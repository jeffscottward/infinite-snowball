import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	buildAssetBudgetReport,
	inspectGlb,
	inspectStarterPackages,
	inspectWav,
	verifyStarterHashes,
} from "./lib/asset-pipeline.mjs";

const root = process.cwd();
const packageDirectories = [
	"starter-level",
	"starter-objects",
	"starter-character",
	"starter-campaign",
	"starter-music",
];
const protocol = await import(
	pathToFileURL(join(root, "packages", "protocol", "dist", "browser.js")).href
);
const packageInspection = await inspectStarterPackages({ root });
if (!packageInspection.ok) {
	for (const entry of packageInspection.issues)
		console.error(`${entry.ruleId}:${entry.path}`);
	process.exit(1);
}

const manifestsByName = new Map();
const failures = [];
const inspectedPackagesByName = new Map(
	packageInspection.packages.map((entry) => [entry.manifest.name, entry]),
);

for (const directory of packageDirectories) {
	const inspectedPackage = packageInspection.packages.find(
		(entry) => entry.packageName === directory,
	);
	if (inspectedPackage === undefined) {
		console.error(`E_CONTENT_TREE:/${directory}`);
		process.exit(1);
	}
	const { manifest, manifestBytes: bytes } = inspectedPackage;
	const parsed = protocol.parseManifest(manifest);
	if (!parsed.ok)
		failures.push(
			...parsed.issues.map(
				(issue) => `${directory}:${issue.ruleId}:${issue.path}`,
			),
		);
	manifestsByName.set(manifest.name, {
		manifest,
		bytes,
		directory,
		inspectedPackage,
	});
}

if (failures.length > 0) {
	for (const failure of failures) console.error(failure);
	process.exit(1);
}

const expandedArtifacts = new WeakMap();

function inspectedAssetBytes(inspectedPackage, asset) {
	let archive = expandedArtifacts.get(inspectedPackage);
	if (archive === undefined) {
		archive = gunzipSync(inspectedPackage.artifact.bytes);
		expandedArtifacts.set(inspectedPackage, archive);
	}
	const targetPath = `package/${asset.path}`;
	let offset = 0;
	while (offset + 512 <= archive.length) {
		const header = archive.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const nameEnd = header.indexOf(0);
		const path = header
			.subarray(0, nameEnd === -1 ? 100 : Math.min(nameEnd, 100))
			.toString("utf8");
		const sizeText = header
			.subarray(124, 136)
			.toString("ascii")
			.replace(/\0.*$/u, "")
			.trim();
		const size = Number.parseInt(sizeText, 8);
		const dataStart = offset + 512;
		const dataEnd = dataStart + size;
		if (!Number.isSafeInteger(size) || size < 0 || dataEnd > archive.length)
			return null;
		if (path === targetPath) {
			const inspectedFile = inspectedPackage.inspection.files.find(
				(entry) => entry.path === asset.path,
			);
			return inspectedFile?.bytes === size
				? archive.subarray(dataStart, dataEnd)
				: null;
		}
		offset = dataStart + Math.ceil(size / 512) * 512;
	}
	return null;
}

function inspectReferences(value, assetIds, location) {
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries()) {
			inspectReferences(entry, assetIds, `${location}/${index}`);
		}
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, entry] of Object.entries(value)) {
		if (
			key.endsWith("AssetId") &&
			typeof entry === "string" &&
			!assetIds.has(entry)
		) {
			failures.push(`${location}/${key}:missing-asset:${entry}`);
		}
		if (key.endsWith("AssetIds") && Array.isArray(entry)) {
			for (const id of entry)
				if (typeof id === "string" && !assetIds.has(id))
					failures.push(`${location}/${key}:missing-asset:${id}`);
		}
		inspectReferences(entry, assetIds, `${location}/${key}`);
	}
}

function inspectPackageReferences(value, location) {
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries()) {
			inspectPackageReferences(entry, `${location}/${index}`);
		}
		return;
	}
	if (!value || typeof value !== "object") return;
	if (
		typeof value.manifestSha256 === "string" &&
		typeof value.name === "string"
	) {
		const target = manifestsByName.get(value.name);
		const inspectedTarget = inspectedPackagesByName.get(value.name);
		if (!target || !inspectedTarget)
			failures.push(`${location}:missing-package:${value.name}`);
		else {
			const sha256 = inspectedTarget.manifestSha256;
			const integrity = inspectedTarget.artifact.integrity;
			if (sha256 !== value.manifestSha256 || integrity !== value.integrity) {
				failures.push(`${location}:stale-package-ref:${value.name}`);
			}
			if (
				target.manifest.version !== value.version ||
				target.manifest.kind !== value.kind
			) {
				failures.push(`${location}:package-ref-identity:${value.name}`);
			}
		}
	}
	for (const [key, entry] of Object.entries(value))
		inspectPackageReferences(entry, `${location}/${key}`);
}

