import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import {
	CONFIG_SHA256,
	contentDigest,
	inspectStarterPackages,
} from "./lib/asset-pipeline.mjs";
import { validateBrandMetadata } from "./lib/policy.mjs";
import {
	containsProhibitedBrandTerm,
	normalizeBrandWords,
	PROHIBITED_BRAND_TERMS,
} from "./lib/brand-terms.mjs";
import {
	inventoryTree,
	readInventoriedFile,
} from "./lib/tree-inventory.mjs";

const root = process.cwd();
const frozenPolicySha256 =
	"aaa30f81fc6c5c4784cbbc1ef79ea723a38a503c67feb69541b1378ec5117630";
const packageDirectories = [
	"starter-level",
	"starter-objects",
	"starter-character",
	"starter-campaign",
	"starter-music",
];
const frozenReviewFileNames = [
	"original-content-review.json",
	"original-content-review.md",
];
const brandReviewInventoryLimits = Object.freeze({
	maxEntries: 2,
	maxFiles: 2,
	maxDepth: 1,
	maxFileBytes: 4_096,
	maxTotalBytes: 5_120,
});
const referenceRenderInventoryLimits = Object.freeze({
	maxEntries: 4,
	maxFiles: 4,
	maxDepth: 1,
	maxFileBytes: 16_384,
	maxTotalBytes: 65_536,
});
const referenceRenderPathPrefix = "docs/assets/reference-renders/";
const sha256Pattern = /^[0-9a-f]{64}$/u;
const referenceRenderRootKeys = [
	"captureConfigSha256",
	"contentSha256",
	"kind",
	"pipelineConfigSha256",
	"renderer",
	"renders",
	"reviewedOn",
	"schemaVersion",
];
const referenceRenderKeys = [
	"animationClips",
	"bindings",
	"bytes",
	"caption",
	"changedPixelRatio",
	"changedPixels",
	"credit",
	"height",
	"kind",
	"meshes",
	"path",
	"pngSha256",
	"representativeReuseOf",
	"renderBindingSha256",
	"renderId",
	"verifiedAssetUrl",
	"width",
];
const referenceRenderBindingKeys = [
	"assetBytes",
	"assetId",
	"assetPath",
	"assetRole",
	"assetSha256",
	"manifestPath",
	"manifestSha256",
	"mime",
	"packageDirectory",
	"packageName",
	"packageVersion",
];
const tradeDressVocabulary = [
	"same prince",
	"rainbow cosmos",
	"logo lettering",
	"exact visual style",
	"king of all cosmos",
];
const frozenReview = {
	schemaVersion: 1,
	productName: "Infinite Snowball",
	tagline: "Roll a tiny snowball into a joyful winter world.",
	description:
		"An original open-source rolling collection game built for the web.",
	claims: ["Open source", "Offline-capable prototype"],
	reviewedOn: "2026-07-15",
	reviewedBy: "P03 original-content review",
	contentSha256:
		"aedd06a9c18bf50737ff0968708a17a7166dbb75eb6344c097db87df43ec9a28",
	renderIndexSha256:
		"474d8bb1f0b3043b05d319dd3985b6a0b0261795ae57814b4d1b78ece0eab613",
	prohibitedVocabulary: {
		franchise: PROHIBITED_BRAND_TERMS,
		tradeDress: tradeDressVocabulary,
	},
	prohibited: {
		affiliationClaims: true,
		franchiseNamesInMarketing: true,
		copiedCharactersLogosAndTradeDress: true,
		unverifiedRatingsReviewsAndStoreBadges: true,
		commercialSoundtrackPackaging: true,
	},
};
const remediationByRule = {
	E_BRAND_AFFILIATION:
		"Do not imply affiliation, endorsement, authorization, or official status.",
	E_BRAND_BINARY:
		"Fully inspect every declared or shipped GLB before completing brand review.",
	E_BRAND_DIRECT_COMPARISON:
		"Describe original mechanics directly instead of franchise-comparison marketing.",
	E_BRAND_FAKE_RATING:
		"Remove unverified ratings, reviews, user counts, awards, and testimonials.",
	E_BRAND_FRANCHISE:
		"Remove every frozen franchise term from runtime manifest keys and values.",
	E_BRAND_MANIFEST:
		"Provide a readable JSON manifest for every required starter package.",
	E_BRAND_NAME:
		"Keep the original Infinite Snowball product and starter-package identity.",
	E_BRAND_REVIEW:
		"Restore the exact frozen original-content review schema and values.",
	E_BRAND_STORE_BADGE:
		"Remove store badges and listing claims until an approved live listing exists.",
	E_BRAND_TRADE_DRESS:
		"Use original characters, logos, typography, interface, world, and visual language.",
	E_SOUNDTRACK_PROHIBITED:
		"Do not suggest, import, stream, package, or redistribute a commercial soundtrack.",
};
const affiliationClaim =
	/\b(?:official|endorsed|authorized|successor|sequel|remake|port|affiliated|affiliation|endorsement)\b|\b(?:sponsored|approved)\s+by\b|\blicensed\b[\s\S]{0,80}\bkatamari\b|\bkatamari\b[\s\S]{0,80}\blicensed\b/iu;
