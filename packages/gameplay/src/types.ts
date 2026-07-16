export interface Vector3 {
	readonly x: number;
	readonly y: number;
	readonly z: number;
}

export interface Quaternion {
	readonly x: number;
	readonly y: number;
	readonly z: number;
	readonly w: number;
}

export interface Pose {
	readonly position: Vector3;
	readonly rotation: Quaternion;
	readonly scale: Vector3;
}

export interface SnowballFacts {
	readonly radius: number;
	readonly volume: number;
	readonly mass: number;
	readonly score: number;
}

export interface SnowballState extends SnowballFacts {
	readonly position: Vector3;
	readonly rotation: Quaternion;
	readonly velocity: Vector3;
	readonly angularVelocity: Vector3;
	readonly grounded: boolean;
	readonly slopeRadians: number;
}

export interface SnowballFactsOptions {
	readonly radius?: number;
	readonly mass?: number;
	readonly score?: number;
}

export interface CollectibleCandidate {
	readonly id: string;
	readonly currentOwnerId: string | null;
	readonly requiredRadius: number;
	readonly volume: number;
	readonly mass: number;
	readonly points: number;
	readonly worldPose: Pose;
}

export interface DataOnlyAttachment {
	readonly parentId: string;
	readonly localPose: Pose;
	readonly rigidBody?: undefined;
	readonly joint?: undefined;
}

export interface CollectedObject {
	readonly entityId: string;
	readonly disableBodyAtTick: number;
	readonly attachment: DataOnlyAttachment;
}

export interface ObjectiveSnapshot {
	readonly currentScore: number;
	readonly targetScore: number;
	readonly complete: boolean;
}

export interface CollectionAudioHookInput {
	readonly entityId: string;
	readonly sequence: number;
	readonly points: number;
	readonly radiusBefore: number;
	readonly radiusAfter: number;
}

export interface CollectionScoreEvent {
	readonly kind: "score";
	readonly entityId: string;
	readonly sequence: number;
	readonly points: number;
	readonly totalScore: number;
}

export interface CollectionObjectiveEvent {
	readonly kind: "objective-complete";
	readonly entityId: string;
	readonly sequence: number;
	readonly targetScore: number;
	readonly totalScore: number;
}

export type CollectionEvent = CollectionScoreEvent | CollectionObjectiveEvent;

export interface CollectionAudioEvent {
	readonly entityId: string;
	readonly cue: string;
	readonly sequence: number;
}

export interface CollectionResult {
	readonly state: SnowballState;
	readonly collected: readonly CollectedObject[];
	readonly remainingIds: readonly string[];
	readonly objective: ObjectiveSnapshot;
	readonly events: readonly CollectionEvent[];
	readonly audioEvents: readonly CollectionAudioEvent[];
}
