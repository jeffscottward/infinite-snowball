import {
	createFixedStepClock,
	FIXED_STEP_SECONDS,
	type FixedStepClock,
	type SimulationTick,
} from "@infinite-snowball/engine";
import type { InputFrame } from "@infinite-snowball/input";

import type { PhysicsEventValue } from "./events.js";
import {
	setFiniteF32Vector3,
	setNormalizedFiniteQuaternion,
} from "./rapier-scalar.js";

import type { PhysicsTransform } from "./transforms.js";

export interface PhysicsEvent<
	TPayload extends PhysicsEventValue = PhysicsEventValue,
> {
	readonly entityId: string;
	readonly otherEntityId?: string;
	readonly kind: string;
	readonly sequence: number;
	readonly payload?: TPayload;
}

export interface RuntimeTickSnapshot<
	TPayload extends PhysicsEventValue = PhysicsEventValue,
> {
	readonly tick: number;
	readonly input: InputFrame;
	readonly events: readonly PhysicsEvent<TPayload>[];
	readonly transforms: readonly PhysicsTransform[];
}

export interface RuntimeLoopCallbacks<
	TPayload extends PhysicsEventValue = PhysicsEventValue,
> {
	readInput(tick: number, timestampMs: number): InputFrame;
	applyController(input: InputFrame, tick: number): void;
	stepPhysics(deltaSeconds: number, tick: number): void;
	drainPhysicsEvents(tick: number): readonly PhysicsEvent<TPayload>[];
	processPhysicsEvents(
		events: readonly PhysicsEvent<TPayload>[],
		tick: number,
	): void;
	collect(events: readonly PhysicsEvent<TPayload>[], tick: number): void;
	disableAndAttach(tick: number): void;
	applyGrowth(tick: number): void;
	updateStreaming(tick: number): void;
	captureTransforms(tick: number): readonly PhysicsTransform[];
	publishSnapshot(snapshot: RuntimeTickSnapshot<TPayload>): void;
	updateUi(snapshot: RuntimeTickSnapshot<TPayload>): void;
	resetInput(): void;
	resetPhysics(): void;
	destroyInput(): void;
	destroyPhysics(): void;
}

export interface RuntimeAdvance<
	TPayload extends PhysicsEventValue = PhysicsEventValue,
> {
	readonly steps: readonly RuntimeTickSnapshot<TPayload>[];
	readonly alpha: number;
	readonly droppedTicks: number;
}

export interface ManualRuntimeLoop<
	TPayload extends PhysicsEventValue = PhysicsEventValue,
> {
	advance(timestampMs: number, hidden: boolean): RuntimeAdvance<TPayload>;
	reset(): void;
	destroy(): void;
	readonly tick: number;
}

function ordinal(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (value === null || typeof value !== "object" || seen.has(value)) {
		return value;
	}
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) {
		deepFreeze(Reflect.get(value, key), seen);
	}
	Object.freeze(value);
	return value;
}

function copiedEvents<TPayload extends PhysicsEventValue>(
	events: readonly PhysicsEvent<TPayload>[],
): readonly PhysicsEvent<TPayload>[] {
	const copied: PhysicsEvent<TPayload>[] = [...structuredClone(events)];
	copied.sort((left, right) => {
		const entity = ordinal(left.entityId, right.entityId);
		if (entity !== 0) return entity;
		const kind = ordinal(left.kind, right.kind);
		if (kind !== 0) return kind;
		const other = ordinal(left.otherEntityId ?? "", right.otherEntityId ?? "");
		return other === 0 ? left.sequence - right.sequence : other;
	});
	return deepFreeze(copied);
}

