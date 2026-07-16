import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
	act,
	createElement,
	type ForwardedRef,
	forwardRef,
	type ReactNode,
	StrictMode,
	useCallback,
} from "react";
import { createRoot } from "react-dom/client";
import { Object3D } from "three";
import { describe, expect, it, vi } from "vitest";

import {
	FIXED_STEP_MS,
	FIXED_STEP_SECONDS,
} from "../../packages/engine/src/index.js";
import type { SnowballCommand } from "../../packages/gameplay/src/index.js";
import {
	createActionState,
	type InputFrame,
} from "../../packages/input/src/index.js";
import {
	applyEcctrlMovement,
	applySnowballGrowthInPlace,
	applySnowballPhysicsCommand,
	captureRigidBodyTransform,
	createCollectedBodyRetirementQueue,
	createEcctrlInputBoundary,
	createManualRapierBinding,
	createManualRapierBridge,
	createManualRuntimeLoop,
	createPhysicsEventBuffer,
	createRawRapierStepper,
	createSnowballRigidBodyConfig,
	createSnowballRigidBodyPosition,
	createTransformInterpolator,
	createVisibleTransformWriter,
	enableSnowballCollisionEvents,
	type ManualRapierBridge,
	type ManualRuntimeLoop,
	type PhysicsTransform,
	type TransformInterpolator,
	toEcctrlMovement,
} from "../../packages/runtime-r3f/src/index.js";

function frame(tick: number, overrides: Partial<InputFrame> = {}): InputFrame {
	return {
		version: 1,
		tick,
		timestampMs: tick * FIXED_STEP_MS,
		move: { x: 0, y: 0 },
		look: { x: 0, y: 0 },
		held: createActionState(),
		pressed: createActionState(),
		released: createActionState(),
		source: "keyboard",
		deviceId: "keyboard",
		...overrides,
	};
}

function transform(id: string, x: number): PhysicsTransform {
	return {
		id,
		position: { x, y: 0, z: 0 },
		rotation: { x: 0, y: 0, z: 0, w: 1 },
		scale: { x: 1, y: 1, z: 1 },
	};
}

interface PinnedRapierEventQueue {
	drainCollisionEvents(
		callback: (
			firstHandle: number,
			secondHandle: number,
			started: boolean,
		) => void,
	): void;
	free(): void;
}

interface PinnedRapierRigidBody {
	translation(): Readonly<{ x: number; y: number; z: number }>;
}

interface PinnedRapierRigidBodyDescriptor {
	setCanSleep(canSleep: boolean): this;
	setLinvel(x: number, y: number, z: number): this;
	setTranslation(x: number, y: number, z: number): this;
}

interface PinnedRapierColliderDescriptor {
	setActiveEvents(activeEvents: number): this;
	setSensor(sensor: boolean): this;
}

interface PinnedRapierWorld {
	timestep: number;
	createRigidBody(
		descriptor: PinnedRapierRigidBodyDescriptor,
	): PinnedRapierRigidBody;
	createCollider(
		descriptor: PinnedRapierColliderDescriptor,
		body?: PinnedRapierRigidBody,
	): Readonly<{ handle: number }>;
	step(queue: PinnedRapierEventQueue): void;
	free(): void;
}

interface PinnedRapierModule {
	readonly ActiveEvents: Readonly<{ COLLISION_EVENTS: number }>;
	readonly ColliderDesc: Readonly<{
		ball(radius: number): PinnedRapierColliderDescriptor;
	}>;
	readonly EventQueue: new (autoDrain: boolean) => PinnedRapierEventQueue;
	readonly RigidBodyDesc: Readonly<{
		dynamic(): PinnedRapierRigidBodyDescriptor;
	}>;
	readonly World: new (
		gravity: Readonly<{ x: number; y: number; z: number }>,
	) => PinnedRapierWorld;
	init(parameters: Readonly<Record<string, never>>): Promise<void>;
}

const requireFromTest = createRequire(import.meta.url);

interface JSDOMInstance {
	readonly window: Window & typeof globalThis;
}

interface JSDOMModule {
	readonly JSDOM: new (html?: string) => JSDOMInstance;
}

function loadJSDOM(): JSDOMModule {
	const vitestEntry = requireFromTest.resolve("vitest");
	return createRequire(vitestEntry)("jsdom") as JSDOMModule;
}

function assignForwardedRef<T>(ref: ForwardedRef<T>, value: T | null): void {
	if (typeof ref === "function") {
		ref(value);
	} else if (ref !== null) {
		ref.current = value;
	}
}

async function loadPinnedRapier(): Promise<PinnedRapierModule> {
	const reactThreeRapierEntry = requireFromTest.resolve("@react-three/rapier");
	const requireFromReactThreeRapier = createRequire(reactThreeRapierEntry);
	const rapier = requireFromReactThreeRapier(
		"@dimforge/rapier3d-compat",
	) as unknown as PinnedRapierModule;
	await rapier.init({});
	return rapier;
}