const copiedTradeDressClaim =
	/\b(?:copy|copies|copied|duplicate|imitate|imitates|recreate|recreates)\b[\s\S]{0,100}\b(?:character(?:\s+design)?s?|logo(?:\s+(?:treatment|lettering))?|lettering|typography|ui|interface|world\s+fiction|story|art(?:work)?|sounds?|music|trade[\s-]+dress|visual\s+(?:style|language))\b/iu;
const directComparisonClaim =
	/\bbetter\s+than\b[\s\S]{0,80}\bkatamari\b|\bexactly\s+like\s+the\s+original\b|\bclone\s+of\b[\s\S]{0,80}\bkatamari\b/iu;
const fakeRatingClaim =
	/\brated\s+\d(?:\.\d+)?\b|\bkatamari\b[\s\S]{0,80}\b\d(?:\.\d+)?\s*stars?\b|\b\d(?:\.\d+)?\s*stars?\b[\s\S]{0,80}\bkatamari\b|\bfive[\s-]+star\b|\b\d[\d,]*\s+(?:ratings?|reviews?|users?|players?|downloads?|installs?)\b|\b(?:rave|glowing)\s+reviews?\b|\bmillions?\s+of\s+(?:users?|players?|downloads?|reviews?)\b|\bcritics?\s+(?:score|rate)(?:s|d)?\b[\s\S]{0,40}\b\d(?:\.\d+)?\s*\/\s*(?:5|10|100)\b|[★⭐]{3,5}|\baward[\s-]+winning\b|\bwinner\s+of\s+\d+\s+awards?\b|\b(?:one|two|three|four|five|six|seven|eight|nine|\d+)\s+(?:million|billion)\s+(?:users?|players?|downloads?|reviews?)\b|\bmajor\s+magazine\b/iu;
const storeClaim =
	/\bdownload\s+on\s+the\s+app\s+store\b|\bget\s+it\s+on\s+google\s+play\b|\b(?:available|listed|published)\s+(?:now\s+)?on\s+(?:the\s+)?(?:app\s+store|google\s+play|play\s+store)\b|\bapp\s+store\s+(?:badge|listing)\b|\b(?:google\s+play|play\s+store)\s+(?:badge|listing)\b/iu;
const prohibitedSoundtrack =
	/\bkatamari\b[\s\S]{0,100}\b(?:soundtrack|music)\b|\b(?:soundtrack|music)\b[\s\S]{0,100}\bkatamari\b/iu;
const jsonStringToken =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: JSON string grammar forbids this exact control-code range.
	/"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\\u0000-\u001F])*"/gu;
