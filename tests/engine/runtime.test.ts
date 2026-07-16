import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createWorld } from "koota";

import { describe, expect, it, vi } from "vitest";

import {
	Attachment,
	applyResidencyToWorld,
	Collectible,
	createFixedStepClock,
	createGameWorld,
	createPerformanceTelemetry,
	createSeededRandom,
	createSystemScheduler,
	createWorldSnapshot,
	FIXED_STEP_MS,
	GameWorldTraits,
	LevelEntity,
	MAX_TELEMETRY_SAMPLES,
	ObjectiveCritical,
	ObjectiveFacts,
	ordinalCompare,
	PackOwner,
	PERFORMANCE_BUDGETS,
	PERFORMANCE_TRACE_LABELS,
	PhysicsHandleKey,
	Player,
	Position,
	RenderHandleKey,
	Requirements,
	Residency,
	type ResidencyBand,
	RuntimeSingleton,
	SizeBand,
	SnowballFacts,
	StableIdentity,
	SYSTEM_PHASES,
	sortSimulationEvents,
	UiSnapshotFacts,
} from "../../packages/engine/src/index.js";

const BANDS: readonly [ResidencyBand, ResidencyBand, ResidencyBand] = [
	{ id: "small", loadRadius: 12, unloadRadius: 16, lookAheadSeconds: 0.5 },
	{ id: "medium", loadRadius: 20, unloadRadius: 26, lookAheadSeconds: 0.75 },
	{ id: "large", loadRadius: 32, unloadRadius: 42, lookAheadSeconds: 1 },
];

describe("fixed-step clock", () => {
	it("replays the same ticks across different render-frame chunking", () => {
		const run = (times: readonly number[]) => {
			const clock = createFixedStepClock();
			const ticks = [] as number[];
			for (const time of times) {
				ticks.push(
					...clock.advance(time, false).ticks.map((tick) => tick.tick),
				);
			}
			return ticks;
		};
		const step = FIXED_STEP_MS;
		expect(run([0, step / 2, step, step * 2, step * 4])).toEqual([1, 2, 3, 4]);
		expect(run([0, step * 2, step * 4])).toEqual([1, 2, 3, 4]);
	});

	it("timestamps every admitted tick at its real monotonic boundary", () => {
		const clock = createFixedStepClock();
		clock.advance(0, false);

		const result = clock.advance(50, false);

		expect(result.ticks).toHaveLength(3);
		expect(result.ticks.map((tick) => tick.timestampMs)).toEqual([
			expect.closeTo(FIXED_STEP_MS, 10),
			expect.closeTo(FIXED_STEP_MS * 2, 10),
			expect.closeTo(50, 10),
		]);
	});

	it("admits at most four catch-up ticks and drops whole excess ticks", () => {
		const clock = createFixedStepClock();
		clock.advance(0, false);
		const result = clock.advance(FIXED_STEP_MS * 10, false);
		expect(result.ticks).toHaveLength(4);
		expect(result.droppedTicks).toBe(6);
		expect(result.alpha).toBeGreaterThanOrEqual(0);
		expect(result.alpha).toBeLessThan(1);
	});

	it("runs zero hidden ticks and never bursts hidden backlog on restore", () => {
		const clock = createFixedStepClock();
		clock.advance(0, false);
		expect(clock.advance(FIXED_STEP_MS * 30, true).ticks).toHaveLength(0);
		expect(clock.advance(FIXED_STEP_MS * 300, true).ticks).toHaveLength(0);
		expect(clock.advance(FIXED_STEP_MS * 301, false).ticks).toHaveLength(0);
		const restored = clock.advance(FIXED_STEP_MS * 302, false).ticks;
		expect(restored).toHaveLength(1);
		expect(restored[0]?.timestampMs).toBeCloseTo(FIXED_STEP_MS * 302, 10);
	});

	it("resets deterministically and rejects non-monotonic timestamps", () => {
		const clock = createFixedStepClock();
		clock.advance(100, false);
		expect(() => clock.advance(99, false)).toThrow(/monotonic/u);
		clock.reset();
		expect(clock.advance(5, false).ticks).toHaveLength(0);
		const afterReset = clock.advance(5 + FIXED_STEP_MS, false).ticks;
		expect(afterReset).toHaveLength(1);
		expect(afterReset[0]?.timestampMs).toBeCloseTo(5 + FIXED_STEP_MS, 10);
		clock.destroy();
		expect(() => clock.advance(6, false)).toThrow(/destroyed/u);
	});
});

