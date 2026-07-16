import { describe, expect, it, vi } from "vitest";
import {
	type CameraIntentController,
	type CollectibleCandidate,
	type CollectionAudioHookInput,
	collectObjects,
	computeSnowballCommand,
	createCameraIntentController,
	createInitialSnowballFacts,
	DEFAULT_SNOWBALL_CONTROLLER,
	growRadius,
	restartSnowballFacts,
	type SnowballState,
} from "../../packages/gameplay/src/index.js";
import {
	createActionState,
	type InputFrame,
} from "../../packages/input/src/index.js";

function frame(overrides: Partial<InputFrame> = {}): InputFrame {
	return {
		version: 1,
		tick: 1,
		timestampMs: 0,
		move: { x: 0, y: 0 },
		look: { x: 0, y: 0 },
		held: createActionState(),
		pressed: createActionState(),
		released: createActionState(),
		source: "keyboard",
		deviceId: "keyboard",
		...overrides,
	};
}

function state(overrides: Partial<SnowballState> = {}): SnowballState {
	return {
		position: { x: 0, y: 0, z: 0 },
		rotation: { x: 0, y: 0, z: 0, w: 1 },
		velocity: { x: 0, y: 0, z: 0 },
		angularVelocity: { x: 0, y: 0, z: 0 },
		radius: 1,
		volume: 1,
		mass: 1,
		score: 0,
		grounded: true,
		slopeRadians: 0,
		...overrides,
	};
}

function collectionOptions(targetScore = 100) {
	return {
		collectorId: "snowball-player",
		targetScore,
	};
}

function candidate(
	overrides: Partial<CollectibleCandidate> = {},
): CollectibleCandidate {
	return {
		id: "rock",
		currentOwnerId: null,
		requiredRadius: 0.5,
		volume: 0.125,
		mass: 0.25,
		points: 10,
		worldPose: {
			position: { x: 1, y: 0, z: 0 },
			rotation: { x: 0, y: 0, z: 0, w: 1 },
			scale: { x: 1, y: 1, z: 1 },
		},
		...overrides,
	};
}

