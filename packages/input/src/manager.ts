import {
	type ActionState,
	copyActionState,
	createActionState,
	GAMEPLAY_ACTIONS,
	INPUT_ACTIONS,
	INPUT_FRAME_VERSION,
	type InputAction,
	type InputFrame,
	type InputSource,
	type InputVector2,
	isGameplayAction,
	normalizeRadialStick,
	normalizeVector,
	UI_ACTIONS,
} from "./actions.js";

const SOURCE_OWNERSHIP_MS = 2_000;
const TOUCH_STICK_RADIUS_PX = 64;
const TOUCH_LOOK_SCALE_PX = 64;
const UI_ACTIVATE = 0.55;
const UI_RELEASE = 0.35;
const GAMEPAD_ANALOG_ACTIVITY_EPSILON = 0.01;
const MAX_KEYBOARD_CODE_LENGTH = 64;
const MAX_GAMEPADS = 16;
const MIN_GAMEPAD_AXES = 4;
const MAX_GAMEPAD_AXES = 16;
const MIN_GAMEPAD_BUTTONS = 16;
const MAX_GAMEPAD_BUTTONS = 64;
const MAX_GAMEPAD_ID_LENGTH = 256;
const MAX_TOUCH_POINTERS = 16;
const MAX_PENDING_SAMPLES = 256;
const GAMEPAD_GAMEPLAY_BUTTON_ACTIONS = Object.freeze([
	"brake",
	"boost",
	"action",
	"resetCamera",
] as const satisfies readonly InputAction[]);

export interface KeyboardInputEvent {
	readonly code: string;
	readonly repeat?: boolean;
	readonly target?: unknown;
}

export interface GamepadButtonSnapshot {
	readonly pressed: boolean;
	readonly value: number;
}

export interface GamepadSnapshot {
	readonly id: string;
	readonly index: number;
	readonly connected: boolean;
	readonly mapping: string;
	readonly axes: readonly number[];
	readonly buttons: readonly GamepadButtonSnapshot[];
	readonly canRumble?: boolean;
}

export interface PointerPoint {
	readonly x: number;
	readonly y: number;
}

export interface PointerCaptureEvent {
	readonly pointerId: number;
	readonly timestampMs: number;
}

/**
 * Abstract port supplied by the P05 browser binding, which remains the owner of
 * native DOM listeners and capture. The manager tracks only injected pointer IDs
 * and removes ownership before requesting each release, so forwarded
 * release/cancel signals cannot cause a second release during reset or destroy.
 */
export interface PointerCaptureAdapter {
	setPointerCapture(pointerId: number): void;
	releasePointerCapture(pointerId: number): void;
	listen(
		type: "release" | "cancel",
		listener: (event: PointerCaptureEvent) => void,
	): () => void;
}

export interface InputManagerOptions {
	readonly pointerCapture?: PointerCaptureAdapter;
}

export class InputBackpressureError extends Error {
	readonly code = "INPUT_BACKPRESSURE";

	constructor() {
		super("input ingress capacity exceeded");
		this.name = "InputBackpressureError";
	}
}

export interface KeyboardInputAdapter {
	keyDown(event: KeyboardInputEvent, timestampMs: number): void;
	keyUp(event: Pick<KeyboardInputEvent, "code">, timestampMs: number): void;
	blur(timestampMs: number): void;
}

export interface GamepadInputAdapter {
	update(snapshot: GamepadSnapshot, timestampMs: number): boolean;
	disconnect(index: number, timestampMs: number): void;
	capabilities(): Readonly<{ canRumble: boolean }>;
}

export interface TouchInputAdapter {
	beginMove(pointerId: number, point: PointerPoint, timestampMs: number): void;
	beginLook(pointerId: number, point: PointerPoint, timestampMs: number): void;
	move(pointerId: number, point: PointerPoint, timestampMs: number): void;
	pressControl(
		action: InputAction,
		pointerId: number,
		timestampMs: number,
	): void;
	releasePointer(pointerId: number, timestampMs: number): void;
	cancelPointer(pointerId: number, timestampMs: number): void;
}

export interface InputManager {
	readonly keyboard: KeyboardInputAdapter;
	readonly gamepad: GamepadInputAdapter;
	readonly touch: TouchInputAdapter;
	frame(tick: number, timestampMs: number): InputFrame;
	pageHide(timestampMs: number): void;
	reset(): void;
	destroy(): void;
	readonly destroyed: boolean;
}

interface DeviceState {
	readonly move: InputVector2;
	readonly look: InputVector2;
	readonly held: ActionState;
}

