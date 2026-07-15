export interface TreeInventoryOptions {
	readonly maxEntries?: number;
	readonly maxFiles?: number;
	readonly maxDepth?: number;
	readonly maxFileBytes?: number;
	readonly maxTotalBytes?: number;
}

export interface TreeInventoryIssue {
	readonly ruleId: string;
	readonly path: string;
	readonly remediation: string;
}

export interface TreeInventoryEntry {
	readonly absolutePath: string;
	readonly relativePath: string;
	readonly realpath: string | undefined;
	readonly contained: boolean;
	readonly kind: "directory" | "file" | "other" | "symlink";
	readonly mode: number;
	readonly bytes: number;
	readonly dev: number;
	readonly ino: number;
	readonly ctimeMs: number;
	readonly mtimeMs: number;
}

export interface TreeInventoryResult {
	readonly ok: boolean;
	readonly issues: readonly TreeInventoryIssue[];
	readonly entries: readonly TreeInventoryEntry[];
	readonly rootRealpath: string | undefined;
}

export interface InventoriedFileReadOptions {
	readonly afterIdentityCheck?: () => void | Promise<void>;
}

export function readInventoriedFile(
	entry: TreeInventoryEntry | undefined,
	options?: InventoriedFileReadOptions,
): Promise<Buffer>;

export function inventoryTree(
	root: string,
	options?: TreeInventoryOptions,
): Promise<TreeInventoryResult>;
