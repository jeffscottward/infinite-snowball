import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	mkdir,
	lstat,
	open,
	realpath,
	rename,
	rm,
	rmdir,
} from "node:fs/promises";
import {
	basename,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
	inventoryTree,
	readInventoriedFile,
} from "./tree-inventory.mjs";
import { canonicalConfigSha256 } from "./canonical-config.mjs";
const PROTOCOL_MANIFEST_MODULE_URL = new URL(
	"../../../packages/protocol/dist/schema/manifests.js",
	import.meta.url,
);
let protocolManifestParserPromise;

function loadProtocolManifestParser() {
	if (protocolManifestParserPromise === undefined) {
		protocolManifestParserPromise = import(PROTOCOL_MANIFEST_MODULE_URL.href)
			.then((module) => {
				if (typeof module.parseManifest !== "function")
					throw new Error("generated manifest parser export is missing");
				return module.parseManifest;
			})
			.catch((error) => {
				throw new Error(
					"E_PROTOCOL_BUILD: build the module-relative protocol manifest parser before provenance generation",
					{ cause: error },
				);
			});
	}
	return protocolManifestParserPromise;
}


export const PROVENANCE_PACKAGE_DIRECTORIES = [
	"starter-campaign",
	"starter-character",
	"starter-level",
	"starter-music",
	"starter-objects",
];

const HASH = /^[a-f0-9]{64}$/u;
const STARTER_PACKAGE_LICENSES = new Set(["CC0-1.0", "CC-BY-4.0"]);
const CC0_LICENSE_URL =
	"https://creativecommons.org/publicdomain/zero/1.0/";
const CC_BY_LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";
const PROJECT_ORIGINAL_SOURCE_URL =
	"https://github.com/jeffscottward/infinite-snowball/tree/main/tools/assets/lib/asset-pipeline.mjs";
const PROJECT_ORIGINAL_MODULE_PATH = "tools/assets/lib/asset-pipeline.mjs";
const PROJECT_ORIGINAL_LICENSE_PATH =
	"docs/licenses/provenance/infinite-snowball-original-content/CC0-1.0.txt";
const PROJECT_ORIGINAL_LICENSE_SHA256 =
	"2f96dd1453e0a4047713aa6cdb4fcdbec8666e12286012f4993ad628bc70d75c";
const PROJECT_PIPELINE_CONFIG_SHA256 =
	"b3a856908518f8d12f46d3f8a7fe53d9856b6c5384f864bf0a2a88b0b2200303";
const PROJECT_ORIGINAL_RECIPES = new Map([
	[
		"generate-icon-v1",
		{
			format: "rgba-png",
			configSha256:
				"2607740b4afac861bf7c2ab32e72a88798a7ed5ff955376d622e65f571f8f9f6",
		},
	],
	[
		"generate-music-track-v1",
		{
			format: "pcm16-stereo-wav",
			configSha256:
				"24536452f1a2f890280f5c083110c9c6f0539080a10f03c2834e97486f04c9fd",
		},
	],
]);
const ORIGINAL_CONTENT_CREATOR = "Infinite Snowball contributors";
const PROVENANCE_CONTENT_LIMITS = Object.freeze({
	maxEntries: 1_024,
	maxFiles: 512,
	maxDepth: 12,
	maxFileBytes: 32 * 1024 * 1024,
	maxTotalBytes: 256 * 1024 * 1024,
});
export const PROVENANCE_OUTPUT_LIMITS = Object.freeze({
	maxRecords: PROVENANCE_CONTENT_LIMITS.maxFiles,
	maxRecordBytes: 256 * 1024,
	maxMachineBytes: PROVENANCE_CONTENT_LIMITS.maxFiles * 256 * 1024,
	maxHumanLedgerBytes: 32 * 1024 * 1024,
});
const PROVENANCE_TRANSACTION_VERSION = 1;
const PROVENANCE_TRANSACTION_MAX_JOURNAL_BYTES = 4 * 1024;
const PROVENANCE_TRANSACTION_MAX_LOCK_BYTES = 512;
const PROVENANCE_TRANSACTION_JOURNAL =
	".provenance-ledger.transaction.json";
const PROVENANCE_TRANSACTION_LOCK = ".provenance-ledger.lock";
const PROVENANCE_TRANSACTION_RECOVERY = ".provenance-ledger.recovery";
const TRANSACTION_ID =
	/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export function validateProvenanceOutputMetrics(value) {
	return (
		exactObjectKeys(value, [
			"recordCount",
			"maxRecordBytes",
			"machineBytes",
			"humanLedgerBytes",
		]) &&
		Number.isSafeInteger(value.recordCount) &&
		value.recordCount >= 0 &&
		value.recordCount <= PROVENANCE_OUTPUT_LIMITS.maxRecords &&
		Number.isSafeInteger(value.maxRecordBytes) &&
		value.maxRecordBytes >= 0 &&
		value.maxRecordBytes <= PROVENANCE_OUTPUT_LIMITS.maxRecordBytes &&
		Number.isSafeInteger(value.machineBytes) &&
		value.machineBytes >= 0 &&
		value.machineBytes <= PROVENANCE_OUTPUT_LIMITS.maxMachineBytes &&
		Number.isSafeInteger(value.humanLedgerBytes) &&
		value.humanLedgerBytes >= 0 &&
		value.humanLedgerBytes <= PROVENANCE_OUTPUT_LIMITS.maxHumanLedgerBytes
	);
}

const BUILTIN_RETAINED_CC0_EVIDENCE = Object.freeze([
	Object.freeze({
		provider: "Kenney",
		sourceUrl: "https://kenney.nl/assets/nature-kit",
		spdx: "CC0-1.0",
		url: CC0_LICENSE_URL,
		sourceRoot: "tools/assets/sources/kenney-nature-kit",
		sourceFiles: Object.freeze([
			"License.txt",
			"rock_smallA-preview.png",
			"rock_smallA.glb",
			"source-evidence.json",
		]),
		artifactPrefix: "kenney-nature-kit.zip",
		sourceMembers: Object.freeze([
			Object.freeze({
				member: "Models/GLTF format/rock_smallA.glb",
				file: "rock_smallA.glb",
				sha256:
					"df9fff9d711e61370e8df0caa2514c89b8f8a8dc6c6fafaf4eb2ec79c5ae07c1",
			}),
			Object.freeze({
				member: "Isometric/rock_smallA_NE.png",
				file: "rock_smallA-preview.png",
				sha256:
					"9ac0749d7657e4b46020e260ef0b8b09c2a829fb2950fdcc1f64b9ffcdd77875",
			}),
		]),
		evidencePath:
			"tools/assets/sources/kenney-nature-kit/source-evidence.json",
		evidenceSha256:
			"0ea677a538076bc6bb09c465b8dfc37a4ae1bb02bdf52824fcbc3a23b0e8dcd7",
		reviewedEvidence: Object.freeze({
			schemaVersion: 1,
			pack: "Nature Kit",
			archiveBytes: 10_537_521,
			archiveSha256:
				"fa7974a0d342bfe63c38664ba9f8ec1a4aab8ea25f099bdc56870e33588c4d9d",
			acquiredAt: "2026-07-15T00:00:00.000Z",
			licenseMember: "License.txt",
			licenseTextPath: "License.txt",
			preview: Object.freeze({
				member: "Isometric/rock_smallA_NE.png",
				path: "rock_smallA-preview.png",
				sha256:
					"9ac0749d7657e4b46020e260ef0b8b09c2a829fb2950fdcc1f64b9ffcdd77875",
			}),
			reviewer: "Infinite Snowball P03 provenance review",
			reviewedAt: "2026-07-15T00:00:00.000Z",
			evidenceStatus: "verified",
			notes:
				"Retained exact GLB, embedded archive license text, and matching Kenney isometric preview. Full downloaded archive remains ignored and untracked.",
			replacement: null,
		}),
		textPath: "tools/assets/sources/kenney-nature-kit/License.txt",
		textSha256:
			"cb96b75e3560ac78d7a53ce6f083f4cdb5c53faea6141b62d63458dcfe1e4b9d",
		grant:
			"Captured CC0 1.0 dedication from the exact downloaded Kenney Nature Kit archive.",
	}),
]);

const LEDGER_COLUMNS = [
	"Record ID",
	"Package",
	"Package license",
	"Asset",
	"Role",
	"Creator",
	"Source",
	"Acquisition",
	"Source artifact",
	"License",
	"Retained license evidence",
	"Attribution",
	"Modifications",
	"Recipe",
	"Output",
	"Reviewer",
	"Dates",
	"Evidence",
	"Replacement",
	"Notes",
];

export const PROVENANCE_LEDGER_HEADER = [
	`| ${LEDGER_COLUMNS.join(" | ")} |`,
	`| ${LEDGER_COLUMNS.map(() => "---").join(" | ")} |`,
];

