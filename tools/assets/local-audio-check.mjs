import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { auditLocalAudioBoundary } from "./lib/policy.mjs";
import {
	LOCAL_AUDIO_FIXTURE_RELATIVE_PATH,
	validateLocalAudioFixture,
} from "./lib/local-audio-fixture.mjs";
import {
	inventoryTree,
	readInventoriedFile,
} from "./lib/tree-inventory.mjs";

const root = process.cwd();
const fixture = JSON.parse(
	await readFile(
		join(root, ...LOCAL_AUDIO_FIXTURE_RELATIVE_PATH.split("/")),
		"utf8",
	),
);
const fixtureSummary = validateLocalAudioFixture(fixture);
const failures = [];
if (!auditLocalAudioBoundary(fixture.imported, fixture.safe).ok)
	failures.push("safe opaque playback state was rejected");
for (const emission of fixture.forbidden) {
	const checked = auditLocalAudioBoundary(fixture.imported, [emission]);
	if (
		checked.ok ||
		!checked.issues.some((issue) => issue.ruleId === "E_LOCAL_AUDIO_EGRESS")
	) {
		failures.push(`forbidden ${emission.channel} egress was accepted`);
	}
}
for (const malformed of fixture.nonArrays ?? []) {
	const checked = auditLocalAudioBoundary(fixture.imported, malformed);
	if (
		checked.ok ||
		!checked.issues.some((issue) => issue.ruleId === "E_LOCAL_AUDIO_EGRESS")
	) {
		failures.push("malformed non-array emissions were accepted");
	}
}


const releaseRoots = [
	join(root, "content"),
	join(root, "docs", "assets"),
	join(root, "docs", "licenses"),
	join(root, "docs", "music"),
	join(root, "docs", "brand"),
];
const releaseInventoryLimits = {
	maxEntries: 1_024,
	maxFiles: 512,
	maxDepth: 12,
	maxFileBytes: 16 * 1024 * 1024,
	maxTotalBytes: 128 * 1024 * 1024,
};
function privateLeafLabel(path) {
	if (path === "localTrackId") return "private local track ID";
	if (path === "fileName") return "private filename (imported filename)";
	if (path.startsWith("tags")) return "private imported tag";
	if (path === "waveform") return "private imported waveform";
	if (path.startsWith("fingerprint"))
		return "private imported fingerprint";
	if (path === "artworkSha256") return "private artwork hash";
	if (path === "fileSha256") return "private file hash";
	if (path.startsWith("playlist")) return "private playlist";
	if (path === "rights") return "private rights note";
	if (path === "bytesBase64") return "encoded audio bytes";
	return `private imported ${path}`;
}

function collectPrivateLeaves(value, path = "", output = []) {
	if (typeof value === "string") {
		if (value.length > 0)
			output.push([privateLeafLabel(path), value]);
		return output;
	}
	if (Array.isArray(value)) {
		if (
			value.length > 0 &&
			value.every(
				(entry) =>
					typeof entry === "number" || typeof entry === "boolean",
			)
		) {
			output.push([privateLeafLabel(path), JSON.stringify(value)]);
			return output;
		}
		for (const [index, entry] of value.entries())
			collectPrivateLeaves(entry, `${path}[${index}]`, output);
		return output;
	}
	if (value && typeof value === "object") {
		for (const [key, entry] of Object.entries(value))
			collectPrivateLeaves(entry, path ? `${path}.${key}` : key, output);
	}
	return output;
}

function privateAliases(value) {
	const bytes = Buffer.from(value, "utf8");
	const hex = bytes.toString("hex");
	let percentEncoded;
	try {
		percentEncoded = encodeURIComponent(value);
	} catch {
		percentEncoded = value;
	}
	return new Set([
		value,
		percentEncoded,
		hex,
		hex.toUpperCase(),
		bytes.toString("base64"),
		bytes.toString("base64url"),
	]);
}

const MIN_PRIVATE_NEEDLE_BYTES = 8;

function decodedAudioNeedles(value) {
	if (typeof value !== "string")
		throw new Error("E_LOCAL_AUDIO_FIXTURE");
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value)
		throw new Error("E_LOCAL_AUDIO_FIXTURE");
	if (decoded.length < MIN_PRIVATE_NEEDLE_BYTES) return [];

	const hex = decoded.toString("hex");
	const canonicalBase64 = decoded.toString("base64");
	const canonicalBase64Url = canonicalBase64
		.replaceAll("+", "-")
		.replaceAll("/", "_");
	const candidates = [
		decoded,
		Buffer.from(hex, "utf8"),
		Buffer.from(hex.toUpperCase(), "utf8"),
		Buffer.from(canonicalBase64, "utf8"),
		Buffer.from(decoded.toString("base64url"), "utf8"),
		Buffer.from(canonicalBase64Url, "utf8"),
	];
	const seen = new Set();
	return candidates.filter((needle) => {
		const key = needle.toString("hex");
		if (needle.length < MIN_PRIVATE_NEEDLE_BYTES || seen.has(key))
			return false;
		seen.add(key);
		return true;
	});
}

const privateNeedles = decodedAudioNeedles(
	fixture.imported.bytesBase64,
).map((needle) => ["decoded audio bytes", needle]);
const seenNeedles = new Set(
	privateNeedles.map(([, needle]) => needle.toString("hex")),
);
for (const [label, value] of collectPrivateLeaves(fixture.imported)) {
	for (const alias of privateAliases(value)) {
		const needle = Buffer.from(alias, "utf8");
		const key = needle.toString("hex");
		if (needle.length === 0 || seenNeedles.has(key)) continue;
		seenNeedles.add(key);
		privateNeedles.push([label, needle]);
	}
}
const checkedFiles = [];
for (const releaseRoot of releaseRoots) {
	const inventory = await inventoryTree(
		releaseRoot,
		releaseInventoryLimits,
	);
	if (!inventory.ok) {
		for (const entry of inventory.issues)
			failures.push(
				`unsafe release tree ${releaseRoot.slice(root.length + 1)}${entry.path}: ${entry.ruleId}`,
			);
		continue;
	}
	const noncanonical = inventory.entries.find(
		(entry) => entry.relativePath !== entry.relativePath.normalize("NFC"),
	);
	if (noncanonical !== undefined) {
		failures.push(
			`noncanonical release path ${relative(root, noncanonical.absolutePath).split(sep).join("/")}`,
		);
		continue;
	}
	for (const entry of inventory.entries) {
		const releasePath = relative(root, entry.absolutePath)
			.split(sep)
			.join("/");
		const pathBytes = Buffer.from(releasePath, "utf8");
		for (const [label, needle] of privateNeedles) {
			if (needle.length > 0 && pathBytes.includes(needle))
				failures.push(`${label} leaked into ${releasePath}`);
		}
		if (entry.kind !== "file" || !entry.contained) continue;
		let bytes;
		try {
			bytes = await readInventoriedFile(entry);
		} catch {
			failures.push(`release file changed during scan: ${releasePath}`);
			continue;
		}
		checkedFiles.push(releasePath);
		for (const [label, needle] of privateNeedles) {
			if (needle.length > 0 && bytes.includes(needle))
				failures.push(`${label} leaked into ${releasePath}`);
		}
	}
}

if (failures.length > 0) {
	for (const failure of failures) console.error(failure);
	process.exitCode = 1;
} else {
	console.log(
		`Local-audio boundary verified: ${fixtureSummary.safeFlows} safe flows, ${fixtureSummary.blockedFlows} blocked egress flows, ${fixtureSummary.malformedSets} malformed emission sets rejected, ${checkedFiles.length} release files free of private bytes and identifiers.`,
	);
}
