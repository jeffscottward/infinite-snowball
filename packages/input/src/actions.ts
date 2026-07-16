export const INPUT_FRAME_VERSION = 1 as const;

export const INPUT_ACTIONS = Object.freeze([
	"moveForward",
	"moveBackward",
	"moveLeft",
	"moveRight",
	"brake",
	"boost",
	"action",
	"pause",
	"resetCamera",
	"up",
	"down",
	"left",
	"right",
	"confirm",
	"back",
] as const);

export type InputAction = (typeof INPUT_ACTIONS)[number];
export type InputSource = "keyboard" | "gamepad" | "touch";
export type ActionState = Record<InputAction, boolean>;

export interface InputVector2 {
	readonly x: number;
	readonly y: number;
}

export interface InputFrame {
	readonly version: typeof INPUT_FRAME_VERSION;
	readonly tick: number;
	readonly timestampMs: number;
	readonly move: InputVector2;
	readonly look: InputVector2;
	readonly held: Readonly<ActionState>;
	readonly pressed: Readonly<ActionState>;
	readonly released: Readonly<ActionState>;
	readonly source: InputSource;
	readonly deviceId: string;
}

export function createActionState(): ActionState {
	return Object.fromEntries(
		INPUT_ACTIONS.map((action) => [action, false]),
	) as ActionState;
}

export function copyActionState(source: Readonly<ActionState>): ActionState {
	const copy = createActionState();
	for (const action of INPUT_ACTIONS) copy[action] = source[action];
	return copy;
}

export function normalizeVector(x: number, y: number): InputVector2 {
	const safeX = Number.isFinite(x) ? x : 0;
	const safeY = Number.isFinite(y) ? y : 0;
	const scale = Math.max(Math.abs(safeX), Math.abs(safeY));
	if (scale === 0) return { x: safeX, y: safeY };
	if (scale <= 1) {
		const magnitude = Math.hypot(safeX, safeY);
		if (magnitude <= 1) return { x: safeX, y: safeY };
		return { x: safeX / magnitude, y: safeY / magnitude };
	}
	const scaledX = safeX / scale;
	const scaledY = safeY / scale;
	const scaledMagnitude = Math.hypot(scaledX, scaledY);
	return {
		x: scaledX / scaledMagnitude,
		y: scaledY / scaledMagnitude,
	};
}

export function normalizeRadialStick(
	x: number,
	y: number,
	deadzone = 0.2,
): InputVector2 {
	if (!Number.isFinite(deadzone) || deadzone < 0 || deadzone >= 1) {
		throw new Error("deadzone must be finite and in [0, 1)");
	}
	const vector = normalizeVector(x, y);
	const magnitude = Math.hypot(vector.x, vector.y);
	if (magnitude <= deadzone) return { x: 0, y: 0 };
	const scaledMagnitude = Math.min(1, (magnitude - deadzone) / (1 - deadzone));
	return {
		x: (vector.x / magnitude) * scaledMagnitude,
		y: (vector.y / magnitude) * scaledMagnitude,
	};
}

export const GAMEPLAY_ACTIONS = Object.freeze([
	"moveForward",
	"moveBackward",
	"moveLeft",
	"moveRight",
	"brake",
	"boost",
	"action",
	"resetCamera",
] as const satisfies readonly InputAction[]);

export type GameplayInputAction = (typeof GAMEPLAY_ACTIONS)[number];

export function isGameplayAction(
	action: InputAction,
): action is GameplayInputAction {
	return (GAMEPLAY_ACTIONS as readonly InputAction[]).includes(action);
}

export const UI_INPUT_ACTIONS = Object.freeze([
	"pause",
	"up",
	"down",
	"left",
	"right",
	"confirm",
	"back",
] as const satisfies readonly InputAction[]);

export type UiInputAction = (typeof UI_INPUT_ACTIONS)[number];
export type UiActionState = Record<UiInputAction, boolean>;

export const UI_ACTIONS: readonly InputAction[] = UI_INPUT_ACTIONS;