const fakeClaimKeys = new Set([
	"award",
	"awards",
	"averagerating",
	"downloadcount",
	"installcount",
	"playercount",
	"rating",
	"ratings",
	"review",
	"reviewcount",
	"reviews",
	"starrating",
	"stars",
	"testimonial",
	"testimonials",
	"usercount",
]);
const storeClaimKeys = new Set([
	"appstore",
	"appstorebadge",
	"appstorelisting",
	"googleplay",
	"googleplaybadge",
	"googleplaylisting",
	"playstore",
	"playstorebadge",
	"playstorelisting",
]);

function issue(ruleId, path) {
	return {
		ruleId,
		path,
		remediation:
			remediationByRule[ruleId] ?? "Remove prohibited runtime brand copy.",
	};
}


const tradeDressMatchers = tradeDressVocabulary.map((term) => {
	const words = normalizeBrandWords(term);
	return { compact: words.replaceAll(" ", ""), words };
});

function matchesVocabulary(words, matchers) {
	const compact = words.replaceAll(" ", "");
	return matchers.some(
		(matcher) =>
			words.includes(matcher.words) || compact.includes(matcher.compact),
	);
}

function classifyBrandText(text) {
	if (typeof text !== "string") return [];
	const normalizedText = normalizeBrandWords(text);
	const searchableText = `${text}\n${normalizedText}`;
	const ruleIds = [];
	if (containsProhibitedBrandTerm(text)) ruleIds.push("E_BRAND_FRANCHISE");
	if (
		matchesVocabulary(normalizedText, tradeDressMatchers) ||
		copiedTradeDressClaim.test(searchableText)
	)
		ruleIds.push("E_BRAND_TRADE_DRESS");
	if (affiliationClaim.test(searchableText))
		ruleIds.push("E_BRAND_AFFILIATION");
	if (directComparisonClaim.test(searchableText))
		ruleIds.push("E_BRAND_DIRECT_COMPARISON");
	if (fakeRatingClaim.test(searchableText))
		ruleIds.push("E_BRAND_FAKE_RATING");
	if (storeClaim.test(searchableText)) ruleIds.push("E_BRAND_STORE_BADGE");
	if (prohibitedSoundtrack.test(searchableText))
		ruleIds.push("E_SOUNDTRACK_PROHIBITED");
	return ruleIds;
}

function collectSegments(value, path = "", output = []) {
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries())
			collectSegments(entry, `${path}/${index}`, output);
	} else if (value && typeof value === "object") {
		for (const [name, entry] of Object.entries(value)) {
			const escapedName = name.replaceAll("~", "~0").replaceAll("/", "~1");
			const entryPath = `${path}/${escapedName}`;
			output.push({ kind: "key", path: entryPath, text: name });
			collectSegments(entry, entryPath, output);
		}
	} else if (value !== null && value !== undefined) {
		output.push({ kind: "value", path: path || "/", text: String(value) });
	}
	return output;
}

function collectRawStringSegments(raw) {
	const output = [];
	for (const match of raw.matchAll(jsonStringToken)) {
		output.push({
			kind: "raw",
			path: `/raw/${output.length}`,
			text: JSON.parse(match[0]),
		});
	}
	return output;
}

function compareFrozen(actual, expected, path, issues) {
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual)) {
			issues.push(issue("E_BRAND_REVIEW", path || "/"));
			return;
		}
		if (actual.length !== expected.length)
			issues.push(issue("E_BRAND_REVIEW", path || "/"));
		for (
			let index = 0;
			index < Math.min(actual.length, expected.length);
			index++
		)
			compareFrozen(actual[index], expected[index], `${path}/${index}`, issues);
		return;
	}
	if (expected && typeof expected === "object") {
		if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
			issues.push(issue("E_BRAND_REVIEW", path || "/"));
			return;
		}
		const actualKeys = Object.keys(actual);
		const expectedKeys = Object.keys(expected);
		for (const name of expectedKeys) {
			const escapedName = name.replaceAll("~", "~0").replaceAll("/", "~1");
			const entryPath = `${path}/${escapedName}`;
			if (!Object.hasOwn(actual, name))
				issues.push(issue("E_BRAND_REVIEW", entryPath));
			else compareFrozen(actual[name], expected[name], entryPath, issues);
		}
		for (const name of actualKeys) {
			if (!Object.hasOwn(expected, name)) {
				const escapedName = name.replaceAll("~", "~0").replaceAll("/", "~1");
				issues.push(issue("E_BRAND_REVIEW", `${path}/${escapedName}`));
			}
		}
		return;
	}
	if (actual !== expected) issues.push(issue("E_BRAND_REVIEW", path || "/"));
}

