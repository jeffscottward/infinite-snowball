import type { InputFrame } from "@infinite-snowball/input";

import type { SnowballState, Vector3 } from "./types.js";

export interface SnowballControllerConfig {
	readonly groundTorque: number;
	readonly turnTorque: number;
	readonly maxGroundSpeed: number;
	readonly maxSlopeRadians: number;
	readonly airControl: number;
	readonly coastBraking: number;
}

export const DEFAULT_SNOWBALL_CONTROLLER: SnowballControllerConfig =
	Object.freeze({
		groundTorque: 12,
		turnTorque: 8,
		maxGroundSpeed: 12,
		maxSlopeRadians: Math.PI / 3,
		airControl: 0.2,
		coastBraking: 0.15,
	});

export interface SnowballCommandOptions {
	readonly reducedMotion?: boolean;
	readonly controller?: Partial<SnowballControllerConfig>;
}

export interface CameraIntent {
	readonly follow: true;
	readonly reset: boolean;
	readonly look: Readonly<{ x: number; y: number }>;
	readonly shake: number;
	readonly zoomPulse: number;
}

export interface SnowballCommand {
	readonly torque: Vector3;
	readonly turn: number;
	readonly braking: number;
	readonly boost: boolean;
	readonly action: boolean;
	readonly camera: CameraIntent;
}

function finite(value: number, label: string): number {
	if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
	return value;
}

function finiteF32(value: number, label: string): number {
	const checked = finite(value, label);
	const converted = Math.fround(checked);
	if (!Number.isFinite(converted) || (checked !== 0 && converted === 0)) {
		throw new Error(`${label} must be finite and safely representable as f32`);
	}
	return checked === 0 ? 0 : checked;
}

function primitiveBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be boolean`);
	}
	return value;
}

function cleanZero(value: number): number {
	return value === 0 ? 0 : value;
}

function controllerConfig(
	overrides: Partial<SnowballControllerConfig> | undefined,
): SnowballControllerConfig {
	const config = { ...DEFAULT_SNOWBALL_CONTROLLER, ...overrides };
	for (const [label, value] of Object.entries(config)) finite(value, label);
	const groundTorque = finiteF32(config.groundTorque, "groundTorque");
	const turnTorque = finiteF32(config.turnTorque, "turnTorque");
	const coastBraking = finiteF32(config.coastBraking, "coastBraking");
	if (
		groundTorque < 0 ||
		turnTorque < 0 ||
		config.maxGroundSpeed <= 0 ||
		config.maxSlopeRadians < 0 ||
		config.airControl < 0 ||
		config.airControl > 1 ||
		coastBraking < 0 ||
		coastBraking > 1
	) {
		throw new Error("invalid snowball controller configuration");
	}
	return Object.freeze({
		...config,
		groundTorque,
		turnTorque,
		coastBraking,
	});
}

export function computeSnowballCommand(
	frame: Readonly<InputFrame>,
	state: Readonly<SnowballState>,
	options: SnowballCommandOptions = {},
): SnowballCommand {
	const config = controllerConfig(options.controller);
	const rawMoveX = finite(frame.move.x, "move.x");
	const rawMoveY = finite(frame.move.y, "move.y");
	const lookX = finite(frame.look.x, "look.x");
	const lookY = finite(frame.look.y, "look.y");
	const lookMagnitude = finite(Math.hypot(lookX, lookY), "look magnitude");
	if (lookMagnitude > 1) {
		throw new Error("look magnitude must not exceed 1");
	}
	const rawMagnitude = finite(Math.hypot(rawMoveX, rawMoveY), "move magnitude");
	const moveMagnitude = Math.min(1, rawMagnitude);
	const moveX = rawMagnitude > 1 ? rawMoveX / rawMagnitude : rawMoveX;
	const moveY = rawMagnitude > 1 ? rawMoveY / rawMagnitude : rawMoveY;
	const speed = finite(
		Math.hypot(
			finite(state.velocity.x, "velocity.x"),
			finite(state.velocity.z, "velocity.z"),
		),
		"speed",
	);
	const speedRatio = finite(speed / config.maxGroundSpeed, "speed ratio");
	const speedScale = Math.max(0, 1 - speedRatio);
	const grounded = primitiveBoolean(state.grounded, "grounded");
	const rawSlopeRadians: unknown = state.slopeRadians;
	if (typeof rawSlopeRadians !== "number") {
		throw new Error("slopeRadians must be a number");
	}
	const slopePermitsTorque =
		!grounded ||
		finite(rawSlopeRadians, "slopeRadians") <= config.maxSlopeRadians;
	const traction = grounded ? (slopePermitsTorque ? 1 : 0) : config.airControl;
	const torqueMagnitude = finite(
		config.groundTorque * moveMagnitude * speedScale * traction,
		"torque magnitude",
	);
	const directionMagnitude = finite(
		Math.hypot(moveX, moveY),
		"move direction magnitude",
	);
	const directionX = directionMagnitude === 0 ? 0 : moveY / directionMagnitude;
	const directionZ = directionMagnitude === 0 ? 0 : -moveX / directionMagnitude;
	const torque = Object.freeze({
		x: cleanZero(finiteF32(directionX * torqueMagnitude, "torque.x")),
		y: 0,
		z: cleanZero(finiteF32(directionZ * torqueMagnitude, "torque.z")),
	});
	const brakeHeld = primitiveBoolean(frame.held.brake, "held.brake");
	const boostHeld = primitiveBoolean(frame.held.boost, "held.boost");
	const actionPressed = primitiveBoolean(
		frame.pressed.action,
		"pressed.action",
	);
	const resetCameraPressed = primitiveBoolean(
		frame.pressed.resetCamera,
		"pressed.resetCamera",
	);
	const braking = finiteF32(
		brakeHeld ? 1 : moveMagnitude <= 0.01 ? config.coastBraking : 0,
		"braking",
	);
	const reducedMotion =
		options.reducedMotion === undefined
			? false
			: primitiveBoolean(options.reducedMotion, "reducedMotion");
	const motionIntensity = Math.min(1, speedRatio);
	const shake = reducedMotion
		? 0
		: Math.min(
				1,
				motionIntensity * (0.2 + braking * 0.1) + Number(boostHeld) * 0.15,
			);
	const zoomPulse = reducedMotion ? 0 : boostHeld ? 0.12 : 0;
	const turn = cleanZero(
		finiteF32(moveX * config.turnTorque * traction, "turn"),
	);
	return Object.freeze({
		torque,
		turn,
		braking,
		boost: boostHeld,
		action: actionPressed,
		camera: Object.freeze({
			follow: true,
			look: Object.freeze({
				x: cleanZero(lookX),
				y: cleanZero(lookY),
			}),
			reset: resetCameraPressed,
			shake,
			zoomPulse,
		}),
	});
}