describe("external fixed-step runtime loop", () => {
	it("runs every deterministic system stage in order before publishing UI", () => {
		const calls: string[] = [];
		const loop = createManualRuntimeLoop({
			readInput: (tick, timestampMs) => {
				calls.push(`input:${tick}:${Math.round(timestampMs)}`);
				return frame(tick);
			},
			applyController: (_input, tick) => calls.push(`controller:${tick}`),
			stepPhysics: (seconds, tick) =>
				calls.push(`physics:${tick}:${seconds.toFixed(6)}`),
			drainPhysicsEvents: (tick) => {
				calls.push(`events:${tick}`);
				return [
					{
						entityId: "z",
						otherEntityId: "rock",
						kind: "collision-start",
						sequence: tick,
						payload: { impact: { impulse: tick } },
					},
					{
						entityId: "a",
						otherEntityId: "rock",
						kind: "collision-start",
						sequence: tick + 1,
						payload: { impact: { impulse: tick + 1 } },
					},
				];
			},
			processPhysicsEvents: (events, tick) => {
				calls.push(
					`process:${tick}:${events.map(({ entityId }) => entityId).join(",")}`,
				);
				expect(Object.isFrozen(events)).toBe(true);
				expect(Object.isFrozen(events[0])).toBe(true);
				expect(Object.isFrozen(events[0]?.payload)).toBe(true);
				expect(Object.isFrozen(events[0]?.payload?.impact)).toBe(true);
				expect(() =>
					Object.defineProperty(events, "0", { value: undefined }),
				).toThrow();
				expect(() =>
					Object.defineProperty(events[0] ?? {}, "kind", {
						value: "mutated",
					}),
				).toThrow();
				expect(() =>
					Object.defineProperty(events[0]?.payload?.impact ?? {}, "impulse", {
						value: 999,
					}),
				).toThrow();
			},
			collect: (events, tick) =>
				calls.push(
					`collection:${tick}:${events.map(({ entityId }) => entityId).join(",")}`,
				),
			disableAndAttach: (tick) => calls.push(`disable-attach:${tick}`),
			applyGrowth: (tick) => calls.push(`growth:${tick}`),
			updateStreaming: (tick) => calls.push(`streaming:${tick}`),
			captureTransforms: (tick) => {
				calls.push(`transforms:${tick}`);
				return [transform("z", tick), transform("a", tick)];
			},
			publishSnapshot: (snapshot) => calls.push(`snapshot:${snapshot.tick}`),
			updateUi: (snapshot) => calls.push(`ui:${snapshot.tick}`),
			resetInput: vi.fn(),
			resetPhysics: vi.fn(),
			destroyInput: vi.fn(),
			destroyPhysics: vi.fn(),
		});
		expect(loop.advance(0, false).steps).toHaveLength(0);
		const result = loop.advance(FIXED_STEP_MS * 2, false);
		expect(result.steps.map((step) => step.tick)).toEqual([1, 2]);
		expect(result.steps[0]?.transforms.map(({ id }) => id)).toEqual(["a", "z"]);
		expect(Object.isFrozen(result.steps[0]?.transforms)).toBe(true);
		expect(Object.isFrozen(result.steps[0]?.transforms[0])).toBe(true);
		expect(Object.isFrozen(result.steps[0]?.transforms[0]?.position)).toBe(
			true,
		);
		expect(Object.isFrozen(result.steps[0]?.transforms[0]?.rotation)).toBe(
			true,
		);
		expect(Object.isFrozen(result.steps[0]?.transforms[0]?.scale)).toBe(true);
		expect(() =>
			Object.defineProperty(
				result.steps[0]?.transforms[0]?.position ?? {},
				"x",
				{ value: 999 },
			),
		).toThrow();
		expect(calls).toEqual([
			`input:1:${Math.round(FIXED_STEP_MS)}`,
			"controller:1",
			"physics:1:0.016667",
			"events:1",
			"process:1:a,z",
			"collection:1:a,z",
			"disable-attach:1",
			"growth:1",
			"streaming:1",
			"transforms:1",
			"snapshot:1",
			"ui:1",
			`input:2:${Math.round(FIXED_STEP_MS * 2)}`,
			"controller:2",
			"physics:2:0.016667",
			"events:2",
			"process:2:a,z",
			"collection:2:a,z",
			"disable-attach:2",
			"growth:2",
			"streaming:2",
			"transforms:2",
			"snapshot:2",
			"ui:2",
		]);
		expect(JSON.parse(JSON.stringify(result))).toEqual(result);
	});

	it("detaches and deep-freezes input before controller and publication", () => {
		const held = createActionState();
		Object.assign(held, { boost: true });
		const source = frame(1, {
			move: { x: 0.5, y: -0.25 },
			look: { x: 0.125, y: -0.5 },
			held,
		});
		const applyController = vi.fn((input: InputFrame) => {
			expect(input).not.toBe(source);
			expect(Object.isFrozen(input)).toBe(true);
			expect(Object.isFrozen(input.move)).toBe(true);
			expect(Object.isFrozen(input.look)).toBe(true);
			expect(Object.isFrozen(input.held)).toBe(true);
			expect(Object.isFrozen(input.pressed)).toBe(true);
			expect(Object.isFrozen(input.released)).toBe(true);
			expect(() =>
				Object.defineProperty(input.move, "x", { value: 99 }),
			).toThrow();
			expect(() =>
				Object.defineProperty(input.held, "boost", { value: false }),
			).toThrow();
			Object.assign(source.move, { x: 99 });
			Object.assign(source.held, { boost: false });
		});
		const publishSnapshot = vi.fn((snapshot) => {
			expect(snapshot.input.move.x).toBe(0.5);
			expect(snapshot.input.held.boost).toBe(true);
		});
		const loop = createManualRuntimeLoop({
			readInput: () => source,
			applyController,
			stepPhysics: vi.fn(),
			drainPhysicsEvents: () => [],
			processPhysicsEvents: vi.fn(),
			collect: vi.fn(),
			disableAndAttach: vi.fn(),
			applyGrowth: vi.fn(),
			updateStreaming: vi.fn(),
			captureTransforms: () => [],
			publishSnapshot,
			updateUi: vi.fn(),
			resetInput: vi.fn(),
			resetPhysics: vi.fn(),
			destroyInput: vi.fn(),
			destroyPhysics: vi.fn(),
		});

		loop.advance(0, false);
		const snapshot = loop.advance(FIXED_STEP_MS, false).steps[0];
		Object.assign(source.look, { y: 99 });
		Object.assign(source.pressed, { action: true });

		expect(applyController).toHaveBeenCalledOnce();
		expect(publishSnapshot).toHaveBeenCalledOnce();
		expect(snapshot?.input).toMatchObject({
			move: { x: 0.5, y: -0.25 },
			look: { x: 0.125, y: -0.5 },
			held: { boost: true },
			pressed: { action: false },
		});
	});

	it("rejects hostile captured transform scalars before publication", () => {
		for (const invalid of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			Number.MAX_VALUE,
			Number.MIN_VALUE,
		]) {
			const publishSnapshot = vi.fn();
			const loop = createManualRuntimeLoop({
				readInput: (tick) => frame(tick),
				applyController: vi.fn(),
				stepPhysics: vi.fn(),
				drainPhysicsEvents: () => [],
				processPhysicsEvents: vi.fn(),
				collect: vi.fn(),
				disableAndAttach: vi.fn(),
				applyGrowth: vi.fn(),
				updateStreaming: vi.fn(),
				captureTransforms: () => [transform("snowball", invalid)],
				publishSnapshot,
				updateUi: vi.fn(),
				resetInput: vi.fn(),
				resetPhysics: vi.fn(),
				destroyInput: vi.fn(),
				destroyPhysics: vi.fn(),
			});
			loop.advance(0, false);

			expect(() => loop.advance(FIXED_STEP_MS, false)).toThrow(
				/finite|f32|underflow/u,
			);
			expect(publishSnapshot).not.toHaveBeenCalled();
			loop.destroy();
		}
	});

	it("ignores receiver-owned array map overrides when copying transforms", () => {
		const captured = [transform("snowball", 1)];
		Object.defineProperty(captured, "map", {
			value: () => [
				{
					...transform("snowball", 1),
					position: { x: Number.NaN, y: 0, z: 0 },
				},
			],
		});
		const publishSnapshot = vi.fn();
		const loop = createManualRuntimeLoop({
			readInput: (tick) => frame(tick),
			applyController: vi.fn(),
			stepPhysics: vi.fn(),
			drainPhysicsEvents: () => [],
			processPhysicsEvents: vi.fn(),
			collect: vi.fn(),
			disableAndAttach: vi.fn(),
			applyGrowth: vi.fn(),
			updateStreaming: vi.fn(),
			captureTransforms: () => captured,
			publishSnapshot,
			updateUi: vi.fn(),
			resetInput: vi.fn(),
			resetPhysics: vi.fn(),
			destroyInput: vi.fn(),
			destroyPhysics: vi.fn(),
		});
		loop.advance(0, false);

		expect(loop.advance(FIXED_STEP_MS, false).steps[0]?.transforms).toEqual([
			transform("snowball", 1),
		]);
		expect(publishSnapshot).toHaveBeenCalledOnce();
	});

	it("preserves admitted catch-up ticks after an earlier tick stage throws", () => {
		let rejectFirstCapture = true;
		const processedTicks: number[] = [];
		const loop = createManualRuntimeLoop({
			readInput: (tick) => frame(tick),
			applyController: (_input, tick) => processedTicks.push(tick),
			stepPhysics: vi.fn(),
			drainPhysicsEvents: () => [],
			processPhysicsEvents: vi.fn(),
			collect: vi.fn(),
			disableAndAttach: vi.fn(),
			applyGrowth: vi.fn(),
			updateStreaming: vi.fn(),
			captureTransforms: () => {
				if (rejectFirstCapture) {
					rejectFirstCapture = false;
					throw new Error("capture failed");
				}
				return [];
			},
			publishSnapshot: vi.fn(),
			updateUi: vi.fn(),
			resetInput: vi.fn(),
			resetPhysics: vi.fn(),
			destroyInput: vi.fn(),
			destroyPhysics: vi.fn(),
		});
		loop.advance(0, false);

		expect(() => loop.advance(FIXED_STEP_MS * 4, false)).toThrow(
			/capture failed/u,
		);
		const recovered = loop.advance(FIXED_STEP_MS * 4, false);
		expect(recovered.steps.map(({ tick }) => tick)).toEqual([2, 3, 4]);
		expect(processedTicks).toEqual([1, 2, 3, 4]);
	});

	it("rejects empty or duplicate captured transform IDs before publication", () => {
		const captureTransforms = vi
			.fn<() => readonly PhysicsTransform[]>()
			.mockReturnValueOnce([transform("", 0)])
			.mockReturnValueOnce([transform("same", 0), transform("same", 1)]);
		const publishSnapshot = vi.fn();
		const loop = createManualRuntimeLoop({
			readInput: (tick) => frame(tick),
			applyController: vi.fn(),
			stepPhysics: vi.fn(),
			drainPhysicsEvents: () => [],
			processPhysicsEvents: vi.fn(),
			collect: vi.fn(),
			disableAndAttach: vi.fn(),
			applyGrowth: vi.fn(),
			updateStreaming: vi.fn(),
			captureTransforms,
			publishSnapshot,
			updateUi: vi.fn(),
			resetInput: vi.fn(),
			resetPhysics: vi.fn(),
			destroyInput: vi.fn(),
			destroyPhysics: vi.fn(),
		});
		loop.advance(0, false);
		expect(() => loop.advance(FIXED_STEP_MS, false)).toThrow(/non-empty/u);
		expect(publishSnapshot).not.toHaveBeenCalled();
		expect(() => loop.advance(FIXED_STEP_MS * 2, false)).toThrow(/duplicate/u);
		expect(publishSnapshot).not.toHaveBeenCalled();
	});

	it("steps zero ticks while hidden, caps catch-up at four, and resets physics before its clock", () => {
		const stepPhysics = vi.fn();
		const calls: string[] = [];
		let loop!: ManualRuntimeLoop;
		const resetInput = vi.fn(() => {
			calls.push(`input:${loop.tick}`);
		});
		const resetPhysics = vi.fn(() => {
			calls.push(`physics:${loop.tick}`);
		});
		const destroyInput = vi.fn();
		const destroyPhysics = vi.fn();
		loop = createManualRuntimeLoop({
			readInput: (tick) => frame(tick),
			applyController: vi.fn(),
			stepPhysics,
			drainPhysicsEvents: () => [],
			processPhysicsEvents: vi.fn(),
			collect: vi.fn(),
			disableAndAttach: vi.fn(),
			applyGrowth: vi.fn(),
			updateStreaming: vi.fn(),
			captureTransforms: () => [],
			publishSnapshot: vi.fn(),
			updateUi: vi.fn(),
			resetInput,
			resetPhysics,
			destroyInput,
			destroyPhysics,
		});
		loop.advance(0, false);
		loop.advance(FIXED_STEP_MS * 100, true);
		loop.advance(FIXED_STEP_MS * 101, false);
		expect(stepPhysics).not.toHaveBeenCalled();
		const catchUp = loop.advance(FIXED_STEP_MS * 111, false);
		expect(catchUp.steps).toHaveLength(4);
		expect(catchUp.droppedTicks).toBe(6);
		loop.reset();
		calls.push(`clock:${loop.tick}`);
		expect(calls).toEqual(["input:4", "physics:4", "clock:0"]);
		expect(resetInput).toHaveBeenCalledOnce();
		expect(resetPhysics).toHaveBeenCalledOnce();
		loop.destroy();
		loop.destroy();
		expect(destroyInput).toHaveBeenCalledOnce();
		expect(destroyPhysics).toHaveBeenCalledOnce();
		expect(() => loop.advance(1, false)).toThrow(/destroyed/u);
		expect(() => loop.reset()).toThrow(/destroyed/u);
		expect(resetInput).toHaveBeenCalledOnce();
		expect(resetPhysics).toHaveBeenCalledOnce();
	});
});

