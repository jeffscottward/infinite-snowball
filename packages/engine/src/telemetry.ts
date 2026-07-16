import { FIXED_STEP_MS } from "./clock.js";
export type PerformanceProfile = "lowMobile" | "mid" | "high";

/**
 * Eight Float64Array buffers cap each telemetry instance at 640,000 bytes
 * and bound the percentile sort to 10,000 values.
 */
export const MAX_TELEMETRY_SAMPLES = 10_000;

export interface PerformanceBudget {
	readonly frameP95Ms: number;
	readonly physicsP95Ms: number;
	readonly inputLatencyP95Ms: number;
	readonly drawCalls: number;
	readonly triangles: number;
	readonly activeBodies: number;
	readonly heapMb: number;
	readonly longTaskMs: number;
}

function budget(
	frameP95Ms: number,
	inputLatencyP95Ms: number,
	drawCalls: number,
	triangles: number,
	activeBodies: number,
	heapMb: number,
): PerformanceBudget {
	return Object.freeze({
		frameP95Ms,
		physicsP95Ms: frameP95Ms * 0.25,
		inputLatencyP95Ms,
		drawCalls,
		triangles,
		activeBodies,
		heapMb,
		longTaskMs: 50,
	});
}

export const PERFORMANCE_BUDGETS: Readonly<
	Record<PerformanceProfile, PerformanceBudget>
> = Object.freeze({
	lowMobile: budget(33.3, 50, 80, 150_000, 150, 250),
	mid: budget(20, FIXED_STEP_MS * 2, 140, 350_000, 350, 400),
	high: budget(16.7, FIXED_STEP_MS * 2, 220, 750_000, 750, 700),
});

export const PERFORMANCE_TRACE_LABELS = Object.freeze({
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

export interface TelemetrySample {
	readonly frameMs: number;
	readonly physicsMs: number;
	readonly inputLatencyMs: number;
	readonly drawCalls: number;
	readonly triangles: number;
	readonly activeBodies: number;
	readonly heapMb: number;
	readonly longTaskMs: number;
}

export interface TelemetrySnapshot extends TelemetrySample {
	readonly profile: PerformanceProfile;
	readonly sampleCount: number;
	readonly frameP95Ms: number;
	readonly physicsP95Ms: number;
	readonly inputLatencyP95Ms: number;
	readonly budget: PerformanceBudget;
	readonly pass: boolean;
}

export interface PerformanceTelemetry {
	record(sample: TelemetrySample): void;
	snapshot(): TelemetrySnapshot;
	reset(): void;
	destroy(): void;
	readonly destroyed: boolean;
}

function requireMetric(value: number, metric: keyof TelemetrySample): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`${metric} must be a finite non-negative number`);
	}
}