function sha256(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

function compareCodeUnits(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalUrlIdentity(value) {
	try {
		const parsed = new URL(value);
		if (
			parsed.protocol !== "https:" ||
			parsed.username !== "" ||
			parsed.password !== ""
		)
			return null;
		if (parsed.hostname.length > 1 && parsed.hostname.endsWith("."))
			parsed.hostname = parsed.hostname.slice(0, -1);
		parsed.search = "";
		parsed.hash = "";
		const path = parsed.pathname.replace(/\/+$/u, "") || "/";
		return `${parsed.protocol}//${parsed.host}${path}`;
	} catch {
		return null;
	}
}

function equivalentCanonicalUrl(left, right) {
	const canonicalLeft = canonicalUrlIdentity(left);
	return (
		canonicalLeft !== null &&
		canonicalLeft === canonicalUrlIdentity(right)
	);
}

function markdown(value) {
	return String(value)
		.replaceAll("\\", "\\\\")
		.replaceAll("|", "\\|")
		.replaceAll("\n", " ");
}

function inlineJson(value) {
	return JSON.stringify(value) ?? "null";
}


function validEvidenceAuthor(value) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value === value.trim()
	);
}

function validEvidenceSource(value) {
	if (typeof value !== "string" || value.length === 0) return false;
	try {
		const parsed = new URL(value);
		return (
			parsed.protocol === "https:" &&
			parsed.username === "" &&
			parsed.password === ""
		);
	} catch {
		return false;
	}
}

export function validatePackageLicensePolicy(manifest) {
	const issues = [];
	const packageLicense = manifest?.license;
	if (!STARTER_PACKAGE_LICENSES.has(packageLicense)) {
		issues.push({
			ruleId: "E_PACKAGE_LICENSE",
			path: "/license",
			remediation:
				"Use the exact CC0-1.0 or CC-BY-4.0 starter package license.",
		});
	}
	const assets = manifest?.assets;
	if (!Array.isArray(assets) || assets.length === 0) {
		issues.push({
			ruleId: "E_PACKAGE_LICENSE_MISMATCH",
			path: "/assets",
			remediation:
				"Bind the package license to every contained runtime asset.",
		});
	} else {
		let assetLicensesValid = true;
		let containsCcBy = false;
		for (const [index, asset] of assets.entries()) {
			if (!STARTER_PACKAGE_LICENSES.has(asset?.license)) {
				assetLicensesValid = false;
				issues.push({
					ruleId: "E_PACKAGE_LICENSE",
					path: `/assets/${index}/license`,
					remediation:
						"Use the exact CC0-1.0 or CC-BY-4.0 asset license.",
				});
			} else if (asset.license === "CC-BY-4.0") {
				containsCcBy = true;
			}
		}
		const expectedPackageLicense = containsCcBy ? "CC-BY-4.0" : "CC0-1.0";
		if (
			assetLicensesValid &&
			STARTER_PACKAGE_LICENSES.has(packageLicense) &&
			packageLicense !== expectedPackageLicense
		) {
			issues.push({
				ruleId: "E_PACKAGE_LICENSE_MISMATCH",
				path: "/license",
				remediation:
					"Use CC-BY-4.0 when any contained asset requires attribution; otherwise use CC0-1.0.",
			});
		}
	}
	if (issues.length > 0) return { ok: false, issues };
	return { ok: true, issues, license: packageLicense };
}

function provenanceContentIssue(ruleId, path, remediation) {
	return { ruleId, path, remediation };
}

function canonicalRepositoryPath(value, maxBytes = 240) {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value !== value.normalize("NFC") ||
		value.includes("\\") ||
		value.includes("\0") ||
		isAbsolute(value)
	) {
		return false;
	}
	const segments = value.split("/");
	const bytes = Buffer.from(value, "utf8");
	return (
		segments.every(
			(segment) =>
				segment.length > 0 && segment !== "." && segment !== "..",
		) &&
		bytes.length <= maxBytes &&
		bytes.toString("utf8") === value
	);
}

function canonicalAssetPath(value) {
	return (
		canonicalRepositoryPath(value, 100) &&
		value.startsWith("assets/")
	);
}

function addExpectedPathAndParents(expectedPaths, path) {
	let current = path;
	while (current.length > 0) {
		expectedPaths.add(current);
		const separator = current.lastIndexOf("/");
		if (separator < 0) break;
		current = current.slice(0, separator);
	}
}

async function containedRepositoryDirectory(root, relativePath, limits) {
	if (!canonicalRepositoryPath(relativePath)) {
		throw new Error("E_LEDGER_LICENSE_PATH");
	}
	const canonicalRoot = await realpath(root);
	const directory = resolve(root, relativePath);
	const canonicalDirectory = await realpath(directory);
	const fromRoot = relative(canonicalRoot, canonicalDirectory);
	if (
		fromRoot === ".." ||
		fromRoot.startsWith(`..${sep}`) ||
		isAbsolute(fromRoot)
	) {
		throw new Error("E_LEDGER_LICENSE_PATH");
	}
	return inventoryTree(directory, limits);
}

async function readRepositoryFile(
	root,
	filePath,
	{
		maxEntries = 1_024,
		maxFiles = 1_024,
		maxDepth = 1,
		maxFileBytes = 32 * 1024 * 1024,
		maxTotalBytes = 64 * 1024 * 1024,
	} = {},
) {
	if (!canonicalRepositoryPath(filePath)) {
		throw new Error("E_LEDGER_LICENSE_PATH");
	}
	const segments = filePath.split("/");
	const fileName = segments.pop();
	const directoryPath = segments.join("/");
	const inventory = await containedRepositoryDirectory(
		root,
		directoryPath,
		{
			maxEntries,
			maxFiles,
			maxDepth,
			maxFileBytes,
			maxTotalBytes,
		},
	);
	const entry = inventory.entries.find(
		(candidate) =>
			candidate.relativePath === fileName &&
			candidate.kind === "file" &&
			candidate.contained,
	);
	if (!inventory.ok || entry === undefined) {
		throw new Error("E_LEDGER_LICENSE_PATH");
	}
	return readInventoriedFile(entry);
}

async function assertSafeOutputPath(root, outputPath, kind) {
	const absoluteRoot = resolve(root);
	const absoluteOutput = resolve(outputPath);
	const fromRoot = relative(absoluteRoot, absoluteOutput);
	if (
		fromRoot.length === 0 ||
		fromRoot === ".." ||
		fromRoot.startsWith(`..${sep}`) ||
		isAbsolute(fromRoot)
	) {
		throw new Error("E_LEDGER_OUTPUT_PATH");
	}
	const canonicalRoot = await realpath(absoluteRoot);
	const segments = fromRoot.split(sep);
	const targetName = segments.pop();
	if (targetName === undefined || targetName.length === 0) {
		throw new Error("E_LEDGER_OUTPUT_PATH");
	}
	let current = canonicalRoot;
	for (const segment of segments) {
		current = join(current, segment);
		let metadata;
		try {
			metadata = await lstat(current);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			await mkdir(current);
			metadata = await lstat(current);
		}
		if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
			throw new Error("E_LEDGER_OUTPUT_PATH");
		}
		const canonicalParent = await realpath(current);
		const parentFromRoot = relative(canonicalRoot, canonicalParent);
		if (
			parentFromRoot === ".." ||
			parentFromRoot.startsWith(`..${sep}`) ||
			isAbsolute(parentFromRoot)
		) {
			throw new Error("E_LEDGER_OUTPUT_PATH");
		}
	}
	const target = join(current, targetName);
	try {
		const metadata = await lstat(target);
		if (
			metadata.isSymbolicLink() ||
			(kind === "directory"
				? !metadata.isDirectory()
				: !metadata.isFile())
		) {
			throw new Error("E_LEDGER_OUTPUT_PATH");
		}
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
}

async function directoryIdentity(path) {
	const [metadata, canonicalPath] = await Promise.all([
		lstat(path),
		realpath(path),
	]);
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
		throw new Error("E_LEDGER_OUTPUT_PATH");
	}
	return {
		canonicalPath,
		dev: metadata.dev,
		ino: metadata.ino,
	};
}

async function assertDirectoryIdentity(path, expected) {
	const current = await directoryIdentity(path);
	if (
		current.canonicalPath !== expected.canonicalPath ||
		current.dev !== expected.dev ||
		current.ino !== expected.ino
	) {
		throw new Error("E_LEDGER_OUTPUT_PATH");
	}
}