describe("physics event copying", () => {
	it("copies, sorts, drains, and bounds plain collision facts", () => {
		const buffer = createPhysicsEventBuffer(2);
		const payload = { impulse: 3 };
		buffer.push({
			entityId: "z",
			otherEntityId: "a",
			kind: "collision-start",
			sequence: 2,
			payload,
		});
		buffer.push({
			entityId: "a",
			otherEntityId: "z",
			kind: "collision-end",
			sequence: 1,
			payload: { impulse: 0 },
		});
		payload.impulse = 99;
		expect(() =>
			buffer.push({
				entityId: "overflow",
				kind: "collision-start",
				sequence: 3,
				payload: {},
			}),
		).toThrow(/capacity/u);
		const events = buffer.drain();
		expect(events.map((event) => event.entityId)).toEqual(["a", "z"]);
		expect(events[1]?.payload).toEqual({ impulse: 3 });
		expect(JSON.parse(JSON.stringify(events))).toEqual(events);
		expect(buffer.drain()).toEqual([]);
		buffer.destroy();
		expect(buffer.destroyed).toBe(true);
		expect(() =>
			buffer.push({
				entityId: "after-destroy",
				kind: "collision-start",
				sequence: 0,
			}),
		).toThrow(/destroyed/u);
		expect(() => buffer.drain()).toThrow(/destroyed/u);
		expect(() => buffer.clear()).toThrow(/destroyed/u);
	});

	it("rejects oversized identifiers, strings, and aggregate payload trees", () => {
		const buffer = createPhysicsEventBuffer();
		expect(() =>
			buffer.push({
				entityId: "x".repeat(257),
				kind: "collision-start",
				sequence: 0,
			}),
		).toThrow(/maximum length/u);
		expect(() =>
			buffer.push({
				entityId: "snowball",
				kind: "collision-start",
				sequence: 0,
				payload: "x".repeat(4_097),
			}),
		).toThrow(/string exceeds/u);
		const oversizedTree = Array.from({ length: 17 }, () =>
			Array.from({ length: 256 }, () => 0),
		);
		expect(() =>
			buffer.push({
				entityId: "snowball",
				kind: "collision-start",
				sequence: 0,
				payload: oversizedTree,
			}),
		).toThrow(/node count/u);
		expect(buffer.size).toBe(0);
	});

	it("rejects boxed text and captures hostile event getters only once", () => {
		const boxedBuffer = createPhysicsEventBuffer();
		const hostileText = {
			length: 8,
			toString: vi.fn(() => {
				throw new Error("hostile coercion");
			}),
		};
		expect(() =>
			boxedBuffer.push({
				entityId: new String("snowball"),
				kind: "collision-start",
				sequence: 0,
			} as unknown as Parameters<typeof boxedBuffer.push>[0]),
		).toThrow(/primitive string/u);
		expect(() =>
			boxedBuffer.push({
				entityId: "snowball",
				kind: hostileText,
				sequence: 0,
			} as unknown as Parameters<typeof boxedBuffer.push>[0]),
		).toThrow(/primitive string/u);
		expect(boxedBuffer.size).toBe(0);
		expect(hostileText.toString).not.toHaveBeenCalled();

		const getterBuffer = createPhysicsEventBuffer();
		let entityReads = 0;
		const changingEvent = {
			get entityId() {
				entityReads += 1;
				return entityReads === 1 ? "z" : hostileText;
			},
			kind: "collision-start",
			sequence: 1,
		};
		getterBuffer.push(
			changingEvent as unknown as Parameters<typeof getterBuffer.push>[0],
		);
		getterBuffer.push({
			entityId: "a",
			kind: "collision-end",
			sequence: 0,
		});

		expect(getterBuffer.drain().map((event) => event.entityId)).toEqual([
			"a",
			"z",
		]);
		expect(entityReads).toBe(1);
		expect(hostileText.toString).not.toHaveBeenCalled();
	});

	it("retains every queued event when sorting the owned drain copy fails", () => {
		const buffer = createPhysicsEventBuffer();
		buffer.push({
			entityId: "z",
			kind: "collision-start",
			sequence: 1,
		});
		buffer.push({
			entityId: "a",
			kind: "collision-end",
			sequence: 0,
		});
		const sortDescriptor = Object.getOwnPropertyDescriptor(
			Array.prototype,
			"sort",
		);
		if (sortDescriptor === undefined) {
			throw new Error("Array.prototype.sort descriptor is unavailable");
		}
		let failure: unknown;
		try {
			Object.defineProperty(Array.prototype, "sort", {
				...sortDescriptor,
				value: () => {
					throw new Error("sort failed");
				},
			});
			buffer.drain();
		} catch (error) {
			failure = error;
		} finally {
			Object.defineProperty(Array.prototype, "sort", sortDescriptor);
		}

		expect(failure).toEqual(new Error("sort failed"));
		expect(buffer.size).toBe(2);
		expect(buffer.drain().map((event) => event.entityId)).toEqual(["a", "z"]);
	});
});

describe("transform interpolation", () => {
	it("keeps previous and current physics poses and samples immutable render poses", () => {
		const interpolator = createTransformInterpolator();
		interpolator.record(1, [transform("z", 0), transform("a", 2)]);
		interpolator.record(2, [transform("z", 10), transform("a", 4)]);
		const halfway = interpolator.sample(0.5);
		expect(halfway.map((entry) => entry.id)).toEqual(["a", "z"]);
		expect(halfway.find((entry) => entry.id === "z")?.position.x).toBe(5);
		expect(Object.isFrozen(halfway)).toBe(true);
		expect(JSON.parse(JSON.stringify(halfway))).toEqual(halfway);
		interpolator.reset();
		expect(interpolator.sample(1)).toEqual([]);
		interpolator.destroy();
		expect(interpolator.destroyed).toBe(true);
		expect(() => interpolator.sample(1)).toThrow(/destroyed/u);
		expect(() => interpolator.reset()).toThrow(/destroyed/u);
	});

	it("reuses preallocated interpolated views in stable-ID order", () => {
		const interpolator = createTransformInterpolator();
		interpolator.record(1, [transform("z", 0), transform("a", 2)]);
		interpolator.record(2, [transform("z", 10), transform("a", 4)]);
		const firstPass: PhysicsTransform[] = [];
		const secondPass: PhysicsTransform[] = [];

		expect(
			interpolator.forEachInterpolated(0.25, (entry) => firstPass.push(entry)),
		).toBe(2);
		expect(
			interpolator.forEachInterpolated(0.75, (entry) => secondPass.push(entry)),
		).toBe(2);

		expect(firstPass.map((entry) => entry.id)).toEqual(["a", "z"]);
		expect(secondPass[0]).toBe(firstPass[0]);
		expect(secondPass[1]).toBe(firstPass[1]);
		expect(secondPass[1]?.position.x).toBe(7.5);
	});

	it("keeps reusable transform IDs canonical after attempted visitor mutation", () => {
		const interpolator = createTransformInterpolator();
		interpolator.record(1, [transform("z", 0), transform("a", 2)]);
		const mutationResults: boolean[] = [];
		interpolator.forEachInterpolated(0.5, (entry) => {
			mutationResults.push(
				Reflect.set(entry as unknown as object, "id", "corrupted"),
			);
		});
		const subsequentIds: string[] = [];
		interpolator.forEachInterpolated(0.5, (entry) => {
			subsequentIds.push(entry.id);
		});

		expect(mutationResults).toEqual([false, false]);
		expect(subsequentIds).toEqual(["a", "z"]);
	});

	it("uses finite convex interpolation with exact endpoints and rejects f32 underflow", () => {
		const maximumFiniteF32 = Math.fround(3.4e38);
		const interpolator = createTransformInterpolator();
		interpolator.record(1, [transform("snowball", maximumFiniteF32)]);
		interpolator.record(2, [transform("snowball", -maximumFiniteF32)]);

		expect(interpolator.sample(0)[0]?.position.x).toBe(maximumFiniteF32);
		expect(interpolator.sample(0.5)[0]?.position.x).toBe(0);
		expect(interpolator.sample(1)[0]?.position.x).toBe(-maximumFiniteF32);

		const underflow = createTransformInterpolator();
		underflow.record(1, [transform("snowball", Math.fround(2 ** -149))]);
		underflow.record(2, [transform("snowball", 0)]);
		expect(() => underflow.sample(0.75)).toThrow(/underflow|f32/u);
	});

	it("takes the shortest quaternion path when the destination dot product is negative", () => {
		const interpolator = createTransformInterpolator();
		interpolator.record(1, [transform("snowball", 0)]);
		interpolator.record(2, [
			{
				...transform("snowball", 0),
				rotation: {
					x: 0,
					y: Math.SQRT1_2,
					z: 0,
					w: -Math.SQRT1_2,
				},
			},
		]);

		const rotation = interpolator.sample(0.5)[0]?.rotation;
		expect(rotation?.y).toBeCloseTo(-0.3826834324, 9);
		expect(rotation?.w).toBeCloseTo(0.9238795325, 9);
		expect(
			Math.hypot(
				rotation?.x ?? Number.NaN,
				rotation?.y ?? Number.NaN,
				rotation?.z ?? Number.NaN,
				rotation?.w ?? Number.NaN,
			),
		).toBeCloseTo(1, 12);
	});

	it("keeps antipodal equivalent quaternions finite and unit length", () => {
		const firstRotation = { x: 0.2, y: -0.3, z: 0.4, w: 0.5 };
		const interpolator = createTransformInterpolator();
		interpolator.record(1, [
			{ ...transform("snowball", 0), rotation: firstRotation },
		]);
		interpolator.record(2, [
			{
				...transform("snowball", 0),
				rotation: {
					x: -firstRotation.x,
					y: -firstRotation.y,
					z: -firstRotation.z,
					w: -firstRotation.w,
				},
			},
		]);

		const rotation = interpolator.sample(0.5)[0]?.rotation;
		const magnitude = Math.hypot(
			rotation?.x ?? Number.NaN,
			rotation?.y ?? Number.NaN,
			rotation?.z ?? Number.NaN,
			rotation?.w ?? Number.NaN,
		);
		expect(Number.isFinite(magnitude)).toBe(true);
		expect(magnitude).toBeCloseTo(1, 12);
		const sourceMagnitude = Math.hypot(
			firstRotation.x,
			firstRotation.y,
			firstRotation.z,
			firstRotation.w,
		);
		const dot =
			((rotation?.x ?? 0) * firstRotation.x +
				(rotation?.y ?? 0) * firstRotation.y +
				(rotation?.z ?? 0) * firstRotation.z +
				(rotation?.w ?? 0) * firstRotation.w) /
			sourceMagnitude;
		expect(Math.abs(dot)).toBeCloseTo(1, 12);
	});
});