function validateRuntimeManifest(manifest, raw, directory) {
	const issues = [];
	const seen = new Set();
	const report = (ruleId, path) => {
		if (seen.has(ruleId)) return;
		seen.add(ruleId);
		issues.push(issue(ruleId, path));
	};
	const segments = [
		{
			kind: "path",
			path: "/",
			text: `content/${directory}/manifest.json`,
		},
		...collectSegments(manifest),
		...collectRawStringSegments(raw),
	];

	if (manifest?.name !== `@infinite-snowball/${directory}`)
		report("E_BRAND_NAME", "/name");

	for (const segment of segments) {
		for (const ruleId of classifyBrandText(segment.text))
			report(ruleId, segment.path);
		if (segment.kind === "key") {
			const normalizedText = normalizeBrandWords(segment.text);
			const compactKey = normalizedText.replaceAll(" ", "");
			const keyWords = normalizedText.split(" ");
			if (
				fakeClaimKeys.has(compactKey) ||
				keyWords.some((word) => fakeClaimKeys.has(word))
			)
				report("E_BRAND_FAKE_RATING", segment.path);
			if (storeClaimKeys.has(compactKey))
				report("E_BRAND_STORE_BADGE", segment.path);
		}
	}

	for (const policyIssue of validateBrandMetadata(manifest).issues) {
		if (seen.has(policyIssue.ruleId)) continue;
		seen.add(policyIssue.ruleId);
		issues.push(policyIssue);
	}
	return issues;
}

function validateInspectedGlbText(manifests, inspection) {
	const issues = [];
	const reportedBinaryPaths = new Set();
	const reportedTextIssues = new Set();
	const reportText = (ruleId, path) => {
		const key = `${ruleId}\0${path}`;
		if (reportedTextIssues.has(key)) return;
		reportedTextIssues.add(key);
		issues.push(issue(ruleId, path));
	};
	const reportBinary = (path) => {
		if (reportedBinaryPaths.has(path)) return;
		reportedBinaryPaths.add(path);
		issues.push(issue("E_BRAND_BINARY", path));
	};
	const packagesByName = new Map(
		inspection.packages.map((entry) => [entry.packageName, entry]),
	);
	for (const [directory, manifest] of manifests) {
		const packageInspection = packagesByName.get(directory);
		const localAssetMetrics =
			packageInspection?.budgetInspection.localAssetMetrics;
		for (const asset of Array.isArray(manifest.assets) ? manifest.assets : []) {
			if (
				typeof asset?.path !== "string" ||
				!asset.path.toLowerCase().endsWith(".glb")
			) {
				continue;
			}
			const path = `/${directory}/${asset.path}`;
			const textValues = localAssetMetrics?.[asset.path]?.textValues;
			if (!Array.isArray(textValues)) {
				reportBinary(path);
				continue;
			}
			for (const value of textValues) {
				for (const ruleId of classifyBrandText(value)) reportText(ruleId, path);
			}
		}
	}
	for (const inspectionIssue of inspection.issues) {
		if (
			inspectionIssue.ruleId === "E_ASSET_ORPHAN" &&
			typeof inspectionIssue.path === "string" &&
			inspectionIssue.path.toLowerCase().endsWith(".glb")
		) {
			reportBinary(inspectionIssue.path);
		}
	}
	return issues;
}