describe("snowball controller commands", () => {
	it("produces immutable torque, turn, braking, boost, action, and camera intents", () => {
		const held = createActionState();
		held.moveForward = true;
		held.moveRight = true;
		held.boost = true;
		const pressed = createActionState();
		pressed.action = true;
		const input = frame({
			move: { x: 1, y: 1 },
			look: { x: 0.5, y: -0.25 },
			held,
			pressed,
		});
		const snowball = state();
		const inputBefore = structuredClone(input);
		const stateBefore = structuredClone(snowball);
		const command = computeSnowballCommand(input, snowball);
		expect(Math.hypot(command.torque.x, command.torque.z)).toBeLessThanOrEqual(
			DEFAULT_SNOWBALL_CONTROLLER.groundTorque + 1e-9,
		);
		expect(command.turn).toBeGreaterThan(0);
		expect(command.boost).toBe(true);
		expect(command.action).toBe(true);
		expect(command.camera.follow).toBe(true);
		expect(command.camera.look).toEqual({ x: 0.5, y: -0.25 });
		expect(input).toEqual(inputBefore);
		expect(snowball).toEqual(stateBefore);
		expect(JSON.parse(JSON.stringify(command))).toEqual(command);
	});

	it("uses held for continuous controls and pressed for one-shot action", () => {
		const held = createActionState();
		held.action = true;
		const heldOnly = computeSnowballCommand(frame({ held }), state());
		expect(heldOnly.action).toBe(false);
		const pressed = createActionState();
		pressed.action = true;
		expect(computeSnowballCommand(frame({ pressed }), state()).action).toBe(
			true,
		);
	});

	it("rejects non-finite movement, look, and overflowing derived values", () => {
		for (const invalid of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			expect(() =>
				computeSnowballCommand(frame({ move: { x: invalid, y: 0 } }), state()),
			).toThrow(/move\.x must be finite/u);
			expect(() =>
				computeSnowballCommand(frame({ move: { x: 0, y: invalid } }), state()),
			).toThrow(/move\.y must be finite/u);
			expect(() =>
				computeSnowballCommand(frame({ look: { x: invalid, y: 0 } }), state()),
			).toThrow(/look\.x must be finite/u);
			expect(() =>
				computeSnowballCommand(frame({ look: { x: 0, y: invalid } }), state()),
			).toThrow(/look\.y must be finite/u);
		}
		expect(() =>
			computeSnowballCommand(
				frame({ move: { x: Number.MAX_VALUE, y: Number.MAX_VALUE } }),
				state(),
			),
		).toThrow(/move magnitude must be finite/u);
		expect(() =>
			computeSnowballCommand(
				frame({ move: { x: 0, y: 1 } }),
				state({
					velocity: {
						x: Number.MAX_VALUE,
						y: 0,
						z: Number.MAX_VALUE,
					},
				}),
			),
		).toThrow(/speed must be finite/u);
		expect(() =>
			computeSnowballCommand(
				frame({ move: { x: 0, y: 1 } }),
				state({ velocity: { x: 1, y: 0, z: 0 } }),
				{ controller: { maxGroundSpeed: Number.MIN_VALUE } },
			),
		).toThrow(/speed ratio must be finite/u);
	});

	it("rejects finite look vectors outside the unit contract", () => {
		for (const look of [
			{ x: 1 + Number.EPSILON, y: 0 },
			{ x: 1e308, y: 0 },
			{ x: 1, y: 1 },
		]) {
			expect(() => computeSnowballCommand(frame({ look }), state())).toThrow(
				/look magnitude must not exceed 1/u,
			);
		}
		const diagonal = 1 / Math.hypot(1, 1);
		const legalDiagonal = computeSnowballCommand(
			frame({ look: { x: diagonal, y: -diagonal } }),
			state(),
		);
		expect(legalDiagonal.camera.look).toEqual({
			x: diagonal,
			y: -diagonal,
		});
	});

	it("limits torque at speed, on steep slopes, and while airborne", () => {
		const moving = frame({ move: { x: 0, y: 1 } });
		const ground = computeSnowballCommand(moving, state());
		const nearLimit = computeSnowballCommand(
			moving,
			state({
				velocity: {
					x: DEFAULT_SNOWBALL_CONTROLLER.maxGroundSpeed * 0.95,
					y: 0,
					z: 0,
				},
			}),
		);
		const tooFast = computeSnowballCommand(
			moving,
			state({
				velocity: {
					x: DEFAULT_SNOWBALL_CONTROLLER.maxGroundSpeed * 1.1,
					y: 0,
					z: 0,
				},
			}),
		);
		const steep = computeSnowballCommand(
			moving,
			state({
				slopeRadians: DEFAULT_SNOWBALL_CONTROLLER.maxSlopeRadians + 0.1,
			}),
		);
		const airborne = computeSnowballCommand(moving, state({ grounded: false }));
		expect(Math.abs(nearLimit.torque.x)).toBeLessThan(
			Math.abs(ground.torque.x),
		);
		expect(tooFast.torque).toEqual({ x: 0, y: 0, z: 0 });
		expect(steep.torque).toEqual({ x: 0, y: 0, z: 0 });
		expect(Math.abs(airborne.torque.x)).toBeCloseTo(
			Math.abs(ground.torque.x) * DEFAULT_SNOWBALL_CONTROLLER.airControl,
			8,
		);
	});

	it("uses air control even when an airborne state retains a steep ground slope", () => {
		const moving = frame({ move: { x: 1, y: 1 } });
		const ground = computeSnowballCommand(moving, state());
		const airborneWithStaleSlope = computeSnowballCommand(
			moving,
			state({
				grounded: false,
				slopeRadians: DEFAULT_SNOWBALL_CONTROLLER.maxSlopeRadians + 0.1,
			}),
		);
		expect(Math.abs(airborneWithStaleSlope.torque.x)).toBeCloseTo(
			Math.abs(ground.torque.x) * DEFAULT_SNOWBALL_CONTROLLER.airControl,
			8,
		);
		expect(Math.abs(airborneWithStaleSlope.turn)).toBeCloseTo(
			Math.abs(ground.turn) * DEFAULT_SNOWBALL_CONTROLLER.airControl,
			8,
		);
		const airborneWithInvalidStaleSlope = computeSnowballCommand(
			moving,
			state({ grounded: false, slopeRadians: Number.NaN }),
		);
		expect(Math.abs(airborneWithInvalidStaleSlope.torque.x)).toBeCloseTo(
			Math.abs(ground.torque.x) * DEFAULT_SNOWBALL_CONTROLLER.airControl,
			8,
		);
		expect(() =>
			computeSnowballCommand(
				moving,
				state({
					grounded: false,
					slopeRadians: "unavailable" as unknown as number,
				}),
			),
		).toThrow(/slopeRadians must be a number/u);
	});

	it("emits braking and reduced-motion-safe camera feedback", () => {
		const held = createActionState();
		held.brake = true;
		const normal = computeSnowballCommand(
			frame({ held }),
			state({ velocity: { x: 4, y: 0, z: 0 } }),
		);
		const reduced = computeSnowballCommand(
			frame({ held }),
			state({ velocity: { x: 4, y: 0, z: 0 } }),
			{ reducedMotion: true },
		);
		expect(normal.braking).toBe(1);
		expect(normal.camera.shake).toBeGreaterThan(0);
		expect(reduced.camera).toMatchObject({
			follow: true,
			shake: 0,
			zoomPulse: 0,
		});
	});

	it("suppresses braking shake while the snowball is stationary", () => {
		const held = createActionState();
		held.brake = true;
		const command = computeSnowballCommand(frame({ held }), state());
		expect(command.braking).toBe(1);
		expect(command.camera.shake).toBe(0);
	});

	it("consumes resetCamera as a one-shot camera command", () => {
		const pressed = createActionState();
		pressed.resetCamera = true;
		const command = computeSnowballCommand(frame({ pressed }), state());
		expect(command.camera.reset).toBe(true);
	});

	it("rejects controller torque boundaries that cannot survive f32 conversion", () => {
		for (const field of ["groundTorque", "turnTorque"] as const) {
			for (const value of [Number.MAX_VALUE, Number.MIN_VALUE]) {
				expect(() =>
					computeSnowballCommand(frame({ move: { x: 1, y: 1 } }), state(), {
						controller: { [field]: value },
					}),
				).toThrow(/f32/u);
			}
		}
		expect(() =>
			computeSnowballCommand(frame(), state(), {
				controller: { coastBraking: Number.MIN_VALUE },
			}),
		).toThrow(/coastBraking.*f32/u);
		const maximumF32 = 3.4028234663852886e38;
		const torque = computeSnowballCommand(
			frame({ move: { x: 0, y: 1 } }),
			state(),
			{ controller: { groundTorque: maximumF32 } },
		);
		const turn = computeSnowballCommand(
			frame({ move: { x: 1, y: 0 } }),
			state(),
			{ controller: { turnTorque: maximumF32 } },
		);
		expect(Math.fround(torque.torque.x)).toBe(torque.torque.x);
		expect(Math.fround(turn.turn)).toBe(turn.turn);
	});
});

