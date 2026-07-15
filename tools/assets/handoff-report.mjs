import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
	buildAssetBudgetReport,
	CONFIG_SHA256,
	contentDigest,
	inspectStarterPackages,
} from "./lib/asset-pipeline.mjs";
import {
	inventoryTree,
	readInventoriedFile,
} from "./lib/tree-inventory.mjs";
import {
	LOCAL_AUDIO_FIXTURE_MAX_BYTES,
	LOCAL_AUDIO_FIXTURE_RELATIVE_PATH,
	validateLocalAudioFixture,
} from "./lib/local-audio-fixture.mjs";
import {
	createWithdrawalRegistryRecord,
	readCanonicalWithdrawalRecord,
	validatePackageLicensePolicy,
	validateWithdrawalPackageBinding,
} from "./lib/policy.mjs";
import {
	provenanceRecordFileName,
	resolveRetainedLicenseEvidence,
} from "./lib/provenance-ledger.mjs";

const root = process.cwd();
const canonicalRoot = await realpath(root);
const requestedModes = process.argv.slice(2);
if (
	requestedModes.length > 1 ||
	(requestedModes.length === 1 && requestedModes[0] !== "--check")
) {
	throw new Error("Usage: node tools/assets/handoff-report.mjs [--check]");
}
const check = requestedModes[0] === "--check";
const execFileAsync = promisify(execFile);
const packageDirectories = [
	"starter-level",
	"starter-objects",
	"starter-character",
	"starter-campaign",
	"starter-music",
];
const referenceRenderSpecs = Object.freeze([
	Object.freeze({
		renderId: "starter-level-scene",
		kind: "level-scene",
		representativeReuseOf: null,
		packageDirectory: "content/starter-level",
		assetId: "arena",
		path: "docs/assets/reference-renders/starter-level-scene.png",
	}),
	Object.freeze({
		renderId: "starter-object-rock",
		kind: "object",
		representativeReuseOf: null,
		packageDirectory: "content/starter-objects",
		assetId: "render",
		path: "docs/assets/reference-renders/starter-object-rock.png",
	}),
	Object.freeze({
		renderId: "starter-character-pebble-friend",
		kind: "character",
		representativeReuseOf: null,
		packageDirectory: "content/starter-character",
		assetId: "model",
		path:
			"docs/assets/reference-renders/starter-character-pebble-friend.png",
	}),
]);
const sourceEvidenceDirectory = "tools/assets/sources/kenney-nature-kit";
const sourceEvidencePaths = Object.freeze([
	`${sourceEvidenceDirectory}/License.txt`,
	`${sourceEvidenceDirectory}/rock_smallA-preview.png`,
	`${sourceEvidenceDirectory}/rock_smallA.glb`,
	`${sourceEvidenceDirectory}/source-evidence.json`,
]);
const maxEvidenceFileBytes = 16 * 1024 * 1024;
const evidenceDirectories = Object.freeze([
	"docs/licenses",
	"docs/brand",
	"docs/music",
	"docs/assets/reference-renders",
	sourceEvidenceDirectory,
]);
const evidenceInventoryLimits = Object.freeze({
	maxEntries: 256,
	maxFiles: 128,
	maxDepth: 8,
	maxFileBytes: maxEvidenceFileBytes,
	maxTotalBytes: 64 * 1024 * 1024,
});

function hash(algorithm, bytes, encoding = "hex") {
	return createHash(algorithm).update(bytes).digest(encoding);
}

function assertRepresentativeReuseDeclarations(references) {
	const renderIds = new Set(references.map((reference) => reference.renderId));
	if (renderIds.size !== references.length)
		throw new Error(
			"E_RENDER_REFERENCE_IDENTITY: reference render IDs must be unique.",
		);
	for (const reference of references) {
		if (
			reference.representativeReuseOf !== null &&
			(typeof reference.representativeReuseOf !== "string" ||
				reference.representativeReuseOf === reference.renderId ||
				!renderIds.has(reference.representativeReuseOf))
		) {
			throw new Error(
				`E_RENDER_REFERENCE_IDENTITY: invalid representativeReuseOf for ${String(reference.renderId)}.`,
			);
		}
	}
}

function representativeReuseDeclared(left, right) {
	return (
		left.representativeReuseOf === right.renderId ||
		right.representativeReuseOf === left.renderId
	);
}

