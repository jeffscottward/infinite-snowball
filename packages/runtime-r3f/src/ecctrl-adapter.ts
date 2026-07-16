import type { InputFrame } from "@infinite-snowball/input";
import type { EcctrlHandle, MovementInput } from "ecctrl";

export type EcctrlMovementHandle = Pick<EcctrlHandle, "setMovement">;

export interface EcctrlHeldRunProps {
	readonly enableToggleRun: false;
}

export interface EcctrlInputBoundary {
	readonly ecctrlProps: EcctrlHeldRunProps;
	forward(frame: Readonly<InputFrame>): void;
	dispose(): void;
	destroy(): void;
	readonly destroyed: boolean;
}

const ECTRL_HELD_RUN_PROPS: EcctrlHeldRunProps = Object.freeze({
	enableToggleRun: false,
});

const NEUTRAL_ECCTRL_MOVEMENT: MovementInput = Object.freeze({
	forward: false,
	backward: false,
	leftward: false,
	rightward: false,
	joystick: Object.freeze({ x: 0, y: 0 }),
	run: false,
	jump: false,
});

export function toEcctrlMovement(frame: Readonly<InputFrame>): MovementInput {
	const movement = {
		forward: frame.held.moveForward || frame.move.y > 0.01,
		backward: frame.held.moveBackward || frame.move.y < -0.01,
		leftward: frame.held.moveLeft || frame.move.x < -0.01,
		rightward: frame.held.moveRight || frame.move.x > 0.01,
		joystick: Object.freeze({ x: frame.move.x, y: frame.move.y }),
		run: frame.held.boost,
		jump: frame.pressed.action,
	};
	return Object.freeze(movement);
}

export function createEcctrlInputBoundary(
	handle: EcctrlMovementHandle,
): EcctrlInputBoundary {
	let destroyed = false;

	function finish(): void {
		if (destroyed) return;
		handle.setMovement(NEUTRAL_ECCTRL_MOVEMENT);
		destroyed = true;
	}

	return Object.freeze({
		ecctrlProps: ECTRL_HELD_RUN_PROPS,
		forward(frame: Readonly<InputFrame>) {
			if (destroyed) throw new Error("Ecctrl input boundary is destroyed");
			handle.setMovement(toEcctrlMovement(frame));
		},
		dispose: finish,
		destroy: finish,
		get destroyed() {
			return destroyed;
		},
	});
}

export function applyEcctrlMovement(
	handle: EcctrlMovementHandle,
	frame: Readonly<InputFrame>,
): void {
	handle.setMovement(toEcctrlMovement(frame));
}
