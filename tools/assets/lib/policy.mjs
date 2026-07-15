import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { canonicalConfigSha256 } from "./canonical-config.mjs";
import { containsProhibitedBrandTerm } from "./brand-terms.mjs";
import {
	inventoryTree,
	readInventoriedFile,
} from "./tree-inventory.mjs";
import {
	formatProvenanceLedgerRow,
	formatProvenanceLedger,
	inspectProvenanceContent,
	PROVENANCE_OUTPUT_LIMITS,
	provenanceRecordFileName,
	readProvenanceLedger,
	readRetainedLicenseText,
	resolveRetainedLicenseEvidence,
	reconstructProvenanceRecord,
	validatePackageLicensePolicy,
	validateProvenanceOutputMetrics,
} from "./provenance-ledger.mjs";

export {
	formatProvenanceLedgerRow,
	generateProvenanceLedger,
	validatePackageLicensePolicy,
} from "./provenance-ledger.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const STABLE_ID = /^(?!__proto__$)[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const SAFE_PROVENANCE_LICENSES = new Set(["CC0-1.0", "CC-BY-4.0"]);
const SAFE_MUSIC_LICENSES = new Set(["CC0-1.0", "CC-BY-4.0"]);
const PROVENANCE_LICENSE_URLS = new Map([
	["CC0-1.0", "https://creativecommons.org/publicdomain/zero/1.0/"],
	["CC-BY-4.0", "https://creativecommons.org/licenses/by/4.0/"],
]);
const SAFE_LOCAL_CHANNELS = new Set(["ui", "player"]);
const SAFE_LOCAL_STATES = new Set(["ready", "playing", "paused", "stopped"]);
const OPAQUE_LOCAL_TRACK_ID =
	/^local-track:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_LOCAL_PAYLOAD_KEYS = new Set(["localTrackId", "state"]);
const PROHIBITED_SOUNDTRACK =
	/katamari[^\n]{0,80}(?:soundtrack|fortissimo)|archive\.org\/details\/katamari-damacy-original-soundtrack/iu;