interface QueuedInputSample {
	timestampMs: number;
	state: DeviceState;
	readonly pressed: ActionState;
	readonly released: ActionState;
	source: InputSource;
	deviceId: string;
}

interface MutableGamepadState extends DeviceState {
	readonly index: number;
	readonly canRumble: boolean;
	readonly moveAnalogValid: boolean;
	readonly lookAnalogValid: boolean;
	readonly stickUi: Readonly<Record<"up" | "down" | "left" | "right", boolean>>;
}

interface TouchPointer {
	readonly kind: "move" | "look" | "control";
	readonly start: PointerPoint;
	current: PointerPoint;
	readonly action?: InputAction;
}

const EMPTY_VECTOR = Object.freeze({ x: 0, y: 0 });

function emptyDeviceState(): DeviceState {
	return {
		move: EMPTY_VECTOR,
		look: EMPTY_VECTOR,
		held: createActionState(),
	};
}

function snapshotDeviceState(state: DeviceState): DeviceState {
	return {
		move: { ...state.move },
		look: { ...state.look },
		held: copyActionState(state.held),
	};
}

function deviceStatesEqual(
	left: Readonly<DeviceState>,
	right: Readonly<DeviceState>,
): boolean {
	if (
		left.move.x !== right.move.x ||
		left.move.y !== right.move.y ||
		left.look.x !== right.look.x ||
		left.look.y !== right.look.y
	) {
		return false;
	}
	for (const action of INPUT_ACTIONS) {
		if (left.held[action] !== right.held[action]) return false;
	}
	return true;
}

function binding(...actions: InputAction[]): readonly InputAction[] {
	return Object.freeze(actions);
}

const KEY_BINDINGS: Readonly<Record<string, readonly InputAction[]>> =
	Object.freeze({
		KeyW: binding("moveForward"),
		KeyS: binding("moveBackward"),
		KeyA: binding("moveLeft"),
		KeyD: binding("moveRight"),
		ArrowUp: binding("moveForward", "up"),
		ArrowDown: binding("moveBackward", "down"),
		ArrowLeft: binding("moveLeft", "left"),
		ArrowRight: binding("moveRight", "right"),
		Space: binding("action", "confirm"),
		KeyR: binding("resetCamera"),
		ShiftLeft: binding("boost"),
		ShiftRight: binding("boost"),
		ControlLeft: binding("brake"),
		ControlRight: binding("brake"),
		Enter: binding("confirm"),
		Escape: binding("pause", "back"),
	});

function assertTimestamp(timestampMs: number): void {
	if (!Number.isFinite(timestampMs) || timestampMs < 0) {
		throw new Error("timestamp must be a finite non-negative number");
	}
}

function isEditableTarget(target: unknown): boolean {
	if (target === null || typeof target !== "object") return false;
	const tagName =
		"tagName" in target && typeof target.tagName === "string"
			? target.tagName.toUpperCase()
			: "";
	if (["INPUT", "TEXTAREA", "SELECT", "OPTION"].includes(tagName)) return true;
	if ("isContentEditable" in target && target.isContentEditable === true) {
		return true;
	}
	if ("getAttribute" in target && typeof target.getAttribute === "function") {
		try {
			return (
				Reflect.apply(target.getAttribute, target, ["contenteditable"]) ===
				"true"
			);
		} catch {
			return false;
		}
	}
	return false;
}

interface ValidatedGamepadSnapshot extends GamepadSnapshot {
	readonly moveAnalogValid: boolean;
	readonly lookAnalogValid: boolean;
}

function gamepadIndexFromUnknown(snapshot: unknown): number | undefined {
	try {
		if (snapshot === null || typeof snapshot !== "object") return undefined;
		const index = Reflect.get(snapshot, "index");
		return Number.isSafeInteger(index) && index >= 0 && index < MAX_GAMEPADS
			? (index as number)
			: undefined;
	} catch {
		return undefined;
	}
}

