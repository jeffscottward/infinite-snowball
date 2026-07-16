import { FIXED_STEP_SECONDS } from "@infinite-snowball/engine";
import { Physics, type PhysicsProps, useRapier } from "@react-three/rapier";
import { type ReactNode, useLayoutEffect, useRef } from "react";

import type { PhysicsEventBuffer } from "./events.js";
import {
	type ColliderEntityResolver,
	createRawRapierStepper,
	type RawRapierStepper,
} from "./rapier-stepper.js";

export interface ManualRapierBridge {
	stepPhysics(deltaSeconds: number, tick: number): void;
	reset(): void;
}

interface RevocableManualRapierBridge {
	readonly bridge: ManualRapierBridge;
	revoke(): void;
}

function createRevocableManualRapierBridge(
	stepper: Pick<RawRapierStepper, "reset" | "step">,
	events: PhysicsEventBuffer,
): RevocableManualRapierBridge {
	let revoked = false;
	function assertAvailable(): void {
		if (revoked) throw new Error("manual Rapier bridge is revoked");
	}
	const bridge: ManualRapierBridge = Object.freeze({
		stepPhysics(deltaSeconds: number, tick: number) {
			assertAvailable();
			stepper.step(deltaSeconds, tick);
		},
		reset() {
			assertAvailable();
			try {
				stepper.reset();
			} finally {
				events.clear();
			}
		},
	});
	return Object.freeze({
		bridge,
		revoke() {
			revoked = true;
		},
	});
}

export function createManualRapierBridge(
	stepper: Pick<RawRapierStepper, "reset" | "step">,
	events: PhysicsEventBuffer,
): ManualRapierBridge {
	return createRevocableManualRapierBridge(stepper, events).bridge;
}

type ManualRapierBridgeCallback = (bridge: ManualRapierBridge | null) => void;

export interface ManualRapierBinding {
	readonly bridge: ManualRapierBridge;
	setOnBridge(onBridge: ManualRapierBridgeCallback | undefined): void;
	destroy(): void;
	readonly destroyed: boolean;
}

export function createManualRapierBinding(
	stepper: Pick<RawRapierStepper, "destroy" | "reset" | "step">,
	events: PhysicsEventBuffer,
	queue: Readonly<{ free(): void }>,
	onBridge?: ManualRapierBridgeCallback,
): ManualRapierBinding {
	const revocable = createRevocableManualRapierBridge(stepper, events);
	let callback = onBridge;
	let requestedCallback = onBridge;
	let transferInProgress = false;
	let destroyed = false;
	let transferGeneration = 0;

	const binding: ManualRapierBinding = {
		bridge: revocable.bridge,
		setOnBridge(nextCallback) {
			if (destroyed) throw new Error("manual Rapier binding is destroyed");
			if (
				(!transferInProgress && callback === nextCallback) ||
				(transferInProgress && requestedCallback === nextCallback)
			) {
				return;
			}
			const previousCallback = callback;
			requestedCallback = nextCallback;
			transferInProgress = true;
			callback = undefined;
			transferGeneration += 1;
			const generation = transferGeneration;
			let releaseFailed = false;
			let releaseFailure: unknown;
			try {
				previousCallback?.(null);
			} catch (error) {
				releaseFailed = true;
				releaseFailure = error;
			}
			if (destroyed || generation !== transferGeneration) {
				if (releaseFailed) throw releaseFailure;
				return;
			}

			callback = nextCallback;
			let publicationFailed = false;
			let publicationFailure: unknown;
			try {
				nextCallback?.(revocable.bridge);
			} catch (error) {
				publicationFailed = true;
				publicationFailure = error;
			}
			if (generation === transferGeneration) {
				transferInProgress = false;
			}
			const publicationOwnsBinding =
				!destroyed && generation === transferGeneration;
			if (publicationFailed) {
				const failures = releaseFailed
					? [releaseFailure, publicationFailure]
					: [publicationFailure];
				if (publicationOwnsBinding) {
					try {
						binding.destroy();
					} catch (error) {
						failures.push(error);
					}
				}
				if (failures.length === 1) throw publicationFailure;
				throw new AggregateError(
					failures,
					"manual Rapier bridge publication failed during callback transfer",
				);
			}
			if (releaseFailed) throw releaseFailure;
		},
		destroy() {
			if (destroyed) return;
			destroyed = true;
			transferGeneration += 1;
			requestedCallback = undefined;
			transferInProgress = false;
			revocable.revoke();
			const finalCallback = callback;
			callback = undefined;
			try {
				stepper.destroy();
			} finally {
				try {
					events.clear();
				} finally {
					try {
						queue.free();
					} finally {
						finalCallback?.(null);
					}
				}
			}
		},
		get destroyed() {
			return destroyed;
		},
	};

	let publicationFailed = false;
	let publicationFailure: unknown;
	try {
		callback?.(revocable.bridge);
	} catch (error) {
		publicationFailed = true;
		publicationFailure = error;
	}
	if (publicationFailed) {
		try {
			binding.destroy();
		} catch (cleanupFailure) {
			throw new AggregateError(
				[publicationFailure, cleanupFailure],
				"manual Rapier bridge publication failed and cleanup also failed",
			);
		}
		throw publicationFailure;
	}
	return Object.freeze(binding);
}

export interface ManualPhysicsProps
	extends Omit<
		PhysicsProps,
		"children" | "paused" | "interpolate" | "timeStep" | "updateLoop"
	> {
	readonly children?: ReactNode;
	readonly events: PhysicsEventBuffer;
	readonly resolveColliderEntityId: ColliderEntityResolver;
	readonly onBridge?: (bridge: ManualRapierBridge | null) => void;
}

function RawStepBinding({
	events,
	resolveColliderEntityId,
	onBridge,
}: Readonly<{
	events: PhysicsEventBuffer;
	resolveColliderEntityId: ColliderEntityResolver;
	onBridge: ((bridge: ManualRapierBridge | null) => void) | undefined;
}>): null {
	const { rapier, world } = useRapier();
	const resolverRef = useRef(resolveColliderEntityId);
	resolverRef.current = resolveColliderEntityId;
	const onBridgeRef = useRef(onBridge);
	onBridgeRef.current = onBridge;
	const bindingRef = useRef<ManualRapierBinding | null>(null);

	useLayoutEffect(() => {
		bindingRef.current?.setOnBridge(onBridge);
	}, [onBridge]);
	useLayoutEffect(() => {
		const queue = new rapier.EventQueue(true);
		let stepper: RawRapierStepper;
		try {
			stepper = createRawRapierStepper<typeof queue>({
				world,
				queue,
				events,
				resolveColliderEntityId: (colliderHandle) =>
					resolverRef.current(colliderHandle),
			});
		} catch (error) {
			try {
				events.clear();
			} finally {
				queue.free();
			}
			throw error;
		}
		const binding = createManualRapierBinding(
			stepper,
			events,
			queue,
			onBridgeRef.current,
		);
		bindingRef.current = binding;
		return () => {
			bindingRef.current = null;
			binding.destroy();
		};
	}, [events, rapier, world]);
	return null;
}

export function ManualPhysics({
	children,
	events,
	resolveColliderEntityId,
	onBridge,
	...physicsProps
}: ManualPhysicsProps) {
	return (
		<Physics
			{...physicsProps}
			paused={true}
			interpolate={false}
			timeStep={FIXED_STEP_SECONDS}
			updateLoop="follow"
		>
			<RawStepBinding
				events={events}
				resolveColliderEntityId={resolveColliderEntityId}
				onBridge={onBridge}
			/>
			{children}
		</Physics>
	);
}