function sha256(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

function issue(ruleId, path, remediation) {
	return { ruleId, path, remediation };
}

function result(issues) {
	return { ok: issues.length === 0, issues };
}

function nonempty(value) {
	return typeof value === "string" && value.trim().length > 0;
}

function validHttps(value) {
	if (!nonempty(value)) return false;
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

function serialized(value) {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

function containsProhibitedBrandMetadata(
	value,
	visited = new WeakSet(),
) {
	if (typeof value === "string")
		return containsProhibitedBrandTerm(value);
	if (!value || typeof value !== "object") return false;
	if (visited.has(value)) return false;
	visited.add(value);
	if (Array.isArray(value))
		return value.some((entry) =>
			containsProhibitedBrandMetadata(entry, visited),
		);
	return Object.entries(value).some(
		([key, entry]) =>
			containsProhibitedBrandTerm(key) ||
			containsProhibitedBrandMetadata(entry, visited),
	);
}

function plainRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

function hasExactKeys(value, expected) {
	if (!plainRecord(value)) return false;
	try {
		return isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
	} catch {
		return false;
	}
}

export function validateProvenanceEvidence(value) {
	const issues = [];
	if (!validHttps(value?.sourceUrl)) {
		issues.push(
			issue(
				"E_PROVENANCE_SOURCE",
				"/sourceUrl",
				"Record the exact authoritative HTTPS source URL.",
			),
		);
	}
	if (!nonempty(value?.sourceArtifact)) {
		issues.push(
			issue(
				"E_PROVENANCE_SOURCE",
				"/sourceArtifact",
				"Record the exact archive member or generated source artifact.",
			),
		);
	}
	if (!HASH.test(value?.sourceArtifactSha256 ?? "")) {
		issues.push(
			issue(
				"E_PROVENANCE_SOURCE_HASH",
				"/sourceArtifactSha256",
				"Record the exact source-artifact SHA-256.",
			),
		);
	}
	if (!nonempty(value?.creator)) {
		issues.push(
			issue(
				"E_PROVENANCE_CREATOR",
				"/creator",
				"Record a known creator or publisher.",
			),
		);
	}
	if (
		!nonempty(value?.provider) ||
		value.provider !== value?.creator
	) {
		issues.push(
			issue(
				"E_PROVENANCE_PROVIDER",
				"/provider",
				"Bind the evidence provider to the exact recorded creator or publisher.",
			),
		);
	}
	if (
		value?.schemaVersion !== 1 ||
		!nonempty(value?.recordId) ||
		!nonempty(value?.packageName) ||
		!nonempty(value?.packageVersion) ||
		!nonempty(value?.packageKind) ||
		!nonempty(value?.packagePath) ||
		!nonempty(value?.assetId) ||
		!nonempty(value?.assetPath) ||
		!nonempty(value?.mime) ||
		!nonempty(value?.role) ||
		!Number.isSafeInteger(value?.bytes) ||
		value.bytes <= 0 ||
		!HASH.test(value?.sha256 ?? "")
	) {
		issues.push(
			issue(
				"E_PROVENANCE_ASSET_IDENTITY",
				"/assetId",
				"Record package/version/path/asset/role/MIME/bytes/SHA identity for the exact runtime asset.",
			),
		);
	}
	if (!nonempty(value?.acquisition) || !nonempty(value?.acquiredAt)) {
		issues.push(
			issue(
				"E_PROVENANCE_ACQUISITION",
				"/acquisition",
				"Record how and when the exact source artifact was acquired.",
			),
		);
	}
	if (!nonempty(value?.reviewer) || !nonempty(value?.reviewedAt)) {
		issues.push(
			issue(
				"E_PROVENANCE_REVIEWER",
				"/reviewer",
				"Record the named provenance reviewer and review timestamp.",
			),
		);
	}
	if (value?.evidenceStatus !== "verified") {
		issues.push(
			issue(
				"E_PROVENANCE_STATUS",
				"/evidenceStatus",
				"Only verified evidence is eligible for starter installs.",
			),
		);
	}
	if (!nonempty(value?.license?.textPath)) {
		issues.push(
			issue(
				"E_PROVENANCE_LICENSE_TEXT",
				"/license/textPath",
				"Retain the exact license text in the repository.",
			),
		);
	}
	if (!HASH.test(value?.license?.textSha256 ?? "")) {
		issues.push(
			issue(
				"E_PROVENANCE_LICENSE_HASH",
				"/license/textSha256",
				"Record the captured license-text SHA-256.",
			),
		);
	}
	if (!validHttps(value?.license?.url)) {
		issues.push(
			issue(
				"E_PROVENANCE_LICENSE_TEXT",
				"/license/url",
				"Record the authoritative license URL.",
			),
		);
	}

	const license = value?.license?.spdx;
	const expectedLicenseUrl = PROVENANCE_LICENSE_URLS.get(license);
	if (
		expectedLicenseUrl !== undefined &&
		value?.license?.url !== expectedLicenseUrl
	) {
		issues.push(
			issue(
				"E_LICENSE_EVIDENCE",
				"/license/url",
				"Bind the SPDX identifier to its exact authoritative Creative Commons URL.",
			),
		);
	}
	if (
		!SAFE_PROVENANCE_LICENSES.has(value?.packageLicense) ||
		!(
			value.packageLicense === license ||
			(value.packageLicense === "CC-BY-4.0" && license === "CC0-1.0")
		)
	) {
		issues.push(
			issue(
				"E_PACKAGE_LICENSE",
				"/packageLicense",
				"Record a CC-BY-4.0 package when attribution is required, or CC0-1.0 only when every contained asset is CC0.",
			),
		);
	}
	if (
		license === "CC-BY-4.0" &&
		(!nonempty(value?.license?.author) ||
			value.license.author !== value?.creator ||
			!validHttps(value?.license?.source) ||
			!equivalentCanonicalUrl(value.license.source, value?.sourceUrl) ||
			equivalentCanonicalUrl(value.sourceUrl, expectedLicenseUrl) ||
			value.license.textPath !==
				`docs/licenses/provenance/cc-by-4.0/${value.license.textSha256}.txt`)
	) {
		issues.push(
			issue(
				"E_LICENSE_EVIDENCE",
				"/license",
				"Retain CC BY author, original HTTPS source, canonical license URL, and hash-addressed license text.",
			),
		);
	}
	if (typeof license === "string" && /(?:^|-)NC(?:-|$)/u.test(license)) {
		issues.push(
			issue(
				"E_LICENSE_NC",
				"/license/spdx",
				"Noncommercial content is not eligible for starter packages.",
			),
		);
	} else if (typeof license === "string" && /(?:^|-)ND(?:-|$)/u.test(license)) {
		issues.push(
			issue(
				"E_LICENSE_ND",
				"/license/spdx",
				"No-derivatives content is not eligible for the transform pipeline.",
			),
		);
	} else if (!SAFE_PROVENANCE_LICENSES.has(license)) {
		issues.push(
			issue(
				"E_LICENSE_AMBIGUOUS",
				"/license/spdx",
				"Use an allowlisted exact grant or quarantine the asset.",
			),
		);
	}
	if (!nonempty(value?.license?.grant)) {
		issues.push(
			issue(
				"E_LICENSE_GRANT_MISSING",
				"/license/grant",
				"Record the captured grant or dedication.",
			),
		);
	}
	if (!nonempty(value?.attribution)) {
		issues.push(
			issue(
				"E_PROVENANCE_ATTRIBUTION",
				"/attribution",
				"Record required attribution or an explicit not-required statement.",
			),
		);
	}
	if (
		!Array.isArray(value?.modifications) ||
		value.modifications.length === 0 ||
		value.modifications.some((entry) => !nonempty(entry))
	) {
		issues.push(
			issue(
				"E_PROVENANCE_MODIFICATIONS",
				"/modifications",
				"Record every modification or an explicit exact-copy decision.",
			),
		);
	}
	const transformation = value?.transformation;
	const transformConfig =
		transformation?.config &&
		typeof transformation.config === "object" &&
		!Array.isArray(transformation.config)
			? transformation.config
			: null;
	let configSha256 = "";
	try {
		if (transformConfig)
			configSha256 = canonicalConfigSha256(transformConfig);
	} catch {
		// Invalid protocol config values are reported by E_PROVENANCE_TRANSFORM.
	}
	if (
		!nonempty(transformation?.recipe) ||
		!nonempty(transformation?.tool?.name) ||
		!nonempty(transformation?.tool?.version) ||
		!transformConfig ||
		!HASH.test(transformation?.configSha256 ?? "") ||
		transformation.configSha256 !== configSha256
	) {
		issues.push(
			issue(
				"E_PROVENANCE_TRANSFORM",
				"/transformation",
				"Record a structured recipe, pinned tool, config, and matching config SHA-256.",
			),
		);
	}
	if (!nonempty(value?.notes)) {
		issues.push(
			issue(
				"E_PROVENANCE_NOTES",
				"/notes",
				"Record review notes for the exact artifact and output.",
			),
		);
	}
	if (!value || !Object.hasOwn(value, "replacement")) {
		issues.push(
			issue(
				"E_PROVENANCE_REPLACEMENT",
				"/replacement",
				"Record an explicit null or reviewed replacement state.",
			),
		);
	}
	if (
		!HASH.test(value?.output?.sha256 ?? "") ||
		value.output.sha256 !== value?.sha256 ||
		!nonempty(value?.output?.path)
	) {
		issues.push(
			issue(
				"E_PROVENANCE_OUTPUT",
				"/output",
				"Bind the tracked output path and SHA-256 to the exact top-level runtime asset hash.",
			),
		);
	}

	if (
		/^os3a$/iu.test(value?.provider ?? "") ||
		/(?:^|\.)os3a\./iu.test(value?.sourceUrl ?? "")
	) {
		issues.push(
			issue(
				"E_SOURCE_ORIGIN_UNVERIFIED",
				"/sourceUrl",
				"Use the original creator or publisher source; an aggregator alone is not provenance evidence.",
			),
		);
	}
	if (
		/pelican/iu.test(value?.provider ?? "") ||
		/meshula\/labyrinth/iu.test(value?.sourceUrl ?? "")
	) {
		issues.push(
			issue(
				"E_SOURCE_PROHIBITED",
				"/sourceUrl",
				"Do not use the Pelican/Labyrinth generator path without independent asset and license verification.",
			),
		);
	}
	if (PROHIBITED_SOUNDTRACK.test(serialized(value))) {
		issues.push(
			issue(
				"E_SOUNDTRACK_PROHIBITED",
				"/sourceUrl",
				"Do not upload, package, catalog, cache, or redistribute the referenced commercial soundtrack.",
			),
		);
	}
	return result(issues);
}

export function validateMusicPolicy(value) {
	const issues = [];
	const license = value?.license;
	if (!SAFE_MUSIC_LICENSES.has(license)) {
		issues.push(
			issue(
				"E_MUSIC_LICENSE",
				"/license",
				"Use original, captured CC0, or fully attributed CC BY music.",
			),
		);
	}
	const expectedMusicLicenseUrl = PROVENANCE_LICENSE_URLS.get(license);
	if (
		expectedMusicLicenseUrl !== undefined &&
		(value?.asset?.licenseUrl !== expectedMusicLicenseUrl ||
			value?.machineProvenance?.license?.url !== expectedMusicLicenseUrl)
	) {
		issues.push(
			issue(
				"E_MUSIC_LICENSE",
				"/asset/licenseUrl",
				"Bind the music SPDX identifier to its exact authoritative Creative Commons URL.",
			),
		);
	}
	if (
		license === "CC-BY-4.0" &&
		(value?.sourceType !== "third-party" ||
			!nonempty(value?.creator) ||
			!validHttps(value?.source) ||
			equivalentCanonicalUrl(value.source, expectedMusicLicenseUrl) ||
			!nonempty(value?.attribution) ||
			!value.attribution.includes(value.creator))
	) {
		issues.push(
			issue(
				"E_MUSIC_ATTRIBUTION",
				"/attribution",
				"Retain the CC BY author, original HTTPS source, and exact attribution.",
			),
		);
	}
	if (!nonempty(value?.attribution)) {
		issues.push(
			issue(
				"E_MUSIC_ATTRIBUTION",
				"/attribution",
				"Record attribution or an explicit CC0 not-required statement.",
			),
		);
	}
	const grant = value?.grant;
	if (
		!hasExactKeys(grant, ["textPath", "textSha256"]) ||
		!nonempty(grant?.textPath) ||
		!HASH.test(grant?.textSha256 ?? "") ||
		value?.retainedGrantSha256 !== grant?.textSha256 ||
		value?.machineProvenance?.license?.textPath !== grant?.textPath ||
		value?.machineProvenance?.license?.textSha256 !== grant?.textSha256 ||
		(license === "CC-BY-4.0" &&
			(grant?.textPath !==
				`docs/licenses/provenance/cc-by-4.0/${grant?.textSha256}.txt` ||
				value?.machineProvenance?.license?.author !== value?.creator ||
				value?.machineProvenance?.license?.source !== value?.source))
	) {
		issues.push(
			issue(
				"E_MUSIC_GRANT",
				"/grant",
				"Retain the exact hashed grant or license text bound to the machine provenance record.",
			),
		);
	}
	if (value?.codec !== "audio/wav") {
		issues.push(
			issue(
				"E_MUSIC_CODEC",
				"/codec",
				"Use the reviewed PCM WAV codec; Ogg is not supported end to end.",
			),
		);
	}
	if (
		!Number.isSafeInteger(value?.bytes) ||
		value.bytes <= 0 ||
		value.bytes > 8 * 1024 * 1024
	) {
		issues.push(
			issue(
				"E_MUSIC_BYTES",
				"/bytes",
				"Keep each decoded-audio source file within 8 MiB.",
			),
		);
	}
	if (
		typeof value?.durationSeconds !== "number" ||
		!Number.isFinite(value.durationSeconds) ||
		value.durationSeconds <= 0 ||
		value.durationSeconds > 600
	) {
		issues.push(
			issue(
				"E_MUSIC_DURATION",
				"/durationSeconds",
				"Keep each track within ten minutes.",
			),
		);
	}
	if (value?.channels !== 2) {
		issues.push(
			issue(
				"E_MUSIC_CHANNELS",
				"/channels",
				"Starter tracks must be reviewed two-channel audio.",
			),
		);
	}
	if (
		!Number.isSafeInteger(value?.sampleRate) ||
		value.sampleRate <= 0 ||
		value.sampleRate > 48_000
	) {
		issues.push(
			issue(
				"E_MUSIC_SAMPLE_RATE",
				"/sampleRate",
				"Keep sample rate at or below 48 kHz.",
			),
		);
	}
	if (
		!Number.isSafeInteger(value?.packBytes) ||
		value.packBytes <= 0 ||
		value.packBytes > 32 * 1024 * 1024
	) {
		issues.push(
			issue(
				"E_MUSIC_PACK_BYTES",
				"/packBytes",
				"Keep the complete music pack within 32 MiB.",
			),
		);
	}
	if (
		!Number.isSafeInteger(value?.packTracks) ||
		value.packTracks <= 0 ||
		value.packTracks > 8
	) {
		issues.push(
			issue(
				"E_MUSIC_TRACK_COUNT",
				"/packTracks",
				"Keep the starter music pack at eight tracks or fewer.",
			),
		);
	}
	if (
		!new Set(["original", "third-party"]).has(value?.sourceType) ||
		!validHttps(value?.source)
	) {
		issues.push(
			issue(
				"E_MUSIC_GRANT",
				"/source",
				"Record original or independently verified third-party source evidence.",
			),
		);
	}

	const asset = value?.asset;
	const provenance = asset?.provenance;
	const machine = value?.machineProvenance;
	if (
		!plainRecord(asset) ||
		!plainRecord(provenance) ||
		!plainRecord(machine) ||
		!plainRecord(machine?.license) ||
		!plainRecord(machine?.output) ||
		value?.assetId !== asset?.assetId ||
		asset?.assetId !== machine?.assetId ||
		asset?.path !== machine?.assetPath ||
		value?.codec !== asset?.mime ||
		asset?.mime !== machine?.mime ||
		value?.bytes !== asset?.bytes ||
		asset?.bytes !== machine?.bytes ||
		!HASH.test(asset?.sha256 ?? "") ||
		asset?.sha256 !== machine?.sha256 ||
		asset?.sha256 !== machine?.output?.sha256 ||
		value?.creator !== provenance?.creator ||
		provenance?.creator !== machine?.creator ||
		value?.source !== provenance?.source ||
		provenance?.source !== machine?.sourceUrl ||
		value?.license !== asset?.license ||
		asset?.license !== machine?.license?.spdx ||
		value?.attribution !== provenance?.attribution ||
		provenance?.attribution !== machine?.attribution ||
		asset?.licenseUrl !== machine?.license?.url ||
		asset?.capturedLicenseSha256 !== machine?.license?.textSha256
	) {
		issues.push(
			issue(
				"E_MUSIC_BINDING",
				"/assetId",
				"Bind every track field to the exact audio asset and canonical machine provenance record.",
			),
		);
	}
	if (PROHIBITED_SOUNDTRACK.test(serialized(value))) {
		issues.push(
			issue(
				"E_SOUNDTRACK_PROHIBITED",
				"/source",
				"Do not upload, package, catalog, cache, or redistribute the referenced commercial soundtrack.",
			),
		);
	}
	return result(issues);
}

function flattenSensitive(value, output = new Set(), visited = new WeakSet()) {
	if (typeof value === "string" && value.length > 0) output.add(value);
	else if (typeof value === "number" || typeof value === "boolean")
		output.add(String(value));
	else if (value && typeof value === "object") {
		if (visited.has(value)) return output;
		visited.add(value);
		if (Array.isArray(value)) {
			for (const entry of value) flattenSensitive(entry, output, visited);
		} else {
			for (const [key, entry] of Object.entries(value)) {
				output.add(key);
				flattenSensitive(entry, output, visited);
			}
		}
	}
	return output;
}

function normalizedOpaqueAlias(value) {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^a-z0-9]/gu, "");
}

function decodedOpaqueCandidates(value) {
	const candidates = new Set([value]);
	let decoded = value;
	for (let index = 0; index < 2; index += 1) {
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) break;
			candidates.add(next);
			decoded = next;
		} catch {
			break;
		}
	}
	return candidates;
}

