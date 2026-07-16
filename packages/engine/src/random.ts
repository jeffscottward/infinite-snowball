export interface SeededRandom {
	nextUint32(): number;
	nextFloat(): number;
	reset(seed?: number): void;
}

function normalizeSeed(seed: number): number {
	if (!Number.isSafeInteger(seed))
		throw new Error("seed must be a safe integer");
	return seed >>> 0;
}

export function createSeededRandom(initialSeed: number): SeededRandom {
	const normalizedInitialSeed = normalizeSeed(initialSeed);
	let state = normalizedInitialSeed;

	function nextUint32(): number {
		state = (state + 0x6d2b_79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return (value ^ (value >>> 14)) >>> 0;
	}

	return {
		nextUint32,
		nextFloat() {
			return nextUint32() / 0x1_0000_0000;
		},
		reset(seed = normalizedInitialSeed) {
			state = normalizeSeed(seed);
		},
	};
}
