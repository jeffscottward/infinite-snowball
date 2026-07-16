import type { InputFrame } from "@infinite-snowball/input";

export interface CameraIntentControllerConfig {
	readonly sensitivity: number;
	readonly invertY: boolean;
	readonly autoRecenter: boolean;
	readonly autoRecenterDelaySeconds: number;
	readonly recenterRate: number;
	readonly minimumPitch: number;
	readonly maximumPitch: number;
	readonly desiredDistance: number;
	readonly minimumDistance: number;
	readonly resolveCollisionDistance?: (desiredDistance: number) => number;
}

export interface CameraIntentFrameOptions {
	readonly deltaSeconds: number;
	readonly shake: number;
	readonly zoomPulse: number;
	readonly reducedMotion: boolean;
}

export interface CameraRigIntent {
	readonly yaw: number;
	readonly pitch: number;
	readonly roll: 0;
	readonly horizonUp: Readonly<{ x: 0; y: 1; z: 0 }>;
	readonly distance: number;
	readonly shake: number;
	readonly zoomPulse: number;
}

export interface CameraIntentController {
	update(
		frame: Readonly<InputFrame>,
		options: Readonly<CameraIntentFrameOptions>,
	): CameraRigIntent;
	reset(): void;
	destroy(): void;
	readonly destroyed: boolean;
}

export const DEFAULT_CAMERA_INTENT_CONTROLLER: Readonly<
	Omit<CameraIntentControllerConfig, "resolveCollisionDistance">
> = Object.freeze({
	sensitivity: 1,
	invertY: false,
	autoRecenter: true,
	autoRecenterDelaySeconds: 1.5,
	recenterRate: 2,
	minimumPitch: -Math.PI / 3,
	maximumPitch: Math.PI / 3,
	desiredDistance: 6,
	minimumDistance: 0.25,
});

const HORIZON_UP = Object.freeze({
	x: 0 as const,
	y: 1 as const,
	z: 0 as const,
});
const MANUAL_LOOK_THRESHOLD = 0.0001;

type CollisionDistanceResolver = NonNullable<
	CameraIntentControllerConfig["resolveCollisionDistance"]
>;
type ResolvedCameraConfig = Readonly<
	Omit<CameraIntentControllerConfig, "resolveCollisionDistance">
>;

function finite(value: number, label: string): number {
	if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
	return value;
}

function numericOption(value: number, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} must be a finite number`);
	}
	return value;
}

function primitiveBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be boolean`);
	}
	return value;
}

function collisionResolver(
	value: unknown,
): CollisionDistanceResolver | undefined {
	if (value !== undefined && typeof value !== "function") {
		throw new Error("collision resolver must be a function");
	}
	return value as CollisionDistanceResolver | undefined;
}

function moveToward(
	value: number,
	target: number,
	maximumDelta: number,
): number {
	const delta = target - value;
	if (Math.abs(delta) <= maximumDelta) return target;
	return value + Math.sign(delta) * maximumDelta;
}

function cleanZero(value: number): number {
	return Math.abs(value) < Number.EPSILON ? 0 : value;
}

function wrapAngle(value: number): number {
	const fullTurn = Math.PI * 2;
	const wrapped =
		((((value + Math.PI) % fullTurn) + fullTurn) % fullTurn) - Math.PI;
	return cleanZero(wrapped);
}

function resolveConfig(
	overrides: Partial<CameraIntentControllerConfig>,
): ResolvedCameraConfig {
	const candidate = { ...DEFAULT_CAMERA_INTENT_CONTROLLER, ...overrides };
	const sensitivity = numericOption(candidate.sensitivity, "sensitivity");
	const autoRecenterDelaySeconds = numericOption(
		candidate.autoRecenterDelaySeconds,
		"autoRecenterDelaySeconds",
	);
	const recenterRate = numericOption(candidate.recenterRate, "recenterRate");
	const minimumPitch = numericOption(candidate.minimumPitch, "minimumPitch");
	const maximumPitch = numericOption(candidate.maximumPitch, "maximumPitch");
	const desiredDistance = numericOption(
		candidate.desiredDistance,
		"desiredDistance",
	);
	const minimumDistance = numericOption(
		candidate.minimumDistance,
		"minimumDistance",
	);
	const invertY = primitiveBoolean(candidate.invertY, "invertY");
	const autoRecenter = primitiveBoolean(candidate.autoRecenter, "autoRecenter");
	if (
		sensitivity < 0 ||
		autoRecenterDelaySeconds < 0 ||
		recenterRate < 0 ||
		minimumPitch > maximumPitch ||
		desiredDistance <= 0 ||
		minimumDistance < 0 ||
		minimumDistance > desiredDistance
	) {
		throw new Error("invalid camera intent controller configuration");
	}
	return Object.freeze({
		sensitivity,
		invertY,
		autoRecenter,
		autoRecenterDelaySeconds,
		recenterRate,
		minimumPitch,
		maximumPitch,
		desiredDistance,
		minimumDistance,
	});
}

