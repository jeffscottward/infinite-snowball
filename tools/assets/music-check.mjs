import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { MusicManifestSchema } from "../../packages/protocol/dist/browser.js";

import { ASSET_LIMITS, inspectWav } from "./lib/asset-pipeline.mjs";
import { containsProhibitedBrandTerm } from "./lib/brand-terms.mjs";
import { validateMusicPolicy } from "./lib/policy.mjs";
import {
	provenanceRecordFileName,
	reconstructProvenanceRecord,
	resolveRetainedLicenseEvidence,
} from "./lib/provenance-ledger.mjs";
import {
	inventoryTree,
	readInventoriedFile,
} from "./lib/tree-inventory.mjs";

const MUSIC_PACKAGE_LIMITS = Object.freeze({
	maxEntries: ASSET_LIMITS.maxStarterFiles + ASSET_LIMITS.maxStarterDepth,
	maxFiles: ASSET_LIMITS.maxStarterFiles,
	maxDepth: ASSET_LIMITS.maxStarterDepth,
	maxFileBytes: ASSET_LIMITS.maxFileBytes,
	maxTotalBytes: ASSET_LIMITS.maxStarterBytes,
});
const EVIDENCE_LIMITS = Object.freeze({
	maxEntries: 128,
	maxFiles: 128,
	maxDepth: 1,
	maxFileBytes: 256 * 1024,
	maxTotalBytes: 4 * 1024 * 1024,
});

class EvidencePathError extends Error {}

function safeEvidencePath(path) {
	if (
		typeof path !== "string" ||
		path.length === 0 ||
		path.length > 512 ||
		isAbsolute(path) ||
		path !== path.normalize("NFC") ||
		path.includes("\\") ||
		path.includes("\0") ||
		Buffer.from(path, "utf8").toString("utf8") !== path
	)
		return false;
	const segments = path.split("/");
	return (
		segments.length >= 2 &&
		segments.every(
			(segment) =>
				segment.length > 0 && segment !== "." && segment !== "..",
		)
	);
}

function createEvidenceReader(root) {
	const inventories = new Map();
	const byteCache = new Map();
	return async function readEvidenceFile(path) {
		if (!safeEvidencePath(path))
			throw new EvidencePathError("evidence path is not canonical");
		if (byteCache.has(path)) return byteCache.get(path);
		const segments = path.split("/");
		const fileName = segments.pop();
		const directoryPath = segments.join("/");
		let inventory = inventories.get(directoryPath);
		if (inventory === undefined) {
			try {
				inventory = await inventoryTree(
					join(root, ...segments),
					EVIDENCE_LIMITS,
				);
			} catch {
				throw new EvidencePathError("evidence inventory failed");
			}
			inventories.set(directoryPath, inventory);
		}
		const entry = inventory.entries.find(
			(candidate) =>
				candidate.relativePath === fileName &&
				candidate.kind === "file" &&
				candidate.contained,
		);
		if (!inventory.ok || entry === undefined)
			throw new EvidencePathError("evidence is not one contained regular file");
		let bytes;
		try {
			bytes = await readInventoriedFile(entry);
		} catch {
			throw new EvidencePathError("evidence identity changed while reading");
		}
		byteCache.set(path, bytes);
		return bytes;
	};
}


function expectedGrantPath(asset) {
	if (asset.license === "CC0-1.0")
		return asset?.provenance?.creator === "Kenney"
			? "tools/assets/sources/kenney-nature-kit/License.txt"
			: "docs/licenses/provenance/infinite-snowball-original-content/CC0-1.0.txt";
	if (
		asset.license === "CC-BY-4.0" &&
		/^[a-f0-9]{64}$/u.test(asset.capturedLicenseSha256 ?? "")
	)
		return `docs/licenses/provenance/cc-by-4.0/${asset.capturedLicenseSha256}.txt`;
	return null;
}

function sameInventoriedIdentity(identity, stats) {
	return (
		stats.isFile() &&
		stats.dev === identity.dev &&
		stats.ino === identity.ino &&
		stats.mode === identity.mode &&
		stats.size === identity.bytes &&
		stats.mtimeMs === identity.mtimeMs &&
		stats.ctimeMs === identity.ctimeMs
	);
}

