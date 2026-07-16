export const SIMULATION_HZ = 60;
export const FIXED_STEP_SECONDS = 1 / SIMULATION_HZ;
export const FIXED_STEP_MS = 1_000 / SIMULATION_HZ;
export const MAX_CATCH_UP_TICKS = 4;

export interface SimulationTick {
	readonly tick: number;
	readonly deltaSeconds: number;
	readonly simulationTimeSeconds: number;
	readonly timestampMs: number;
}

export interface FixedStepAdvance {
	readonly ticks: readonly SimulationTick[];
	readonly alpha: number;
	readonly droppedTicks: number;
}

export interface FixedStepClock {
	advance(timestampMs: number, hidden: boolean): FixedStepAdvance;
	reset(): void;
	destroy(): void;
	readonly tick: number;
}

const EMPTY_ADVANCE: FixedStepAdvance = Object.freeze({
	ticks: Object.freeze([]),
	alpha: 0,
	droppedTicks: 0,
});

const TICK_EPSILON_MS = Number.EPSILON * FIXED_STEP_MS * 4;

function requireTimestamp(timestampMs: number): void {
	if (!Number.isFinite(timestampMs) || timestampMs < 0) {
		throw new Error(
			"timestampMs must be a finite non-negative monotonic timestamp",
		);
	}
}

export function createFixedStepClock(): FixedStepClock {
	let accumulatorMs = 0;
	let currentTick = 0;
	let destroyed = false;
	let hiddenPreviously = false;
	let lastTimestampMs: number | undefined;

	function assertAlive(): void {
		if (destroyed) throw new Error("fixed-step clock is destroyed");
	}

	return {
		advance(timestampMs, hidden) {
			assertAlive();
			requireTimestamp(timestampMs);
			if (lastTimestampMs !== undefined && timestampMs < lastTimestampMs) {
				throw new Error("timestampMs must be monotonic");
			}
			if (hidden) {
				lastTimestampMs = timestampMs;
				accumulatorMs = 0;
				hiddenPreviously = true;
				return EMPTY_ADVANCE;
			}
			if (lastTimestampMs === undefined || hiddenPreviously) {
				lastTimestampMs = timestampMs;
				accumulatorMs = 0;
				hiddenPreviously = false;
				return EMPTY_ADVANCE;
			}

			accumulatorMs += timestampMs - lastTimestampMs;
			lastTimestampMs = timestampMs;
			const ticks: SimulationTick[] = [];
			while (
				accumulatorMs + TICK_EPSILON_MS >= FIXED_STEP_MS &&
				ticks.length < MAX_CATCH_UP_TICKS
			) {
				accumulatorMs -= FIXED_STEP_MS;
				if (Math.abs(accumulatorMs) < TICK_EPSILON_MS) {
					accumulatorMs = 0;
				}
				currentTick += 1;
				ticks.push(
					Object.freeze({
						tick: currentTick,
						deltaSeconds: FIXED_STEP_SECONDS,
						simulationTimeSeconds: currentTick * FIXED_STEP_SECONDS,
						timestampMs: timestampMs - accumulatorMs,
					}),
				);
			}

			const droppedTicks = Math.floor(
				(accumulatorMs + TICK_EPSILON_MS) / FIXED_STEP_MS,
			);
			if (droppedTicks > 0) {
				accumulatorMs -= droppedTicks * FIXED_STEP_MS;
			}
			const alpha = Math.min(
				Math.max(accumulatorMs / FIXED_STEP_MS, 0),
				1 - Number.EPSILON,
			);
			return Object.freeze({
				ticks: Object.freeze(ticks),
				alpha,
				droppedTicks,
			});
		},
		reset() {
			assertAlive();
			accumulatorMs = 0;
			currentTick = 0;
			hiddenPreviously = false;
			lastTimestampMs = undefined;
		},
		destroy() {
			accumulatorMs = 0;
			lastTimestampMs = undefined;
			destroyed = true;
		},
		get tick() {
			return currentTick;
		},
	};
}
