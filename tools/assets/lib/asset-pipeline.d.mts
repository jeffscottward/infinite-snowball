import type { Manifest } from "../../../packages/protocol/src/browser.js";
import type {
	PackageInspection,
	PackageInspectionFile,
} from "../../../packages/protocol/src/validation/package-inspection.js";

export interface AssetIssue {
	readonly ruleId: string;
	readonly path: string;
	readonly remediation: string;
	readonly [key: string]: unknown;
}

export interface AssetValidationResult {
	readonly ok: boolean;
	readonly issues: AssetIssue[];
}

export interface GlbMetrics {
	readonly bytes: number;
	readonly triangles: number;
	readonly materials: number;
	readonly textures: number;
	readonly textureSets: number;
	readonly textureBytes: number;
	readonly decodedTextureBytes: number;
	readonly maxTextureDimension: number;
	readonly extensionsRequired: string[];
	readonly extensionsUsed: string[];
	readonly animationClips: string[];
	readonly textValues: readonly string[];
}

export interface PngMetrics {
	readonly width: number;
	readonly height: number;
	readonly decodedBytes: number;
	readonly decodedScanlineBytes: number;
}

export interface WavMetrics {
	readonly durationSeconds: number;
	readonly channels: number;
	readonly sampleRate: number;
	readonly bitsPerSample: number;
	readonly dataBytes: number;
}

export interface RuntimeAssetFile {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly compressedBytes?: number;
	readonly kind: string;
	readonly role?: string;
	readonly glb?: GlbMetrics;
	readonly texture?: PngMetrics;
	readonly audio?: WavMetrics;
}

export type AssetBudgetGlbMetrics = Readonly<
	Pick<
		GlbMetrics,
		| "bytes"
		| "triangles"
		| "materials"
		| "textures"
		| "textureSets"
		| "textureBytes"
		| "decodedTextureBytes"
		| "maxTextureDimension"
	>
>;

export type AssetBudgetFile = Omit<RuntimeAssetFile, "glb"> & {
	readonly glb?: AssetBudgetGlbMetrics;
};

export interface LocalAssetMetrics {
	readonly materials: number;
	readonly textures: number;
	readonly textureSets: number;
	readonly textureBytes: number;
	readonly maxTextureDimension: number;
	readonly textValues?: readonly string[];
}

export interface AssetPipelineOptions {
	readonly root?: string;
	readonly contentRoot?: string;
}

export interface AssetPipelineInspectionOptions extends AssetPipelineOptions {
	readonly afterAssetIdentityCheck?: (
		relativePath: string,
	) => void | Promise<void>;
}

export interface RebuildStarterContentOptions {
	readonly root?: string;
	readonly outputRoot?: string;
}

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

export interface ExactPackageRef {
	readonly name: string;
	readonly version: string;
	readonly kind: Manifest["kind"];
	readonly engine: string;
	readonly integrity: string;
	readonly manifestSha256: string;
	readonly catalogEntryId: string;
}

export interface StarterPackageInspectionFacts
	extends Omit<PackageInspection, "manifest"> {
	readonly manifest: Manifest;
	readonly files: PackageInspectionFile[];
	readonly localAssetMetrics: Readonly<Record<string, LocalAssetMetrics>>;
}

export interface StarterPackageArtifact {
	readonly packageName: string;
	readonly manifest: Manifest;
	readonly manifestBytes: Buffer;
	readonly manifestSha256: string;
	readonly artifact: DeterministicPackageArtifact;
	readonly inspection: PackageInspection & { readonly manifest: Manifest };
	readonly budgetInspection: StarterPackageInspectionFacts;
	readonly ref: ExactPackageRef;
}

export interface StarterHashSnapshotFile {
	readonly path: string;
	readonly bytes: number;
	readonly actualSha256: string;
}

export interface StarterHashSnapshot {
	readonly packages: ReadonlyArray<{
		readonly packageName: string;
		readonly assets: Manifest["assets"];
		readonly files: readonly StarterHashSnapshotFile[];
	}>;
}

export const ASSET_LIMITS: Readonly<{
	maxFileBytes: number;
	maxTriangles: number;
	maxMaterials: number;
	maxTextureDimension: number;
	maxTextureBytes: number;
	maxDecodedTextureBytes: number;
	maxStarterFileBytes: number;
	maxStarterEntries: number;
	maxStarterDepth: number;
	maxStarterFiles: number;
	maxStarterBytes: number;
	maxEmbeddedImages: number;
	maxStarterTriangles: number;
}>;

export const ROLE_TEXTURE_SET_BUDGETS: Readonly<{
	collectible: number;
	hero: number;
}>;

export const PIPELINE_CONFIG: Readonly<Record<string, unknown>>;
export function assertAuditedNodeRuntime(runtimeVersion?: string): void;

export const CONFIG_SHA256: string;

export function inspectGlb(
	input: Buffer | Uint8Array,
): AssetValidationResult & { readonly metrics: GlbMetrics };

export function inspectPng(
	input: Buffer | Uint8Array,
): AssetValidationResult & { readonly metrics: PngMetrics };

export function inspectWav(
	input: Buffer | Uint8Array,
): AssetValidationResult & { readonly metrics: WavMetrics };

export function buildDeterministicPackageArtifact(
	manifest: Manifest,
	assetBytes: Map<string, Buffer>,
	options?: { readonly reconcileTotals?: boolean },
): DeterministicPackageArtifact;

export function readProjectLicenseBytes(
	root: string,
	options?: {
		readonly afterIdentityCheck?: () => void | Promise<void>;
	},
): Promise<Buffer>;

export function readStarterTemplates(
	root: string,
	options?: {
		readonly afterIdentityCheck?: (
			relativePath: string,
		) => void | Promise<void>;
	},
): Promise<Readonly<Record<string, unknown>>>;

export function rebuildStarterContent(
	options?: RebuildStarterContentOptions,
): Promise<{
	readonly configSha256: string;
	readonly files: Record<string, string>;
	readonly packages: StarterPackageArtifact[];
}>;

export function inspectStarterPackages(
	options?: AssetPipelineInspectionOptions,
): Promise<
	AssetValidationResult & {
		readonly packages: StarterPackageArtifact[];
		readonly hashSnapshot: StarterHashSnapshot;
	}
>;

export function validatePackageBudgets(
	inspection: StarterPackageInspectionFacts,
): AssetValidationResult;

export function verifyStarterHashes(
	options?: AssetPipelineInspectionOptions,
): Promise<AssetValidationResult>;

export function scanStarterRuntimeFiles(
	options?: AssetPipelineInspectionOptions,
): Promise<
	AssetValidationResult & {
		readonly files: RuntimeAssetFile[];
		readonly contentDigest: string | undefined;
	}
>;

export function buildAssetBudgetReport(options?: AssetPipelineInspectionOptions): Promise<
	AssetValidationResult & {
		readonly totals: {
			readonly files: number;
			readonly bytes: number;
			readonly glbFiles: number;
			readonly triangles: number;
			readonly materials: number;
			readonly textureBytes: number;
		};
		readonly files: AssetBudgetFile[];
		readonly contentDigest: string | undefined;
	}
>;

export function contentDigest(options?: AssetPipelineOptions): Promise<string>;
