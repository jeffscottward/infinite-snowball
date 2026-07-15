import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	appendFile,
	copyFile,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
	buildDeterministicPackageArtifact,
	contentDigest,
	inspectGlb,
} from "../../tools/assets/lib/asset-pipeline.mjs";
import { containsProhibitedBrandTerm } from "../../tools/assets/lib/brand-terms.mjs";
import {
	inventoryTree,
	readInventoriedFile,
} from "../../tools/assets/lib/tree-inventory.mjs";

const ROOT = process.cwd();
const CHECKER = join(ROOT, "tools", "assets", "brand-check.mjs");
const PACKAGE_DIRECTORIES = [
	"starter-level",
	"starter-objects",
	"starter-character",
	"starter-campaign",
	"starter-music",
] as const;
const CYRILLIC_A_CLAIM = "Kаtamari soundtrack";
const FULL_SCRIPT_PROHIBITED_TERMS = [
	"КАТАМАРІ",
	"КАТАМАРИ",
	"ΚΑΤΑΜΑΡΙ",
] as const;
const REVIEWED_LATIN_CONFUSABLES = [
	{ codePoint: "U+0251", value: "Kɑtamari" },
	{ codePoint: "U+1D00", value: "Kᴀtamari" },
	{ codePoint: "U+1D0B", value: "ᴋatamari" },
	{ codePoint: "U+1D1B", value: "Kaᴛamari" },
	{ codePoint: "U+1D0D", value: "Kataᴍari" },
	{ codePoint: "U+0280", value: "Katamaʀi" },
	{ codePoint: "U+026A", value: "Katamarɪ" },
	{ codePoint: "U+0131", value: "Katamarı" },
] as const;
const LEGAL_ORIGINALS = [
	"オリジナルの雪玉サウンドトラックです。",
	"Оригинальная музыка для снежного шара.",
	"Χειμωνιάτικη μουσική για χιονόμπαλα.",
	"Infinite Snowball — зимняя музыка.",
	"Original аurora soundtrack.",
] as const;
const GLB_RULE_CASES = [
	{
		name: "copied trade dress",
		value: "Copy the character design and logo treatment.",
		ruleId: "E_BRAND_TRADE_DRESS",
	},
	{
		name: "false affiliation",
		value: "Official endorsed successor.",
		ruleId: "E_BRAND_AFFILIATION",
	},
	{
		name: "direct comparison",
		value: "Exactly like the original.",
		ruleId: "E_BRAND_DIRECT_COMPARISON",
	},
	{
		name: "fake rating",
		value: "Rated 4.9 stars.",
		ruleId: "E_BRAND_FAKE_RATING",
	},
	{
		name: "store badge",
		value: "Download on the App Store.",
		ruleId: "E_BRAND_STORE_BADGE",
	},
	{
		name: "commercial soundtrack",
		value: "Recommend importing the commercial Katamari soundtrack.",
		ruleId: "E_SOUNDTRACK_PROHIBITED",
	},
] as const;
const LAWFUL_GLB_RULE_BOUNDARIES = [
	{
		name: "original visual design",
		value: "Create an original character design and visual style.",
		ruleId: "E_BRAND_TRADE_DRESS",
	},
	{
		name: "CC0 license",
		value: "Licensed under CC0-1.0.",
		ruleId: "E_BRAND_AFFILIATION",
	},
	{
		name: "mechanical comparison",
		value: "Compare snowball sizes during playtesting.",
		ruleId: "E_BRAND_DIRECT_COMPARISON",
	},
	{
		name: "gameplay stars",
		value: "Collect 5 stars to unlock the level.",
		ruleId: "E_BRAND_FAKE_RATING",
	},
	{
		name: "source archive",
		value: "Download the CC0 source archive.",
		ruleId: "E_BRAND_STORE_BADGE",
	},
	{
		name: "first-party soundtrack",
		value: "We composed an original soundtrack.",
		ruleId: "E_SOUNDTRACK_PROHIBITED",
	},
] as const;
const GENERIC_CLAIM_BOUNDARIES = [
	{
		name: "first-party soundtrack",
		lawful: "Use the Infinite Snowball soundtrack in this level.",
		branded: "Use the Katamari soundtrack in this level.",
		ruleId: "E_SOUNDTRACK_PROHIBITED",
	},
	{
		name: "asset license",
		lawful: "Licensed under CC0-1.0.",
		branded: "Licensed Katamari game.",
		ruleId: "E_BRAND_AFFILIATION",
	},
	{
		name: "gameplay stars",
		lawful: "Collect 5 stars to unlock the level.",
		branded: "Katamari earned 5 stars.",
		ruleId: "E_BRAND_FAKE_RATING",
	},
] as const;
const scratchRoots: string[] = [];