function percentile95(values: Float64Array, count: number): number {
	if (count === 0) return 0;
	const sorted = Array.from(values.subarray(0, count)).sort(
		(left, right) => left - right,
	);
	return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function maximum(values: Float64Array, count: number): number {
	let result = 0;
	for (let index = 0; index < count; index += 1) {
		result = Math.max(result, values[index] ?? 0);
	}
	return result;
}

export function createPerformanceTelemetry(
	profile: PerformanceProfile,
	maxSamples = 120,
): PerformanceTelemetry {
	if (
		typeof profile !== "string" ||
		!Object.hasOwn(PERFORMANCE_BUDGETS, profile)
	) {
		throw new Error("unknown performance profile");
	}
	if (!Number.isSafeInteger(maxSamples) || maxSamples <= 0) {
		throw new Error("maxSamples must be a positive safe integer");
	}
	if (maxSamples > MAX_TELEMETRY_SAMPLES) {
		throw new Error(`maxSamples must be at most ${MAX_TELEMETRY_SAMPLES}`);
	}
	const profileBudget = PERFORMANCE_BUDGETS[profile];
	const frameMs = new Float64Array(maxSamples);
	const physicsMs = new Float64Array(maxSamples);
	const inputLatencyMs = new Float64Array(maxSamples);
	const drawCalls = new Float64Array(maxSamples);
	const triangles = new Float64Array(maxSamples);
	const activeBodies = new Float64Array(maxSamples);
	const heapMb = new Float64Array(maxSamples);
	const longTaskMs = new Float64Array(maxSamples);
	let count = 0;
	let cursor = 0;
	let destroyed = false;

	function assertAlive(): void {
		if (destroyed) throw new Error("performance telemetry is destroyed");
	}
	return {
		record(sample) {
			assertAlive();
			const sampleFrameMs = sample.frameMs;
			const samplePhysicsMs = sample.physicsMs;
			const sampleInputLatencyMs = sample.inputLatencyMs;
			const sampleDrawCalls = sample.drawCalls;
			const sampleTriangles = sample.triangles;
			const sampleActiveBodies = sample.activeBodies;
			const sampleHeapMb = sample.heapMb;
			const sampleLongTaskMs = sample.longTaskMs;
			requireMetric(sampleFrameMs, "frameMs");
			requireMetric(samplePhysicsMs, "physicsMs");
			requireMetric(sampleInputLatencyMs, "inputLatencyMs");
			requireMetric(sampleDrawCalls, "drawCalls");
			requireMetric(sampleTriangles, "triangles");
			requireMetric(sampleActiveBodies, "activeBodies");
			requireMetric(sampleHeapMb, "heapMb");
			requireMetric(sampleLongTaskMs, "longTaskMs");
			frameMs[cursor] = sampleFrameMs;
			physicsMs[cursor] = samplePhysicsMs;
			inputLatencyMs[cursor] = sampleInputLatencyMs;
			drawCalls[cursor] = sampleDrawCalls;
			triangles[cursor] = sampleTriangles;
			activeBodies[cursor] = sampleActiveBodies;
			heapMb[cursor] = sampleHeapMb;
			longTaskMs[cursor] = sampleLongTaskMs;
			cursor = (cursor + 1) % maxSamples;
			count = Math.min(count + 1, maxSamples);
		},
		snapshot() {
			assertAlive();
			const evidence: TelemetrySample = {
				frameMs: percentile95(frameMs, count),
				physicsMs: percentile95(physicsMs, count),
				inputLatencyMs: percentile95(inputLatencyMs, count),
				drawCalls: maximum(drawCalls, count),
				triangles: maximum(triangles, count),
				activeBodies: maximum(activeBodies, count),
				heapMb: maximum(heapMb, count),
				longTaskMs: maximum(longTaskMs, count),
			};
			const result = {
				profile,
				sampleCount: count,
				...evidence,
				frameP95Ms: evidence.frameMs,
				physicsP95Ms: evidence.physicsMs,
				inputLatencyP95Ms: evidence.inputLatencyMs,
				budget: profileBudget,
				pass:
					count > 0 &&
					evidence.frameMs <= profileBudget.frameP95Ms &&
					evidence.physicsMs <= profileBudget.physicsP95Ms &&
					evidence.inputLatencyMs <= profileBudget.inputLatencyP95Ms &&
					evidence.drawCalls <= profileBudget.drawCalls &&
					evidence.triangles <= profileBudget.triangles &&
					evidence.activeBodies <= profileBudget.activeBodies &&
					evidence.heapMb <= profileBudget.heapMb &&
					evidence.longTaskMs <= profileBudget.longTaskMs,
			};
			return Object.freeze(result);
		},
		reset() {
			assertAlive();
			count = 0;
			cursor = 0;
		},
		destroy() {
			if (destroyed) return;
			count = 0;
			cursor = 0;
			destroyed = true;
		},
		get destroyed() {
			return destroyed;
		},
	};
}

export const createRuntimeTelemetry = createPerformanceTelemetry;
