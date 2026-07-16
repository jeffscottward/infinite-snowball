import type { Entity, World } from "koota";

import {
	Attachment,
	Collectible,
	LevelEntity,
	ObjectiveCritical,
	ObjectiveFacts,
	PackOwner,
	PhysicsHandleKey,
	Player,
	Position,
	RenderHandleKey,
	Requirements,
	Residency,
	RuntimeSingleton,
	SizeBand,
	SnowballFacts,
	StableIdentity,
	UiSnapshotFacts,
} from "./ecs.js";
import { ordinalCompare } from "./scheduler.js";

export interface WorldEntitySnapshot {
	readonly id: string;
	readonly position?: Readonly<{ x: number; y: number; z: number }>;
	readonly snowball?: Readonly<{
		radius: number;
		volume: number;
		mass: number;
		score: number;
	}>;
	readonly objective?: Readonly<{
		currentScore: number;
		targetScore: number;
		complete: boolean;
	}>;
	readonly ui?: Readonly<{
		radius: number;
		score: number;
		objectiveProgress: number;
	}>;
	readonly packOwner?: Readonly<{
		packageName: string;
		packageVersion: string;
	}>;
	readonly sizeBand?: Readonly<{ index: number; requiredRadius: number }>;
	readonly residency?: Readonly<{
		active: boolean;
		cellX: number;
		cellZ: number;
	}>;
	readonly requirements?: Readonly<{
		minimumRadius: number;
		maximumRadius: number;
	}>;
	readonly physicsHandleKey?: string;
	readonly renderHandleKey?: string;
	readonly attachment?: Readonly<{
		parentId: string;
		localPosition: Readonly<{ x: number; y: number; z: number }>;
		localRotation: Readonly<{ x: number; y: number; z: number; w: number }>;
		localScale: Readonly<{ x: number; y: number; z: number }>;
	}>;
	readonly tags: readonly string[];
}

export interface WorldSnapshot {
	readonly tick: number;
	readonly entities: readonly WorldEntitySnapshot[];
}

function tagsFor(entity: Entity): readonly string[] {
	const tags: string[] = [];
	for (const [name, tag] of [
		["attachment", Attachment],
		["collectible", Collectible],
		["level", LevelEntity],
		["objective-critical", ObjectiveCritical],
		["player", Player],
		["runtime-singleton", RuntimeSingleton],
	] as const) {
		if (entity.has(tag)) tags.push(name);
	}
	return Object.freeze(tags.sort(ordinalCompare));
}

function isSnapshotEligible(entity: Entity): boolean {
	return (
		entity.has(StableIdentity) ||
		entity.has(Position) ||
		entity.has(SnowballFacts) ||
		entity.has(ObjectiveFacts) ||
		entity.has(UiSnapshotFacts) ||
		entity.has(PackOwner) ||
		entity.has(SizeBand) ||
		entity.has(Residency) ||
		entity.has(Requirements) ||
		entity.has(PhysicsHandleKey) ||
		entity.has(RenderHandleKey) ||
		entity.has(Attachment) ||
		entity.has(Collectible) ||
		entity.has(LevelEntity) ||
		entity.has(ObjectiveCritical) ||
		entity.has(Player) ||
		entity.has(RuntimeSingleton)
	);
}

type PlainFactKind = "number" | "string" | "boolean";

const FACT_SCHEMAS = {
	position: [
		["x", "number"],
		["y", "number"],
		["z", "number"],
	],
	snowball: [
		["radius", "number"],
		["volume", "number"],
		["mass", "number"],
		["score", "number"],
	],
	objective: [
		["currentScore", "number"],
		["targetScore", "number"],
		["complete", "boolean"],
	],
	ui: [
		["radius", "number"],
		["score", "number"],
		["objectiveProgress", "number"],
	],
	packOwner: [
		["packageName", "string"],
		["packageVersion", "string"],
	],
	sizeBand: [
		["index", "number"],
		["requiredRadius", "number"],
	],
	residency: [
		["active", "boolean"],
		["cellX", "number"],
		["cellZ", "number"],
	],
	requirements: [
		["minimumRadius", "number"],
		["maximumRadius", "number"],
	],
	handleKey: [["value", "string"]],
	attachment: [
		["parentId", "string"],
		["localPositionX", "number"],
		["localPositionY", "number"],
		["localPositionZ", "number"],
		["localRotationX", "number"],
		["localRotationY", "number"],
		["localRotationZ", "number"],
		["localRotationW", "number"],
		["localScaleX", "number"],
		["localScaleY", "number"],
		["localScaleZ", "number"],
	],
} as const satisfies Record<
	string,
	readonly (readonly [string, PlainFactKind])[]
>;

