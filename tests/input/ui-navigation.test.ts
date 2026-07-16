import { describe, expect, it } from "vitest";

import {
	createActionState,
	createInputManager,
	createUiFocusNavigator,
	type InputAction,
	type InputFrame,
	type InputSource,
	projectUiInput,
} from "../../packages/input/src/index.js";

function frame(
	tick: number,
	options: Readonly<{
		pressed?: readonly InputAction[];
		held?: readonly InputAction[];
		released?: readonly InputAction[];
		source?: InputSource;
		deviceId?: string;
	}> = {},
): InputFrame {
	const pressed = createActionState();
	const held = createActionState();
	const released = createActionState();
	for (const action of options.pressed ?? []) pressed[action] = true;
	for (const action of options.held ?? []) held[action] = true;
	for (const action of options.released ?? []) released[action] = true;
	return {
		version: 1,
		tick,
		timestampMs: tick * 10,
		move: { x: 1, y: 0 },
		look: { x: 0, y: 1 },
		held,
		pressed,
		released,
		source: options.source ?? "keyboard",
		deviceId: options.deviceId ?? "keyboard",
	};
}

describe("UI-safe normalized input", () => {
	it("projects only normalized menu actions into immutable plain data", () => {
		const projected = projectUiInput(
			frame(1, {
				pressed: ["confirm", "boost"],
				held: ["right", "moveRight"],
				released: ["back", "brake"],
			}),
		);
		expect(projected).toEqual({
			tick: 1,
			timestampMs: 10,
			source: "keyboard",
			deviceId: "keyboard",
			held: {
				pause: false,
				up: false,
				down: false,
				left: false,
				right: true,
				confirm: false,
				back: false,
			},
			pressed: {
				pause: false,
				up: false,
				down: false,
				left: false,
				right: false,
				confirm: true,
				back: false,
			},
			released: {
				pause: false,
				up: false,
				down: false,
				left: false,
				right: false,
				confirm: false,
				back: true,
			},
		});
		expect(Object.isFrozen(projected)).toBe(true);
		expect(Object.isFrozen(projected.pressed)).toBe(true);
		expect(JSON.parse(JSON.stringify(projected))).toEqual(projected);
	});
});

describe("deterministic UI focus navigation", () => {
	it("uses authored edges, stable default focus, transition edges, and fixed direction priority", () => {
		const navigator = createUiFocusNavigator([
			{ id: "menu:settings", left: "menu:start" },
			{ id: "menu:quit", up: "menu:start" },
			{
				id: "menu:start",
				down: "menu:quit",
				right: "menu:settings",
			},
		]);

		expect(navigator.focusId).toBe("menu:quit");
		expect(
			navigator.update(frame(1, { pressed: ["up", "right"] })),
		).toMatchObject({ focusId: "menu:start", activatedId: undefined });
		expect(navigator.update(frame(2, { held: ["right"] }))).toMatchObject({
			focusId: "menu:start",
		});
		expect(
			navigator.update(frame(3, { pressed: ["right", "confirm"] })),
		).toEqual({
			tick: 3,
			focusId: "menu:settings",
			activatedId: "menu:settings",
			backRequested: false,
			pauseRequested: false,
		});
		expect(
			navigator.update(frame(4, { pressed: ["back", "pause"] })),
		).toMatchObject({ backRequested: true, pauseRequested: true });
		expect(() => navigator.update(frame(4))).toThrow(/increase/u);

		navigator.reset("menu:start");
		expect(navigator.focusId).toBe("menu:start");
		navigator.destroy();
		expect(navigator.destroyed).toBe(true);
		expect(() => navigator.update(frame(5))).toThrow(/destroyed/u);
	});

	it("keeps focus navigation independent of the gameplay owner source", () => {
		const navigator = createUiFocusNavigator([
			{ id: "left", right: "right" },
			{ id: "right", left: "left" },
		]);
		expect(
			navigator.update(
				frame(1, {
					pressed: ["right"],
					source: "gamepad",
					deviceId: "gamepad-0",
				}),
			).focusId,
		).toBe("right");
		expect(
			navigator.update(
				frame(2, {
					pressed: ["left"],
					source: "touch",
					deviceId: "touch",
				}),
			).focusId,
		).toBe("left");
	});

	it("activates the focused control from the keyboard Space binding", () => {
		const manager = createInputManager();
		const navigator = createUiFocusNavigator(
			[
				{ id: "menu:start", right: "menu:settings" },
				{ id: "menu:settings", left: "menu:start" },
			],
			"menu:start",
		);
		manager.keyboard.keyDown({ code: "Space", repeat: false }, 0);

		const inputFrame = manager.frame(1, 0);
		expect(inputFrame.pressed.action).toBe(true);
		expect(inputFrame.pressed.confirm).toBe(true);
		expect(navigator.update(inputFrame).activatedId).toBe("menu:start");
	});

	it("rejects invalid focus graphs instead of falling back to DOM order", () => {
		expect(() =>
			createUiFocusNavigator([{ id: "a", right: "missing" }]),
		).toThrow(/missing/u);
		expect(() => createUiFocusNavigator([{ id: "a" }, { id: "a" }])).toThrow(
			/duplicate/u,
		);
	});
});