export function createCameraIntentController(
	overrides: Partial<CameraIntentControllerConfig> = {},
): CameraIntentController {
	let resolveCollisionDistance = collisionResolver(
		overrides.resolveCollisionDistance,
	);
	const config = resolveConfig(overrides);
	overrides = {};
	const neutralPitch = Math.max(
		config.minimumPitch,
		Math.min(config.maximumPitch, 0),
	);
	let yaw = 0;
	let pitch = neutralPitch;
	let idleSeconds = 0;
	let destroyed = false;
	let updating = false;

	function assertAlive(): void {
		if (destroyed) throw new Error("camera intent controller is destroyed");
	}

	const controller: CameraIntentController = {
		update(frame, options) {
			assertAlive();
			if (updating) {
				throw new Error(
					"camera intent controller update is already in progress",
				);
			}
			updating = true;
			try {
				const deltaSeconds = numericOption(
					options.deltaSeconds,
					"deltaSeconds",
				);
				const lookX = finite(frame.look.x, "look.x");
				const lookY = finite(frame.look.y, "look.y");
				const lookMagnitude = finite(
					Math.hypot(lookX, lookY),
					"look magnitude",
				);
				const shake = numericOption(options.shake, "shake");
				const zoomPulse = numericOption(options.zoomPulse, "zoomPulse");
				const reducedMotion = primitiveBoolean(
					options.reducedMotion,
					"reducedMotion",
				);
				if (deltaSeconds <= 0 || shake < 0 || zoomPulse < 0) {
					throw new Error(
						"camera frame values must be positive or non-negative",
					);
				}
				const resetRequested = primitiveBoolean(
					frame.pressed.resetCamera,
					"pressed.resetCamera",
				);
				const hasManualLook =
					!resetRequested && lookMagnitude > MANUAL_LOOK_THRESHOLD;
				let nextYaw = yaw;
				let nextPitch = pitch;
				let nextIdleSeconds = idleSeconds;
				if (resetRequested) {
					nextYaw = 0;
					nextPitch = neutralPitch;
					nextIdleSeconds = 0;
				} else if (hasManualLook) {
					const yawDelta = finite(
						lookX * config.sensitivity * deltaSeconds,
						"yaw delta",
					);
					const pitchDelta = finite(
						lookY *
							(config.invertY ? -1 : 1) *
							config.sensitivity *
							deltaSeconds,
						"pitch delta",
					);
					nextYaw = wrapAngle(finite(yaw + yawDelta, "yaw"));
					nextPitch = Math.max(
						config.minimumPitch,
						Math.min(config.maximumPitch, finite(pitch + pitchDelta, "pitch")),
					);
					nextIdleSeconds = 0;
				} else {
					const delayRemaining = Math.max(
						0,
						config.autoRecenterDelaySeconds - idleSeconds,
					);
					const recenterSeconds = Math.max(0, deltaSeconds - delayRemaining);
					nextIdleSeconds =
						deltaSeconds >= delayRemaining
							? config.autoRecenterDelaySeconds
							: idleSeconds + deltaSeconds;
					if (config.autoRecenter && recenterSeconds > 0) {
						const maximumDelta = finite(
							config.recenterRate * recenterSeconds,
							"recenter delta",
						);
						nextYaw = wrapAngle(moveToward(wrapAngle(yaw), 0, maximumDelta));
						nextPitch = moveToward(pitch, neutralPitch, maximumDelta);
					}
				}
				const collisionDistance =
					resolveCollisionDistance?.(config.desiredDistance) ??
					config.desiredDistance;
				finite(collisionDistance, "collision distance");
				const distance = Math.max(
					config.minimumDistance,
					Math.min(config.desiredDistance, collisionDistance),
				);
				assertAlive();
				const intent = Object.freeze({
					yaw: cleanZero(nextYaw),
					pitch: Object.is(nextPitch, -0) ? 0 : nextPitch,
					roll: 0 as const,
					horizonUp: HORIZON_UP,
					distance,
					shake: reducedMotion ? 0 : shake,
					zoomPulse: reducedMotion ? 0 : zoomPulse,
				});
				yaw = nextYaw;
				pitch = nextPitch;
				idleSeconds = nextIdleSeconds;
				return intent;
			} finally {
				updating = false;
			}
		},
		reset() {
			assertAlive();
			if (updating) {
				throw new Error(
					"camera intent controller update is already in progress",
				);
			}
			yaw = 0;
			pitch = neutralPitch;
			idleSeconds = 0;
		},
		destroy() {
			if (destroyed) return;
			resolveCollisionDistance = undefined;
			yaw = 0;
			pitch = 0;
			idleSeconds = 0;
			destroyed = true;
		},
		get destroyed() {
			return destroyed;
		},
	};
	return Object.freeze(controller);
}