async function syncDirectory(path) {
	let handle;
	try {
		handle = await open(path, fsConstants.O_RDONLY);
		await handle.sync();
	} catch (error) {
		if (!["EINVAL", "ENOTSUP", "EBADF"].includes(error?.code)) throw error;
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function writeExclusiveFile(path, bytes, parent, parentIdentity) {
	await assertDirectoryIdentity(parent, parentIdentity);
	let handle;
	let identity;
	try {
		handle = await open(
			path,
			fsConstants.O_CREAT |
				fsConstants.O_EXCL |
				fsConstants.O_NOFOLLOW |
				fsConstants.O_WRONLY,
			0o600,
		);
		await handle.writeFile(bytes);
		await handle.sync();
		const metadata = await handle.stat();
		if (
			!metadata.isFile() ||
			metadata.nlink !== 1 ||
			metadata.size !== bytes.length
		) {
			throw new Error("E_LEDGER_OUTPUT_PATH");
		}
		identity = { dev: metadata.dev, ino: metadata.ino };
	} finally {
		await handle?.close().catch(() => {});
	}
	await assertDirectoryIdentity(parent, parentIdentity);
	return identity;
}

async function existingOutput(path, kind) {
	try {
		const metadata = await lstat(path);
		if (
			metadata.isSymbolicLink() ||
			(kind === "directory"
				? !metadata.isDirectory()
				: !metadata.isFile())
		) {
			throw new Error("E_LEDGER_OUTPUT_PATH");
		}
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

async function cleanupDirectory(path) {
	try {
		const metadata = await lstat(path);
		if (!metadata.isSymbolicLink() && metadata.isDirectory()) {
			await rm(path, { recursive: true, force: true });
		}
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
}

async function cleanupFile(path) {
	try {
		const metadata = await lstat(path);
		if (!metadata.isSymbolicLink() && metadata.isFile()) {
			await rm(path, { force: true });
		}
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
}

function provenanceTransactionNames(transactionId) {
	return {
		machineStage: `.provenance-records-${transactionId}.stage`,
		machineBackup: `.provenance-records-${transactionId}.backup`,
		ledgerStage: `.provenance-ledger-${transactionId}.stage`,
		ledgerBackup: `.provenance-ledger-${transactionId}.backup`,
	};
}

function canonicalJsonBytes(value, maximum, ruleId) {
	const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
	if (bytes.length === 0 || bytes.length > maximum) {
		throw new Error(ruleId);
	}
	return bytes;
}

async function finishCommittedTransaction(operation, message, code) {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await operation();
			return true;
		} catch {}
	}
	process.emitWarning(message, { code });
	return false;
}

async function readCanonicalTransactionFile(path, maximum, ruleId) {
	let handle;
	try {
		try {
			handle = await open(
				path,
				fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
			);
		} catch (error) {
			if (error?.code === "ENOENT") return undefined;
			throw error;
		}
		const metadata = await handle.stat();
		if (
			!metadata.isFile() ||
			metadata.nlink !== 1 ||
			!Number.isSafeInteger(metadata.size) ||
			metadata.size <= 0 ||
			metadata.size > maximum
		) {
			throw new Error(ruleId);
		}
		const bytes = Buffer.alloc(metadata.size);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		const extra = Buffer.alloc(1);
		const { bytesRead: extraBytes } = await handle.read(
			extra,
			0,
			1,
			bytes.length,
		);
		const revalidated = await handle.stat();
		if (
			bytesRead !== bytes.length ||
			extraBytes !== 0 ||
			revalidated.dev !== metadata.dev ||
			revalidated.ino !== metadata.ino ||
			revalidated.size !== metadata.size
		) {
			throw new Error(ruleId);
		}
		let value;
		try {
			value = JSON.parse(bytes.toString("utf8"));
		} catch {
			throw new Error(ruleId);
		}
		if (!canonicalJsonBytes(value, maximum, ruleId).equals(bytes)) {
			throw new Error(ruleId);
		}
		return {
			value,
			identity: { dev: metadata.dev, ino: metadata.ino },
		};
	} catch (error) {
		if (error?.message === ruleId) throw error;
		throw new Error(ruleId, { cause: error });
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function removeOwnedFile(path, identity, parent, parentIdentity, ruleId) {
	await assertDirectoryIdentity(parent, parentIdentity);
	let metadata;
	try {
		metadata = await lstat(path);
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw new Error(ruleId, { cause: error });
	}
	if (
		metadata.isSymbolicLink() ||
		!metadata.isFile() ||
		metadata.nlink !== 1 ||
		metadata.dev !== identity.dev ||
		metadata.ino !== identity.ino
	) {
		throw new Error(ruleId);
	}
	await rm(path);
	await assertDirectoryIdentity(parent, parentIdentity);
}

function validProvenanceJournal(value) {
	if (
		!exactObjectKeys(value, [
			"version",
			"transactionId",
			"machineStage",
			"machineBackup",
			"ledgerStage",
			"ledgerBackup",
			"hadMachine",
			"hadLedger",
		]) ||
		value.version !== PROVENANCE_TRANSACTION_VERSION ||
		typeof value.transactionId !== "string" ||
		!TRANSACTION_ID.test(value.transactionId) ||
		typeof value.hadMachine !== "boolean" ||
		typeof value.hadLedger !== "boolean"
	) {
		return false;
	}
	const expected = provenanceTransactionNames(value.transactionId);
	return (
		value.machineStage === expected.machineStage &&
		value.machineBackup === expected.machineBackup &&
		value.ledgerStage === expected.ledgerStage &&
		value.ledgerBackup === expected.ledgerBackup
	);
}

function validProvenanceLock(value) {
	return (
		exactObjectKeys(value, ["version", "pid", "transactionId"]) &&
		value.version === PROVENANCE_TRANSACTION_VERSION &&
		Number.isSafeInteger(value.pid) &&
		value.pid > 0 &&
		value.pid <= 2_147_483_647 &&
		typeof value.transactionId === "string" &&
		TRANSACTION_ID.test(value.transactionId)
	);
}

function processIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error?.code === "ESRCH") return false;
		if (error?.code === "EPERM") return true;
		throw new Error("E_LEDGER_TRANSACTION_LOCK", { cause: error });
	}
}

async function recoverOutputToOld({
	target,
	stage,
	backup,
	kind,
	hadOutput,
}) {
	const [backupExists, stageExists, targetExists] = await Promise.all([
		existingOutput(backup, kind),
		existingOutput(stage, kind),
		existingOutput(target, kind),
	]);
	if (backupExists) {
		if (!hadOutput) throw new Error("E_LEDGER_TRANSACTION_JOURNAL");
		if (targetExists) {
			if (kind === "directory") await cleanupDirectory(target);
			else await cleanupFile(target);
		}
		await rename(backup, target);
	} else if (hadOutput) {
		if (!targetExists) throw new Error("E_LEDGER_TRANSACTION_JOURNAL");
	} else if (targetExists) {
		if (stageExists) throw new Error("E_LEDGER_TRANSACTION_JOURNAL");
		if (kind === "directory") await cleanupDirectory(target);
		else await cleanupFile(target);
	}
	if (kind === "directory") await cleanupDirectory(stage);
	else await cleanupFile(stage);
}

async function recoverProvenanceJournal({
	machineRoot,
	ledgerPath,
	machineParent,
	ledgerParent,
	machineParentIdentity,
	ledgerParentIdentity,
}) {
	const journalPath = join(ledgerParent, PROVENANCE_TRANSACTION_JOURNAL);
	const journal = await readCanonicalTransactionFile(
		journalPath,
		PROVENANCE_TRANSACTION_MAX_JOURNAL_BYTES,
		"E_LEDGER_TRANSACTION_JOURNAL",
	);
	if (journal === undefined) return undefined;
	if (!validProvenanceJournal(journal.value)) {
		throw new Error("E_LEDGER_TRANSACTION_JOURNAL");
	}
	const names = provenanceTransactionNames(journal.value.transactionId);
	try {
		await recoverOutputToOld({
			target: ledgerPath,
			stage: join(ledgerParent, names.ledgerStage),
			backup: join(ledgerParent, names.ledgerBackup),
			kind: "file",
			hadOutput: journal.value.hadLedger,
		});
		await recoverOutputToOld({
			target: machineRoot,
			stage: join(machineParent, names.machineStage),
			backup: join(machineParent, names.machineBackup),
			kind: "directory",
			hadOutput: journal.value.hadMachine,
		});
		await syncDirectory(machineParent);
		await syncDirectory(ledgerParent);
		await removeOwnedFile(
			journalPath,
			journal.identity,
			ledgerParent,
			ledgerParentIdentity,
			"E_LEDGER_TRANSACTION_JOURNAL",
		);
		await syncDirectory(ledgerParent);
		return journal.value.transactionId;
	} catch (error) {
		if (error?.message === "E_LEDGER_TRANSACTION_JOURNAL") throw error;
		throw new Error("E_LEDGER_TRANSACTION_JOURNAL", { cause: error });
	}
}

async function cleanupProvenanceTransactionArtifacts({
	transactionId,
	machineParent,
	ledgerParent,
}) {
	const names = provenanceTransactionNames(transactionId);
	await cleanupDirectory(join(machineParent, names.machineStage));
	await cleanupDirectory(join(machineParent, names.machineBackup));
	await cleanupFile(join(ledgerParent, names.ledgerStage));
	await cleanupFile(join(ledgerParent, names.ledgerBackup));
}

async function acquireProvenanceLock({
	machineRoot,
	ledgerPath,
	machineParent,
	ledgerParent,
	machineParentIdentity,
	ledgerParentIdentity,
	hook,
}) {
	const lockPath = join(ledgerParent, PROVENANCE_TRANSACTION_LOCK);
	const recoveryPath = join(
		ledgerParent,
		PROVENANCE_TRANSACTION_RECOVERY,
	);
	const recoveryClaimError = (cause) =>
		new Error(
			"E_LEDGER_TRANSACTION_LOCK: recovery claim present; inspect the fixed journal and lock before manual removal",
			cause === undefined ? undefined : { cause },
		);

	async function recoveryClaimExists() {
		try {
			await lstat(recoveryPath);
			return true;
		} catch (error) {
			if (error?.code === "ENOENT") return false;
			throw recoveryClaimError(error);
		}
	}

	async function createLock() {
		const transactionId = randomUUID();
		const bytes = canonicalJsonBytes(
			{
				version: PROVENANCE_TRANSACTION_VERSION,
				pid: process.pid,
				transactionId,
			},
			PROVENANCE_TRANSACTION_MAX_LOCK_BYTES,
			"E_LEDGER_TRANSACTION_LOCK",
		);
		const identity = await writeExclusiveFile(
			lockPath,
			bytes,
			ledgerParent,
			ledgerParentIdentity,
		);
		await syncDirectory(ledgerParent);
		return { path: lockPath, transactionId, identity };
	}

	if (await recoveryClaimExists()) throw recoveryClaimError();
	try {
		return await createLock();
	} catch (error) {
		if (error?.code !== "EEXIST") {
			if (error?.message === "E_LEDGER_TRANSACTION_LOCK") throw error;
			throw new Error("E_LEDGER_TRANSACTION_LOCK", { cause: error });
		}
	}

	const stale = await readCanonicalTransactionFile(
		lockPath,
		PROVENANCE_TRANSACTION_MAX_LOCK_BYTES,
		"E_LEDGER_TRANSACTION_LOCK",
	);
	if (stale === undefined || !validProvenanceLock(stale.value)) {
		throw new Error("E_LEDGER_TRANSACTION_LOCK");
	}
	if (processIsAlive(stale.value.pid)) {
		throw new Error("E_LEDGER_TRANSACTION_LOCK");
	}

	let recoveryIdentity;
	try {
		await assertDirectoryIdentity(ledgerParent, ledgerParentIdentity);
		await mkdir(recoveryPath, { mode: 0o700 });
		recoveryIdentity = await directoryIdentity(recoveryPath);
		await assertDirectoryIdentity(ledgerParent, ledgerParentIdentity);
	} catch (error) {
		throw recoveryClaimError(error);
	}

	await hook?.("after-recovery-claim");
	await assertDirectoryIdentity(recoveryPath, recoveryIdentity);
	await recoverProvenanceJournal({
		machineRoot,
		ledgerPath,
		machineParent,
		ledgerParent,
		machineParentIdentity,
		ledgerParentIdentity,
	});
	await assertDirectoryIdentity(recoveryPath, recoveryIdentity);
	await cleanupProvenanceTransactionArtifacts({
		transactionId: stale.value.transactionId,
		machineParent,
		ledgerParent,
	});
	await assertDirectoryIdentity(recoveryPath, recoveryIdentity);
	await removeOwnedFile(
		lockPath,
		stale.identity,
		ledgerParent,
		ledgerParentIdentity,
		"E_LEDGER_TRANSACTION_LOCK",
	);
	await syncDirectory(ledgerParent);

	let fresh;
	try {
		fresh = await createLock();
		await assertDirectoryIdentity(recoveryPath, recoveryIdentity);
		await assertDirectoryIdentity(ledgerParent, ledgerParentIdentity);
		await rmdir(recoveryPath);
		await assertDirectoryIdentity(ledgerParent, ledgerParentIdentity);
		await syncDirectory(ledgerParent);
	} catch (error) {
		throw recoveryClaimError(error);
	}
	return fresh;
}

async function releaseProvenanceLock(lock, ledgerParent, ledgerParentIdentity) {
	await removeOwnedFile(
		lock.path,
		lock.identity,
		ledgerParent,
		ledgerParentIdentity,
		"E_LEDGER_TRANSACTION_LOCK",
	);
	await syncDirectory(ledgerParent);
}

async function transactionTestHook(options, root) {
	if (options.transactionTestHook === undefined) return undefined;
	if (typeof options.transactionTestHook !== "function") {
		throw new Error("E_LEDGER_TEST_HOOK");
	}
	const canonicalRoot = await realpath(root);
	if (!basename(canonicalRoot).startsWith(".tmp-infinite-snowball-")) {
		throw new Error("E_LEDGER_TEST_HOOK");
	}
	return options.transactionTestHook;
}

async function replaceProvenanceOutputs({
	root,
	machineRoot,
	machineOutputs,
	ledgerPath,
	ledgerBytes,
	hook,
}) {
	await assertSafeOutputPath(root, ledgerPath, "file");
	await assertSafeOutputPath(root, machineRoot, "directory");
	const machineParent = resolve(machineRoot, "..");
	const ledgerParent = resolve(ledgerPath, "..");
	const [machineParentIdentity, ledgerParentIdentity] = await Promise.all([
		directoryIdentity(machineParent),
		directoryIdentity(ledgerParent),
	]);
	const lock = await acquireProvenanceLock({
		machineRoot,
		ledgerPath,
		machineParent,
		ledgerParent,
		machineParentIdentity,
		ledgerParentIdentity,
		hook,
	});
	const names = provenanceTransactionNames(lock.transactionId);
	const machineStage = join(machineParent, names.machineStage);
	const machineBackup = join(machineParent, names.machineBackup);
	const ledgerStage = join(ledgerParent, names.ledgerStage);
	const ledgerBackup = join(ledgerParent, names.ledgerBackup);
	const journalPath = join(ledgerParent, PROVENANCE_TRANSACTION_JOURNAL);
	let hadMachine = false;
	let hadLedger = false;
	let machineBackedUp = false;
	let machineInstalled = false;
	let ledgerBackedUp = false;
	let ledgerInstalled = false;
	let journalIdentity;
	let committed = false;

	try {
		await recoverProvenanceJournal({
			machineRoot,
			ledgerPath,
			machineParent,
			ledgerParent,
			machineParentIdentity,
			ledgerParentIdentity,
		});
		await hook?.("after-recovery");
		await assertDirectoryIdentity(machineParent, machineParentIdentity);
		await mkdir(machineStage, { mode: 0o700 });
		const machineStageIdentity = await directoryIdentity(machineStage);
		const outputNames = new Set();
		for (const output of machineOutputs) {
			const name = basename(output.path);
			if (
				name !== output.path.slice(machineRoot.length + 1) ||
				outputNames.has(name)
			) {
				throw new Error("E_LEDGER_OUTPUT_PATH");
			}
			outputNames.add(name);
			await writeExclusiveFile(
				join(machineStage, name),
				output.bytes,
				machineStage,
				machineStageIdentity,
			);
		}
		await syncDirectory(machineStage);
		await writeExclusiveFile(
			ledgerStage,
			ledgerBytes,
			ledgerParent,
			ledgerParentIdentity,
		);
		await syncDirectory(ledgerParent);

		hadMachine = await existingOutput(machineRoot, "directory");
		hadLedger = await existingOutput(ledgerPath, "file");
		const journalBytes = canonicalJsonBytes(
			{
				version: PROVENANCE_TRANSACTION_VERSION,
				transactionId: lock.transactionId,
				...names,
				hadMachine,
				hadLedger,
			},
			PROVENANCE_TRANSACTION_MAX_JOURNAL_BYTES,
			"E_LEDGER_TRANSACTION_JOURNAL",
		);
		journalIdentity = await writeExclusiveFile(
			journalPath,
			journalBytes,
			ledgerParent,
			ledgerParentIdentity,
		);
		await syncDirectory(ledgerParent);

		await assertDirectoryIdentity(machineParent, machineParentIdentity);
		if (hadMachine) {
			await rename(machineRoot, machineBackup);
			machineBackedUp = true;
			await hook?.("after-machine-backup");
		}
		await rename(machineStage, machineRoot);
		machineInstalled = true;
		await hook?.("after-machine-install");

		await assertDirectoryIdentity(ledgerParent, ledgerParentIdentity);
		if (hadLedger) {
			await rename(ledgerPath, ledgerBackup);
			ledgerBackedUp = true;
			await hook?.("after-ledger-backup");
		}
		await rename(ledgerStage, ledgerPath);
		ledgerInstalled = true;
		await hook?.("after-ledger-install");
		await syncDirectory(machineParent);
		await syncDirectory(ledgerParent);
		await removeOwnedFile(
			journalPath,
			journalIdentity,
			ledgerParent,
			ledgerParentIdentity,
			"E_LEDGER_TRANSACTION_JOURNAL",
		);
		committed = true;
	} catch (error) {
		if (ledgerInstalled) await cleanupFile(ledgerPath);
		if (ledgerBackedUp) await rename(ledgerBackup, ledgerPath);
		if (machineInstalled) await cleanupDirectory(machineRoot);
		if (machineBackedUp) await rename(machineBackup, machineRoot);
		await cleanupFile(ledgerStage);
		await cleanupDirectory(machineStage);
		if (journalIdentity !== undefined) {
			await removeOwnedFile(
				journalPath,
				journalIdentity,
				ledgerParent,
				ledgerParentIdentity,
				"E_LEDGER_TRANSACTION_JOURNAL",
			);
			await syncDirectory(ledgerParent);
		}
		throw error;
	} finally {
		if (committed) {
			const cleanupComplete = await finishCommittedTransaction(
				async () => {
					await syncDirectory(ledgerParent);
					await hook?.("before-postcommit-cleanup");
					await cleanupFile(ledgerBackup);
					await cleanupDirectory(machineBackup);
					await cleanupFile(ledgerStage);
					await cleanupDirectory(machineStage);
					await syncDirectory(machineParent);
					await syncDirectory(ledgerParent);
				},
				"Committed provenance output cleanup was deferred.",
				"E_LEDGER_POSTCOMMIT_CLEANUP",
			);
			if (cleanupComplete) {
				await finishCommittedTransaction(
					async () => {
						await hook?.("before-lock-release");
						await releaseProvenanceLock(
							lock,
							ledgerParent,
							ledgerParentIdentity,
						);
					},
					"Committed provenance output cleanup was deferred.",
					"E_LEDGER_POSTCOMMIT_CLEANUP",
				);
			}
		} else {
			await cleanupFile(ledgerStage);
			await cleanupDirectory(machineStage);
			await releaseProvenanceLock(
				lock,
				ledgerParent,
				ledgerParentIdentity,
			);
		}
	}
}

export async function readRetainedLicenseText(root, textPath) {
	return readRepositoryFile(root, textPath, {
		maxFileBytes: 2 * 1024 * 1024,
		maxTotalBytes: 32 * 1024 * 1024,
	});
}

export async function readProvenanceLedger(root) {
	return readRepositoryFile(
		root,
		"docs/licenses/third-party-ledger.md",
		{
			maxEntries: 2_048,
			maxFiles: 1_024,
			maxDepth: 12,
			maxFileBytes: PROVENANCE_OUTPUT_LIMITS.maxHumanLedgerBytes,
			maxTotalBytes: PROVENANCE_OUTPUT_LIMITS.maxHumanLedgerBytes,
		},
	);
}

export async function inspectProvenanceContent(contentRoot) {
	const inventory = await inventoryTree(
		contentRoot,
		PROVENANCE_CONTENT_LIMITS,
	);
	const issues = inventory.issues.map((entry) => ({
		...entry,
		path: `/content${entry.path}`,
	}));
	const entriesByPath = new Map(
		inventory.entries.map((entry) => [entry.relativePath, entry]),
	);
	const expectedDirectories = new Set(PROVENANCE_PACKAGE_DIRECTORIES);
	for (const entry of inventory.entries) {
		if (entry.relativePath !== entry.relativePath.normalize("NFC")) {
			issues.push(
				provenanceContentIssue(
					"E_PATH_POLICY",
					`/content/${entry.relativePath}`,
					"Use only NFC-normalized starter content paths.",
				),
			);
		}
		if (entry.relativePath.includes("/")) continue;
		if (!expectedDirectories.has(entry.relativePath)) {
			issues.push(
				provenanceContentIssue(
					entry.kind === "directory"
						? "E_LEDGER_PACKAGE_MANIFEST"
						: "E_LEDGER_CONTENT_ORPHAN",
					`/content/${entry.relativePath}`,
					"Keep exactly the five canonical starter package directories and no top-level files.",
				),
			);
		} else if (entry.kind !== "directory") {
			issues.push(
				provenanceContentIssue(
					"E_LEDGER_PACKAGE_MANIFEST",
					`/content/${entry.relativePath}/manifest.json`,
					"Restore the canonical starter package as a contained regular directory.",
				),
			);
		}
	}
	for (const packageDirectory of PROVENANCE_PACKAGE_DIRECTORIES) {
		if (entriesByPath.get(packageDirectory)?.kind !== "directory") {
			issues.push(
				provenanceContentIssue(
					"E_LEDGER_PACKAGE_MANIFEST",
					`/content/${packageDirectory}/manifest.json`,
					"Restore every canonical starter package manifest.",
				),
			);
		}
	}
	if (issues.length > 0) {
		return { ok: false, issues, packages: [], inventory };
	}
	const parseManifest = await loadProtocolManifestParser();

	const packages = [];
	const expectedPaths = new Set(PROVENANCE_PACKAGE_DIRECTORIES);
	for (const packageDirectory of PROVENANCE_PACKAGE_DIRECTORIES) {
		const manifestPath = `${packageDirectory}/manifest.json`;
		expectedPaths.add(manifestPath);
		const manifestEntry = entriesByPath.get(manifestPath);
		if (manifestEntry?.kind !== "file" || !manifestEntry.contained) {
			issues.push(
				provenanceContentIssue(
					"E_LEDGER_PACKAGE_MANIFEST",
					`/content/${manifestPath}`,
					"Restore a contained regular JSON manifest for every canonical starter package.",
				),
			);
			continue;
		}
		let manifest;
		try {
			manifest = JSON.parse(
				(await readInventoriedFile(manifestEntry)).toString("utf8"),
			);
		} catch {
			issues.push(
				provenanceContentIssue(
					"E_LEDGER_PACKAGE_MANIFEST",
					`/content/${manifestPath}`,
					"Restore a stable valid JSON manifest for every canonical starter package.",
				),
			);
			continue;
		}
		const validatedManifest = parseManifest(manifest);
		if (!validatedManifest.ok) {
			issues.push(
				provenanceContentIssue(
					"E_LEDGER_PACKAGE_MANIFEST",
					`/content/${manifestPath}`,
					"Validate every starter manifest through the complete bounded protocol contract before provenance derivation.",
				),
			);
			for (const manifestIssue of validatedManifest.issues) {
				const ruleId =
					/^\/assets\/\d+\/path$/u.test(manifestIssue.path)
						? "E_PATH_POLICY"
						: manifestIssue.ruleId;
				issues.push(
					provenanceContentIssue(
						ruleId,
						`/content/${manifestPath}${manifestIssue.path}`,
						manifestIssue.remediation,
					),
				);
			}
			continue;
		}
		manifest = validatedManifest.value;
		const assets = manifest?.assets;
		if (!Array.isArray(assets) || assets.length === 0) {
			issues.push(
				provenanceContentIssue(
					"E_LEDGER_PACKAGE_MANIFEST",
					`/content/${manifestPath}`,
					"Declare a nonempty duplicate-free asset inventory.",
				),
			);
			continue;
		}
		const declaredPaths = new Set();
		for (const [index, asset] of assets.entries()) {
			if (
				!canonicalAssetPath(asset?.path) ||
				declaredPaths.has(asset.path)
			) {
				issues.push(
					provenanceContentIssue(
						"E_PATH_POLICY",
						`/content/${packageDirectory}/manifest.json/assets/${index}/path`,
						"Declare each runtime asset once with a contained canonical NFC assets/ path.",
					),
				);
				continue;
			}
			declaredPaths.add(asset.path);
			addExpectedPathAndParents(
				expectedPaths,
				`${packageDirectory}/${asset.path}`,
			);
		}
		packages.push({
			packageDirectory,
			manifest,
			assetEntries: new Map(),
			assetBytes: new Map(),
		});
	}
	for (const entry of inventory.entries) {
		if (!expectedPaths.has(entry.relativePath)) {
			issues.push(
				provenanceContentIssue(
					"E_LEDGER_CONTENT_ORPHAN",
					`/content/${entry.relativePath}`,
					"Remove undeclared starter content files and directories.",
				),
			);
		}
	}
	for (const packageEntry of packages) {
		for (const asset of packageEntry.manifest.assets) {
			if (!canonicalAssetPath(asset?.path)) continue;
			const relativePath = `${packageEntry.packageDirectory}/${asset.path}`;
			const entry = entriesByPath.get(relativePath);
			if (entry?.kind !== "file" || !entry.contained) {
				issues.push(
					provenanceContentIssue(
						"E_LEDGER_RUNTIME_MISSING",
						`/content/${relativePath}`,
						"Restore every declared runtime asset as a contained regular file.",
					),
				);
			} else {
				packageEntry.assetEntries.set(asset.path, entry);
			}
		}
	}
	if (issues.length > 0) {
		return { ok: false, issues, packages: [], inventory };
	}
	for (const packageEntry of packages) {
		for (const asset of packageEntry.manifest.assets) {
			try {
				packageEntry.assetBytes.set(
					asset.path,
					await readInventoriedFile(
						packageEntry.assetEntries.get(asset.path),
					),
				);
			} catch {
				issues.push(
					provenanceContentIssue(
						"E_PATH_POLICY",
						`/content/${packageEntry.packageDirectory}/${asset.path}`,
						"Reject runtime assets that change after bounded inventory.",
					),
				);
			}
		}
	}
	return {
		ok: issues.length === 0,
		issues,
		packages: issues.length === 0 ? packages : [],
		inventory,
	};
}

function evidenceFailure(asset, cause) {
	const readRace =
		cause instanceof Error &&
		/changed while reading|grew beyond/u.test(cause.message)
			? ": retained evidence changed while reading or grew beyond its inventoried size"
			: "";
	throw new Error(
		`E_LEDGER_LICENSE_EVIDENCE: ${asset?.assetId ?? "unknown-asset"}${readRace}`,
		{ cause },
	);
}

function exactObjectKeys(value, keys) {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null) &&
		JSON.stringify(Object.keys(value).sort()) ===
			JSON.stringify([...keys].sort())
	);
}

function validReviewedEvidenceReplacement(value) {
	return (
		value === null ||
		(exactObjectKeys(value, [
			"provider",
			"sourceUrl",
			"archiveFile",
			"archiveSha256",
		]) &&
			validEvidenceAuthor(value.provider) &&
			validEvidenceSource(value.sourceUrl) &&
			canonicalRepositoryPath(value.archiveFile, 100) &&
			!value.archiveFile.includes("/") &&
			HASH.test(value.archiveSha256))
	);
}

async function resolveProjectOriginalEvidence(root, asset) {
	const creator = asset?.provenance?.creator;
	const provider = asset?.provenance?.provider ?? creator;
	const transformation = asset?.provenance?.transformation;
	const config = transformation?.config;
	const recipe = PROJECT_ORIGINAL_RECIPES.get(transformation?.recipe);
	let moduleBytes;
	let licenseBytes;
	try {
		[moduleBytes, licenseBytes] = await Promise.all([
			readRepositoryFile(root, PROJECT_ORIGINAL_MODULE_PATH),
			readRetainedLicenseText(root, PROJECT_ORIGINAL_LICENSE_PATH),
		]);
	} catch {
		evidenceFailure(asset);
	}
	if (
		creator !== ORIGINAL_CONTENT_CREATOR ||
		provider !== ORIGINAL_CONTENT_CREATOR ||
		asset?.license !== "CC0-1.0" ||
		asset?.licenseUrl !== CC0_LICENSE_URL ||
		asset?.capturedLicenseSha256 !== PROJECT_ORIGINAL_LICENSE_SHA256 ||
		sha256(licenseBytes) !== PROJECT_ORIGINAL_LICENSE_SHA256 ||
		asset?.provenance?.source !== PROJECT_ORIGINAL_SOURCE_URL ||
		asset?.provenance?.sourceArtifactSha256 !== sha256(moduleBytes) ||
		transformation?.tool?.name !==
			"@infinite-snowball/asset-pipeline" ||
		transformation?.tool?.version !== "1.0.0" ||
		recipe === undefined ||
		!exactObjectKeys(config, [
			"deterministic",
			"format",
			"pipelineConfigSha256",
		]) ||
		config.deterministic !== true ||
		config.format !== recipe.format ||
		config.pipelineConfigSha256 !== PROJECT_PIPELINE_CONFIG_SHA256 ||
		transformation.configSha256 !== recipe.configSha256 ||
		canonicalConfigSha256(config) !== transformation.configSha256
	) {
		evidenceFailure(asset);
	}
	return {
		kind: "project-original",
		provider,
		sourceUrl: PROJECT_ORIGINAL_SOURCE_URL,
		sourceArtifact: PROJECT_ORIGINAL_MODULE_PATH,
		spdx: "CC0-1.0",
		url: CC0_LICENSE_URL,
		textPath: PROJECT_ORIGINAL_LICENSE_PATH,
		textSha256: PROJECT_ORIGINAL_LICENSE_SHA256,
		grant:
			"Original generated Infinite Snowball starter-content asset dedicated under CC0 1.0.",
	};
}

export async function resolveRetainedLicenseEvidence(
	root,
	asset,
	dispatch,
) {
	const creator = asset?.provenance?.creator;
	const provider = asset?.provenance?.provider ?? creator;
	const sourceUrl = asset?.provenance?.source;
	if (!validEvidenceAuthor(creator) || provider !== creator) {
		evidenceFailure(asset);
	}
	if (creator === ORIGINAL_CONTENT_CREATOR) {
		return resolveProjectOriginalEvidence(root, asset);
	}
	if (dispatch !== undefined && !Array.isArray(dispatch)) {
		evidenceFailure(asset);
	}
	const reviewedDispatch = [
		...BUILTIN_RETAINED_CC0_EVIDENCE,
		...(dispatch ?? []),
	];
	const retained = reviewedDispatch.find(
		(candidate) =>
			candidate.provider === provider &&
			equivalentCanonicalUrl(candidate.sourceUrl, sourceUrl) &&
			candidate.spdx === asset?.license &&
			candidate.url === asset?.licenseUrl &&
			candidate.textSha256 === asset?.capturedLicenseSha256,
	);
	if (retained === undefined) evidenceFailure(asset);
	if (
		!canonicalRepositoryPath(retained.sourceRoot) ||
		!retained.sourceRoot.startsWith("tools/assets/sources/") ||
		!Array.isArray(retained.sourceFiles) ||
		retained.sourceFiles.length === 0 ||
		retained.sourceFiles.length > 32 ||
		new Set(retained.sourceFiles).size !== retained.sourceFiles.length ||
		retained.sourceFiles.some(
			(file) =>
				!canonicalRepositoryPath(file, 100) || file.includes("/"),
		) ||
		!Array.isArray(retained.sourceMembers) ||
		retained.sourceMembers.length === 0 ||
		retained.sourceMembers.length > 16 ||
		retained.sourceMembers.some(
			(member) =>
				!canonicalRepositoryPath(member?.member) ||
				!canonicalRepositoryPath(member?.file, 100) ||
				member.file.includes("/") ||
				!HASH.test(member?.sha256 ?? "") ||
				!retained.sourceFiles.includes(member.file),
		) ||
		new Set(
			retained.sourceMembers.map((member) => member.member),
		).size !== retained.sourceMembers.length ||
		typeof retained.artifactPrefix !== "string" ||
		retained.artifactPrefix.length === 0 ||
		retained.artifactPrefix.includes("#") ||
		retained.artifactPrefix.includes("/") ||
		retained.artifactPrefix.includes("\\") ||
		!canonicalRepositoryPath(retained.textPath) ||
		!HASH.test(retained.textSha256 ?? "") ||
		typeof retained.grant !== "string" ||
		retained.grant.length === 0
	) {
		evidenceFailure(asset);
	}
	if (
		retained.evidencePath !== undefined &&
		(retained.evidencePath !==
			`${retained.sourceRoot}/source-evidence.json` ||
			!retained.sourceFiles.includes("source-evidence.json"))
	) {
		evidenceFailure(asset);
	}
	const bundle = await containedRepositoryDirectory(
		root,
		retained.sourceRoot,
		{
			maxEntries: 32,
			maxFiles: 32,
			maxDepth: 1,
			maxFileBytes: 32 * 1024 * 1024,
			maxTotalBytes: 64 * 1024 * 1024,
		},
	);
	const actualFiles = bundle.entries
		.filter((entry) => entry.kind === "file" && entry.contained)
		.map((entry) => entry.relativePath)
		.sort();
	if (
		!bundle.ok ||
		bundle.entries.some(
			(entry) => entry.kind !== "file" || !entry.contained,
		) ||
		JSON.stringify(actualFiles) !==
			JSON.stringify([...retained.sourceFiles].sort())
	) {
		evidenceFailure(asset);
	}
	const entries = new Map(
		bundle.entries.map((entry) => [entry.relativePath, entry]),
	);
	const retainedMemberBytes = new Map();
	try {
		for (const member of retained.sourceMembers) {
			const bytes = await readInventoriedFile(entries.get(member.file));
			if (sha256(bytes) !== member.sha256) evidenceFailure(asset);
			retainedMemberBytes.set(member.member, bytes);
		}
	} catch (cause) {
		evidenceFailure(asset, cause);
	}
	const configuredMember =
		asset?.provenance?.transformation?.config?.sourceMember;
	const selectedMember = retained.sourceMembers.find(
		(member) => member.member === configuredMember,
	);
	if (
		selectedMember === undefined ||
		!retainedMemberBytes.has(selectedMember.member) ||
		selectedMember.sha256 !==
			asset?.provenance?.sourceArtifactSha256
	) {
		evidenceFailure(asset);
	}
	let licenseBytes;
	try {
		licenseBytes = await readRetainedLicenseText(root, retained.textPath);
	} catch (cause) {
		evidenceFailure(asset, cause);
	}
	if (sha256(licenseBytes) !== retained.textSha256) {
		evidenceFailure(asset);
	}
	if (retained.evidencePath !== undefined) {
		let sourceEvidence;
		let sourceEvidenceBytes;
		try {
			sourceEvidenceBytes = await readInventoriedFile(
				entries.get("source-evidence.json"),
			);
			sourceEvidence = JSON.parse(sourceEvidenceBytes.toString("utf8"));
		} catch {
			evidenceFailure(asset);
		}
		const reviewed = retained.reviewedEvidence;
		const primarySource = retained.sourceMembers[0];
		const expectedSourceEvidence = {
			schemaVersion: reviewed?.schemaVersion,
			provider,
			pack: reviewed?.pack,
			sourceUrl,
			archiveFile: retained.artifactPrefix,
			archiveBytes: reviewed?.archiveBytes,
			archiveSha256: reviewed?.archiveSha256,
			sourceMember: primarySource?.member,
			sourceArtifactSha256: primarySource?.sha256,
			creator,
			acquiredAt: reviewed?.acquiredAt,
			license: {
				spdx: retained.spdx,
				url: retained.url,
				member: reviewed?.licenseMember,
				textPath: reviewed?.licenseTextPath,
				textSha256: retained.textSha256,
			},
			preview: reviewed?.preview,
			reviewer: reviewed?.reviewer,
			reviewedAt: reviewed?.reviewedAt,
			evidenceStatus: reviewed?.evidenceStatus,
			notes: reviewed?.notes,
			replacement: reviewed?.replacement,
		};
		const reviewedMembers = [
			{
				member: primarySource?.member,
				file: primarySource?.file,
				sha256: primarySource?.sha256,
			},
			{
				member: reviewed?.preview?.member,
				file: reviewed?.preview?.path,
				sha256: reviewed?.preview?.sha256,
			},
		];
		if (
			!exactObjectKeys(sourceEvidence, [
				"schemaVersion",
				"provider",
				"pack",
				"sourceUrl",
				"archiveFile",
				"archiveBytes",
				"archiveSha256",
				"sourceMember",
				"sourceArtifactSha256",
				"creator",
				"acquiredAt",
				"license",
				"preview",
				"reviewer",
				"reviewedAt",
				"evidenceStatus",
				"notes",
				"replacement",
			]) ||
			!exactObjectKeys(sourceEvidence?.license, [
				"spdx",
				"url",
				"member",
				"textPath",
				"textSha256",
			]) ||
			!exactObjectKeys(sourceEvidence?.preview, [
				"member",
				"path",
				"sha256",
			]) ||
			!exactObjectKeys(reviewed, [
				"schemaVersion",
				"pack",
				"archiveBytes",
				"archiveSha256",
				"acquiredAt",
				"licenseMember",
				"licenseTextPath",
				"preview",
				"reviewer",
				"reviewedAt",
				"evidenceStatus",
				"notes",
				"replacement",
			]) ||
			!Number.isSafeInteger(reviewed.archiveBytes) ||
			reviewed.archiveBytes <= 0 ||
			!HASH.test(reviewed.archiveSha256 ?? "") ||
			!validReviewedEvidenceReplacement(reviewed.replacement) ||
			reviewed.evidenceStatus !== "verified" ||
			reviewed.acquiredAt !==
				(asset.provenance.acquiredAt ??
					asset.provenance.reviewedAt) ||
			reviewed.reviewedAt !== asset.provenance.reviewedAt ||
			!HASH.test(retained.evidenceSha256 ?? "") ||
			sha256(sourceEvidenceBytes) !== retained.evidenceSha256 ||
			!sourceEvidenceBytes.equals(
				Buffer.from(
					`${JSON.stringify(sourceEvidence, null, "\t")}\n`,
					"utf8",
				),
			) ||
			!isDeepStrictEqual(sourceEvidence, expectedSourceEvidence) ||
			!isDeepStrictEqual(
				reviewedMembers,
				retained.sourceMembers.map(
					({ member, file, sha256: memberSha256 }) => ({
						member,
						file,
						sha256: memberSha256,
					}),
				),
			)
		) {
			evidenceFailure(asset);
		}
	}
	return {
		kind: "retained",
		provider,
		sourceUrl,
		sourceArtifact: `${retained.artifactPrefix}#${selectedMember.member}`,
		spdx: retained.spdx,
		url: retained.url,
		textPath: retained.textPath,
		textSha256: retained.textSha256,
		grant: retained.grant,
		author: creator,
		source: sourceUrl,
	};
}

function licenseEvidence(asset, retainedEvidence) {
	const creator = asset?.provenance?.creator;
	const provider = asset?.provenance?.provider ?? creator;
	const source = asset?.provenance?.source;
	if (
		!validEvidenceAuthor(creator) ||
		provider !== creator ||
		!validEvidenceSource(source) ||
		!HASH.test(asset?.capturedLicenseSha256 ?? "") ||
		retainedEvidence?.provider !== provider ||
		retainedEvidence?.sourceUrl !== source ||
		retainedEvidence?.spdx !== asset?.license ||
		retainedEvidence?.url !== asset?.licenseUrl ||
		retainedEvidence?.textSha256 !==
			asset?.capturedLicenseSha256
	) {
		evidenceFailure(asset);
	}
	switch (asset.license) {
		case "CC0-1.0":
			if (asset.licenseUrl !== CC0_LICENSE_URL) {
				evidenceFailure(asset);
			}
			break;
		case "CC-BY-4.0":
			if (
				retainedEvidence.kind !== "retained" ||
				asset.licenseUrl !== CC_BY_LICENSE_URL ||
				equivalentCanonicalUrl(source, CC_BY_LICENSE_URL) ||
				typeof asset?.provenance?.attribution !== "string" ||
				!asset.provenance.attribution.includes(creator)
			) {
				evidenceFailure(asset);
			}
			break;
		default:
			throw new Error(
				`E_LEDGER_LICENSE_UNMAPPED: ${asset?.assetId ?? "unknown-asset"}`,
			);
	}
	return {
		spdx: retainedEvidence.spdx,
		url: retainedEvidence.url,
		textPath: retainedEvidence.textPath,
		textSha256: retainedEvidence.textSha256,
		...(asset.license === "CC-BY-4.0"
			? { author: creator, source }
			: {}),
		grant: retainedEvidence.grant,
	};
}

export function provenanceRecordFileName(record) {
	const packageMatch =
		typeof record?.packageName === "string"
			? /^@infinite-snowball\/([a-z0-9][a-z0-9._-]*)$/u.exec(record.packageName)
			: null;
	if (
		packageMatch === null ||
		typeof record?.assetId !== "string" ||
		!/^(?!__proto__$)[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(record.assetId)
	) {
		throw new Error(
			"E_LEDGER_PATH: provenance package and asset IDs must satisfy the frozen manifest grammars",
		);
	}
	const readablePackage = packageMatch[1].slice(0, 48);
	const readableAsset = encodeURIComponent(record.assetId).slice(0, 64);
	const identityHash = sha256(
		Buffer.from(JSON.stringify([record.packageName, record.assetId]), "utf8"),
	);
	const fileName = `${readablePackage}--${readableAsset}--${identityHash}.json`;
	if (fileName.includes("/") || fileName.includes("\\") || fileName === ".") {
		throw new Error(
			"E_LEDGER_PATH: provenance record filename escaped its containing directory",
		);
	}
	return fileName;
}

export function reconstructProvenanceRecord({
	packageDirectory,
	manifest,
	asset,
	runtimeBytes,
	retainedLicenseEvidence,
}) {
	const packageLicense = validatePackageLicensePolicy(manifest);
	if (!packageLicense.ok) {
		throw new Error(
			`E_LEDGER_PACKAGE_LICENSE: ${packageLicense.issues
				.map((entry) => entry.ruleId)
				.join(",")}`,
		);
	}
	const runtimeSha256 = sha256(runtimeBytes);
	if (runtimeSha256 !== asset.sha256 || runtimeBytes.length !== asset.bytes) {
		throw new Error(
			`E_LEDGER_SOURCE_MISMATCH: ${packageDirectory}/${asset.path}`,
		);
	}
	const recordId = `asset:${manifest.name}:${manifest.version}:${asset.assetId}`;
	const outputPath = `content/${packageDirectory}/${asset.path}`;
	const modifications = Array.isArray(asset?.provenance?.modifications)
		? asset.provenance.modifications
		: [];
	return {
		schemaVersion: 1,
		recordId,
		id: recordId,
		packageName: manifest.name,
		packageVersion: manifest.version,
		packageKind: manifest.kind,
		packageLicense: packageLicense.license,
		packagePath: `content/${packageDirectory}/manifest.json`,
		assetId: asset.assetId,
		assetPath: asset.path,
		mime: asset.mime,
		bytes: runtimeBytes.length,
		sha256: runtimeSha256,
		role: asset.role,
		provider: retainedLicenseEvidence.provider,
		creator: asset.provenance.creator,
		sourceUrl: retainedLicenseEvidence.sourceUrl,
		sourceArtifact: retainedLicenseEvidence.sourceArtifact,
		sourceArtifactSha256: asset.provenance.sourceArtifactSha256,
		acquisition: asset.provenance.acquisition,
		acquiredAt:
			asset.provenance.acquiredAt ?? asset.provenance.reviewedAt,
		license: licenseEvidence(asset, retainedLicenseEvidence),
		reviewer: asset.provenance.reviewer,
		reviewedAt: asset.provenance.reviewedAt,
		evidenceStatus: asset.provenance.evidenceStatus,
		attribution: asset.provenance.attribution,
		modifications,
		transformation: asset.provenance.transformation,
		notes: asset.provenance.notes,
		replacement: asset.provenance.replacement,
		output: {
			path: outputPath,
			sha256: runtimeSha256,
		},
		transformations: [
			...modifications,
			`${asset?.provenance?.transformation?.recipe ?? "unknown-recipe"} config ${asset?.provenance?.transformation?.configSha256 ?? "missing"}`,
		],
		provenanceSha256: sha256(
			Buffer.from(JSON.stringify(asset.provenance), "utf8"),
		),
		assetRecordSha256: sha256(Buffer.from(JSON.stringify(asset), "utf8")),
	};
}

export function formatProvenanceLedgerRow(record) {
	const recipe = [
		record.transformation.recipe,
		`${record.transformation.tool.name}@${record.transformation.tool.version}`,
		`config ${record.transformation.configSha256}`,
		inlineJson(record.transformation.config),
	].join("; ");
	const values = [
		`\`${record.recordId}\``,
		`\`${record.packageName}@${record.packageVersion}\``,
		record.packageLicense,
		`${record.assetId}; ${record.assetPath}; ${record.mime}; ${record.bytes} bytes; ${record.sha256}`,
		record.role,
		record.creator,
		`[source](${record.sourceUrl})`,
		record.acquisition,
		`${record.sourceArtifact}; ${record.sourceArtifactSha256}`,
		`[${record.license.spdx}](${record.license.url})`,
		`${record.license.textPath}; ${record.license.textSha256}; ${record.license.grant}`,
		record.attribution,
		inlineJson(record.modifications),
		recipe,
		`${record.output.path}; ${record.output.sha256}`,
		record.reviewer,
		`${record.acquiredAt}; ${record.reviewedAt}`,
		record.evidenceStatus,
		inlineJson(record.replacement),
		record.notes,
	];
	return `| ${values.map(markdown).join(" | ")} |`;
}

function provenanceLedgerPreamble(recordCount) {
	return [
		"# Infinite Snowball starter-content provenance ledger",
		"",
		"This ledger covers every runtime asset in the checked-in starter packages, including original generated assets and approved CC0 or fully evidenced CC BY assets. It records evidence; it does not imply affiliation with any other game or publisher.",
		"",
		`Generated deterministically from ${recordCount} package asset records. Machine-readable records live in \`docs/licenses/provenance/records/\`.`,
		"",
		...PROVENANCE_LEDGER_HEADER,
	];
}

const PROVENANCE_LEDGER_FOOTER = Object.freeze([
	"",
	"## Policy notes",
	"",
	"- Kenney Nature Kit evidence includes the exact archive, GLB member, preview member, and captured CC0 license hashes.",
	"- CC BY 4.0 evidence binds the exact author, original HTTPS source, attribution, canonical license URL, and hash-addressed retained license text.",
	"- Original icons and the original `Snowdrift Signal` PCM loop are reproducible outputs dedicated under CC0 1.0.",
	"- No commercial soundtrack files, franchise assets, user ratings, or store-install claims are included.",
	"- Withdrawn or disputed evidence blocks new installs while preserving save/history references and a migration target.",
	"",
]);

export function formatProvenanceLedger(records) {
	const ordered = [...records].sort((left, right) =>
		compareCodeUnits(left.recordId, right.recordId),
	);
	return [
		...provenanceLedgerPreamble(ordered.length),
		...ordered.map(formatProvenanceLedgerRow),
		...PROVENANCE_LEDGER_FOOTER,
	].join("\n");
}

export async function generateProvenanceLedger(options = {}) {
	const root = resolve(options.root ?? process.cwd());
	const contentRoot = resolve(options.contentRoot ?? join(root, "content"));
	const machineRoot = resolve(
		root,
		"docs",
		"licenses",
		"provenance",
		"records",
	);
	const ledgerPath = resolve(
		root,
		"docs",
		"licenses",
		"third-party-ledger.md",
	);
	if (
		(options.machineRoot !== undefined &&
			resolve(options.machineRoot) !== machineRoot) ||
		(options.ledgerPath !== undefined &&
			resolve(options.ledgerPath) !== ledgerPath)
	) {
		throw new Error("E_LEDGER_OUTPUT_PATH");
	}
	await assertSafeOutputPath(root, ledgerPath, "file");
	await assertSafeOutputPath(root, machineRoot, "directory");
	const records = [];
	const inspected = await inspectProvenanceContent(contentRoot);
	if (!inspected.ok) {
		throw new Error(
			`E_LEDGER_CONTENT_INSPECTION: ${inspected.issues
				.map((entry) => entry.ruleId)
				.join(",")}`,
		);
	}
	for (const packageEntry of inspected.packages) {
		const { packageDirectory, manifest, assetBytes } = packageEntry;
		const packageLicense = validatePackageLicensePolicy(manifest);
		if (!packageLicense.ok) {
			throw new Error(
				`E_LEDGER_PACKAGE_LICENSE: ${packageLicense.issues
					.map((entry) => entry.ruleId)
					.join(",")}`,
			);
		}
		for (const asset of manifest.assets) {
			const retainedLicenseEvidence =
				await resolveRetainedLicenseEvidence(
					root,
					asset,
					options.retainedEvidenceDispatch,
				);
			if (records.length >= PROVENANCE_OUTPUT_LIMITS.maxRecords)
				throw new Error("E_LEDGER_OUTPUT_BUDGET");
			records.push(
				reconstructProvenanceRecord({
					packageDirectory,
					manifest,
					asset,
					runtimeBytes: assetBytes.get(asset.path),
					retainedLicenseEvidence,
				}),
			);
		}
	}
	records.sort((left, right) =>
		compareCodeUnits(left.recordId, right.recordId),
	);
	const machineOutputs = [];
	let machineBytes = 0;
	let maxRecordBytes = 0;
	const ledgerLines = provenanceLedgerPreamble(records.length);
	let humanLedgerBytes = Buffer.byteLength(ledgerLines.join("\n"), "utf8");
	if (humanLedgerBytes > PROVENANCE_OUTPUT_LIMITS.maxHumanLedgerBytes)
		throw new Error("E_LEDGER_OUTPUT_BUDGET");
	for (const record of records) {
		const output = {
			path: join(machineRoot, provenanceRecordFileName(record)),
			bytes: Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"),
		};
		const nextMachineBytes = machineBytes + output.bytes.length;
		if (
			output.bytes.length > PROVENANCE_OUTPUT_LIMITS.maxRecordBytes ||
			!Number.isSafeInteger(nextMachineBytes) ||
			nextMachineBytes > PROVENANCE_OUTPUT_LIMITS.maxMachineBytes
		)
			throw new Error("E_LEDGER_OUTPUT_BUDGET");
		machineBytes = nextMachineBytes;
		maxRecordBytes = Math.max(maxRecordBytes, output.bytes.length);
		machineOutputs.push(output);

		const row = formatProvenanceLedgerRow(record);
		const rowBytes = Buffer.byteLength(row, "utf8");
		const nextHumanLedgerBytes = humanLedgerBytes + 1 + rowBytes;
		if (
			rowBytes > PROVENANCE_OUTPUT_LIMITS.maxRecordBytes ||
			!Number.isSafeInteger(nextHumanLedgerBytes) ||
			nextHumanLedgerBytes > PROVENANCE_OUTPUT_LIMITS.maxHumanLedgerBytes
		)
			throw new Error("E_LEDGER_OUTPUT_BUDGET");
		humanLedgerBytes = nextHumanLedgerBytes;
		ledgerLines.push(row);
	}
	const footerBytes =
		1 + Buffer.byteLength(PROVENANCE_LEDGER_FOOTER.join("\n"), "utf8");
	if (
		!Number.isSafeInteger(humanLedgerBytes + footerBytes) ||
		humanLedgerBytes + footerBytes >
			PROVENANCE_OUTPUT_LIMITS.maxHumanLedgerBytes
	)
		throw new Error("E_LEDGER_OUTPUT_BUDGET");
	humanLedgerBytes += footerBytes;
	ledgerLines.push(...PROVENANCE_LEDGER_FOOTER);
	const ledger = ledgerLines.join("\n");
	const ledgerBytes = Buffer.from(ledger, "utf8");
	if (
		!validateProvenanceOutputMetrics({
			recordCount: machineOutputs.length,
			maxRecordBytes,
			machineBytes,
			humanLedgerBytes,
		}) ||
		ledgerBytes.length !== humanLedgerBytes
	)
		throw new Error("E_LEDGER_OUTPUT_BUDGET");

	const hook = await transactionTestHook(options, root);
	await replaceProvenanceOutputs({
		root,
		machineRoot,
		machineOutputs,
		ledgerPath,
		ledgerBytes,
		hook,
	});

	return {
		records: records.length,
		machineRoot,
		ledgerPath,
		ledgerSha256: sha256(ledgerBytes),
	};
}
