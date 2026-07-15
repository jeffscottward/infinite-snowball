import { constants as fileConstants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

function normalizePath(path) {
	return path.split(sep).join("/");
}

function containedPath(root, target) {
	const path = relative(root, target);
	return (
		path === "" ||
		(!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
	);
}

function inventoryIssue(ruleId, path, remediation, extra = {}) {
	return { ruleId, path, remediation, ...extra };
}

function inventoryLimit(options, name) {
	const value = options[name];
	if (value === undefined) return Number.MAX_SAFE_INTEGER;
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(
			`E_FILE_BUDGET: ${name} must be a non-negative safe integer`,
		);
	}
	return value;
}

function sameInventoryIdentity(entry, stats) {
	return (
		stats.isFile() &&
		stats.dev === entry.dev &&
		stats.ino === entry.ino &&
		stats.size === entry.bytes &&
		stats.ctimeMs === entry.ctimeMs &&
		stats.mtimeMs === entry.mtimeMs
	);
}

export async function readInventoriedFile(entry, options = {}) {
	if (
		entry?.kind !== "file" ||
		typeof entry.absolutePath !== "string" ||
		typeof entry.realpath !== "string" ||
		!Number.isInteger(fileConstants.O_NOFOLLOW) ||
		(options.afterIdentityCheck !== undefined &&
			typeof options.afterIdentityCheck !== "function")
	) {
		throw new Error(
			"E_PATH_POLICY: only complete inventoried regular-file identities may be read",
		);
	}
	try {
		if ((await realpath(entry.absolutePath)) !== entry.realpath) {
			throw new Error("inventory realpath changed");
		}
		const handle = await open(
			entry.absolutePath,
			fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
		);
		try {
			const before = await handle.stat();
			if (!sameInventoryIdentity(entry, before)) {
				throw new Error("inventory identity changed");
			}
			await options.afterIdentityCheck?.();
			const bytes = Buffer.allocUnsafe(entry.bytes);
			let offset = 0;
			while (offset < bytes.length) {
				const { bytesRead } = await handle.read(
					bytes,
					offset,
					bytes.length - offset,
					offset,
				);
				if (bytesRead === 0) {
					throw new Error("inventoried file ended before its bounded size");
				}
				offset += bytesRead;
			}
			const probe = Buffer.allocUnsafe(1);
			const { bytesRead: trailingBytes } = await handle.read(
				probe,
				0,
				1,
				entry.bytes,
			);
			if (trailingBytes !== 0) {
				throw new Error("inventoried file grew beyond its bounded size");
			}
			const after = await handle.stat();
			const finalPathStats = await lstat(entry.absolutePath);
			const finalRealpath = await realpath(entry.absolutePath);
			if (
				!sameInventoryIdentity(entry, after) ||
				!sameInventoryIdentity(entry, finalPathStats) ||
				finalRealpath !== entry.realpath
			) {
				throw new Error("inventory identity changed while reading");
			}
			return bytes;
		} finally {
			await handle.close();
		}
	} catch (cause) {
		throw new Error(
			`E_PATH_POLICY: ${entry?.relativePath ?? "/"} changed after bounded inventory`,
			{ cause },
		);
	}
}

export async function inventoryTree(root, options = {}) {
	const issues = [];
	const entries = [];
	const limits = {
		maxEntries: inventoryLimit(options, "maxEntries"),
		maxFiles: inventoryLimit(options, "maxFiles"),
		maxDepth: inventoryLimit(options, "maxDepth"),
		maxFileBytes: inventoryLimit(options, "maxFileBytes"),
		maxTotalBytes: inventoryLimit(options, "maxTotalBytes"),
	};
	let fileCount = 0;
	let totalBytes = 0;
	let stoppedForBudget = false;
	const stopForBudget = () => {
		if (stoppedForBudget) return;
		stoppedForBudget = true;
		issues.push(
			inventoryIssue(
				"E_FILE_BUDGET",
				"/",
				"Keep inventory within reviewed entry, file, depth, per-file, and total-byte limits before reading file contents.",
			),
		);
	};
	let rootStat;
	try {
		rootStat = await lstat(root);
	} catch {
		return {
			ok: false,
			issues: [
				inventoryIssue(
					"E_CONTENT_TREE",
					"/",
					"Restore the expected regular content directory before inventory.",
				),
			],
			entries,
			rootRealpath: undefined,
		};
	}
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		return {
			ok: false,
			issues: [
				inventoryIssue(
					rootStat.isSymbolicLink() ? "E_PATH_POLICY" : "E_CONTENT_TREE",
					"/",
					"Use one real regular directory as the inventory root; symlinks and unknown types are forbidden.",
				),
			],
			entries,
			rootRealpath: undefined,
		};
	}
	const rootRealpath = await realpath(root);

	async function walk(directory) {
		const names = [];
		for await (const directoryEntry of await opendir(directory)) {
			if (entries.length + names.length >= limits.maxEntries) {
				stopForBudget();
				break;
			}
			names.push(directoryEntry.name);
		}
		if (stoppedForBudget) return;
		names.sort();
		for (const name of names) {
			if (stoppedForBudget) return;
			if (entries.length >= limits.maxEntries) {
				stopForBudget();
				return;
			}
			const target = join(directory, name);
			const relativePath = normalizePath(relative(root, target));
			const depth = relativePath.split("/").length;
			if (depth > limits.maxDepth) {
				stopForBudget();
				return;
			}
			let stats;
			try {
				stats = await lstat(target);
			} catch {
				issues.push(
					inventoryIssue(
						"E_CONTENT_TREE",
						`/${relativePath}`,
						"Reject entries that change or disappear during bounded inventory.",
					),
				);
				continue;
			}
			let targetRealpath;
			try {
				targetRealpath = await realpath(target);
			} catch {
				issues.push(
					inventoryIssue(
						stats.isSymbolicLink() ? "E_PATH_POLICY" : "E_CONTENT_TREE",
						`/${relativePath}`,
						"Reject broken links and entries without a contained canonical path.",
					),
				);
			}
			const contained =
				targetRealpath !== undefined &&
				containedPath(rootRealpath, targetRealpath);
			let kind = "other";
			if (stats.isSymbolicLink()) kind = "symlink";
			else if (stats.isDirectory()) kind = "directory";
			else if (stats.isFile()) kind = "file";
			if (kind === "file") {
				const nextFileCount = fileCount + 1;
				const nextTotalBytes = totalBytes + stats.size;
				if (
					!Number.isSafeInteger(stats.size) ||
					stats.size < 0 ||
					stats.size > limits.maxFileBytes ||
					nextFileCount > limits.maxFiles ||
					!Number.isSafeInteger(nextTotalBytes) ||
					nextTotalBytes > limits.maxTotalBytes
				) {
					stopForBudget();
					return;
				}
				fileCount = nextFileCount;
				totalBytes = nextTotalBytes;
			}
			entries.push({
				absolutePath: target,
				relativePath,
				realpath: targetRealpath,
				contained,
				kind,
				mode: stats.mode,
				bytes: stats.size,
				dev: stats.dev,
				ino: stats.ino,
				ctimeMs: stats.ctimeMs,
				mtimeMs: stats.mtimeMs,
			});
			if (kind === "symlink" || !contained) {
				issues.push(
					inventoryIssue(
						"E_PATH_POLICY",
						`/${relativePath}`,
						"Replace links or escaped paths with contained regular files and directories.",
					),
				);
				continue;
			}
			if (kind === "other") {
				issues.push(
					inventoryIssue(
						"E_CONTENT_TREE",
						`/${relativePath}`,
						"Remove sockets, devices, and unknown filesystem entry types.",
					),
				);
				continue;
			}
			if (kind === "directory") await walk(target);
		}
	}

	await walk(root);
	return {
		ok: issues.length === 0,
		issues,
		entries,
		rootRealpath,
	};
}