function encodedPrivateAliases(value) {
	const bytes = Buffer.from(value, "utf8");
	let percentEncoded;
	try {
		percentEncoded = encodeURIComponent(value);
	} catch {
		return null;
	}
	return new Set([
		value,
		percentEncoded,
		bytes.toString("hex"),
		bytes.toString("base64"),
		bytes.toString("base64url"),
	]);
}

function uuidMasksPrivateAlias(candidate, alias) {
	if (!OPAQUE_LOCAL_TRACK_ID.test(candidate)) return false;
	const candidateHex = candidate
		.slice("local-track:".length)
		.replaceAll("-", "");
	const aliasHex = alias.toLowerCase().replace(/[^a-f0-9]/gu, "");
	if (aliasHex.length < candidateHex.length) return false;
	for (
		let offset = 0;
		offset <= aliasHex.length - candidateHex.length;
		offset += 1
	) {
		let matches = true;
		for (let index = 0; index < candidateHex.length; index += 1) {
			if (index === 12 || index === 16) continue;
			if (candidateHex[index] !== aliasHex[offset + index]) {
				matches = false;
				break;
			}
		}
		if (matches) return true;
	}
	return false;
}

function opaqueLocalTrackIdCollides(localTrackId, sensitive) {
	if (
		!nonempty(localTrackId) ||
		!OPAQUE_LOCAL_TRACK_ID.test(localTrackId)
	) {
		return true;
	}
	for (const candidate of decodedOpaqueCandidates(localTrackId)) {
		const normalizedCandidate = normalizedOpaqueAlias(candidate);
		for (const sensitiveValue of sensitive) {
			const aliases = encodedPrivateAliases(sensitiveValue);
			if (aliases === null) return true;
			for (const alias of aliases) {
				if (
					candidate === alias ||
					uuidMasksPrivateAlias(candidate, alias)
				) {
					return true;
				}
				const normalizedAlias = normalizedOpaqueAlias(alias);
				if (
					normalizedAlias.length >= 8 &&
					normalizedCandidate.includes(normalizedAlias)
				) {
					return true;
				}
			}
		}
	}
	return false;
}