async function readFrozenReviewFiles() {
	const reviewRoot = join(root, "docs", "brand");
	const [inventory, rootRealpath] = await Promise.all([
		inventoryTree(reviewRoot, brandReviewInventoryLimits),
		realpath(root),
	]);
	if (
		!inventory.ok ||
		inventory.rootRealpath !== join(rootRealpath, "docs", "brand") ||
		inventory.entries.length !== frozenReviewFileNames.length
	) {
		throw new Error("E_BRAND_REVIEW: frozen review inventory changed");
	}
	const entriesByPath = new Map(
		inventory.entries.map((entry) => [entry.relativePath, entry]),
	);
	const entries = frozenReviewFileNames.map((name) => entriesByPath.get(name));
	if (
		entries.some(
			(entry) =>
				entry?.kind !== "file" ||
				entry.contained !== true ||
				typeof entry.realpath !== "string",
		)
	) {
		throw new Error("E_BRAND_REVIEW: frozen review files are not contained");
	}
	const [reviewBytes, policyBytes] = await Promise.all(
		entries.map((entry) => readInventoriedFile(entry)),
	);
	return { policyBytes, reviewBytes };
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
	if (!isRecord(value)) return false;
	const actualKeys = Object.keys(value).sort();
	const sortedExpectedKeys = [...expectedKeys].sort();
	return JSON.stringify(actualKeys) === JSON.stringify(sortedExpectedKeys);
}

function requireReviewedArtifact(condition) {
	if (!condition)
		throw new Error("E_BRAND_REVIEW: reviewed artifact is invalid");
}

function validateReferenceRenderSchema(metadata) {
	requireReviewedArtifact(hasExactKeys(metadata, referenceRenderRootKeys));
	requireReviewedArtifact(
		metadata.schemaVersion === 1 &&
			metadata.kind === "p03-reference-renders" &&
			typeof metadata.reviewedOn === "string" &&
			sha256Pattern.test(metadata.contentSha256) &&
			sha256Pattern.test(metadata.pipelineConfigSha256) &&
			sha256Pattern.test(metadata.captureConfigSha256) &&
			isRecord(metadata.renderer) &&
			metadata.renderer.engine === "Three.js" &&
			metadata.renderer.loader === "GLTFLoader" &&
			Array.isArray(metadata.renderer.requestFailures) &&
			metadata.renderer.requestFailures.length === 0 &&
			isRecord(metadata.renderer.config) &&
			Array.isArray(metadata.renders) &&
			metadata.renders.length === 3,
	);

	const renderIds = new Set();
	const renderPaths = new Set();
	const renderKinds = [];
	for (const render of metadata.renders) {
		requireReviewedArtifact(
			hasExactKeys(render, referenceRenderKeys) &&
				typeof render.renderId === "string" &&
				/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(render.renderId) &&
				typeof render.kind === "string" &&
				typeof render.path === "string" &&
				render.path ===
					`${referenceRenderPathPrefix}${render.renderId}.png` &&
				sha256Pattern.test(render.pngSha256) &&
				Number.isSafeInteger(render.bytes) &&
				render.bytes > 0 &&
				Number.isSafeInteger(render.width) &&
				render.width > 0 &&
				Number.isSafeInteger(render.height) &&
				render.height > 0 &&
				Number.isSafeInteger(render.changedPixels) &&
				render.changedPixels >= 64 &&
				typeof render.changedPixelRatio === "number" &&
				Number.isFinite(render.changedPixelRatio) &&
				Number.isSafeInteger(render.meshes) &&
				render.meshes > 0 &&
				Array.isArray(render.animationClips) &&
				render.animationClips.every((entry) => typeof entry === "string") &&
				typeof render.caption === "string" &&
				render.caption.length > 0 &&
				typeof render.credit === "string" &&
				render.credit.length > 0 &&
				sha256Pattern.test(render.renderBindingSha256) &&
				Array.isArray(render.bindings) &&
				(render.representativeReuseOf === null ||
					(typeof render.representativeReuseOf === "string" &&
						render.representativeReuseOf.length > 0)) &&
				typeof render.verifiedAssetUrl === "string" &&
				/^\/verified-assets\/[0-9a-f]{64}\.glb$/u.test(
					render.verifiedAssetUrl,
				) &&
				render.bindings.length > 0 &&
				!renderIds.has(render.renderId) &&
				!renderPaths.has(render.path),
		);
		renderIds.add(render.renderId);
		renderPaths.add(render.path);
		renderKinds.push(render.kind);

		for (const binding of render.bindings) {
			requireReviewedArtifact(
				hasExactKeys(binding, referenceRenderBindingKeys) &&
					typeof binding.packageDirectory === "string" &&
					binding.packageDirectory.startsWith("content/") &&
					packageDirectories.includes(
						binding.packageDirectory.slice("content/".length),
					) &&
					binding.packageName ===
						`@infinite-snowball/${binding.packageDirectory.slice(
							"content/".length,
						)}` &&
					typeof binding.packageVersion === "string" &&
					binding.manifestPath ===
						`${binding.packageDirectory}/manifest.json` &&
					sha256Pattern.test(binding.manifestSha256) &&
					typeof binding.assetId === "string" &&
					binding.assetId.length > 0 &&
					typeof binding.assetPath === "string" &&
					binding.assetPath.startsWith(`${binding.packageDirectory}/assets/`) &&
					typeof binding.assetRole === "string" &&
					binding.assetRole.length > 0 &&
					Number.isSafeInteger(binding.assetBytes) &&
					binding.assetBytes > 0 &&
					sha256Pattern.test(binding.assetSha256) &&
					typeof binding.mime === "string" &&
					binding.mime.length > 0,
			);
		}
		const expectedBindingSha256 = createHash("sha256")
			.update(
				JSON.stringify({
					renderId: render.renderId,
					representativeReuseOf: render.representativeReuseOf,
					verifiedAssetUrl: render.verifiedAssetUrl,
					contentSha256: metadata.contentSha256,
					pipelineConfigSha256: metadata.pipelineConfigSha256,
					captureConfigSha256: metadata.captureConfigSha256,
					bindings: render.bindings,
				}),
			)
			.digest("hex");
		requireReviewedArtifact(
			render.renderBindingSha256 === expectedBindingSha256,
		);
	}
	requireReviewedArtifact(
		JSON.stringify(renderKinds.sort()) ===
			JSON.stringify(["character", "level-scene", "object"]),
	);
	return metadata.renders;
}