function validateGamepadSnapshot(
	snapshot: unknown,
	index: number,
): ValidatedGamepadSnapshot | undefined {
	try {
		if (snapshot === null || typeof snapshot !== "object") return undefined;
		const id = Reflect.get(snapshot, "id");
		const connected = Reflect.get(snapshot, "connected");
		const mapping = Reflect.get(snapshot, "mapping");
		const rawAxes = Reflect.get(snapshot, "axes");
		const rawButtons = Reflect.get(snapshot, "buttons");
		if (
			typeof id !== "string" ||
			id.length > MAX_GAMEPAD_ID_LENGTH ||
			connected !== true ||
			mapping !== "standard" ||
			!Array.isArray(rawAxes) ||
			!Array.isArray(rawButtons)
		) {
			return undefined;
		}
		const axesLength: unknown = rawAxes.length;
		const buttonsLength: unknown = rawButtons.length;
		if (
			typeof axesLength !== "number" ||
			!Number.isSafeInteger(axesLength) ||
			axesLength < MIN_GAMEPAD_AXES ||
			axesLength > MAX_GAMEPAD_AXES ||
			typeof buttonsLength !== "number" ||
			!Number.isSafeInteger(buttonsLength) ||
			buttonsLength < MIN_GAMEPAD_BUTTONS ||
			buttonsLength > MAX_GAMEPAD_BUTTONS
		) {
			return undefined;
		}

		const axes: number[] = [];
		const axisValidity: boolean[] = [];
		for (let axisIndex = 0; axisIndex < axesLength; axisIndex += 1) {
			const value = rawAxes[axisIndex];
			if (typeof value !== "number") return undefined;
			const valid = Number.isFinite(value);
			axisValidity.push(valid);
			axes.push(valid ? Math.max(-1, Math.min(1, value)) : 0);
		}

		const buttons: GamepadButtonSnapshot[] = [];
		for (let buttonIndex = 0; buttonIndex < buttonsLength; buttonIndex += 1) {
			const rawButton = rawButtons[buttonIndex];
			if (rawButton === null || typeof rawButton !== "object") return undefined;
			const pressed = Reflect.get(rawButton, "pressed");
			const value = Reflect.get(rawButton, "value");
			if (
				typeof pressed !== "boolean" ||
				typeof value !== "number" ||
				!Number.isFinite(value) ||
				value < 0 ||
				value > 1
			) {
				return undefined;
			}
			buttons.push({ pressed, value });
		}

		return {
			id,
			index,
			connected: true,
			mapping: "standard",
			axes,
			buttons,
			canRumble: Reflect.get(snapshot, "canRumble") === true,
			moveAnalogValid: axisValidity[0] === true && axisValidity[1] === true,
			lookAnalogValid: axisValidity[2] === true && axisValidity[3] === true,
		};
	} catch {
		return undefined;
	}
}

function button(snapshot: ValidatedGamepadSnapshot, index: number): boolean {
	const value = snapshot.buttons[index];
	return value?.pressed === true || (value?.value ?? 0) >= 0.5;
}

function axis(snapshot: ValidatedGamepadSnapshot, index: number): number {
	return snapshot.axes[index] ?? 0;
}

function directionWithHysteresis(previous: boolean, value: number): boolean {
	return previous ? value > UI_RELEASE : value >= UI_ACTIVATE;
}

function actionStateFromCodes(codes: ReadonlySet<string>): ActionState {
	const state = createActionState();
	for (const code of codes) {
		if (!Object.hasOwn(KEY_BINDINGS, code)) continue;
		for (const action of KEY_BINDINGS[code] ?? []) state[action] = true;
	}
	return state;
}

function movementFromActions(actions: Readonly<ActionState>): InputVector2 {
	return normalizeVector(
		Number(actions.moveRight) - Number(actions.moveLeft),
		Number(actions.moveForward) - Number(actions.moveBackward),
	);
}

function hasMeaningfulGameplay(state: DeviceState): boolean {
	if (Math.hypot(state.move.x, state.move.y) > 0.05) return true;
	if (Math.hypot(state.look.x, state.look.y) > 0.05) return true;
	for (const action of GAMEPLAY_ACTIONS) {
		if (state.held[action]) return true;
	}
	return false;
}

function hasMeaningfulGamepadAnalog(state: MutableGamepadState): boolean {
	return (
		(state.moveAnalogValid && Math.hypot(state.move.x, state.move.y) > 0.05) ||
		(state.lookAnalogValid && Math.hypot(state.look.x, state.look.y) > 0.05)
	);
}

function hasMeaningfulVectorChange(
	previous: Readonly<InputVector2>,
	current: Readonly<InputVector2>,
	valid: boolean,
): boolean {
	if (!valid) return false;
	const deltaX = current.x - previous.x;
	const deltaY = current.y - previous.y;
	return (
		deltaX * deltaX + deltaY * deltaY >
		GAMEPAD_ANALOG_ACTIVITY_EPSILON * GAMEPAD_ANALOG_ACTIVITY_EPSILON
	);
}

