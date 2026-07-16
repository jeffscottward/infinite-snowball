import { describe, expect, it, vi } from "vitest";

import {
	activateDomControl,
	cameraFeedbackForMotionPreference,
	createActionState,
	createInputManager,
	GAMEPLAY_ACTIONS,
	type GamepadSnapshot,
	INPUT_ACTIONS,
	INPUT_FRAME_VERSION,
	InputBackpressureError,
	normalizeRadialStick,
	normalizeVector,
	type PointerCaptureAdapter,
	type PointerCaptureEvent,
	TOUCH_CONTROL_LAYOUT,
	UI_INPUT_ACTIONS,
} from "../../packages/input/src/index.js";

function standardGamepad(
	overrides: Partial<GamepadSnapshot> = {},
): GamepadSnapshot {
	return {
		id: "standard-pad",
		index: 0,
		connected: true,
		mapping: "standard",
		axes: [0, 0, 0, 0],
		buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
		...overrides,
	};
}

describe("InputFrame contract", () => {
	it("creates a frozen v1 frame with complete stable action maps", () => {
		const manager = createInputManager();
		const frame = manager.frame(4, 100);
		expect(frame.version).toBe(INPUT_FRAME_VERSION);
		expect(frame).toMatchObject({
			tick: 4,
			timestampMs: 100,
			source: "keyboard",
			deviceId: "keyboard",
		});
		expect(Object.keys(frame.held)).toEqual(INPUT_ACTIONS);
		expect(Object.keys(frame.pressed)).toEqual(INPUT_ACTIONS);
		expect(Object.keys(frame.released)).toEqual(INPUT_ACTIONS);
		expect(Object.isFrozen(frame)).toBe(true);
		expect(Object.isFrozen(frame.held)).toBe(true);
		expect(JSON.parse(JSON.stringify(frame))).toEqual(frame);
	});

	it("creates independent complete action states", () => {
		const first = createActionState();
		const second = createActionState();
		first.action = true;
		expect(second.action).toBe(false);
		expect(Object.keys(first)).toEqual(INPUT_ACTIONS);
	});

	it("freezes the canonical and derived runtime action tuples", () => {
		expect(Object.isFrozen(INPUT_ACTIONS)).toBe(true);
		expect(Object.isFrozen(GAMEPLAY_ACTIONS)).toBe(true);
		expect(Object.isFrozen(UI_INPUT_ACTIONS)).toBe(true);
	});

	it("publishes queued raw samples only when their wall-clock boundary is due", () => {
		const manager = createInputManager();
		manager.keyboard.keyDown({ code: "Space", repeat: false }, 49);

		const tick1 = manager.frame(1, 16.667);
		const tick2 = manager.frame(2, 33.333);
		const tick3 = manager.frame(3, 50);

		expect(tick1.held.action).toBe(false);
		expect(tick1.pressed.action).toBe(false);
		expect(tick2.held.action).toBe(false);
		expect(tick2.pressed.action).toBe(false);
		expect(tick3.held.action).toBe(true);
		expect(tick3.pressed.action).toBe(true);
	});

	it("publishes both edges once when down and up occur between boundaries", () => {
		const manager = createInputManager();
		manager.frame(1, 16.667);
		manager.keyboard.keyDown({ code: "Space", repeat: false }, 20);
		manager.keyboard.keyUp({ code: "Space" }, 25);

		const tap = manager.frame(2, 33.333);
		expect(tap.held.action).toBe(false);
		expect(tap.pressed.action).toBe(true);
		expect(tap.released.action).toBe(true);

		const settled = manager.frame(3, 50);
		expect(settled.pressed.action).toBe(false);
		expect(settled.released.action).toBe(false);
	});

	it("latches a complete tap for one strictly increasing tick and rejects repeated ticks", () => {
		const manager = createInputManager();
		manager.keyboard.keyDown({ code: "Space", repeat: false }, 0);
		manager.keyboard.keyUp({ code: "Space" }, 1);

		const tap = manager.frame(1, 1);
		expect(tap.held.action).toBe(false);
		expect(tap.pressed.action).toBe(true);
		expect(tap.released.action).toBe(true);

		expect(() => manager.frame(1, 1)).toThrow(/strictly increasing tick/u);
		const settled = manager.frame(2, 2);
		expect(settled.pressed.action).toBe(false);
		expect(settled.released.action).toBe(false);
		expect(() => manager.frame(0, 3)).toThrow(/strictly increasing tick/u);
	});

	it("latches short gamepad and touch taps between ticks", () => {
		const gamepad = createInputManager();
		const buttons = standardGamepad().buttons.map((button) => ({ ...button }));
		buttons[0] = { pressed: true, value: 1 };
		gamepad.gamepad.update(standardGamepad({ buttons }), 0);
		gamepad.gamepad.update(standardGamepad(), 1);
		const gamepadTap = gamepad.frame(1, 1);

		const touch = createInputManager();
		touch.touch.pressControl("action", 1, 0);
		touch.touch.releasePointer(1, 1);
		const touchTap = touch.frame(1, 1);

		for (const tap of [gamepadTap, touchTap]) {
			expect(tap.held.action).toBe(false);
			expect(tap.pressed.action).toBe(true);
			expect(tap.released.action).toBe(true);
		}
	});
});