type JsonRecord = Record<string, unknown>;

type PackageReference = {
	name: string;
	version: string;
	kind: string;
	manifestSha256: string;
	integrity: string;
};

type GlbStringLocation = "extras" | "material" | "node";

function updatePackageReferences(
	value: unknown,
	references: ReadonlyMap<string, PackageReference>,
): void {
	if (Array.isArray(value)) {
		for (const entry of value) updatePackageReferences(entry, references);
		return;
	}
	if (value === null || typeof value !== "object") return;
	const object = value as JsonRecord;
	if (
		typeof object.name === "string" &&
		typeof object.manifestSha256 === "string" &&
		typeof object.integrity === "string"
	) {
		const replacement = references.get(object.name);
		if (replacement !== undefined) Object.assign(object, replacement);
	}
	for (const entry of Object.values(object))
		updatePackageReferences(entry, references);
}

async function rewritePackageArtifact(
	root: string,
	directory: string,
	references: ReadonlyMap<string, PackageReference>,
): Promise<PackageReference> {
	const packageRoot = join(root, "content", directory);
	const manifestPath = join(packageRoot, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	updatePackageReferences(manifest, references);
	const assetBytes = new Map<string, Buffer>(
		await Promise.all(
			(manifest.assets as Array<{ path: string }>).map(
				async (asset) =>
					[asset.path, await readFile(join(packageRoot, asset.path))] as const,
			),
		),
	);
	const artifact = buildDeterministicPackageArtifact(manifest, assetBytes);
	await writeFile(
		manifestPath,
		`${JSON.stringify(artifact.manifest, null, 2)}\n`,
		"utf8",
	);
	return {
		name: artifact.manifest.name,
		version: artifact.manifest.version,
		kind: artifact.manifest.kind,
		manifestSha256: artifact.manifestSha256,
		integrity: artifact.integrity,
	};
}

function withGlbString(
	input: Buffer,
	location: GlbStringLocation,
	value: string,
): Buffer {
	const jsonLength = input.readUInt32LE(12);
	const document = JSON.parse(
		input.subarray(20, 20 + jsonLength).toString("utf8"),
	) as JsonRecord;
	if (location === "extras") {
		document.extras = { originalBrandName: value };
	} else {
		const collection = document[
			location === "node" ? "nodes" : "materials"
		] as JsonRecord[];
		collection[0]!.name = value;
	}
	const json = Buffer.from(JSON.stringify(document), "utf8");
	const paddedJsonLength = (json.length + 3) & ~3;
	const trailingChunks = input.subarray(20 + jsonLength);
	const output = Buffer.alloc(20 + paddedJsonLength + trailingChunks.length, 0x20);
	input.copy(output, 0, 0, 12);
	output.writeUInt32LE(output.length, 8);
	output.writeUInt32LE(paddedJsonLength, 12);
	output.writeUInt32LE(0x4e4f534a, 16);
	json.copy(output, 20);
	trailingChunks.copy(output, 20 + paddedJsonLength);
	return output;
}

async function writeCharacterGlbBytes(
	root: string,
	bytes: Buffer,
): Promise<void> {
	const packageRoot = join(root, "content", "starter-character");
	const manifestPath = join(packageRoot, "manifest.json");
	const assetPath = "assets/pebble-friend.glb";
	await writeFile(join(packageRoot, assetPath), bytes);

	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as JsonRecord;
	const asset = (manifest.assets as JsonRecord[]).find(
		(candidate) => candidate.path === assetPath,
	);
	if (asset === undefined) throw new Error("character GLB asset is missing");
	const digest = createHash("sha256").update(bytes).digest("hex");
	asset.bytes = bytes.length;
	asset.sha256 = digest;
	(asset.provenance as JsonRecord).outputSha256 = digest;
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

	const references = new Map<string, PackageReference>();
	const character = await rewritePackageArtifact(
		root,
		"starter-character",
		references,
	);
	references.set(character.name, character);
	await rewritePackageArtifact(root, "starter-campaign", references);
}

async function writeCharacterGlbString(
	root: string,
	location: GlbStringLocation,
	value: string,
): Promise<void> {
	const filePath = join(
		root,
		"content",
		"starter-character",
		"assets",
		"pebble-friend.glb",
	);
	const bytes = withGlbString(await readFile(filePath), location, value);
	await writeCharacterGlbBytes(root, bytes);
}

async function makeScratchRoot(): Promise<string> {
	const scratch = await mkdtemp(join(tmpdir(), "infinite-snowball-confusable-"));
	scratchRoots.push(scratch);
	await mkdir(join(scratch, "docs", "brand"), { recursive: true });
	await copyFile(
		join(ROOT, "docs", "brand", "original-content-review.json"),
		join(scratch, "docs", "brand", "original-content-review.json"),
	);
	await copyFile(
		join(ROOT, "docs", "brand", "original-content-review.md"),
		join(scratch, "docs", "brand", "original-content-review.md"),
	);
	for (const directory of PACKAGE_DIRECTORIES) {
		await cp(
			join(ROOT, "content", directory),
			join(scratch, "content", directory),
			{ recursive: true },
		);
	}
	await cp(
		join(ROOT, "docs", "assets", "reference-renders"),
		join(scratch, "docs", "assets", "reference-renders"),
		{ recursive: true },
	);
	return scratch;
}

async function writeDescription(
	root: string,
	value: string,
	escapeCyrillicA = false,
): Promise<string> {
	const path = join(root, "content", "starter-level", "manifest.json");
	const manifest = JSON.parse(await readFile(path, "utf8")) as JsonRecord;
	const metadata = manifest.metadata as JsonRecord;
	metadata.translations = { en: { description: value } };
	let raw = `${JSON.stringify(manifest, null, 2)}\n`;
	if (escapeCyrillicA) {
		raw = raw.replace(CYRILLIC_A_CLAIM, "K\\u0430tamari soundtrack");
	}
	await writeFile(path, raw, "utf8");
	return raw;
}

function runBrandCheck(cwd: string): { output: string; status: number | null } {
	const result = spawnSync(process.execPath, [CHECKER], {
		cwd,
		encoding: "utf8",
		timeout: 5_000,
	});
	if (result.error) throw result.error;
	return {
		output: `${result.stdout}${result.stderr}`,
		status: result.status,
	};
}

afterEach(async () => {
	await Promise.all(
		scratchRoots
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});


describe("P03 prohibited-brand confusables", () => {
	it.each(REVIEWED_LATIN_CONFUSABLES)(
		"rejects reviewed Latin confusable $codePoint directly",
		({ value }) => {
			expect(containsProhibitedBrandTerm(value)).toBe(true);
		},
	);

	it.each(FULL_SCRIPT_PROHIBITED_TERMS)(
		"rejects the full-script prohibited term %s directly",
		(value) => {
			expect(containsProhibitedBrandTerm(value)).toBe(true);
		},
	);

	it.each(LEGAL_ORIGINALS)(
		"allows the unrelated original term %s directly",
		(value) => {
			expect(containsProhibitedBrandTerm(value)).toBe(false);
		},
	);

	it("preserves lawful whitespace boundaries around Look at a marina", async () => {
		const lawful = "Look at a marina";
		expect(containsProhibitedBrandTerm(lawful)).toBe(false);

		const manifestRoot = await makeScratchRoot();
		await writeDescription(manifestRoot, lawful);
		const manifestResult = runBrandCheck(manifestRoot);
		expect(manifestResult.status).not.toBeNull();
		expect(manifestResult.output).not.toContain("E_BRAND_FRANCHISE");

		const glbRoot = await makeScratchRoot();
		await writeCharacterGlbString(glbRoot, "node", lawful);
		const glbResult = runBrandCheck(glbRoot);
		expect(glbResult.status).not.toBeNull();
		expect(glbResult.output).not.toContain("E_BRAND_FRANCHISE");
	});

	it.each([
		"Katamari",
		"Kata Mari",
		"Kata-mari",
		"Kata\u200bmari",
	] as const)("rejects reviewed brand evasion %s", (value) => {
		expect(containsProhibitedBrandTerm(value)).toBe(true);
	});

	it.each([
		"Licensed by Bandai Namco Entertainment.",
		"Licensed by Namco.",
		"Please import this commercial soundtrack.",
		"Official soundtrack files must not be downloaded.",
		"Bundle the soundtrack only if it is copyrighted.",
		"Unlicensed soundtrack content must never be shipped.",
		"This commercial soundtrack must not be included.",
		"Never copy an official soundtrack.",
	] as const)("rejects contextual protected claim %s", (value) => {
		expect(containsProhibitedBrandTerm(value)).toBe(true);
	});

	it.each([
		"Licensed under CC0-1.0.",
		"We composed an original soundtrack.",
		"Collect 5 stars to unlock the level.",
		"Historical legal review of third-party licensing.",
		"Import the level package after review and verification by the release team; this official soundtrack is original.",
		"Look at a marina.",
	] as const)("allows lawful contextual prose %s", (value) => {
		expect(containsProhibitedBrandTerm(value)).toBe(false);
	});

	it.each(FULL_SCRIPT_PROHIBITED_TERMS)(
		"rejects the full-script prohibited term %s in a manifest",
		async (value) => {
			const root = await makeScratchRoot();
			await writeDescription(root, value);

			const result = runBrandCheck(root);
			expect(result.status, result.output).toBe(1);
			expect(result.output).toContain("E_BRAND_FRANCHISE");
		},
	);

	it.each(REVIEWED_LATIN_CONFUSABLES)(
		"rejects reviewed Latin confusable $codePoint in a manifest",
		async ({ value }) => {
			const root = await makeScratchRoot();
			await writeDescription(root, value);
			const result = runBrandCheck(root);
			expect(result.status, result.output).toBe(1);
			expect(result.output).toContain("E_BRAND_FRANCHISE");
		},
	);

	it("rejects a raw Cyrillic-a spelling of Katamari", async () => {
		const root = await makeScratchRoot();
		const raw = await writeDescription(root, CYRILLIC_A_CLAIM);
		expect(raw).toContain(CYRILLIC_A_CLAIM);
		expect(raw).not.toContain("\\u0430");

		const result = runBrandCheck(root);
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("E_BRAND_FRANCHISE");
	});

	it("rejects the JSON-escaped Cyrillic-a spelling of Katamari", async () => {
		const root = await makeScratchRoot();
		const raw = await writeDescription(root, CYRILLIC_A_CLAIM, true);
		expect(raw).toContain("K\\u0430tamari soundtrack");

		const result = runBrandCheck(root);
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("E_BRAND_FRANCHISE");
	});


	it.each(["node", "material", "extras"] as const)(
		"rejects prohibited GLB %s strings after bounded inspection",
		async (location) => {
			const root = await makeScratchRoot();
			await writeCharacterGlbString(root, location, CYRILLIC_A_CLAIM);

			const result = runBrandCheck(root);
			expect(result.status, result.output).toBe(1);
			expect(result.output).toContain("E_BRAND_FRANCHISE");
			expect(result.output).toContain(
				"/starter-character/assets/pebble-friend.glb",
			);
		},
	);

	it.each(REVIEWED_LATIN_CONFUSABLES)(
		"rejects reviewed Latin confusable $codePoint in inspected GLB text",
		async ({ value }) => {
			const root = await makeScratchRoot();
			await writeCharacterGlbString(root, "node", value);
			const result = runBrandCheck(root);
			expect(result.status, result.output).toBe(1);
			expect(result.output).toContain("E_BRAND_FRANCHISE");
			expect(result.output).toContain(
				"/starter-character/assets/pebble-friend.glb",
			);
		},
	);

	it.each(GLB_RULE_CASES)(
		"rejects manifest-equivalent $name claims in inspected GLB text",
		async ({ value, ruleId }) => {
			const root = await makeScratchRoot();
			await writeCharacterGlbString(root, "extras", value);

			const result = runBrandCheck(root);
			expect(result.status, result.output).toBe(1);
			expect(result.output).toContain(
				`${ruleId} /starter-character/assets/pebble-friend.glb`,
			);
		},
	);

	it.each(LAWFUL_GLB_RULE_BOUNDARIES)(
		"does not classify lawful $name prose in inspected GLB text",
		async ({ value, ruleId }) => {
			const root = await makeScratchRoot();
			await writeCharacterGlbString(root, "extras", value);

			const result = runBrandCheck(root);
			expect(result.status, result.output).toBe(1);
			expect(result.output).toContain("E_BRAND_REVIEW");
			expect(result.output).not.toContain(
				`${ruleId} /starter-character/assets/pebble-friend.glb`,
			);
		},
	);

	it("fails closed when a declared GLB is missing", async () => {
		const root = await makeScratchRoot();
		await rm(
			join(
				root,
				"content",
				"starter-character",
				"assets",
				"pebble-friend.glb",
			),
		);

		const result = runBrandCheck(root);
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("E_BRAND_BINARY");
		expect(result.output).toContain(
			"E_BRAND_MANIFEST /starter-character/manifest.json",
		);
	});

	it("fails closed when a declared GLB is invalid", async () => {
		const root = await makeScratchRoot();
		await writeCharacterGlbBytes(root, Buffer.from("not a glTF binary", "utf8"));

		const result = runBrandCheck(root);
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("E_BRAND_BINARY");
		expect(result.output).toContain(
			"/starter-character/assets/pebble-friend.glb",
		);
	});

	it("fails closed when a shipped GLB is not declared or inspected", async () => {
		const root = await makeScratchRoot();
		const assetsRoot = join(root, "content", "starter-character", "assets");
		await copyFile(
			join(assetsRoot, "pebble-friend.glb"),
			join(assetsRoot, "uninspected.glb"),
		);

		const result = runBrandCheck(root);
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("E_BRAND_BINARY");
		expect(result.output).toContain(
			"/starter-character/assets/uninspected.glb",
		);
	});

	it("fails closed when a GLB is shipped at the content root", async () => {
		const root = await makeScratchRoot();
		await copyFile(
			join(
				root,
				"content",
				"starter-character",
				"assets",
				"pebble-friend.glb",
			),
			join(root, "content", "rogue.glb"),
		);

		const result = runBrandCheck(root);
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("E_BRAND_BINARY /assets");
	});

	it("fails closed when an unknown package ships a GLB", async () => {
		const root = await makeScratchRoot();
		const unknownAssets = join(root, "content", "unknown-package", "assets");
		await mkdir(unknownAssets, { recursive: true });
		await copyFile(
			join(
				root,
				"content",
				"starter-character",
				"assets",
				"pebble-friend.glb",
			),
			join(unknownAssets, "rogue.glb"),
		);

		const result = runBrandCheck(root);
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("E_BRAND_BINARY /assets");
	});

	it.each(["node", "material", "extras"] as const)(
		"allows innocuous non-Latin GLB %s strings after bounded inspection",
		async (location) => {
			const original = await readFile(
				join(
					ROOT,
					"content",
					"starter-character",
					"assets",
					"pebble-friend.glb",
				),
			);
			const inspection = inspectGlb(
				withGlbString(original, location, "雪玉の友だち"),
			);

			expect(inspection.ok).toBe(true);
			expect(inspection.metrics.textValues).toContain("雪玉の友だち");
			expect(
				inspection.metrics.textValues?.some((value) =>
					containsProhibitedBrandTerm(value),
				),
			).toBe(false);
		},
	);

	it.each([
		"Licensed by Bandai Namco Entertainment.",
		"Download the commercial soundtrack for this game.",
	] as const)(
		"rejects contextual protected GLB text after bounded inspection: %s",
		async (value) => {
			const root = await makeScratchRoot();
			await writeCharacterGlbString(root, "node", value);

			const result = runBrandCheck(root);
			expect(result.status, result.output).toBe(1);
			expect(result.output).toContain("E_BRAND_FRANCHISE");
			expect(result.output).toContain(
				"/starter-character/assets/pebble-friend.glb",
			);
		},
	);

	it.each([
		"Licensed under CC0-1.0.",
		"We composed an original soundtrack.",
	] as const)(
		"does not classify lawful contextual GLB text: %s",
		async (value) => {
			const root = await makeScratchRoot();
			await writeCharacterGlbString(root, "node", value);

			const result = runBrandCheck(root);
			expect(result.status, result.output).toBe(1);
			expect(result.output).toContain("E_BRAND_REVIEW");
			expect(result.output).not.toContain("E_BRAND_FRANCHISE");
		},
	);

	it.each(GENERIC_CLAIM_BOUNDARIES)(
		"does not classify lawful $name prose when content integrity detects drift",
		async ({ lawful, ruleId }) => {
			const root = await makeScratchRoot();
			await writeDescription(root, lawful);

			const result = runBrandCheck(root);
			expect(result.status, result.output).toBe(1);
			expect(result.output).toContain("E_BRAND_REVIEW");
			expect(result.output).not.toContain(ruleId);
		},
	);

	it.each(GENERIC_CLAIM_BOUNDARIES)(
		"still rejects a distinctively branded $name claim",
		async ({ branded, ruleId }) => {
			const root = await makeScratchRoot();
			await writeDescription(root, branded);

			const result = runBrandCheck(root);
			expect(result.status, result.output).toBe(1);
			expect(result.output).toContain(ruleId);
			expect(result.output).toContain("E_BRAND_FRANCHISE");
		},
	);

});

describe("P03 reviewed artifact digests", () => {
	it("accepts the exact current content and canonical render-index digests", async () => {
		const review = JSON.parse(
			await readFile(
				join(ROOT, "docs", "brand", "original-content-review.json"),
				"utf8",
			),
		) as JsonRecord;
		const indexBytes = await readFile(
			join(ROOT, "docs", "assets", "reference-renders", "index.json"),
		);
		const index = JSON.parse(indexBytes.toString("utf8")) as JsonRecord;

		expect(review.contentSha256).toBe(await contentDigest({ root: ROOT }));
		expect(review.renderIndexSha256).toBe(
			createHash("sha256").update(indexBytes).digest("hex"),
		);
		expect(index.contentSha256).toBe(review.contentSha256);
		expect(indexBytes.toString("utf8")).toBe(
			`${JSON.stringify(index, null, 2)}\n`,
		);
		expect(runBrandCheck(ROOT).status).toBe(0);
	});

	it("rejects valid content drift after every package identity is refreshed", async () => {
		const root = await makeScratchRoot();
		await writeCharacterGlbString(
			root,
			"extras",
			"Original pebble friend geometry",
		);

		const result = runBrandCheck(root);
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("E_BRAND_REVIEW");
	});

	it("rejects canonical render-index drift while the review is unchanged", async () => {
		const root = await makeScratchRoot();
		const indexPath = join(
			root,
			"docs",
			"assets",
			"reference-renders",
			"index.json",
		);
		const index = JSON.parse(await readFile(indexPath, "utf8")) as JsonRecord;
		index.reviewedOn = "2026-07-16";
		await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

		const result = runBrandCheck(root);
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("E_BRAND_REVIEW");
	});

	it("fails closed when the reviewed render index is missing", async () => {
		const root = await makeScratchRoot();
		await rm(
			join(root, "docs", "assets", "reference-renders", "index.json"),
		);

		const result = runBrandCheck(root);
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("E_BRAND_REVIEW");
	});

	it("rejects a noncanonical reviewed render index", async () => {
		const root = await makeScratchRoot();
		const indexPath = join(
			root,
			"docs",
			"assets",
			"reference-renders",
			"index.json",
		);
		const index = JSON.parse(await readFile(indexPath, "utf8")) as JsonRecord;
		await writeFile(indexPath, JSON.stringify(index), "utf8");

		const result = runBrandCheck(root);
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("E_BRAND_REVIEW");
	});

	it("rejects a symlinked reference-render root without changing external files", async () => {
		const root = await makeScratchRoot();
		const externalRoot = await mkdtemp(
			join(tmpdir(), "infinite-snowball-render-external-"),
		);
		scratchRoots.push(externalRoot);
		const externalRenders = join(externalRoot, "reference-renders");
		const localRenders = join(root, "docs", "assets", "reference-renders");
		await cp(localRenders, externalRenders, { recursive: true });
		const externalIndex = join(externalRenders, "index.json");
		const sentinel = await readFile(externalIndex);
		await rm(localRenders, { recursive: true });
		await symlink(externalRenders, localRenders, "dir");

		const result = runBrandCheck(root);
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("E_BRAND_REVIEW");
		expect(await readFile(externalIndex)).toEqual(sentinel);
	});
});

describe("P03 bounded brand-review files", () => {
	it("rejects duplicate early reviewed digest keys before semantic comparison", async () => {
		const root = await makeScratchRoot();
		const reviewPath = join(
			root,
			"docs",
			"brand",
			"original-content-review.json",
		);
		const canonical = await readFile(reviewPath, "utf8");
		const compact = JSON.stringify(JSON.parse(canonical) as JsonRecord);
		const duplicate = compact.replace(
			"{",
			`{"contentSha256":"${"0".repeat(64)}","renderIndexSha256":"${"1".repeat(64)}",`,
		);
		const policyBytes = await readFile(
			join(root, "docs", "brand", "original-content-review.md"),
		);
		expect(duplicate).not.toBe(compact);
		expect(Buffer.byteLength(duplicate) + policyBytes.length).toBeLessThanOrEqual(
			5_120,
		);
		await writeFile(reviewPath, duplicate, "utf8");

		const result = runBrandCheck(root);
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("E_BRAND_REVIEW");
	});

	it("rejects reordered reviewed JSON even when values are unchanged", async () => {
		const root = await makeScratchRoot();
		const reviewPath = join(
			root,
			"docs",
			"brand",
			"original-content-review.json",
		);
		const review = JSON.parse(await readFile(reviewPath, "utf8")) as JsonRecord;
		const reordered = {
			renderIndexSha256: review.renderIndexSha256,
			...review,
		};
		await writeFile(
			reviewPath,
			`${JSON.stringify(reordered, null, "\t")}\n`,
			"utf8",
		);

		const result = runBrandCheck(root);
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("E_BRAND_REVIEW");
	});

	it("rejects semantically identical noncanonical reviewed JSON", async () => {
		const root = await makeScratchRoot();
		const reviewPath = join(
			root,
			"docs",
			"brand",
			"original-content-review.json",
		);
		const review = JSON.parse(await readFile(reviewPath, "utf8")) as JsonRecord;
		await writeFile(reviewPath, JSON.stringify(review), "utf8");

		const result = runBrandCheck(root);
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("E_BRAND_REVIEW");
	});

	it("rejects a symlinked docs/brand root without changing its external files", async () => {
		const root = await makeScratchRoot();
		const externalRoot = await mkdtemp(
			join(tmpdir(), "infinite-snowball-brand-external-"),
		);
		scratchRoots.push(externalRoot);
		const externalBrand = join(externalRoot, "brand");
		await cp(join(root, "docs", "brand"), externalBrand, { recursive: true });
		const externalReview = join(
			externalBrand,
			"original-content-review.json",
		);
		const sentinel = await readFile(externalReview);
		await rm(join(root, "docs", "brand"), { recursive: true });
		await symlink(externalBrand, join(root, "docs", "brand"), "dir");

		const result = runBrandCheck(root);
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("E_BRAND_REVIEW");
		expect(await readFile(externalReview)).toEqual(sentinel);
	});

	it("rejects a FIFO review entry without opening it or changing an external sentinel", async () => {
		const root = await makeScratchRoot();
		const externalRoot = await mkdtemp(
			join(tmpdir(), "infinite-snowball-brand-sentinel-"),
		);
		scratchRoots.push(externalRoot);
		const sentinelPath = join(externalRoot, "sentinel.txt");
		await writeFile(sentinelPath, "UNCHANGED", "utf8");
		const reviewPath = join(
			root,
			"docs",
			"brand",
			"original-content-review.md",
		);
		await rm(reviewPath);
		const fifo = spawnSync("mkfifo", [reviewPath], { encoding: "utf8" });
		expect(fifo.status, `${fifo.stdout}${fifo.stderr}`).toBe(0);

		const result = runBrandCheck(root);
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("E_BRAND_REVIEW");
		expect(await readFile(sentinelPath, "utf8")).toBe("UNCHANGED");
	});

	it("rejects same-inode review growth with an external sentinel untouched", async () => {
		const root = await makeScratchRoot();
		const reviewRoot = join(root, "docs", "brand");
		const inventory = await inventoryTree(reviewRoot, {
			maxEntries: 2,
			maxFiles: 2,
			maxDepth: 1,
			maxFileBytes: 4_096,
			maxTotalBytes: 5_120,
		});
		const reviewEntry = inventory.entries.find(
			(entry) => entry.relativePath === "original-content-review.json",
		);
		const externalRoot = await mkdtemp(
			join(tmpdir(), "infinite-snowball-brand-growth-"),
		);
		scratchRoots.push(externalRoot);
		const sentinelPath = join(externalRoot, "sentinel.txt");
		await writeFile(sentinelPath, "UNCHANGED", "utf8");

		await expect(
			readInventoriedFile(reviewEntry, {
				afterIdentityCheck: () =>
					appendFile(reviewEntry!.absolutePath, " ", "utf8"),
			}),
		).rejects.toThrow("E_PATH_POLICY");
		expect(await readFile(sentinelPath, "utf8")).toBe("UNCHANGED");
	});

	it("rejects any third file in the frozen docs/brand inventory", async () => {
		const root = await makeScratchRoot();
		await writeFile(join(root, "docs", "brand", "unexpected.txt"), "extra");

		const result = runBrandCheck(root);
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("E_BRAND_REVIEW");
	});
});
