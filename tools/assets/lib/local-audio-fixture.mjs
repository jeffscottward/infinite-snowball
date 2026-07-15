import { createHash } from "node:crypto";

import { auditLocalAudioBoundary } from "./policy.mjs";

export const LOCAL_AUDIO_FIXTURE_RELATIVE_PATH =
	"tests/fixtures/assets/local-audio-cases.json";
export const LOCAL_AUDIO_FIXTURE_MAX_BYTES = 256 * 1024;

const TOP_LEVEL_KEYS = Object.freeze([
	"collidingOpaqueIds",
	"derivedOpaqueIds",
	"forbidden",
	"imported",
	"malformedPrivateValues",
	"nonArrays",
	"safe",
]);
const IMPORTED_KEYS = Object.freeze([
	"artworkSha256",
	"bytesBase64",
	"fileName",
	"fileSha256",
	"fingerprint",
	"localTrackId",
	"playlist",
	"rights",
	"tags",
	"waveform",
]);
const EMISSION_KEYS = Object.freeze(["channel", "payload"]);
const DERIVED_ID_KEYS = Object.freeze(["fileName", "localTrackId"]);
const SAFE_CHANNELS = Object.freeze(["player", "ui"]);
const FORBIDDEN_CHANNELS = Object.freeze([
	"analytics",
	"catalog",
	"diagnostic",
	"export",
	"network",
	"package",
	"player",
	"screenshot",
	"service-worker",
	"ui",
]);
const SAFE_STATES = new Set(["paused", "playing", "ready", "stopped"]);
const MAX_FIXTURE_BYTES = LOCAL_AUDIO_FIXTURE_MAX_BYTES;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_ARRAY_ENTRIES = 8 * 1024;
const MAX_JSON_DEPTH = 12;

function fail() {
	throw new Error("E_LOCAL_AUDIO_FIXTURE");
}

function plainRecord(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
	return (
		plainRecord(value) &&
		Object.keys(value).sort().join("\0") === expected.join("\0")
	);
}

function denseArray(value, minimum = 1) {
	return (
		Array.isArray(value) &&
		value.length >= minimum &&
		value.length <= MAX_ARRAY_ENTRIES &&
		Object.keys(value).length === value.length
	);
}

function boundedString(value, allowEmpty = false) {
	return (
		typeof value === "string" &&
		(allowEmpty || value.trim().length > 0) &&
		Buffer.byteLength(value, "utf8") <= MAX_STRING_BYTES
	);
}

function stringArray(value) {
	return denseArray(value) && value.every((entry) => boundedString(entry));
}

function canonicalJsonValue(value, depth = 0) {
	if (depth > MAX_JSON_DEPTH) fail();
	if (
		value === null ||
		typeof value === "boolean" ||
		boundedString(value, true)
	)
		return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value)) {
		if (!denseArray(value, 0)) fail();
		return value.map((entry) => canonicalJsonValue(entry, depth + 1));
	}
	if (!plainRecord(value) || Object.keys(value).length > 64) fail();
	const output = {};
	for (const key of Object.keys(value).sort()) {
		if (!boundedString(key)) fail();
		output[key] = canonicalJsonValue(value[key], depth + 1);
	}
	return output;
}

function canonicalEmission(value) {
	if (!exactKeys(value, EMISSION_KEYS) || !boundedString(value.channel)) fail();
	const payload = canonicalJsonValue(value.payload);
	if (!plainRecord(payload) || Object.keys(payload).length === 0) fail();
	return { channel: value.channel, payload };
}

function deepFreeze(value) {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const entry of Object.values(value)) deepFreeze(entry);
		Object.freeze(value);
	}
	return value;
}

function validateImported(value) {
	if (!exactKeys(value, IMPORTED_KEYS)) fail();
	if (
		!boundedString(value.localTrackId) ||
		!boundedString(value.fileName) ||
		!boundedString(value.bytesBase64) ||
		Buffer.from(value.bytesBase64, "base64").toString("base64") !==
			value.bytesBase64 ||
		!stringArray(value.tags) ||
		!HASH.test(value.artworkSha256) ||
		!denseArray(value.waveform) ||
		!value.waveform.every((entry) =>
			typeof entry === "number" && Number.isFinite(entry),
		) ||
		!boundedString(value.fingerprint) ||
		!HASH.test(value.fileSha256) ||
		!stringArray(value.playlist) ||
		!boundedString(value.rights)
	)
		fail();
	return {
		localTrackId: value.localTrackId,
		fileName: value.fileName,
		bytesBase64: value.bytesBase64,
		tags: [...value.tags],
		artworkSha256: value.artworkSha256,
		waveform: [...value.waveform],
		fingerprint: value.fingerprint,
		fileSha256: value.fileSha256,
		playlist: [...value.playlist],
		rights: value.rights,
	};
}