describe("keyboard normalization", () => {
	it("normalizes diagonals and emits one edge independent of key repeat", () => {
		const manager = createInputManager();
		manager.keyboard.keyDown({ code: "KeyW", repeat: false }, 0);
		manager.keyboard.keyDown({ code: "KeyD", repeat: false }, 0);
		const pressed = manager.frame(1, 0);
		expect(Math.hypot(pressed.move.x, pressed.move.y)).toBeCloseTo(1, 8);
		expect(pressed.move.x).toBeCloseTo(Math.SQRT1_2, 8);
		expect(pressed.move.y).toBeCloseTo(Math.SQRT1_2, 8);
		expect(pressed.pressed.moveForward).toBe(true);
		expect(pressed.pressed.moveRight).toBe(true);

		manager.keyboard.keyDown({ code: "KeyW", repeat: true }, 1);
		const repeated = manager.frame(2, 1);
		expect(repeated.held.moveForward).toBe(true);
		expect(repeated.pressed.moveForward).toBe(false);
		manager.keyboard.keyUp({ code: "KeyW" }, 2);
		const released = manager.frame(3, 2);
		expect(released.released.moveForward).toBe(true);
	});

	it("ignores editable targets and synthesizes releases on blur", () => {
		const manager = createInputManager();
		manager.keyboard.keyDown(
			{ code: "Space", repeat: false, target: { tagName: "INPUT" } },
			0,
		);
		expect(manager.frame(1, 0).held.action).toBe(false);
		manager.keyboard.keyDown({ code: "Space", repeat: false }, 1);
		expect(manager.frame(2, 1).pressed.action).toBe(true);
		manager.keyboard.blur(2);
		const released = manager.frame(3, 2);
		expect(released.held.action).toBe(false);
		expect(released.released.action).toBe(true);
	});

	it("ignores a repeated keydown even when it is the first event", () => {
		const manager = createInputManager();
		manager.keyboard.keyDown({ code: "KeyW", repeat: true }, 0);
		const ignored = manager.frame(1, 0);
		expect(ignored.held.moveForward).toBe(false);
		expect(ignored.pressed.moveForward).toBe(false);

		manager.keyboard.keyDown({ code: "KeyW", repeat: false }, 1);
		expect(manager.frame(2, 1).pressed.moveForward).toBe(true);
	});

	it("rejects prototype-named codes and no-op releases without poisoning later input", () => {
		const manager = createInputManager();
		let timestampMs = 0;
		for (const code of [
			"toString",
			"constructor",
			"__proto__",
			"hasOwnProperty",
		]) {
			expect(() =>
				manager.keyboard.keyDown({ code, repeat: false }, timestampMs++),
			).not.toThrow();
			expect(() =>
				manager.keyboard.keyUp({ code }, timestampMs++),
			).not.toThrow();
		}

		manager.keyboard.keyDown({ code: "Space", repeat: false }, timestampMs);
		const pressed = manager.frame(1, timestampMs++);
		expect(pressed.pressed.action).toBe(true);
		expect(pressed.pressed.confirm).toBe(true);

		manager.keyboard.blur(timestampMs);
		const released = manager.frame(2, timestampMs);
		expect(released.released.action).toBe(true);
		expect(released.released.confirm).toBe(true);
	});
});

