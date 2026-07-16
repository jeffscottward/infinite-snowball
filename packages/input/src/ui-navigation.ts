import {
	type ActionState,
	type InputFrame,
	type InputSource,
	UI_INPUT_ACTIONS,
	type UiActionState,
	type UiInputAction,
} from "./actions.js";

export interface UiInputSnapshot {
	readonly tick: number;
	readonly timestampMs: number;
	readonly source: InputSource;
	readonly deviceId: string;
	readonly held: Readonly<UiActionState>;
	readonly pressed: Readonly<UiActionState>;
	readonly released: Readonly<UiActionState>;
}

function projectActionState(
	state: Readonly<ActionState>,
): Readonly<UiActionState> {
	const projected = {} as UiActionState;
	for (const action of UI_INPUT_ACTIONS) projected[action] = state[action];
	return Object.freeze(projected);
}

export function projectUiInput(frame: Readonly<InputFrame>): UiInputSnapshot {
	return Object.freeze({
		tick: frame.tick,
		timestampMs: frame.timestampMs,
		source: frame.source,
		deviceId: frame.deviceId,
		held: projectActionState(frame.held),
		pressed: projectActionState(frame.pressed),
		released: projectActionState(frame.released),
	});
}

export interface UiFocusNode {
	readonly id: string;
	readonly up?: string;
	readonly down?: string;
	readonly left?: string;
	readonly right?: string;
}

export interface UiFocusSnapshot {
	readonly tick: number;
	readonly focusId: string;
	readonly activatedId: string | undefined;
	readonly backRequested: boolean;
	readonly pauseRequested: boolean;
}

export interface UiFocusNavigator {
	update(frame: Readonly<InputFrame>): UiFocusSnapshot;
	reset(initialFocusId?: string): void;
	destroy(): void;
	readonly focusId: string;
	readonly destroyed: boolean;
}

const DIRECTION_ACTIONS = Object.freeze([
	"up",
	"down",
	"left",
	"right",
] as const satisfies readonly UiInputAction[]);

function requireId(id: string, label: string): string {
	if (id.length === 0 || id.trim() !== id) {
		throw new Error(
			`${label} must be a non-empty stable ID without edge whitespace`,
		);
	}
	return id;
}

function stableFirst(ids: Iterable<string>): string {
	const sorted = [...ids].sort((left, right) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
	const first = sorted[0];
	if (first === undefined) throw new Error("UI focus graph must not be empty");
	return first;
}

export function createUiFocusNavigator(
	inputNodes: readonly Readonly<UiFocusNode>[],
	initialFocusId?: string,
): UiFocusNavigator {
	const nodes = new Map<string, Readonly<UiFocusNode>>();
	for (const inputNode of inputNodes) {
		const id = requireId(inputNode.id, "UI focus node ID");
		if (nodes.has(id)) throw new Error(`duplicate UI focus node ID: ${id}`);
		nodes.set(id, Object.freeze({ ...inputNode, id }));
	}
	const defaultFocusId = stableFirst(nodes.keys());
	for (const node of nodes.values()) {
		for (const direction of DIRECTION_ACTIONS) {
			const targetId = node[direction];
			if (targetId !== undefined && !nodes.has(targetId)) {
				throw new Error(
					`UI focus node ${node.id} has missing ${direction} target: ${targetId}`,
				);
			}
		}
	}

	function resolveFocus(id: string | undefined): string {
		const nextId = id ?? defaultFocusId;
		if (!nodes.has(nextId))
			throw new Error(`unknown UI focus node ID: ${nextId}`);
		return nextId;
	}

	let currentFocusId = resolveFocus(initialFocusId);
	let lastTick = -1;
	let destroyed = false;

	function assertAlive(): void {
		if (destroyed) throw new Error("UI focus navigator is destroyed");
	}

	return Object.freeze({
		update(frame: Readonly<InputFrame>) {
			assertAlive();
			if (!Number.isSafeInteger(frame.tick) || frame.tick <= lastTick) {
				throw new Error("UI input frame tick must increase monotonically");
			}
			lastTick = frame.tick;
			const input = projectUiInput(frame);
			const currentNode = nodes.get(currentFocusId);
			if (currentNode === undefined) {
				throw new Error(`missing current UI focus node: ${currentFocusId}`);
			}
			for (const direction of DIRECTION_ACTIONS) {
				if (!input.pressed[direction]) continue;
				currentFocusId = currentNode[direction] ?? currentFocusId;
				break;
			}
			return Object.freeze({
				tick: frame.tick,
				focusId: currentFocusId,
				activatedId: input.pressed.confirm ? currentFocusId : undefined,
				backRequested: input.pressed.back,
				pauseRequested: input.pressed.pause,
			});
		},
		reset(nextInitialFocusId?: string) {
			assertAlive();
			currentFocusId = resolveFocus(nextInitialFocusId);
			lastTick = -1;
		},
		destroy() {
			if (destroyed) return;
			nodes.clear();
			destroyed = true;
		},
		get focusId() {
			assertAlive();
			return currentFocusId;
		},
		get destroyed() {
			return destroyed;
		},
	});
}