describe("Ecctrl optional adapter", () => {
	it("translates every normalized frame through public setMovement, including releases", () => {
		const held = createActionState();
		held.moveForward = true;
		held.moveRight = true;
		held.boost = true;
		const pressed = createActionState();
		pressed.action = true;
		const active = frame(1, { move: { x: 0.5, y: 0.75 }, held, pressed });
		expect(toEcctrlMovement(active)).toEqual({
			forward: true,
			backward: false,
			leftward: false,
			rightward: true,
			joystick: { x: 0.5, y: 0.75 },
			run: true,
			jump: true,
		});
		const setMovement = vi.fn();
		applyEcctrlMovement({ setMovement }, active);
		applyEcctrlMovement({ setMovement }, frame(2));
		expect(setMovement).toHaveBeenLastCalledWith({
			forward: false,
			backward: false,
			leftward: false,
			rightward: false,
			joystick: { x: 0, y: 0 },
			run: false,
			jump: false,
		});
	});

	it("forces held-run props and neutralizes the complete movement frame on disposal", () => {
		const setMovement = vi.fn();
		const boundary = createEcctrlInputBoundary({ setMovement });
		const held = createActionState();
		held.boost = true;

		expect(boundary.ecctrlProps).toEqual({ enableToggleRun: false });
		boundary.forward(frame(1, { held, move: { x: 0.25, y: 1 } }));
		expect(setMovement).toHaveBeenLastCalledWith(
			expect.objectContaining({
				joystick: { x: 0.25, y: 1 },
				run: true,
			}),
		);

		boundary.dispose();
		expect(setMovement).toHaveBeenLastCalledWith({
			forward: false,
			backward: false,
			leftward: false,
			rightward: false,
			joystick: { x: 0, y: 0 },
			run: false,
			jump: false,
		});
		expect(() => boundary.forward(frame(2))).toThrow(/destroyed/u);
		boundary.destroy();
		expect(setMovement).toHaveBeenCalledTimes(2);
	});
});

describe("sphere body proxy", () => {
	it("derives bounded rigid-body and collider facts from snowball radius and mass", () => {
		expect(createSnowballRigidBodyConfig({ radius: 2, mass: 8 })).toEqual({
			colliderRadius: 1.9,
			additionalMass: 8,
			ccd: true,
			canSleep: true,
		});
		expect(() => createSnowballRigidBodyConfig({ radius: 0, mass: 1 })).toThrow(
			/radius/u,
		);
	});

	it("rejects non-finite, f32-overflowed, and underflowed body facts", () => {
		for (const invalid of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			Number.MAX_VALUE,
			Number.MIN_VALUE,
		]) {
			expect(() =>
				createSnowballRigidBodyConfig({ radius: invalid, mass: 1 }),
			).toThrow(/radius/u);
			expect(() =>
				createSnowballRigidBodyConfig({ radius: 1, mass: invalid }),
			).toThrow(/mass/u);
		}
		expect(createSnowballRigidBodyConfig({ radius: 1.25, mass: 2.5 })).toEqual(
			expect.objectContaining({
				colliderRadius: 1.1875,
				additionalMass: 2.5,
			}),
		);
	});

	it("captures a detached f32-safe initial Rapier position before JSX", () => {
		const source: [number, number, number] = [1, 2, 3];
		const captured = createSnowballRigidBodyPosition(source);
		source[0] = 99;
		expect(captured).toEqual([1, 2, 3]);
		expect(Object.isFrozen(captured)).toBe(true);

		for (const invalid of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			Number.MAX_VALUE,
			Number.MIN_VALUE,
		]) {
			expect(() => createSnowballRigidBodyPosition([invalid, 0, 0])).toThrow(
				/position|finite|f32|underflow/u,
			);
		}
	});

	it("applies commands only through a narrow public rigid-body handle", () => {
		const handle = {
			addTorque: vi.fn(),
			applyImpulse: vi.fn(),
			linvel: vi.fn(() => ({ x: 4, y: 7, z: -8 })),
			setLinvel: vi.fn(),
		};
		const command: SnowballCommand = {
			torque: { x: 2, y: 0, z: 1 },
			turn: 0.5,
			braking: 0.25,
			boost: true,
			action: false,
			camera: {
				follow: true,
				look: { x: 0, y: 0 },
				shake: 0,
				zoomPulse: 0,
				reset: false,
			},
		};
		applySnowballPhysicsCommand(handle, command);
		expect(handle.addTorque).toHaveBeenCalledWith({ x: 2, y: 0.5, z: 1 }, true);
		expect(handle.setLinvel).toHaveBeenCalledWith({ x: 3, y: 7, z: -6 }, true);
		expect(handle.applyImpulse).toHaveBeenCalled();
	});

	it("rejects hostile torque before invoking any rigid-body handle", () => {
		const camera = {
			follow: true,
			look: { x: 0, y: 0 },
			shake: 0,
			zoomPulse: 0,
			reset: false,
		} as const;
		for (const invalid of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			Number.MAX_VALUE,
			Number.MIN_VALUE,
		]) {
			const handle = {
				addTorque: vi.fn(),
				applyImpulse: vi.fn(),
				linvel: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
				setLinvel: vi.fn(),
			};
			const command: SnowballCommand = {
				torque: { x: invalid, y: 0, z: 0 },
				turn: 0,
				braking: 0,
				boost: false,
				action: false,
				camera,
			};

			expect(() => applySnowballPhysicsCommand(handle, command)).toThrow(
				/torque|finite|f32|underflow/u,
			);
			expect(handle.addTorque).not.toHaveBeenCalled();
			expect(handle.applyImpulse).not.toHaveBeenCalled();
			expect(handle.linvel).not.toHaveBeenCalled();
			expect(handle.setLinvel).not.toHaveBeenCalled();
		}

		const handle = {
			addTorque: vi.fn(),
			applyImpulse: vi.fn(),
			linvel: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
			setLinvel: vi.fn(),
		};
		expect(() =>
			applySnowballPhysicsCommand(handle, {
				torque: { x: 0, y: Math.fround(3.4e38), z: 0 },
				turn: Math.fround(3.4e38),
				braking: 0,
				boost: false,
				action: false,
				camera,
			}),
		).toThrow(/torque|f32/u);
		expect(handle.addTorque).not.toHaveBeenCalled();
	});

	it("grows the authoritative collider and recomputes mass in place", () => {
		const calls: string[] = [];
		const collider = {
			setRadius: vi.fn((_radius: number) => calls.push("radius")),
			setMass: vi.fn((_mass: number) => calls.push("mass")),
		};
		const body = {
			recomputeMassPropertiesFromColliders: vi.fn(() =>
				calls.push("recompute"),
			),
		};
		applySnowballGrowthInPlace(collider, body, { radius: 3, mass: 12 });
		expect(collider.setRadius.mock.calls[0]?.[0]).toBeCloseTo(2.85);
		expect(collider.setMass).toHaveBeenCalledWith(12);
		expect(calls).toEqual(["radius", "mass", "recompute"]);
	});

	it("validates a complete growth update before mutating Rapier handles", () => {
		for (const facts of [
			{ radius: Number.MAX_VALUE, mass: 1 },
			{ radius: 1, mass: Number.MIN_VALUE },
		]) {
			const collider = {
				setRadius: vi.fn(),
				setMass: vi.fn(),
			};
			const body = {
				recomputeMassPropertiesFromColliders: vi.fn(),
			};

			expect(() => applySnowballGrowthInPlace(collider, body, facts)).toThrow(
				/finite|f32|underflow/u,
			);
			expect(collider.setRadius).not.toHaveBeenCalled();
			expect(collider.setMass).not.toHaveBeenCalled();
			expect(body.recomputeMassPropertiesFromColliders).not.toHaveBeenCalled();
		}
	});

	it("accepts only the pinned Rapier ActiveEvents mask", () => {
		const collider = { setActiveEvents: vi.fn() };
		for (const activeEvents of [0, 1, 2, 3]) {
			enableSnowballCollisionEvents(collider, activeEvents);
		}
		expect(collider.setActiveEvents.mock.calls.map(([value]) => value)).toEqual(
			[0, 1, 2, 3],
		);
		for (const invalid of [-1, 4, 2 ** 32, Number.NaN]) {
			expect(() => enableSnowballCollisionEvents(collider, invalid)).toThrow(
				/collision event flags/u,
			);
		}
		expect(collider.setActiveEvents).toHaveBeenCalledTimes(4);
	});

	it("retires disabled bodies at their deadline and finalizes pending bodies on reset or destroy", () => {
		const first = { setEnabled: vi.fn() };
		const second = { setEnabled: vi.fn() };
		const removed: Array<typeof first> = [];
		const retirements = createCollectedBodyRetirementQueue<typeof first>(
			(body) => removed.push(body),
		);
		retirements.collect("z", second, 4);
		retirements.collect("a", first, 4);
		expect(first.setEnabled).toHaveBeenCalledWith(false);
		expect(second.setEnabled).toHaveBeenCalledWith(false);
		expect(retirements.flush(3)).toEqual([]);
		expect(retirements.flush(4)).toEqual(["a", "z"]);
		expect(removed).toEqual([first, second]);

		retirements.collect("z", second, 10);
		retirements.collect("a", first, 10);
		retirements.reset();
		expect(removed).toEqual([first, second, first, second]);
		expect(retirements.size).toBe(0);

		retirements.collect("a", first, 12);
		retirements.destroy();
		expect(removed).toEqual([first, second, first, second, first]);
		expect(() => retirements.flush(12)).toThrow(/destroyed/u);
	});

	it("retains failed removals for deterministic retry", () => {
		const body = { setEnabled: vi.fn() };
		let shouldFail = true;
		const retirements = createCollectedBodyRetirementQueue<typeof body>(() => {
			if (shouldFail) throw new Error("remove failed");
		});
		retirements.collect("a", body, 2);

		expect(() => retirements.flush(2)).toThrow(/could not be retired/u);
		expect(retirements.size).toBe(1);

		shouldFail = false;
		expect(retirements.flush(2)).toEqual(["a"]);
		expect(retirements.size).toBe(0);
	});
});

