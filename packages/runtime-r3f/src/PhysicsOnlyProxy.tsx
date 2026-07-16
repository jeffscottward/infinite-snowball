import type { ReactNode } from "react";

export interface PhysicsOnlyProxyProps {
	readonly children: ReactNode;
	readonly name?: string;
}

export function PhysicsOnlyProxy({
	children,
	name = "physics-only-proxy",
}: PhysicsOnlyProxyProps) {
	return (
		<group name={name} visible={false}>
			{children}
		</group>
	);
}
