import {
	type ConfigurableTrait,
	createWorld,
	type Entity,
	trait,
	type World,
} from "koota";

export const StableIdentity = trait(() => ({ value: "" }));
export const Position = trait(() => ({ x: 0, y: 0, z: 0 }));
export const Player = trait();
export const Collectible = trait();
export const LevelEntity = trait();
export const PackOwner = trait(() => ({
	packageName: "",
	packageVersion: "",
}));
export const Requirements = trait(() => ({
	minimumRadius: 0,
	maximumRadius: Number.MAX_SAFE_INTEGER,
}));
export const PhysicsHandleKey = trait(() => ({ value: "" }));
export const RenderHandleKey = trait(() => ({ value: "" }));
export const Attachment = trait(() => ({
	parentId: "",
	localPositionX: 0,
	localPositionY: 0,
	localPositionZ: 0,
	localRotationX: 0,
	localRotationY: 0,
	localRotationZ: 0,
	localRotationW: 1,
	localScaleX: 1,
	localScaleY: 1,
	localScaleZ: 1,
}));
export const ObjectiveCritical = trait();
export const RuntimeSingleton = trait();
export const SnowballFacts = trait(() => ({
	radius: 1,
	volume: 1,
	mass: 1,
	score: 0,
}));
export const ObjectiveFacts = trait(() => ({
	currentScore: 0,
	targetScore: 0,
	complete: false,
}));
export const SizeBand = trait(() => ({
	index: 0,
	requiredRadius: 0,
}));
export const Residency = trait(() => ({
	active: false,
	cellX: 0,
	cellZ: 0,
}));
export const UiSnapshotFacts = trait(() => ({
	radius: 1,
	score: 0,
	objectiveProgress: 0,
}));

export const GameWorldTraits = Object.freeze({
	StableIdentity,
	Position,
	Player,
	Collectible,
	LevelEntity,
	PackOwner,
	Requirements,
	PhysicsHandleKey,
	RenderHandleKey,
	Attachment,
	ObjectiveCritical,
	RuntimeSingleton,
	SnowballFacts,
	ObjectiveFacts,
	SizeBand,
	Residency,
	UiSnapshotFacts,
});

export type HandleKind = "physics" | "render" | "audio" | "camera";

const HANDLE_KINDS = Object.freeze([
	"physics",
	"render",
	"audio",
	"camera",
] as const satisfies readonly HandleKind[]);

export interface WorldHandleRegistry {
	set(stableId: string, kind: HandleKind, handle: unknown): void;
	get(stableId: string, kind: HandleKind): unknown;
	delete(stableId: string, kind?: HandleKind): boolean;
	clear(): void;
	reset(): void;
	destroy(): void;
	readonly destroyed: boolean;
	readonly size: number;
}

function isStableId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function handleKey(stableId: string, kind: HandleKind): string {
	if (!isStableId(stableId)) {
		throw new Error("stable ID must be a primitive non-empty string");
	}
	return `${stableId}\u0000${kind}`;
}

export function createWorldHandleRegistry(): WorldHandleRegistry {
	const handles = new Map<string, unknown>();
	let destroyed = false;

	function assertAlive(): void {
		if (destroyed) throw new Error("world handle registry is destroyed");
	}
	return {
		set(stableId, kind, handle) {
			assertAlive();
			handles.set(handleKey(stableId, kind), handle);
		},
		get(stableId, kind) {
			assertAlive();
			return handles.get(handleKey(stableId, kind));
		},
		delete(stableId, kind) {
			assertAlive();
			if (kind !== undefined) return handles.delete(handleKey(stableId, kind));
			let deleted = false;
			for (const handleKind of HANDLE_KINDS) {
				if (handles.delete(handleKey(stableId, handleKind))) deleted = true;
			}
			return deleted;
		},
		clear() {
			assertAlive();
			handles.clear();
		},
		reset() {
			assertAlive();
			handles.clear();
		},
		destroy() {
			if (destroyed) return;
			handles.clear();
			destroyed = true;
		},
		get destroyed() {
			return destroyed;
		},
		get size() {
			return handles.size;
		},
	};
}

export interface GameWorld {
	readonly world: World;
	readonly handles: WorldHandleRegistry;
	reset(): void;
	destroy(): void;
	readonly destroyed: boolean;
}

