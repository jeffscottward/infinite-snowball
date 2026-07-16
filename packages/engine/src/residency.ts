import type { Entity, World } from "koota";

import {
	Attachment,
	ObjectiveCritical,
	Player,
	Position,
	Residency,
	SizeBand,
	StableIdentity,
} from "./ecs.js";
import { ordinalCompare } from "./scheduler.js";

export interface Vector3Data {
	readonly x: number;
	readonly y: number;
	readonly z: number;
}

export interface ResidencyBand {
	readonly id: string;
	readonly loadRadius: number;
	readonly unloadRadius: number;
	readonly lookAheadSeconds: number;
}

export interface ResidencyFocus {
	readonly position: Vector3Data;
	readonly velocity: Vector3Data;
}

export interface ResidencyOptions {
	readonly bands: readonly ResidencyBand[];
	readonly cellSize: number;
	readonly focus: ResidencyFocus;
}

export interface ResidencyResult {
	readonly activeIds: readonly string[];
	readonly cells: ReadonlyMap<string, readonly string[]>;
}

function requireFinite(value: number, label: string): void {
	if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

function requireFiniteVector(vector: Vector3Data, label: string): void {
	for (const axis of ["x", "y", "z"] as const) {
		requireFinite(vector[axis], `${label}.${axis}`);
	}
}

function validateOptions(options: ResidencyOptions): void {
	if (options.bands.length < 3) {
		throw new Error("residency requires at least three size bands");
	}
	if (!Number.isFinite(options.cellSize) || options.cellSize <= 0) {
		throw new Error("cellSize must be a finite positive number");
	}
	requireFiniteVector(options.focus.position, "focus.position");
	requireFiniteVector(options.focus.velocity, "focus.velocity");
	const ids = new Set<string>();
	for (const band of options.bands) {
		if (band.id.length === 0 || ids.has(band.id)) {
			throw new Error("residency band IDs must be unique and non-empty");
		}
		ids.add(band.id);
		for (const [label, value] of [
			["loadRadius", band.loadRadius],
			["unloadRadius", band.unloadRadius],
			["lookAheadSeconds", band.lookAheadSeconds],
		] as const) {
			requireFinite(value, label);
			if (value < 0) throw new Error(`${label} must be non-negative`);
		}
		if (band.unloadRadius <= band.loadRadius) {
			throw new Error("unloadRadius must be greater than loadRadius");
		}
	}
}

function cellCoordinates(
	position: Vector3Data,
	cellSize: number,
	entityId: string,
): Readonly<{ cellX: number; cellZ: number; key: string }> {
	const rawCellX = Math.floor(position.x / cellSize);
	const rawCellZ = Math.floor(position.z / cellSize);
	if (!Number.isSafeInteger(rawCellX)) {
		throw new Error(`entity ${entityId} cellX must be a safe integer`);
	}
	if (!Number.isSafeInteger(rawCellZ)) {
		throw new Error(`entity ${entityId} cellZ must be a safe integer`);
	}
	const cellX = Object.is(rawCellX, -0) ? 0 : rawCellX;
	const cellZ = Object.is(rawCellZ, -0) ? 0 : rawCellZ;
	return { cellX, cellZ, key: `${cellX}:${cellZ}` };
}

export function applyResidencyToWorld(
	world: World,
	options: ResidencyOptions,
): ResidencyResult {
	validateOptions(options);
	const entities = [...world.query(Position, Residency)].filter(
		(entity) =>
			entity.has(SizeBand) ||
			entity.has(Player) ||
			entity.has(Attachment) ||
			entity.has(ObjectiveCritical),
	);
	const stableIds = new Set<string>();
	for (const entity of entities) {
		const identity = entity.get(StableIdentity);
		if (identity === undefined || identity.value.length === 0) {
			throw new Error("residency StableIdentity values must be non-empty");
		}
		if (stableIds.has(identity.value)) {
			throw new Error(`duplicate residency StableIdentity: ${identity.value}`);
		}
		stableIds.add(identity.value);
	}
	entities.sort((left, right) =>
		ordinalCompare(
			left.get(StableIdentity)?.value ?? "",
			right.get(StableIdentity)?.value ?? "",
		),
	);

	const plans: {
		readonly entity: Entity;
		readonly active: boolean;
		readonly cellX: number;
		readonly cellZ: number;
	}[] = [];
	const unsortedCells = new Map<string, string[]>();
	const activeIds: string[] = [];

	for (const entity of entities) {
		const identity = entity.get(StableIdentity);
		const position = entity.get(Position);
		const sizeBand = entity.get(SizeBand);
		const residency = entity.get(Residency);
		if (
			identity === undefined ||
			position === undefined ||
			residency === undefined
		) {
			throw new Error("residency participant lost required facts");
		}
		requireFiniteVector(position, `entity ${identity.value} position`);

		const pinned =
			entity.has(Player) ||
			entity.has(Attachment) ||
			entity.has(ObjectiveCritical);
		let band: ResidencyBand | undefined;
		if (sizeBand !== undefined) {
			if (!Number.isSafeInteger(sizeBand.index)) {
				throw new Error(
					`entity ${identity.value} size band index must be a safe integer`,
				);
			}
			if (sizeBand.index < 0 || sizeBand.index >= options.bands.length) {
				throw new Error(
					`entity ${identity.value} size band index must be in range`,
				);
			}
			band = options.bands[sizeBand.index];
		} else if (!pinned) {
			throw new Error(`entity ${identity.value} has an unknown size band`);
		}

		const { cellX, cellZ, key } = cellCoordinates(
			position,
			options.cellSize,
			identity.value,
		);
		let active = true;
		if (!pinned) {
			if (band === undefined) {
				throw new Error(`entity ${identity.value} has an unknown size band`);
			}
			const predictedX =
				options.focus.position.x +
				options.focus.velocity.x * band.lookAheadSeconds;
			const predictedZ =
				options.focus.position.z +
				options.focus.velocity.z * band.lookAheadSeconds;
			requireFinite(predictedX, `entity ${identity.value} predictedX`);
			requireFinite(predictedZ, `entity ${identity.value} predictedZ`);
			const distance = Math.hypot(
				position.x - predictedX,
				position.z - predictedZ,
			);
			requireFinite(distance, `entity ${identity.value} distance`);
			active = residency.active
				? distance <= band.unloadRadius
				: distance <= band.loadRadius;
		}

		const ids = unsortedCells.get(key) ?? [];
		ids.push(identity.value);
		unsortedCells.set(key, ids);
		if (active) activeIds.push(identity.value);
		plans.push({ entity, active, cellX, cellZ });
	}

	const cells = new Map<string, readonly string[]>();
	for (const key of [...unsortedCells.keys()].sort(ordinalCompare)) {
		cells.set(
			key,
			Object.freeze([...(unsortedCells.get(key) ?? [])].sort(ordinalCompare)),
		);
	}
	const result = Object.freeze({
		activeIds: Object.freeze(activeIds.sort(ordinalCompare)),
		cells,
	});
	for (const plan of plans) {
		plan.entity.set(Residency, {
			active: plan.active,
			cellX: plan.cellX,
			cellZ: plan.cellZ,
		});
	}
	return result;
}
