import {
	interpolateFiniteF32,
	setFiniteF32Vector3,
	setNormalizedFiniteQuaternion,
} from "./rapier-scalar.js";

export interface TransformVector3 {
	readonly x: number;
	readonly y: number;
	readonly z: number;
}

export interface TransformQuaternion {
	readonly x: number;
	readonly y: number;
	readonly z: number;
	readonly w: number;
}

export interface PhysicsTransform {
	readonly id: string;
	readonly position: TransformVector3;
	readonly rotation: TransformQuaternion;
	readonly scale: TransformVector3;
}

export interface ReadonlyRigidBodyTransform {
	translation(): TransformVector3;
	rotation(): TransformQuaternion;
}

export interface TransformInterpolator {
	record(tick: number, transforms: readonly PhysicsTransform[]): void;
	forEachInterpolated(
		alpha: number,
		visitor: (transform: PhysicsTransform) => void,
	): number;
	sample(alpha: number): readonly PhysicsTransform[];
	reset(): void;
	destroy(): void;
	readonly destroyed: boolean;
}

interface TransformPair {
	readonly previous: PhysicsTransform;
	readonly current: PhysicsTransform;
}

interface MutableTransformVector3 {
	x: number;
	y: number;
	z: number;
}

interface MutableTransformQuaternion {
	x: number;
	y: number;
	z: number;
	w: number;
}

interface MutablePhysicsTransform {
	readonly id: string;
	readonly position: MutableTransformVector3;
	readonly rotation: MutableTransformQuaternion;
	readonly scale: MutableTransformVector3;
}

interface InterpolatedTransformSlot {
	readonly pair: TransformPair;
	readonly output: MutablePhysicsTransform;
}

function ordinal(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function vector(value: TransformVector3, label: string): TransformVector3 {
	const output = { x: 0, y: 0, z: 0 };
	setFiniteF32Vector3(output, value, label);
	return Object.freeze(output);
}

function quaternion(value: TransformQuaternion): TransformQuaternion {
	const output = { x: 0, y: 0, z: 0, w: 1 };
	setNormalizedFiniteQuaternion(
		output,
		value.x,
		value.y,
		value.z,
		value.w,
		"transform rotation",
	);
	return Object.freeze(output);
}

function copy(transform: PhysicsTransform): PhysicsTransform {
	if (transform.id.length === 0)
		throw new Error("transform ID must not be empty");
	return Object.freeze({
		id: transform.id,
		position: vector(transform.position, "transform position"),
		rotation: quaternion(transform.rotation),
		scale: vector(transform.scale, "transform scale"),
	});
}

function mutableCopy(transform: PhysicsTransform): MutablePhysicsTransform {
	return Object.freeze({
		id: transform.id,
		position: {
			x: transform.position.x,
			y: transform.position.y,
			z: transform.position.z,
		},
		rotation: {
			x: transform.rotation.x,
			y: transform.rotation.y,
			z: transform.rotation.z,
			w: transform.rotation.w,
		},
		scale: {
			x: transform.scale.x,
			y: transform.scale.y,
			z: transform.scale.z,
		},
	});
}

function interpolateVectorInPlace(
	output: MutableTransformVector3,
	left: TransformVector3,
	right: TransformVector3,
	alpha: number,
): void {
	output.x = interpolateFiniteF32(
		left.x,
		right.x,
		alpha,
		"interpolated vector.x",
	);
	output.y = interpolateFiniteF32(
		left.y,
		right.y,
		alpha,
		"interpolated vector.y",
	);
	output.z = interpolateFiniteF32(
		left.z,
		right.z,
		alpha,
		"interpolated vector.z",
	);
}

function interpolateQuaternionInPlace(
	output: MutableTransformQuaternion,
	left: TransformQuaternion,
	right: TransformQuaternion,
	alpha: number,
): void {
	if (alpha === 0) {
		output.x = left.x;
		output.y = left.y;
		output.z = left.z;
		output.w = left.w;
		return;
	}
	if (alpha === 1) {
		output.x = right.x;
		output.y = right.y;
		output.z = right.z;
		output.w = right.w;
		return;
	}
	const dot =
		left.x * right.x + left.y * right.y + left.z * right.z + left.w * right.w;
	const sign = dot < 0 ? -1 : 1;
	const x = interpolateFiniteF32(
		left.x,
		right.x * sign,
		alpha,
		"interpolated rotation.x",
	);
	const y = interpolateFiniteF32(
		left.y,
		right.y * sign,
		alpha,
		"interpolated rotation.y",
	);
	const z = interpolateFiniteF32(
		left.z,
		right.z * sign,
		alpha,
		"interpolated rotation.z",
	);
	const w = interpolateFiniteF32(
		left.w,
		right.w * sign,
		alpha,
		"interpolated rotation.w",
	);
	setNormalizedFiniteQuaternion(output, x, y, z, w, "interpolated rotation");
}

function requireInterpolationAlpha(alpha: number): void {
	if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
		throw new Error("interpolation alpha must be finite and in [0, 1]");
	}
}

