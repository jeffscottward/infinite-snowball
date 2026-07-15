import type { RetainedEvidenceDispatch } from "./provenance-ledger.mjs";

export interface PolicyIssue {
	readonly ruleId: string;
	readonly path: string;
	readonly remediation: string;
}

export interface PolicyResult {
	readonly ok: boolean;
	readonly issues: PolicyIssue[];
}

export type StarterPackageLicense = "CC0-1.0" | "CC-BY-4.0";

export interface PackageLicensePolicyResult extends PolicyResult {
	readonly license?: StarterPackageLicense;
}

export interface PackageLicenseManifest {
	readonly license?: unknown;
	readonly assets?: readonly {
		readonly assetId?: unknown;
		readonly license?: unknown;
	}[];
}

export interface ProvenanceLedgerOptions {
	readonly root?: string;
	readonly contentRoot?: string;
	readonly machineRoot?: string;
	readonly ledgerPath?: string;
	readonly retainedEvidenceDispatch?: readonly RetainedEvidenceDispatch[];
}

export interface ImmutablePackageIdentity {
	readonly name: string;
	readonly version: string;
	readonly integrity: string;
	readonly manifestSha256: string;
}

export interface InspectedPackageIdentity {
	readonly manifest: {
		readonly name: string;
		readonly version: string;
		readonly assets: readonly { readonly assetId: string }[];
		readonly entries: readonly {
			readonly objects?: readonly {
				readonly objectId: string;
				readonly renderAssetId?: string;
				readonly colliderAssetId?: string;
				readonly lodAssetIds?: readonly string[];
			}[];
		}[];
	};
	readonly manifestSha256: string;
	readonly artifact: {
		readonly integrity: string;
	};
}

export interface WithdrawalRegistryRecord {
	readonly schemaVersion: 1;
	readonly registryId: string;
	readonly simulationOnly: true;
	readonly status: "withdrawn";
	readonly package: ImmutablePackageIdentity;
	readonly packageKey: string;
	readonly allowNewInstalls: false;
	readonly preserveReferences: readonly string[];
	readonly affected: {
		readonly objectIds: readonly string[];
		readonly assetIds: readonly string[];
	};
	readonly replacement: {
		readonly package: ImmutablePackageIdentity;
		readonly packageKey: string;
		readonly objectIdMap: Readonly<Record<string, string>>;
		readonly assetIdMap: Readonly<Record<string, string>>;
	};
	readonly catalogEligibility: {
		readonly package: { readonly name: string; readonly version: string };
		readonly status: "withdrawn";
		readonly existingInstall: false;
		readonly replacement: { readonly name: string; readonly version: string };
	};
	readonly dispatch: {
		readonly simulationOnly: true;
		readonly type: "withdraw-package";
		readonly eventId: string;
		readonly package: string;
		readonly replacement: string;
	};
}

export function validatePackageLicensePolicy(
	manifest: PackageLicenseManifest,
): PackageLicensePolicyResult;
export function validateProvenanceEvidence(value: unknown): PolicyResult;
export function validateMusicPolicy(value: unknown): PolicyResult;
export function auditLocalAudioBoundary(
	imported: unknown,
	emissions: unknown,
): PolicyResult;
export function validateBrandMetadata(value: unknown): PolicyResult;
export function validateWithdrawalRecord(value: unknown): PolicyResult;
export function validateWithdrawalPackageBinding(
	value: unknown,
	currentPackages: readonly InspectedPackageIdentity[],
): PolicyResult;
export function createWithdrawalRegistryRecord(
	value: unknown,
): WithdrawalRegistryRecord;
export function readCanonicalWithdrawalRecord(root?: string): Promise<unknown>;
export function formatProvenanceLedgerRow(record: unknown): string;
export function generateProvenanceLedger(
	options?: ProvenanceLedgerOptions,
): Promise<{
	readonly records: number;
	readonly machineRoot: string;
	readonly ledgerPath: string;
	readonly ledgerSha256: string;
}>;

export function checkProvenanceLedger(
	options?: ProvenanceLedgerOptions,
): Promise<
	PolicyResult & {
		readonly runtimeFiles: number;
		readonly machineRecords: number;
		readonly humanRows: number;
	}
>;