export function auditLocalAudioBoundary(imported, emissions) {
	const issues = [];
	if (!Array.isArray(emissions)) {
		return result([
			issue(
				"E_LOCAL_AUDIO_EGRESS",
				"/emissions",
				"Require an array of exact local UI/player emissions and fail closed on malformed input.",
			),
		]);
	}
	const localTrackId = imported?.localTrackId;
	const sensitive = new Set();
	if (plainRecord(imported)) {
		for (const [key, entry] of Object.entries(imported)) {
			sensitive.add(key);
			if (key !== "localTrackId") flattenSensitive(entry, sensitive);
		}
	} else {
		flattenSensitive(imported, sensitive);
	}
	const opaqueIdCollides = opaqueLocalTrackIdCollides(localTrackId, sensitive);
	if (opaqueIdCollides) {
		issues.push(
			issue(
				"E_LOCAL_AUDIO_EGRESS",
				"/imported/localTrackId",
				"Use a present, independently opaque local track ID that does not encode or reuse imported names, hashes, or metadata.",
			),
		);
	}
	const allowedOpaqueValues = new Set([
		localTrackId,
		...SAFE_LOCAL_STATES,
		...SAFE_LOCAL_PAYLOAD_KEYS,
	]);
	for (const [index, emission] of emissions.entries()) {
		const payload = emission?.payload;
		const payloadValues = flattenSensitive(payload);
		const forbiddenChannel = !SAFE_LOCAL_CHANNELS.has(emission?.channel);
		const exactEmission =
			hasExactKeys(emission, ["channel", "payload"]) &&
			hasExactKeys(payload, ["localTrackId", "state"]) &&
			payload?.localTrackId === imported?.localTrackId &&
			SAFE_LOCAL_STATES.has(payload?.state);
		const leaked = [...payloadValues].some(
			(value) => sensitive.has(value) && !allowedOpaqueValues.has(value),
		);
		const unknownPayload = [...payloadValues].some(
			(value) =>
				!SAFE_LOCAL_PAYLOAD_KEYS.has(value) && !allowedOpaqueValues.has(value),
		);
		if (
			forbiddenChannel ||
			!exactEmission ||
			leaked ||
			unknownPayload
		) {
			issues.push(
				issue(
					"E_LOCAL_AUDIO_EGRESS",
					`/emissions/${index}`,
					"Keep imported audio bytes, names, keys, tags, artwork, waveform, hashes, playlists, and rights metadata local-only.",
				),
			);
		}
	}
	return result(issues);
}

