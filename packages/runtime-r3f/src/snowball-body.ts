import type { SnowballCommand } from "@infinite-snowball/gameplay";
import {
	requireFiniteF32,
	requireNonNegativeFiniteF32,
	requirePositiveFiniteF32,
	setFiniteF32Vector3,
} from "./rapier-scalar.js";

export interface SnowballBodyFacts {
	readonly radius: number;
	readonly mass: number;
}

export interface SnowballRigidBodyConfig {
	readonly colliderRadius: number;
	readonly additionalMass: number;
	readonly ccd: true;
	readonly canSleep: true;
}

export interface SnowballRigidBodyHandle {
	addTorque(
		torque: Readonly<{ x: number; y: number; z: number }>,
		wakeUp: boolean,
	): void;
	applyImpulse(
		impulse: Readonly<{ x: number; y: number; z: number }>,
		wakeUp: boolean,
	): void;
	linvel(): Readonly<{ x: number; y: number; z: number }>;
	setLinvel(
		velocity: Readonly<{ x: number; y: number; z: number }>,
		wakeUp: boolean,
	): void;
}

export interface SnowballColliderHandle {
	setRadius(radius: number): void;
	setMass(mass: number): void;
}

export interface SnowballCollisionEventHandle<TActiveEvents extends number> {
	setActiveEvents(activeEvents: TActiveEvents): void;
}

export interface SnowballGrowthBodyHandle {
	recomputeMassPropertiesFromColliders(): void;
}

export interface RetirableRigidBody {
	setEnabled(enabled: boolean): void;
}

export interface CollectedBodyRetirementQueue<
	TBody extends RetirableRigidBody,
> {
	collect(stableId: string, body: TBody, disableBodyAtTick: number): void;
	flush(tick: number): readonly string[];
	reset(): void;
	destroy(): void;
	readonly size: number;
}

export function createSnowballRigidBodyPosition(
	position: readonly [number, number, number],
): readonly [number, number, number] {
	return Object.freeze([
		requireFiniteF32(position[0], "snowball position.x"),
		requireFiniteF32(position[1], "snowball position.y"),
		requireFiniteF32(position[2], "snowball position.z"),
	]);
}

export function createSnowballRigidBodyConfig(
	facts: SnowballBodyFacts,
): SnowballRigidBodyConfig {
	const radius = requirePositiveFiniteF32(facts.radius, "snowball radius");
	const mass = requireNonNegativeFiniteF32(facts.mass, "snowball mass");
	const colliderRadius = requirePositiveFiniteF32(
		radius * 0.95,
		"snowball collider radius",
	);
	return Object.freeze({
		colliderRadius,
		additionalMass: mass,
		ccd: true,
		canSleep: true,
	});
}

export function applySnowballGrowthInPlace(
	collider: SnowballColliderHandle,
	body: SnowballGrowthBodyHandle,
	facts: SnowballBodyFacts,
): void {
	const config = createSnowballRigidBodyConfig(facts);
	collider.setRadius(config.colliderRadius);
	collider.setMass(config.additionalMass);
	body.recomputeMassPropertiesFromColliders();
}

export function createCollectedBodyRetirementQueue<
	TBody extends RetirableRigidBody,
>(removeRigidBody: (body: TBody) => void): CollectedBodyRetirementQueue<TBody> {
	const pending = new Map<
		string,
		Readonly<{ body: TBody; disableBodyAtTick: number }>
	>();
	let destroyed = false;
	let lastFlushTick = -1;

	function assertAlive(): void {
		if (destroyed)
			throw new Error("collected-body retirement queue is destroyed");
	}

	function retirePending(stableIds: readonly string[]): void {
		const failures: unknown[] = [];
		for (const stableId of stableIds) {
			const entry = pending.get(stableId);
			if (entry === undefined) continue;
			try {
				removeRigidBody(entry.body);
				pending.delete(stableId);
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(
				failures,
				"one or more collected rigid bodies could not be retired",
			);
		}
	}

	const queue: CollectedBodyRetirementQueue<TBody> = {
		collect(stableId, body, disableBodyAtTick) {
			assertAlive();
			if (stableId.length === 0) {
				throw new Error("collected body stable ID must not be empty");
			}
			if (!Number.isSafeInteger(disableBodyAtTick) || disableBodyAtTick < 0) {
				throw new Error(
					"disable-body tick must be a non-negative safe integer",
				);
			}
			if (pending.has(stableId)) {
				throw new Error(`duplicate pending collected body: ${stableId}`);
			}
			body.setEnabled(false);
			pending.set(stableId, Object.freeze({ body, disableBodyAtTick }));
		},
		flush(tick) {
			assertAlive();
			if (!Number.isSafeInteger(tick) || tick < 0 || tick <= lastFlushTick) {
				throw new Error("retirement flush tick must increase monotonically");
			}
			const removed: string[] = [];
			const dueStableIds: string[] = [];
			for (const stableId of [...pending.keys()].sort()) {
				const entry = pending.get(stableId);
				if (entry === undefined || entry.disableBodyAtTick > tick) continue;
				dueStableIds.push(stableId);
			}
			retirePending(dueStableIds);
			removed.push(...dueStableIds);
			lastFlushTick = tick;
			return Object.freeze(removed);
		},
		reset() {
			assertAlive();
			retirePending([...pending.keys()].sort());
			lastFlushTick = -1;
		},
		destroy() {
			if (destroyed) return;
			retirePending([...pending.keys()].sort());
			destroyed = true;
		},
		get size() {
			return pending.size;
		},
	};
	return Object.freeze(queue);
}

export function enableSnowballCollisionEvents<TActiveEvents extends number>(
	collider: SnowballCollisionEventHandle<TActiveEvents>,
	collisionEvents: TActiveEvents,
): void {
	if (
		!Number.isSafeInteger(collisionEvents) ||
		collisionEvents < 0 ||
		collisionEvents > 3
	) {
		throw new Error("collision event flags must use the supported mask 0..3");
	}
	collider.setActiveEvents(collisionEvents);
}

export function applySnowballPhysicsCommand(
	handle: SnowballRigidBodyHandle,
	command: Readonly<SnowballCommand>,
): void {
	const torque = { x: 0, y: 0, z: 0 };
	setFiniteF32Vector3(
		torque,
		{
			x: command.torque.x,
			y: command.torque.y + command.turn,
			z: command.torque.z,
		},
		"snowball torque",
	);

	let impulse: { x: number; y: number; z: number } | undefined;
	if (command.boost) {
		impulse = { x: 0, y: 0, z: 0 };
		setFiniteF32Vector3(
			impulse,
			{
				x: command.torque.x * 0.5,
				y: 0,
				z: command.torque.z * 0.5,
			},
			"snowball boost impulse",
		);
	}

	let velocity: { x: number; y: number; z: number } | undefined;
	if (command.braking > 0) {
		const currentVelocity = handle.linvel();
		const scale = Math.max(0, 1 - Math.min(1, command.braking));
		velocity = { x: 0, y: 0, z: 0 };
		setFiniteF32Vector3(
			velocity,
			{
				x: currentVelocity.x * scale,
				y: currentVelocity.y,
				z: currentVelocity.z * scale,
			},
			"snowball velocity",
		);
	}

	handle.addTorque(torque, true);
	if (velocity !== undefined) handle.setLinvel(velocity, true);
	if (impulse !== undefined) handle.applyImpulse(impulse, true);
}
