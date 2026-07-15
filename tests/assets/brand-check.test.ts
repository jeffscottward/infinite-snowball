import { spawnSync } from "node:child_process";
import {
	copyFile,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { containsProhibitedBrandTerm } from "../../tools/assets/lib/brand-terms.mjs";

const ROOT = process.cwd();
const CHECKER = join(ROOT, "tools", "assets", "brand-check.mjs");
const PACKAGE_DIRECTORIES = [
	"starter-level",
	"starter-objects",
	"starter-character",
	"starter-campaign",
	"starter-music",
] as const;
const REVIEW_FIELDS = [
	"schemaVersion",
	"productName",
	"tagline",
	"description",
	"claims",
	"reviewedOn",
	"reviewedBy",
	"contentSha256",
	"renderIndexSha256",
	"prohibitedVocabulary",
	"prohibited",
] as const;
const PROHIBITED_FLAGS = [
	"affiliationClaims",
	"franchiseNamesInMarketing",
	"copiedCharactersLogosAndTradeDress",
	"unverifiedRatingsReviewsAndStoreBadges",
	"commercialSoundtrackPackaging",
] as const;

type JsonRecord = Record<string, unknown>;
type BrandCases = {
	franchiseVocabulary: string[];
	tradeDressVocabulary: string[];
	copiedTradeDressClaims: string[];
	affiliationClaims: string[];
	fakeRatingClaims: string[];
	storeClaims: string[];
	directComparisonClaims: string[];
	soundtrackSuggestions: string[];
};

const scratchRoots: string[] = [];

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function makeScratchRoot(): Promise<string> {
	const scratch = await mkdtemp(join(tmpdir(), "infinite-snowball-brand-"));
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

function runBrandCheck(cwd: string): { output: string; status: number | null } {
	const result = spawnSync(process.execPath, [CHECKER], {
		cwd,
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	return {
		output: `${result.stdout}${result.stderr}`,
		status: result.status,
	};
}

function metadataOf(manifest: JsonRecord): JsonRecord {
	return manifest.metadata as JsonRecord;
}

async function writeManifestClaim(
	root: string,
	claim: string,
	key = "description",
): Promise<void> {
	const path = join(root, "content", "starter-level", "manifest.json");
	const manifest = await readJson<JsonRecord>(path);
	metadataOf(manifest).translations = {
		en: { [key]: claim },
	};
	await writeJson(path, manifest);
}

afterEach(async () => {
	await Promise.all(
		scratchRoots
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("P03 original-brand publication gate", () => {
	it("accepts the exact machine review and all five complete starter manifests", () => {
		const result = runBrandCheck(ROOT);
		expect(result.status, result.output).toBe(0);
		expect(result.output).toContain(
			"Original-brand review verified across 5 starter manifests.",
		);
	});

	it("requires every exact frozen review field and prohibition", async () => {
		const root = await makeScratchRoot();
		const reviewPath = join(
			root,
			"docs",
			"brand",
			"original-content-review.json",
		);
		const fullReview = await readJson<JsonRecord>(reviewPath);
		const candidates: Array<{ name: string; value: JsonRecord }> = [
			{ name: "empty review", value: {} },
		];
		for (const field of REVIEW_FIELDS) {
			const partial = structuredClone(fullReview);
			delete partial[field];
			candidates.push({ name: `missing ${field}`, value: partial });
		}
		for (const flag of PROHIBITED_FLAGS) {
			const partial = structuredClone(fullReview);
			delete (partial.prohibited as JsonRecord)[flag];
			candidates.push({ name: `missing prohibited.${flag}`, value: partial });
		}
		const disabled = structuredClone(fullReview);
		(disabled.prohibited as JsonRecord).affiliationClaims = false;
		candidates.push({ name: "disabled prohibition", value: disabled });
		const extra = structuredClone(fullReview);
		extra.unreviewedField = true;
		candidates.push({ name: "unknown review field", value: extra });
		const alteredCopy = structuredClone(fullReview);
		alteredCopy.tagline = "A different rolling game.";
		candidates.push({ name: "altered frozen copy", value: alteredCopy });

		for (const candidate of candidates) {
			await writeJson(reviewPath, candidate.value);
			const result = runBrandCheck(root);
			expect(result.status, candidate.name).toBe(1);
			expect(result.output, candidate.name).toContain("E_BRAND_REVIEW");
		}
	});

	it("binds the exact human review while allowing its factual policy warnings", async () => {
		const root = await makeScratchRoot();
		const reviewPath = join(
			root,
			"docs",
			"brand",
			"original-content-review.md",
		);
		const original = await readFile(reviewPath, "utf8");
		expect(runBrandCheck(root).status).toBe(0);
		await writeFile(
			reviewPath,
			original.replace(
				"Product name: **Infinite Snowball**",
				"Product name: **Katamari**",
			),
			"utf8",
		);
		const result = runBrandCheck(root);
		expect(result.status).toBe(1);
		expect(result.output).toContain("E_BRAND_REVIEW");
	});

	it("freezes the complete case-insensitive franchise and trade-dress vocabulary", async () => {
		const root = await makeScratchRoot();
		const cases = await readJson<BrandCases>(
			join(ROOT, "tests", "fixtures", "assets", "brand-check-cases.json"),
		);
		const review = await readJson<JsonRecord>(
			join(ROOT, "docs", "brand", "original-content-review.json"),
		);
		expect(review.prohibitedVocabulary).toEqual({
			franchise: cases.franchiseVocabulary,
			tradeDress: cases.tradeDressVocabulary,
		});

		for (const term of cases.franchiseVocabulary) {
			await writeManifestClaim(root, term.toUpperCase());
			const result = runBrandCheck(root);
			expect(result.status, term).toBe(1);
			expect(result.output, term).toContain("E_BRAND_FRANCHISE");
		}
		await writeManifestClaim(root, "Kátamari");
		const normalizedFranchise = runBrandCheck(root);
		expect(normalizedFranchise.status).toBe(1);
		expect(normalizedFranchise.output).toContain("E_BRAND_FRANCHISE");
		for (const term of cases.tradeDressVocabulary) {
			await writeManifestClaim(root, term.toUpperCase());
			const result = runBrandCheck(root);
			expect(result.status, term).toBe(1);
			expect(result.output, term).toContain("E_BRAND_TRADE_DRESS");
		}
	});

	it("fails closed on invalid identities and scans safe manifest tags, descriptions, translations, and nested keys and values", async () => {
		const root = await makeScratchRoot();
		const path = join(root, "content", "starter-level", "manifest.json");
		const baseline = await readJson<JsonRecord>(path);
		const cases: Array<{
			name: string;
			mutate: (manifest: JsonRecord) => void;
		}> = [
			{
				name: "package name",
				mutate: (manifest) => {
					manifest.name = "@infinite-snowball/KaTaMaRi";
				},
			},
			{
				name: "tag",
				mutate: (manifest) => {
					metadataOf(manifest).tags = ["KaTaMaRi"];
				},
			},
			{
				name: "asset path",
				mutate: (manifest) => {
					(manifest.assets as JsonRecord[])[0]!.path =
						"assets/KaTaMaRi-icon.png";
				},
			},
			{
				name: "description",
				mutate: (manifest) => {
					metadataOf(manifest).description = "A bare KaTaMaRi reference.";
				},
			},
			{
				name: "translation value",
				mutate: (manifest) => {
					metadataOf(manifest).translations = {
						fr: { description: "KaTaMaRi" },
					};
				},
			},
			{
				name: "nested key",
				mutate: (manifest) => {
					metadataOf(manifest).translations = {
						KaTaMaRiLore: { description: "winter collection" },
					};
				},
			},
		];

		for (const testCase of cases) {
			const manifest = structuredClone(baseline);
			testCase.mutate(manifest);
			await writeJson(path, manifest);
			const result = runBrandCheck(root);
			expect(result.status, testCase.name).toBe(1);
			expect(result.output, testCase.name).toContain(
				testCase.name === "package name" || testCase.name === "asset path"
					? "E_BRAND_MANIFEST"
					: "E_BRAND_FRANCHISE",
			);
		}

		const safeRaw = `${JSON.stringify(baseline, null, 2)}\n`;
		const safeName = '"name": "@infinite-snowball/starter-level"';
		await writeFile(
			path,
			safeRaw.replace(safeName, `"name": "K\\u0061tamari",\n  ${safeName}`),
			"utf8",
		);
		const rawBytesResult = runBrandCheck(root);
		expect(rawBytesResult.status).toBe(1);
		expect(rawBytesResult.output).toContain("E_BRAND_FRANCHISE");

		expect(containsProhibitedBrandTerm("kata")).toBe(false);
		expect(containsProhibitedBrandTerm("mari")).toBe(false);
	});

	it("rejects copied trade dress and false affiliation, rating, review, store, comparison, and soundtrack claims", async () => {
		const root = await makeScratchRoot();
		const cases = await readJson<BrandCases>(
			join(ROOT, "tests", "fixtures", "assets", "brand-check-cases.json"),
		);
		const groups: Array<{ claims: string[]; ruleId: string }> = [
			{
				claims: cases.copiedTradeDressClaims,
				ruleId: "E_BRAND_TRADE_DRESS",
			},
			{
				claims: cases.affiliationClaims,
				ruleId: "E_BRAND_AFFILIATION",
			},
			{
				claims: cases.fakeRatingClaims,
				ruleId: "E_BRAND_FAKE_RATING",
			},
			{ claims: cases.storeClaims, ruleId: "E_BRAND_STORE_BADGE" },
			{
				claims: cases.directComparisonClaims,
				ruleId: "E_BRAND_DIRECT_COMPARISON",
			},
			{
				claims: cases.soundtrackSuggestions,
				ruleId: "E_SOUNDTRACK_PROHIBITED",
			},
		];
		for (const group of groups) {
			for (const claim of group.claims) {
				await writeManifestClaim(root, claim);
				const result = runBrandCheck(root);
				expect(result.status, claim).toBe(1);
				expect(result.output, claim).toContain(group.ruleId);
			}
		}

		const keyCases = [
			{ key: "copiedTradeDress", ruleId: "E_BRAND_TRADE_DRESS" },
			{ key: "officialPartner", ruleId: "E_BRAND_AFFILIATION" },
			{ key: "pressReviews", ruleId: "E_BRAND_FAKE_RATING" },
			{ key: "appStoreBadge", ruleId: "E_BRAND_STORE_BADGE" },
			{ key: "betterThanKatamari", ruleId: "E_BRAND_DIRECT_COMPARISON" },
			{ key: "recommendKatamariSoundtrack", ruleId: "E_SOUNDTRACK_PROHIBITED" },
		];
		for (const testCase of keyCases) {
			await writeManifestClaim(root, "blocked", testCase.key);
			const result = runBrandCheck(root);
			expect(result.status, testCase.key).toBe(1);
			expect(result.output, testCase.key).toContain(testCase.ruleId);
		}
	});

	it("applies contextual protected-claim boundaries to manifest text", async () => {
		const cases = [
			{
				name: "protected publisher license",
				lawful: "Licensed under CC0-1.0.",
				prohibited: "Infinite Snowball is licensed by Bandai Namco.",
			},
			{
				name: "commercial soundtrack transfer",
				lawful: "We composed an original soundtrack.",
				prohibited: "Download the commercial soundtrack for this game.",
			},
		] as const;
		for (const testCase of cases) {
			const root = await makeScratchRoot();
			await writeManifestClaim(root, testCase.lawful);
			const lawfulResult = runBrandCheck(root);
			expect(lawfulResult.status, testCase.name).toBe(1);
			expect(lawfulResult.output, testCase.name).toContain("E_BRAND_REVIEW");
			expect(lawfulResult.output, testCase.name).not.toContain(
				"E_BRAND_FRANCHISE",
			);

			await writeManifestClaim(root, testCase.prohibited);
			const prohibitedResult = runBrandCheck(root);
			expect(prohibitedResult.status, testCase.name).toBe(1);
			expect(prohibitedResult.output, testCase.name).toContain(
				"E_BRAND_FRANCHISE",
			);
		}
	});
});