export function validateBrandMetadata(value) {
	const issues = [];
	const text = serialized(value);
	const prohibitedBrand = containsProhibitedBrandMetadata(value);
	if (
		prohibitedBrand &&
		/(?:official|endorsed|authorized|licensed)\b|\bsuccessor\b/iu.test(text)
	) {
		issues.push(
			issue(
				"E_BRAND_AFFILIATION",
				"/",
				"Do not imply affiliation, endorsement, or official successor status.",
			),
		);
	}
	if (
		prohibitedBrand ||
		/katamari\s+damacy|beautiful\s+katamari|we\s+love\s+katamari/iu.test(text)
	) {
		issues.push(
			issue(
				"E_BRAND_FRANCHISE",
				"/",
				"Use the original Infinite Snowball name and factual compatibility copy.",
			),
		);
	}
	if (
		/same\s+prince|rainbow\s+cosmos|logo\s+lettering|exact\s+visual\s+style|king\s+of\s+all\s+cosmos/iu.test(
			text,
		)
	) {
		issues.push(
			issue(
				"E_BRAND_TRADE_DRESS",
				"/",
				"Use original characters, logo, typography, world, and visual language.",
			),
		);
	}
	if (
		prohibitedBrand &&
		/(?:rating|review)"\s*:|\b\d(?:\.\d)?\s*stars?\b|major\s+magazine/iu.test(
			text,
		)
	) {
		issues.push(
			issue(
				"E_BRAND_FAKE_RATING",
				"/",
				"Publish only verified, sourceable ratings and reviews.",
			),
		);
	}
	if (
		/download\s+on\s+the\s+app\s+store|get\s+it\s+on\s+google\s+play/iu.test(
			text,
		)
	) {
		issues.push(
			issue(
				"E_BRAND_STORE_BADGE",
				"/badges",
				"Do not show store badges before a real approved listing exists.",
			),
		);
	}
	if (
		/better\s+than\s+katamari|exactly\s+like\s+the\s+original|clone\s+of\s+katamari/iu.test(
			text,
		)
	) {
		issues.push(
			issue(
				"E_BRAND_DIRECT_COMPARISON",
				"/",
				"Describe original mechanics directly instead of franchise-comparison marketing.",
			),
		);
	}
	if (
		PROHIBITED_SOUNDTRACK.test(text) ||
		/download\s+and\s+play\s+the\s+katamari\s+soundtrack/iu.test(text)
	) {
		issues.push(
			issue(
				"E_SOUNDTRACK_PROHIBITED",
				"/",
				"Do not direct users to import or redistribute the referenced commercial soundtrack.",
			),
		);
	}
	if (
		value?.productName !== undefined &&
		value.productName !== "Infinite Snowball"
	) {
		issues.push(
			issue(
				"E_BRAND_NAME",
				"/productName",
				"Use the original Infinite Snowball product name.",
			),
		);
	}
	return result(issues);
}

function validPackageIdentity(value) {
	return (
		hasExactKeys(value, ["name", "version", "integrity", "manifestSha256"]) &&
		/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(value.name) &&
		/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value.version) &&
		/^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/u.test(value.integrity) &&
		HASH.test(value.manifestSha256)
	);
}

function packageIdentitySha256(value) {
	return sha256(
		Buffer.from(
			[value.name, value.version, value.integrity, value.manifestSha256].join(
				"\n",
			),
			"utf8",
		),
	);
}

function validAffectedIds(value) {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((entry) => nonempty(entry) && STABLE_ID.test(entry)) &&
		new Set(value).size === value.length
	);
}

function validCompleteMap(value, affectedIds) {
	return (
		Array.isArray(affectedIds) &&
		plainRecord(value) &&
		isDeepStrictEqual(Object.keys(value).sort(), [...affectedIds].sort()) &&
		Object.values(value).every(
			(entry) => nonempty(entry) && STABLE_ID.test(entry),
		)
	);
}

export function validateWithdrawalRecord(value) {
	const issues = [];
	const packageIdentity = value?.package;
	const expectedRecordId = validPackageIdentity(packageIdentity)
		? `withdrawal:${packageIdentitySha256(packageIdentity)}`
		: "";
	if (
		value?.schemaVersion !== 1 ||
		!validPackageIdentity(packageIdentity) ||
		value?.recordId !== expectedRecordId
	) {
		issues.push(
			issue(
				"E_WITHDRAWAL_IDENTITY",
				"/package",
				"Bind withdrawal to the exact package name, version, npm integrity, and manifest SHA-256.",
			),
		);
	}
	if (value?.simulationOnly !== true) {
		issues.push(
			issue(
				"E_WITHDRAWAL_SIMULATION",
				"/simulationOnly",
				"Keep this reviewed P03 drill explicitly simulation-only; never convert it into a live withdrawal event.",
			),
		);
	}
	if (
		value?.evidenceStatus !== "withdrawn" ||
		value?.installEligibility !== "withdrawn" ||
		value?.allowNewInstalls !== false
	) {
		issues.push(
			issue(
				"E_WITHDRAWAL_INSTALL",
				"/allowNewInstalls",
				"Withdrawn evidence must block every new install.",
			),
		);
	}
	const references = new Set(
		Array.isArray(value?.preserveReferences) ? value.preserveReferences : [],
	);
	if (!references.has("save") || !references.has("history")) {
		issues.push(
			issue(
				"E_WITHDRAWAL_HISTORY",
				"/preserveReferences",
				"Preserve both save and history references during withdrawal.",
			),
		);
	}
	const affectedObjectIds = value?.affectedObjectIds;
	const affectedAssetIds = value?.affectedAssetIds;
	if (
		!validAffectedIds(affectedObjectIds) ||
		!validAffectedIds(affectedAssetIds)
	) {
		issues.push(
			issue(
				"E_WITHDRAWAL_AFFECTED",
				"/affectedObjectIds",
				"Record every affected object ID and asset ID explicitly.",
			),
		);
	}
	const replacement = value?.replacement;
	if (
		!plainRecord(replacement) ||
		!validPackageIdentity(replacement?.package) ||
		!validCompleteMap(replacement?.objectIdMap, affectedObjectIds ?? []) ||
		!validCompleteMap(replacement?.assetIdMap, affectedAssetIds ?? []) ||
		(packageIdentity?.name === replacement?.package?.name &&
			packageIdentity?.version === replacement?.package?.version) ||
		packageIdentity?.integrity === replacement?.package?.integrity ||
		packageIdentity?.manifestSha256 === replacement?.package?.manifestSha256
	) {
		issues.push(
			issue(
				"E_WITHDRAWAL_REPLACEMENT",
				"/replacement",
				"Record an exact replacement package and complete deterministic object/asset migration maps.",
			),
		);
	}
	return result(issues);
}
function inspectedPackageIdentity(entry) {
	return {
		name: entry?.manifest?.name,
		version: entry?.manifest?.version,
		integrity: entry?.artifact?.integrity,
		manifestSha256: entry?.manifestSha256,
	};
}

function referencedAssetIds(object) {
	return [
		object?.renderAssetId,
		object?.colliderAssetId,
		...(Array.isArray(object?.lodAssetIds) ? object.lodAssetIds : []),
	].filter((assetId) => typeof assetId === "string");
}