function projectPlainFacts<T extends object>(
	label: string,
	facts: T | undefined,
	schema: readonly (readonly [keyof T & string, PlainFactKind])[],
): T | undefined {
	if (facts === undefined) return undefined;
	const source = facts as unknown as Record<string, unknown>;
	const projected: Record<string, unknown> = {};
	for (const [key, kind] of schema) {
		let value: unknown;
		try {
			value = source[key];
		} catch {
			throw new Error(`${label}.${key} must be ${kind}`);
		}
		if (kind === "number") {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw new Error(`${label}.${key} must be finite`);
			}
			projected[key] = Object.is(value, -0) ? 0 : value;
		} else if (kind === "string") {
			if (typeof value !== "string") {
				throw new Error(`${label}.${key} must be a primitive string`);
			}
			projected[key] = value;
		} else {
			if (typeof value !== "boolean") {
				throw new Error(`${label}.${key} must be boolean`);
			}
			projected[key] = value;
		}
	}
	return Object.freeze(projected) as unknown as T;
}

export function createWorldSnapshot(world: World, tick: number): WorldSnapshot {
	if (!Number.isSafeInteger(tick) || tick < 0) {
		throw new Error("snapshot tick must be a non-negative safe integer");
	}
	const snapshotEntities = [...world.query()].filter(isSnapshotEligible);
	const idsByEntity = new Map<Entity, string>();
	const stableIds = new Set<string>();
	for (const entity of snapshotEntities) {
		const identity = entity.get(StableIdentity);
		let stableId: unknown;
		try {
			stableId = identity?.value;
		} catch {
			throw new Error("StableIdentity.value must be a primitive string");
		}
		if (identity === undefined) {
			throw new Error("snapshot entity is missing StableIdentity");
		}
		if (typeof stableId !== "string") {
			throw new Error("StableIdentity.value must be a primitive string");
		}
		if (stableId.length === 0) {
			throw new Error("snapshot StableIdentity values must be non-empty");
		}
		if (stableIds.has(stableId)) {
			throw new Error(`duplicate snapshot StableIdentity: ${stableId}`);
		}
		stableIds.add(stableId);
		idsByEntity.set(entity, stableId);
	}
	const entities = snapshotEntities
		.map((entity): WorldEntitySnapshot => {
			const stableId = idsByEntity.get(entity);
			if (stableId === undefined) {
				throw new Error("snapshot entity lost its StableIdentity");
			}
			const position = projectPlainFacts(
				"position",
				entity.get(Position),
				FACT_SCHEMAS.position,
			);
			const snowball = projectPlainFacts(
				"snowball",
				entity.get(SnowballFacts),
				FACT_SCHEMAS.snowball,
			);
			const objective = projectPlainFacts(
				"objective",
				entity.get(ObjectiveFacts),
				FACT_SCHEMAS.objective,
			);
			const ui = projectPlainFacts(
				"ui",
				entity.get(UiSnapshotFacts),
				FACT_SCHEMAS.ui,
			);
			const owner = projectPlainFacts(
				"packOwner",
				entity.get(PackOwner),
				FACT_SCHEMAS.packOwner,
			);
			const band = projectPlainFacts(
				"sizeBand",
				entity.get(SizeBand),
				FACT_SCHEMAS.sizeBand,
			);
			const residency = projectPlainFacts(
				"residency",
				entity.get(Residency),
				FACT_SCHEMAS.residency,
			);
			const requirements = projectPlainFacts(
				"requirements",
				entity.get(Requirements),
				FACT_SCHEMAS.requirements,
			);
			const physicsHandleKey = projectPlainFacts(
				"physicsHandleKey",
				entity.get(PhysicsHandleKey),
				FACT_SCHEMAS.handleKey,
			);
			const renderHandleKey = projectPlainFacts(
				"renderHandleKey",
				entity.get(RenderHandleKey),
				FACT_SCHEMAS.handleKey,
			);
			const attachment = projectPlainFacts(
				"attachment",
				entity.get(Attachment),
				FACT_SCHEMAS.attachment,
			);
			return Object.freeze({
				id: stableId,
				...(position === undefined ? {} : { position }),
				...(snowball === undefined ? {} : { snowball }),
				...(objective === undefined ? {} : { objective }),
				...(ui === undefined ? {} : { ui }),
				...(owner === undefined ? {} : { packOwner: owner }),
				...(band === undefined ? {} : { sizeBand: band }),
				...(residency === undefined ? {} : { residency }),
				...(requirements === undefined ? {} : { requirements }),
				...(physicsHandleKey === undefined
					? {}
					: { physicsHandleKey: physicsHandleKey.value }),
				...(renderHandleKey === undefined
					? {}
					: { renderHandleKey: renderHandleKey.value }),
				...(attachment === undefined
					? {}
					: {
							attachment: Object.freeze({
								parentId: attachment.parentId,
								localPosition: Object.freeze({
									x: attachment.localPositionX,
									y: attachment.localPositionY,
									z: attachment.localPositionZ,
								}),
								localRotation: Object.freeze({
									x: attachment.localRotationX,
									y: attachment.localRotationY,
									z: attachment.localRotationZ,
									w: attachment.localRotationW,
								}),
								localScale: Object.freeze({
									x: attachment.localScaleX,
									y: attachment.localScaleY,
									z: attachment.localScaleZ,
								}),
							}),
						}),
				tags: tagsFor(entity),
			});
		})
		.sort((left, right) => ordinalCompare(left.id, right.id));
	const snapshotTick = Object.is(tick, -0) ? 0 : tick;
	return Object.freeze({
		tick: snapshotTick,
		entities: Object.freeze(entities),
	});
}
