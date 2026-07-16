import { growRadius } from "./facts.js";
import type {
	CollectedObject,
	CollectibleCandidate,
	CollectionAudioEvent,
	CollectionAudioHookInput,
	CollectionEvent,
	CollectionResult,
	Pose,
	Quaternion,
	SnowballState,
	Vector3,
} from "./types.js";

export interface CollectionOptions {
	readonly collectorId: string;
	readonly targetScore: number;
	readonly resolveAudioCue?: (
		event: Readonly<CollectionAudioHookInput>,
	) => string | undefined;
}

// Fixed, non-configurable ceilings bound sorting, event fan-out, and retained text per tick.
const MAX_COLLECTION_CANDIDATES_PER_TICK = 4_096;
const MAX_COLLECTION_ID_LENGTH = 256;
const MAX_AUDIO_CUE_LENGTH = 256;

function ordinal(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function requireFinite(value: number, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} must be finite`);
	}
	return value === 0 ? 0 : value;
}

function requireNonNegative(value: number, label: string): number {
	const checked = requireFinite(value, label);
	if (checked < 0) throw new Error(`${label} must be non-negative`);
	return checked === 0 ? 0 : checked;
}

function requirePositiveF32(value: number, label: string): number {
	const checked = requireFinite(value, label);
	if (checked <= 0) {
		throw new Error(`${label} must be a finite positive number`);
	}
	const converted = Math.fround(checked);
	if (!Number.isFinite(converted) || converted === 0) {
		throw new Error(`${label} must be finite and safely representable as f32`);
	}
	return checked;
}

function requireNonNegativeF32(value: number, label: string): number {
	const checked = requireNonNegative(value, label);
	const converted = Math.fround(checked);
	if (!Number.isFinite(converted) || (checked !== 0 && converted === 0)) {
		throw new Error(`${label} must be finite and safely representable as f32`);
	}
	return checked;
}

function requireBoundedPrimitiveString(
	value: unknown,
	label: string,
	maximumLength: number,
): string {
	if (typeof value !== "string") {
		throw new Error(`${label} must be a primitive string`);
	}
	if (value.length === 0) throw new Error(`${label} must not be empty`);
	if (value.length > maximumLength) {
		throw new Error(`${label} must not exceed ${maximumLength} characters`);
	}
	return value;
}

function requireBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
	return value;
}

function cleanZero(value: number): number {
	return Math.abs(value) < Number.EPSILON ? 0 : value;
}

function frozenVector(vector: Vector3): Vector3 {
	return Object.freeze({
		x: cleanZero(requireFinite(vector.x, "vector.x")),
		y: cleanZero(requireFinite(vector.y, "vector.y")),
		z: cleanZero(requireFinite(vector.z, "vector.z")),
	});
}

function normalizedQuaternion(quaternion: Quaternion): Quaternion {
	const x = requireFinite(quaternion.x, "quaternion.x");
	const y = requireFinite(quaternion.y, "quaternion.y");
	const z = requireFinite(quaternion.z, "quaternion.z");
	const w = requireFinite(quaternion.w, "quaternion.w");
	const scale = Math.max(Math.abs(x), Math.abs(y), Math.abs(z), Math.abs(w));
	if (scale === 0) throw new Error("quaternion must not be zero");
	const scaledX = x / scale;
	const scaledY = y / scale;
	const scaledZ = z / scale;
	const scaledW = w / scale;
	const magnitude = Math.hypot(scaledX, scaledY, scaledZ, scaledW);
	return Object.freeze({
		x: cleanZero(scaledX / magnitude),
		y: cleanZero(scaledY / magnitude),
		z: cleanZero(scaledZ / magnitude),
		w: cleanZero(scaledW / magnitude),
	});
}

function inverse(quaternion: Quaternion): Quaternion {
	const normalized = normalizedQuaternion(quaternion);
	return Object.freeze({
		x: cleanZero(-normalized.x),
		y: cleanZero(-normalized.y),
		z: cleanZero(-normalized.z),
		w: normalized.w,
	});
}

function multiply(left: Quaternion, right: Quaternion): Quaternion {
	const normalizedLeft = normalizedQuaternion(left);
	const normalizedRight = normalizedQuaternion(right);
	return normalizedQuaternion({
		x:
			normalizedLeft.w * normalizedRight.x +
			normalizedLeft.x * normalizedRight.w +
			normalizedLeft.y * normalizedRight.z -
			normalizedLeft.z * normalizedRight.y,
		y:
			normalizedLeft.w * normalizedRight.y -
			normalizedLeft.x * normalizedRight.z +
			normalizedLeft.y * normalizedRight.w +
			normalizedLeft.z * normalizedRight.x,
		z:
			normalizedLeft.w * normalizedRight.z +
			normalizedLeft.x * normalizedRight.y -
			normalizedLeft.y * normalizedRight.x +
			normalizedLeft.z * normalizedRight.w,
		w:
			normalizedLeft.w * normalizedRight.w -
			normalizedLeft.x * normalizedRight.x -
			normalizedLeft.y * normalizedRight.y -
			normalizedLeft.z * normalizedRight.z,
	});
}

function rotate(vector: Vector3, quaternion: Quaternion): Vector3 {
	const q = normalizedQuaternion(quaternion);
	const tx = 2 * (q.y * vector.z - q.z * vector.y);
	const ty = 2 * (q.z * vector.x - q.x * vector.z);
	const tz = 2 * (q.x * vector.y - q.y * vector.x);
	return frozenVector({
		x: vector.x + q.w * tx + (q.y * tz - q.z * ty),
		y: vector.y + q.w * ty + (q.z * tx - q.x * tz),
		z: vector.z + q.w * tz + (q.x * ty - q.y * tx),
	});
}

function localPose(parent: Readonly<SnowballState>, worldPose: Pose): Pose {
	const inverseParent = inverse(parent.rotation);
	const offset = {
		x: worldPose.position.x - parent.position.x,
		y: worldPose.position.y - parent.position.y,
		z: worldPose.position.z - parent.position.z,
	};
	return Object.freeze({
		position: rotate(offset, inverseParent),
		rotation: multiply(inverseParent, worldPose.rotation),
		scale: frozenVector(worldPose.scale),
	});
}

function frozenState(
	state: Readonly<SnowballState>,
	facts: Readonly<{
		radius: number;
		volume: number;
		mass: number;
		score: number;
	}>,
): SnowballState {
	const grounded = requireBoolean(state.grounded, "grounded");
	const rawSlopeRadians: unknown = state.slopeRadians;
	if (typeof rawSlopeRadians !== "number") {
		throw new Error("slopeRadians must be a number");
	}
	const slopeRadians = grounded
		? requireFinite(rawSlopeRadians, "slopeRadians")
		: Number.isFinite(rawSlopeRadians)
			? cleanZero(rawSlopeRadians)
			: 0;
	return Object.freeze({
		position: frozenVector(state.position),
		rotation: normalizedQuaternion(state.rotation),
		velocity: frozenVector(state.velocity),
		angularVelocity: frozenVector(state.angularVelocity),
		radius: facts.radius,
		volume: facts.volume,
		mass: facts.mass,
		score: facts.score,
		grounded,
		slopeRadians,
	});
}

interface ValidatedCandidate {
	readonly source: CollectibleCandidate;
	readonly id: string;
	readonly currentOwnerId: string | null;
	readonly requiredRadius: number;
	readonly volume: number;
	readonly mass: number;
	readonly points: number;
}

function validateCandidate(candidate: unknown): ValidatedCandidate {
	if (
		typeof candidate !== "object" ||
		candidate === null ||
		Array.isArray(candidate)
	) {
		throw new Error("collectible candidate must be an object");
	}
	const source = candidate as CollectibleCandidate;
	const id = requireBoundedPrimitiveString(
		source.id,
		"collectible ID",
		MAX_COLLECTION_ID_LENGTH,
	);
	const owner = source.currentOwnerId;
	const currentOwnerId =
		owner === null
			? null
			: requireBoundedPrimitiveString(
					owner,
					"current owner ID",
					MAX_COLLECTION_ID_LENGTH,
				);
	return Object.freeze({
		source,
		id,
		currentOwnerId,
		requiredRadius: requireNonNegative(source.requiredRadius, "requiredRadius"),
		volume: requireNonNegative(source.volume, "volume"),
		mass: requireNonNegative(source.mass, "mass"),
		points: requireNonNegative(source.points, "points"),
	});
}

export function collectObjects(
	state: Readonly<SnowballState>,
	candidates: readonly CollectibleCandidate[],
	tick: number,
	options: CollectionOptions,
): CollectionResult {
	if (!Array.isArray(candidates)) {
		throw new Error("collection candidates must be a real candidate array");
	}
	const candidateCount = candidates.length;
	if (candidateCount > MAX_COLLECTION_CANDIDATES_PER_TICK) {
		throw new Error(
			`collection candidate array exceeds maximum of ${MAX_COLLECTION_CANDIDATES_PER_TICK}`,
		);
	}
	if (!Number.isSafeInteger(tick) || tick < 0) {
		throw new Error("collection tick must be a non-negative safe integer");
	}
	const disableBodyAtTick = tick + 1;
	if (!Number.isSafeInteger(disableBodyAtTick)) {
		throw new Error("collection retirement tick must be a safe integer");
	}
	const resolveAudioCue = options.resolveAudioCue;
	if (resolveAudioCue !== undefined && typeof resolveAudioCue !== "function") {
		throw new Error("audio cue resolver must be a function");
	}
	const targetScore = requireNonNegative(options.targetScore, "targetScore");
	const collectorId = requireBoundedPrimitiveString(
		options.collectorId,
		"collector ID",
		MAX_COLLECTION_ID_LENGTH,
	);
	const tickStartRadius = requirePositiveF32(state.radius, "snowball radius");
	let radius = tickStartRadius;
	let volume = requireNonNegative(state.volume, "snowball volume");
	let mass = requireNonNegativeF32(state.mass, "snowball mass");
	let score = requireNonNegative(state.score, "snowball score");
	const validated: ValidatedCandidate[] = [];
	for (let index = 0; index < candidateCount; index += 1) {
		validated.push(validateCandidate(candidates[index]));
	}
	const seen = new Set<string>();
	for (const candidate of validated) {
		if (seen.has(candidate.id)) {
			throw new Error(`duplicate collectible ID: ${candidate.id}`);
		}
		seen.add(candidate.id);
	}
	validated.sort((left, right) => ordinal(left.id, right.id));
	const eligible: ValidatedCandidate[] = [];
	const collected: CollectedObject[] = [];
	const remainingIds: string[] = [];
	const events: CollectionEvent[] = [];
	const audioEvents: CollectionAudioEvent[] = [];
	const audioInputs: Readonly<CollectionAudioHookInput>[] = [];
	let eventSequence = 0;

	for (const candidate of validated) {
		if (
			candidate.currentOwnerId !== null ||
			candidate.requiredRadius > tickStartRadius
		) {
			remainingIds.push(candidate.id);
		} else {
			eligible.push(candidate);
		}
	}

	for (const candidate of eligible) {
		const addedVolume = candidate.volume === 0 ? 0 : candidate.volume;
		const addedMass = candidate.mass === 0 ? 0 : candidate.mass;
		const points = candidate.points === 0 ? 0 : candidate.points;
		const radiusBefore = radius;
		const scoreBefore = score;
		const attachment = Object.freeze({
			parentId: collectorId,
			localPose: localPose(state, candidate.source.worldPose),
		});
		collected.push(
			Object.freeze({
				entityId: candidate.id,
				disableBodyAtTick,
				attachment,
			}),
		);
		radius = requirePositiveF32(
			growRadius(radius, addedVolume),
			"snowball radius",
		);
		volume = requireNonNegative(volume + addedVolume, "snowball volume");
		mass = requireNonNegativeF32(mass + addedMass, "snowball mass");
		score = requireNonNegative(score + points, "snowball score");
		events.push(
			Object.freeze({
				kind: "score",
				entityId: candidate.id,
				sequence: eventSequence,
				points,
				totalScore: score,
			}),
		);
		eventSequence += 1;
		if (scoreBefore < targetScore && score >= targetScore) {
			events.push(
				Object.freeze({
					kind: "objective-complete",
					entityId: candidate.id,
					sequence: eventSequence,
					targetScore,
					totalScore: score,
				}),
			);
			eventSequence += 1;
		}
		audioInputs.push(
			Object.freeze({
				entityId: candidate.id,
				sequence: audioInputs.length,
				points,
				radiusBefore,
				radiusAfter: radius,
			}),
		);
	}

	const nextState = frozenState(state, { radius, volume, mass, score });
	for (const audioInput of audioInputs) {
		const cue = resolveAudioCue?.(audioInput);
		if (cue === undefined) continue;
		audioEvents.push(
			Object.freeze({
				entityId: audioInput.entityId,
				cue: requireBoundedPrimitiveString(
					cue,
					"audio cue",
					MAX_AUDIO_CUE_LENGTH,
				),
				sequence: audioInput.sequence,
			}),
		);
	}
	return Object.freeze({
		state: nextState,
		collected: Object.freeze(collected),
		remainingIds: Object.freeze(remainingIds),
		objective: Object.freeze({
			currentScore: score,
			targetScore,
			complete: score >= targetScore,
		}),
		events: Object.freeze(events),
		audioEvents: Object.freeze(audioEvents),
	});
}