export function validateWithdrawalPackageBinding(value, currentPackages) {
	const packages = Array.isArray(currentPackages) ? currentPackages : [];
	const matches = packages.filter(
		(entry) =>
			entry?.manifest?.name === value?.package?.name &&
			entry?.manifest?.version === value?.package?.version,
	);
	const current = matches.length === 1 ? matches[0] : undefined;
	const expected =
		current === undefined ? undefined : inspectedPackageIdentity(current);
	const issues = [];
	if (expected === undefined || !isDeepStrictEqual(value?.package, expected)) {
		issues.push(
			issue(
				"E_WITHDRAWAL_IDENTITY",
				"/package",
				"Bind the withdrawal to the exact current package name, version, artifact integrity, and manifest SHA-256.",
			),
		);
	}
	const replacementPackage = value?.replacement?.package;
	const reviewedReplacementMatches = validPackageIdentity(replacementPackage)
		? packages.filter(
				(entry) =>
					entry?.manifest?.name === replacementPackage.name &&
					entry?.manifest?.version === replacementPackage.version,
			)
		: [];
	if (reviewedReplacementMatches.length > 0) {
		const reviewedReplacement =
			reviewedReplacementMatches.length === 1
				? reviewedReplacementMatches[0]
				: undefined;
		const expectedReplacement =
			reviewedReplacement === undefined
				? undefined
				: inspectedPackageIdentity(reviewedReplacement);
		if (
			expectedReplacement === undefined ||
			!isDeepStrictEqual(replacementPackage, expectedReplacement)
		) {
			issues.push(
				issue(
					"E_WITHDRAWAL_REPLACEMENT",
					"/replacement/package",
					"Bind a present reviewed replacement to its exact package name, version, artifact integrity, and manifest SHA-256.",
				),
			);
		}
		if (reviewedReplacement !== undefined) {
			const replacementAssetIds = new Set(
				(Array.isArray(reviewedReplacement.manifest?.assets)
					? reviewedReplacement.manifest.assets
					: []
				).map((asset) => asset?.assetId),
			);
			const replacementObjectIds = new Set(
				(
					Array.isArray(reviewedReplacement.manifest?.entries)
						? reviewedReplacement.manifest.entries
						: []
				)
					.flatMap((entry) =>
						Array.isArray(entry?.objects) ? entry.objects : [],
					)
					.map((object) => object?.objectId),
			);
			const objectIdMap = value?.replacement?.objectIdMap;
			const assetIdMap = value?.replacement?.assetIdMap;
			const targetsExist =
				plainRecord(objectIdMap) &&
				Object.values(objectIdMap).every((objectId) =>
					replacementObjectIds.has(objectId),
				) &&
				plainRecord(assetIdMap) &&
				Object.values(assetIdMap).every((assetId) =>
					replacementAssetIds.has(assetId),
				);
			if (!targetsExist) {
				issues.push(
					issue(
						"E_WITHDRAWAL_REPLACEMENT",
						"/replacement",
						"Bind every replacement object and asset map target to an ID in the exact reviewed replacement manifest.",
					),
				);
			}
		}
	}
	if (current !== undefined) {
		const manifestAssetIds = new Set(
			(Array.isArray(current.manifest?.assets)
				? current.manifest.assets
				: []
			).map((asset) => asset?.assetId),
		);
		const manifestObjects = (
			Array.isArray(current.manifest?.entries) ? current.manifest.entries : []
		).flatMap((entry) => (Array.isArray(entry?.objects) ? entry.objects : []));
		const objectById = new Map(
			manifestObjects.map((object) => [object?.objectId, object]),
		);
		const affectedObjectIds = value?.affectedObjectIds;
		const affectedAssetIds = value?.affectedAssetIds;
		const affectedAssetSet = new Set(
			Array.isArray(affectedAssetIds) ? affectedAssetIds : [],
		);
		const affectedObjectSet = new Set(
			Array.isArray(affectedObjectIds) ? affectedObjectIds : [],
		);
		const affectedObjectsValid =
			validAffectedIds(affectedObjectIds) &&
			affectedObjectIds.every((objectId) => {
				const object = objectById.get(objectId);
				if (object === undefined) return false;
				const relatedAssetIds = referencedAssetIds(object);
				return relatedAssetIds.every(
					(assetId) =>
						manifestAssetIds.has(assetId) && affectedAssetSet.has(assetId),
				);
			}) &&
			manifestObjects.every((object) => {
				const referencesAffectedAsset = referencedAssetIds(object).some(
					(assetId) => affectedAssetSet.has(assetId),
				);
				return (
					!referencesAffectedAsset || affectedObjectSet.has(object?.objectId)
				);
			});
		const affectedAssetsValid =
			validAffectedIds(affectedAssetIds) &&
			affectedAssetIds.every((assetId) => manifestAssetIds.has(assetId));
		const replacement = value?.replacement;
		if (
			!affectedObjectsValid ||
			!affectedAssetsValid ||
			!validCompleteMap(
				replacement?.objectIdMap,
				Array.isArray(affectedObjectIds) ? affectedObjectIds : [],
			) ||
			!validCompleteMap(
				replacement?.assetIdMap,
				Array.isArray(affectedAssetIds) ? affectedAssetIds : [],
			)
		) {
			issues.push(
				issue(
					"E_WITHDRAWAL_AFFECTED",
					"/affectedObjectIds",
					"Bind the complete reverse closure of affected objects and relationship assets, plus replacement map keys, to the exact current manifest.",
				),
			);
		}
	}
	return result(issues);
}

export function createWithdrawalRegistryRecord(value) {
	const checked = validateWithdrawalRecord(value);
	if (!checked.ok) {
		throw new Error(
			`E_WITHDRAWAL_RECORD_INVALID: ${checked.issues
				.map((entry) => entry.ruleId)
				.join(",")}`,
		);
	}
	const packageIdentity = structuredClone(value.package);
	const replacementPackage = structuredClone(value.replacement.package);
	const packageKey = `${packageIdentity.name}@${packageIdentity.version}`;
	const replacementKey = `${replacementPackage.name}@${replacementPackage.version}`;
	return {
		schemaVersion: 1,
		registryId: value.recordId,
		simulationOnly: true,
		status: "withdrawn",
		package: packageIdentity,
		packageKey,
		allowNewInstalls: false,
		preserveReferences: [...value.preserveReferences],
		affected: {
			objectIds: [...value.affectedObjectIds],
			assetIds: [...value.affectedAssetIds],
		},
		replacement: {
			package: replacementPackage,
			packageKey: replacementKey,
			objectIdMap: { ...value.replacement.objectIdMap },
			assetIdMap: { ...value.replacement.assetIdMap },
		},
		catalogEligibility: {
			package: {
				name: packageIdentity.name,
				version: packageIdentity.version,
			},
			status: "withdrawn",
			existingInstall: false,
			replacement: {
				name: replacementPackage.name,
				version: replacementPackage.version,
			},
		},
		dispatch: {
			simulationOnly: true,
			type: "withdraw-package",
			eventId: value.recordId,
			package: packageKey,
			replacement: replacementKey,
		},
	};
}


function orderedWithdrawalMap(value, affectedIds) {
	return Object.fromEntries(
		affectedIds.map((affectedId) => [affectedId, value[affectedId]]),
	);
}