describe("standard gamepad normalization", () => {
	it("applies radial 0.20 deadzone with continuous rescaling and unit clamp", () => {
		expect(normalizeRadialStick(0.19, 0, 0.2)).toEqual({ x: 0, y: 0 });
		expect(normalizeRadialStick(0.6, 0, 0.2).x).toBeCloseTo(0.5, 8);
		expect(normalizeRadialStick(2, 0, 0.2)).toEqual({ x: 1, y: 0 });
		const manager = createInputManager();
		manager.gamepad.update(standardGamepad({ axes: [0.6, -0.8, 0, 0] }), 10);
		const frame = manager.frame(1, 10);
		expect(Math.hypot(frame.move.x, frame.move.y)).toBeCloseTo(1, 8);
		expect(frame.source).toBe("gamepad");
		expect(frame.deviceId).toBe("gamepad-0");
	});

	it("rejects unreviewed non-standard mappings without changing state", () => {
		const manager = createInputManager();
		expect(manager.gamepad.update(standardGamepad({ mapping: "" }), 0)).toBe(
			false,
		);
		expect(manager.frame(1, 0).move).toEqual({ x: 0, y: 0 });
	});

	it("uses D-pad and left-stick 0.55/0.35 hysteresis for one UI edge", () => {
		const manager = createInputManager();
		manager.gamepad.update(standardGamepad({ axes: [0.56, 0, 0, 0] }), 0);
		expect(manager.frame(1, 0).pressed.right).toBe(true);
		manager.gamepad.update(standardGamepad({ axes: [0.5, 0, 0, 0] }), 1);
		expect(manager.frame(2, 1)).toMatchObject({
			held: { right: true },
			pressed: { right: false },
		});
		manager.gamepad.update(standardGamepad({ axes: [0.34, 0, 0, 0] }), 2);
		expect(manager.frame(3, 2).released.right).toBe(true);
		const dpadButtons = standardGamepad().buttons.map((button) => ({
			...button,
		}));
		dpadButtons[12] = { pressed: true, value: 1 };
		manager.gamepad.update(standardGamepad({ buttons: dpadButtons }), 3);
		expect(manager.frame(4, 3).pressed.up).toBe(true);
	});

	it("does not let D-pad state activate the separate stick hysteresis latch", () => {
		const manager = createInputManager();
		const dpadButtons = standardGamepad().buttons.map((button) => ({
			...button,
		}));
		dpadButtons[15] = { pressed: true, value: 1 };
		manager.gamepad.update(
			standardGamepad({ axes: [0.4, 0, 0, 0], buttons: dpadButtons }),
			0,
		);
		expect(manager.frame(1, 0).held.right).toBe(true);

		dpadButtons[15] = { pressed: false, value: 0 };
		manager.gamepad.update(
			standardGamepad({ axes: [0.4, 0, 0, 0], buttons: dpadButtons }),
			1,
		);
		const dpadReleased = manager.frame(2, 1);
		expect(dpadReleased.held.right).toBe(false);
		expect(dpadReleased.released.right).toBe(true);

		manager.gamepad.update(standardGamepad({ axes: [0.56, 0, 0, 0] }), 2);
		expect(manager.frame(3, 2).pressed.right).toBe(true);
	});

	it("synthesizes releases on disconnect and only reports rumble capability", () => {
		const manager = createInputManager();
		const buttons = standardGamepad().buttons.map((button) => ({ ...button }));
		buttons[0] = { pressed: true, value: 1 };
		manager.gamepad.update(standardGamepad({ buttons, canRumble: true }), 0);
		expect(manager.gamepad.capabilities()).toEqual({ canRumble: true });
		expect(manager.frame(1, 0).pressed.action).toBe(true);
		manager.gamepad.disconnect(0, 1);
		expect(manager.frame(2, 1).released.action).toBe(true);
	});

	it("clears a known gamepad on malformed containers and accepts later polls", () => {
		const manager = createInputManager();
		const buttons = standardGamepad().buttons.map((entry) => ({ ...entry }));
		buttons[0] = { pressed: true, value: 1 };
		expect(manager.gamepad.update(standardGamepad({ buttons }), 0)).toBe(true);
		expect(manager.frame(1, 0).held.action).toBe(true);

		const missingAxes = {
			...standardGamepad(),
			axes: null,
		} as unknown as GamepadSnapshot;
		expect(manager.gamepad.update(missingAxes, 1)).toBe(false);
		const axesRelease = manager.frame(2, 1);
		expect(axesRelease.held.action).toBe(false);
		expect(axesRelease.released.action).toBe(true);

		expect(manager.gamepad.update(standardGamepad({ buttons }), 2)).toBe(true);
		expect(manager.frame(3, 2).pressed.action).toBe(true);
		const missingButtons = {
			...standardGamepad(),
			buttons: null,
		} as unknown as GamepadSnapshot;
		expect(manager.gamepad.update(missingButtons, 3)).toBe(false);
		expect(manager.frame(4, 3).released.action).toBe(true);

		expect(manager.gamepad.update(standardGamepad(), 4)).toBe(true);
		expect(manager.frame(5, 4).held.action).toBe(false);
	});

	it("bounds gamepad indexes, array lengths, and button value shapes", () => {
		const manager = createInputManager();
		const largestAxes = Array.from({ length: 16 }, () => 0);
		const largestButtons = Array.from({ length: 64 }, () => ({
			pressed: false,
			value: 0,
		}));
		for (let index = 0; index < 16; index += 1) {
			expect(
				manager.gamepad.update(
					standardGamepad({
						index,
						axes: largestAxes,
						buttons: largestButtons,
						canRumble: index === 15,
					}),
					index,
				),
			).toBe(true);
		}
		expect(manager.gamepad.capabilities()).toEqual({ canRumble: true });
		expect(
			manager.gamepad.update(
				standardGamepad({ index: 16, canRumble: true }),
				16,
			),
		).toBe(false);

		expect(
			manager.gamepad.update(
				standardGamepad({
					index: 15,
					axes: [...largestAxes, 0],
				}),
				17,
			),
		).toBe(false);
		expect(manager.gamepad.capabilities()).toEqual({ canRumble: false });
		expect(
			manager.gamepad.update(
				standardGamepad({
					index: 15,
					buttons: [...largestButtons, { pressed: false, value: 0 }],
				}),
				18,
			),
		).toBe(false);
		const invalidButtons = standardGamepad().buttons.map((entry) => ({
			...entry,
		}));
		invalidButtons[0] = { pressed: false, value: Number.NaN };
		expect(
			manager.gamepad.update(
				standardGamepad({ index: 15, buttons: invalidButtons }),
				19,
			),
		).toBe(false);
		expect(manager.gamepad.update(standardGamepad({ index: 15 }), 20)).toBe(
			true,
		);
	});
});