describe("deterministic scheduling", () => {
	it("produces identical seeded sequences", () => {
		const first = createSeededRandom(0x51ced);
		const second = createSeededRandom(0x51ced);
		expect(Array.from({ length: 12 }, () => first.nextUint32())).toEqual(
			Array.from({ length: 12 }, () => second.nextUint32()),
		);
		expect(first.nextFloat()).toBeGreaterThanOrEqual(0);
		expect(first.nextFloat()).toBeLessThan(1);
	});

	it("enforces the immutable complete stage order and stable IDs within stages", () => {
		expect(SYSTEM_PHASES).toEqual([
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
		]);
		expect(Object.isFrozen(SYSTEM_PHASES)).toBe(true);

		const calls: string[] = [];
		const scheduler = createSystemScheduler<{ tick: number }>();
		scheduler.register({
			id: "z-physics",
			phase: "PHYSICS",
			run: () => calls.push("z-physics"),
		});
		scheduler.register({
			id: "ui",
			phase: "UI",
			run: () => calls.push("ui"),
		});
		scheduler.register({
			id: "input",
			phase: "INPUT",
			run: () => calls.push("input"),
		});
		scheduler.register({
			id: "a-physics",
			phase: "PHYSICS",
			run: () => calls.push("a-physics"),
		});
		scheduler.register({
			id: "camera",
			phase: "CONTROLLER_CAMERA",
			run: () => calls.push("camera"),
		});
		scheduler.register({
			id: "events",
			phase: "PHYSICS_EVENTS",
			run: () => calls.push("events"),
		});
		scheduler.register({
			id: "collection",
			phase: "COLLECTION",
			run: () => calls.push("collection"),
		});
		scheduler.register({
			id: "disable-attach",
			phase: "DISABLE_ATTACH",
			run: () => calls.push("disable-attach"),
		});
		scheduler.register({
			id: "growth",
			phase: "GROWTH",
			run: () => calls.push("growth"),
		});
		scheduler.register({
			id: "streaming",
			phase: "STREAMING",
			run: () => calls.push("streaming"),
		});
		scheduler.register({
			id: "snapshot",
			phase: "SNAPSHOT",
			run: () => calls.push("snapshot"),
		});
		scheduler.run({ tick: 1 });
		expect(calls).toEqual([
			"input",
			"camera",
			"a-physics",
			"z-physics",
			"events",
			"collection",
			"disable-attach",
			"growth",
			"streaming",
			"snapshot",
			"ui",
		]);
		expect(Object.isFrozen(scheduler.systems)).toBe(true);
		expect(() =>
			scheduler.register({ id: "ui", phase: "UI", run: vi.fn() }),
		).toThrow(/duplicate/u);
		scheduler.reset();
		expect(scheduler.systems).toHaveLength(11);
		calls.length = 0;
		scheduler.run({ tick: 2 });
		expect(calls).toEqual([
			"input",
			"camera",
			"a-physics",
			"z-physics",
			"events",
			"collection",
			"disable-attach",
			"growth",
			"streaming",
			"snapshot",
			"ui",
		]);
		scheduler.clear();
		expect(scheduler.systems).toHaveLength(0);
		scheduler.register({
			id: "after-clear",
			phase: "INPUT",
			run: vi.fn(),
		});
		scheduler.destroy();
		expect(scheduler.destroyed).toBe(true);
		expect(scheduler.systems).toHaveLength(0);
		expect(() => scheduler.run({ tick: 2 })).toThrow(/destroyed/u);
	});

	it("stores frozen registration copies that caller mutation cannot corrupt", () => {
		const calls: string[] = [];
		const scheduler = createSystemScheduler<undefined>();
		const originalRun = () => calls.push("original");
		const registration: {
			id: string;
			phase: (typeof SYSTEM_PHASES)[number];
			run: () => void;
		} = {
			id: "mutable",
			phase: "GROWTH",
			run: originalRun,
		};
		scheduler.register(registration);

		registration.id = "corrupted";
		registration.phase = "INPUT";
		registration.run = () => calls.push("corrupted");
		scheduler.register({
			id: "first",
			phase: "INPUT",
			run: () => calls.push("first"),
		});
		scheduler.run(undefined);

		expect(calls).toEqual(["first", "original"]);
		expect(scheduler.systems[1]).toEqual({
			id: "mutable",
			phase: "GROWTH",
			run: originalRun,
		});
		expect(Object.isFrozen(scheduler.systems[1])).toBe(true);
		expect(scheduler.unregister("mutable")).toBe(true);
		expect(scheduler.unregister("corrupted")).toBe(false);
	});

	it("rejects recursive passes, releases the guard after errors, and cancels after destruction", () => {
		const recursive = createSystemScheduler<undefined>();
		let shouldRecurse = true;
		recursive.register({
			id: "recursive",
			phase: "INPUT",
			run: () => {
				if (!shouldRecurse) return;
				shouldRecurse = false;
				recursive.run(undefined);
			},
		});

		expect(() => recursive.run(undefined)).toThrow(/already running/u);
		expect(() => recursive.run(undefined)).not.toThrow();
		recursive.destroy();

		const lateRun = vi.fn();
		const destructive = createSystemScheduler<undefined>();
		destructive.register({
			id: "a-destroy",
			phase: "INPUT",
			run: () => destructive.destroy(),
		});
		destructive.register({
			id: "z-late",
			phase: "INPUT",
			run: lateRun,
		});

		expect(() => destructive.run(undefined)).not.toThrow();
		expect(destructive.destroyed).toBe(true);
		expect(lateRun).not.toHaveBeenCalled();
	});

	it("sorts copied events by stable entity IDs, kind, peer, and sequence", () => {
		const input = [
			{
				entityId: "b",
				otherEntityId: "a",
				kind: "collect",
				sequence: 2,
				payload: { n: 2 },
			},
			{
				entityId: "a",
				otherEntityId: "z",
				kind: "touch",
				sequence: 3,
				payload: { n: 3 },
			},
			{
				entityId: "a",
				otherEntityId: "b",
				kind: "collect",
				sequence: 1,
				payload: { n: 1 },
			},
		];
		const sorted = sortSimulationEvents(input);
		expect(sorted.map((event) => event.payload.n)).toEqual([1, 3, 2]);
		expect(input[0]?.payload.n).toBe(2);
		expect(ordinalCompare("A", "a")).toBeLessThan(0);
	});

	it("preflights safe event sequences before reading sortable facts", () => {
		for (const invalidSequence of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			-1,
			0.5,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			let kindReads = 0;
			const events = [
				{
					entityId: "same",
					get kind() {
						kindReads += 1;
						return "same";
					},
					sequence: 0,
					payload: "first",
				},
				{
					entityId: "same",
					kind: "same",
					sequence: invalidSequence,
					payload: "invalid",
				},
			];
			expect(() => sortSimulationEvents(events)).toThrow(
				/sequence must be a non-negative safe integer/u,
			);
			expect(kindReads).toBe(0);
		}

		let sequenceReads = 0;
		const sorted = sortSimulationEvents([
			{
				entityId: "same",
				kind: "same",
				get sequence() {
					sequenceReads += 1;
					return sequenceReads === 1 ? 2 : Number.NaN;
				},
				payload: 2,
			},
			{
				entityId: "same",
				kind: "same",
				sequence: 0,
				payload: 0,
			},
			{
				entityId: "same",
				kind: "same",
				sequence: 1,
				payload: 1,
			},
		]);
		expect(sequenceReads).toBe(1);
		expect(sorted.map((event) => event.payload)).toEqual([0, 1, 2]);
	});
});

