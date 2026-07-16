export const SYSTEM_PHASES = Object.freeze([
	"INPUT",
	"CONTROLLER_CAMERA",
	"PHYSICS",
	"PHYSICS_EVENTS",
	"COLLECTION",
	"DISABLE_ATTACH",
	"GROWTH",
	"STREAMING",
	"SNAPSHOT",
	"UI",
] as const);

export type SystemPhase = (typeof SYSTEM_PHASES)[number];

export interface EngineSystem<TContext> {
	readonly id: string;
	readonly phase: SystemPhase;
	run(context: TContext): void;
}

export interface SystemScheduler<TContext> {
	register(system: EngineSystem<TContext>): void;
	unregister(id: string): boolean;
	run(context: TContext): void;
	clear(): void;
	reset(): void;
	destroy(): void;
	readonly destroyed: boolean;
	readonly systems: readonly EngineSystem<TContext>[];
}

export function ordinalCompare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

const PHASE_INDEX = new Map(
	SYSTEM_PHASES.map((phase, index) => [phase, index] as const),
);

export function createSystemScheduler<TContext>(): SystemScheduler<TContext> {
	const systems = new Map<string, EngineSystem<TContext>>();
	let ordered: readonly EngineSystem<TContext>[] = Object.freeze([]);
	let destroyed = false;
	let running = false;

	function assertAlive(): void {
		if (destroyed) throw new Error("system scheduler is destroyed");
	}

	function refresh(): void {
		ordered = Object.freeze(
			[...systems.values()].sort((left, right) => {
				const phase =
					(PHASE_INDEX.get(left.phase) ?? Number.MAX_SAFE_INTEGER) -
					(PHASE_INDEX.get(right.phase) ?? Number.MAX_SAFE_INTEGER);
				return phase === 0 ? ordinalCompare(left.id, right.id) : phase;
			}),
		);
	}

	return {
		register(system) {
			assertAlive();
			const { id, phase, run } = system;
			if (id.length === 0) {
				throw new Error("system ID must not be empty");
			}
			if (!PHASE_INDEX.has(phase)) {
				throw new Error(`unknown system phase: ${String(phase)}`);
			}
			if (systems.has(id)) {
				throw new Error(`duplicate system ID: ${id}`);
			}
			systems.set(id, Object.freeze({ id, phase, run }));
			refresh();
		},
		unregister(id) {
			assertAlive();
			const removed = systems.delete(id);
			if (removed) refresh();
			return removed;
		},
		run(context) {
			assertAlive();
			if (running) throw new Error("system scheduler is already running");
			running = true;
			try {
				for (const system of ordered) {
					if (destroyed) break;
					system.run(context);
				}
			} finally {
				running = false;
			}
		},
		clear() {
			assertAlive();
			systems.clear();
			refresh();
		},
		reset() {
			assertAlive();
		},
		destroy() {
			if (destroyed) return;
			systems.clear();
			refresh();
			destroyed = true;
		},
		get destroyed() {
			return destroyed;
		},
		get systems() {
			return ordered;
		},
	};
}

export interface SimulationEvent<TPayload = unknown> {
	readonly entityId: string;
	readonly otherEntityId?: string;
	readonly kind: string;
	readonly sequence: number;
	readonly payload: TPayload;
}

export function sortSimulationEvents<TPayload>(
	events: readonly SimulationEvent<TPayload>[],
): readonly SimulationEvent<TPayload>[] {
	const sequences = new Array<number>(events.length);
	for (let index = 0; index < events.length; index += 1) {
		const sequence = events[index]?.sequence;
		if (
			sequence === undefined ||
			!Number.isSafeInteger(sequence) ||
			sequence < 0
		) {
			throw new Error(
				"simulation event sequence must be a non-negative safe integer",
			);
		}
		sequences[index] = sequence;
	}
	const copiedEvents = events.map((event, index) => {
		const otherEntityId = event.otherEntityId;
		return Object.freeze({
			entityId: event.entityId,
			...(otherEntityId === undefined ? {} : { otherEntityId }),
			kind: event.kind,
			sequence: sequences[index] ?? 0,
			payload: event.payload,
		});
	});
	return Object.freeze(
		copiedEvents.sort((left, right) => {
			const entity = ordinalCompare(left.entityId, right.entityId);
			if (entity !== 0) return entity;
			const kind = ordinalCompare(left.kind, right.kind);
			if (kind !== 0) return kind;
			const peer = ordinalCompare(
				left.otherEntityId ?? "",
				right.otherEntityId ?? "",
			);
			return peer === 0 ? left.sequence - right.sequence : peer;
		}),
	);
}