describe("source arbitration", () => {
	it("keeps last meaningful gameplay ownership for two seconds and ignores UI-only focus/navigation", () => {
		const manager = createInputManager();
		manager.keyboard.keyDown({ code: "KeyW", repeat: false }, 0);
		expect(manager.frame(1, 0).source).toBe("keyboard");
		manager.keyboard.keyUp({ code: "KeyW" }, 1);
		manager.frame(2, 1);

		const dpadButtons = standardGamepad().buttons.map((button) => ({
			...button,
		}));
		dpadButtons[12] = { pressed: true, value: 1 };
		manager.gamepad.update(standardGamepad({ buttons: dpadButtons }), 1000);
		const uiOnly = manager.frame(3, 1000);
		expect(uiOnly.source).toBe("keyboard");
		expect(uiOnly.pressed.up).toBe(true);

		manager.touch.pressControl("confirm", 7, 1500);
		expect(manager.frame(4, 1500).source).toBe("keyboard");
		manager.touch.releasePointer(7, 1501);
		manager.touch.beginMove(8, { x: 0, y: 0 }, 2101);
		manager.touch.move(8, { x: 64, y: 0 }, 2102);
		expect(manager.frame(5, 2102).source).toBe("touch");
	});

	it("does not let a UI-only keydown claim from an older blocked gameplay key", () => {
		const manager = createInputManager();
		const buttons = standardGamepad().buttons.map((button) => ({ ...button }));
		buttons[2] = { pressed: true, value: 1 };
		manager.gamepad.update(standardGamepad({ buttons }), 0);
		expect(manager.frame(1, 0).source).toBe("gamepad");

		manager.keyboard.keyDown({ code: "KeyW", repeat: false }, 1_000);
		manager.keyboard.keyDown({ code: "Enter", repeat: false }, 2_500);
		const uiOnly = manager.frame(2, 2_500);
		expect(uiOnly.source).toBe("gamepad");
		expect(uiOnly.pressed.confirm).toBe(true);

		manager.keyboard.keyDown({ code: "KeyD", repeat: false }, 2_501);
		expect(manager.frame(3, 2_501).source).toBe("keyboard");
	});

	it("does not refresh gamepad ownership for unchanged held polls", () => {
		const manager = createInputManager();
		const buttons = standardGamepad().buttons.map((button) => ({ ...button }));
		buttons[0] = { pressed: true, value: 1 };
		const held = standardGamepad({ buttons });

		manager.gamepad.update(held, 0);
		expect(manager.frame(1, 0).source).toBe("gamepad");
		for (const timestampMs of [500, 1_500, 2_500]) {
			manager.gamepad.update(held, timestampMs);
		}

		manager.keyboard.keyDown({ code: "KeyW", repeat: false }, 2_501);
		expect(manager.frame(2, 2_501)).toMatchObject({
			source: "keyboard",
			deviceId: "keyboard",
		});
	});

	it("lets a newly active gamepad action claim after the ownership window", () => {
		const manager = createInputManager();
		manager.keyboard.keyDown({ code: "KeyW", repeat: false }, 0);
		expect(manager.frame(1, 0).source).toBe("keyboard");
		manager.keyboard.keyUp({ code: "KeyW" }, 1);

		const buttons = standardGamepad().buttons.map((button) => ({ ...button }));
		buttons[2] = { pressed: true, value: 1 };
		manager.gamepad.update(standardGamepad({ buttons }), 1_000);
		manager.gamepad.update(standardGamepad({ buttons }), 2_000);
		expect(manager.frame(2, 2_000).source).toBe("keyboard");

		buttons[0] = { pressed: true, value: 1 };
		manager.gamepad.update(standardGamepad({ buttons }), 2_001);
		const changed = manager.frame(3, 2_001);
		expect(changed.source).toBe("gamepad");
		expect(changed.pressed.action).toBe(true);
	});

	it("ignores gamepad analog jitter but claims a meaningful vector change", () => {
		const manager = createInputManager();
		manager.keyboard.keyDown({ code: "KeyW", repeat: false }, 0);
		expect(manager.frame(1, 0).source).toBe("keyboard");
		manager.keyboard.keyUp({ code: "KeyW" }, 1);

		manager.gamepad.update(standardGamepad({ axes: [0.6, 0, 0, 0] }), 1_000);
		manager.gamepad.update(
			standardGamepad({ axes: [0.600_001, 0, 0, 0] }),
			2_000,
		);
		expect(manager.frame(2, 2_000).source).toBe("keyboard");

		manager.gamepad.update(standardGamepad({ axes: [0.7, 0, 0, 0] }), 2_001);
		expect(manager.frame(3, 2_001).source).toBe("gamepad");
	});

	it("claims cumulative analog movement that crosses the jitter epsilon", () => {
		const manager = createInputManager();
		manager.keyboard.keyDown({ code: "KeyW", repeat: false }, 0);
		expect(manager.frame(1, 0).source).toBe("keyboard");
		manager.keyboard.keyUp({ code: "KeyW" }, 1);

		manager.gamepad.update(standardGamepad({ axes: [0.6, 0, 0, 0] }), 1_000);
		manager.gamepad.update(standardGamepad({ axes: [0.605, 0, 0, 0] }), 1_500);
		manager.gamepad.update(standardGamepad({ axes: [0.61, 0, 0, 0] }), 2_001);

		expect(manager.frame(2, 2_001).source).toBe("gamepad");
	});

	it("does not claim ownership when invalid analog axes sanitize to zero", () => {
		const manager = createInputManager();
		manager.gamepad.update(standardGamepad({ axes: [0.6, 0, 0, 0] }), 0);
		expect(manager.frame(1, 0).source).toBe("gamepad");

		manager.keyboard.keyDown({ code: "KeyW", repeat: false }, 2_001);
		expect(manager.frame(2, 2_001).source).toBe("keyboard");

		manager.gamepad.update(
			standardGamepad({ axes: [Number.NaN, 0, 0, 0] }),
			4_002,
		);
		expect(manager.frame(3, 4_002).source).toBe("keyboard");
	});

	it("claims a low-magnitude look change above the jitter epsilon", () => {
		const manager = createInputManager();
		manager.keyboard.keyDown({ code: "KeyW", repeat: false }, 0);
		expect(manager.frame(1, 0).source).toBe("keyboard");
		manager.keyboard.keyUp({ code: "KeyW" }, 1);

		manager.gamepad.update(standardGamepad(), 1_000);
		manager.gamepad.update(standardGamepad({ axes: [0, 0, 0.216, 0] }), 2_000);
		expect(manager.frame(2, 2_000).source).toBe("gamepad");
	});

	it("preserves valid movement activity when an unrelated look stick is invalid", () => {
		const manager = createInputManager();
		manager.keyboard.keyDown({ code: "KeyW", repeat: false }, 0);
		expect(manager.frame(1, 0).source).toBe("keyboard");
		manager.keyboard.keyUp({ code: "KeyW" }, 1);

		expect(
			manager.gamepad.update(
				standardGamepad({ axes: [0.6, 0, Number.NaN, 0] }),
				2_001,
			),
		).toBe(true);
		const frame = manager.frame(2, 2_001);
		expect(frame.source).toBe("gamepad");
		expect(frame.move.x).toBeGreaterThan(0);
		expect(frame.look).toEqual({ x: 0, y: 0 });
	});
	it("enforces one raw timestamp high-water mark while frames may lag it", () => {
		const manager = createInputManager();
		manager.keyboard.keyDown({ code: "Space", repeat: false }, 49);
		expect(manager.frame(1, 16.667).held.action).toBe(false);
		expect(() => manager.touch.beginMove(1, { x: 0, y: 0 }, 48)).toThrow(
			/raw timestamp.*nondecreasing/u,
		);

		expect(() => manager.touch.beginMove(1, { x: 0, y: 0 }, 49)).not.toThrow();
		expect(manager.frame(2, 50).held.action).toBe(true);
	});

	it("releases ownership immediately when the owning gamepad disconnects", () => {
		const manager = createInputManager();
		const buttons = standardGamepad().buttons.map((button) => ({ ...button }));
		buttons[0] = { pressed: true, value: 1 };
		manager.gamepad.update(standardGamepad({ buttons }), 0);
		expect(manager.frame(1, 0).source).toBe("gamepad");

		manager.gamepad.disconnect(0, 1);
		manager.keyboard.keyDown({ code: "KeyW", repeat: false }, 2);
		const keyboardClaim = manager.frame(2, 2);
		expect(keyboardClaim.source).toBe("keyboard");
		expect(keyboardClaim.held.moveForward).toBe(true);
		expect(keyboardClaim.released.action).toBe(true);
	});
});

