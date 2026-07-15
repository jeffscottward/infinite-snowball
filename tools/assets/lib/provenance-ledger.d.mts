export interface ProvenanceRecordIdentity {
	readonly packageName: string;
	readonly assetId: string;
}

export interface RetainedSourceMember {
	readonly member: string;
	readonly file: string;
	readonly sha256: string;
}

export interface ReviewedSourceEvidence {
	readonly schemaVersion: 1;
	readonly pack: string;
	readonly archiveBytes: number;
	readonly archiveSha256: string;
	readonly acquiredAt: string;
	readonly licenseMember: string;
	readonly licenseTextPath: string;
	readonly preview: {
		readonly member: string;
		readonly path: string;
		readonly sha256: string;
	};
	readonly reviewer: string;
	readonly reviewedAt: string;
	readonly evidenceStatus: "verified";
	readonly notes: string;
	readonly replacement:
		| null
		| {
				readonly provider: string;
				readonly sourceUrl: string;
				readonly archiveFile: string;
				readonly archiveSha256: string;
		  };
}

export interface RetainedEvidenceDispatch {
	readonly provider: string;
	readonly sourceUrl: string;
	readonly spdx: StarterPackageLicense;
	readonly url: string;
	readonly sourceRoot: string;
	readonly sourceFiles: readonly string[];
	readonly artifactPrefix: string;
	readonly sourceMembers: readonly RetainedSourceMember[];
	readonly evidencePath?: string;
	readonly evidenceSha256?: string;
	readonly reviewedEvidence?: ReviewedSourceEvidence;
	readonly textPath: string;
	readonly textSha256: string;
	readonly grant: string;
}

export interface RetainedEvidenceResolution {
	readonly kind: "project-original" | "retained";
	readonly provider: string;
	readonly sourceUrl: string;
	readonly sourceArtifact: string;
	readonly spdx: StarterPackageLicense;
	readonly url: string;
	readonly textPath: string;
	readonly textSha256: string;
	readonly grant: string;
	readonly author?: string;
	readonly source?: string;
}

export interface ProvenanceLedgerOptions {
	readonly root?: string;
	readonly contentRoot?: string;
	readonly machineRoot?: string;
	readonly ledgerPath?: string;
	readonly retainedEvidenceDispatch?: readonly RetainedEvidenceDispatch[];
	readonly transactionTestHook?: (
		boundary:
			| "after-recovery"
			| "after-recovery-claim"
			| "after-machine-backup"
			| "after-machine-install"
			| "after-ledger-backup"
			| "after-ledger-install"
			| "before-postcommit-cleanup"
			| "before-lock-release",
	) => void | Promise<void>;
}

export interface ReconstructedProvenanceRecord
	extends ProvenanceRecordIdentity {
	readonly recordId: string;
	readonly packageVersion: string;
	readonly packageKind: string;
	readonly packageLicense: StarterPackageLicense;
	readonly assetPath: string;
	readonly provider: string;
	readonly creator: string;
	readonly license: Readonly<Record<string, unknown>>;
	readonly [key: string]: unknown;
}

export const PROVENANCE_LEDGER_HEADER: readonly string[];
export const PROVENANCE_PACKAGE_DIRECTORIES: readonly [
	"starter-campaign",
	"starter-character",
	"starter-level",
	"starter-music",
	"starter-objects",
];
export const PROVENANCE_OUTPUT_LIMITS: Readonly<{
	maxRecords: number;
	maxRecordBytes: number;
	maxMachineBytes: number;
	maxHumanLedgerBytes: number;
}>;
export function validateProvenanceOutputMetrics(value: {
	readonly recordCount: number;
	readonly maxRecordBytes: number;
	readonly machineBytes: number;
	readonly humanLedgerBytes: number;
}): boolean;

export function provenanceRecordFileName(
	record: ProvenanceRecordIdentity,
): string;

export type StarterPackageLicense = "CC0-1.0" | "CC-BY-4.0";

export interface PackageLicensePolicyResult {
	readonly ok: boolean;
	readonly issues: readonly {
		readonly ruleId: string;
		readonly path: string;
		readonly remediation: string;
	}[];
	readonly license?: StarterPackageLicense;
}

export function validatePackageLicensePolicy(manifest: {
	readonly license?: unknown;
	readonly assets?: readonly { readonly license?: unknown }[];
}): PackageLicensePolicyResult;

export function reconstructProvenanceRecord(input: {
	readonly packageDirectory: string;
	readonly manifest: unknown;
	readonly asset: unknown;
	readonly runtimeBytes: Uint8Array;
	readonly retainedLicenseEvidence: RetainedEvidenceResolution;
}): ReconstructedProvenanceRecord;

export function formatProvenanceLedgerRow(record: unknown): string;
export function formatProvenanceLedger(
	records: readonly unknown[],
): string;

export function readProvenanceLedger(root: string): Promise<Uint8Array>;

export function readRetainedLicenseText(
	root: string,
	textPath: string,
): Promise<Uint8Array>;

export function resolveRetainedLicenseEvidence(
	root: string,
	asset: unknown,
	dispatch?: readonly RetainedEvidenceDispatch[],
): Promise<RetainedEvidenceResolution>;

export function inspectProvenanceContent(contentRoot: string): Promise<{
	readonly ok: boolean;
	readonly issues: readonly {
		readonly ruleId: string;
		readonly path: string;
		readonly remediation: string;
	}[];
	readonly packages: readonly {
		readonly packageDirectory: string;
		readonly manifest: {
			readonly assets: readonly unknown[];
			readonly [key: string]: unknown;
		};
		readonly assetEntries: ReadonlyMap<string, unknown>;
		readonly assetBytes: ReadonlyMap<string, Uint8Array>;
	}[];
	readonly inventory: unknown;
}>;

export function generateProvenanceLedger(
	options?: ProvenanceLedgerOptions,
): Promise<{
	readonly records: number;
	readonly machineRoot: string;
	readonly ledgerPath: string;
	readonly ledgerSha256: string;
}>;