function assertDistinctReferenceValues(references, selectValue, label) {
	const firstByValue = new Map();
	for (const reference of references) {
		const value = selectValue(reference);
		if (typeof value !== "string" || value.length === 0)
			throw new Error(
				`E_RENDER_REFERENCE_IDENTITY: ${String(reference.renderId)} lacks ${label}.`,
			);
		const first = firstByValue.get(value);
		if (
			first !== undefined &&
			!representativeReuseDeclared(first, reference)
		) {
			throw new Error(
				`E_RENDER_REFERENCE_IDENTITY: ${first.renderId} and ${String(reference.renderId)} share ${label} without explicit representative reuse.`,
			);
		}
		if (first === undefined) firstByValue.set(value, reference);
	}
}

function assertDeclaredRepresentativeReuseMatches(
	references,
	selectValue,
	label,
) {
	const referenceById = new Map(
		references.map((reference) => [reference.renderId, reference]),
	);
	for (const reference of references) {
		if (typeof reference.representativeReuseOf !== "string") continue;
		const representative = referenceById.get(reference.representativeReuseOf);
		if (
			representative === undefined ||
			selectValue(reference) !== selectValue(representative)
		) {
			throw new Error(
				`E_RENDER_REFERENCE_IDENTITY: ${reference.renderId} declares representative reuse but does not share ${label}.`,
			);
		}
	}
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
	const absolutePath = resolve(root, relativePath);
	const expectedPath = resolve(canonicalRoot, relativePath);
	const metadata = await lstat(absolutePath);
	if (
		!metadata.isDirectory() ||
		(await realpath(absolutePath)) !== expectedPath
	)
		throw new Error(
			`Evidence directory crosses a symlink or leaves the canonical project root: ${relativePath}`,
		);
	return absolutePath;
}