describe("camera intent controller", () => {
	it("keeps a stable horizon, applies sensitivity, and delegates collision distance", () => {
		const resolveCollisionDistance = vi.fn(
			(desiredDistance: number) => desiredDistance / 2,
		);
		const camera = createCameraIntentController({
			sensitivity: 2,
			desiredDistance: 8,
			resolveCollisionDistance,
		});
		const intent = camera.update(frame({ look: { x: 1, y: 0.5 } }), {
			deltaSeconds: 0.5,
			shake: 0.4,
			zoomPulse: 0.2,
			reducedMotion: false,
		});
		expect(intent).toMatchObject({
			yaw: 1,
			pitch: 0.5,
			roll: 0,
			horizonUp: { x: 0, y: 1, z: 0 },
			distance: 4,
			shake: 0.4,
			zoomPulse: 0.2,
		});
		expect(resolveCollisionDistance).toHaveBeenCalledWith(8);
		const inverted = createCameraIntentController({
			sensitivity: 2,
			invertY: true,
		});
		const invertedIntent = inverted.update(frame({ look: { x: 0, y: 0.5 } }), {
			deltaSeconds: 0.5,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		expect(invertedIntent.pitch).toBe(-0.5);
	});

	it("supports auto-recenter, reset, reduced motion, and deterministic cleanup", () => {
		const camera = createCameraIntentController({
			sensitivity: 1,
			autoRecenter: true,
			autoRecenterDelaySeconds: 0,
			recenterRate: 1,
		});
		camera.update(frame({ look: { x: 1, y: 0.5 } }), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		const centered = camera.update(frame(), {
			deltaSeconds: 1,
			shake: 0.5,
			zoomPulse: 0.25,
			reducedMotion: true,
		});
		expect(centered).toMatchObject({
			yaw: 0,
			pitch: 0,
			shake: 0,
			zoomPulse: 0,
		});
		camera.reset();
		const reset = camera.update(frame(), {
			deltaSeconds: 1 / 60,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		expect(reset.yaw).toBe(0);
		expect(reset.pitch).toBe(0);
		camera.destroy();
		expect(camera.destroyed).toBe(true);
		expect(() =>
			camera.update(frame(), {
				deltaSeconds: 1 / 60,
				shake: 0,
				zoomPulse: 0,
				reducedMotion: false,
			}),
		).toThrow(/destroyed/u);
	});

	it("resets from the input action with deterministic precedence over look", () => {
		const camera = createCameraIntentController({
			autoRecenter: false,
			sensitivity: 1,
		});
		camera.update(frame({ look: { x: 1, y: 0.5 } }), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		const pressed = createActionState();
		pressed.resetCamera = true;
		const reset = camera.update(frame({ look: { x: 1, y: 0.5 }, pressed }), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		expect(reset).toMatchObject({ yaw: 0, pitch: 0 });
	});

	it("auto-recenters across the wrapped yaw boundary by the shortest angle", () => {
		const camera = createCameraIntentController({
			sensitivity: Math.PI * 2 - 0.1,
			autoRecenter: true,
			autoRecenterDelaySeconds: 0,
			recenterRate: 0.05,
		});
		camera.update(frame({ look: { x: 1, y: 0 } }), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		const recentered = camera.update(frame(), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		expect(recentered.yaw).toBeCloseTo(-0.05, 12);
	});

	it("applies recentering only to time beyond the configured delay", () => {
		const camera = createCameraIntentController({
			sensitivity: 1,
			autoRecenter: true,
			autoRecenterDelaySeconds: 1.5,
			recenterRate: 1,
		});
		camera.update(frame({ look: { x: 1, y: 0 } }), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		camera.update(frame(), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		const recentered = camera.update(frame(), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		expect(recentered.yaw).toBeCloseTo(0.5, 12);
	});

	it("uses the nearest permitted pitch as neutral for positive-only bounds", () => {
		const camera = createCameraIntentController({
			sensitivity: 1,
			autoRecenter: true,
			autoRecenterDelaySeconds: 0,
			recenterRate: 1,
			minimumPitch: 0.25,
			maximumPitch: 0.75,
		});
		const initial = camera.update(frame(), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		expect(initial.pitch).toBe(0.25);
		camera.update(frame({ look: { x: 0, y: 0.5 } }), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		const recentered = camera.update(frame(), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		expect(recentered.pitch).toBe(0.25);
		camera.update(frame({ look: { x: 0, y: 0.5 } }), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		camera.reset();
		const reset = camera.update(frame(), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		expect(reset.pitch).toBe(0.25);
	});

	it("uses the nearest permitted pitch as neutral for negative-only bounds", () => {
		const camera = createCameraIntentController({
			sensitivity: 1,
			autoRecenter: true,
			autoRecenterDelaySeconds: 0,
			recenterRate: 1,
			minimumPitch: -0.75,
			maximumPitch: -0.25,
		});
		const initial = camera.update(frame(), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		expect(initial.pitch).toBe(-0.25);
		camera.update(frame({ look: { x: 0, y: -0.5 } }), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		const recentered = camera.update(frame(), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		expect(recentered.pitch).toBe(-0.25);
		const pressed = createActionState();
		pressed.resetCamera = true;
		const reset = camera.update(frame({ pressed }), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		expect(reset.pitch).toBe(-0.25);
	});

	it("never emits zero outside tiny positive-only or negative-only bounds", () => {
		for (const [
			minimumPitch,
			maximumPitch,
			neutralPitch,
			movedPitch,
			lookY,
		] of [
			[
				Number.MIN_VALUE,
				Number.MIN_VALUE * 2,
				Number.MIN_VALUE,
				Number.MIN_VALUE * 2,
				1,
			],
			[
				-Number.MIN_VALUE * 2,
				-Number.MIN_VALUE,
				-Number.MIN_VALUE,
				-Number.MIN_VALUE * 2,
				-1,
			],
		] as const) {
			const camera = createCameraIntentController({
				minimumPitch,
				maximumPitch,
				sensitivity: Number.MIN_VALUE,
			});
			const initial = camera.update(frame(), {
				deltaSeconds: 1,
				shake: 0,
				zoomPulse: 0,
				reducedMotion: false,
			});
			expect(initial.pitch).toBe(neutralPitch);
			const moved = camera.update(frame({ look: { x: 0, y: lookY } }), {
				deltaSeconds: 1,
				shake: 0,
				zoomPulse: 0,
				reducedMotion: false,
			});
			expect(moved.pitch).toBe(movedPitch);
		}
	});

	it("keeps auto-recenter finite across huge accepted idle frames", () => {
		const camera = createCameraIntentController({
			sensitivity: 1,
			autoRecenter: true,
			autoRecenterDelaySeconds: 0,
			recenterRate: 0,
		});
		camera.update(frame({ look: { x: 0.5, y: 0.5 } }), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		const idleFrame = {
			deltaSeconds: Number.MAX_VALUE,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		} as const;
		camera.update(frame(), idleFrame);
		const afterOverflowingElapsedTotal = camera.update(frame(), idleFrame);
		expect(afterOverflowingElapsedTotal.yaw).toBe(0.5);
		expect(afterOverflowingElapsedTotal.pitch).toBe(0.5);
	});

	it("rejects a finite input combination whose yaw delta overflows", () => {
		const camera = createCameraIntentController({
			sensitivity: Number.MAX_VALUE,
			autoRecenter: false,
		});
		expect(() =>
			camera.update(frame({ look: { x: 1, y: 0 } }), {
				deltaSeconds: 2,
				shake: 0,
				zoomPulse: 0,
				reducedMotion: false,
			}),
		).toThrow(/yaw delta must be finite/u);
	});

	it("runtime-validates every camera option type", () => {
		for (const option of [
			"sensitivity",
			"autoRecenterDelaySeconds",
			"recenterRate",
			"minimumPitch",
			"maximumPitch",
			"desiredDistance",
			"minimumDistance",
		] as const) {
			expect(() =>
				createCameraIntentController({
					[option]: "not-a-number",
				} as never),
			).toThrow(/finite number/u);
		}
		for (const option of ["invertY", "autoRecenter"] as const) {
			expect(() =>
				createCameraIntentController({ [option]: "false" } as never),
			).toThrow(/boolean/u);
		}
		expect(() =>
			createCameraIntentController({
				resolveCollisionDistance: 1,
			} as never),
		).toThrow(/resolver must be a function/u);

		const camera = createCameraIntentController();
		for (const option of ["deltaSeconds", "shake", "zoomPulse"] as const) {
			expect(() =>
				camera.update(frame(), {
					deltaSeconds: 1,
					shake: 0,
					zoomPulse: 0,
					reducedMotion: false,
					[option]: "not-a-number",
				} as never),
			).toThrow(/finite number/u);
		}
		expect(() =>
			camera.update(frame(), {
				deltaSeconds: 1,
				shake: 0,
				zoomPulse: 0,
				reducedMotion: "false",
			} as never),
		).toThrow(/reducedMotion must be boolean/u);
	});

	it("rejects overflowing look, pitch, and recenter derivations", () => {
		const camera = createCameraIntentController({
			sensitivity: 2,
			autoRecenter: false,
		});
		expect(() =>
			camera.update(
				frame({
					look: { x: Number.MAX_VALUE, y: Number.MAX_VALUE },
				}),
				{
					deltaSeconds: 1,
					shake: 0,
					zoomPulse: 0,
					reducedMotion: false,
				},
			),
		).toThrow(/look magnitude must be finite/u);
		expect(() =>
			camera.update(frame({ look: { x: 0, y: Number.MAX_VALUE } }), {
				deltaSeconds: 1,
				shake: 0,
				zoomPulse: 0,
				reducedMotion: false,
			}),
		).toThrow(/pitch delta must be finite/u);

		const recentering = createCameraIntentController({
			autoRecenter: true,
			autoRecenterDelaySeconds: 0,
			recenterRate: Number.MAX_VALUE,
		});
		recentering.update(frame({ look: { x: 0.5, y: 0 } }), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		expect(() =>
			recentering.update(frame(), {
				deltaSeconds: Number.MAX_VALUE,
				shake: 0,
				zoomPulse: 0,
				reducedMotion: false,
			}),
		).toThrow(/recenter delta must be finite/u);
	});

	it("never consults the collision resolver after terminal destroy", () => {
		const resolveCollisionDistance = vi.fn((distance: number) => distance);
		const camera = createCameraIntentController({ resolveCollisionDistance });
		camera.update(frame(), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		camera.destroy();
		expect(() =>
			camera.update(frame(), {
				deltaSeconds: 1,
				shake: 0,
				zoomPulse: 0,
				reducedMotion: false,
			}),
		).toThrow(/destroyed/u);
		expect(resolveCollisionDistance).toHaveBeenCalledTimes(1);
	});

	it("does not commit camera state when collision resolution rejects a frame", () => {
		let collisionDistance = Number.NaN;
		const camera = createCameraIntentController({
			autoRecenter: false,
			resolveCollisionDistance: () => collisionDistance,
		});
		expect(() =>
			camera.update(frame({ look: { x: 1, y: 0.5 } }), {
				deltaSeconds: 1,
				shake: 0,
				zoomPulse: 0,
				reducedMotion: false,
			}),
		).toThrow(/collision distance must be finite/u);
		collisionDistance = 6;
		const afterRejectedFrame = camera.update(frame(), {
			deltaSeconds: 1,
			shake: 0,
			zoomPulse: 0,
			reducedMotion: false,
		});
		expect(afterRejectedFrame).toMatchObject({ yaw: 0, pitch: 0 });
	});

	it("rejects recursive camera updates from the collision resolver", () => {
		let camera!: CameraIntentController;
		let recurse = true;
		camera = createCameraIntentController({
			resolveCollisionDistance: (desiredDistance) => {
				if (recurse) {
					recurse = false;
					camera.update(frame(), {
						deltaSeconds: 1,
						shake: 0,
						zoomPulse: 0,
						reducedMotion: false,
					});
				}
				return desiredDistance;
			},
		});
		expect(() =>
			camera.update(frame(), {
				deltaSeconds: 1,
				shake: 0,
				zoomPulse: 0,
				reducedMotion: false,
			}),
		).toThrow(/update is already in progress/u);
	});

	it("rejects an outer camera update when its resolver destroys the controller", () => {
		let camera!: CameraIntentController;
		camera = createCameraIntentController({
			resolveCollisionDistance: (desiredDistance) => {
				camera.destroy();
				return desiredDistance;
			},
		});
		expect(() =>
			camera.update(frame(), {
				deltaSeconds: 1,
				shake: 0,
				zoomPulse: 0,
				reducedMotion: false,
			}),
		).toThrow(/destroyed/u);
		expect(camera.destroyed).toBe(true);
	});
});

describe("growth and deterministic collection", () => {
	it("canonicalizes accepted non-negative zero scalars in facts and collection output", () => {
		const initial = createInitialSnowballFacts({ mass: -0, score: -0 });
		const restarted = restartSnowballFacts(initial, { mass: -0, score: -0 });
		const audioInputs: Readonly<CollectionAudioHookInput>[] = [];
		const result = collectObjects(
			state({ volume: -0, mass: -0, score: -0, slopeRadians: -0 }),
			[
				candidate({
					requiredRadius: -0,
					volume: -0,
					mass: -0,
					points: -0,
				}),
			],
			0,
			{
				...collectionOptions(-0),
				resolveAudioCue: (event) => {
					audioInputs.push(event);
					return "collect:zero";
				},
			},
		);
		const publicFactAndScoreValues = [
			initial.radius,
			initial.volume,
			initial.mass,
			initial.score,
			restarted.radius,
			restarted.volume,
			restarted.mass,
			restarted.score,
			result.state.radius,
			result.state.volume,
			result.state.mass,
			result.state.score,
			result.state.slopeRadians,
			result.objective.currentScore,
			result.objective.targetScore,
			...result.events.flatMap((event) =>
				event.kind === "score"
					? [event.points, event.totalScore]
					: [event.targetScore, event.totalScore],
			),
			...audioInputs.flatMap((event) => [
				event.points,
				event.radiusBefore,
				event.radiusAfter,
			]),
		];
		for (const value of publicFactAndScoreValues) {
			expect(Object.is(value, -0)).toBe(false);
		}
		expect(Object.isFrozen(initial)).toBe(true);
		expect(Object.isFrozen(restarted)).toBe(true);
		expect(Object.isFrozen(result.state)).toBe(true);
		expect(Object.isFrozen(result.events[0])).toBe(true);
		expect(Object.isFrozen(audioInputs[0])).toBe(true);
	});

	it("requires a real candidate array without consulting array-like iterators", () => {
		let iteratorRequested = false;
		const arrayLike = {
			length: 0,
			[Symbol.iterator]() {
				iteratorRequested = true;
				return [][Symbol.iterator]();
			},
		};
		expect(() =>
			collectObjects(state(), arrayLike as never, 0, collectionOptions()),
		).toThrow(/candidate array/u);
		expect(iteratorRequested).toBe(false);
	});

	it("rejects oversized candidate batches before candidate getters or resolvers", () => {
		let candidateGetterCalls = 0;
		const guardedCandidate = {
			...candidate(),
			get id() {
				candidateGetterCalls += 1;
				return "guarded";
			},
		};
		const resolveAudioCue = vi.fn(() => "collect:guarded");
		let thrown: unknown;
		try {
			collectObjects(
				state(),
				Array.from({ length: 4_097 }, () => guardedCandidate),
				0,
				{ ...collectionOptions(), resolveAudioCue },
			);
		} catch (error) {
			thrown = error;
		}
		expect(candidateGetterCalls).toBe(0);
		expect(resolveAudioCue).not.toHaveBeenCalled();
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toMatch(/maximum of 4096/u);
	});

	it("uses one captured bounded array length without calling owned methods", () => {
		let lengthReads = 0;
		const proxied = new Proxy([candidate()], {
			get(target, property, receiver) {
				if (property === "length") {
					lengthReads += 1;
					return lengthReads === 1 ? 1 : 4_097;
				}
				return Reflect.get(target, property, receiver);
			},
		});
		Object.defineProperty(proxied, "map", {
			value: () => {
				throw new Error("input-owned map must not run");
			},
		});
		const result = collectObjects(state(), proxied, 0, collectionOptions());
		expect(result.collected).toHaveLength(1);
		expect(lengthReads).toBe(1);
	});

	it("requires bounded primitive IDs and rejects duplicate primitive IDs", () => {
		expect(() =>
			collectObjects(state(), [], 0, {
				...collectionOptions(),
				collectorId: "x".repeat(257),
			}),
		).toThrow(/collector ID.*256/u);
		expect(() =>
			collectObjects(
				state(),
				[candidate({ id: "x".repeat(257) })],
				0,
				collectionOptions(),
			),
		).toThrow(/collectible ID.*256/u);
		expect(() =>
			collectObjects(
				state(),
				[
					candidate({
						currentOwnerId: "x".repeat(257),
					}),
				],
				0,
				collectionOptions(),
			),
		).toThrow(/current owner ID.*256/u);
		expect(() =>
			collectObjects(
				state(),
				[
					candidate({
						id: new String("boxed") as unknown as string,
					}),
				],
				0,
				collectionOptions(),
			),
		).toThrow(/collectible ID must be a primitive string/u);
		expect(() =>
			collectObjects(
				state(),
				[candidate({ id: "duplicate" }), candidate({ id: "duplicate" })],
				0,
				collectionOptions(),
			),
		).toThrow(/duplicate collectible ID/u);
	});

	it("runtime-validates the audio resolver and its bounded primitive cues", () => {
		expect(() =>
			collectObjects(state(), [], 0, {
				...collectionOptions(),
				resolveAudioCue: 1 as never,
			}),
		).toThrow(/audio cue resolver must be a function/u);
		expect(() =>
			collectObjects(state(), [candidate()], 0, {
				...collectionOptions(),
				resolveAudioCue: () => new String("boxed") as unknown as string,
			}),
		).toThrow(/audio cue must be a primitive string/u);
		expect(() =>
			collectObjects(state(), [candidate()], 0, {
				...collectionOptions(),
				resolveAudioCue: () => "x".repeat(257),
			}),
		).toThrow(/audio cue.*256/u);
	});

	it("defers audio resolution until every candidate transition validates", () => {
		const resolveAudioCue = vi.fn(() => "collect");
		expect(() =>
			collectObjects(
				state(),
				[
					candidate({ id: "a-valid" }),
					candidate({
						id: "b-invalid",
						worldPose: {
							position: { x: Number.NaN, y: 0, z: 0 },
							rotation: { x: 0, y: 0, z: 0, w: 1 },
							scale: { x: 1, y: 1, z: 1 },
						},
					}),
				],
				0,
				{ ...collectionOptions(), resolveAudioCue },
			),
		).toThrow(/vector\.x must be finite/u);
		expect(resolveAudioCue).not.toHaveBeenCalled();
	});

	it("defers audio resolution until the next state is fully validated", () => {
		const resolveAudioCue = vi.fn(() => "collect");
		expect(() =>
			collectObjects(
				state({
					velocity: { x: Number.NaN, y: 0, z: 0 },
				}),
				[candidate({ id: "valid" })],
				0,
				{ ...collectionOptions(), resolveAudioCue },
			),
		).toThrow(/vector\.x must be finite/u);
		expect(resolveAudioCue).not.toHaveBeenCalled();
	});
	it("normalizes an unavailable airborne slope but rejects it when grounded", () => {
		for (const unavailableSlope of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			const result = collectObjects(
				state({ grounded: false, slopeRadians: unavailableSlope }),
				[],
				0,
				collectionOptions(),
			);
			expect(result.state.slopeRadians).toBe(0);
		}
		expect(() =>
			collectObjects(
				state({ grounded: true, slopeRadians: Number.NaN }),
				[],
				0,
				collectionOptions(),
			),
		).toThrow(/slopeRadians must be finite/u);
	});
	it("normalizes extreme finite quaternion operands before deriving local rotation", () => {
		const parentRotation = Object.freeze({ x: 0.5, y: 0.5, z: 0.5, w: 0.5 });
		const extremeRotation = Object.freeze({
			x: Number.MAX_VALUE,
			y: Number.MAX_VALUE,
			z: Number.MAX_VALUE,
			w: Number.MAX_VALUE,
		});
		const extremeCandidate = candidate({
			worldPose: {
				position: { x: 1, y: 0, z: 0 },
				rotation: extremeRotation,
				scale: { x: 1, y: 1, z: 1 },
			},
		});
		const first = collectObjects(
			state({ rotation: parentRotation }),
			[extremeCandidate],
			0,
			collectionOptions(),
		);
		const second = collectObjects(
			state({ rotation: parentRotation }),
			[extremeCandidate],
			0,
			collectionOptions(),
		);
		const localRotation = first.collected[0]?.attachment.localPose.rotation;
		expect(localRotation).toBeDefined();
		if (localRotation === undefined) {
			throw new Error("expected the extreme candidate to be collected");
		}
		expect(
			Object.values(localRotation).every((component) =>
				Number.isFinite(component),
			),
		).toBe(true);
		expect(
			Math.hypot(
				localRotation.x,
				localRotation.y,
				localRotation.z,
				localRotation.w,
			),
		).toBeCloseTo(1, 12);
		expect(localRotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
		expect(second.collected[0]?.attachment.localPose.rotation).toEqual(
			localRotation,
		);
		expect(Object.isFrozen(localRotation)).toBe(true);
		expect(extremeCandidate.worldPose.rotation).toBe(extremeRotation);
	});

	it("uses exact cubic-volume radius growth within the safe f32 range", () => {
		expect(growRadius(2, 19)).toBeCloseTo(3, 12);
		expect(growRadius(1, 0)).toBe(1);
		const smallRadius = 1e-40;
		expect(growRadius(smallRadius, 0)).toBe(smallRadius);
		expect(() => growRadius(0, 1)).toThrow(/radius/u);
	});

	it("rejects snowball radius and mass that cannot survive f32 conversion", () => {
		for (const radius of [Number.MAX_VALUE, Number.MIN_VALUE]) {
			expect(() => createInitialSnowballFacts({ radius })).toThrow(
				/radius.*f32/u,
			);
			expect(() => growRadius(radius, 0)).toThrow(/radius.*f32/u);
		}
		for (const mass of [Number.MAX_VALUE, Number.MIN_VALUE]) {
			expect(() => createInitialSnowballFacts({ mass })).toThrow(/mass.*f32/u);
		}
		expect(() => growRadius(3.4028234663852886e38, Number.MAX_VALUE)).toThrow(
			/grown radius.*f32/u,
		);
		expect(createInitialSnowballFacts({ mass: 0 }).mass).toBe(0);
	});

	it("returns finite positive JSON facts at the maximum f32 scale", () => {
		const facts = createInitialSnowballFacts({
			radius: 3e38,
			mass: 3e38,
		});
		expect(Number.isFinite(facts.volume)).toBe(true);
		expect(facts.volume).toBeGreaterThan(0);
		expect(Math.fround(facts.radius)).toBeGreaterThan(0);
		expect(Math.fround(facts.mass)).toBeGreaterThan(0);
		expect(JSON.parse(JSON.stringify(facts))).toEqual(facts);
	});

	it("sorts eligible collections, grows aggregate facts, scores, and disables bodies by next tick", () => {
		const resolveAudioCue = vi.fn(
			(event: Readonly<{ entityId: string }>) => `collect:${event.entityId}`,
		);
		const result = collectObjects(
			state({ position: { x: 1, y: 0, z: 0 }, score: 5 }),
			[
				candidate({ id: "z", points: 3, volume: 0.25, mass: 0.5 }),
				candidate({ id: "a", points: 7, volume: 0.125, mass: 0.25 }),
				candidate({ id: "too-large", requiredRadius: 9 }),
			],
			10,
			{
				...collectionOptions(12),
				resolveAudioCue,
			},
		);
		expect(result.collected.map((entry) => entry.entityId)).toEqual(["a", "z"]);
		expect(result.remainingIds).toEqual(["too-large"]);
		expect(result.state.score).toBe(15);
		expect(result.state.volume).toBeCloseTo(1.375, 12);
		expect(result.state.mass).toBeCloseTo(1.75, 12);
		expect(result.state.radius).toBeCloseTo(Math.cbrt(1.375), 12);
		expect(result.objective).toEqual({
			currentScore: 15,
			targetScore: 12,
			complete: true,
		});
		expect(result.events).toEqual([
			{
				kind: "score",
				entityId: "a",
				sequence: 0,
				points: 7,
				totalScore: 12,
			},
			{
				kind: "objective-complete",
				entityId: "a",
				sequence: 1,
				targetScore: 12,
				totalScore: 12,
			},
			{
				kind: "score",
				entityId: "z",
				sequence: 2,
				points: 3,
				totalScore: 15,
			},
		]);
		expect(result.audioEvents).toEqual([
			{ entityId: "a", cue: "collect:a", sequence: 0 },
			{ entityId: "z", cue: "collect:z", sequence: 1 },
		]);
		expect(resolveAudioCue.mock.calls.map(([event]) => event.entityId)).toEqual(
			["a", "z"],
		);
		for (const entry of result.collected) {
			expect(entry.disableBodyAtTick).toBe(11);
			expect(entry.attachment.parentId).toBe("snowball-player");
			expect(entry.attachment.rigidBody).toBeUndefined();
			expect(entry.attachment.joint).toBeUndefined();
		}
		expect(result.collected[0]?.attachment.localPose.position).toEqual({
			x: 0,
			y: 0,
			z: 0,
		});
	});

	it("freezes eligibility at the tick-start radius before applying growth", () => {
		const first = candidate({
			id: "a-small",
			requiredRadius: 1,
			volume: 7,
			points: 1,
		});
		const second = candidate({
			id: "b-later",
			requiredRadius: 1.9,
			volume: 1,
			points: 1,
		});
		const result = collectObjects(
			state(),
			[second, first],
			2,
			collectionOptions(99),
		);
		expect(result.collected.map((entry) => entry.entityId)).toEqual([
			"a-small",
		]);
		expect(result.remainingIds).toEqual(["b-later"]);
		expect(result.state.radius).toBeCloseTo(2, 12);
	});

	it("skips already-owned candidates in deterministic ID order", () => {
		const result = collectObjects(
			state(),
			[
				candidate({ id: "z-owned", currentOwnerId: "another-snowball" }),
				candidate({ id: "a-free" }),
				candidate({ id: "b-owned", currentOwnerId: "snowball-player" }),
			],
			7,
			collectionOptions(),
		);
		expect(result.collected.map((entry) => entry.entityId)).toEqual(["a-free"]);
		expect(result.remainingIds).toEqual(["b-owned", "z-owned"]);
	});

	it("rejects collection results that cannot remain finite JSON data", () => {
		expect(() =>
			collectObjects(
				state({ mass: Number.MAX_VALUE, score: Number.MAX_VALUE }),
				[
					candidate({
						volume: 0,
						mass: Number.MAX_VALUE,
						points: Number.MAX_VALUE,
					}),
				],
				1,
				collectionOptions(Number.MAX_VALUE),
			),
		).toThrow(/snowball mass must be finite/u);
	});

	it("rejects collection-derived snowball mass outside the safe f32 range", () => {
		expect(() =>
			collectObjects(
				state({ mass: 3e38 }),
				[candidate({ mass: 3e38, volume: 0 })],
				1,
				collectionOptions(),
			),
		).toThrow(/snowball mass.*f32/u);
		expect(() =>
			collectObjects(
				state({ mass: Number.MIN_VALUE }),
				[],
				1,
				collectionOptions(),
			),
		).toThrow(/snowball mass.*f32/u);
	});
	it("rejects a tick whose next-tick retirement deadline is unsafe", () => {
		expect(() =>
			collectObjects(
				state(),
				[candidate()],
				Number.MAX_SAFE_INTEGER,
				collectionOptions(),
			),
		).toThrow(/retirement tick/u);
	});

	it("returns data-only local poses and JSON-round-trippable snapshots", () => {
		const result = collectObjects(
			state({ position: { x: 1, y: 2, z: 3 } }),
			[
				candidate({
					worldPose: {
						position: { x: 3, y: 5, z: 7 },
						rotation: { x: 0, y: 0, z: 0, w: 1 },
						scale: { x: 2, y: 2, z: 2 },
					},
				}),
			],
			4,
			collectionOptions(),
		);
		expect(result.collected[0]?.attachment.localPose.position).toEqual({
			x: 2,
			y: 3,
			z: 4,
		});
		expect(JSON.parse(JSON.stringify(result))).toEqual(result);
		expect(JSON.stringify(result)).not.toContain("function");
	});
});

describe("restart facts", () => {
	it("creates isolated initial facts and deterministic restart snapshots", () => {
		const first = createInitialSnowballFacts({
			radius: 1.5,
			mass: 2,
			score: 3,
		});
		const second = createInitialSnowballFacts({
			radius: 1.5,
			mass: 2,
			score: 3,
		});
		expect(first).toEqual(second);
		expect(first).not.toBe(second);
		const restarted = restartSnowballFacts(first, {
			radius: 0.75,
			mass: 1,
			score: 0,
		});
		expect(restarted).toMatchObject({
			radius: 0.75,
			mass: 1,
			score: 0,
			volume: 0.75 ** 3,
		});
		expect(first.radius).toBe(1.5);
	});
});
