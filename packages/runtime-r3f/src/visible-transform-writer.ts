import type { Object3D } from "three";
import { Quaternion, Vector3 } from "three";
import {
	setFiniteF32Vector3,
	setNormalizedFiniteQuaternion,
} from "./rapier-scalar.js";
import type { PhysicsTransform, TransformInterpolator } from "./transforms.js";

export interface VisibleTransformWriter {
	bind(stableId: string, object: Object3D): void;
	unbind(stableId: string): boolean;
	write(tick: number, transforms: readonly PhysicsTransform[]): number;
	writeInterpolated(
		tick: number,
		interpolator: TransformInterpolator,
		alpha: number,
	): number;
	reset(): void;
	destroy(): void;
	readonly size: number;
}

function ordinal(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

interface StagedVisibleTransform {
	object: Object3D | undefined;
	readonly position: Vector3;
	readonly rotation: Quaternion;
	readonly scale: Vector3;
}

export function createVisibleTransformWriter(): VisibleTransformWriter {
	const objects = new Map<string, Object3D>();
	let objectOwners = new WeakMap<Object3D, string>();
	const stagedTransforms: StagedVisibleTransform[] = [];
	let lastTick = -1;
	let destroyed = false;

	function assertAlive(): void {
		if (destroyed) throw new Error("visible transform writer is destroyed");
	}

	function validateTick(tick: number): void {
		if (!Number.isSafeInteger(tick) || tick < 0 || tick < lastTick) {
			throw new Error("visible transform tick must not regress");
		}
	}

	function stageTransform(
		index: number,
		transform: PhysicsTransform,
		previousId: string | undefined,
	): string {
		if (transform.id.length === 0) {
			throw new Error("visible transform stable ID must not be empty");
		}
		if (previousId !== undefined && ordinal(previousId, transform.id) >= 0) {
			throw new Error(
				"visible transforms must be strictly sorted by stable ID",
			);
		}
		let slot = stagedTransforms[index];
		if (slot === undefined) {
			slot = {
				object: undefined,
				position: new Vector3(),
				rotation: new Quaternion(),
				scale: new Vector3(),
			};
			stagedTransforms.push(slot);
		}
		setFiniteF32Vector3(
			slot.position,
			transform.position,
			"visible transform position",
		);
		setNormalizedFiniteQuaternion(
			slot.rotation,
			transform.rotation.x,
			transform.rotation.y,
			transform.rotation.z,
			transform.rotation.w,
			"visible transform rotation",
		);
		setFiniteF32Vector3(slot.scale, transform.scale, "visible transform scale");
		slot.object = objects.get(transform.id);
		return transform.id;
	}

	function writeStaged(count: number): number {
		let writes = 0;
		for (let index = 0; index < count; index += 1) {
			const slot = stagedTransforms[index];
			const object = slot?.object;
			if (slot === undefined || object === undefined) continue;
			object.position.copy(slot.position);
			object.quaternion.copy(slot.rotation);
			object.scale.copy(slot.scale);
			object.updateMatrix();
			writes += 1;
		}
		return writes;
	}

	const writer: VisibleTransformWriter = {
		bind(stableId, object) {
			assertAlive();
			if (stableId.length === 0) {
				throw new Error("visible object stable ID must not be empty");
			}
			if (objects.has(stableId)) {
				throw new Error(`duplicate visible object stable ID: ${stableId}`);
			}
			const owner = objectOwners.get(object);
			if (owner !== undefined) {
				throw new Error(
					`visible object is already owned by stable ID: ${owner}`,
				);
			}
			objects.set(stableId, object);
			objectOwners.set(object, stableId);
		},
		unbind(stableId) {
			assertAlive();
			const object = objects.get(stableId);
			if (object === undefined) return false;
			objects.delete(stableId);
			objectOwners.delete(object);
			for (const slot of stagedTransforms) {
				if (slot.object === object) slot.object = undefined;
			}
			return true;
		},
		write(tick, transforms) {
			assertAlive();
			validateTick(tick);
			let previousId: string | undefined;
			for (let index = 0; index < transforms.length; index += 1) {
				const transform = transforms[index];
				if (transform === undefined) {
					throw new Error("visible transform entry must be defined");
				}
				previousId = stageTransform(index, transform, previousId);
			}
			const writes = writeStaged(transforms.length);
			lastTick = tick;
			return writes;
		},
		writeInterpolated(tick, interpolator, alpha) {
			assertAlive();
			validateTick(tick);
			let count = 0;
			let previousId: string | undefined;
			interpolator.forEachInterpolated(alpha, (transform) => {
				previousId = stageTransform(count, transform, previousId);
				count += 1;
			});
			const writes = writeStaged(count);
			lastTick = tick;
			return writes;
		},
		reset() {
			assertAlive();
			objects.clear();
			objectOwners = new WeakMap<Object3D, string>();
			stagedTransforms.length = 0;
			lastTick = -1;
		},
		destroy() {
			if (destroyed) return;
			objects.clear();
			objectOwners = new WeakMap<Object3D, string>();
			stagedTransforms.length = 0;
			destroyed = true;
		},
		get size() {
			return objects.size;
		},
	};
	return Object.freeze(writer);
}
