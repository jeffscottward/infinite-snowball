import type { InputAction } from "./actions.js";

export interface TouchControlDescriptor {
	readonly id: "move" | "look" | InputAction;
	readonly label: string;
	readonly minimumSizePx: number;
}

export const TOUCH_CONTROL_LAYOUT = Object.freeze({
	safeAreaAware: true,
	controls: Object.freeze([
		Object.freeze({ id: "move", label: "Move", minimumSizePx: 96 }),
		Object.freeze({ id: "look", label: "Camera", minimumSizePx: 96 }),
		Object.freeze({ id: "action", label: "Action", minimumSizePx: 56 }),
		Object.freeze({ id: "boost", label: "Boost", minimumSizePx: 56 }),
		Object.freeze({ id: "brake", label: "Brake", minimumSizePx: 56 }),
		Object.freeze({ id: "pause", label: "Pause", minimumSizePx: 48 }),
		Object.freeze({
			id: "resetCamera",
			label: "Reset camera",
			minimumSizePx: 48,
		}),
	] satisfies readonly TouchControlDescriptor[]),
});

export interface ActivatableDomControl {
	focus(): void;
	click(): void;
}

export function activateDomControl(target: ActivatableDomControl): void {
	target.focus();
	target.click();
}

export function cameraFeedbackForMotionPreference(
	reducedMotion: boolean,
): Readonly<{
	shakeScale: number;
	zoomPulseScale: number;
}> {
	return Object.freeze(
		reducedMotion
			? { shakeScale: 0, zoomPulseScale: 0 }
			: { shakeScale: 1, zoomPulseScale: 1 },
	);
}
