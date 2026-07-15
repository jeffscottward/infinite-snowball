import { execFile } from "node:child_process";
import {
	lstat,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { AUDITED_NODE_VERSION } from "./lib/canonical-config.mjs";
import {
	inventoryTree,
	readInventoriedFile,
} from "./lib/tree-inventory.mjs";

const execFileAsync = promisify(execFile);
const INPUT_FILES = [
	"package.json",
	"tests/fixtures/assets/local-audio-cases.json",
];
const INPUT_DIRECTORIES = [
	"tools/assets",
	"packages/protocol/dist",
	"docs/brand",
	"docs/licenses",
	"docs/music",
];
const GENERATED_PATHS = [
	"content",
	"docs/assets/starter-content-budget.json",
	"docs/assets/reference-renders",
	"docs/assets/p03-content-handoff.json",
	"docs/licenses/provenance/records",
	"docs/licenses/third-party-ledger.md",
];
const GENERATION_STEPS = [
	["tools/assets/rebuild-starter.mjs"],
	["tools/assets/budget-report.mjs"],
	["tools/assets/render-smoke.mjs", "--generate"],
	["tools/assets/handoff-report.mjs"],
];
const MAX_ENTRIES = 1_024;
const MAX_FILES = 512;
const MAX_DEPTH = 12;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const INPUT_MAX_ENTRIES = 4_096;
const INPUT_MAX_FILES = 2_048;
const INPUT_MAX_DEPTH = 16;
const INPUT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const INPUT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

function absolutePath(root, relativePath) {
	return join(root, ...relativePath.split("/"));
}


function assertInputBounds(
	entryCount,
	fileCount,
	totalBytes,
	fileBytes = 0,
) {
	if (
		!Number.isSafeInteger(entryCount) ||
		entryCount < 0 ||
		!Number.isSafeInteger(fileCount) ||
		fileCount < 0 ||
		!Number.isSafeInteger(totalBytes) ||
		totalBytes < 0 ||
		!Number.isSafeInteger(fileBytes) ||
		fileBytes < 0 ||
		entryCount > INPUT_MAX_ENTRIES ||
		fileCount > INPUT_MAX_FILES ||
		totalBytes > INPUT_MAX_TOTAL_BYTES ||
		fileBytes > INPUT_MAX_FILE_BYTES
	) {
		throw new Error("E_REBUILD_INPUT input trees exceed inspection bounds");
	}
}

function rejectInputInventory(relativePath, inventory) {
	if (inventory.issues.some((entry) => entry.ruleId === "E_FILE_BUDGET")) {
		throw new Error("E_REBUILD_INPUT input trees exceed inspection bounds");
	}
	const details = inventory.issues
		.slice(0, 8)
		.map((entry) => `${entry.ruleId} ${relativePath}${entry.path}`)
		.join("; ");
	throw new Error(`E_REBUILD_INPUT ${relativePath}: ${details}`);
}

async function inventoryInputDirectories(root) {
	const inventories = [];
	let entryCount = 0;
	let fileCount = 0;
	let totalBytes = 0;
	for (const relativePath of INPUT_DIRECTORIES) {
		const nextEntryCount = entryCount + 1;
		assertInputBounds(nextEntryCount, fileCount, totalBytes);
		let inventory;
		try {
			inventory = await inventoryTree(absolutePath(root, relativePath), {
				maxEntries: INPUT_MAX_ENTRIES - nextEntryCount,
				maxFiles: INPUT_MAX_FILES - fileCount,
				maxDepth: INPUT_MAX_DEPTH,
				maxFileBytes: INPUT_MAX_FILE_BYTES,
				maxTotalBytes: INPUT_MAX_TOTAL_BYTES - totalBytes,
			});
		} catch (cause) {
			throw new Error(
				`E_REBUILD_INPUT ${relativePath}: input tree cannot be inventoried`,
				{ cause },
			);
		}
		if (!inventory.ok) rejectInputInventory(relativePath, inventory);
		if (inventory.rootRealpath !== resolve(root, relativePath)) {
			throw new Error(
				`E_REBUILD_INPUT ${relativePath}: input root escapes the canonical project root`,
			);
		}
		const nonCanonicalPath = inventory.entries.find(
			(entry) => entry.relativePath !== entry.relativePath.normalize("NFC"),
		);
		if (nonCanonicalPath !== undefined) {
			throw new Error(
				`E_REBUILD_INPUT input path must be NFC: ${relativePath}/${nonCanonicalPath.relativePath}`,
			);
		}
		const files = inventory.entries.filter((entry) => entry.kind === "file");
		const inventoryBytes = files.reduce(
			(total, entry) => total + entry.bytes,
			0,
		);
		entryCount = nextEntryCount + inventory.entries.length;
		fileCount += files.length;
		totalBytes += inventoryBytes;
		assertInputBounds(entryCount, fileCount, totalBytes);
		inventories.push({ relativePath, entries: inventory.entries });
	}
	return inventories;
}

async function snapshotInputFiles(root) {
	const files = [];
	for (const relativePath of INPUT_FILES) {
		const absolute = absolutePath(root, relativePath);
		let metadata;
		let canonicalPath;
		try {
			metadata = await lstat(absolute);
			canonicalPath = await realpath(absolute);
		} catch (cause) {
			throw new Error(
				`E_REBUILD_INPUT ${relativePath}: required input file is unavailable`,
				{ cause },
			);
		}
		if (
			!metadata.isFile() ||
			canonicalPath !== resolve(root, relativePath) ||
			!Number.isSafeInteger(metadata.size) ||
			metadata.size < 0 ||
			metadata.size > INPUT_MAX_FILE_BYTES
		) {
			throw new Error(
				`E_REBUILD_INPUT ${relativePath}: input must be one bounded canonical regular file`,
			);
		}
		const entry = {
			absolutePath: absolute,
			relativePath,
			realpath: canonicalPath,
			contained: true,
			kind: "file",
			mode: metadata.mode,
			bytes: metadata.size,
			dev: metadata.dev,
			ino: metadata.ino,
			ctimeMs: metadata.ctimeMs,
			mtimeMs: metadata.mtimeMs,
		};
		let bytes;
		try {
			bytes = await readInventoriedFile(entry);
		} catch (cause) {
			throw new Error(
				`E_REBUILD_INPUT ${relativePath}: input changed after bounded inventory`,
				{ cause },
			);
		}
		if (relativePath === "package.json") {
			let packageJson;
			try {
				packageJson = JSON.parse(bytes.toString("utf8"));
			} catch (cause) {
				throw new Error(
					"E_REBUILD_INPUT package.json: root package metadata is invalid JSON",
					{ cause },
				);
			}
			if (
				packageJson?.devEngines?.runtime?.name !== "node" ||
				packageJson?.devEngines?.runtime?.version !== AUDITED_NODE_VERSION
			) {
				throw new Error(
					`E_REBUILD_INPUT package.json: devEngines.runtime must pin node ${AUDITED_NODE_VERSION}`,
				);
			}
		}
		files.push({ relativePath, mode: metadata.mode, bytes });
	}
	return files;
}



async function copySnapshottedInputFiles(sandbox, files) {
	for (const file of files) {
		const destination = absolutePath(sandbox, file.relativePath);
		await mkdir(dirname(destination), { recursive: true });
		try {
			await writeFile(destination, file.bytes, {
				flag: "wx",
				mode: file.mode & 0o777,
			});
		} catch (cause) {
			throw new Error(
				`E_REBUILD_INPUT ${file.relativePath}: sandbox input reconstruction failed`,
				{ cause },
			);
		}
	}
}

async function copyInventoriedInputDirectories(sandbox, inventories) {
	for (const inventory of inventories) {
		await mkdir(absolutePath(sandbox, inventory.relativePath), {
			recursive: true,
		});
		for (const entry of inventory.entries) {
			const relativePath = `${inventory.relativePath}/${entry.relativePath}`;
			const destination = absolutePath(sandbox, relativePath);
			if (entry.kind === "directory") {
				await mkdir(destination, {
					recursive: true,
					mode: entry.mode & 0o777,
				});
				continue;
			}
			if (entry.kind !== "file") {
				throw new Error(
					`E_REBUILD_INPUT ${relativePath}: unsupported inventoried entry type`,
				);
			}
			let bytes;
			try {
				bytes = await readInventoriedFile(entry);
			} catch (cause) {
				throw new Error(
					`E_REBUILD_INPUT ${relativePath}: input changed after bounded inventory`,
					{ cause },
				);
			}
			await mkdir(dirname(destination), { recursive: true });
			try {
				await writeFile(destination, bytes, {
					flag: "wx",
					mode: entry.mode & 0o777,
				});
			} catch (cause) {
				throw new Error(
					`E_REBUILD_INPUT ${relativePath}: sandbox input reconstruction failed`,
					{ cause },
				);
			}
		}
	}
}

async function resolveTrustedDependencyDirectory(root, relativePath) {
	try {
		const canonicalPath = await realpath(absolutePath(root, relativePath));
		const stats = await lstat(canonicalPath);
		if (!stats.isDirectory()) throw new Error("not a directory");
		return canonicalPath;
	} catch {
		throw new Error(
			`E_REBUILD_INPUT ${relativePath}: restore the installed dependency directory`,
		);
	}
}

function assertGeneratedBounds(
	entryCount,
	fileCount,
	totalBytes,
	fileBytes = 0,
) {
	if (
		!Number.isSafeInteger(entryCount) ||
		!Number.isSafeInteger(fileCount) ||
		!Number.isSafeInteger(totalBytes) ||
		!Number.isSafeInteger(fileBytes) ||
		entryCount > MAX_ENTRIES ||
		fileCount > MAX_FILES ||
		totalBytes > MAX_TOTAL_BYTES ||
		fileBytes > MAX_FILE_BYTES
	) {
		throw new Error(
			"E_REBUILD_PARITY generated outputs exceed inspection bounds",
		);
	}
}

function rejectGeneratedInventory(relativePath, inventory) {
	if (inventory.issues.some((entry) => entry.ruleId === "E_FILE_BUDGET")) {
		throw new Error(
			"E_REBUILD_PARITY generated outputs exceed inspection bounds",
		);
	}
	const details = inventory.issues
		.slice(0, 8)
		.map((entry) => `${entry.ruleId} ${relativePath}${entry.path}`)
		.join("; ");
	throw new Error(`E_REBUILD_PARITY ${relativePath}: ${details}`);
}

async function snapshotInventoriedFile(path, entry) {
	try {
		return await readInventoriedFile(entry);
	} catch (cause) {
		throw new Error(
			`E_REBUILD_PARITY ${path}: generated file changed during bounded snapshot`,
			{ cause },
		);
	}
}

async function snapshotGeneratedPaths(root) {
	const canonicalRoot = await realpath(root);
	const snapshot = new Map();
	let entryCount = 0;
	let fileCount = 0;
	let totalBytes = 0;

	for (const relativePath of GENERATED_PATHS) {
		const target = absolutePath(root, relativePath);
		let stats;
		try {
			stats = await lstat(target);
		} catch (cause) {
			throw new Error(
				`E_REBUILD_PARITY ${relativePath}: generated path cannot be inventoried`,
				{ cause },
			);
		}
		if (stats.isSymbolicLink()) {
			throw new Error(
				`E_REBUILD_PARITY ${relativePath}: symlinks are forbidden`,
			);
		}
		let targetRealpath;
		try {
			targetRealpath = await realpath(target);
		} catch (cause) {
			throw new Error(
				`E_REBUILD_PARITY ${relativePath}: generated path cannot be resolved`,
				{ cause },
			);
		}
		if (targetRealpath !== resolve(canonicalRoot, relativePath)) {
			throw new Error(
				`E_REBUILD_PARITY ${relativePath}: generated path escapes the canonical root`,
			);
		}

		if (stats.isFile()) {
			const nextEntryCount = entryCount + 1;
			const nextFileCount = fileCount + 1;
			const nextTotalBytes = totalBytes + stats.size;
			assertGeneratedBounds(
				nextEntryCount,
				nextFileCount,
				nextTotalBytes,
				stats.size,
			);
			const entry = {
				absolutePath: target,
				relativePath,
				realpath: targetRealpath,
				contained: true,
				kind: "file",
				mode: stats.mode,
				bytes: stats.size,
				dev: stats.dev,
				ino: stats.ino,
				ctimeMs: stats.ctimeMs,
				mtimeMs: stats.mtimeMs,
			};
			const bytes = await snapshotInventoriedFile(relativePath, entry);
			entryCount = nextEntryCount;
			fileCount = nextFileCount;
			totalBytes = nextTotalBytes;
			snapshot.set(relativePath, { kind: "file", bytes });
			continue;
		}
		if (!stats.isDirectory()) {
			throw new Error(
				`E_REBUILD_PARITY ${relativePath}: unsupported entry type`,
			);
		}

		const nextEntryCount = entryCount + 1;
		assertGeneratedBounds(nextEntryCount, fileCount, totalBytes);
		let inventory;
		try {
			inventory = await inventoryTree(target, {
				maxEntries: MAX_ENTRIES - nextEntryCount,
				maxFiles: MAX_FILES - fileCount,
				maxDepth: MAX_DEPTH,
				maxFileBytes: MAX_FILE_BYTES,
				maxTotalBytes: MAX_TOTAL_BYTES - totalBytes,
			});
		} catch (cause) {
			throw new Error(
				`E_REBUILD_PARITY ${relativePath}: generated tree cannot be inventoried`,
				{ cause },
			);
		}
		if (!inventory.ok) rejectGeneratedInventory(relativePath, inventory);
		if (inventory.rootRealpath !== targetRealpath) {
			throw new Error(
				`E_REBUILD_PARITY ${relativePath}: generated root identity changed during inventory`,
			);
		}
		const files = inventory.entries.filter((entry) => entry.kind === "file");
		const inventoryBytes = files.reduce(
			(total, entry) => total + entry.bytes,
			0,
		);
		entryCount = nextEntryCount + inventory.entries.length;
		fileCount += files.length;
		totalBytes += inventoryBytes;
		assertGeneratedBounds(entryCount, fileCount, totalBytes);

		snapshot.set(`${relativePath}/`, { kind: "directory" });
		for (const entry of inventory.entries) {
			const path = `${relativePath}/${entry.relativePath}`;
			if (entry.kind === "directory") {
				snapshot.set(`${path}/`, { kind: "directory" });
				continue;
			}
			if (entry.kind !== "file") {
				throw new Error(`E_REBUILD_PARITY ${path}: unsupported entry type`);
			}
			snapshot.set(path, {
				kind: "file",
				bytes: await snapshotInventoriedFile(path, entry),
			});
		}
	}

	return { snapshot, fileCount, totalBytes };
}

function compareSnapshots(checkedIn, rebuilt) {
	const differences = [];
	const paths = [...new Set([...checkedIn.keys(), ...rebuilt.keys()])].sort();
	for (const path of paths) {
		const expected = checkedIn.get(path);
		const actual = rebuilt.get(path);
		if (!expected) differences.push(`${path}: unexpected fresh output`);
		else if (!actual) differences.push(`${path}: missing fresh output`);
		else if (expected.kind !== actual.kind)
			differences.push(`${path}: entry type changed`);
		else if (expected.kind === "file" && !expected.bytes.equals(actual.bytes))
			differences.push(`${path}: bytes differ`);
		if (differences.length >= 20) break;
	}
	if (differences.length > 0) {
		throw new Error(`E_REBUILD_PARITY\n${differences.join("\n")}`);
	}
}

async function runGenerationStep(root, [script, ...arguments_]) {
	try {
		await execFileAsync(
			process.execPath,
			[absolutePath(root, script), ...arguments_],
			{
				cwd: root,
				env: { ...process.env, NO_COLOR: "1" },
				maxBuffer: 4 * 1024 * 1024,
				timeout: 120_000,
			},
		);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`E_REBUILD_GENERATION ${script}: ${detail}`);
	}
}