describe("touch normalization and accessible controls", () => {
	it("normalizes move, camera drag, action controls, and pointer cancellation", () => {
		const manager = createInputManager();
		manager.touch.beginMove(1, { x: 100, y: 100 }, 0);
		manager.touch.move(1, { x: 164, y: 36 }, 1);
		manager.touch.beginLook(2, { x: 200, y: 100 }, 1);
		manager.touch.move(2, { x: 232, y: 116 }, 2);
		manager.touch.pressControl("action", 3, 2);
		const frame = manager.frame(1, 2);
		expect(Math.hypot(frame.move.x, frame.move.y)).toBeCloseTo(1, 8);
		expect(frame.look).toEqual({ x: 0.5, y: -0.25 });
		expect(frame.pressed.action).toBe(true);
		expect(frame.source).toBe("touch");
		manager.touch.cancelPointer(1, 3);
		manager.touch.cancelPointer(2, 3);
		manager.touch.cancelPointer(3, 3);
		const released = manager.frame(2, 3);
		expect(released.move).toEqual({ x: 0, y: 0 });
		expect(released.look).toEqual({ x: 0, y: 0 });
		expect(released.released.action).toBe(true);
	});

	it("merges directional touch controls with analog movement and held flags", () => {
		const manager = createInputManager();
		manager.touch.pressControl("moveForward", 1, 0);
		manager.touch.pressControl("moveRight", 2, 0);
		const digitalDiagonal = manager.frame(1, 0);
		expect(digitalDiagonal.move.x).toBeCloseTo(Math.SQRT1_2, 8);
		expect(digitalDiagonal.move.y).toBeCloseTo(Math.SQRT1_2, 8);
		expect(digitalDiagonal.held.moveForward).toBe(true);
		expect(digitalDiagonal.held.moveRight).toBe(true);

		manager.touch.releasePointer(2, 1);
		manager.touch.beginMove(3, { x: 0, y: 0 }, 1);
		manager.touch.move(3, { x: 64, y: 0 }, 1);
		const merged = manager.frame(2, 1);
		expect(merged.move.x).toBeCloseTo(Math.SQRT1_2, 8);
		expect(merged.move.y).toBeCloseTo(Math.SQRT1_2, 8);
		expect(merged.held.moveForward).toBe(true);
		expect(merged.held.moveRight).toBe(true);
	});

	it("unit-clamps touch look diagonals and inverts screen Y", () => {
		const manager = createInputManager();
		manager.touch.beginLook(1, { x: 10, y: 10 }, 0);
		manager.touch.move(1, { x: 74, y: 74 }, 1);
		const frame = manager.frame(1, 1);
		expect(Math.hypot(frame.look.x, frame.look.y)).toBeCloseTo(1, 8);
		expect(frame.look.x).toBeCloseTo(Math.SQRT1_2, 8);
		expect(frame.look.y).toBeCloseTo(-Math.SQRT1_2, 8);
	});

	it("scale-normalizes extreme finite touch deltas without overflow collapse", () => {
		const extreme = normalizeVector(Number.MAX_VALUE, -Number.MAX_VALUE);
		expect(extreme.x).toBeCloseTo(Math.SQRT1_2, 12);
		expect(extreme.y).toBeCloseTo(-Math.SQRT1_2, 12);
		const manager = createInputManager();
		manager.touch.beginMove(1, { x: 0, y: 0 }, 0);
		manager.touch.move(1, { x: Number.MAX_VALUE, y: Number.MAX_VALUE }, 1);

		const frame = manager.frame(1, 1);
		expect(frame.source).toBe("touch");
		expect(frame.move.x).toBeCloseTo(Math.SQRT1_2, 8);
		expect(frame.move.y).toBeCloseTo(-Math.SQRT1_2, 8);
		expect(Math.hypot(frame.move.x, frame.move.y)).toBeCloseTo(1, 8);
	});

	it("uses the injected P05 capture port and releases each owned pointer once", () => {
		const listeners = {
			release: new Set<(event: PointerCaptureEvent) => void>(),
			cancel: new Set<(event: PointerCaptureEvent) => void>(),
		};
		const capture: PointerCaptureAdapter = {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(),
			listen(type, listener) {
				listeners[type].add(listener);
				return () => listeners[type].delete(listener);
			},
		};
		const manager = createInputManager({ pointerCapture: capture });

		manager.touch.pressControl("action", 7, 0);
		expect(capture.setPointerCapture).toHaveBeenCalledWith(7);
		expect(manager.frame(1, 0).held.action).toBe(true);
		for (const listener of listeners.release) {
			listener({ pointerId: 7, timestampMs: 1 });
		}
		expect(manager.frame(2, 1).released.action).toBe(true);
		expect(capture.releasePointerCapture).toHaveBeenCalledWith(7);

		manager.touch.beginMove(8, { x: 0, y: 0 }, 2);
		manager.touch.move(8, { x: 64, y: 0 }, 2);
		for (const listener of listeners.cancel) {
			listener({ pointerId: 8, timestampMs: 3 });
		}
		expect(manager.frame(3, 3).move).toEqual({ x: 0, y: 0 });
		expect(capture.releasePointerCapture).toHaveBeenCalledWith(8);

		manager.touch.pressControl("action", 9, 4);
		manager.reset();
		expect(capture.releasePointerCapture).toHaveBeenCalledWith(9);
		manager.touch.pressControl("action", 10, 5);
		manager.destroy();
		expect(capture.releasePointerCapture).toHaveBeenCalledWith(10);
		expect(vi.mocked(capture.releasePointerCapture).mock.calls).toEqual([
			[7],
			[8],
			[9],
			[10],
		]);
		expect(listeners.release.size).toBe(0);
		expect(listeners.cancel.size).toBe(0);
	});

	it("caps active touch pointers and recovers capacity after release", () => {
		const capture: PointerCaptureAdapter = {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(),
			listen: () => () => undefined,
		};
		const manager = createInputManager({ pointerCapture: capture });
		for (let pointerId = 0; pointerId < 16; pointerId += 1) {
			manager.touch.pressControl("action", pointerId, 0);
		}
		manager.touch.pressControl("resetCamera", 16, 0);
		expect(capture.setPointerCapture).toHaveBeenCalledTimes(16);
		expect(manager.frame(1, 0).held.resetCamera).toBe(false);

		for (let pointerId = 0; pointerId < 16; pointerId += 1) {
			manager.touch.releasePointer(pointerId, 1);
		}
		manager.touch.pressControl("resetCamera", 16, 2);
		expect(capture.setPointerCapture).toHaveBeenLastCalledWith(16);
		const recovered = manager.frame(2, 2);
		expect(recovered.released.action).toBe(true);
		expect(recovered.pressed.resetCamera).toBe(true);
	});

	it("clears pointer ownership before a native capture release throws", () => {
		const capture: PointerCaptureAdapter = {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(() => {
				throw new Error("native release failed");
			}),
			listen: () => () => undefined,
		};
		const manager = createInputManager({ pointerCapture: capture });
		manager.touch.pressControl("action", 7, 0);
		expect(manager.frame(1, 0).held.action).toBe(true);

		expect(() => manager.touch.releasePointer(7, 1)).toThrow(
			/native capture release/u,
		);
		const released = manager.frame(2, 1);
		expect(released.held.action).toBe(false);
		expect(released.released.action).toBe(true);
		manager.keyboard.keyDown({ code: "KeyW", repeat: false }, 2_001);
		expect(manager.frame(3, 2_001).held.moveForward).toBe(true);
	});
	it("publishes safe-area coarse controls of at least 48px", () => {
		expect(TOUCH_CONTROL_LAYOUT.safeAreaAware).toBe(true);
		for (const control of TOUCH_CONTROL_LAYOUT.controls) {
			expect(control.minimumSizePx).toBeGreaterThanOrEqual(48);
		}
	});

	it("publishes a canonical accessible camera reset control", () => {
		expect(INPUT_ACTIONS).toContain("resetCamera");
		expect(TOUCH_CONTROL_LAYOUT.controls).toContainEqual({
			id: "resetCamera",
			label: "Reset camera",
			minimumSizePx: 48,
		});
	});

	it("focuses and activates the same structural DOM control", () => {
		const target = { focus: vi.fn(), click: vi.fn() };
		activateDomControl(target);
		expect(target.focus).toHaveBeenCalledOnce();
		expect(target.click).toHaveBeenCalledOnce();
	});
});