async function readOwnedRegularFile(
	relativePath,
	maxBytes = maxEvidenceFileBytes,
) {
	const absolutePath = resolve(root, relativePath);
	const expectedPath = resolve(canonicalRoot, relativePath);
	const metadata = await lstat(absolutePath);
	if (!metadata.isFile() || (await realpath(absolutePath)) !== expectedPath)
		throw new Error(
			`Evidence file crosses a symlink or leaves the canonical project root: ${relativePath}`,
		);
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
			openedMetadata.size > maxBytes
		) {
			throw new Error(
				`Evidence file changed before reading or exceeds ${maxBytes} bytes: ${relativePath}`,
			);
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
			if (bytesRead === 0)
				throw new Error(
					`Evidence file changed while reading: ${relativePath}`,
				);
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
			throw new Error(
				`Evidence file changed while reading or grew beyond its inventoried size: ${relativePath}`,
			);
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

async function writeOwnedFileAtomically(relativePath, bytes) {
	const absolutePath = resolve(root, relativePath);
	const expectedPath = resolve(canonicalRoot, relativePath);
	try {
		const metadata = await lstat(absolutePath);
		if (!metadata.isFile() || (await realpath(absolutePath)) !== expectedPath)
			throw new Error(
				`Handoff target crosses a symlink or is not a regular file: ${relativePath}`,
			);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	const temporaryPath = `${absolutePath}.tmp-${process.pid}`;
	let handle;
	try {
		handle = await open(
			temporaryPath,
			fsConstants.O_WRONLY |
				fsConstants.O_CREAT |
				fsConstants.O_EXCL |
				fsConstants.O_NOFOLLOW,
			0o644,
		);
		await handle.writeFile(bytes);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporaryPath, absolutePath);
	} catch (error) {
		await handle?.close().catch(() => {});
		await rm(temporaryPath, { force: true }).catch(() => {});
		throw error;
	}
}


async function inventoryEvidenceFiles(initialBytes) {
	let entryCount = 1;
	let fileCount = 1;
	let totalBytes = initialBytes;
	const files = [];
	for (const directory of evidenceDirectories) {
		const ownedDirectory = await requireOwnedDirectory(directory);
		const inventory = await inventoryTree(ownedDirectory, {
			maxEntries: evidenceInventoryLimits.maxEntries - entryCount,
			maxFiles: evidenceInventoryLimits.maxFiles - fileCount,
			maxDepth: evidenceInventoryLimits.maxDepth,
			maxFileBytes: evidenceInventoryLimits.maxFileBytes,
			maxTotalBytes: evidenceInventoryLimits.maxTotalBytes - totalBytes,
		});
		if (inventory.rootRealpath !== resolve(canonicalRoot, directory)) {
			throw new Error(
				`Bounded P03 evidence inventory failed: E_PATH_POLICY:/${directory}`,
			);
		}
		if (!inventory.ok) {
			throw new Error(
				`Bounded P03 evidence inventory failed: ${inventory.issues
					.map((entry) => `${entry.ruleId}:${entry.path}`)
					.join(",")}`,
			);
		}
		for (const entry of inventory.entries) {
			entryCount += 1;
			if (entry.kind === "directory") continue;
			if (entry.kind !== "file" || !entry.contained)
				throw new Error(
					`Bounded P03 evidence inventory rejected ${entry.kind}: ${directory}/${entry.relativePath}`,
				);
			fileCount += 1;
			totalBytes += entry.bytes;
			files.push({
				entry,
				path: `${directory}/${entry.relativePath}`,
			});
		}
	}
	return files;
}
function evidenceCategory(path) {
	if (path === "docs/assets/starter-content-budget.json") return "asset-budget";
	if (path === "docs/licenses/third-party-ledger.md") return "human-ledger";
	if (path.startsWith("docs/licenses/provenance/records/"))
		return "machine-provenance";
	if (path.startsWith("docs/licenses/withdrawals/"))
		return "withdrawal-registry";
	if (path.startsWith("docs/licenses/provenance/")) return "captured-license";
	if (path === "docs/licenses/asset-policy.md") return "provenance-policy";
	if (path === "docs/licenses/withdrawal-policy.md") return "withdrawal-policy";
	if (path.startsWith("docs/brand/")) return "brand-review";
	if (path === "docs/music/local-import-boundary.md")
		return "local-audio-policy";
	if (path.startsWith("docs/music/")) return "music-policy";
	if (path === "docs/assets/reference-renders/index.json")
		return "render-metadata";
	if (path.startsWith("docs/assets/reference-renders/"))
		return "reference-render";
	if (path.startsWith(`${sourceEvidenceDirectory}/`))
		return "source-evidence";
	throw new Error(`Unclassified P03 evidence artifact: ${path}`);
}

async function buildEvidenceInventory() {
	const budgetPath = "docs/assets/starter-content-budget.json";
	const budgetBytes = await readOwnedRegularFile(budgetPath);
	const discovered = await inventoryEvidenceFiles(budgetBytes.length);
	const inventory = [
		{
			category: evidenceCategory(budgetPath),
			path: budgetPath,
			bytes: budgetBytes.length,
			sha256: hash("sha256", budgetBytes),
		},
		...(await Promise.all(
			discovered.map(async ({ entry, path }) => {
				const bytes = await readInventoriedFile(entry);
				return {
					category: evidenceCategory(path),
					path,
					bytes: bytes.length,
					sha256: hash("sha256", bytes),
				};
			}),
		)),
	].sort((left, right) =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
	);
	if (new Set(inventory.map((entry) => entry.path)).size !== inventory.length)
		throw new Error("P03 evidence inventory contains duplicate paths.");
	return inventory;
}

function requireExactEvidencePaths(label, actual, expected) {
	const sortedActual = [...actual].sort();
	const sortedExpected = [...expected].sort();
	if (JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected))
		throw new Error(
			`${label} evidence paths are missing or unexpected: expected ${sortedExpected.join(", ")}; received ${sortedActual.join(", ") || "(none)"}.`,
		);
}

