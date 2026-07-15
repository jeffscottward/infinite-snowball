import type {
	AssetValidationResult,
	AssetBudgetFile,
	StarterPackageArtifact,
} from "./lib/asset-pipeline.mjs";

export interface RebuildStarterOptions {
	readonly root?: string;
	readonly transactionTestHook?: (
		boundary:
			| "after-recovery"
			| "after-recovery-claim"
			| "after-content-backup"
			| "after-content-install"
			| "after-provenance"
			| "before-postcommit-cleanup"
			| "before-lock-release",
	) => void | Promise<void>;
}

export interface RebuildStarterResult {
	readonly build: {
		readonly configSha256: string;
		readonly files: Record<string, string>;
		readonly packages: StarterPackageArtifact[];
	};
	readonly ledger: {
		readonly records: number;
		readonly machineRoot: string;
		readonly ledgerPath: string;
		readonly ledgerSha256: string;
	};
	readonly hashes: AssetValidationResult;
	readonly budget: AssetValidationResult & {
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
	};
}

export function runRebuildStarter(
	options?: RebuildStarterOptions,
): Promise<RebuildStarterResult>;