function validateSafe(value, imported) {
	if (!denseArray(value)) fail();
	const output = value.map((entry) => {
		const emission = canonicalEmission(entry);
		if (
			!SAFE_CHANNELS.includes(emission.channel) ||
			!exactKeys(emission.payload, ["localTrackId", "state"]) ||
			emission.payload.localTrackId !== imported.localTrackId ||
			!SAFE_STATES.has(emission.payload.state)
		)
			fail();
		return emission;
	});
	const channels = new Set(output.map((entry) => entry.channel));
	if (!SAFE_CHANNELS.every((channel) => channels.has(channel))) fail();
	return output;
}

function validateForbidden(value) {
	if (!denseArray(value)) fail();
	const output = value.map(canonicalEmission);
	const channels = new Set(output.map((entry) => entry.channel));
	if (
		output.some((entry) => !FORBIDDEN_CHANNELS.includes(entry.channel)) ||
		!FORBIDDEN_CHANNELS.every((channel) => channels.has(channel))
	)
		fail();
	return output;
}

function validateNonArrays(value) {
	if (!denseArray(value)) fail();
	const output = value.map((entry) => {
		if (entry === null) return null;
		if (typeof entry === "string" && boundedString(entry)) return entry;
		if (plainRecord(entry) && Object.keys(entry).length === 0) return {};
		fail();
	});
	if (
		!output.some((entry) => entry === null) ||
		!output.some((entry) => typeof entry === "string") ||
		!output.some((entry) => plainRecord(entry))
	)
		fail();
	return output;
}

function validateOptionalCaseClasses(value) {
	if (
		!denseArray(value.collidingOpaqueIds) ||
		!value.collidingOpaqueIds.every(
			(entry) => entry === null || boundedString(entry, true),
		) ||
		!denseArray(value.derivedOpaqueIds) ||
		!value.derivedOpaqueIds.every(
			(entry) =>
				exactKeys(entry, DERIVED_ID_KEYS) &&
				boundedString(entry.fileName) &&
				boundedString(entry.localTrackId),
		) ||
		!stringArray(value.malformedPrivateValues)
	)
		fail();
	return {
		collidingOpaqueIds: [...value.collidingOpaqueIds],
		derivedOpaqueIds: value.derivedOpaqueIds.map((entry) => ({
			fileName: entry.fileName,
			localTrackId: entry.localTrackId,
		})),
		malformedPrivateValues: [...value.malformedPrivateValues],
	};
}

export function validateLocalAudioFixture(value) {
	try {
		if (!exactKeys(value, TOP_LEVEL_KEYS)) fail();
		const imported = validateImported(value.imported);
		const safe = validateSafe(value.safe, imported);
		const forbidden = validateForbidden(value.forbidden);
		const nonArrays = validateNonArrays(value.nonArrays);
		const optionalCases = validateOptionalCaseClasses(value);
		const validated = deepFreeze({
			imported,
			safe,
			nonArrays,
			...optionalCases,
			forbidden,
		});
		if (!auditLocalAudioBoundary(validated.imported, validated.safe).ok) fail();
		for (const emission of validated.forbidden) {
			const checked = auditLocalAudioBoundary(validated.imported, [emission]);
			if (
				checked.ok ||
				!checked.issues.some(
					(entry) => entry.ruleId === "E_LOCAL_AUDIO_EGRESS",
				)
			)
				fail();
		}
		for (const emissions of validated.nonArrays) {
			const checked = auditLocalAudioBoundary(validated.imported, emissions);
			if (
				checked.ok ||
				!checked.issues.some(
					(entry) => entry.ruleId === "E_LOCAL_AUDIO_EGRESS",
				)
			)
				fail();
		}

		// Canonical fixture serialization is compact UTF-8 JSON with recursively
		// code-unit-sorted object keys and original array order, derived only from
		// the deeply frozen validated clone above.
		const canonical = JSON.stringify(canonicalJsonValue(validated));
		if (Buffer.byteLength(canonical, "utf8") > MAX_FIXTURE_BYTES) fail();
		return Object.freeze({
			fixtureSha256: createHash("sha256")
				.update(Buffer.from(canonical, "utf8"))
				.digest("hex"),
			safeFlows: validated.safe.length,
			blockedFlows: validated.forbidden.length,
			malformedSets: validated.nonArrays.length,
		});
	} catch (error) {
		if (error?.message === "E_LOCAL_AUDIO_FIXTURE") throw error;
		fail();
	}
}