async function readReferenceRenderIndex() {
	const referenceRoot = join(root, "docs", "assets", "reference-renders");
	const [inventory, rootRealpath] = await Promise.all([
		inventoryTree(referenceRoot, referenceRenderInventoryLimits),
		realpath(root),
	]);
	requireReviewedArtifact(
		inventory.ok &&
			inventory.rootRealpath ===
				join(rootRealpath, "docs", "assets", "reference-renders"),
	);
	const entriesByPath = new Map(
		inventory.entries.map((entry) => [entry.relativePath, entry]),
	);
	const indexEntry = entriesByPath.get("index.json");
	requireReviewedArtifact(
		indexEntry?.kind === "file" &&
			indexEntry.contained === true &&
			typeof indexEntry.realpath === "string",
	);
	const indexBytes = await readInventoriedFile(indexEntry);
	const metadata = JSON.parse(indexBytes.toString("utf8"));
	requireReviewedArtifact(
		indexBytes.equals(
			Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
		),
	);
	const renders = validateReferenceRenderSchema(metadata);
	const renderFileNames = renders.map((render) =>
		render.path.slice(referenceRenderPathPrefix.length),
	);
	const expectedFileNames = ["index.json", ...renderFileNames].sort();
	requireReviewedArtifact(
		JSON.stringify(inventory.entries.map((entry) => entry.relativePath).sort()) ===
			JSON.stringify(expectedFileNames),
	);
	const renderEntries = renderFileNames.map((name) => entriesByPath.get(name));
	requireReviewedArtifact(
		renderEntries.every(
			(entry) =>
				entry?.kind === "file" &&
				entry.contained === true &&
				typeof entry.realpath === "string",
		),
	);
	const renderBytes = await Promise.all(
		renderEntries.map((entry) => readInventoriedFile(entry)),
	);
	for (const [index, bytes] of renderBytes.entries()) {
		requireReviewedArtifact(
			bytes.length === renders[index].bytes &&
				createHash("sha256").update(bytes).digest("hex") ===
					renders[index].pngSha256,
		);
	}
	return { indexBytes, metadata };
}