describe("Koota world ownership", () => {
	it("spawns, queries, mutates, removes, resets, and destroys public traits", () => {
		const game = createGameWorld();
		const initialSingleton = game.world.query(RuntimeSingleton)[0];
		expect(initialSingleton).toBeDefined();
		initialSingleton?.set(ObjectiveFacts, {
			currentScore: 5,
			targetScore: 10,
			complete: false,
		});
		const player = game.world.spawn(
			StableIdentity({ value: "player" }),
			Position({ x: 1, y: 2, z: 3 }),
			SnowballFacts({ radius: 1, volume: 1, mass: 1, score: 0 }),
			Player,
			Residency({ active: true, cellX: 0, cellZ: 0 }),
		);
		const collectible = game.world.spawn(
			StableIdentity({ value: "rock" }),
			Position({ x: 4, y: 0, z: 0 }),
			Collectible,
			SizeBand({ index: 0, requiredRadius: 0.4 }),
			Residency({ active: false, cellX: 0, cellZ: 0 }),
		);
		expect([...game.world.query(Player)]).toEqual([player]);
		expect([...game.world.query(Collectible)]).toEqual([collectible]);
		player.set(Position, { x: 7, y: 2, z: 3 });
		expect(player.get(Position)?.x).toBe(7);
		collectible.remove(Collectible);
		expect(game.world.query(Collectible)).toHaveLength(0);
		collectible.add(Collectible);
		expect(collectible.has(Collectible)).toBe(true);
		game.handles.set("player", "physics", { opaque: true });
		expect(game.handles.get("player", "physics")).toEqual({ opaque: true });
		game.handles.set("rock", "render", { visible: true });
		collectible.destroy();
		expect(game.handles.get("rock", "render")).toBeUndefined();
		game.reset();
		expect(game.world.query()).toHaveLength(1);
		expect(game.world.query(RuntimeSingleton)).toHaveLength(1);
		expect(
			game.world.query(RuntimeSingleton)[0]?.get(ObjectiveFacts)?.targetScore,
		).toBe(0);
		expect(game.handles.size).toBe(0);
		const afterReset = game.world.spawn(
			StableIdentity({ value: "after-reset" }),
			Collectible,
		);
		game.handles.set("after-reset", "render", { visible: true });
		afterReset.destroy();
		expect(game.handles.get("after-reset", "render")).toBeUndefined();
		game.destroy();
		expect(game.handles.destroyed).toBe(true);
		expect(() => game.handles.set("late", "render", {})).toThrow(/destroyed/u);
		expect(() => game.reset()).toThrow(/destroyed/u);
	});

	it("keeps StableIdentity immutable and cleans handles under its captured ID", () => {
		const game = createGameWorld();
		const entity = game.world.spawn(
			StableIdentity({ value: "original" }),
			Player,
		);
		const identity = entity.get(StableIdentity);
		game.handles.set("original", "render", { visible: true });

		expect(Object.isFrozen(identity)).toBe(true);
		expect(() => Object.assign(identity ?? {}, { value: "direct" })).toThrow();
		expect(() => entity.set(StableIdentity, { value: "replacement" })).toThrow(
			/immutable/u,
		);
		expect(entity.get(StableIdentity)).toEqual({ value: "original" });

		const removable = game.world.spawn(
			StableIdentity({ value: "remove-readd" }),
			Collectible,
		);
		removable.remove(StableIdentity);
		expect(() =>
			removable.add(StableIdentity({ value: "replacement" })),
		).toThrow(/immutable/u);
		expect(removable.get(StableIdentity)).toEqual({ value: "remove-readd" });
		removable.destroy();

		const prefixed = game.world.spawn(
			StableIdentity({ value: "original\u0000child" }),
			Collectible,
		);
		game.handles.set("original\u0000child", "render", { child: true });

		entity.destroy();
		expect(game.handles.get("original", "render")).toBeUndefined();
		expect(game.handles.get("original\u0000child", "render")).toEqual({
			child: true,
		});
		prefixed.destroy();
		expect(game.handles.size).toBe(0);
		game.destroy();
	});

	it("validates StableIdentity atomically and reserves IDs until entity destruction", () => {
		const game = createGameWorld();
		const initialEntityCount = game.world.query().length;
		for (const value of [
			"",
			42,
			new String("boxed"),
			{ [Symbol.toPrimitive]: () => "coerced" },
		]) {
			expect(() =>
				game.world.spawn(StableIdentity({ value: value as never }), Player),
			).toThrow(/primitive non-empty string/u);
			expect(game.world.query()).toHaveLength(initialEntityCount);
		}

		let identityReads = 0;
		const suppliedIdentity = {
			get value() {
				identityReads += 1;
				return identityReads === 1 ? "reserved" : "changed";
			},
		};
		const owner = game.world.spawn(StableIdentity(suppliedIdentity), Player);
		expect(identityReads).toBe(1);
		const ownerIdentity = owner.get(StableIdentity);
		expect(ownerIdentity).toEqual({ value: "reserved" });
		if (!ownerIdentity) {
			throw new Error("spawned owner must retain its stable identity");
		}
		expect(
			Object.getOwnPropertyDescriptor(ownerIdentity, "value")?.get,
		).toBeUndefined();

		const countWithOwner = game.world.query().length;
		expect(() =>
			game.world.spawn(StableIdentity({ value: "reserved" }), Collectible),
		).toThrow(/duplicate StableIdentity/u);
		expect(game.world.query()).toHaveLength(countWithOwner);

		const waiting = game.world.spawn(Player);
		expect(() => waiting.add(StableIdentity({ value: "reserved" }))).toThrow(
			/duplicate StableIdentity/u,
		);
		expect(waiting.has(StableIdentity)).toBe(false);

		owner.remove(StableIdentity);
		expect(() => waiting.add(StableIdentity({ value: "reserved" }))).toThrow(
			/duplicate StableIdentity/u,
		);
		expect(waiting.has(StableIdentity)).toBe(false);

		owner.destroy();
		expect(() =>
			waiting.add(StableIdentity({ value: "reserved" })),
		).not.toThrow();
		expect(waiting.get(StableIdentity)).toEqual({ value: "reserved" });
		expect(Object.isFrozen(waiting.get(StableIdentity))).toBe(true);
		expect(() =>
			waiting.set(StableIdentity, {
				value: new String("reserved") as never,
			}),
		).toThrow(/primitive non-empty string/u);
		expect(waiting.get(StableIdentity)).toEqual({ value: "reserved" });
		waiting.destroy();
		game.destroy();
	});

	it("keeps worlds and handle registries isolated", () => {
		const first = createGameWorld();
		const second = createGameWorld();
		first.world.spawn(StableIdentity({ value: "one" }), Player);
		first.handles.set("one", "render", { visible: true });
		expect(second.world.query(Player)).toHaveLength(0);
		expect(second.handles.size).toBe(0);
		first.destroy();
		second.destroy();
	});

	it("exports the complete Phase 04 trait set without function-valued facts", () => {
		for (const trait of Object.values(GameWorldTraits)) {
			expect(typeof trait).toBe("function");
		}
	});

	it("initializes every tag and AoS trait while dynamic Function is blocked", () => {
		const setup = fileURLToPath(
			new URL(
				"../fixtures/runtime/blocked-function-setup.mjs",
				import.meta.url,
			),
		);
		const engineUrl = new URL(
			"../../packages/engine/dist/index.js",
			import.meta.url,
		).href;
		const smoke = `
			import {
				createGameWorld,
				GameWorldTraits,
				StableIdentity,
			} from ${JSON.stringify(engineUrl)};
			const game = createGameWorld();
			const traits = Object.values(GameWorldTraits).filter(
				(trait) => trait !== StableIdentity,
			);
			const entity = game.world.spawn(
				StableIdentity({ value: "aot-smoke" }),
				...traits,
			);
			for (const trait of Object.values(GameWorldTraits)) {
				if (!entity.has(trait)) {
					throw new Error("spawned entity is missing an initialized Phase 04 trait");
				}
			}
			game.destroy();
		`;
		const result = spawnSync(
			process.execPath,
			["--import", setup, "--input-type=module", "--eval", smoke],
			{
				encoding: "utf8",
				env: { ...process.env, NO_COLOR: "1" },
			},
		);
		expect(
			result.status,
			`${result.stdout ?? ""}\n${result.stderr ?? ""}`,
		).toBe(0);
	});
});

