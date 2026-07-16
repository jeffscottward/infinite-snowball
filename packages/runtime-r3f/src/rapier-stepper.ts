import { FIXED_STEP_SECONDS } from "@infinite-snowball/engine";

import type { PhysicsEventBuffer } from "./events.js";

export type ColliderEntityResolver = (
	colliderHandle: number,
) => string | undefined;

export interface RawRapierEventQueue {
	drainCollisionEvents(
		callback: (
			firstHandle: number,
			secondHandle: number,
			started: boolean,
		) => void,
	): void;
}

export interface RawRapierWorld<TQueue extends RawRapierEventQueue> {
	timestep: number;
	step(queue: TQueue): void;
}

export interface RawRapierStepper {
	step(deltaSeconds: number, tick: number): void;
	reset(): void;
	destroy(): void;
}

export interface RawRapierStepperOptions<TQueue extends RawRapierEventQueue> {
	readonly world: RawRapierWorld<TQueue>;
	readonly queue: TQueue;
	readonly events: PhysicsEventBuffer;
	readonly resolveColliderEntityId: ColliderEntityResolver;
}

function ordinal(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function createRawRapierStepper<TQueue extends RawRapierEventQueue>(
	options: RawRapierStepperOptions<TQueue>,
): RawRapierStepper {
	let destroyed = false;
	let lastTick = -1;
	let sequence = 0;

	function assertAlive(): void {
		if (destroyed) throw new Error("raw Rapier stepper is destroyed");
	}

	const stepper: RawRapierStepper = {
		step(deltaSeconds, tick) {
			assertAlive();
			if (!Number.isFinite(deltaSeconds)) {
				throw new Error("raw Rapier step delta must be finite");
			}
			if (Math.abs(deltaSeconds - FIXED_STEP_SECONDS) > Number.EPSILON) {
				throw new Error(
					"raw Rapier step must use the fixed simulation interval",
				);
			}
			if (!Number.isSafeInteger(tick) || tick < 0 || tick <= lastTick) {
				throw new Error("raw Rapier tick must increase monotonically");
			}
			lastTick = tick;
			options.world.timestep = FIXED_STEP_SECONDS;
			options.world.step(options.queue);
			options.queue.drainCollisionEvents(
				(firstHandle, secondHandle, started) => {
					const firstId = options.resolveColliderEntityId(firstHandle);
					const secondId = options.resolveColliderEntityId(secondHandle);
					if (
						firstId === undefined ||
						secondId === undefined ||
						firstId === secondId
					) {
						return;
					}
					if (!Number.isSafeInteger(sequence)) {
						throw new Error(
							"collision event sequence exceeded the safe integer range",
						);
					}
					const firstComesFirst = ordinal(firstId, secondId) <= 0;
					const entityId = firstComesFirst ? firstId : secondId;
					const otherEntityId = firstComesFirst ? secondId : firstId;
					options.events.push({
						entityId,
						otherEntityId,
						kind: started ? "collision-start" : "collision-end",
						sequence,
						payload: { tick },
					});
					sequence += 1;
				},
			);
		},
		reset() {
			assertAlive();
			lastTick = -1;
			sequence = 0;
		},
		destroy() {
			if (destroyed) return;
			destroyed = true;
		},
	};
	return Object.freeze(stepper);
}
