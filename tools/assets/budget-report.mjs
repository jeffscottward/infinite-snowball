import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";

import {
	ASSET_LIMITS,
	buildAssetBudgetReport,
	CONFIG_SHA256,
} from "./lib/asset-pipeline.mjs";

const root = process.cwd();
const canonicalRoot = await realpath(root);
const outputDirectory = "docs/assets";
const outputPath = `${outputDirectory}/starter-content-budget.json`;
const maxBudgetEvidenceBytes = 16 * 1024 * 1024;

function outputPathError(message, cause) {
	return new Error(`E_BUDGET_OUTPUT_PATH: ${message}`, { cause });
}

function sameFileState(expected, actual) {
	return (
		actual.isFile() &&
		actual.dev === expected.dev &&
		actual.ino === expected.ino &&
		actual.size === expected.size &&
		actual.mtimeMs === expected.mtimeMs &&
		actual.ctimeMs === expected.ctimeMs
	);
}

async function requireOwnedDirectory(relativePath) {
	try {
		const absolutePath = resolve(root, relativePath);
		const expectedPath = resolve(canonicalRoot, relativePath);
		const metadata = await lstat(absolutePath);
		if (
			!metadata.isDirectory() ||
			(await realpath(absolutePath)) !== expectedPath
		) {
			throw new Error("directory is not canonically owned");
		}
		return absolutePath;
	} catch (cause) {
		throw outputPathError(
			`owned regular directory required at ${relativePath}`,
			cause,
		);
	}
}

async function readOwnedBudgetEvidence() {
	try {
		const absolutePath = resolve(root, outputPath);
		const expectedPath = resolve(canonicalRoot, outputPath);
		const metadata = await lstat(absolutePath);
		if (!metadata.isFile() || (await realpath(absolutePath)) !== expectedPath)
			throw new Error("target is not a canonically owned regular file");
		const handle = await open(
			absolutePath,
			fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
		);
		try {
			const openedMetadata = await handle.stat();
			if (
				!sameFileState(metadata, openedMetadata) ||
				!Number.isSafeInteger(openedMetadata.size) ||
				openedMetadata.size < 0 ||
				openedMetadata.size > maxBudgetEvidenceBytes
			) {
				throw new Error("target changed or exceeds the evidence byte bound");
			}
			const bytes = Buffer.alloc(openedMetadata.size);
			let offset = 0;
			while (offset < bytes.length) {
				const { bytesRead } = await handle.read(
					bytes,
					offset,
					bytes.length - offset,
					offset,
				);
				if (bytesRead === 0) throw new Error("target changed while reading");
				offset += bytesRead;
			}
			const extra = Buffer.alloc(1);
			const { bytesRead: extraBytes } = await handle.read(
				extra,
				0,
				1,
				bytes.length,
			);
			const finalMetadata = await handle.stat();
			if (
				extraBytes !== 0 ||
				!sameFileState(metadata, finalMetadata) ||
				!sameFileState(openedMetadata, finalMetadata)
			) {
				throw new Error("target changed while reading");
			}
			return bytes;
		} finally {
			await handle.close();
		}
	} catch (cause) {
		throw outputPathError(
			`cannot read owned budget evidence at ${outputPath}`,
			cause,
		);
	}
}

async function writeOwnedBudgetEvidence(bytes) {
	const absolutePath = resolve(root, outputPath);
	const expectedPath = resolve(canonicalRoot, outputPath);
	const temporaryPath = `${absolutePath}.tmp-${process.pid}`;
	let handle;
	let temporaryCreated = false;
	try {
		await requireOwnedDirectory("docs");
		await requireOwnedDirectory(outputDirectory);
		try {
			const metadata = await lstat(absolutePath);
			if (!metadata.isFile() || (await realpath(absolutePath)) !== expectedPath)
				throw new Error("target is not a canonically owned regular file");
		} catch (cause) {
			if (cause?.code !== "ENOENT") throw cause;
		}
		handle = await open(
			temporaryPath,
			fsConstants.O_WRONLY |
				fsConstants.O_CREAT |
				fsConstants.O_EXCL |
				fsConstants.O_NOFOLLOW,
			0o644,
		);
		temporaryCreated = true;
		await handle.writeFile(bytes);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await requireOwnedDirectory(outputDirectory);
		await rename(temporaryPath, absolutePath);
		temporaryCreated = false;
	} catch (cause) {
		await handle?.close().catch(() => {});
		if (temporaryCreated)
			await rm(temporaryPath, { force: true }).catch(() => {});
		if (cause?.message?.startsWith("E_BUDGET_OUTPUT_PATH:")) throw cause;
		throw outputPathError(
			`cannot write owned budget evidence at ${outputPath}`,
			cause,
		);
	}
}
const budget = await buildAssetBudgetReport({ root });
if (typeof budget.contentDigest !== "string") {
	throw outputPathError("budget scan did not produce one complete content digest");
}
const report = {
	schemaVersion: 1,
	pipelineConfigSha256: CONFIG_SHA256,
	contentSha256: budget.contentDigest,
	limits: ASSET_LIMITS,
	totals: budget.totals,
	files: budget.files,
	issues: budget.issues,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (Buffer.byteLength(serialized, "utf8") > maxBudgetEvidenceBytes) {
	throw outputPathError(
		`generated budget evidence exceeds ${maxBudgetEvidenceBytes} bytes`,
	);
}
const expected = Buffer.from(serialized, "utf8");
await requireOwnedDirectory("docs");
await requireOwnedDirectory(outputDirectory);
if (process.argv.includes("--check")) {
	const current = await readOwnedBudgetEvidence();
	if (!current.equals(expected)) {
		console.error(
			"Starter content budget evidence is missing or stale; regenerate with node tools/assets/budget-report.mjs.",
		);
		process.exitCode = 1;
	}
} else {
	await writeOwnedBudgetEvidence(expected);
}

if (!budget.ok) {
	for (const issue of budget.issues)
		console.error(`${issue.ruleId} ${issue.path}: ${issue.remediation}`);
	process.exitCode = 1;
} else {
	console.log(
		`Starter asset budget verified: ${budget.totals.files} files, ${budget.totals.bytes} bytes, ${budget.totals.triangles} triangles.`,
	);
}