export function captureRigidBodyTransform(
	id: string,
	body: ReadonlyRigidBodyTransform,
	scale: TransformVector3 = { x: 1, y: 1, z: 1 },
): PhysicsTransform {
	return copy({
		id,
		position: body.translation(),
		rotation: body.rotation(),
		scale,
	});
}

export function createTransformInterpolator(): TransformInterpolator {
	let pairs = new Map<string, TransformPair>();
	let outputsById = new Map<string, MutablePhysicsTransform>();
	let orderedSlots: readonly InterpolatedTransformSlot[] = [];
	let lastTick = -1;
	let destroyed = false;
	function assertAlive(): void {
		if (destroyed) throw new Error("transform interpolator is destroyed");
	}
	return {
		record(tick, transforms) {
			assertAlive();
			if (!Number.isSafeInteger(tick) || tick < 0 || tick <= lastTick) {
				throw new Error("transform tick must increase monotonically");
			}
			const next = new Map<string, TransformPair>();
			const nextOutputs = new Map<string, MutablePhysicsTransform>();
			for (const transform of transforms) {
				if (next.has(transform.id))
					throw new Error(`duplicate transform ID: ${transform.id}`);
				const current = copy(transform);
				const previous = pairs.get(transform.id)?.current ?? current;
				next.set(transform.id, Object.freeze({ previous, current }));
				nextOutputs.set(
					transform.id,
					outputsById.get(transform.id) ?? mutableCopy(current),
				);
			}
			pairs = next;
			outputsById = nextOutputs;
			orderedSlots = [...pairs.entries()]
				.sort(([left], [right]) => ordinal(left, right))
				.map(([id, pair]) =>
					Object.freeze({
						pair,
						output: outputsById.get(id) ?? mutableCopy(pair.current),
					}),
				);
			lastTick = tick;
		},
		forEachInterpolated(alpha, visitor) {
			assertAlive();
			requireInterpolationAlpha(alpha);
			for (const slot of orderedSlots) {
				interpolateVectorInPlace(
					slot.output.position,
					slot.pair.previous.position,
					slot.pair.current.position,
					alpha,
				);
				interpolateQuaternionInPlace(
					slot.output.rotation,
					slot.pair.previous.rotation,
					slot.pair.current.rotation,
					alpha,
				);
				interpolateVectorInPlace(
					slot.output.scale,
					slot.pair.previous.scale,
					slot.pair.current.scale,
					alpha,
				);
				visitor(slot.output);
			}
			return orderedSlots.length;
		},
		sample(alpha) {
			assertAlive();
			requireInterpolationAlpha(alpha);
			const result: PhysicsTransform[] = [];
			for (const slot of orderedSlots) {
				interpolateVectorInPlace(
					slot.output.position,
					slot.pair.previous.position,
					slot.pair.current.position,
					alpha,
				);
				interpolateQuaternionInPlace(
					slot.output.rotation,
					slot.pair.previous.rotation,
					slot.pair.current.rotation,
					alpha,
				);
				interpolateVectorInPlace(
					slot.output.scale,
					slot.pair.previous.scale,
					slot.pair.current.scale,
					alpha,
				);
				result.push(copy(slot.output));
			}
			return Object.freeze(result);
		},
		reset() {
			assertAlive();
			pairs.clear();
			outputsById.clear();
			orderedSlots = [];
			lastTick = -1;
		},
		destroy() {
			if (destroyed) return;
			pairs.clear();
			outputsById.clear();
			orderedSlots = [];
			lastTick = -1;
			destroyed = true;
		},
		get destroyed() {
			return destroyed;
		},
	};
}