function hasNewGamepadGameplayInput(
	previous: MutableGamepadState | undefined,
	activityBaseline: MutableGamepadState | undefined,
	current: MutableGamepadState,
): boolean {
	if (previous === undefined) {
		for (const action of GAMEPAD_GAMEPLAY_BUTTON_ACTIONS) {
			if (current.held[action]) return true;
		}
		return hasMeaningfulGamepadAnalog(current);
	}
	for (const action of GAMEPAD_GAMEPLAY_BUTTON_ACTIONS) {
		if (!previous.held[action] && current.held[action]) return true;
	}
	const baseline = activityBaseline ?? previous;
	return (
		hasMeaningfulVectorChange(
			baseline.move,
			current.move,
			current.moveAnalogValid,
		) ||
		hasMeaningfulVectorChange(
			baseline.look,
			current.look,
			current.lookAnalogValid,
		)
	);
}

function gamepadState(
	snapshot: ValidatedGamepadSnapshot,
	previous?: MutableGamepadState,
): MutableGamepadState {
	const move = snapshot.moveAnalogValid
		? normalizeRadialStick(axis(snapshot, 0), -axis(snapshot, 1))
		: EMPTY_VECTOR;
	const look = snapshot.lookAnalogValid
		? normalizeRadialStick(axis(snapshot, 2), -axis(snapshot, 3))
		: EMPTY_VECTOR;
	const held = createActionState();
	const stickUi = {
		up: directionWithHysteresis(
			previous?.stickUi.up ?? false,
			-axis(snapshot, 1),
		),
		down: directionWithHysteresis(
			previous?.stickUi.down ?? false,
			axis(snapshot, 1),
		),
		left: directionWithHysteresis(
			previous?.stickUi.left ?? false,
			-axis(snapshot, 0),
		),
		right: directionWithHysteresis(
			previous?.stickUi.right ?? false,
			axis(snapshot, 0),
		),
	};
	held.moveForward = move.y > 0.01;
	held.moveBackward = move.y < -0.01;
	held.moveLeft = move.x < -0.01;
	held.moveRight = move.x > 0.01;
	held.action = button(snapshot, 0);
	held.confirm = held.action;
	held.back = button(snapshot, 1);
	held.boost = button(snapshot, 2) || button(snapshot, 5);
	held.resetCamera = button(snapshot, 3);
	held.brake = button(snapshot, 4) || axis(snapshot, 4) > 0.5;
	held.pause = button(snapshot, 9);
	held.up = button(snapshot, 12) || stickUi.up;
	held.down = button(snapshot, 13) || stickUi.down;
	held.left = button(snapshot, 14) || stickUi.left;
	held.right = button(snapshot, 15) || stickUi.right;
	return {
		index: snapshot.index,
		canRumble: snapshot.canRumble === true,
		moveAnalogValid: snapshot.moveAnalogValid,
		lookAnalogValid: snapshot.lookAnalogValid,
		move,
		look,
		held,
		stickUi,
	};
}

function freezeFrame(
	tick: number,
	timestampMs: number,
	state: DeviceState,
	pressed: ActionState,
	released: ActionState,
	source: InputSource,
	deviceId: string,
): InputFrame {
	return Object.freeze({
		version: INPUT_FRAME_VERSION,
		tick,
		timestampMs,
		move: Object.freeze({ ...state.move }),
		look: Object.freeze({ ...state.look }),
		held: Object.freeze(copyActionState(state.held)),
		pressed: Object.freeze(pressed),
		released: Object.freeze(released),
		source,
		deviceId,
	});
}