describe("rigid-body transform capture", () => {
	it("copies public handle values into immutable render data", () => {
		const position = { x: 1, y: 2, z: 3 };
		const rotation = { x: 0, y: 0, z: 0, w: 2 };
		const captured = captureRigidBodyTransform("snowball", {
			translation: () => position,
			rotation: () => rotation,
		});
		position.x = 99;
		rotation.w = 0;

		expect(captured).toEqual({
			id: "snowball",
			position: { x: 1, y: 2, z: 3 },
			rotation: { x: 0, y: 0, z: 0, w: 1 },
			scale: { x: 1, y: 1, z: 1 },
		});
		expect(Object.isFrozen(captured.position)).toBe(true);
	});

	it("normalizes extreme finite quaternions without overflow", () => {
		const captured = captureRigidBodyTransform("snowball", {
			translation: () => ({ x: 0, y: 0, z: 0 }),
			rotation: () => ({
				x: Number.MAX_VALUE,
				y: Number.MAX_VALUE,
				z: Number.MAX_VALUE,
				w: Number.MAX_VALUE,
			}),
		});

		expect(captured.rotation).toEqual({ x: 0.5, y: 0.5, z: 0.5, w: 0.5 });
		expect(
			Math.hypot(
				captured.rotation.x,
				captured.rotation.y,
				captured.rotation.z,
				captured.rotation.w,
			),
		).toBeCloseTo(1, 12);
	});

	it("rejects hostile position and scale scalars before copying render data", () => {
		for (const invalid of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			Number.MAX_VALUE,
			Number.MIN_VALUE,
		]) {
			expect(() =>
				captureRigidBodyTransform("snowball", {
					translation: () => ({ x: invalid, y: 0, z: 0 }),
					rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }),
				}),
			).toThrow(/position|vector|finite|f32|underflow/u);
			expect(() =>
				captureRigidBodyTransform(
					"snowball",
					{
						translation: () => ({ x: 0, y: 0, z: 0 }),
						rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }),
					},
					{ x: 1, y: invalid, z: 1 },
				),
			).toThrow(/scale|vector|finite|f32|underflow/u);
		}
	});
});

describe("raw Rapier world bridge", () => {
	it("owns one raw step and drains copied stable-ID collisions per admitted tick", () => {
		const batches = [
			[{ first: 9, second: 4, started: true }],
			[{ first: 4, second: 9, started: false }],
		];
		const queue = {
			drainCollisionEvents: vi.fn(
				(
					callback: (
						firstHandle: number,
						secondHandle: number,
						started: boolean,
					) => void,
				) => {
					for (const collision of batches.shift() ?? []) {
						callback(collision.first, collision.second, collision.started);
					}
				},
			),
		};
		const world = {
			timestep: 0,
			step: vi.fn((received: typeof queue) => {
				expect(received).toBe(queue);
			}),
		};
		const events = createPhysicsEventBuffer();
		const ids = new Map([
			[4, "crate"],
			[9, "snowball"],
		]);
		const stepper = createRawRapierStepper({
			world,
			queue,
			events,
			resolveColliderEntityId: (handle) => ids.get(handle),
		});

		expect(() => stepper.step(1 / 30, 1)).toThrow(/fixed simulation interval/u);
		stepper.step(FIXED_STEP_SECONDS, 1);
		expect(world.timestep).toBe(FIXED_STEP_SECONDS);
		expect(world.step).toHaveBeenCalledTimes(1);
		expect(queue.drainCollisionEvents).toHaveBeenCalledTimes(1);
		expect(events.drain()).toEqual([
			{
				entityId: "crate",
				otherEntityId: "snowball",
				kind: "collision-start",
				sequence: 0,
				payload: { tick: 1 },
			},
		]);

		stepper.step(FIXED_STEP_SECONDS, 2);
		expect(world.step).toHaveBeenCalledTimes(2);
		expect(events.drain()[0]?.kind).toBe("collision-end");
		stepper.reset();
		stepper.step(FIXED_STEP_SECONDS, 0);
		world.step.mockImplementationOnce(() => {
			throw new Error("step failed");
		});
		expect(() => stepper.step(FIXED_STEP_SECONDS, 1)).toThrow(/step failed/u);
		expect(() => stepper.step(FIXED_STEP_SECONDS, 1)).toThrow(/monotonically/u);
		expect(world.step).toHaveBeenCalledTimes(4);
		stepper.destroy();
		expect(() => stepper.step(FIXED_STEP_SECONDS, 1)).toThrow(/destroyed/u);
	});

	it("rejects non-finite deltas before stepping, draining, or consuming the tick", () => {
		const queue = { drainCollisionEvents: vi.fn() };
		const world = { timestep: 0, step: vi.fn() };
		const events = createPhysicsEventBuffer();
		const stepper = createRawRapierStepper({
			world,
			queue,
			events,
			resolveColliderEntityId: () => undefined,
		});

		for (const invalid of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			expect(() => stepper.step(invalid, 1)).toThrow(/finite|fixed/u);
		}
		expect(world.timestep).toBe(0);
		expect(world.step).not.toHaveBeenCalled();
		expect(queue.drainCollisionEvents).not.toHaveBeenCalled();

		stepper.step(FIXED_STEP_SECONDS, 1);
		expect(world.step).toHaveBeenCalledOnce();
		expect(queue.drainCollisionEvents).toHaveBeenCalledOnce();
	});

	it("steps the pinned Rapier implementation within pose tolerance and drains real collision events", async () => {
		const rapier = await loadPinnedRapier();
		const queue = new rapier.EventQueue(true);
		const world = new rapier.World({ x: 0, y: 0, z: 0 });
		const events = createPhysicsEventBuffer();
		let destroyStepper: (() => void) | undefined;
		try {
			const body = world.createRigidBody(
				rapier.RigidBodyDesc.dynamic()
					.setTranslation(0, 0, 0)
					.setLinvel(0.75, 0, 0)
					.setCanSleep(false),
			);
			const movingCollider = world.createCollider(
				rapier.ColliderDesc.ball(0.5)
					.setSensor(true)
					.setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS),
				body,
			);
			const anchorCollider = world.createCollider(
				rapier.ColliderDesc.ball(0.5)
					.setSensor(true)
					.setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS),
			);
			const ids = new Map([
				[movingCollider.handle, "moving"],
				[anchorCollider.handle, "anchor"],
			]);
			const stepper = createRawRapierStepper({
				world,
				queue,
				events,
				resolveColliderEntityId: (handle) => ids.get(handle),
			});
			destroyStepper = () => stepper.destroy();

			stepper.step(FIXED_STEP_SECONDS, 1);

			const expectedX = 0.75 * FIXED_STEP_SECONDS;
			expect(Math.abs(body.translation().x - expectedX)).toBeLessThanOrEqual(
				1e-6,
			);
			expect(events.drain()).toEqual([
				{
					entityId: "anchor",
					otherEntityId: "moving",
					kind: "collision-start",
					sequence: 0,
					payload: { tick: 1 },
				},
			]);
		} finally {
			destroyStepper?.();
			queue.free();
			world.free();
		}
	});
});