const issues = [];
let assetInspection = { ok: false, issues: [], packages: [] };
try {
	assetInspection = await inspectStarterPackages({ root });
} catch {
	// The standalone brand gate reports the fail-closed package state below.
}

let reviewedArtifacts;
try {
	const [reviewFiles, currentContentSha256, referenceRenderIndex] =
		await Promise.all([
			readFrozenReviewFiles(),
			contentDigest({ root }),
			readReferenceRenderIndex(),
		]);
	reviewedArtifacts = {
		currentContentSha256,
		referenceRenderIndex,
		reviewFiles,
	};
} catch {
	issues.push(issue("E_BRAND_REVIEW", "/"));
}
if (reviewedArtifacts !== undefined) {
	try {
		const reviewBytes = reviewedArtifacts.reviewFiles.reviewBytes;
		if (
			!reviewBytes.equals(
				Buffer.from(`${JSON.stringify(frozenReview, null, "\t")}\n`, "utf8"),
			)
		) {
			throw new Error("E_BRAND_REVIEW: review JSON is not canonical");
		}
		const review = JSON.parse(reviewBytes.toString("utf8"));
		compareFrozen(review, frozenReview, "", issues);
		const renderIndexSha256 = createHash("sha256")
			.update(reviewedArtifacts.referenceRenderIndex.indexBytes)
			.digest("hex");
		if (review.contentSha256 !== reviewedArtifacts.currentContentSha256)
			issues.push(issue("E_BRAND_REVIEW", "/contentSha256"));
		if (review.renderIndexSha256 !== renderIndexSha256)
			issues.push(issue("E_BRAND_REVIEW", "/renderIndexSha256"));
		if (
			reviewedArtifacts.referenceRenderIndex.metadata.contentSha256 !==
				reviewedArtifacts.currentContentSha256 ||
			reviewedArtifacts.referenceRenderIndex.metadata.pipelineConfigSha256 !==
				CONFIG_SHA256 ||
			reviewedArtifacts.referenceRenderIndex.metadata.reviewedOn !==
				review.reviewedOn
		) {
			issues.push(
				issue(
					"E_BRAND_REVIEW",
					"/docs/assets/reference-renders/index.json",
				),
			);
		}
	} catch {
		issues.push(issue("E_BRAND_REVIEW", "/"));
	}
	const policySha256 = createHash("sha256")
		.update(reviewedArtifacts.reviewFiles.policyBytes)
		.digest("hex");
	if (policySha256 !== frozenPolicySha256)
		issues.push(issue("E_BRAND_REVIEW", "/original-content-review.md"));
}

const runtimeManifests = new Map();
const packagesByName = new Map(
	assetInspection.packages.map((entry) => [entry.packageName, entry]),
);
for (const directory of packageDirectories) {
	const packageInspection = packagesByName.get(directory);
	if (packageInspection === undefined) {
		issues.push(issue("E_BRAND_MANIFEST", `/${directory}/manifest.json`));
		continue;
	}
	const raw = packageInspection.manifestBytes.toString("utf8");
	const manifest = packageInspection.manifest;
	runtimeManifests.set(directory, manifest);
	for (const manifestIssue of validateRuntimeManifest(
		manifest,
		raw,
		directory,
	)) {
		issues.push({
			...manifestIssue,
			path: `/${directory}${manifestIssue.path === "/" ? "" : manifestIssue.path}`,
		});
	}
}

issues.push(...validateInspectedGlbText(runtimeManifests, assetInspection));
if (!assetInspection.ok)
	issues.push(issue("E_BRAND_BINARY", "/assets"));

if (issues.length > 0) {
	for (const entry of issues)
		console.error(`${entry.ruleId} ${entry.path}: ${entry.remediation}`);
	process.exitCode = 1;
} else {
	console.log(
		`Original-brand review verified across ${packageDirectories.length} starter manifests.`,
	);
}