describe("deterministic residency and snapshots", () => {
	it("uses sorted cells, look-ahead, hysteresis, and pinned residency", () => {
		const game = createGameWorld();
		const spawn = (
			id: string,
			x: number,
			band: number,
			pinned?: "player" | "attachment" | "objective",
		) => {
			const tags =
				pinned === "player"
					? [Player]
					: pinned === "attachment"
						? [Attachment]
						: pinned === "objective"
							? [ObjectiveCritical]
							: [];
			return game.world.spawn(
				StableIdentity({ value: id }),
				Position({ x, y: 0, z: 0 }),
				SizeBand({ index: band, requiredRadius: 0 }),
				Residency({ active: false, cellX: 0, cellZ: 0 }),
				...tags,
			);
		};
		spawn("z-near", 11, 0);
		spawn("a-edge", 13, 0);
		spawn("pinned-far", 999, 2, "objective");
		const first = applyResidencyToWorld(game.world, {
			bands: BANDS,
			cellSize: 8,
			focus: { position: { x: 0, y: 0, z: 0 }, velocity: { x: 4, y: 0, z: 0 } },
		});
		expect(first.activeIds).toEqual(["a-edge", "pinned-far", "z-near"]);
		expect([...first.cells.keys()]).toEqual(
			[...first.cells.keys()].sort(ordinalCompare),
		);
		const edge = game.world
			.query(StableIdentity, Residency)
			.find((entity) => entity.get(StableIdentity)?.value === "a-edge");
		expect(edge?.get(Residency)?.active).toBe(true);

		const second = applyResidencyToWorld(game.world, {
			bands: BANDS,
			cellSize: 8,
			focus: {
				position: { x: -1, y: 0, z: 0 },
				velocity: { x: 0, y: 0, z: 0 },
			},
		});
		expect(second.activeIds).toContain("a-edge");
		edge?.set(Position, { x: 17, y: 0, z: 0 });
		const third = applyResidencyToWorld(game.world, {
			bands: BANDS,
			cellSize: 8,
			focus: { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } },
		});
		expect(third.activeIds).not.toContain("a-edge");
		expect(third.activeIds).toContain("pinned-far");
		game.destroy();
	});

	it("processes every pinned kind without a SizeBand", () => {
		const game = createGameWorld();
		for (const [id, pinned] of [
			["attachment", Attachment],
			["objective", ObjectiveCritical],
			["player", Player],
		] as const) {
			game.world.spawn(
				StableIdentity({ value: id }),
				Position({ x: 999, y: 0, z: 0 }),
				Residency({ active: false, cellX: 0, cellZ: 0 }),
				pinned,
			);
		}

		const result = applyResidencyToWorld(game.world, {
			bands: BANDS,
			cellSize: 8,
			focus: { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } },
		});

		expect(result.activeIds).toEqual(["attachment", "objective", "player"]);
		expect(
			game.world
				.query(Residency)
				.filter(
					(entity) =>
						entity.has(Player) ||
						entity.has(Attachment) ||
						entity.has(ObjectiveCritical),
				)
				.every((entity) => entity.get(Residency)?.active === true),
		).toBe(true);
		game.destroy();
	});

	it("validates residency identities before sorting or mutating participants", () => {
		const world = createWorld();
		const valid = world.spawn(
			StableIdentity({ value: "valid" }),
			Position({ x: 0, y: 0, z: 0 }),
			SizeBand({ index: 0, requiredRadius: 0 }),
			Residency({ active: false, cellX: 0, cellZ: 0 }),
		);
		const invalid = world.spawn(
			StableIdentity({ value: "" }),
			Position({ x: 0, y: 0, z: 0 }),
			SizeBand({ index: 0, requiredRadius: 0 }),
			Residency({ active: false, cellX: 0, cellZ: 0 }),
		);
		world.spawn(
			StableIdentity({ value: "valid" }),
			Position({ x: 0, y: 0, z: 0 }),
			SizeBand({ index: 0, requiredRadius: 0 }),
			Residency({ active: false, cellX: 0, cellZ: 0 }),
		);
		const options = {
			bands: BANDS,
			cellSize: 8,
			focus: { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } },
		};

		expect(() => applyResidencyToWorld(world, options)).toThrow(/non-empty/u);
		expect(valid.get(Residency)?.active).toBe(false);

		invalid.destroy();
		expect(() => applyResidencyToWorld(world, options)).toThrow(/duplicate/u);
		expect(valid.get(Residency)?.active).toBe(false);
		world.destroy();
	});

	it("preflights residency bands and every numeric derivation transactionally", () => {
		const game = createGameWorld();
		const first = game.world.spawn(
			StableIdentity({ value: "a-valid" }),
			Position({ x: 0, y: 0, z: 0 }),
			SizeBand({ index: 0, requiredRadius: 0 }),
			Residency({ active: false, cellX: 7, cellZ: 8 }),
		);
		const invalid = game.world.spawn(
			StableIdentity({ value: "z-invalid" }),
			Position({ x: 0, y: 0, z: 0 }),
			SizeBand({ index: 99, requiredRadius: 0 }),
			Residency({ active: false, cellX: 9, cellZ: 10 }),
		);
		const firstResidency = first.get(Residency);
		const invalidResidency = invalid.get(Residency);
		if (!firstResidency || !invalidResidency) {
			throw new Error("residency fixtures must expose initial facts");
		}
		const initialFirst = { ...firstResidency };
		const initialInvalid = { ...invalidResidency };
		const baseOptions = {
			bands: BANDS,
			cellSize: 8,
			focus: {
				position: { x: 0, y: 0, z: 0 },
				velocity: { x: 0, y: 0, z: 0 },
			},
		};
		const expectResidencyUnchanged = () => {
			expect(first.get(Residency)).toEqual(initialFirst);
			expect(invalid.get(Residency)).toEqual(initialInvalid);
		};

		expect(() => applyResidencyToWorld(game.world, baseOptions)).toThrow(
			/size band.*range/u,
		);
		expectResidencyUnchanged();

		invalid.set(SizeBand, { index: 0.5, requiredRadius: 0 });
		expect(() => applyResidencyToWorld(game.world, baseOptions)).toThrow(
			/size band.*safe integer/u,
		);
		expectResidencyUnchanged();
		invalid.set(SizeBand, { index: 0, requiredRadius: 0 });

		expect(() =>
			applyResidencyToWorld(game.world, {
				...baseOptions,
				focus: {
					...baseOptions.focus,
					position: { x: 0, y: Number.NaN, z: 0 },
				},
			}),
		).toThrow(/focus\.position\.y must be finite/u);
		expectResidencyUnchanged();

		expect(() =>
			applyResidencyToWorld(game.world, {
				...baseOptions,
				focus: {
					...baseOptions.focus,
					velocity: { x: 0, y: Number.POSITIVE_INFINITY, z: 0 },
				},
			}),
		).toThrow(/focus\.velocity\.y must be finite/u);
		expectResidencyUnchanged();

		invalid.set(Position, {
			x: 0,
			y: Number.POSITIVE_INFINITY,
			z: 0,
		});
		expect(() => applyResidencyToWorld(game.world, baseOptions)).toThrow(
			/position\.y must be finite/u,
		);
		expectResidencyUnchanged();

		invalid.set(Position, { x: Number.MAX_VALUE, y: 0, z: 0 });
		expect(() =>
			applyResidencyToWorld(game.world, {
				...baseOptions,
				cellSize: Number.MIN_VALUE,
			}),
		).toThrow(/cellX.*safe integer/u);
		expectResidencyUnchanged();

		invalid.set(Position, { x: 0, y: 0, z: 0 });
		const overflowingPredictionBands = BANDS.map((band, index) =>
			index === 0 ? { ...band, lookAheadSeconds: 2 } : band,
		);
		expect(() =>
			applyResidencyToWorld(game.world, {
				...baseOptions,
				bands: overflowingPredictionBands,
				focus: {
					...baseOptions.focus,
					velocity: { x: Number.MAX_VALUE, y: 0, z: 0 },
				},
			}),
		).toThrow(/predictedX must be finite/u);
		expectResidencyUnchanged();

		invalid.set(Position, { x: Number.MAX_VALUE, y: 0, z: 0 });
		expect(() =>
			applyResidencyToWorld(game.world, {
				...baseOptions,
				cellSize: Number.MAX_VALUE,
				focus: {
					...baseOptions.focus,
					position: { x: -Number.MAX_VALUE, y: 0, z: 0 },
				},
			}),
		).toThrow(/distance must be finite/u);
		expectResidencyUnchanged();
		game.destroy();
	});

	it("stays deterministic when Koota swap-removes a participating entity", () => {
		const run = (withRemoval: boolean) => {
			const game = createGameWorld();
			const spawn = (id: string, x: number) =>
				game.world.spawn(
					StableIdentity({ value: id }),
					Position({ x, y: 0, z: 0 }),
					SizeBand({ index: 0, requiredRadius: 0 }),
					Residency({ active: false, cellX: 0, cellZ: 0 }),
				);
			if (withRemoval) {
				spawn("z", 1);
				const removed = spawn("removed", 2);
				spawn("a", 3);
				removed.destroy();
			} else {
				spawn("a", 3);
				spawn("z", 1);
			}
			const result = applyResidencyToWorld(game.world, {
				bands: BANDS,
				cellSize: 8,
				focus: {
					position: { x: 0, y: 0, z: 0 },
					velocity: { x: 0, y: 0, z: 0 },
				},
			});
			const comparable = {
				activeIds: result.activeIds,
				cells: [...result.cells],
				snapshotIds: createWorldSnapshot(game.world, 1).entities.map(
					(entity) => entity.id,
				),
			};
			game.destroy();
			return comparable;
		};

		expect(run(true)).toEqual(run(false));
	});

	it("emits immutable, ID-sorted, plain-data snapshots", () => {
		const game = createGameWorld();
		game.world.spawn(
			StableIdentity({ value: "z" }),
			Position({ x: 2, y: 0, z: 0 }),
			Player,
		);
		game.world.spawn(
			StableIdentity({ value: "a" }),
			Position({ x: 1, y: 0, z: 0 }),
			Collectible,
		);
		const snapshot = createWorldSnapshot(game.world, 7);
		expect(snapshot.tick).toBe(7);
		expect(snapshot.entities.map((entity) => entity.id)).toEqual([
			"a",
			"runtime:singleton",
			"z",
		]);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
		expect(JSON.stringify(snapshot)).not.toContain("function");
		game.destroy();
	});

	it("fails closed when snapshot-bearing entities lack StableIdentity", () => {
		const game = createGameWorld();
		game.world.spawn(Player);

		expect(() => createWorldSnapshot(game.world, 1)).toThrow(
			/snapshot entity.*StableIdentity/u,
		);
		game.destroy();
	});

	it("rejects every non-finite projected fact and preserves a full JSON round trip", () => {
		const game = createGameWorld();
		const entity = game.world.spawn(
			StableIdentity({ value: "all-facts" }),
			Position({ x: 1, y: 2, z: 3 }),
			SnowballFacts({ radius: 4, volume: 5, mass: 6, score: 7 }),
			ObjectiveFacts({ currentScore: 8, targetScore: 9, complete: false }),
			UiSnapshotFacts({ radius: 10, score: 11, objectiveProgress: 0.5 }),
			PackOwner({ packageName: "pack", packageVersion: "1.0.0" }),
			SizeBand({ index: 1, requiredRadius: 12 }),
			Residency({ active: true, cellX: 13, cellZ: 14 }),
			Requirements({ minimumRadius: 15, maximumRadius: 16 }),
			PhysicsHandleKey({ value: "physics" }),
			RenderHandleKey({ value: "render" }),
			Attachment({
				parentId: "parent",
				localPositionX: 17,
				localPositionY: 18,
				localPositionZ: 19,
				localRotationX: 20,
				localRotationY: 21,
				localRotationZ: 22,
				localRotationW: 23,
				localScaleX: 24,
				localScaleY: 25,
				localScaleZ: 26,
			}),
			Player,
			Collectible,
			LevelEntity,
			ObjectiveCritical,
		);
		const factGroups = [
			["position", entity.get(Position)],
			["snowball", entity.get(SnowballFacts)],
			["objective", entity.get(ObjectiveFacts)],
			["ui", entity.get(UiSnapshotFacts)],
			["sizeBand", entity.get(SizeBand)],
			["residency", entity.get(Residency)],
			["requirements", entity.get(Requirements)],
			["attachment", entity.get(Attachment)],
		] as const;
		const checkedFacts: string[] = [];

		for (const [group, facts] of factGroups) {
			expect(facts).toBeDefined();
			if (facts === undefined) continue;
			const mutableFacts = facts as unknown as Record<string, unknown>;
			for (const [key, original] of Object.entries(mutableFacts)) {
				if (typeof original !== "number") continue;
				const label = `${group}.${key}`;
				const invalidKind = checkedFacts.length % 3;
				mutableFacts[key] =
					invalidKind === 0
						? BigInt(1)
						: invalidKind === 1
							? Number.NaN
							: Number.POSITIVE_INFINITY;
				expect(() => createWorldSnapshot(game.world, 1)).toThrow(
					new RegExp(`${label} must be finite`, "u"),
				);
				mutableFacts[key] = original;
				checkedFacts.push(label);
			}
		}
		expect(checkedFacts).toEqual([
			"position.x",
			"position.y",
			"position.z",
			"snowball.radius",
			"snowball.volume",
			"snowball.mass",
			"snowball.score",
			"objective.currentScore",
			"objective.targetScore",
			"ui.radius",
			"ui.score",
			"ui.objectiveProgress",
			"sizeBand.index",
			"sizeBand.requiredRadius",
			"residency.cellX",
			"residency.cellZ",
			"requirements.minimumRadius",
			"requirements.maximumRadius",
			"attachment.localPositionX",
			"attachment.localPositionY",
			"attachment.localPositionZ",
			"attachment.localRotationX",
			"attachment.localRotationY",
			"attachment.localRotationZ",
			"attachment.localRotationW",
			"attachment.localScaleX",
			"attachment.localScaleY",
			"attachment.localScaleZ",
		]);
		expect(() => createWorldSnapshot(game.world, Number.NaN)).toThrow(
			/snapshot tick/u,
		);
		expect(() =>
			createWorldSnapshot(game.world, Number.POSITIVE_INFINITY),
		).toThrow(/snapshot tick/u);

		const snapshot = createWorldSnapshot(game.world, 2);
		expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
		game.destroy();
	});

	it("whitelists plain snapshot facts and validates every nonnumeric field", () => {
		const world = createWorld();
		const entity = world.spawn(
			StableIdentity({ value: "hostile" }),
			Position({ x: 1, y: 2, z: 3 }),
			ObjectiveFacts({ currentScore: 4, targetScore: 5, complete: false }),
			PackOwner({ packageName: "pack", packageVersion: "1.0.0" }),
			Residency({ active: true, cellX: 6, cellZ: 7 }),
			PhysicsHandleKey({ value: "physics" }),
			RenderHandleKey({ value: "render" }),
			Attachment({
				parentId: "parent",
				localPositionX: 8,
				localPositionY: 9,
				localPositionZ: 10,
				localRotationX: 11,
				localRotationY: 12,
				localRotationZ: 13,
				localRotationW: 14,
				localScaleX: 15,
				localScaleY: 16,
				localScaleZ: 17,
			}),
		);
		const invalidFacts = [
			["StableIdentity.value", entity.get(StableIdentity), "value", "hostile"],
			["objective.complete", entity.get(ObjectiveFacts), "complete", false],
			["packOwner.packageName", entity.get(PackOwner), "packageName", "pack"],
			[
				"packOwner.packageVersion",
				entity.get(PackOwner),
				"packageVersion",
				"1.0.0",
			],
			["residency.active", entity.get(Residency), "active", true],
			[
				"physicsHandleKey.value",
				entity.get(PhysicsHandleKey),
				"value",
				"physics",
			],
			["renderHandleKey.value", entity.get(RenderHandleKey), "value", "render"],
			["attachment.parentId", entity.get(Attachment), "parentId", "parent"],
		] as const;

		for (const [
			index,
			[label, facts, key, original],
		] of invalidFacts.entries()) {
			expect(facts).toBeDefined();
			if (facts === undefined) continue;
			const mutableFacts = facts as unknown as Record<string, unknown>;
			mutableFacts[key] =
				index % 3 === 0
					? new String("boxed")
					: index % 3 === 1
						? () => "function"
						: { nested: true };
			expect(() => createWorldSnapshot(world, 1)).toThrow(
				new RegExp(`${label} must be`, "u"),
			);
			mutableFacts[key] = original;
		}

		let numericReads = 0;
		let stringReads = 0;
		let booleanReads = 0;
		entity.set(Position, {
			get x() {
				numericReads += 1;
				return numericReads === 1 ? 1 : Number.POSITIVE_INFINITY;
			},
			y: 2,
			z: 3,
			extra: () => "must not escape",
		} as never);
		entity.set(PackOwner, {
			get packageName() {
				stringReads += 1;
				return stringReads === 1 ? "pack" : ({ bad: true } as never);
			},
			packageVersion: "1.0.0",
			extra: { bad: true },
		} as never);
		entity.set(ObjectiveFacts, {
			currentScore: 4,
			targetScore: 5,
			get complete() {
				booleanReads += 1;
				return booleanReads === 1 ? false : () => true as never;
			},
		} as never);
		(entity.get(Attachment) as unknown as Record<string, unknown>).extra = () =>
			"must not escape";

		const snapshot = createWorldSnapshot(world, 2);
		const projected = snapshot.entities.find(
			(candidate) => candidate.id === "hostile",
		);
		expect(numericReads).toBe(1);
		expect(stringReads).toBe(1);
		expect(booleanReads).toBe(1);
		expect(projected?.position).toEqual({ x: 1, y: 2, z: 3 });
		expect(projected?.packOwner).toEqual({
			packageName: "pack",
			packageVersion: "1.0.0",
		});
		expect(projected?.objective).toEqual({
			currentScore: 4,
			targetScore: 5,
			complete: false,
		});
		expect(
			Object.getOwnPropertyDescriptor(projected?.position ?? {}, "x")?.get,
		).toBeUndefined();
		expect(Object.getPrototypeOf(projected?.position ?? null)).toBe(
			Object.prototype,
		);
		expect(Object.isFrozen(projected?.position)).toBe(true);
		expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
		world.destroy();
	});

	it("projects immutable UI facts across initial, update, and reset snapshots", () => {
		const game = createGameWorld();
		const initialSingleton = game.world.query(RuntimeSingleton)[0];
		const initial = createWorldSnapshot(game.world, 0).entities.find(
			(entity) => entity.id === "runtime:singleton",
		);
		expect(initial?.ui).toEqual({
			radius: 1,
			score: 0,
			objectiveProgress: 0,
		});
		expect(Object.isFrozen(initial?.ui)).toBe(true);

		initialSingleton?.set(UiSnapshotFacts, {
			radius: 2.5,
			score: 125,
			objectiveProgress: 0.75,
		});
		const updated = createWorldSnapshot(game.world, 1).entities.find(
			(entity) => entity.id === "runtime:singleton",
		);
		expect(updated?.ui).toEqual({
			radius: 2.5,
			score: 125,
			objectiveProgress: 0.75,
		});
		expect(initial?.ui).toEqual({
			radius: 1,
			score: 0,
			objectiveProgress: 0,
		});

		game.reset();
		const reset = createWorldSnapshot(game.world, 0).entities.find(
			(entity) => entity.id === "runtime:singleton",
		);
		expect(reset?.ui).toEqual({
			radius: 1,
			score: 0,
			objectiveProgress: 0,
		});
		expect(Object.isFrozen(reset?.ui)).toBe(true);
		game.destroy();
	});

	it("rejects empty and duplicate snapshot identities instead of dropping or tying them", () => {
		const world = createWorld();
		const invalid = world.spawn(StableIdentity({ value: "" }), Player);
		world.spawn(StableIdentity({ value: "duplicate" }), Collectible);
		expect(() => createWorldSnapshot(world, 1)).toThrow(/non-empty/u);

		invalid.destroy();
		world.spawn(StableIdentity({ value: "duplicate" }), Player);
		expect(() => createWorldSnapshot(world, 1)).toThrow(/duplicate/u);
		world.destroy();
	});
});