describe("manual Rapier bridge lifecycle", () => {
	it("clears buffered events whenever the bridge resets", () => {
		const events = createPhysicsEventBuffer();
		events.push({
			entityId: "snowball",
			kind: "collision-start",
			sequence: 0,
			payload: { tick: 1 },
		});
		const stepper = { step: vi.fn(), reset: vi.fn() };
		const bridge = createManualRapierBridge(stepper, events);

		bridge.reset();

		expect(stepper.reset).toHaveBeenCalledOnce();
		expect(events.size).toBe(0);
	});

	it("revokes and releases a failed bridge publication", () => {
		const calls: string[] = [];
		const events = createPhysicsEventBuffer();
		events.push({
			entityId: "snowball",
			kind: "collision-start",
			sequence: 0,
		});
		const stepper = {
			step: vi.fn(),
			reset: vi.fn(),
			destroy: vi.fn(() => calls.push("destroy")),
		};
		const queue = { free: vi.fn(() => calls.push("free")) };
		let retained: ManualRapierBridge | undefined;

		expect(() =>
			createManualRapierBinding(stepper, events, queue, (bridge) => {
				if (bridge === null) return;
				retained = bridge;
				throw new Error("publish failed");
			}),
		).toThrow(/publish failed/u);

		expect(calls).toEqual(["destroy", "free"]);
		expect(events.size).toBe(0);
		expect(retained).toBeDefined();
		const retainedBridge = retained;
		if (retainedBridge === undefined)
			throw new Error("bridge was not published");
		expect(() => retainedBridge.stepPhysics(FIXED_STEP_SECONDS, 1)).toThrow(
			/revoked/u,
		);
		expect(stepper.step).not.toHaveBeenCalled();
	});

	it("revokes first and attempts every cleanup before the null notification", () => {
		const calls: string[] = [];
		const events = createPhysicsEventBuffer();
		vi.spyOn(events, "clear").mockImplementation(() => {
			calls.push("clear");
			throw new Error("clear failed");
		});
		let retained!: ManualRapierBridge;
		let revokedBeforeDestroy = false;
		const stepper = {
			step: vi.fn(),
			reset: vi.fn(),
			destroy: vi.fn(() => {
				calls.push("destroy");
				try {
					retained.stepPhysics(FIXED_STEP_SECONDS, 1);
				} catch (error) {
					revokedBeforeDestroy =
						error instanceof Error && /revoked/u.test(error.message);
				}
				throw new Error("destroy failed");
			}),
		};
		const queue = {
			free: vi.fn(() => {
				calls.push("free");
				throw new Error("free failed");
			}),
		};
		const binding = createManualRapierBinding(
			stepper,
			events,
			queue,
			(bridge) => {
				if (bridge !== null) {
					retained = bridge;
					return;
				}
				calls.push("notify:null");
				throw new Error("notify failed");
			},
		);

		expect(() => binding.destroy()).toThrow(/notify failed/u);
		expect(revokedBeforeDestroy).toBe(true);
		expect(calls).toEqual(["destroy", "clear", "free", "notify:null"]);
		expect(() => binding.destroy()).not.toThrow();
		expect(stepper.destroy).toHaveBeenCalledOnce();
		expect(queue.free).toHaveBeenCalledOnce();
	});

	it("remounts with an empty event buffer even when cleanup notification throws", () => {
		const events = createPhysicsEventBuffer();
		events.push({
			entityId: "snowball",
			kind: "collision-start",
			sequence: 0,
		});
		const first = createManualRapierBinding(
			{ step: vi.fn(), reset: vi.fn(), destroy: vi.fn() },
			events,
			{ free: vi.fn() },
			(bridge) => {
				if (bridge === null) throw new Error("cleanup callback failed");
			},
		);

		expect(() => first.destroy()).toThrow(/cleanup callback failed/u);
		expect(events.size).toBe(0);

		const sizesAtPublish: number[] = [];
		const second = createManualRapierBinding(
			{ step: vi.fn(), reset: vi.fn(), destroy: vi.fn() },
			events,
			{ free: vi.fn() },
			(bridge) => {
				if (bridge !== null) sizesAtPublish.push(events.size);
			},
		);
		expect(sizesAtPublish).toEqual([0]);
		second.destroy();
	});

	it("publishes a replacement callback even when the prior release throws", () => {
		const firstCallback = vi.fn((bridge: ManualRapierBridge | null) => {
			if (bridge === null) throw new Error("prior release failed");
		});
		const nextCallback = vi.fn();
		const binding = createManualRapierBinding(
			{ step: vi.fn(), reset: vi.fn(), destroy: vi.fn() },
			createPhysicsEventBuffer(),
			{ free: vi.fn() },
			firstCallback,
		);

		expect(() => binding.setOnBridge(nextCallback)).toThrow(
			/prior release failed/u,
		);
		expect(nextCallback).toHaveBeenCalledWith(binding.bridge);
		binding.destroy();
		expect(nextCallback).toHaveBeenLastCalledWith(null);
	});

	it("does not publish a replacement after the prior callback destroys reentrantly", () => {
		const stepper = {
			step: vi.fn(),
			reset: vi.fn(),
			destroy: vi.fn(),
		};
		const queue = { free: vi.fn() };
		let destroyBinding: () => void = () => {
			throw new Error("binding is not ready");
		};
		const previousCallback = vi.fn((bridge: ManualRapierBridge | null) => {
			if (bridge === null) destroyBinding();
		});
		const nextCallback = vi.fn();
		const binding = createManualRapierBinding(
			stepper,
			createPhysicsEventBuffer(),
			queue,
			previousCallback,
		);
		destroyBinding = () => binding.destroy();

		binding.setOnBridge(nextCallback);

		expect(binding.destroyed).toBe(true);
		expect(nextCallback).not.toHaveBeenCalled();
		expect(stepper.destroy).toHaveBeenCalledOnce();
		expect(queue.free).toHaveBeenCalledOnce();
		expect(() => binding.bridge.stepPhysics(FIXED_STEP_SECONDS, 1)).toThrow(
			/revoked/u,
		);
	});

	it("lets a reentrant clear supersede an in-progress callback replacement", () => {
		const stepper = {
			step: vi.fn(),
			reset: vi.fn(),
			destroy: vi.fn(),
		};
		let clearBridge: () => void = () => {
			throw new Error("binding is not ready");
		};
		const previousCallback = vi.fn((bridge: ManualRapierBridge | null) => {
			if (bridge === null) clearBridge();
		});
		const nextCallback = vi.fn();
		const binding = createManualRapierBinding(
			stepper,
			createPhysicsEventBuffer(),
			{ free: vi.fn() },
			previousCallback,
		);
		clearBridge = () => binding.setOnBridge(undefined);

		binding.setOnBridge(nextCallback);

		expect(binding.destroyed).toBe(false);
		expect(previousCallback).toHaveBeenCalledTimes(2);
		expect(nextCallback).not.toHaveBeenCalled();
		binding.bridge.stepPhysics(FIXED_STEP_SECONDS, 1);
		expect(stepper.step).toHaveBeenCalledOnce();
		binding.destroy();
		expect(nextCallback).not.toHaveBeenCalled();
	});

	it("preserves a reentrant successor when stale publication throws", () => {
		const stepper = {
			step: vi.fn(),
			reset: vi.fn(),
			destroy: vi.fn(),
		};
		const queue = { free: vi.fn() };
		const previousCallback = vi.fn();
		const successorCallback = vi.fn();
		let installSuccessor: () => void = () => {
			throw new Error("binding is not ready");
		};
		const staleCallback = vi.fn((bridge: ManualRapierBridge | null) => {
			if (bridge === null) return;
			installSuccessor();
			throw new Error("stale publication failed");
		});
		const binding = createManualRapierBinding(
			stepper,
			createPhysicsEventBuffer(),
			queue,
			previousCallback,
		);
		installSuccessor = () => binding.setOnBridge(successorCallback);

		expect(() => binding.setOnBridge(staleCallback)).toThrow(
			/stale publication failed/u,
		);

		expect(binding.destroyed).toBe(false);
		expect(successorCallback).toHaveBeenCalledTimes(1);
		expect(successorCallback).toHaveBeenCalledWith(binding.bridge);
		binding.bridge.stepPhysics(FIXED_STEP_SECONDS, 1);
		expect(stepper.step).toHaveBeenCalledOnce();
		expect(stepper.destroy).not.toHaveBeenCalled();
		expect(queue.free).not.toHaveBeenCalled();
		binding.destroy();
		expect(successorCallback).toHaveBeenLastCalledWith(null);
		expect(stepper.destroy).toHaveBeenCalledOnce();
		expect(queue.free).toHaveBeenCalledOnce();
	});

	it("fully cleans and aggregates replacement publication failures", () => {
		const calls: string[] = [];
		const events = createPhysicsEventBuffer();
		events.push({
			entityId: "snowball",
			kind: "collision-start",
			sequence: 0,
		});
		const originalClear = events.clear.bind(events);
		vi.spyOn(events, "clear").mockImplementation(() => {
			calls.push("clear");
			originalClear();
		});
		const stepper = {
			step: vi.fn(),
			reset: vi.fn(),
			destroy: vi.fn(() => calls.push("destroy")),
		};
		const queue = { free: vi.fn(() => calls.push("free")) };
		const previousCallback = vi.fn((bridge: ManualRapierBridge | null) => {
			if (bridge === null) {
				calls.push("release");
				throw new Error("release failed");
			}
		});
		let retained: ManualRapierBridge | undefined;
		const nextCallback = vi.fn((bridge: ManualRapierBridge | null) => {
			if (bridge === null) {
				calls.push("replacement:null");
				throw new Error("replacement cleanup failed");
			}
			calls.push("replacement:publish");
			retained = bridge;
			throw new Error("replacement publish failed");
		});
		const binding = createManualRapierBinding(
			stepper,
			events,
			queue,
			previousCallback,
		);
		let thrown: unknown;
		try {
			binding.setOnBridge(nextCallback);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(AggregateError);
		expect(calls).toEqual([
			"release",
			"replacement:publish",
			"destroy",
			"clear",
			"free",
			"replacement:null",
		]);
		expect(events.size).toBe(0);
		expect(binding.destroyed).toBe(true);
		const retainedBridge = retained;
		if (retainedBridge === undefined)
			throw new Error("bridge was not retained");
		expect(() => retainedBridge.stepPhysics(FIXED_STEP_SECONDS, 1)).toThrow(
			/revoked/u,
		);
		expect(stepper.step).not.toHaveBeenCalled();
	});
});

describe("visible transform ownership", () => {
	it("allows multiple render writes per tick, rejects regression, and retains one-writer ownership", () => {
		const writer = createVisibleTransformWriter();
		const first = new Object3D();
		const second = new Object3D();
		const firstCopy = vi.spyOn(first.position, "copy");
		const secondCopy = vi.spyOn(second.position, "copy");
		writer.bind("a", first);
		writer.bind("z", second);

		expect(writer.write(1, [transform("a", 2), transform("z", 9)])).toBe(2);
		expect(writer.write(1, [transform("a", 3), transform("z", 10)])).toBe(2);
		expect(first.position.x).toBe(3);
		expect(second.position.x).toBe(10);
		expect(firstCopy.mock.calls[1]?.[0]).toBe(firstCopy.mock.calls[0]?.[0]);
		expect(secondCopy.mock.calls[1]?.[0]).toBe(secondCopy.mock.calls[0]?.[0]);
		expect(() => writer.write(0, [])).toThrow(/regress/u);
		expect(() => writer.bind("other-a", first)).toThrow(/already owned/u);
		expect(() =>
			writer.write(2, [transform("z", 1), transform("a", 2)]),
		).toThrow(/strictly sorted/u);
		expect(first.position.x).toBe(3);
		expect(second.position.x).toBe(10);
		writer.reset();
		expect(writer.size).toBe(0);
		writer.destroy();
	});

	it("validates every direct transform before mutating any Object3D pose", () => {
		const hostileTransforms: readonly PhysicsTransform[] = [
			{
				...transform("z", 9),
				position: { x: Number.NaN, y: 0, z: 0 },
			},
			{
				...transform("z", 9),
				scale: { x: 1, y: Number.POSITIVE_INFINITY, z: 1 },
			},
			{
				...transform("z", 9),
				rotation: { x: 0, y: 0, z: 0, w: 0 },
			},
			{
				...transform("z", 9),
				position: { x: Number.MAX_VALUE, y: 0, z: 0 },
			},
			{
				...transform("z", 9),
				position: { x: Number.MIN_VALUE, y: 0, z: 0 },
			},
		];
		for (const hostile of hostileTransforms) {
			const writer = createVisibleTransformWriter();
			const first = new Object3D();
			const second = new Object3D();
			first.position.set(11, 12, 13);
			first.scale.set(2, 3, 4);
			second.position.set(21, 22, 23);
			second.scale.set(5, 6, 7);
			const firstPose = {
				position: first.position.toArray(),
				quaternion: first.quaternion.toArray(),
				scale: first.scale.toArray(),
			};
			const secondPose = {
				position: second.position.toArray(),
				quaternion: second.quaternion.toArray(),
				scale: second.scale.toArray(),
			};
			writer.bind("a", first);
			writer.bind("z", second);

			expect(() => writer.write(1, [transform("a", 1), hostile])).toThrow(
				/finite|f32|underflow|quaternion|rotation/u,
			);
			expect({
				position: first.position.toArray(),
				quaternion: first.quaternion.toArray(),
				scale: first.scale.toArray(),
			}).toEqual(firstPose);
			expect({
				position: second.position.toArray(),
				quaternion: second.quaternion.toArray(),
				scale: second.scale.toArray(),
			}).toEqual(secondPose);
		}
	});

	it("writes preallocated interpolation directly without snapshot churn", () => {
		const interpolator = createTransformInterpolator();
		const writer = createVisibleTransformWriter();
		const object = new Object3D();
		const positionCopy = vi.spyOn(object.position, "copy");
		writer.bind("snowball", object);
		interpolator.record(1, [transform("snowball", 0)]);
		interpolator.record(2, [transform("snowball", 10)]);

		expect(writer.writeInterpolated(2, interpolator, 0.25)).toBe(1);
		expect(writer.writeInterpolated(2, interpolator, 0.75)).toBe(1);
		expect(object.position.x).toBe(7.5);
		expect(positionCopy.mock.calls[1]?.[0]).toBe(
			positionCopy.mock.calls[0]?.[0],
		);
	});

	it("stages a whole interpolated pass before mutating visible objects", () => {
		const writer = createVisibleTransformWriter();
		const first = new Object3D();
		const second = new Object3D();
		first.position.x = 10;
		second.position.x = 20;
		writer.bind("a", first);
		writer.bind("z", second);
		const hostileInterpolator: TransformInterpolator = {
			record: vi.fn(),
			forEachInterpolated(_alpha, visitor) {
				visitor(transform("a", 1));
				visitor({
					...transform("z", 2),
					rotation: {
						x: Number.NaN,
						y: 0,
						z: 0,
						w: 1,
					},
				});
				return 2;
			},
			sample: vi.fn(() => []),
			reset: vi.fn(),
			destroy: vi.fn(),
			destroyed: false,
		};

		expect(() => writer.writeInterpolated(1, hostileInterpolator, 0.5)).toThrow(
			/finite|rotation/u,
		);
		expect(first.position.x).toBe(10);
		expect(second.position.x).toBe(20);
	});
});

describe("Snowball rigid-body handle lifecycle", () => {
	it("replays ready/null/ready in StrictMode and still publishes a replacement after release failure", async () => {
		const bodyHandle = Object.freeze({ kind: "body" });
		const colliderHandle = {
			kind: "collider",
			setActiveEvents: vi.fn(),
		};
		const MockRigidBody = forwardRef<
			object,
			Readonly<{ children?: ReactNode }>
		>(({ children }, ref) => {
			const hostRef = useCallback(
				(node: HTMLDivElement | null) =>
					assignForwardedRef(ref, node === null ? null : bodyHandle),
				[ref],
			);
			return createElement("div", { ref: hostRef }, children);
		});
		const MockBallCollider = forwardRef<object>((_props, ref) => {
			const hostRef = useCallback(
				(node: HTMLSpanElement | null) =>
					assignForwardedRef(ref, node === null ? null : colliderHandle),
				[ref],
			);
			return createElement("span", { ref: hostRef });
		});
		vi.doMock("@react-three/rapier", () => ({
			BallCollider: MockBallCollider,
			RigidBody: MockRigidBody,
			useRapier: () => ({
				rapier: { ActiveEvents: { COLLISION_EVENTS: 1 } },
			}),
		}));
		vi.resetModules();
		// Dynamic import is required so Vitest applies the test-only Rapier module mock.
		const { SnowballRigidBodyProxy } = await import(
			"../../packages/runtime-r3f/src/SnowballRigidBodyProxy.js"
		);
		const { JSDOM } = loadJSDOM();
		const dom = new JSDOM(
			'<!doctype html><html><body><div id="first"></div><div id="second"></div></body></html>',
		);
		const globalKeys = [
			"window",
			"document",
			"navigator",
			"Node",
			"Element",
			"HTMLElement",
			"IS_REACT_ACT_ENVIRONMENT",
		] as const;
		const previousGlobals = globalKeys.map(
			(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
		);
		const window = dom.window;
		Object.defineProperties(globalThis, {
			window: { configurable: true, value: window },
			document: { configurable: true, value: window.document },
			navigator: { configurable: true, value: window.navigator },
			Node: { configurable: true, value: window.Node },
			Element: { configurable: true, value: window.Element },
			HTMLElement: { configurable: true, value: window.HTMLElement },
			IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
		});
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		try {
			const firstContainer = window.document.getElementById("first");
			const secondContainer = window.document.getElementById("second");
			if (firstContainer === null || secondContainer === null) {
				throw new Error("React test containers are missing");
			}

			const notifications: string[] = [];
			const firstRoot = createRoot(firstContainer);
			await act(async () => {
				firstRoot.render(
					createElement(
						StrictMode,
						null,
						createElement(SnowballRigidBodyProxy, {
							stableId: "strict-snowball",
							facts: { radius: 1, mass: 2 },
							onHandles: (body, collider) => {
								notifications.push(
									body === null && collider === null ? "null" : "ready",
								);
							},
						}),
					),
				);
			});
			expect(notifications).toEqual(["ready", "null", "ready"]);
			await act(async () => firstRoot.unmount());
			expect(notifications).toEqual(["ready", "null", "ready", "null"]);

			let throwOnRelease = false;
			const replacementNotifications: string[] = [];
			const secondRoot = createRoot(secondContainer);
			const previousCallback = (
				body: object | null,
				collider: object | null,
			) => {
				if (body === null && collider === null && throwOnRelease) {
					throw new Error("prior handle release failed");
				}
			};
			await act(async () => {
				secondRoot.render(
					createElement(
						StrictMode,
						null,
						createElement(SnowballRigidBodyProxy, {
							stableId: "replacement-snowball",
							facts: { radius: 1, mass: 2 },
							onHandles: previousCallback,
						}),
					),
				);
			});
			throwOnRelease = true;
			let replacementError: unknown;
			try {
				await act(async () => {
					secondRoot.render(
						createElement(
							StrictMode,
							null,
							createElement(SnowballRigidBodyProxy, {
								stableId: "replacement-snowball",
								facts: { radius: 1, mass: 2 },
								onHandles: (body, collider) => {
									replacementNotifications.push(
										body === null && collider === null ? "null" : "ready",
									);
								},
							}),
						),
					);
				});
			} catch (error) {
				replacementError = error;
			}
			expect(replacementError).toBeInstanceOf(Error);
			expect(replacementNotifications[0]).toBe("ready");
		} finally {
			consoleError.mockRestore();
			window.close();
			for (const [key, descriptor] of previousGlobals) {
				if (descriptor === undefined) {
					Reflect.deleteProperty(globalThis, key);
				} else {
					Object.defineProperty(globalThis, key, descriptor);
				}
			}
			vi.doUnmock("@react-three/rapier");
			vi.resetModules();
		}
	});
});

describe("React Three Rapier ownership boundary", () => {
	it("owns one paused raw queue/world step and one hidden proxy/visible writer path", async () => {
		const [manual, stepper, ecctrl, proxy, snowballProxy, writer] =
			await Promise.all([
				readFile(
					new URL(
						"../../packages/runtime-r3f/src/ManualPhysics.tsx",
						import.meta.url,
					),
					"utf8",
				),
				readFile(
					new URL(
						"../../packages/runtime-r3f/src/rapier-stepper.ts",
						import.meta.url,
					),
					"utf8",
				),
				readFile(
					new URL(
						"../../packages/runtime-r3f/src/ecctrl-adapter.ts",
						import.meta.url,
					),
					"utf8",
				),
				readFile(
					new URL(
						"../../packages/runtime-r3f/src/PhysicsOnlyProxy.tsx",
						import.meta.url,
					),
					"utf8",
				),
				readFile(
					new URL(
						"../../packages/runtime-r3f/src/SnowballRigidBodyProxy.tsx",
						import.meta.url,
					),
					"utf8",
				),
				readFile(
					new URL(
						"../../packages/runtime-r3f/src/visible-transform-writer.ts",
						import.meta.url,
					),
					"utf8",
				),
			]);
		expect(manual.match(/<Physics\b/gu)).toHaveLength(1);
		expect(manual).toContain("paused={true}");
		expect(manual).toContain("interpolate={false}");
		expect(manual.match(/new\s+rapier\.EventQueue\s*\(/gu)).toHaveLength(1);
		expect(manual).toContain("createManualRapierBinding");
		expect(manual).toContain("}, [events, rapier, world]);");
		expect(stepper.match(/world\.step\(options\.queue\)/gu)).toHaveLength(1);
		expect(stepper).toContain("world.timestep = FIXED_STEP_SECONDS");
		expect(`${manual}\n${stepper}`).not.toMatch(
			/\bon(?:Collision|Intersection)(?:Enter|Exit)\b/u,
		);
		expect(manual).not.toMatch(/\{\s*step\s*\}\s*=\s*useRapier/u);
		expect(ecctrl.match(/handle\.setMovement\(/gu)).toHaveLength(3);
		expect(ecctrl).not.toMatch(/\b(?:stepPhysics|RigidBody|Rapier)\b/u);
		expect(proxy).toContain("visible={false}");
		expect(snowballProxy.match(/<RigidBody\b/gu)).toHaveLength(1);
		expect(snowballProxy.match(/<BallCollider\b/gu)).toHaveLength(1);
		expect(snowballProxy).toContain("colliders={false}");
		expect(snowballProxy).toContain("<PhysicsOnlyProxy");
		expect(snowballProxy).not.toContain("applySnowballGrowthInPlace");
		expect(snowballProxy).not.toContain("[facts.mass, facts.radius]");
		expect(snowballProxy).toContain("rapier.ActiveEvents.COLLISION_EVENTS");
		expect(snowballProxy).toContain("ref={setBody}");
		expect(snowballProxy).toContain("ref={setCollider}");
		expect(snowballProxy).toContain("initialConfig");
		expect(snowballProxy).toContain(
			"const initialStableId = useRef(stableId);",
		);
		expect(snowballProxy).toContain(
			"createSnowballRigidBodyPosition(position)",
		);
		expect(snowballProxy).toContain(
			"if (stableId !== initialStableId.current)",
		);
		expect(snowballProxy).toContain("name={initialIdentity.name}");
		expect(snowballProxy).toContain("position={initialPosition.current}");
		expect(snowballProxy).toContain("userData={initialIdentity.userData}");
		expect(snowballProxy).toMatch(
			/useLayoutEffect\(\(\) => \{\s*notifyReadyHandles\(\);\s*return \(\) => \{/u,
		);
		expect(snowballProxy).not.toContain(
			String.raw`name={\`\${stableId}:physics-only\`}`,
		);
		expect(snowballProxy).not.toContain(
			"position={[position[0], position[1], position[2]]}",
		);
		expect(snowballProxy).not.toMatch(
			/\bon(?:Collision|Intersection)(?:Enter|Exit)\b/u,
		);
		expect(ecctrl).toContain("enableToggleRun: false");
		const clearedBodyRef = snowballProxy.lastIndexOf("body.current = null;");
		const clearedColliderRef = snowballProxy.lastIndexOf(
			"collider.current = null;",
		);
		const handleRelease = snowballProxy.lastIndexOf(
			"onHandlesRef.current?.(null, null);",
		);
		expect(clearedBodyRef).toBeGreaterThan(-1);
		expect(clearedColliderRef).toBeGreaterThan(clearedBodyRef);
		expect(handleRelease).toBeGreaterThan(clearedColliderRef);
		expect(manual.match(/\tuseLayoutEffect\(\(\) => \{/gu)).toHaveLength(2);
		expect(writer.match(/object\.position\.copy\(/gu)).toHaveLength(1);
		const unbindStart = writer.indexOf("unbind(stableId)");
		const writeStart = writer.indexOf("write(tick, transforms)", unbindStart);
		const unbindSource = writer.slice(unbindStart, writeStart);
		expect(unbindSource).toContain("stagedTransforms");
		expect(unbindSource).toContain("slot.object = undefined");
	});
});
