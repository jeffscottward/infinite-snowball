interface ReadonlyVector3 {
	readonly x: number;
	readonly y: number;
	readonly z: number;
}

interface MutableVector3 {
	x: number;
	y: number;
	z: number;
}

interface MutableQuaternion extends MutableVector3 {
	w: number;
}

function requireFinite(value: number, label: string): number {
	if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
	return value;
}

export function requireFiniteF32(value: number, label: string): number {
	requireFinite(value, label);
	const rounded = Math.fround(value);
	if (!Number.isFinite(rounded)) {
		throw new Error(`${label} must fit the finite f32 range`);
	}
	if (value !== 0 && rounded === 0) {
		throw new Error(`${label} must not underflow the finite f32 range`);
	}
	return value === 0 ? 0 : value;
}

export function requirePositiveFiniteF32(value: number, label: string): number {
	const validated = requireFiniteF32(value, label);
	if (validated <= 0) throw new Error(`${label} must be positive`);
	return validated;
}

export function requireNonNegativeFiniteF32(
	value: number,
	label: string,
): number {
	const validated = requireFiniteF32(value, label);
	if (validated < 0) throw new Error(`${label} must be non-negative`);
	return validated;
}

export function setFiniteF32Vector3(
	output: MutableVector3,
	value: ReadonlyVector3,
	label: string,
): void {
	const x = requireFiniteF32(value.x, `${label}.x`);
	const y = requireFiniteF32(value.y, `${label}.y`);
	const z = requireFiniteF32(value.z, `${label}.z`);
	output.x = x;
	output.y = y;
	output.z = z;
}

export function setNormalizedFiniteQuaternion(
	output: MutableQuaternion,
	xValue: number,
	yValue: number,
	zValue: number,
	wValue: number,
	label: string,
): void {
	const x = requireFinite(xValue, `${label}.x`);
	const y = requireFinite(yValue, `${label}.y`);
	const z = requireFinite(zValue, `${label}.z`);
	const w = requireFinite(wValue, `${label}.w`);
	const scale = Math.max(Math.abs(x), Math.abs(y), Math.abs(z), Math.abs(w));
	if (scale === 0) throw new Error(`${label} must not be a zero quaternion`);

	const scaledX = x / scale;
	const scaledY = y / scale;
	const scaledZ = z / scale;
	const scaledW = w / scale;
	const magnitude = Math.hypot(scaledX, scaledY, scaledZ, scaledW);
	if (!Number.isFinite(magnitude) || magnitude === 0) {
		throw new Error(`${label} could not be normalized`);
	}
	const normalizedX = requireFiniteF32(scaledX / magnitude, `${label}.x`);
	const normalizedY = requireFiniteF32(scaledY / magnitude, `${label}.y`);
	const normalizedZ = requireFiniteF32(scaledZ / magnitude, `${label}.z`);
	const normalizedW = requireFiniteF32(scaledW / magnitude, `${label}.w`);
	output.x = normalizedX;
	output.y = normalizedY;
	output.z = normalizedZ;
	output.w = normalizedW;
}

export function interpolateFiniteF32(
	left: number,
	right: number,
	alpha: number,
	label: string,
): number {
	if (alpha === 0) return requireFiniteF32(left, label);
	if (alpha === 1) return requireFiniteF32(right, label);
	return requireFiniteF32(left * (1 - alpha) + right * alpha, label);
}