function canonicalWithdrawalBytes(record) {
	const replacement = record.replacement;
	const canonical = {
		schemaVersion: record.schemaVersion,
		recordId: record.recordId,
		package: {
			name: record.package.name,
			version: record.package.version,
			integrity: record.package.integrity,
			manifestSha256: record.package.manifestSha256,
		},
		affectedObjectIds: record.affectedObjectIds,
		affectedAssetIds: record.affectedAssetIds,
		evidenceStatus: record.evidenceStatus,
		installEligibility: record.installEligibility,
		allowNewInstalls: record.allowNewInstalls,
		preserveReferences: record.preserveReferences,
		reason: record.reason,
		replacement: {
			package: {
				name: replacement.package.name,
				version: replacement.package.version,
				integrity: replacement.package.integrity,
				manifestSha256: replacement.package.manifestSha256,
			},
			objectIdMap: orderedWithdrawalMap(
				replacement.objectIdMap,
				record.affectedObjectIds,
			),
			assetIdMap: orderedWithdrawalMap(
				replacement.assetIdMap,
				record.affectedAssetIds,
			),
		},
		simulationOnly: record.simulationOnly,
	};
	return `${JSON.stringify(canonical, null, "\t")}\n`;
}

export async function readCanonicalWithdrawalRecord(
	root = process.cwd(),
) {
	const directory = resolve(
		root,
		"docs",
		"licenses",
		"withdrawals",
	);
	try {
		const inventory = await inventoryTree(directory, {
			maxEntries: 64,
			maxFiles: 32,
			maxDepth: 1,
			maxFileBytes: 256 * 1024,
			maxTotalBytes: 512 * 1024,
		});
		const entry = inventory.entries.find(
			(candidate) =>
				candidate.relativePath ===
					"starter-rock-simulated.json" &&
				candidate.kind === "file" &&
				candidate.contained,
		);
		if (!inventory.ok || entry === undefined) {
			throw new Error("unsafe withdrawal inventory");
		}
		const raw = (await readInventoriedFile(entry)).toString("utf8");
		const record = JSON.parse(raw);
		if (!validateWithdrawalRecord(record).ok)
			throw new Error("invalid withdrawal record");
		if (raw !== canonicalWithdrawalBytes(record))
			throw new Error("noncanonical withdrawal bytes");
		return record;
	} catch (cause) {
		throw new Error(
			"E_WITHDRAWAL_PATH: read only the exact bounded canonical withdrawal record",
			{ cause },
		);
	}
}

function normalized(path) {
	return path.split(sep).join("/");
}