async function verifyCleanRebuild(root) {
	const requestedRoot = resolve(root);
	const rootStats = await lstat(requestedRoot);
	if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
		throw new Error("E_REBUILD_INPUT project root must be a regular directory");
	}
	const canonicalRoot = await realpath(requestedRoot);
	const inputFiles = await snapshotInputFiles(canonicalRoot);
	const inputInventories = await inventoryInputDirectories(canonicalRoot);
	const protocolNodeModules = await resolveTrustedDependencyDirectory(
		canonicalRoot,
		"packages/protocol/node_modules",
	);

	const checkedIn = await snapshotGeneratedPaths(canonicalRoot);
	const sandbox = await mkdtemp(join(tmpdir(), "snowball-clean-rebuild-"));
	try {
		await copySnapshottedInputFiles(sandbox, inputFiles);
		await copyInventoriedInputDirectories(sandbox, inputInventories);
		await mkdir(absolutePath(sandbox, "docs/assets"), {
			recursive: true,
		});
		await rm(absolutePath(sandbox, "docs/licenses/provenance/records"), {
			recursive: true,
			force: true,
		});
		await rm(absolutePath(sandbox, "docs/licenses/third-party-ledger.md"), {
			force: true,
		});
		await symlink(
			await realpath(absolutePath(canonicalRoot, "node_modules")),
			absolutePath(sandbox, "node_modules"),
			"dir",
		);
		await symlink(
			protocolNodeModules,
			absolutePath(sandbox, "packages/protocol/node_modules"),
			"dir",
		);

		for (const step of GENERATION_STEPS) await runGenerationStep(sandbox, step);
		const rebuilt = await snapshotGeneratedPaths(sandbox);
		compareSnapshots(checkedIn.snapshot, rebuilt.snapshot);
		return {
			files: checkedIn.fileCount,
			bytes: checkedIn.totalBytes,
			paths: GENERATED_PATHS.length,
		};
	} finally {
		await rm(sandbox, { recursive: true, force: true, maxRetries: 3 });
	}
}

const result = await verifyCleanRebuild(process.cwd());
console.log(
	`Clean rebuild parity verified: ${result.paths} generated roots, ${result.files} files, ${result.bytes} bytes.`,
);