export function createGameWorld(): GameWorld {
	const world = createWorld();
	const handles = createWorldHandleRegistry();
	const stableIds = new Map<Entity, string>();
	const entitiesByStableId = new Map<string, Entity>();
	const originalSpawn = world.spawn.bind(world);
	let destroyed = false;

	function activeOwner(stableId: string): Entity | undefined {
		const owner = entitiesByStableId.get(stableId);
		if (owner === undefined || world.has(owner)) return owner;
		entitiesByStableId.delete(stableId);
		stableIds.delete(owner);
		return undefined;
	}

	function restoreStableIdentity(
		entity: Entity,
		stableId: string,
		message: string,
	): never {
		entity.set(StableIdentity, Object.freeze({ value: stableId }), false);
		throw new Error(message);
	}

	function subscribeStableIdentityLifecycle(): () => void {
		const unsubscribeAdd = world.onAdd(StableIdentity, (entity) => {
			const stableId = stableIds.get(entity);
			const identity = entity.get(StableIdentity);
			let value: unknown;
			try {
				value = identity?.value;
			} catch {
				if (stableId !== undefined) {
					restoreStableIdentity(
						entity,
						stableId,
						"StableIdentity must be a primitive non-empty string",
					);
				}
				entity.remove(StableIdentity);
				throw new Error("StableIdentity must be a primitive non-empty string");
			}

			if (stableId !== undefined) {
				if (!isStableId(value)) {
					restoreStableIdentity(
						entity,
						stableId,
						"StableIdentity must be a primitive non-empty string",
					);
				}
				if (value !== stableId) {
					restoreStableIdentity(
						entity,
						stableId,
						"StableIdentity is immutable after entity creation",
					);
				}
				entity.set(StableIdentity, Object.freeze({ value: stableId }), false);
				return;
			}

			if (!isStableId(value)) {
				entity.remove(StableIdentity);
				throw new Error("StableIdentity must be a primitive non-empty string");
			}
			const owner = activeOwner(value);
			if (owner !== undefined && owner !== entity) {
				entity.remove(StableIdentity);
				throw new Error(`duplicate StableIdentity: ${value}`);
			}
			entity.set(StableIdentity, Object.freeze({ value }), false);
			stableIds.set(entity, value);
			entitiesByStableId.set(value, entity);
		});

		const unsubscribeChange = world.onChange(StableIdentity, (entity) => {
			const stableId = stableIds.get(entity);
			const identity = entity.get(StableIdentity);
			let value: unknown;
			try {
				value = identity?.value;
			} catch {
				if (stableId !== undefined) {
					restoreStableIdentity(
						entity,
						stableId,
						"StableIdentity must be a primitive non-empty string",
					);
				}
				entity.remove(StableIdentity);
				throw new Error("StableIdentity must be a primitive non-empty string");
			}

			if (stableId !== undefined) {
				if (!isStableId(value)) {
					restoreStableIdentity(
						entity,
						stableId,
						"StableIdentity must be a primitive non-empty string",
					);
				}
				if (value !== stableId) {
					restoreStableIdentity(
						entity,
						stableId,
						"StableIdentity is immutable after entity creation",
					);
				}
				entity.set(StableIdentity, Object.freeze({ value: stableId }), false);
				return;
			}

			if (!isStableId(value)) {
				entity.remove(StableIdentity);
				throw new Error("StableIdentity must be a primitive non-empty string");
			}
			const owner = activeOwner(value);
			if (owner !== undefined && owner !== entity) {
				entity.remove(StableIdentity);
				throw new Error(`duplicate StableIdentity: ${value}`);
			}
			entity.set(StableIdentity, Object.freeze({ value }), false);
			stableIds.set(entity, value);
			entitiesByStableId.set(value, entity);
		});

		const unsubscribeRemove = world.onRemove(StableIdentity, (entity) => {
			const stableId = stableIds.get(entity);
			if (stableId !== undefined) handles.delete(stableId);
			queueMicrotask(() => {
				if (destroyed || world.has(entity)) return;
				stableIds.delete(entity);
				if (
					stableId !== undefined &&
					entitiesByStableId.get(stableId) === entity
				) {
					entitiesByStableId.delete(stableId);
				}
			});
		});

		return () => {
			unsubscribeAdd();
			unsubscribeChange();
			unsubscribeRemove();
			stableIds.clear();
			entitiesByStableId.clear();
		};
	}

	world.spawn = (...traits: ConfigurableTrait[]): Entity => {
		let identityIndex = -1;
		let identityValue: string | undefined;
		const sanitizedTraits = [...traits];
		for (let index = 0; index < traits.length; index += 1) {
			const config = traits[index];
			const configuredTrait = Array.isArray(config) ? config[0] : config;
			if (configuredTrait !== StableIdentity) continue;
			if (identityIndex !== -1) {
				throw new Error("entity creation accepts one StableIdentity");
			}
			const params = Array.isArray(config) ? config[1] : undefined;
			let value: unknown;
			try {
				value = (params as { readonly value?: unknown } | undefined)?.value;
			} catch {
				throw new Error("StableIdentity must be a primitive non-empty string");
			}
			if (!isStableId(value)) {
				throw new Error("StableIdentity must be a primitive non-empty string");
			}
			const owner = activeOwner(value);
			if (owner !== undefined) {
				throw new Error(`duplicate StableIdentity: ${value}`);
			}
			identityIndex = index;
			identityValue = value;
		}
		if (identityIndex !== -1 && identityValue !== undefined) {
			sanitizedTraits[identityIndex] = StableIdentity(
				Object.freeze({ value: identityValue }),
			);
		}
		return originalSpawn(...sanitizedTraits);
	};

	function bootstrapSingleton(): void {
		world.spawn(
			StableIdentity({ value: "runtime:singleton" }),
			RuntimeSingleton,
			ObjectiveFacts,
			UiSnapshotFacts,
		);
	}

	let unsubscribeStableIdentityLifecycle = subscribeStableIdentityLifecycle();
	bootstrapSingleton();

	function assertAlive(): void {
		if (destroyed) throw new Error("game world is destroyed");
	}

	return {
		world,
		handles,
		reset() {
			assertAlive();
			unsubscribeStableIdentityLifecycle();
			world.reset();
			handles.reset();
			unsubscribeStableIdentityLifecycle = subscribeStableIdentityLifecycle();
			bootstrapSingleton();
		},
		destroy() {
			if (destroyed) return;
			unsubscribeStableIdentityLifecycle();
			handles.destroy();
			world.destroy();
			destroyed = true;
		},
		get destroyed() {
			return destroyed;
		},
	};
}