async function openInventoriedAsset(entry, identity) {
	const handle = await open(
		entry.absolutePath,
		constants.O_RDONLY | constants.O_NOFOLLOW,
	);
	try {
		if (!sameInventoriedIdentity(identity, await handle.stat()))
			throw new Error("inventoried file identity changed");
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function readExactInventoriedAsset(handle, identity) {
	const bytes = Buffer.alloc(identity.bytes);
	let offset = 0;
	while (offset < bytes.length) {
		const { bytesRead } = await handle.read(
			bytes,
			offset,
			bytes.length - offset,
			offset,
		);
		if (bytesRead === 0)
			throw new Error("inventoried file ended before its declared size");
		offset += bytesRead;
	}
	const probe = Buffer.allocUnsafe(1);
	const { bytesRead: extraBytes } = await handle.read(
		probe,
		0,
		1,
		identity.bytes,
	);
	const finalStats = await handle.stat();
	if (
		extraBytes !== 0 ||
		!sameInventoriedIdentity(identity, finalStats)
	)
		throw new Error("inventoried file identity changed while reading");
	return bytes;
}
async function readInventoriedAudio(contexts, entriesByPath) {
	const opened = [];
	try {
		for (const { asset } of contexts) {
			const identity = entriesByPath.get(asset.path);
			if (identity === undefined)
				throw new Error("inventoried asset is missing");
			const handle = await openInventoriedAsset(identity, identity);
			opened.push({ asset, handle, identity });
		}
		const bytesByAssetId = new Map();
		for (const { asset, handle, identity } of opened) {
			const bytes = await readExactInventoriedAsset(handle, identity);
			bytesByAssetId.set(asset.assetId, bytes);
		}
		return bytesByAssetId;
	} finally {
		await Promise.allSettled(opened.map(({ handle }) => handle.close()));
	}
}



function issue(ruleId, path, remediation) {
	return { ruleId, path, remediation };
}

function reportIssues(issues) {
	for (const entry of issues)
		console.error(`${entry.ruleId} ${entry.path}: ${entry.remediation}`);
	process.exitCode = 1;
}

function safeAssetPath(path) {
	if (
		typeof path !== "string" ||
		path.length === 0 ||
		path.length > 100 ||
		path !== path.normalize("NFC") ||
		!path.startsWith("assets/") ||
		path.includes("\\") ||
		path.includes("\0") ||
		Buffer.from(path, "utf8").toString("utf8") !== path ||
		Buffer.byteLength(`package/${path}`, "utf8") > 100
	)
		return false;
	return path
		.split("/")
		.every(
			(segment) =>
				segment.length > 0 && segment !== "." && segment !== "..",
		);
}
const MAX_WAV_CHUNKS = 4_096;
const MAX_WAV_INFO_CHUNKS = 256;
const MAX_WAV_INFO_BYTES = 256 * 1024;
const MAX_MANIFEST_DEPTH = 64;
const MAX_MANIFEST_NODES = 262_144;
const MAX_MANIFEST_CONTAINER_ENTRIES = 4_096;
const UTF16_BE_DECODER = new TextDecoder("utf-16be");


function ancillaryPayloadTexts(payload) {
	const texts = [payload.toString("utf8")];
	const evenLength = payload.length - (payload.length % 2);
	if (evenLength >= 2) {
		const evenPayload = payload.subarray(0, evenLength);
		texts.push(
			evenPayload.toString("utf16le"),
			UTF16_BE_DECODER.decode(evenPayload),
		);
	}
	return texts;
}

function inspectInfoListMetadata(payload) {
	if (
		payload.length < 4 ||
		payload.length > MAX_WAV_INFO_BYTES ||
		payload.toString("ascii", 0, 4) !== "INFO"
	)
		return { ok: false, prohibited: false };
	let chunkCount = 0;
	let metadataBytes = 0;
	let prohibited = false;
	let offset = 4;
	while (offset < payload.length) {
		if (
			chunkCount >= MAX_WAV_INFO_CHUNKS ||
			offset + 8 > payload.length
		)
			return { ok: false, prohibited: false };
		chunkCount += 1;
		const chunkId = payload.toString("ascii", offset, offset + 4);
		if (!/^[\x20-\x7e]{4}$/u.test(chunkId))
			return { ok: false, prohibited: false };
		const payloadBytes = payload.readUInt32LE(offset + 4);
		const payloadStart = offset + 8;
		const payloadEnd = payloadStart + payloadBytes;
		const paddedEnd = payloadEnd + (payloadBytes % 2);
		if (
			payloadEnd < payloadStart ||
			paddedEnd > payload.length ||
			payloadBytes > MAX_WAV_INFO_BYTES - metadataBytes ||
			(payloadBytes % 2 === 1 && payload[payloadEnd] !== 0)
		)
			return { ok: false, prohibited: false };
		metadataBytes += payloadBytes;
		if (
			ancillaryPayloadTexts(payload.subarray(payloadStart, payloadEnd)).some(
				(text) => containsProhibitedBrandTerm(text),
			)
		)
			prohibited = true;
		offset = paddedEnd;
	}
	return { ok: offset === payload.length, prohibited };
}

function inspectWavAncillaryMetadata(buffer) {
	if (buffer.length < 12) return { ok: false, prohibited: false };
	let chunkCount = 0;
	let offset = 12;
	while (offset < buffer.length) {
		if (chunkCount >= MAX_WAV_CHUNKS || offset + 8 > buffer.length)
			return { ok: false, prohibited: false };
		chunkCount += 1;
		const chunkId = buffer.toString("ascii", offset, offset + 4);
		const payloadBytes = buffer.readUInt32LE(offset + 4);
		const payloadStart = offset + 8;
		const payloadEnd = payloadStart + payloadBytes;
		if (payloadEnd > buffer.length)
			return { ok: false, prohibited: false };
		const payload = buffer.subarray(payloadStart, payloadEnd);
		if (chunkId === "LIST") {
			if (payload.length < 4) return { ok: false, prohibited: false };
			if (payload.toString("ascii", 0, 4) === "INFO") {
				const infoInspection = inspectInfoListMetadata(payload);
				if (!infoInspection.ok) return infoInspection;
				if (infoInspection.prohibited) return infoInspection;
			}
		}
		if (
			chunkId !== "fmt " &&
			chunkId !== "data" &&
			ancillaryPayloadTexts(payload).some((text) =>
				containsProhibitedBrandTerm(text),
			)
		)
			return { ok: true, prohibited: true };
		offset = payloadEnd + (payloadBytes % 2);
	}
	return { ok: offset === buffer.length, prohibited: false };
}

function containsProhibitedManifestTerm(rootValue) {
	const stack = [{ value: rootValue, path: "/", depth: 0 }];
	const seen = new WeakSet();
	let nodeCount = 1;
	let prohibited = false;

	while (stack.length > 0) {
		const current = stack.pop();
		if (current.depth > MAX_MANIFEST_DEPTH)
			return { ok: false, prohibited: false, path: current.path };

		const value = current.value;
		if (typeof value === "string") {
			if (containsProhibitedBrandTerm(value)) prohibited = true;
			continue;
		}
		if (
			value === null ||
			typeof value === "boolean" ||
			(typeof value === "number" && Number.isFinite(value))
		)
			continue;
		if (typeof value !== "object")
			return { ok: false, prohibited: false, path: current.path };
		if (seen.has(value))
			return { ok: false, prohibited: false, path: current.path };
		seen.add(value);

		let array;
		let keys;
		let prototype;
		try {
			array = Array.isArray(value);
			prototype = Object.getPrototypeOf(value);
			keys = Reflect.ownKeys(value);
		} catch {
			return { ok: false, prohibited: false, path: current.path };
		}
		if (
			(array && prototype !== Array.prototype) ||
			(!array && prototype !== Object.prototype && prototype !== null) ||
			keys.some((key) => typeof key !== "string")
		)
			return { ok: false, prohibited: false, path: current.path };

		const dataKeys = array ? keys.filter((key) => key !== "length") : keys;
		if (
			dataKeys.length > MAX_MANIFEST_CONTAINER_ENTRIES ||
			dataKeys.length > MAX_MANIFEST_NODES - nodeCount
		)
			return { ok: false, prohibited: false, path: current.path };
		nodeCount += dataKeys.length;
		let descriptors;
		try {
			descriptors = Object.getOwnPropertyDescriptors(value);
		} catch {
			return { ok: false, prohibited: false, path: current.path };
		}


		for (let index = dataKeys.length - 1; index >= 0; index -= 1) {
			const key = dataKeys[index];
			const descriptor = descriptors[key];
			const path = `${current.path === "/" ? "" : current.path}/${key
				.replaceAll("~", "~0")
				.replaceAll("/", "~1")}`;
			if (
				descriptor === undefined ||
				!Object.hasOwn(descriptor, "value")
			)
				return { ok: false, prohibited: false, path };
			if (containsProhibitedBrandTerm(key)) prohibited = true;
			stack.push({
				value: descriptor.value,
				path,
				depth: current.depth + 1,
			});
		}
	}

	return { ok: true, prohibited, path: "/" };
}


function expectedDirectories(paths) {
	const directories = new Set();
	for (const path of paths) {
		const segments = path.split("/");
		for (let index = 1; index < segments.length; index += 1)
			directories.add(segments.slice(0, index).join("/"));
	}
	return directories;
}

function musicCandidate({
	asset,
	bytes,
	decodedAudio,
	machine,
	packBytes,
	retainedGrantSha256,
	track,
	trackCount,
}) {
	return {
		...track,
		durationSeconds: decodedAudio.durationSeconds,
		channels: decodedAudio.channels,
		sampleRate: decodedAudio.sampleRate,
		sourceType:
			track.creator === "Infinite Snowball contributors"
				? "original"
				: "third-party",
		grant: {
			textPath: machine.license?.textPath,
			textSha256: machine.license?.textSha256,
		},
		retainedGrantSha256,
		codec: asset.mime,
		bytes,
		packBytes,
		packTracks: trackCount,
		asset,
		machineProvenance: machine,
	};
}

const root = process.cwd();
const packageDirectory = "starter-music";
const packageRoot = join(root, "content", packageDirectory);
const inventory = await inventoryTree(packageRoot, MUSIC_PACKAGE_LIMITS);
const inspectionIssues = [...inventory.issues];
const entriesByPath = new Map(
	inventory.entries.map((entry) => [entry.relativePath, entry]),
);
const manifestEntry = entriesByPath.get("manifest.json");
let manifest;

if (inventory.ok) {
	if (
		manifestEntry?.kind !== "file" ||
		manifestEntry.contained !== true
	) {
		inspectionIssues.push(
			issue(
				"E_MANIFEST_MISSING",
				"/manifest.json",
				"Restore one contained regular music-package manifest.",
			),
		);
	} else {
		let manifestBytes;
		try {
			manifestBytes = await readInventoriedFile(manifestEntry);
		} catch {
			inspectionIssues.push(
				issue(
					"E_PATH_POLICY",
					"/manifest.json",
					"Read only the exact regular manifest proven by package inventory.",
				),
			);
		}
		if (manifestBytes !== undefined) {
			try {
				manifest = JSON.parse(manifestBytes.toString("utf8"));
			} catch {
				inspectionIssues.push(
					issue(
						"E_MANIFEST_MISSING",
						"/manifest.json",
						"Restore one complete JSON music-package manifest.",
					),
				);
			}
		}
	}
}

if (manifest !== undefined) {
	const manifestTerms = containsProhibitedManifestTerm(manifest);
	if (!manifestTerms.ok) {
		inspectionIssues.push(
			issue(
				"E_MANIFEST_BOUNDS",
				"/manifest.json",
				"Keep the manifest within reviewed depth, node, container, and plain-data bounds.",
			),
		);
	} else if (manifestTerms.prohibited) {
		inspectionIssues.push(
			issue(
				"E_SOUNDTRACK_PROHIBITED",
				"/",
				"Do not upload, package, catalog, cache, or redistribute the referenced commercial soundtrack.",
			),
		);
	}
	if (
		manifest.name !== "@infinite-snowball/starter-music" ||
		manifest.kind !== "music"
	) {
		inspectionIssues.push(
			issue(
				"E_PACKAGE_REF",
				"/manifest.json",
				"Bind the fixed music directory to the exact starter-music identity.",
			),
		);
	}
	const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
	const declaredPaths = assets.map((asset) => asset?.path);
	const safePaths = declaredPaths.filter(safeAssetPath);
	const declaredPathSet = new Set(safePaths);
	if (
		safePaths.length !== declaredPaths.length ||
		declaredPathSet.size !== declaredPaths.length
	) {
		inspectionIssues.push(
			issue(
				"E_PATH_POLICY",
				"/manifest.json",
				"Declare a duplicate-free inventory of safe NFC relative asset paths.",
			),
		);
	}
	const expectedFiles = new Set(["manifest.json", ...safePaths]);
	const expectedDirectorySet = expectedDirectories(safePaths);
	for (const entry of inventory.entries) {
		if (entry.kind === "directory" && !expectedDirectorySet.has(entry.relativePath)) {
			inspectionIssues.push(
				issue(
					"E_CONTENT_TREE",
					`/${entry.relativePath}`,
					"Remove directories outside the exact declared music inventory.",
				),
			);
		}
		if (entry.kind === "file" && !expectedFiles.has(entry.relativePath)) {
			inspectionIssues.push(
				issue(
					"E_ASSET_ORPHAN",
					`/${entry.relativePath}`,
					"Remove files outside the exact declared music inventory.",
				),
			);
		}
	}
	for (const path of safePaths) {
		const entry = entriesByPath.get(path);
		if (entry?.kind !== "file" || entry.contained !== true) {
			inspectionIssues.push(
				issue(
					"E_ASSET_MISSING",
					`/${path}`,
					"Restore the exact declared asset as one contained regular file.",
				),
			);
		}
	}
}

if (inspectionIssues.length > 0 || manifest === undefined) {
	reportIssues(inspectionIssues);
} else {
	const recordManifestResult = MusicManifestSchema.safeParse(manifest);
	const recordManifest = recordManifestResult.success
		? recordManifestResult.data
		: manifest;
	const assets = manifest.assets;
	const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
	const tracks = entries.flatMap((entry) =>
		Array.isArray(entry?.tracks) ? entry.tracks : [],
	);
	const audioAssets = assets.filter(
		(entry) =>
			typeof entry?.mime === "string" && entry.mime.startsWith("audio/"),
	);
	const declaredPackBytes = audioAssets.reduce(
		(sum, asset) =>
			Number.isSafeInteger(asset.bytes) ? sum + asset.bytes : Number.NaN,
		0,
	);
	const preflightIssues = [];
	const trackContexts = [];
	const readEvidenceFile = createEvidenceReader(root);
	const audioAssetsById = new Map();
	const duplicateAudioAssetIds = new Set();
	const musicPackIds = new Set();
	const trackIds = new Set();
	let flatTrackIndex = 0;
	for (const [entryIndex, entry] of entries.entries()) {
		if (typeof entry?.musicPackId === "string") {
			if (musicPackIds.has(entry.musicPackId)) {
				preflightIssues.push(
					issue(
						"E_MUSIC_BINDING",
						`/entries/${entryIndex}/musicPackId`,
						"Keep every music-pack ID unique within the manifest.",
					),
				);
			}
			musicPackIds.add(entry.musicPackId);
		}
		for (const track of Array.isArray(entry?.tracks) ? entry.tracks : []) {
			if (typeof track?.trackId === "string") {
				if (trackIds.has(track.trackId)) {
					preflightIssues.push(
						issue(
							"E_MUSIC_BINDING",
							`/tracks/${flatTrackIndex}/trackId`,
							"Keep every track ID unique within the manifest.",
						),
					);
				}
				trackIds.add(track.trackId);
			}
			const cueIds = new Set();
			for (const [cueIndex, cue] of (
				Array.isArray(track?.cues) ? track.cues : []
			).entries()) {
				if (typeof cue?.id !== "string") continue;
				if (cueIds.has(cue.id)) {
					preflightIssues.push(
						issue(
							"E_MUSIC_BINDING",
							`/tracks/${track.trackId}/cues/${cueIndex}/id`,
							"Keep every cue ID unique within its track.",
						),
					);
				}
				cueIds.add(cue.id);
			}
			flatTrackIndex += 1;
		}
	}
	for (const [index, asset] of audioAssets.entries()) {
		if (
			typeof asset.assetId !== "string" ||
			asset.assetId.length === 0 ||
			audioAssetsById.has(asset.assetId)
		) {
			if (typeof asset.assetId === "string")
				duplicateAudioAssetIds.add(asset.assetId);
			preflightIssues.push(
				issue(
					"E_MUSIC_BINDING",
					`/assets/${index}/assetId`,
					"Bind every audio asset to one unique exact asset ID.",
				),
			);
			continue;
		}
		audioAssetsById.set(asset.assetId, asset);
	}
	for (const asset of audioAssets) {
		if (
			tracks.filter((track) => track.assetId === asset.assetId).length !== 1
		) {
			preflightIssues.push(
				issue(
					"E_MUSIC_BINDING",
					`/assets/${asset.assetId}/tracks`,
					"Bind every exact audio asset to one and only one track.",
				),
			);
		}
	}
	if (tracks.length === 0) {
		preflightIssues.push(
			issue(
				"E_MUSIC_TRACK_COUNT",
				"/tracks",
				"Retain at least one exact reviewed music track.",
			),
		);
	}

	for (const track of tracks) {
		const asset = duplicateAudioAssetIds.has(track.assetId)
			? undefined
			: audioAssetsById.get(track.assetId);
		if (!asset) {
			preflightIssues.push(
				issue(
					"E_MUSIC_BINDING",
					`/tracks/${track.trackId}/assetId`,
					"Bind the track to one exact audio asset.",
				),
			);
			continue;
		}
		let machineBytes;
		try {
			const fileName = provenanceRecordFileName({
				packageName: manifest.name,
				assetId: asset.assetId,
			});
			const recordPath =
				`docs/licenses/provenance/records/${fileName}`;
			machineBytes = await readEvidenceFile(recordPath);
		} catch (error) {
			preflightIssues.push(
				issue(
					error instanceof EvidencePathError
						? "E_PATH_POLICY"
						: "E_MUSIC_PROVENANCE",
					`/tracks/${track.trackId}/assetId`,
					"Retain the canonical machine provenance record as one bounded inventoried regular file.",
				),
			);
			continue;
		}
		let machine;
		try {
			machine = JSON.parse(machineBytes.toString("utf8"));
		} catch {
			preflightIssues.push(
				issue(
					"E_MUSIC_PROVENANCE",
					`/tracks/${track.trackId}/assetId`,
					"Retain the canonical machine provenance record for the exact track bytes.",
				),
			);
			continue;
		}
		const grantPath = expectedGrantPath(asset);
		if (grantPath === null || machine.license?.textPath !== grantPath) {
			preflightIssues.push(
				issue(
					"E_MUSIC_GRANT",
					`/tracks/${track.trackId}/grant`,
					"Retain the exact hashed grant or license text.",
				),
			);
			continue;
		}
		let retainedLicenseEvidence;
		try {
			retainedLicenseEvidence = await resolveRetainedLicenseEvidence(
				root,
				asset,
			);
		} catch {
			preflightIssues.push(
				issue(
					"E_MUSIC_GRANT",
					`/tracks/${track.trackId}/grant`,
					"Retain the exact grant through its bounded canonical provenance resolver.",
				),
			);
			continue;
		}
		const retainedGrantSha256 = retainedLicenseEvidence.textSha256;
		const candidate = musicCandidate({
			asset,
			bytes: asset.bytes,
			decodedAudio: track,
			machine,
			packBytes: declaredPackBytes,
			retainedGrantSha256,
			track,
			trackCount: tracks.length,
		});
		for (const entry of validateMusicPolicy(candidate).issues) {
			preflightIssues.push({
				...entry,
				path: `/tracks/${track.trackId}${entry.path}`,
			});
		}
		trackContexts.push({
			asset,
			machine,
			retainedGrantSha256,
			retainedLicenseEvidence,
			track,
		});
	}

	if (preflightIssues.length > 0) {
		reportIssues(preflightIssues);
	} else {
		const issues = [];
		let audioBytes = new Map();
		try {
			audioBytes = await readInventoriedAudio(trackContexts, entriesByPath);
		} catch {
			issues.push(
				issue(
					"E_PATH_POLICY",
					"/assets",
					"Read only the exact regular audio files proven by package inventory.",
				),
			);
		}
		const packBytes = [...audioBytes.values()].reduce(
			(sum, bytes) => sum + bytes.length,
			0,
		);

		for (const {
			asset,
			machine,
			retainedGrantSha256,
			retainedLicenseEvidence,
			track,
		} of trackContexts) {
			const runtimeBytes = audioBytes.get(track.assetId);
			if (!runtimeBytes) {
				issues.push(
					issue(
						"E_MUSIC_BINDING",
						`/tracks/${track.trackId}/assetId`,
						"Bind the track to one exact audio asset.",
					),
				);
				continue;
			}
			const wavInspection = inspectWav(runtimeBytes);
			if (!wavInspection.ok) {
				for (const entry of wavInspection.issues) {
					issues.push({
						...entry,
						path: `/tracks/${track.trackId}/decodedAudio${entry.path}`,
					});
				}
				continue;
			}
			const metadataInspection = inspectWavAncillaryMetadata(runtimeBytes);
			if (!metadataInspection.ok) {
				issues.push(
					issue(
						"E_MUSIC_BINDING",
						`/tracks/${track.trackId}/decodedAudio/metadata`,
						"Keep ancillary WAV metadata inside the bounded RIFF chunk structure.",
					),
				);
				continue;
			}
			if (metadataInspection.prohibited) {
				issues.push(
					issue(
						"E_SOUNDTRACK_PROHIBITED",
						`/tracks/${track.trackId}/decodedAudio/metadata`,
						"Do not package prohibited commercial soundtrack metadata.",
					),
				);
				continue;
			}
			const decodedAudio = wavInspection.metrics;
			if (
				decodedAudio.durationSeconds !== track.durationSeconds ||
				decodedAudio.channels !== track.channels ||
				decodedAudio.sampleRate !== track.sampleRate ||
				decodedAudio.bitsPerSample !== 16
			) {
				issues.push(
					issue(
						"E_MUSIC_BINDING",
						`/tracks/${track.trackId}/decodedAudio`,
						"Bind declared duration, channels, sample rate, and PCM16 sample depth to the exact decoded WAV bytes.",
					),
				);
				continue;
			}
			const loop = track.loop;
			if (
				!Number.isFinite(loop?.startSeconds) ||
				!Number.isFinite(loop?.endSeconds) ||
				loop.startSeconds < 0 ||
				loop.startSeconds >= loop.endSeconds ||
				loop.endSeconds > decodedAudio.durationSeconds
			) {
				issues.push(
					issue(
						"E_MUSIC_BINDING",
						`/tracks/${track.trackId}/loop`,
						"Bind the loop to an ordered non-negative range inside decoded duration.",
					),
				);
				continue;
			}
			let cueOutsideDuration = false;
			for (const [cueIndex, cue] of (
				Array.isArray(track.cues) ? track.cues : []
			).entries()) {
				if (
					!Number.isFinite(cue?.atSeconds) ||
					cue.atSeconds < 0 ||
					cue.atSeconds > decodedAudio.durationSeconds
				) {
					cueOutsideDuration = true;
					issues.push(
						issue(
							"E_MUSIC_BINDING",
							`/tracks/${track.trackId}/cues/${cueIndex}/atSeconds`,
							"Bind every cue time inside the exact decoded duration.",
						),
					);
				}
			}
			if (cueOutsideDuration) continue;
			const recordAsset = recordManifest.assets.find(
				(candidate) =>
					candidate.assetId === asset.assetId && candidate.path === asset.path,
			);
			let expectedMachine;
			try {
				expectedMachine = reconstructProvenanceRecord({
					packageDirectory,
					manifest: recordManifest,
					asset: recordAsset ?? asset,
					runtimeBytes,
					retainedLicenseEvidence,
				});
			} catch {
				issues.push(
					issue(
						"E_MUSIC_PROVENANCE",
						`/tracks/${track.trackId}/assetId`,
						"Retain the canonical machine provenance record for the exact track bytes.",
					),
				);
				continue;
			}
			if (!isDeepStrictEqual(machine, expectedMachine)) {
				issues.push(
					issue(
						"E_MUSIC_PROVENANCE",
						`/tracks/${track.trackId}/assetId`,
						"Regenerate the machine provenance record from the exact manifest and track bytes.",
					),
				);
			}
			const candidate = musicCandidate({
				asset,
				bytes: runtimeBytes.length,
				decodedAudio,
				machine,
				packBytes,
				retainedGrantSha256,
				track,
				trackCount: tracks.length,
			});
			for (const entry of validateMusicPolicy(candidate).issues) {
				issues.push({
					...entry,
					path: `/tracks/${track.trackId}${entry.path}`,
				});
			}
		}

		if (issues.length > 0) {
			reportIssues(issues);
		} else {
			console.log(
				`Music policy verified: ${tracks.length} WAV track, ${packBytes} exact bytes, canonical provenance and retained grants matched.`,
			);
		}
	}
}