async function resolvePackageLicenseEvidence(inspectedByDirectory) {
	const resolved = [];
	for (const directory of packageDirectories) {
		const inspected = inspectedByDirectory.get(directory);
		if (!inspected)
			throw new Error(`Missing inspected starter package: ${directory}`);
		for (const asset of inspected.manifest.assets) {
			const resolution = await resolveRetainedLicenseEvidence(root, asset);
			resolved.push({
				packageName: inspected.manifest.name,
				assetId: asset.assetId,
				kind: resolution.kind,
				provider: resolution.provider,
				sourceUrl: resolution.sourceUrl,
				sourceArtifact: resolution.sourceArtifact,
				spdx: resolution.spdx,
				url: resolution.url,
				textPath: resolution.textPath,
				textSha256: resolution.textSha256,
			});
		}
	}
	return resolved.sort((left, right) => {
		const leftKey = `${left.packageName}\0${left.assetId}`;
		const rightKey = `${right.packageName}\0${right.assetId}`;
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
}

async function readCorrelatedEvidence(path, evidenceByPath) {
	const expected = evidenceByPath.get(path);
	const bytes = await readOwnedRegularFile(path);
	if (
		expected === undefined ||
		expected.bytes !== bytes.length ||
		expected.sha256 !== hash("sha256", bytes)
	) {
		throw new Error(
			`E_HANDOFF_EVIDENCE_STATE: ${path} changed after evidence inventory.`,
		);
	}
	return bytes;
}


async function buildReport() {
	await requireOwnedDirectory("content");
	for (const directory of packageDirectories)
		await requireOwnedDirectory(`content/${directory}`);
	const packageInspection = await inspectStarterPackages({ root });
	if (!packageInspection.ok)
		throw new Error(
			`Cannot hand off invalid deterministic package artifacts: ${packageInspection.issues
				.map((entry) => `${entry.ruleId}:${entry.path}`)
				.join(",")}`,
		);
	const inspectedByDirectory = new Map(
		packageInspection.packages.map((entry) => [entry.packageName, entry]),
	);
	const licenseEvidence =
		await resolvePackageLicenseEvidence(inspectedByDirectory);
	let localAudioBoundary;
	try {
		const localAudioFixtureBytes = await readOwnedRegularFile(
			LOCAL_AUDIO_FIXTURE_RELATIVE_PATH,
			LOCAL_AUDIO_FIXTURE_MAX_BYTES,
		);
		const summary = validateLocalAudioFixture(
			JSON.parse(localAudioFixtureBytes.toString("utf8")),
		);
		localAudioBoundary = Object.freeze({
			path: LOCAL_AUDIO_FIXTURE_RELATIVE_PATH,
			...summary,
		});
	} catch (error) {
		throw new Error(
			"E_LOCAL_AUDIO_FIXTURE: refuse handoff without the exact validated local-audio boundary fixture.",
			{ cause: error },
		);
	}
	const packages = [];
	const manifests = new Map();
	for (const directory of packageDirectories) {
		const inspected = inspectedByDirectory.get(directory);
		if (!inspected)
			throw new Error(`Missing inspected starter package: ${directory}`);
		const manifest = inspected.manifest;
		const packageLicense = validatePackageLicensePolicy(manifest);
		if (!packageLicense.ok)
			throw new Error(
				`Cannot hand off package with invalid license policy: ${directory}:${packageLicense.issues
					.map((entry) => entry.ruleId)
					.join(",")}`,
			);
		const maxCompressionRatio = Number(
			inspected.artifact.entries
				.reduce(
					(maximum, entry) =>
						Math.max(
							maximum,
							entry.compressedBytes === 0
								? 0
								: entry.bytes / entry.compressedBytes,
						),
					0,
				)
				.toFixed(6),
		);
		manifests.set(manifest.kind, manifest);
		packages.push({
			directory: `content/${directory}`,
			manifestPath: `content/${directory}/manifest.json`,
			name: manifest.name,
			version: manifest.version,
			kind: manifest.kind,
			license: packageLicense.license,
			manifestSha256: inspected.manifestSha256,
			integrity: inspected.artifact.integrity,
			artifactBytes: inspected.artifact.bytes.length,
			artifactSha256: hash("sha256", inspected.artifact.bytes),
			archive: inspected.inspection.archive,
			totals: {
				bytes: inspected.inspection.archive.compressedBytes,
				uncompressedBytes: inspected.inspection.archive.uncompressedBytes,
				fileCount: inspected.inspection.archive.fileCount,
				maxDepth: inspected.inspection.archive.maxDepth,
				maxCompressionRatio,
			},
			assets: manifest.assets.map((asset) => ({
				assetId: asset.assetId,
				path: `content/${directory}/${asset.path}`,
				role: asset.role,
				mime: asset.mime,
				bytes: asset.bytes,
				sha256: asset.sha256,
			})),
		});
	}
	const withdrawal = await readCanonicalWithdrawalRecord(root);
	const withdrawalBinding = validateWithdrawalPackageBinding(
		withdrawal,
		packageInspection.packages,
	);
	if (!withdrawalBinding.ok)
		throw new Error(
			`Cannot hand off an invalid withdrawal package binding: ${withdrawalBinding.issues
				.map((entry) => `${entry.ruleId}:${entry.path}`)
				.join(",")}`,
		);
	const withdrawalRegistry = createWithdrawalRegistryRecord(withdrawal);
	const withdrawalBoundary = {
		simulationOnly: withdrawalRegistry.simulationOnly,
		allowNewInstalls: withdrawalRegistry.allowNewInstalls,
		package: withdrawalRegistry.package,
		replacement: withdrawalRegistry.replacement.package,
		recordId: withdrawalRegistry.registryId,
	};

	const objectPack = manifests.get("object-pack");
	const level = manifests.get("level");
	const character = manifests.get("character");
	const music = manifests.get("music");
	const budget = await buildAssetBudgetReport({ root });
	if (!budget.ok)
		throw new Error(
			`Cannot hand off over-budget content: ${budget.issues.map((entry) => entry.ruleId).join(",")}`,
		);
	const budgetPath = "docs/assets/starter-content-budget.json";
	const ledgerPath = "docs/licenses/third-party-ledger.md";
	const currentContentSha256 = await contentDigest({ root });
	const evidenceInventory = await buildEvidenceInventory();
	const evidenceByPath = new Map(
		evidenceInventory.map((entry) => [entry.path, entry]),
	);
	const evidencePathsFor = (category) =>
		evidenceInventory
			.filter((entry) => entry.category === category)
			.map((entry) => entry.path);
	requireExactEvidencePaths(
		"Machine provenance",
		evidencePathsFor("machine-provenance"),
		packages.flatMap((pkg) =>
			pkg.assets.map(
				(asset) =>
					`docs/licenses/provenance/records/${provenanceRecordFileName({
						packageName: pkg.name,
						assetId: asset.assetId,
					})}`,
			),
		),
	);
	requireExactEvidencePaths(
		"Retained source",
		evidencePathsFor("source-evidence"),
		sourceEvidencePaths,
	);
	requireExactEvidencePaths("Brand review", evidencePathsFor("brand-review"), [
		"docs/brand/original-content-review.json",
		"docs/brand/original-content-review.md",
	]);
	requireExactEvidencePaths(
		"Captured license",
		evidencePathsFor("captured-license"),
		["docs/licenses/provenance/infinite-snowball-original-content/CC0-1.0.txt"],
	);
	requireExactEvidencePaths(
		"Provenance policy",
		evidencePathsFor("provenance-policy"),
		["docs/licenses/asset-policy.md"],
	);
	requireExactEvidencePaths(
		"Music policy",
		[
			...evidencePathsFor("music-policy"),
			...evidencePathsFor("local-audio-policy"),
		],
		[
			"docs/music/local-import-boundary.md",
			"docs/music/original-music-policy.md",
		],
	);
	requireExactEvidencePaths(
		"Withdrawal registry",
		evidencePathsFor("withdrawal-registry"),
		["docs/licenses/withdrawals/starter-rock-simulated.json"],
	);
	requireExactEvidencePaths(
		"Withdrawal policy",
		evidencePathsFor("withdrawal-policy"),
		["docs/licenses/withdrawal-policy.md"],
	);
	for (const evidencePath of [
		...evidencePathsFor("source-evidence"),
		...evidencePathsFor("captured-license"),
	]) {
		await readCorrelatedEvidence(evidencePath, evidenceByPath);
	}
	for (const license of licenseEvidence) {
		if (evidenceByPath.get(license.textPath)?.sha256 !== license.textSha256)
			throw new Error(
				`E_HANDOFF_EVIDENCE_STATE: license text digest is stale for ${license.textPath}.`,
			);
	}
	const revalidatedLicenseEvidence =
		await resolvePackageLicenseEvidence(inspectedByDirectory);
	if (
		JSON.stringify(revalidatedLicenseEvidence) !==
		JSON.stringify(licenseEvidence)
	) {
		throw new Error(
			"E_HANDOFF_EVIDENCE_STATE: license evidence changed during handoff validation.",
		);
	}
	const withdrawalPath =
		"docs/licenses/withdrawals/starter-rock-simulated.json";
	let inventoriedWithdrawal;
	try {
		inventoriedWithdrawal = JSON.parse(
			(
				await readCorrelatedEvidence(withdrawalPath, evidenceByPath)
			).toString("utf8"),
		);
	} catch (cause) {
		throw new Error(
			"E_HANDOFF_EVIDENCE_STATE: withdrawal evidence is not the validated canonical record.",
			{ cause },
		);
	}
	if (JSON.stringify(inventoriedWithdrawal) !== JSON.stringify(withdrawal))
		throw new Error(
			"E_HANDOFF_EVIDENCE_STATE: withdrawal evidence changed during handoff validation.",
		);

	const referenceMetadataPath = "docs/assets/reference-renders/index.json";
	const referenceMetadataBytes =
		await readOwnedRegularFile(referenceMetadataPath);
	const referenceMetadataEvidence = evidenceByPath.get(referenceMetadataPath);
	if (
		referenceMetadataEvidence?.category !== "render-metadata" ||
		referenceMetadataEvidence.bytes !== referenceMetadataBytes.length ||
		referenceMetadataEvidence.sha256 !==
			hash("sha256", referenceMetadataBytes)
	) {
		throw new Error(
			"E_HANDOFF_EVIDENCE_STATE: reference-render metadata changed after evidence inventory.",
		);
	}
	const referenceMetadata = JSON.parse(
		referenceMetadataBytes.toString("utf8"),
	);
	if (
		referenceMetadata.kind !== "p03-reference-renders" ||
		referenceMetadata.contentSha256 !== currentContentSha256 ||
		referenceMetadata.pipelineConfigSha256 !== CONFIG_SHA256 ||
		referenceMetadata.renderer?.engine !== "Three.js" ||
		referenceMetadata.renderer?.loader !== "GLTFLoader" ||
		!Array.isArray(referenceMetadata.renders)
	) {
		throw new Error(
			"Reference render metadata is not bound to the current P03 content and Three/GLTFLoader renderer.",
		);
	}
	if (
		!Array.isArray(referenceMetadata.renderer?.requestFailures) ||
		referenceMetadata.renderer.requestFailures.length !== 0
	) {
		throw new Error(
			"Reference render metadata request failures must be an empty array.",
		);
	}
	const actualReferenceSpecs = referenceMetadata.renders
		.map((render) => ({
			renderId: render.renderId,
			kind: render.kind,
			representativeReuseOf: render.representativeReuseOf,
			packageDirectory: render.bindings?.[0]?.packageDirectory,
			assetId: render.bindings?.[0]?.assetId,
			path: render.path,
		}))
		.sort((left, right) =>
			left.renderId < right.renderId
				? -1
				: left.renderId > right.renderId
					? 1
					: 0,
		);
	const expectedReferenceSpecs = [...referenceRenderSpecs].sort((left, right) =>
		left.renderId < right.renderId
			? -1
			: left.renderId > right.renderId
				? 1
				: 0,
	);
	if (
		JSON.stringify(actualReferenceSpecs) !==
		JSON.stringify(expectedReferenceSpecs)
	) {
		throw new Error(
			"E_RENDER_REFERENCE_IDENTITY: reference metadata must match the frozen render specifications.",
		);
	}
	for (const render of referenceMetadata.renders) {
		if (!Array.isArray(render.bindings) || render.bindings.length !== 1)
			throw new Error(
				`E_RENDER_REFERENCE_IDENTITY: ${String(render.renderId)} must bind exactly one verified GLB.`,
			);
	}
	assertRepresentativeReuseDeclarations(referenceMetadata.renders);
	for (const [selectValue, label] of [
		[(render) => render.bindings[0].assetSha256, "verified GLB SHA-256"],
		[(render) => render.verifiedAssetUrl, "verified GLB URL"],
		[(render) => render.pngSha256, "generated PNG SHA-256"],
	]) {
		assertDistinctReferenceValues(
			referenceMetadata.renders,
			selectValue,
			label,
		);
		assertDeclaredRepresentativeReuseMatches(
			referenceMetadata.renders,
			selectValue,
			label,
		);
	}
	requireExactEvidencePaths(
		"Reference render",
		[
			...evidencePathsFor("render-metadata"),
			...evidencePathsFor("reference-render"),
		],
		[
			referenceMetadataPath,
			...referenceMetadata.renders.map((render) => render.path),
		],
	);
	for (const render of referenceMetadata.renders) {
		const pngEvidence = evidenceByPath.get(render.path);
		if (pngEvidence?.category !== "reference-render")
			throw new Error(
				`Reference render path is not an inventoried PNG: ${render.path}`,
			);
		const pngBytes = await readOwnedRegularFile(render.path);
		if (
			pngEvidence.bytes !== pngBytes.length ||
			pngEvidence.sha256 !== hash("sha256", pngBytes) ||
			pngEvidence.sha256 !== render.pngSha256 ||
			pngBytes.length !== render.bytes ||
			render.changedPixels < 64 ||
			typeof render.caption !== "string" ||
			render.caption.length === 0 ||
			typeof render.credit !== "string" ||
			render.credit.length === 0 ||
			!Array.isArray(render.bindings) ||
			render.bindings.length !== 1
		) {
			throw new Error(
				`Reference render evidence is incomplete or stale: ${render.path}`,
			);
		}
		const expectedBindingSha256 = hash(
			"sha256",
			Buffer.from(
				JSON.stringify({
					renderId: render.renderId,
					representativeReuseOf: render.representativeReuseOf,
					verifiedAssetUrl: render.verifiedAssetUrl,
					contentSha256: currentContentSha256,
					pipelineConfigSha256: CONFIG_SHA256,
					captureConfigSha256: referenceMetadata.captureConfigSha256,
					bindings: render.bindings,
				}),
				"utf8",
			),
		);
		if (expectedBindingSha256 !== render.renderBindingSha256)
			throw new Error(`Reference render binding is stale: ${render.renderId}`);
		const binding = render.bindings[0];
		const packageDirectory = binding.packageDirectory;
		const directory =
			typeof packageDirectory === "string" &&
			packageDirectory.startsWith("content/")
				? packageDirectory.slice("content/".length)
				: "";
		const expectedVerifiedAssetUrl = `/verified-assets/${hash(
			"sha256",
			Buffer.from(
				`${directory}\0${String(binding.assetId)}\0${String(binding.assetSha256)}`,
				"utf8",
			),
		)}.glb`;
		if (
			directory.length === 0 ||
			render.verifiedAssetUrl !== expectedVerifiedAssetUrl
		) {
			throw new Error(
				`E_RENDER_REFERENCE_IDENTITY: ${render.renderId} has a stale verified GLB URL.`,
			);
		}
		for (const binding of render.bindings) {
			const pkg = packages.find(
				(candidate) => candidate.manifestPath === binding.manifestPath,
			);
			const asset = pkg?.assets.find(
				(candidate) =>
					candidate.assetId === binding.assetId &&
					candidate.path === binding.assetPath,
			);
			if (
				!pkg ||
				pkg.directory !== binding.packageDirectory ||
				pkg.name !== binding.packageName ||
				pkg.version !== binding.packageVersion ||
				pkg.manifestSha256 !== binding.manifestSha256 ||
				!asset ||
				asset.mime !== "model/gltf-binary" ||
				asset.mime !== binding.mime ||
				asset.role !== binding.assetRole ||
				asset.bytes !== binding.assetBytes ||
				asset.sha256 !== binding.assetSha256 ||
				!binding.assetPath.endsWith(".glb")
			) {
				throw new Error(
					`Reference render source binding is stale: ${render.renderId}:${binding.assetId}`,
				);
			}
		}
	}

	return {
		schemaVersion: 2,
		phase: "P03",
		status: "verified",
		reviewedOn: "2026-07-15",
		pipelineConfigSha256: CONFIG_SHA256,
		contentSha256: currentContentSha256,
		consumers: ["P04", "P05", "P06", "P07", "P09", "P10"],
		packages,
		runtimeHints: {
			objects: objectPack.entries.flatMap((entry) =>
				entry.objects.map((object) => ({
					objectId: object.objectId,
					radius: object.radius,
					volume: object.volume,
					points: object.points,
					category: object.category,
					colliderAssetId: object.colliderAssetId,
					renderAssetId: object.renderAssetId,
					attachPolicy: object.attachPolicy,
					material: {
						roughness: object.material.roughness,
						metalness: object.material.metalness,
					},
					lodAssetIds: [...object.lodAssetIds],
					budgets: {
						maxTriangles: object.budgets.maxTriangles,
						maxBytes: object.budgets.maxBytes,
					},
					sizeClass: object.objectId === "goal-stone" ? "goal" : "small",
				})),
			),
			levels: level.entries.map((entry) => ({
				levelId: entry.levelId,
				arenaAssetId: entry.arenaAssetId,
				layoutAssetId: entry.layoutAssetId,
				collectibleGroups: entry.collectibleGroups,
				finalGoal: entry.finalGoal,
				sizeBands: entry.sizeBands,
				cameraBounds: entry.cameraBounds,
				budgets: entry.budgets,
			})),
			characters: character.entries.map((entry) => ({
				characterId: entry.characterId,
				modelAssetId: entry.modelAssetId,
				scale: entry.scale,
				animationClips: entry.animationClips,
				bounds: entry.bounds,
				controllerPreset: entry.controllerPreset,
			})),
			music: music.entries.flatMap((entry) =>
				entry.tracks.map((track) => ({
					trackId: track.trackId,
					assetId: track.assetId,
					durationSeconds: track.durationSeconds,
					channels: track.channels,
					sampleRate: track.sampleRate,
				})),
			),
			referenceRenders: referenceMetadata.renders.map((render) => ({
				renderId: render.renderId,
				kind: render.kind,
				representativeReuseOf: render.representativeReuseOf,
				verifiedAssetUrl: render.verifiedAssetUrl,
				path: render.path,
				pngSha256: render.pngSha256,
				caption: render.caption,
				credit: render.credit,
				renderBindingSha256: render.renderBindingSha256,
				bindings: render.bindings,
			})),
		},
		evidence: {
			licenseEvidence,
			withdrawalBoundary,
			localAudioBoundary,
			inventory: evidenceInventory,
			budget: {
				path: budgetPath,
				sha256: evidenceByPath.get(budgetPath).sha256,
				totals: budget.totals,
			},
			credits: {
				path: ledgerPath,
				sha256: evidenceByPath.get(ledgerPath).sha256,
			},
			commands: [
				"corepack pnpm vitest run tests/assets tests/fixtures/assets",
				"corepack pnpm run assets:rebuild-starter && corepack pnpm run assets:verify-hashes",
				"corepack pnpm run assets:budget-report && node tools/assets/render-smoke.mjs --check && corepack pnpm run assets:headless-smoke",
				"corepack pnpm run licenses:ledger-check && corepack pnpm run music:policy-check && corepack pnpm run brand:originality-check",
				"corepack pnpm run local-audio:boundary-check",
			],
		},
		caveats: [
			"The cleared Kenney rock is intentionally reused as placeholder arena, layout, collectible, and goal geometry; P04 must not present it as production art.",
			"Pebble Friend is a decorative prototype with one deterministic embedded Idle rotation clip, not a humanoid rig.",
			"P03 defines local-audio privacy policy only; P05/P07 own browser storage, playback, catalog, and deletion behavior.",
			"No catalog ratings, reviews, install counts, commercial soundtrack assets, or store badges are approved.",
		],
	};
}

const target = "docs/assets/p03-content-handoff.json";
if (!check) {
	await execFileAsync(
		process.execPath,
		[fileURLToPath(new URL("./render-smoke.mjs", import.meta.url)), "--check"],
		{ cwd: root, timeout: 60_000 },
	);
}
const report = await buildReport();
const expected = `${JSON.stringify(report, null, 2)}\n`;
if (check) {
	const current = await readOwnedRegularFile(target)
		.then((bytes) => bytes.toString("utf8"))
		.catch(() => "");
	if (current !== expected) {
		console.error(
			"P03 content handoff is missing or stale; regenerate with node tools/assets/handoff-report.mjs.",
		);
		process.exitCode = 1;
	} else {
		console.log(
			`P03 content handoff verified: ${report.packages.length} packages for ${report.consumers.join(", ")}.`,
		);
	}
} else {
	await requireOwnedDirectory("docs/assets");
	await writeOwnedFileAtomically(target, expected);
	console.log(
		`P03 content handoff generated: ${report.packages.length} packages for ${report.consumers.join(", ")}.`,
	);
}
