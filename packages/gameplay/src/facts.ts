import type { SnowballFacts, SnowballFactsOptions } from "./types.js";

function finiteNonNegative(value: number, label: string): number {
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`${label} must be a finite non-negative number`);
	}
	return value === 0 ? 0 : value;
}

function finitePositive(value: number, label: string): number {
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${label} must be a finite positive number`);
	}
	return value;
}

function safelyRepresentableF32(value: number, label: string): number {
	const converted = Math.fround(value);
	if (!Number.isFinite(converted) || (value !== 0 && converted === 0)) {
		throw new Error(`${label} must be finite and safely representable as f32`);
	}
	return value === 0 ? 0 : value;
}

export function createInitialSnowballFacts(
	options: SnowballFactsOptions = {},
): SnowballFacts {
	const radius = safelyRepresentableF32(
		finitePositive(options.radius ?? 1, "radius"),
		"radius",
	);
	const volume = finitePositive(radius ** 3, "volume");
	const mass = safelyRepresentableF32(
		finiteNonNegative(options.mass ?? 1, "mass"),
		"mass",
	);
	const score = finiteNonNegative(options.score ?? 0, "score");
	return Object.freeze({
		radius,
		volume,
		mass,
		score,
	});
}

export function restartSnowballFacts(
	_current: Readonly<SnowballFacts>,
	options: SnowballFactsOptions = {},
): SnowballFacts {
	return createInitialSnowballFacts(options);
}

export function growRadius(currentRadius: number, addedVolume: number): number {
	const radius = safelyRepresentableF32(
		finitePositive(currentRadius, "radius"),
		"radius",
	);
	const radiusVolume = finitePositive(radius ** 3, "radius volume");
	const added = finiteNonNegative(addedVolume, "added volume");
	const combinedVolume = finitePositive(
		radiusVolume + added,
		"combined volume",
	);
	if (added === 0) return radius;
	return safelyRepresentableF32(
		finitePositive(Math.cbrt(combinedVolume), "grown radius"),
		"grown radius",
	);
}