export function createInputManager(
	options: Readonly<InputManagerOptions> = {},
): InputManager {
	const keyboardCodes = new Set<string>();
	const gamepads = new Map<number, MutableGamepadState>();
	const gamepadActivityBaselines = new Map<number, MutableGamepadState>();
	const touchPointers = new Map<number, TouchPointer>();
	let samples: QueuedInputSample[] = [];
	let source: InputSource = "keyboard";
	let deviceId = "keyboard";
	let sourceActivityMs = Number.NEGATIVE_INFINITY;
	let publishedState = emptyDeviceState();
	let publishedSource: InputSource = "keyboard";
	let publishedDeviceId = "keyboard";
	let rawTimestampHighWaterMs = Number.NEGATIVE_INFINITY;
	let lastFrameTick: number | undefined;
	let lastFrameTimestampMs: number | undefined;
	let destroyed = false;

	function acceptRawTimestamp(timestampMs: number): void {
		assertTimestamp(timestampMs);
		if (timestampMs < rawTimestampHighWaterMs) {
			throw new Error("raw timestamp must be manager-wide nondecreasing");
		}
		rawTimestampHighWaterMs = timestampMs;
	}

	function assertAlive(): void {
		if (destroyed) throw new Error("input manager is destroyed");
	}

	function claim(
		candidateSource: InputSource,
		candidateDeviceId: string,
		timestampMs: number,
	): void {
		if (candidateSource === source) {
			deviceId = candidateDeviceId;
			sourceActivityMs = Math.max(sourceActivityMs, timestampMs);
			return;
		}
		if (timestampMs - sourceActivityMs >= SOURCE_OWNERSHIP_MS) {
			source = candidateSource;
			deviceId = candidateDeviceId;
			sourceActivityMs = timestampMs;
		}
	}

	function keyboardState(): DeviceState {
		const held = actionStateFromCodes(keyboardCodes);
		return { move: movementFromActions(held), look: EMPTY_VECTOR, held };
	}

	function touchState(): DeviceState {
		const held = createActionState();
		let analogMove: InputVector2 = EMPTY_VECTOR;
		let look: InputVector2 = EMPTY_VECTOR;
		for (const pointer of touchPointers.values()) {
			if (pointer.kind === "control" && pointer.action !== undefined) {
				held[pointer.action] = true;
			} else if (pointer.kind === "move") {
				analogMove = normalizeVector(
					(pointer.current.x - pointer.start.x) / TOUCH_STICK_RADIUS_PX,
					(pointer.start.y - pointer.current.y) / TOUCH_STICK_RADIUS_PX,
				);
			} else if (pointer.kind === "look") {
				look = normalizeVector(
					(pointer.current.x - pointer.start.x) / TOUCH_LOOK_SCALE_PX,
					(pointer.start.y - pointer.current.y) / TOUCH_LOOK_SCALE_PX,
				);
			}
		}
		const move = normalizeVector(
			analogMove.x + Number(held.moveRight) - Number(held.moveLeft),
			analogMove.y + Number(held.moveForward) - Number(held.moveBackward),
		);
		held.moveForward ||= analogMove.y > 0.01;
		held.moveBackward ||= analogMove.y < -0.01;
		held.moveLeft ||= analogMove.x < -0.01;
		held.moveRight ||= analogMove.x > 0.01;
		return { move, look, held };
	}

	function gamepadOwnerState(): DeviceState {
		const index = Number.parseInt(deviceId.slice("gamepad-".length), 10);
		return (
			gamepads.get(index) ?? {
				move: EMPTY_VECTOR,
				look: EMPTY_VECTOR,
				held: createActionState(),
			}
		);
	}

	function currentOwnerState(): DeviceState {
		if (source === "touch") return touchState();
		if (source === "gamepad") return gamepadOwnerState();
		return keyboardState();
	}

	function currentOutputState(): DeviceState {
		const owner = currentOwnerState();
		const held = createActionState();
		for (const action of GAMEPLAY_ACTIONS) held[action] = owner.held[action];
		const allStates: DeviceState[] = [
			keyboardState(),
			touchState(),
			...gamepads.values(),
		];
		for (const action of UI_ACTIONS) {
			held[action] = allStates.some((state) => state.held[action]);
		}
		return { move: owner.move, look: owner.look, held };
	}

	function transitionEdges(
		before: Readonly<ActionState>,
		after: Readonly<ActionState>,
	): Readonly<{ pressed: ActionState; released: ActionState }> {
		const pressed = createActionState();
		const released = createActionState();
		for (const action of INPUT_ACTIONS) {
			if (!before[action] && after[action]) pressed[action] = true;
			if (before[action] && !after[action]) released[action] = true;
		}
		return { pressed, released };
	}

	function mutateState(timestampMs: number, mutation: () => void): void {
		const lastSample = samples[samples.length - 1];
		if (
			samples.length >= MAX_PENDING_SAMPLES &&
			lastSample?.timestampMs !== timestampMs
		) {
			throw new InputBackpressureError();
		}
		const beforeState = currentOutputState();
		const beforeSource = source;
		const beforeDeviceId = deviceId;
		mutation();
		const state = currentOutputState();
		if (
			beforeSource === source &&
			beforeDeviceId === deviceId &&
			deviceStatesEqual(beforeState, state)
		) {
			return;
		}
		const edges = transitionEdges(beforeState.held, state.held);
		const sample: QueuedInputSample = {
			timestampMs,
			state: snapshotDeviceState(state),
			pressed: edges.pressed,
			released: edges.released,
			source,
			deviceId,
		};
		if (lastSample?.timestampMs === timestampMs) {
			lastSample.state = sample.state;
			lastSample.source = sample.source;
			lastSample.deviceId = sample.deviceId;
			for (const action of INPUT_ACTIONS) {
				lastSample.pressed[action] ||= sample.pressed[action];
				lastSample.released[action] ||= sample.released[action];
			}
			return;
		}
		samples.push(sample);
	}

	function detachAllSources(): number[] {
		const pointerIds = [...touchPointers.keys()];
		keyboardCodes.clear();
		gamepads.clear();
		gamepadActivityBaselines.clear();
		touchPointers.clear();
		source = "keyboard";
		deviceId = "keyboard";
		sourceActivityMs = Number.NEGATIVE_INFINITY;
		return pointerIds;
	}

	function attemptPointerCaptureReleases(
		pointerIds: readonly number[],
		errors: unknown[],
	): void {
		for (const pointerId of pointerIds) {
			try {
				options.pointerCapture?.releasePointerCapture(pointerId);
			} catch (error) {
				errors.push(error);
			}
		}
	}

	function throwCleanupErrors(
		message: string,
		errors: readonly unknown[],
	): void {
		if (errors.length > 0) throw new AggregateError(errors, message);
	}

	function releaseAllSources(timestampMs: number): void {
		const liveState = currentOutputState();
		const released = createActionState();
		for (const action of INPUT_ACTIONS) {
			released[action] = liveState.held[action] || publishedState.held[action];
		}
		const pointerIds = detachAllSources();
		const neutralState = currentOutputState();
		samples = [
			{
				timestampMs,
				state: snapshotDeviceState(neutralState),
				pressed: createActionState(),
				released,
				source,
				deviceId,
			},
		];
		const errors: unknown[] = [];
		attemptPointerCaptureReleases(pointerIds, errors);
		throwCleanupErrors("native capture release failed", errors);
	}

	function clearInternalState(): readonly number[] {
		const pointerIds = detachAllSources();
		samples = [];
		publishedState = emptyDeviceState();
		publishedSource = "keyboard";
		publishedDeviceId = "keyboard";
		lastFrameTick = undefined;
		return pointerIds;
	}

	const keyboard: KeyboardInputAdapter = {
		keyDown(event, timestampMs) {
			assertAlive();
			acceptRawTimestamp(timestampMs);
			if (
				typeof event.code !== "string" ||
				event.code.length > MAX_KEYBOARD_CODE_LENGTH
			) {
				return;
			}
			const actions = Object.hasOwn(KEY_BINDINGS, event.code)
				? KEY_BINDINGS[event.code]
				: undefined;
			if (
				event.repeat === true ||
				isEditableTarget(event.target) ||
				actions === undefined ||
				keyboardCodes.has(event.code)
			) {
				return;
			}
			mutateState(timestampMs, () => {
				keyboardCodes.add(event.code);
				if (actions.some(isGameplayAction)) {
					claim("keyboard", "keyboard", timestampMs);
				}
			});
		},
		keyUp(event, timestampMs) {
			assertAlive();
			acceptRawTimestamp(timestampMs);
			if (
				typeof event.code !== "string" ||
				event.code.length > MAX_KEYBOARD_CODE_LENGTH ||
				!Object.hasOwn(KEY_BINDINGS, event.code) ||
				!keyboardCodes.has(event.code)
			) {
				return;
			}
			mutateState(timestampMs, () => keyboardCodes.delete(event.code));
		},
		blur(timestampMs) {
			assertAlive();
			acceptRawTimestamp(timestampMs);
			releaseAllSources(timestampMs);
		},
	};

	const gamepad: GamepadInputAdapter = {
		update(snapshot, timestampMs) {
			assertAlive();
			const index = gamepadIndexFromUnknown(snapshot);
			const validatedSnapshot =
				index === undefined
					? undefined
					: validateGamepadSnapshot(snapshot, index);
			if (validatedSnapshot === undefined) {
				assertTimestamp(timestampMs);
				if (index === undefined || !gamepads.has(index)) return false;
				acceptRawTimestamp(timestampMs);
				mutateState(timestampMs, () => {
					gamepads.delete(index);
					gamepadActivityBaselines.delete(index);
					if (source === "gamepad" && deviceId === `gamepad-${index}`) {
						source = "keyboard";
						deviceId = "keyboard";
						sourceActivityMs = Number.NEGATIVE_INFINITY;
					}
				});
				return false;
			}

			acceptRawTimestamp(timestampMs);
			mutateState(timestampMs, () => {
				const previous = gamepads.get(validatedSnapshot.index);
				const activityBaseline = gamepadActivityBaselines.get(
					validatedSnapshot.index,
				);
				const state = gamepadState(validatedSnapshot, previous);
				const hasNewGameplayInput = hasNewGamepadGameplayInput(
					previous,
					activityBaseline,
					state,
				);
				gamepads.set(validatedSnapshot.index, state);
				if (activityBaseline === undefined || hasNewGameplayInput) {
					gamepadActivityBaselines.set(validatedSnapshot.index, state);
				}
				if (hasNewGameplayInput) {
					claim("gamepad", `gamepad-${validatedSnapshot.index}`, timestampMs);
				}
			});
			return true;
		},
		disconnect(index, timestampMs) {
			assertAlive();
			acceptRawTimestamp(timestampMs);
			if (
				!Number.isSafeInteger(index) ||
				index < 0 ||
				index >= MAX_GAMEPADS ||
				!gamepads.has(index)
			) {
				return;
			}
			mutateState(timestampMs, () => {
				gamepads.delete(index);
				gamepadActivityBaselines.delete(index);
				if (source === "gamepad" && deviceId === `gamepad-${index}`) {
					source = "keyboard";
					deviceId = "keyboard";
					sourceActivityMs = Number.NEGATIVE_INFINITY;
				}
			});
		},
		capabilities() {
			assertAlive();
			let canRumble = false;
			for (const state of gamepads.values()) {
				if (!state.canRumble) continue;
				canRumble = true;
				break;
			}
			return Object.freeze({ canRumble });
		},
	};

	function registerTouchPointer(
		pointerId: number,
		pointer: TouchPointer,
		timestampMs: number,
		claimGameplay: boolean,
	): void {
		if (
			touchPointers.has(pointerId) ||
			touchPointers.size >= MAX_TOUCH_POINTERS
		) {
			return;
		}
		options.pointerCapture?.setPointerCapture(pointerId);
		try {
			mutateState(timestampMs, () => {
				touchPointers.set(pointerId, pointer);
				if (claimGameplay) claim("touch", "touch", timestampMs);
			});
		} catch (error) {
			touchPointers.delete(pointerId);
			const cleanupErrors: unknown[] = [];
			attemptPointerCaptureReleases([pointerId], cleanupErrors);
			if (cleanupErrors.length > 0) {
				throw new AggregateError(
					[error, ...cleanupErrors],
					"pointer capture registration failed",
				);
			}
			throw error;
		}
	}

	function beginPointer(
		pointerId: number,
		point: PointerPoint,
		kind: "move" | "look",
		timestampMs: number,
	): void {
		assertAlive();
		acceptRawTimestamp(timestampMs);
		if (!Number.isSafeInteger(pointerId) || pointerId < 0) {
			throw new Error("pointerId must be a non-negative safe integer");
		}
		if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
			throw new Error("pointer point must be finite");
		}
		registerTouchPointer(
			pointerId,
			{
				kind,
				start: { ...point },
				current: { ...point },
			},
			timestampMs,
			false,
		);
	}

	function finishPointer(pointerId: number, timestampMs: number): void {
		assertAlive();
		acceptRawTimestamp(timestampMs);
		if (!touchPointers.has(pointerId)) return;
		mutateState(timestampMs, () => touchPointers.delete(pointerId));
		const errors: unknown[] = [];
		attemptPointerCaptureReleases([pointerId], errors);
		throwCleanupErrors("native capture release failed", errors);
	}

	const touch: TouchInputAdapter = {
		beginMove(pointerId, point, timestampMs) {
			beginPointer(pointerId, point, "move", timestampMs);
		},
		beginLook(pointerId, point, timestampMs) {
			beginPointer(pointerId, point, "look", timestampMs);
		},
		move(pointerId, point, timestampMs) {
			assertAlive();
			acceptRawTimestamp(timestampMs);
			const pointer = touchPointers.get(pointerId);
			if (
				pointer === undefined ||
				!Number.isFinite(point.x) ||
				!Number.isFinite(point.y)
			)
				return;
			mutateState(timestampMs, () => {
				pointer.current = { ...point };
				if (hasMeaningfulGameplay(touchState())) {
					claim("touch", "touch", timestampMs);
				}
			});
		},
		pressControl(action, pointerId, timestampMs) {
			assertAlive();
			acceptRawTimestamp(timestampMs);
			if (!INPUT_ACTIONS.includes(action))
				throw new Error("unknown touch action");
			if (!Number.isSafeInteger(pointerId) || pointerId < 0) {
				throw new Error("pointerId must be a non-negative safe integer");
			}
			registerTouchPointer(
				pointerId,
				{
					kind: "control",
					start: { x: 0, y: 0 },
					current: { x: 0, y: 0 },
					action,
				},
				timestampMs,
				isGameplayAction(action),
			);
		},
		releasePointer(pointerId, timestampMs) {
			finishPointer(pointerId, timestampMs);
		},
		cancelPointer(pointerId, timestampMs) {
			finishPointer(pointerId, timestampMs);
		},
	};

	let stopPointerRelease: () => void = () => undefined;
	let stopPointerCancel: () => void = () => undefined;
	if (options.pointerCapture !== undefined) {
		let registeredRelease: (() => void) | undefined;
		try {
			const releaseDisposer: unknown = options.pointerCapture.listen(
				"release",
				(event) => {
					finishPointer(event.pointerId, event.timestampMs);
				},
			);
			if (typeof releaseDisposer !== "function") {
				throw new TypeError("release listener did not return a disposer");
			}
			const release = (): void => {
				releaseDisposer();
			};
			registeredRelease = release;
			const cancelDisposer: unknown = options.pointerCapture.listen(
				"cancel",
				(event) => {
					finishPointer(event.pointerId, event.timestampMs);
				},
			);
			if (typeof cancelDisposer !== "function") {
				throw new TypeError("cancel listener did not return a disposer");
			}
			const cancel = (): void => {
				cancelDisposer();
			};
			stopPointerRelease = release;
			stopPointerCancel = cancel;
		} catch (error) {
			const errors: unknown[] = [error];
			if (registeredRelease !== undefined) {
				try {
					registeredRelease();
				} catch (cleanupError) {
					errors.push(cleanupError);
				}
			}
			throw new AggregateError(errors, "pointer listener registration failed");
		}
	}

	return {
		keyboard,
		gamepad,
		touch,
		frame(tick, timestampMs) {
			assertAlive();
			assertTimestamp(timestampMs);
			if (!Number.isSafeInteger(tick) || tick < 0) {
				throw new Error("tick must be a non-negative safe integer");
			}
			if (lastFrameTick !== undefined && tick <= lastFrameTick) {
				throw new Error("frame requires a strictly increasing tick");
			}
			if (
				lastFrameTimestampMs !== undefined &&
				timestampMs < lastFrameTimestampMs
			) {
				throw new Error("frame timestamp must be monotonic");
			}
			lastFrameTick = tick;
			lastFrameTimestampMs = timestampMs;

			const pressed = createActionState();
			const released = createActionState();
			let drainedCount = 0;
			for (const sample of samples) {
				if (sample.timestampMs > timestampMs) break;
				for (const action of INPUT_ACTIONS) {
					pressed[action] ||= sample.pressed[action];
					released[action] ||= sample.released[action];
				}
				publishedState = sample.state;
				publishedSource = sample.source;
				publishedDeviceId = sample.deviceId;
				drainedCount += 1;
			}
			if (drainedCount > 0) samples.splice(0, drainedCount);
			return freezeFrame(
				tick,
				timestampMs,
				publishedState,
				pressed,
				released,
				publishedSource,
				publishedDeviceId,
			);
		},
		pageHide(timestampMs) {
			assertAlive();
			acceptRawTimestamp(timestampMs);
			releaseAllSources(timestampMs);
		},
		reset() {
			assertAlive();
			const pointerIds = clearInternalState();
			const errors: unknown[] = [];
			attemptPointerCaptureReleases(pointerIds, errors);
			throwCleanupErrors("input manager reset cleanup failed", errors);
		},
		destroy() {
			if (destroyed) return;
			destroyed = true;
			const errors: unknown[] = [];
			let pointerIds: readonly number[] = [];
			try {
				pointerIds = clearInternalState();
			} catch (error) {
				errors.push(error);
			}
			attemptPointerCaptureReleases(pointerIds, errors);
			const releaseDisposer = stopPointerRelease;
			const cancelDisposer = stopPointerCancel;
			stopPointerRelease = () => undefined;
			stopPointerCancel = () => undefined;
			for (const dispose of [releaseDisposer, cancelDisposer]) {
				try {
					dispose();
				} catch (error) {
					errors.push(error);
				}
			}
			throwCleanupErrors("input manager cleanup failed", errors);
		},
		get destroyed() {
			return destroyed;
		},
	};
}