for (const {
	manifest,
	directory,
	inspectedPackage,
} of manifestsByName.values()) {
	const assetIds = new Set(manifest.assets.map((asset) => asset.assetId));
	inspectReferences(manifest.entries, assetIds, `/${directory}/entries`);
	inspectPackageReferences(
		{ dependencies: manifest.dependencies, entries: manifest.entries },
		`/${directory}`,
	);
	for (const asset of manifest.assets) {
		if (
			!inspectedPackage.inspection.files.some(
				(entry) => entry.path === asset.path,
			)
		)
			failures.push(`/${directory}/${asset.path}:missing-inspected-asset`);
	}

	if (manifest.kind === "level") {
		const objectPacks = manifest.dependencies
			.filter((dependency) => dependency.kind === "object-pack")
			.map((dependency) => manifestsByName.get(dependency.name)?.manifest)
			.filter(Boolean);
		const allObjectIds = new Set(
			objectPacks.flatMap((objectPack) =>
				objectPack.entries.flatMap((entry) =>
					entry.objects.map((object) => object.objectId),
				),
			),
		);
		for (const level of manifest.entries) {
			for (const group of level.collectibleGroups) {
				const objectPack = manifestsByName.get(group.objectPack.name)?.manifest;
				const groupObjectIds = new Set(
					objectPack?.entries.flatMap((entry) =>
						entry.objects.map((object) => object.objectId),
					) ?? [],
				);
				for (const objectId of group.objectIds) {
					if (!groupObjectIds.has(objectId)) {
						failures.push(
							`/${directory}/levels/${level.levelId}:missing-collectible:${objectId}`,
						);
					}
				}
			}
			if (!allObjectIds.has(level.finalGoal.objectId)) {
				failures.push(
					`/${directory}/levels/${level.levelId}:missing-final-goal:${level.finalGoal.objectId}`,
				);
			}
		}
	}

	if (manifest.kind === "character") {
		for (const character of manifest.entries) {
			const modelAsset = manifest.assets.find(
				(candidate) => candidate.assetId === character.modelAssetId,
			);
			const model = modelAsset
				? inspectedAssetBytes(inspectedPackage, modelAsset)
				: null;
			const inspection = model ? inspectGlb(model) : null;
			for (const declared of character.animationClips) {
				if (!inspection?.metrics.animationClips.includes(declared.clip)) {
					failures.push(
						`/${directory}/characters/${character.characterId}:missing-animation:${declared.clip}`,
					);
				}
			}
		}
	}

	if (manifest.kind === "music") {
		for (const track of manifest.entries.flatMap((entry) => entry.tracks)) {
			const asset = manifest.assets.find(
				(candidate) => candidate.assetId === track.assetId,
			);
			const wav = asset
				? inspectedAssetBytes(inspectedPackage, asset)
				: null;
			const inspection = wav ? inspectWav(wav) : null;
			if (!inspection?.ok) {
				failures.push(`/${directory}/tracks/${track.trackId}:invalid-wav`);
				continue;
			}
			const { bitsPerSample, channels, durationSeconds, sampleRate } =
				inspection.metrics;
			if (
				channels !== track.channels ||
				sampleRate !== track.sampleRate ||
				bitsPerSample !== 16 ||
				durationSeconds !== track.durationSeconds
			) {
				failures.push(
					`/${directory}/tracks/${track.trackId}:decoded-metadata-mismatch`,
				);
			}
		}
	}
}

const hashes = await verifyStarterHashes({ root });
const budget = await buildAssetBudgetReport({ root });
failures.push(...hashes.issues.map((entry) => `${entry.ruleId}:${entry.path}`));
failures.push(...budget.issues.map((entry) => `${entry.ruleId}:${entry.path}`));

if (failures.length > 0) {
	for (const failure of failures) console.error(failure);
	process.exitCode = 1;
} else {
	console.log(
		`Structural starter smoke passed: ${manifestsByName.size} manifests, ${budget.totals.files} files, ${budget.totals.glbFiles} GLBs.`,
	);
}