function copiedTransforms(
	transforms: readonly PhysicsTransform[],
): readonly PhysicsTransform[] {
	const copied: PhysicsTransform[] = [];
	for (let index = 0; index < transforms.length; index += 1) {
		const entry = transforms[index];
		if (entry === undefined) {
			throw new Error("physics transform entry must be defined");
		}
		const position = { x: 0, y: 0, z: 0 };
		const rotation = { x: 0, y: 0, z: 0, w: 1 };
		const scale = { x: 0, y: 0, z: 0 };
		setFiniteF32Vector3(position, entry.position, "physics transform position");
		setNormalizedFiniteQuaternion(
			rotation,
			entry.rotation.x,
			entry.rotation.y,
			entry.rotation.z,
			entry.rotation.w,
			"physics transform rotation",
		);
		setFiniteF32Vector3(scale, entry.scale, "physics transform scale");
		copied.push(
			Object.freeze({
				id: entry.id,
				position: Object.freeze(position),
				rotation: Object.freeze(rotation),
				scale: Object.freeze(scale),
			}),
		);
	}
	copied.sort((left, right) => ordinal(left.id, right.id));
	for (let index = 0; index < copied.length; index += 1) {
		const entry = copied[index];
		if (entry === undefined) continue;
		if (entry.id.length === 0) {
			throw new Error("physics transform ID must be non-empty");
		}
		if (index > 0 && copied[index - 1]?.id === entry.id) {
			throw new Error(`duplicate physics transform ID: ${entry.id}`);
		}
	}
	return Object.freeze(copied);
}

export function createManualRuntimeLoop<
	TPayload extends PhysicsEventValue = PhysicsEventValue,
>(callbacks: RuntimeLoopCallbacks<TPayload>): ManualRuntimeLoop<TPayload> {
	const clock: FixedStepClock = createFixedStepClock();
	let destroyed = false;
	let pendingTicks: SimulationTick[] = [];
	let deferredDroppedTicks = 0;

	function assertAlive(): void {
		if (destroyed) throw new Error("manual runtime loop is destroyed");
	}

	function runSimulationTick(
		simulationTick: SimulationTick,
	): RuntimeTickSnapshot<TPayload> {
		const input = deepFreeze(
			structuredClone(
				callbacks.readInput(simulationTick.tick, simulationTick.timestampMs),
			),
		);
		callbacks.applyController(input, simulationTick.tick);
		callbacks.stepPhysics(FIXED_STEP_SECONDS, simulationTick.tick);
		const events = copiedEvents(
			callbacks.drainPhysicsEvents(simulationTick.tick),
		);
		callbacks.processPhysicsEvents(events, simulationTick.tick);
		callbacks.collect(events, simulationTick.tick);
		callbacks.disableAndAttach(simulationTick.tick);
		callbacks.applyGrowth(simulationTick.tick);
		callbacks.updateStreaming(simulationTick.tick);
		const transforms = copiedTransforms(
			callbacks.captureTransforms(simulationTick.tick),
		);
		const snapshot = Object.freeze({
			tick: simulationTick.tick,
			input,
			events,
			transforms,
		});
		callbacks.publishSnapshot(snapshot);
		callbacks.updateUi(snapshot);
		return snapshot;
	}

	return {
		advance(timestampMs, hidden) {
			assertAlive();
			const advance = clock.advance(timestampMs, hidden);
			if (hidden) {
				return Object.freeze({
					steps: Object.freeze([]),
					alpha: advance.alpha,
					droppedTicks: advance.droppedTicks,
				});
			}
			const ticks =
				pendingTicks.length === 0
					? advance.ticks
					: [...pendingTicks, ...advance.ticks];
			pendingTicks = [];
			const steps: RuntimeTickSnapshot<TPayload>[] = [];
			for (let index = 0; index < ticks.length; index += 1) {
				const simulationTick = ticks[index];
				if (simulationTick === undefined) continue;
				try {
					steps.push(runSimulationTick(simulationTick));
				} catch (error) {
					pendingTicks = ticks.slice(index + 1);
					deferredDroppedTicks += advance.droppedTicks;
					throw error;
				}
			}
			const droppedTicks = deferredDroppedTicks + advance.droppedTicks;
			deferredDroppedTicks = 0;
			return Object.freeze({
				steps: Object.freeze(steps),
				alpha: advance.alpha,
				droppedTicks,
			});
		},
		reset() {
			assertAlive();
			callbacks.resetInput();
			callbacks.resetPhysics();
			pendingTicks = [];
			deferredDroppedTicks = 0;
			clock.reset();
		},
		destroy() {
			if (destroyed) return;
			destroyed = true;
			pendingTicks = [];
			deferredDroppedTicks = 0;
			try {
				callbacks.destroyInput();
			} finally {
				try {
					callbacks.destroyPhysics();
				} finally {
					clock.destroy();
				}
			}
		},
		get tick() {
			return clock.tick;
		},
	};
}
