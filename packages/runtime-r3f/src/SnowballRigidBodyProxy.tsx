import {
	BallCollider,
	type RapierCollider,
	type RapierRigidBody,
	RigidBody,
	useRapier,
} from "@react-three/rapier";
import { useCallback, useLayoutEffect, useRef } from "react";

import { PhysicsOnlyProxy } from "./PhysicsOnlyProxy.js";
import {
	createSnowballRigidBodyConfig,
	createSnowballRigidBodyPosition,
	enableSnowballCollisionEvents,
	type SnowballBodyFacts,
	type SnowballRigidBodyConfig,
} from "./snowball-body.js";

export interface SnowballRigidBodyProxyProps {
	readonly stableId: string;
	readonly facts: SnowballBodyFacts;
	readonly position?: readonly [number, number, number];
	readonly onHandles?: (
		body: RapierRigidBody | null,
		collider: RapierCollider | null,
	) => void;
}

export function SnowballRigidBodyProxy({
	stableId,
	facts,
	position = [0, 0, 0],
	onHandles,
}: SnowballRigidBodyProxyProps) {
	const { rapier } = useRapier();
	const body = useRef<RapierRigidBody>(null);
	const collider = useRef<RapierCollider>(null);
	const initialConfig = useRef<SnowballRigidBodyConfig | null>(null);
	const initialStableId = useRef(stableId);
	const initialPosition = useRef<readonly [number, number, number] | null>(
		null,
	);
	const initialIdentityRef = useRef<{
		readonly name: string;
		readonly userData: Readonly<{ readonly stableId: string }>;
	} | null>(null);
	if (initialConfig.current === null) {
		initialConfig.current = createSnowballRigidBodyConfig({
			radius: facts.radius,
			mass: facts.mass,
		});
	}
	const config = initialConfig.current;
	if (initialStableId.current.length === 0) {
		throw new Error("snowball rigid-body stable ID must not be empty");
	}
	if (stableId !== initialStableId.current) {
		throw new Error("snowball rigid-body stable ID cannot change after mount");
	}
	if (initialPosition.current === null) {
		initialPosition.current = createSnowballRigidBodyPosition(position);
	}
	if (initialIdentityRef.current === null) {
		initialIdentityRef.current = Object.freeze({
			name: `${initialStableId.current}:physics-only`,
			userData: Object.freeze({ stableId: initialStableId.current }),
		});
	}
	const initialIdentity = initialIdentityRef.current;
	const onHandlesRef = useRef(onHandles);
	const publishedHandlesRef = useRef<{
		readonly callback: NonNullable<SnowballRigidBodyProxyProps["onHandles"]>;
		readonly body: RapierRigidBody;
		readonly collider: RapierCollider;
	} | null>(null);
	const notifyReadyHandles = useCallback(() => {
		const currentBody = body.current;
		const currentCollider = collider.current;
		const callback = onHandlesRef.current;
		if (
			currentBody === null ||
			currentCollider === null ||
			callback === undefined
		) {
			return;
		}
		const published = publishedHandlesRef.current;
		if (
			published?.callback === callback &&
			published.body === currentBody &&
			published.collider === currentCollider
		) {
			return;
		}
		callback(currentBody, currentCollider);
		publishedHandlesRef.current = {
			callback,
			body: currentBody,
			collider: currentCollider,
		};
	}, []);
	const setBody = useCallback(
		(nextBody: RapierRigidBody | null) => {
			body.current = nextBody;
			notifyReadyHandles();
		},
		[notifyReadyHandles],
	);
	const setCollider = useCallback(
		(nextCollider: RapierCollider | null) => {
			collider.current = nextCollider;
			if (nextCollider !== null) {
				enableSnowballCollisionEvents(
					nextCollider,
					rapier.ActiveEvents.COLLISION_EVENTS,
				);
			}
			notifyReadyHandles();
		},
		[notifyReadyHandles, rapier],
	);

	useLayoutEffect(() => {
		const previousCallback = onHandlesRef.current;
		if (previousCallback === onHandles) return;
		publishedHandlesRef.current = null;
		let releaseFailed = false;
		let releaseFailure: unknown;
		try {
			previousCallback?.(null, null);
		} catch (error) {
			releaseFailed = true;
			releaseFailure = error;
		}
		onHandlesRef.current = onHandles;
		let publicationFailed = false;
		let publicationFailure: unknown;
		try {
			notifyReadyHandles();
		} catch (error) {
			publicationFailed = true;
			publicationFailure = error;
		}
		if (releaseFailed && publicationFailed) {
			throw new AggregateError(
				[releaseFailure, publicationFailure],
				"snowball handle callback replacement failed",
			);
		}
		if (publicationFailed) throw publicationFailure;
		if (releaseFailed) throw releaseFailure;
	}, [notifyReadyHandles, onHandles]);

	useLayoutEffect(() => {
		notifyReadyHandles();
		return () => {
			body.current = null;
			collider.current = null;
			publishedHandlesRef.current = null;
			onHandlesRef.current?.(null, null);
		};
	}, [notifyReadyHandles]);

	return (
		<PhysicsOnlyProxy name={initialIdentity.name}>
			<RigidBody
				ref={setBody}
				type="dynamic"
				position={initialPosition.current}
				colliders={false}
				ccd={config.ccd}
				canSleep={config.canSleep}
				userData={initialIdentity.userData}
			>
				<BallCollider
					ref={setCollider}
					args={[config.colliderRadius]}
					mass={config.additionalMass}
				/>
			</RigidBody>
		</PhysicsOnlyProxy>
	);
}