describe("lifecycle and motion preference", () => {
	it("suppresses decorative camera feedback under reduced motion", () => {
		expect(cameraFeedbackForMotionPreference(false)).toEqual({
			shakeScale: 1,
			zoomPulseScale: 1,
		});
		expect(cameraFeedbackForMotionPreference(true)).toEqual({
			shakeScale: 0,
			zoomPulseScale: 0,
		});
	});

	it("synthesizes touch releases when the page is hidden", () => {
		const manager = createInputManager();
		manager.touch.pressControl("action", 1, 0);
		expect(manager.frame(1, 0).held.action).toBe(true);
		manager.pageHide(1);
		const released = manager.frame(2, 1);
		expect(released.held.action).toBe(false);
		expect(released.released.action).toBe(true);
	});

	it("prevents sticky controls after reset and rejects use after destroy", () => {
		const manager = createInputManager();
		manager.keyboard.keyDown({ code: "Space", repeat: false }, 0);
		manager.frame(1, 0);
		manager.reset();
		expect(manager.frame(2, 1).held.action).toBe(false);
		manager.destroy();
		expect(manager.destroyed).toBe(true);
		expect(() => manager.frame(3, 2)).toThrow(/destroyed/u);
	});

	it("reset clears live, published, and future queued samples", () => {
		const manager = createInputManager();
		manager.keyboard.keyDown({ code: "Space", repeat: false }, 1);
		expect(manager.frame(1, 1).held.action).toBe(true);
		manager.keyboard.keyUp({ code: "Space" }, 100);

		manager.reset();
		const reset = manager.frame(1, 200);
		expect(reset.held.action).toBe(false);
		expect(reset.pressed.action).toBe(false);
		expect(reset.released.action).toBe(false);
	});

	it("preserves timestamp high-water marks across reset while restarting ticks", () => {
		const manager = createInputManager();
		manager.keyboard.keyDown({ code: "Space", repeat: false }, 100);
		expect(manager.frame(7, 50).tick).toBe(7);

		manager.reset();
		expect(() => manager.keyboard.keyUp({ code: "Space" }, 99)).toThrow(
			/raw timestamp.*nondecreasing/u,
		);
		expect(() => manager.frame(1, 49)).toThrow(/frame timestamp.*monotonic/u);
		expect(manager.frame(1, 51)).toMatchObject({
			tick: 1,
			timestampMs: 51,
			source: "keyboard",
			deviceId: "keyboard",
		});
	});

	it("emits matching pressed/held/released action semantics for all devices", () => {
		const keyboard = createInputManager();
		keyboard.keyboard.keyDown({ code: "Space", repeat: false }, 0);
		const kDown = keyboard.frame(1, 0);
		keyboard.keyboard.keyUp({ code: "Space" }, 1);
		const kUp = keyboard.frame(2, 1);

		const gamepad = createInputManager();
		const buttons = standardGamepad().buttons.map((button) => ({ ...button }));
		buttons[0] = { pressed: true, value: 1 };
		gamepad.gamepad.update(standardGamepad({ buttons }), 0);
		const gDown = gamepad.frame(1, 0);
		gamepad.gamepad.update(standardGamepad(), 1);
		const gUp = gamepad.frame(2, 1);

		const touch = createInputManager();
		touch.touch.pressControl("action", 1, 0);
		const tDown = touch.frame(1, 0);
		touch.touch.releasePointer(1, 1);
		const tUp = touch.frame(2, 1);
		for (const down of [kDown, gDown, tDown]) {
			expect(down.pressed.action).toBe(true);
			expect(down.held.action).toBe(true);
		}
		for (const up of [kUp, gUp, tUp]) {
			expect(up.released.action).toBe(true);
			expect(up.held.action).toBe(false);
		}
	});

	it("maps resetCamera with matching gameplay semantics on every device", () => {
		const keyboard = createInputManager();
		keyboard.keyboard.keyDown({ code: "KeyR", repeat: false }, 0);
		const keyboardDown = keyboard.frame(1, 0);
		keyboard.keyboard.keyUp({ code: "KeyR" }, 1);
		const keyboardUp = keyboard.frame(2, 1);

		const buttons = standardGamepad().buttons.map((button) => ({ ...button }));
		buttons[3] = { pressed: true, value: 1 };
		const gamepad = createInputManager();
		gamepad.gamepad.update(standardGamepad({ buttons }), 0);
		const gamepadDown = gamepad.frame(1, 0);
		buttons[3] = { pressed: false, value: 0 };
		gamepad.gamepad.update(standardGamepad({ buttons }), 1);
		const gamepadUp = gamepad.frame(2, 1);

		const touch = createInputManager();
		touch.touch.pressControl("resetCamera", 1, 0);
		const touchDown = touch.frame(1, 0);
		touch.touch.releasePointer(1, 1);
		const touchUp = touch.frame(2, 1);

		for (const down of [keyboardDown, gamepadDown, touchDown]) {
			expect(down.pressed.resetCamera).toBe(true);
			expect(down.held.resetCamera).toBe(true);
		}
		for (const up of [keyboardUp, gamepadUp, touchUp]) {
			expect(up.released.resetCamera).toBe(true);
			expect(up.held.resetCamera).toBe(false);
		}
	});

	it("unwinds partial pointer-listener registration", () => {
		const stopRelease = vi.fn(() => {
			throw new Error("release disposer failed");
		});
		const capture: PointerCaptureAdapter = {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(),
			listen(type) {
				if (type === "release") return stopRelease;
				throw new Error("cancel registration failed");
			},
		};

		expect(() => createInputManager({ pointerCapture: capture })).toThrow(
			/pointer listener registration/u,
		);
		expect(stopRelease).toHaveBeenCalledOnce();
	});

	it("marks destroy terminal and attempts every owned cleanup when callbacks throw", () => {
		const stopRelease = vi.fn(() => {
			throw new Error("release disposer failed");
		});
		const stopCancel = vi.fn(() => {
			throw new Error("cancel disposer failed");
		});
		const capture: PointerCaptureAdapter = {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(() => {
				throw new Error("capture release failed");
			}),
			listen(type) {
				return type === "release" ? stopRelease : stopCancel;
			},
		};
		const manager = createInputManager({ pointerCapture: capture });
		manager.touch.pressControl("action", 1, 0);
		manager.touch.pressControl("resetCamera", 2, 0);

		expect(() => manager.destroy()).toThrow(/input manager cleanup/u);
		expect(manager.destroyed).toBe(true);
		expect(capture.releasePointerCapture).toHaveBeenCalledTimes(2);
		expect(stopRelease).toHaveBeenCalledOnce();
		expect(stopCancel).toHaveBeenCalledOnce();
		expect(() => manager.destroy()).not.toThrow();
		expect(() => manager.frame(1, 0)).toThrow(/destroyed/u);
	});

	it("surfaces bounded pending ingress and recovers after a frame drain", () => {
		const manager = createInputManager();
		for (let timestampMs = 0; timestampMs < 256; timestampMs += 1) {
			if (timestampMs % 2 === 0) {
				manager.keyboard.keyDown({ code: "Space", repeat: false }, timestampMs);
			} else {
				manager.keyboard.keyUp({ code: "Space" }, timestampMs);
			}
		}
		expect(() =>
			manager.keyboard.keyDown({ code: "Space", repeat: false }, 256),
		).toThrow(InputBackpressureError);

		const drained = manager.frame(1, 255);
		expect(drained.held.action).toBe(false);
		expect(drained.pressed.action).toBe(true);
		expect(drained.released.action).toBe(true);
		manager.keyboard.keyDown({ code: "KeyW", repeat: false }, 1_024);
		expect(manager.frame(2, 1_024).pressed.moveForward).toBe(true);
	});

	it("never retimestamps an accepted sample when backpressure rejects ingress", () => {
		const manager = createInputManager();
		for (let timestampMs = 0; timestampMs < 256; timestampMs += 1) {
			if (timestampMs % 2 === 0) {
				manager.keyboard.keyDown({ code: "Space", repeat: false }, timestampMs);
			} else {
				manager.keyboard.keyUp({ code: "Space" }, timestampMs);
			}
		}
		expect(() =>
			manager.keyboard.keyDown({ code: "Space", repeat: false }, 1_000),
		).toThrow(InputBackpressureError);

		const pastBoundary = manager.frame(1, 255);
		expect(pastBoundary.held.action).toBe(false);
		expect(pastBoundary.pressed.action).toBe(true);
		expect(pastBoundary.released.action).toBe(true);
		const rejectedFuture = manager.frame(2, 1_000);
		expect(rejectedFuture.held.action).toBe(false);
		expect(rejectedFuture.pressed.action).toBe(false);
		expect(rejectedFuture.released.action).toBe(false);
	});

	it.each([
		"blur",
		"pageHide",
	] as const)("forces %s releases through a saturated pending queue", (lifecycle) => {
		const capture: PointerCaptureAdapter = {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(),
			listen: () => () => undefined,
		};
		const manager = createInputManager({ pointerCapture: capture });
		manager.touch.beginMove(7, { x: 0, y: 0 }, 0);
		manager.touch.move(7, { x: 64, y: 0 }, 0);
		for (let timestampMs = 1; timestampMs < 256; timestampMs += 1) {
			if (timestampMs % 2 === 1) {
				manager.keyboard.keyDown({ code: "Space", repeat: false }, timestampMs);
			} else {
				manager.keyboard.keyUp({ code: "Space" }, timestampMs);
			}
		}

		expect(() => {
			if (lifecycle === "blur") manager.keyboard.blur(1_000);
			else manager.pageHide(1_000);
		}).not.toThrow();
		const released = manager.frame(1, 1_000);
		expect(released.source).toBe("keyboard");
		expect(released.held.confirm).toBe(false);
		expect(released.held.moveRight).toBe(false);
		expect(released.released.confirm).toBe(true);
		expect(released.released.moveRight).toBe(true);
		expect(capture.releasePointerCapture).toHaveBeenCalledOnce();

		manager.destroy();
		expect(capture.releasePointerCapture).toHaveBeenCalledOnce();
	});
});