export async function checkProvenanceLedger(options = {}) {
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
	const outputPathsCanonical =
		(options.machineRoot === undefined ||
			resolve(options.machineRoot) === machineRoot) &&
		(options.ledgerPath === undefined ||
			resolve(options.ledgerPath) === ledgerPath);
	const issues = [];
	if (!outputPathsCanonical) {
		issues.push(
			issue(
				"E_LEDGER_OUTPUT_PATH",
				"/ledger",
				"Read provenance evidence only from the canonical machine-record and human-ledger paths.",
			),
		);
	}
	const runtime = new Map();

	const inspected = await inspectProvenanceContent(contentRoot);
	for (const contentIssue of inspected.issues) issues.push(contentIssue);
	for (const packageEntry of inspected.packages) {
		const {
			packageDirectory,
			manifest,
			assetBytes,
		} = packageEntry;
		const packageLicense = validatePackageLicensePolicy(manifest);
		for (const packageIssue of packageLicense.issues) {
			issues.push({
				...packageIssue,
				path: `/${packageDirectory}${packageIssue.path}`,
			});
		}
		for (const asset of manifest.assets) {
			const recordId = `asset:${manifest.name}:${manifest.version}:${asset.assetId}`;
			const bytes = assetBytes.get(asset.path);
			if (runtime.has(recordId)) {
				issues.push(
					issue(
						"E_LEDGER_RUNTIME_DUPLICATE",
						`/${recordId}`,
						"Use one stable record per runtime asset.",
					),
				);
			}
			const runtimeMatches =
				bytes !== undefined &&
				sha256(bytes) === asset.sha256 &&
				bytes.length === asset.bytes;
			if (!runtimeMatches) {
				issues.push(
					issue(
						"E_LEDGER_RUNTIME_HASH",
						`/${recordId}`,
						"Match manifest evidence to exact runtime bytes.",
					),
				);
			}
			let canonicalRecord = null;
			if (runtimeMatches) {
				try {
					const retainedLicenseEvidence =
						await resolveRetainedLicenseEvidence(
							root,
							asset,
							options.retainedEvidenceDispatch,
						);
					canonicalRecord = reconstructProvenanceRecord({
						packageDirectory,
						manifest,
						asset,
						runtimeBytes: bytes,
						retainedLicenseEvidence,
					});
				} catch {
					issues.push(
						issue(
							"E_LEDGER_MACHINE_STALE",
							`/${recordId}`,
							"Reconstruct a canonical provenance record from the current manifest and runtime bytes.",
						),
					);
				}
			}
			runtime.set(recordId, { canonicalRecord });
		}
	}

	const machines = new Map();
	const machineRawBytes = new Map();
	const machineInventory = await inventoryTree(machineRoot, {
		maxEntries: PROVENANCE_OUTPUT_LIMITS.maxRecords,
		maxFiles: PROVENANCE_OUTPUT_LIMITS.maxRecords,
		maxDepth: 1,
		maxFileBytes: PROVENANCE_OUTPUT_LIMITS.maxRecordBytes,
		maxTotalBytes: PROVENANCE_OUTPUT_LIMITS.maxMachineBytes,
	});
	for (const inventoryIssue of machineInventory.issues) {
		issues.push(
			issue(
				"E_LEDGER_MACHINE_INVENTORY",
				`/machine${inventoryIssue.path}`,
				"Keep the fixed machine-record directory bounded, flat, regular-file-only, and contained.",
			),
		);
	}
	for (const entry of machineInventory.entries) {
		const file = entry.absolutePath;
		if (
			entry.kind !== "file" ||
			!entry.contained ||
			!entry.relativePath.endsWith(".json")
		) {
			issues.push(
				issue(
					"E_LEDGER_MACHINE_PATH",
					`/${normalized(relative(root, file))}`,
					"Store only contained regular canonical JSON records directly in the machine-record directory.",
				),
			);
			continue;
		}
		let record;
		let rawBytes;
		try {
			rawBytes = await readInventoriedFile(entry);
			record = JSON.parse(rawBytes.toString("utf8"));
		} catch {
			issues.push(
				issue(
					"E_LEDGER_MACHINE_JSON",
					`/${normalized(relative(root, file))}`,
					"Repair the machine-readable provenance JSON.",
				),
			);
			continue;
		}
		const machinePath = normalized(relative(machineRoot, file));
		let canonicalMachinePath = null;
		try {
			canonicalMachinePath = provenanceRecordFileName(record);
		} catch {
			// Invalid embedded identities are reported as a noncanonical path below.
		}
		if (machinePath !== canonicalMachinePath) {
			issues.push(
				issue(
					"E_LEDGER_MACHINE_PATH",
					`/${normalized(relative(root, file))}`,
					"Store every machine record at its exact canonical provenance filename with no nesting.",
				),
			);
		}
		if (!nonempty(record?.recordId)) {
			issues.push(
				issue(
					"E_LEDGER_MACHINE_ID",
					`/${normalized(relative(root, file))}`,
					"Add a stable recordId.",
				),
			);
			continue;
		}
		if (machines.has(record.recordId)) {
			issues.push(
				issue(
					"E_LEDGER_MACHINE_DUPLICATE",
					`/${record.recordId}`,
					"Keep exactly one machine record per runtime asset.",
				),
			);
		}
		machines.set(record.recordId, record);
		machineRawBytes.set(record.recordId, rawBytes);
		const validation = validateProvenanceEvidence(record);
		for (const entry of validation.issues)
			issues.push({ ...entry, path: `/${record.recordId}${entry.path}` });
	}

	let ledger = "";
	let ledgerBytes = Buffer.alloc(0);
	try {
		ledgerBytes = Buffer.from(await readProvenanceLedger(root));
		ledger = ledgerBytes.toString("utf8");
	} catch {
		issues.push(
			issue(
				"E_LEDGER_HUMAN_MISSING",
				"/ledger",
				"Generate the human-readable provenance ledger.",
			),
		);
	}
	const machineFiles = machineInventory.entries.filter(
		(entry) => entry.kind === "file" && entry.contained,
	);
	if (
		!validateProvenanceOutputMetrics({
			recordCount: machineFiles.length,
			maxRecordBytes: machineFiles.reduce(
				(maximum, entry) => Math.max(maximum, entry.bytes),
				0,
			),
			machineBytes: machineFiles.reduce(
				(total, entry) => total + entry.bytes,
				0,
			),
			humanLedgerBytes: ledgerBytes.length,
		})
	) {
		issues.push(
			issue(
				"E_LEDGER_OUTPUT_BUDGET",
				"/",
				"Keep machine records and the human ledger within the shared provenance output budget.",
			),
		);
	}
	const canonicalRecords = [...runtime.values()].map(
		(entry) => entry.canonicalRecord,
	);
	if (
		canonicalRecords.every((record) => record !== null) &&
		ledger !== formatProvenanceLedger(canonicalRecords)
	) {
		issues.push(
			issue(
				"E_LEDGER_HUMAN_STALE",
				"/ledger",
				"Regenerate the complete human ledger, including its heading, policy notes, and canonical asset rows.",
			),
		);
	}
	const humanRows = new Map();
	for (const line of ledger.split(/\r?\n/u)) {
		const match = line.match(/^\|\s*`?(asset:[^`|]+)`?\s*\|/u);
		if (!match) continue;
		if (humanRows.has(match[1]))
			issues.push(
				issue(
					"E_LEDGER_HUMAN_DUPLICATE",
					`/${match[1]}`,
					"Keep one human row per runtime asset.",
				),
			);
		humanRows.set(match[1], line);
	}

	const retainedLicenseHashes = new Map();
	for (const [recordId, expected] of runtime) {
		const machine = machines.get(recordId);
		if (!machine) {
			issues.push(
				issue(
					"E_LEDGER_MACHINE_MISSING",
					`/${recordId}`,
					"Generate the corresponding machine provenance record.",
				),
			);
		} else if (
			expected.canonicalRecord &&
			!isDeepStrictEqual(machine, expected.canonicalRecord)
		) {
			issues.push(
				issue(
					"E_LEDGER_MACHINE_STALE",
					`/${recordId}`,
					"Regenerate every machine field from the current manifest and exact runtime bytes.",
				),
			);
		}
		else if (
			expected.canonicalRecord &&
			!machineRawBytes
				.get(recordId)
				?.equals(
					Buffer.from(
						`${JSON.stringify(expected.canonicalRecord, null, 2)}\n`,
						"utf8",
					),
				)
		) {
			issues.push(
				issue(
					"E_LEDGER_MACHINE_NONCANONICAL",
					`/${recordId}`,
					"Store the exact canonical pretty-printed JSON bytes with one occurrence of every key.",
				),
			);
		}
		if (expected.canonicalRecord) {
			const licensePath = expected.canonicalRecord.license.textPath;
			if (!retainedLicenseHashes.has(licensePath)) {
				try {
					retainedLicenseHashes.set(
						licensePath,
						sha256(
							await readRetainedLicenseText(root, licensePath),
						),
					);
				} catch {
					retainedLicenseHashes.set(licensePath, null);
				}
			}
			const retainedLicenseSha256 = retainedLicenseHashes.get(licensePath);
			if (retainedLicenseSha256 === null) {
				issues.push(
					issue(
						"E_LEDGER_LICENSE_MISSING",
						`/${recordId}/license`,
						"Retain the exact captured license text.",
					),
				);
			} else if (
				retainedLicenseSha256 !== expected.canonicalRecord.license.textSha256
			) {
				issues.push(
					issue(
						"E_LEDGER_LICENSE_HASH",
						`/${recordId}/license`,
						"Match the captured license-text hash.",
					),
				);
			}
		}
		const humanRow = humanRows.get(recordId);
		if (humanRow === undefined) {
			issues.push(
				issue(
					"E_LEDGER_HUMAN_MISSING",
					`/${recordId}`,
					"Add the corresponding human ledger row.",
				),
			);
		} else if (
			expected.canonicalRecord &&
			humanRow !== formatProvenanceLedgerRow(expected.canonicalRecord)
		) {
			issues.push(
				issue(
					"E_LEDGER_HUMAN_STALE",
					`/${recordId}`,
					"Regenerate every human ledger column from the canonical machine record.",
				),
			);
		}
	}
	for (const recordId of machines.keys()) {
		if (!runtime.has(recordId))
			issues.push(
				issue(
					"E_LEDGER_MACHINE_ORPHAN",
					`/${recordId}`,
					"Remove or restore the orphan record.",
				),
			);
	}
	for (const recordId of humanRows.keys()) {
		if (!runtime.has(recordId))
			issues.push(
				issue(
					"E_LEDGER_HUMAN_ORPHAN",
					`/${recordId}`,
					"Remove or restore the orphan ledger row.",
				),
			);
	}

	return {
		ok: issues.length === 0,
		issues,
		runtimeFiles: runtime.size,
		machineRecords: machines.size,
		humanRows: humanRows.size,
	};
}
