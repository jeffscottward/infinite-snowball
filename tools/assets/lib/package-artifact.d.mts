import type { Manifest } from "../../../packages/protocol/src/browser.js";
import type { PackageInspection } from "../../../packages/protocol/src/validation/package-inspection.js";

export interface PackageArtifactEntry {
	readonly path: string;
	readonly archivePath: string;
	readonly bytes: number;
	readonly compressedBytes: number;
	readonly kind: "asset" | "metadata";
}

export interface DeterministicPackageArtifact {
	readonly manifest: Manifest;
	readonly manifestBytes: Buffer;
	readonly manifestSha256: string;
	readonly packageJsonBytes: Buffer;
	readonly bytes: Buffer;
	readonly integrity: string;
	readonly archive: PackageInspection["archive"];
	readonly overhead: {
		readonly terminatorCompressedBytes: number;
		readonly sizeBindingCompressedBytes: number;
	};
	readonly entries: PackageArtifactEntry[];
}

export interface PackageArtifactWorkingProjection {
	readonly compressionPhaseBytes: number;
	readonly finalMaterializationBytes: number;
	readonly peakBytes: number;
}

export function projectPackageArtifactWorkingBytes(
	effectiveArtifactBytes: number,
	maximumTarMemberBytes: number,
	manifestProjectedBytes: number,
): PackageArtifactWorkingProjection;

export function buildDeterministicPackageArtifact(
	manifest: Manifest,
	assetBytes: Map<string, Buffer>,
	options?: { readonly reconcileTotals?: boolean },
): DeterministicPackageArtifact;