describe("performance telemetry", () => {
	it("exports explicit conservative profile budgets", () => {
		expect(PERFORMANCE_BUDGETS.lowMobile).toMatchObject({
			frameP95Ms: 33.3,
			inputLatencyP95Ms: 50,
			drawCalls: 80,
			triangles: 150_000,
			activeBodies: 150,
			heapMb: 250,
		});
		expect(PERFORMANCE_BUDGETS.mid).toMatchObject({
			frameP95Ms: 20,
			inputLatencyP95Ms: FIXED_STEP_MS * 2,
			drawCalls: 140,
			triangles: 350_000,
			activeBodies: 350,
			heapMb: 400,
		});
		expect(PERFORMANCE_BUDGETS.high).toMatchObject({
			frameP95Ms: 16.7,
			inputLatencyP95Ms: FIXED_STEP_MS * 2,
			drawCalls: 220,
			triangles: 750_000,
			activeBodies: 750,
			heapMb: 700,
		});
		expect(PERFORMANCE_TRACE_LABELS).toEqual({
			frame: "infinite-snowball.frame",
			physics: "infinite-snowball.physics",
			input: "infinite-snowball.input",
			resource: "infinite-snowball.resource",
			draw: "infinite-snowball.draw",
			triangles: "infinite-snowball.triangles",
			bodies: "infinite-snowball.bodies",
			longTask: "infinite-snowball.long-task",
			lifecycle: "infinite-snowball.lifecycle",
		});
		expect(Object.isFrozen(PERFORMANCE_TRACE_LABELS)).toBe(true);
		for (const budget of Object.values(PERFORMANCE_BUDGETS)) {
			expect(budget.physicsP95Ms).toBeCloseTo(budget.frameP95Ms * 0.25, 6);
			expect(budget.longTaskMs).toBe(50);
		}
	});

	it("caps allocation and accepts only own literal profile names", () => {
		const atLimit = createPerformanceTelemetry(
			"lowMobile",
			MAX_TELEMETRY_SAMPLES,
		);
		atLimit.destroy();
		expect(() =>
			createPerformanceTelemetry("mid", MAX_TELEMETRY_SAMPLES + 1),
		).toThrow(/maxSamples.*at most/u);
		for (const profile of ["__proto__", "constructor", "toString", "unknown"]) {
			expect(() => createPerformanceTelemetry(profile as never, 1)).toThrow(
				/performance profile/u,
			);
		}
		const coercibleProfile = {
			[Symbol.toPrimitive]: () => "mid",
		};
		expect(() =>
			createPerformanceTelemetry(coercibleProfile as never, 1),
		).toThrow(/performance profile/u);
	});

	it("reads every telemetry getter exactly once before validation and storage", () => {
		const telemetry = createPerformanceTelemetry("mid", 2);
		const reads = Array.from({ length: 8 }, () => 0);
		const readOnce = (index: number, value: number) => {
			reads[index] = (reads[index] ?? 0) + 1;
			return reads[index] === 1 ? value : Number.NaN;
		};
		telemetry.record({
			get frameMs() {
				return readOnce(0, 10);
			},
			get physicsMs() {
				return readOnce(1, 2);
			},
			get inputLatencyMs() {
				return readOnce(2, 3);
			},
			get drawCalls() {
				return readOnce(3, 4);
			},
			get triangles() {
				return readOnce(4, 5);
			},
			get activeBodies() {
				return readOnce(5, 6);
			},
			get heapMb() {
				return readOnce(6, 7);
			},
			get longTaskMs() {
				return readOnce(7, 8);
			},
		});

		expect(reads).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
		expect(telemetry.snapshot()).toMatchObject({
			sampleCount: 1,
			frameMs: 10,
			physicsMs: 2,
			inputLatencyMs: 3,
			drawCalls: 4,
			triangles: 5,
			activeBodies: 6,
			heapMb: 7,
			longTaskMs: 8,
		});
	});

	it("keeps the per-frame telemetry record path on preallocated scalar buffers", () => {
		const source = createPerformanceTelemetry.toString();
		const recordStart = source.indexOf("record(sample)");
		const snapshotStart = source.indexOf("snapshot()", recordStart);
		expect(recordStart).toBeGreaterThanOrEqual(0);
		expect(snapshotStart).toBeGreaterThan(recordStart);
		const recordSource = source.slice(recordStart, snapshotStart);
		expect(recordSource).toContain("[cursor]");
		expect(recordSource).not.toMatch(
			/Object\.freeze|\.push\(|\.splice\(|\.\.\.sample|new\s+/u,
		);
	});

	it("bounds samples and reports frame, physics, input, resource, and long-task evidence", () => {
		const telemetry = createPerformanceTelemetry("mid", 3);
		for (const frameMs of [10, 12, 16, 13]) {
			telemetry.record({
				frameMs,
				physicsMs: 4,
				inputLatencyMs: 2,
				drawCalls: 40,
				triangles: 80_000,
				activeBodies: 75,
				heapMb: 120,
				longTaskMs: 0,
			});
		}
		const result = telemetry.snapshot();
		expect(result.sampleCount).toBe(3);
		expect(result.frameP95Ms).toBe(16);
		expect(result.physicsP95Ms).toBe(4);
		expect(result.inputLatencyP95Ms).toBe(2);
		expect(result.pass).toBe(true);
		telemetry.record({
			frameMs: 60,
			physicsMs: 20,
			inputLatencyMs: 30,
			drawCalls: 100,
			triangles: 200_000,
			activeBodies: 200,
			heapMb: 300,
			longTaskMs: 60,
		});
		expect(telemetry.snapshot().pass).toBe(false);
		telemetry.reset();
		expect(telemetry.snapshot()).toMatchObject({
			sampleCount: 0,
			pass: false,
		});
		telemetry.destroy();
		expect(telemetry.destroyed).toBe(true);
		expect(() => telemetry.snapshot()).toThrow(/destroyed/u);
	});

	it("uses maxima for hard-cap metrics while timing metrics retain p95 semantics", () => {
		const telemetry = createPerformanceTelemetry("mid", 64);
		for (let index = 0; index < 20; index += 1) {
			telemetry.record({
				frameMs: 10,
				physicsMs: 2,
				inputLatencyMs: 4,
				drawCalls: 40,
				triangles: 80_000,
				activeBodies: 75,
				heapMb: 120,
				longTaskMs: 0,
			});
		}
		telemetry.record({
			frameMs: 1_000,
			physicsMs: 1_000,
			inputLatencyMs: 1_000,
			drawCalls: PERFORMANCE_BUDGETS.mid.drawCalls + 1,
			triangles: PERFORMANCE_BUDGETS.mid.triangles + 1,
			activeBodies: PERFORMANCE_BUDGETS.mid.activeBodies + 1,
			heapMb: PERFORMANCE_BUDGETS.mid.heapMb + 1,
			longTaskMs: PERFORMANCE_BUDGETS.mid.longTaskMs + 1,
		});

		const result = telemetry.snapshot();
		expect(result).toMatchObject({
			frameP95Ms: 10,
			physicsP95Ms: 2,
			inputLatencyP95Ms: 4,
			drawCalls: PERFORMANCE_BUDGETS.mid.drawCalls + 1,
			triangles: PERFORMANCE_BUDGETS.mid.triangles + 1,
			activeBodies: PERFORMANCE_BUDGETS.mid.activeBodies + 1,
			heapMb: PERFORMANCE_BUDGETS.mid.heapMb + 1,
			longTaskMs: PERFORMANCE_BUDGETS.mid.longTaskMs + 1,
			pass: false,
		});
	});

	it("returns zero hard-cap evidence and fails when there are no samples", () => {
		const result = createPerformanceTelemetry("high").snapshot();
		expect(result).toMatchObject({
			sampleCount: 0,
			frameP95Ms: 0,
			physicsP95Ms: 0,
			inputLatencyP95Ms: 0,
			drawCalls: 0,
			triangles: 0,
			activeBodies: 0,
			heapMb: 0,
			longTaskMs: 0,
			pass: false,
		});
	});
});
