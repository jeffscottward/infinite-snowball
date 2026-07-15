import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
	applyOfflineEvent,
	createOfflineState,
} from "../../packages/protocol/src/offline/model.js";
import { validateCatalogInstallEligibility } from "../../packages/protocol/src/validation/dependency-catalog.js";

import {
	auditLocalAudioBoundary,
	checkProvenanceLedger,
	createWithdrawalRegistryRecord,
	formatProvenanceLedgerRow,
	readCanonicalWithdrawalRecord,
	generateProvenanceLedger,
	validateBrandMetadata,
	validateMusicPolicy,
	validateProvenanceEvidence,
	validateWithdrawalPackageBinding,
	validateWithdrawalRecord,
} from "../../tools/assets/lib/policy.mjs";
import {
	provenanceRecordFileName,
	reconstructProvenanceRecord,
	resolveRetainedLicenseEvidence,
} from "../../tools/assets/lib/provenance-ledger.mjs";

const ROOT = process.cwd();
const FIXTURE_ROOT = join(ROOT, "tests", "fixtures", "assets");
const MUSIC_CHECK = join(ROOT, "tools", "assets", "music-check.mjs");
const LOCAL_AUDIO_CHECK = join(ROOT, "tools", "assets", "local-audio-check.mjs");
const execFileAsync = promisify(execFile);

async function copiedMusicCheckRoot(
	transformWav: (wav: Buffer) => Buffer,
): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "infinite-snowball-music-check-"));
	await Promise.all([
		mkdir(join(root, "content"), { recursive: true }),
		mkdir(join(root, "docs", "licenses"), { recursive: true }),
		mkdir(join(root, "tools", "assets", "lib"), { recursive: true }),
	]);
	await Promise.all([
		cp(
			join(ROOT, "content", "starter-music"),
			join(root, "content", "starter-music"),
			{ recursive: true },
		),
		cp(
			join(ROOT, "docs", "licenses", "provenance"),
			join(root, "docs", "licenses", "provenance"),
			{ recursive: true },
		),
		cp(
			join(ROOT, "tools", "assets", "lib", "asset-pipeline.mjs"),
			join(root, "tools", "assets", "lib", "asset-pipeline.mjs"),
		),
	]);
	const packageDirectory = "starter-music";
	const packageRoot = join(root, "content", packageDirectory);
	const manifestPath = join(packageRoot, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	const moduleBytes = await readFile(
		join(root, "tools", "assets", "lib", "asset-pipeline.mjs"),
	);
	const moduleSha256 = createHash("sha256")
		.update(moduleBytes)
		.digest("hex");
	for (const candidate of manifest.assets) {
		if (candidate.provenance.creator === "Infinite Snowball contributors") {
			candidate.provenance.sourceArtifactSha256 = moduleSha256;
		}
	}
	const asset = manifest.assets.find(
		(candidate: { assetId: string }) => candidate.assetId === "track",
	);
	const runtimePath = join(packageRoot, asset.path);
	const runtimeBytes = transformWav(await readFile(runtimePath));
	const runtimeSha256 = createHash("sha256").update(runtimeBytes).digest("hex");
	asset.bytes = runtimeBytes.length;
	asset.sha256 = runtimeSha256;
	asset.provenance.outputSha256 = runtimeSha256;
	await Promise.all([
		writeFile(runtimePath, runtimeBytes),
		writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
	]);
	const retainedLicenseEvidence =
		await resolveRetainedLicenseEvidence(root, asset);
	const machine = reconstructProvenanceRecord({
		packageDirectory,
		manifest,
		asset,
		runtimeBytes,
		retainedLicenseEvidence,
	});
	await writeFile(
		join(
			root,
			"docs",
			"licenses",
			"provenance",
			"records",
			provenanceRecordFileName(machine),
		),
		`${JSON.stringify(machine, null, 2)}\n`,
	);
	return root;
}

async function localAudioReleaseRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "infinite-snowball-local-audio-"));
	const directories = [
		join(root, "content"),
		join(root, "docs", "assets"),
		join(root, "docs", "licenses"),
		join(root, "docs", "music"),
		join(root, "docs", "brand"),
		join(root, "tests", "fixtures", "assets"),
	];
	await Promise.all(
		directories.map((directory) => mkdir(directory, { recursive: true })),
	);
	await cp(
		join(FIXTURE_ROOT, "local-audio-cases.json"),
		join(root, "tests", "fixtures", "assets", "local-audio-cases.json"),
	);
	return root;
}

async function alignProjectOriginalSourceHashes(
	contentRoot: string,
): Promise<void> {
	const moduleSha256 = createHash("sha256")
		.update(
			await readFile(
				join(ROOT, "tools", "assets", "lib", "asset-pipeline.mjs"),
			),
		)
		.digest("hex");
	for (const directory of await readdir(contentRoot)) {
		const manifestPath = join(contentRoot, directory, "manifest.json");
		const manifest = JSON.parse(
			await readFile(manifestPath, "utf8"),
		) as {
			assets: Array<{
				provenance: {
					creator: string;
					sourceArtifactSha256: string;
				};
			}>;
		};
		for (const asset of manifest.assets) {
			if (
				asset.provenance.creator ===
				"Infinite Snowball contributors"
			) {
				asset.provenance.sourceArtifactSha256 = moduleSha256;
			}
		}
		await writeFile(
			manifestPath,
			`${JSON.stringify(manifest, null, 2)}\n`,
			"utf8",
		);
	}
}

async function prepareLedgerScratch(
	root: string,
	contentRoot: string,
): Promise<void> {
	await cp(join(ROOT, "content"), contentRoot, { recursive: true });
	await Promise.all([
		mkdir(
			join(root, "docs", "licenses", "provenance"),
			{ recursive: true },
		),
		mkdir(join(root, "tools", "assets", "sources"), {
			recursive: true,
		}),
		mkdir(join(root, "tools", "assets", "lib"), { recursive: true }),
	]);
	await Promise.all([
		cp(
			join(
				ROOT,
				"docs",
				"licenses",
				"provenance",
				"infinite-snowball-original-content",
			),
			join(
				root,
				"docs",
				"licenses",
				"provenance",
				"infinite-snowball-original-content",
			),
			{ recursive: true },
		),
		cp(
			join(
				ROOT,
				"tools",
				"assets",
				"sources",
				"kenney-nature-kit",
			),
			join(
				root,
				"tools",
				"assets",
				"sources",
				"kenney-nature-kit",
			),
			{ recursive: true },
		),
		cp(
			join(ROOT, "tools", "assets", "lib", "asset-pipeline.mjs"),
			join(root, "tools", "assets", "lib", "asset-pipeline.mjs"),
		),
	]);
	await alignProjectOriginalSourceHashes(contentRoot);
}

async function fixture<T>(name: string): Promise<T> {
	return JSON.parse(await readFile(join(FIXTURE_ROOT, name), "utf8")) as T;
}

function setPath(
	target: Record<string, unknown>,
	path: string,
	value: unknown,
): void {
	const parts = path.split(".");
	let current: Record<string, unknown> = target;
	for (const part of parts.slice(0, -1)) {
		const next = current[part];
		if (typeof next !== "object" || next === null || Array.isArray(next)) {
			current[part] = {};
		}
		current = current[part] as Record<string, unknown>;
	}
	current[parts.at(-1) as string] = value;
}

function deletePath(target: Record<string, unknown>, path: string): void {
	const parts = path.split(".");
	let current: Record<string, unknown> = target;
	for (const part of parts.slice(0, -1)) {
		const next = current[part];
		if (typeof next !== "object" || next === null || Array.isArray(next))
			return;
		current = next as Record<string, unknown>;
	}
	delete current[parts.at(-1) as string];
}

function candidate(
	baseline: Record<string, unknown>,
	testCase: { patch?: Record<string, unknown>; delete?: string[] },
): Record<string, unknown> {
	const result = structuredClone(baseline);
	for (const [path, value] of Object.entries(testCase.patch ?? {}))
		setPath(result, path, value);
	for (const path of testCase.delete ?? []) deletePath(result, path);
	return result;
}

type Case = {
	name: string;
	patch?: Record<string, unknown>;
	delete?: string[];
	expected?: string | string[];
};

type PackageIdentity = {
	name: string;
	version: string;
	integrity: string;
	manifestSha256: string;
};

describe("P03 license and provenance policy", () => {
	it("accepts complete exact-artifact evidence", async () => {
		const data = await fixture<{ baseline: Record<string, unknown> }>(
			"provenance-cases.json",
		);
		expect(validateProvenanceEvidence(data.baseline)).toEqual({
			ok: true,
			issues: [],
		});
	});
	it("maps every legal provenance identity to one collision-resistant path segment", () => {
		const simple = provenanceRecordFileName({
			packageName: "@infinite-snowball/starter-objects",
			assetId: "render",
		});
		expect(simple).toMatch(/^starter-objects--render--[a-f0-9]{64}\.json$/u);
		const nested = provenanceRecordFileName({
			packageName: "@infinite-snowball/starter-objects",
			assetId: "models/hero",
		});
		expect(nested).toMatch(
			/^starter-objects--models%2Fhero--[a-f0-9]{64}\.json$/u,
		);
		expect(nested).not.toMatch(/[\\/]/u);
		const caseVariant = provenanceRecordFileName({
			packageName: "@infinite-snowball/starter-objects",
			assetId: "Render",
		});
		expect(caseVariant.toLowerCase()).not.toBe(simple.toLowerCase());
		const delimiterVariants = [
			provenanceRecordFileName({
				packageName: "@infinite-snowball/starter--objects",
				assetId: "render",
			}),
			provenanceRecordFileName({
				packageName: "@infinite-snowball/starter",
				assetId: "objects--render",
			}),
		];
		expect(new Set(delimiterVariants).size).toBe(delimiterVariants.length);
		expect(
			provenanceRecordFileName({
				packageName: "@infinite-snowball/starter-objects",
				assetId: "a".repeat(128),
			}).length,
		).toBeLessThanOrEqual(255);
		expect(() =>
			provenanceRecordFileName({
				packageName: "../../starter-objects",
				assetId: "render",
			}),
		).toThrow(/E_LEDGER_PATH/u);
		expect(() =>
			provenanceRecordFileName({
				packageName: "@infinite-snowball/starter-objects",
				assetId: "../../escape",
			}),
		).toThrow(/E_LEDGER_PATH/u);
	});

	it("fails closed for every unsafe provenance fixture with stable rule IDs", async () => {
		const data = await fixture<{
			baseline: Record<string, unknown>;
			cases: Case[];
		}>("provenance-cases.json");
		for (const testCase of data.cases) {
			const result = validateProvenanceEvidence(
				candidate(data.baseline, testCase),
			);
			const expected = Array.isArray(testCase.expected)
				? testCase.expected
				: [testCase.expected];
			expect(result.ok, testCase.name).toBe(false);
			expect(
				result.issues.map((issue) => issue.ruleId),
				testCase.name,
			).toEqual(expect.arrayContaining(expected));
		}
	});

	it("rejects CC BY sources canonically equivalent to the license URL while accepting a real source", async () => {
		const data = await fixture<{
			baseline: Record<string, unknown>;
		}>("provenance-cases.json");
		const buildCcBy = (sourceUrl: string): Record<string, unknown> => {
			const record = structuredClone(data.baseline);
			const textSha256 = "b".repeat(64);
			for (const [path, value] of [
				["packageLicense", "CC-BY-4.0"],
				["sourceUrl", sourceUrl],
				["license.spdx", "CC-BY-4.0"],
				[
					"license.url",
					"https://creativecommons.org/licenses/by/4.0/",
				],
				["license.author", "Kenney"],
				["license.source", sourceUrl],
				[
					"license.textPath",
					`docs/licenses/provenance/cc-by-4.0/${textSha256}.txt`,
				],
			] as const) {
				setPath(record, path, value);
			}
			return record;
		};
		for (const sourceUrl of [
			"https://creativecommons.org/licenses/by/4.0/?candidate=1",
			"https://CREATIVECOMMONS.ORG:443/licenses/by/4.0#original",
			"https://creativecommons.org./licenses/by/4.0/",
		]) {
			const checked = validateProvenanceEvidence(
				buildCcBy(sourceUrl),
			);
			expect(checked.ok, sourceUrl).toBe(false);
			expect(
				checked.issues.map((entry) => entry.ruleId),
			).toContain("E_LICENSE_EVIDENCE");
		}
		const realSourceWithDnsRoot = buildCcBy(
			"https://example.com./original-source",
		);
		setPath(
			realSourceWithDnsRoot,
			"sourceUrl",
			"https://example.com/original-source",
		);
		expect(validateProvenanceEvidence(realSourceWithDnsRoot).issues).toEqual([]);
	});

	it("keeps runtime assets in exact one-to-one correspondence with canonical human and machine ledgers", async () => {
		const scratch = await mkdtemp(
			join(tmpdir(), "infinite-snowball-p03-ledger-"),
		);
		const contentRoot = join(scratch, "content");
		const machineRoot = join(
			scratch,
			"docs",
			"licenses",
			"provenance",
			"records",
		);
		const ledgerPath = join(
			scratch,
			"docs",
			"licenses",
			"third-party-ledger.md",
		);
		try {
			await prepareLedgerScratch(scratch, contentRoot);
			await generateProvenanceLedger({
				root: scratch,
				contentRoot,
				machineRoot,
				ledgerPath,
			});
			const result = await checkProvenanceLedger({
				root: scratch,
				contentRoot,
				machineRoot,
				ledgerPath,
			});
			expect(result.issues).toEqual([]);
			expect(result.runtimeFiles).toBeGreaterThan(0);
			expect(result.runtimeFiles).toBe(result.machineRecords);
			expect(result.runtimeFiles).toBe(result.humanRows);
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	});

	it("detects every material machine field that drifts from the current manifest and bytes", async () => {
		const scratch = await mkdtemp(
			join(tmpdir(), "infinite-snowball-p03-ledger-"),
		);
		const contentRoot = join(scratch, "content");
		const machineRoot = join(
			scratch,
			"docs",
			"licenses",
			"provenance",
			"records",
		);
		const ledgerPath = join(
			scratch,
			"docs",
			"licenses",
			"third-party-ledger.md",
		);
		try {
			await prepareLedgerScratch(scratch, contentRoot);
			await generateProvenanceLedger({
				root: scratch,
				contentRoot,
				machineRoot,
				ledgerPath,
			});
			const machineFile = join(
				machineRoot,
				(await readdir(machineRoot)).sort()[0] as string,
			);
			const canonical = JSON.parse(
				await readFile(machineFile, "utf8"),
			) as Record<string, unknown>;
			const mutations: Array<[string, unknown]> = [
				["creator", "Another reviewed creator"],
				["sourceUrl", "https://example.com/reviewed-source"],
				["sourceArtifact", "different-reviewed-source.bin"],
				["sourceArtifactSha256", "d".repeat(64)],
				["acquisition", "different reviewed acquisition"],
				["acquiredAt", "2026-07-16T00:00:00.000Z"],
				["packageLicense", "CC-BY-4.0"],
				["license.url", "https://example.com/reviewed-license"],
				["license.textSha256", "e".repeat(64)],
				["license.grant", "Different captured grant."],
				["attribution", "Different complete attribution."],
				["modifications", ["different reviewed modification"]],
				["transformation.recipe", "different-reviewed-recipe-v1"],
				["output.path", "content/different/output.bin"],
				["reviewer", "Different provenance reviewer"],
				["reviewedAt", "2026-07-16T00:00:00.000Z"],
				["evidenceStatus", "withdrawn"],
				["replacement", "asset:reviewed-replacement"],
			];
			for (const [path, value] of mutations) {
				const mutated = structuredClone(canonical);
				setPath(mutated, path, value);
				await writeFile(
					machineFile,
					`${JSON.stringify(mutated, null, 2)}\n`,
					"utf8",
				);
				const result = await checkProvenanceLedger({
					root: scratch,
					contentRoot,
					machineRoot,
					ledgerPath,
				});
				expect(
					result.issues.map((entry) => entry.ruleId),
					path,
				).toContain("E_LEDGER_MACHINE_STALE");
			}
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	});

	it("detects valid but stale human ledger columns instead of accepting IDs alone", async () => {
		const scratch = await mkdtemp(
			join(tmpdir(), "infinite-snowball-p03-ledger-"),
		);
		const contentRoot = join(scratch, "content");
		const machineRoot = join(
			scratch,
			"docs",
			"licenses",
			"provenance",
			"records",
		);
		const ledgerPath = join(
			scratch,
			"docs",
			"licenses",
			"third-party-ledger.md",
		);
		try {
			await prepareLedgerScratch(scratch, contentRoot);
			await generateProvenanceLedger({
				root: scratch,
				contentRoot,
				machineRoot,
				ledgerPath,
			});
			const machineFile = join(
				machineRoot,
				(await readdir(machineRoot)).sort()[0] as string,
			);
			const canonical = JSON.parse(
				await readFile(machineFile, "utf8"),
			) as Record<string, unknown>;
			const canonicalRow = formatProvenanceLedgerRow(canonical);
			const ledger = await readFile(ledgerPath, "utf8");
			const mutations: Array<[string, unknown]> = [
				["creator", "Another reviewed creator"],
				["sourceUrl", "https://example.com/reviewed-source"],
				["sourceArtifact", "different-reviewed-source.bin"],
				["sourceArtifactSha256", "d".repeat(64)],
				["acquisition", "different reviewed acquisition"],
				["packageLicense", "CC-BY-4.0"],
				["license.url", "https://example.com/reviewed-license"],
				["license.textSha256", "e".repeat(64)],
				["license.grant", "Different captured grant."],
				["attribution", "Different complete attribution."],
				["modifications", ["different reviewed modification"]],
				["transformation.recipe", "different-reviewed-recipe-v1"],
				["output.path", "content/different/output.bin"],
				["reviewer", "Different provenance reviewer"],
				["acquiredAt", "2026-07-16T00:00:00.000Z"],
				["reviewedAt", "2026-07-16T00:00:00.000Z"],
				["evidenceStatus", "withdrawn"],
				["replacement", "asset:reviewed-replacement"],
			];
			for (const [path, value] of mutations) {
				const mutated = structuredClone(canonical);
				setPath(mutated, path, value);
				await writeFile(
					ledgerPath,
					ledger.replace(canonicalRow, formatProvenanceLedgerRow(mutated)),
					"utf8",
				);
				const result = await checkProvenanceLedger({
					root: scratch,
					contentRoot,
					machineRoot,
					ledgerPath,
				});
				expect(
					result.issues.map((entry) => entry.ruleId),
					path,
				).toContain("E_LEDGER_HUMAN_STALE");
			}
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	});
});

describe("P03 music policy", () => {
	it("allows only original, captured CC0, and fully attributed CC BY tracks", async () => {
		const data = await fixture<{
			baseline: Record<string, unknown>;
			accepted: Case[];
		}>("music-cases.json");
		for (const testCase of data.accepted) {
			expect(
				validateMusicPolicy(candidate(data.baseline, testCase)),
				testCase.name,
			).toEqual({ ok: true, issues: [] });
		}
	});

	it("rejects license, attribution, grant, codec, decoded-audio, pack, and soundtrack violations", async () => {
		const data = await fixture<{
			baseline: Record<string, unknown>;
			rejected: Case[];
		}>("music-cases.json");
		for (const testCase of data.rejected) {
			const result = validateMusicPolicy(candidate(data.baseline, testCase));
			expect(result.ok, testCase.name).toBe(false);
			expect(
				result.issues.map((issue) => issue.ruleId),
				testCase.name,
			).toContain(testCase.expected);
		}
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects non-finite track duration %s at the exported policy boundary",
		async (durationSeconds) => {
			const data = await fixture<{ baseline: Record<string, unknown> }>(
				"music-cases.json",
			);
			const result = validateMusicPolicy({
				...data.baseline,
				durationSeconds,
			});
			expect(result.ok).toBe(false);
			expect(result.issues.map((issue) => issue.ruleId)).toContain(
				"E_MUSIC_DURATION",
			);
		},
	);

	it("rejects a CC BY track bound to a CC0 asset and machine record", async () => {
		const data = await fixture<{
			baseline: Record<string, unknown>;
		}>("music-cases.json");
		const mismatched = candidate(data.baseline, {
			patch: {
				license: "CC-BY-4.0",
				attribution:
					"Snowdrift Signal by Example Composer, CC BY 4.0, source and changes recorded.",
			},
		});
		const result = validateMusicPolicy(mismatched);
		expect(result.ok).toBe(false);
		expect(result.issues.map((entry) => entry.ruleId)).toContain(
			"E_MUSIC_BINDING",
		);
	});

	it("rejects malformed runtime WAV bytes in the music CLI", async () => {
		const root = await copiedMusicCheckRoot((wav) => {
			const malformed = Buffer.from(wav);
			malformed.write("NOPE", 0, "ascii");
			return malformed;
		});
		try {
			await expect(
				execFileAsync(process.execPath, [MUSIC_CHECK], {
					cwd: root,
					timeout: 30_000,
				}),
			).rejects.toMatchObject({
				stderr: expect.stringContaining("E_WAV_STRUCTURE"),
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		[
			"duration",
			(wav: Buffer) => {
				const drifted = Buffer.concat([wav, Buffer.alloc(4)]);
				drifted.writeUInt32LE(drifted.length - 8, 4);
				drifted.writeUInt32LE(drifted.readUInt32LE(40) + 4, 40);
				return drifted;
			},
		],
		[
			"channels",
			(wav: Buffer) => {
				const drifted = Buffer.from(wav);
				drifted.writeUInt16LE(1, 22);
				drifted.writeUInt16LE(2, 32);
				drifted.writeUInt32LE(88_200, 28);
				return drifted;
			},
		],
		[
			"sample rate",
			(wav: Buffer) => {
				const drifted = Buffer.from(wav);
				drifted.writeUInt32LE(48_000, 24);
				drifted.writeUInt32LE(192_000, 28);
				return drifted;
			},
		],
		[
			"bits per sample",
			(wav: Buffer) => {
				const drifted = Buffer.from(wav);
				drifted.writeUInt16LE(24, 34);
				drifted.writeUInt16LE(6, 32);
				drifted.writeUInt32LE(264_600, 28);
				return drifted;
			},
		],
	] as const)(
		"rejects decoded WAV %s drift in the music CLI",
		async (_label, transformWav) => {
			const root = await copiedMusicCheckRoot(transformWav);
			try {
				await expect(
					execFileAsync(process.execPath, [MUSIC_CHECK], {
						cwd: root,
						timeout: 30_000,
					}),
				).rejects.toMatchObject({
					stderr: expect.stringContaining("E_MUSIC_BINDING"),
				});
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it("publishes the same closed music license and codec allowlists it enforces", async () => {
		const [musicPolicy, assetPolicy, template] = await Promise.all([
			readFile(join(ROOT, "docs", "music", "original-music-policy.md"), "utf8"),
			readFile(join(ROOT, "docs", "licenses", "asset-policy.md"), "utf8"),
			JSON.parse(
				await readFile(
					join(ROOT, "tools", "assets", "templates", "music.json"),
					"utf8",
				),
			) as {
				assets: Array<{ role: string; path: string; mime: string }>;
			},
		]);
		expect(`${musicPolicy}\n${assetPolicy}`).not.toMatch(/royalty[- ]free/iu);
		expect(musicPolicy).not.toMatch(/\bOgg\b/u);
		expect(
			template.assets.find((asset) => asset.role === "music-track"),
		).toMatchObject({
			path: expect.stringMatching(/\.wav$/u),
			mime: "audio/wav",
		});
	});
});

describe("P03 local-audio privacy boundary", () => {
	it("allows opaque local playback state without sensitive bytes or metadata", async () => {
		const data = await fixture<{
			imported: Record<string, unknown>;
			safe: unknown[];
		}>("local-audio-cases.json");
		expect(auditLocalAudioBoundary(data.imported, data.safe)).toEqual({
			ok: true,
			issues: [],
		});
	});

	it("blocks catalog, package, export, diagnostic, network, service-worker, screenshot, and analytics egress", async () => {
		const data = await fixture<{
			imported: Record<string, unknown>;
			forbidden: unknown[];
		}>("local-audio-cases.json");
		for (const emission of data.forbidden) {
			const result = auditLocalAudioBoundary(data.imported, [emission]);
			expect(result.ok, JSON.stringify(emission)).toBe(false);
			expect(result.issues.map((issue) => issue.ruleId)).toContain(
				"E_LOCAL_AUDIO_EGRESS",
			);
		}
	});

	it("rejects malformed non-array emissions before inspecting payloads", async () => {
		const data = await fixture<{ nonArrays: unknown[] }>(
			"local-audio-cases.json",
		);
		for (const emissions of data.nonArrays) {
			const result = auditLocalAudioBoundary({}, emissions);
			expect(result.ok, JSON.stringify(emissions)).toBe(false);
			expect(result.issues.map((entry) => entry.ruleId)).toContain(
				"E_LOCAL_AUDIO_EGRESS",
			);
		}
	});
	it("rejects missing opaque IDs and aliases of imported file names or hashes", async () => {
		const data = await fixture<{
			imported: Record<string, unknown>;
			collidingOpaqueIds: unknown[];
		}>("local-audio-cases.json");
		for (const localTrackId of data.collidingOpaqueIds) {
			const imported = { ...data.imported, localTrackId };
			const emissions = [
				{
					channel: "player",
					payload: { localTrackId, state: "playing" },
				},
			];
			const checked = auditLocalAudioBoundary(imported, emissions);
			expect(checked.ok, JSON.stringify(localTrackId)).toBe(false);
			expect(checked.issues.map((entry) => entry.ruleId)).toContain(
				"E_LOCAL_AUDIO_EGRESS",
			);
		}
	});

	it("rejects short and non-Latin file-name aliases as local track IDs", async () => {
		const data = await fixture<{
			imported: Record<string, unknown>;
			derivedOpaqueIds: Array<{ fileName: string; localTrackId: string }>;
		}>("local-audio-cases.json");
		for (const testCase of data.derivedOpaqueIds) {
			const imported = { ...data.imported, ...testCase };
			const checked = auditLocalAudioBoundary(imported, [
				{
					channel: "player",
					payload: {
						localTrackId: testCase.localTrackId,
						state: "playing",
					},
				},
			]);
			expect(checked.ok, testCase.fileName).toBe(false);
			expect(checked.issues.map((entry) => entry.ruleId)).toContain(
				"E_LOCAL_AUDIO_EGRESS",
			);
		}
	});

	it("fails closed for malformed Unicode private metadata", async () => {
		const data = await fixture<{
			imported: Record<string, unknown>;
			malformedPrivateValues: string[];
		}>("local-audio-cases.json");
		for (const fileName of data.malformedPrivateValues) {
			const imported = { ...data.imported, fileName };
			const localTrackId = data.imported["localTrackId"];
			const checked = auditLocalAudioBoundary(imported, [
				{
					channel: "player",
					payload: { localTrackId, state: "playing" },
				},
			]);
			expect(checked.ok).toBe(false);
			expect(checked.issues.map((entry) => entry.ruleId)).toContain(
				"E_LOCAL_AUDIO_EGRESS",
			);
		}
	});

	it("rejects private metadata embedded in a reference-render release artifact", async () => {
		const root = await localAudioReleaseRoot();
		try {
			await mkdir(join(root, "docs", "assets", "reference-renders"), {
				recursive: true,
			});
			await writeFile(
				join(root, "docs", "assets", "reference-renders", "canary.png"),
				Buffer.from("private-winter-mix.wav", "utf8"),
			);
			await expect(
				execFileAsync(process.execPath, [LOCAL_AUDIO_CHECK], {
					cwd: root,
					timeout: 30_000,
				}),
			).rejects.toMatchObject({
				stderr: expect.stringContaining("private filename"),
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects private rights metadata in the published music policy", async () => {
		const root = await localAudioReleaseRoot();
		try {
			await writeFile(
				join(root, "docs", "music", "policy.md"),
				"personal local playback only",
				"utf8",
			);
			await expect(
				execFileAsync(process.execPath, [LOCAL_AUDIO_CHECK], {
					cwd: root,
					timeout: 30_000,
				}),
			).rejects.toMatchObject({
				stderr: expect.stringContaining("private rights note"),
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a private filename used only as an empty release directory", async () => {
		const root = await localAudioReleaseRoot();
		try {
			await mkdir(join(root, "docs", "assets", "private-winter-mix.wav"));
			await expect(
				execFileAsync(process.execPath, [LOCAL_AUDIO_CHECK], {
					cwd: root,
					timeout: 30_000,
				}),
			).rejects.toMatchObject({
				stderr: expect.stringContaining("private filename"),
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects an exact short imported tag in a scanned release file", async () => {
		const root = await localAudioReleaseRoot();
		const data = await fixture<{
			imported: { tags: string[] };
		}>("local-audio-cases.json");
		try {
			const shortTag = data.imported.tags[0];
			if (shortTag === undefined) {
				throw new Error("short imported tag fixture is missing");
			}
			await writeFile(
				join(root, "docs", "assets", "short-tag-leak.txt"),
				shortTag,
				"utf8",
			);
			await expect(
				execFileAsync(process.execPath, [LOCAL_AUDIO_CHECK], {
					cwd: root,
					timeout: 30_000,
				}),
			).rejects.toMatchObject({
				stderr: expect.stringContaining("private imported tag"),
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		["lowercase hex", (bytes: Buffer) => bytes.toString("hex")],
		[
			"uppercase hex",
			(bytes: Buffer) => bytes.toString("hex").toUpperCase(),
		],
		["canonical base64", (bytes: Buffer) => bytes.toString("base64")],
		[
			"unpadded base64url",
			(bytes: Buffer) => bytes.toString("base64url"),
		],
	] as const)(
		"rejects decoded audio bytes encoded as %s in a release file",
		async (_label, encode) => {
			const root = await localAudioReleaseRoot();
			const data = await fixture<{
				imported: { bytesBase64: string };
			}>("local-audio-cases.json");
			try {
				const decoded = Buffer.from(
					data.imported.bytesBase64,
					"base64",
				);
				await writeFile(
					join(root, "docs", "assets", "decoded-audio-leak.txt"),
					encode(decoded),
					"utf8",
				);
				await expect(
					execFileAsync(process.execPath, [LOCAL_AUDIO_CHECK], {
						cwd: root,
						timeout: 30_000,
					}),
				).rejects.toMatchObject({
					stderr: expect.stringContaining("decoded audio bytes"),
				});
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it("rejects canonical padded base64url derived from decoded audio bytes", async () => {
		const root = await localAudioReleaseRoot();
		const fixturePath = join(
			root,
			"tests",
			"fixtures",
			"assets",
			"local-audio-cases.json",
		);
		try {
			const copiedFixture = JSON.parse(
				await readFile(fixturePath, "utf8"),
			) as { imported: { bytesBase64: string } };
			const decoded = Buffer.from([
				0xfb, 0xff, 0xef, 0xfb, 0xff, 0xef, 0xfb, 0xff,
			]);
			copiedFixture.imported.bytesBase64 =
				decoded.toString("base64");
			await writeFile(
				fixturePath,
				`${JSON.stringify(copiedFixture, null, 2)}\n`,
				"utf8",
			);
			await writeFile(
				join(root, "docs", "assets", "decoded-audio-leak.txt"),
				decoded
					.toString("base64")
					.replaceAll("+", "-")
					.replaceAll("/", "_"),
				"utf8",
			);
			await expect(
				execFileAsync(process.execPath, [LOCAL_AUDIO_CHECK], {
					cwd: root,
					timeout: 30_000,
				}),
			).rejects.toMatchObject({
				stderr: expect.stringContaining("decoded audio bytes"),
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not derive ambiguous encodings from decoded audio shorter than eight bytes", async () => {
		const root = await localAudioReleaseRoot();
		const fixturePath = join(
			root,
			"tests",
			"fixtures",
			"assets",
			"local-audio-cases.json",
		);
		try {
			const copiedFixture = JSON.parse(
				await readFile(fixturePath, "utf8"),
			) as { imported: { bytesBase64: string } };
			const decoded = Buffer.from("private", "utf8");
			copiedFixture.imported.bytesBase64 =
				decoded.toString("base64");
			await writeFile(
				fixturePath,
				`${JSON.stringify(copiedFixture, null, 2)}\n`,
				"utf8",
			);
			await writeFile(
				join(root, "docs", "assets", "short-aliases.txt"),
				`${decoded.toString("hex")}\n${decoded.toString("base64url")}\n`,
				"utf8",
			);
			await expect(
				execFileAsync(process.execPath, [LOCAL_AUDIO_CHECK], {
					cwd: root,
					timeout: 30_000,
				}),
			).resolves.toMatchObject({
				stdout: expect.stringContaining(
					"Local-audio boundary verified",
				),
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects raw and encoded imported tags, filenames, local IDs, waveform, and fingerprints in release files", async () => {
		const root = await localAudioReleaseRoot();
		const data = await fixture<{
			imported: {
				fileName: string;
				fingerprint: string;
				localTrackId: string;
				tags: string[];
				waveform: number[];
			};
		}>("local-audio-cases.json");
		try {
			const releaseText = [
				data.imported.tags[1],
				Buffer.from(data.imported.fileName, "utf8").toString("base64"),
				data.imported.localTrackId,
				Buffer.from(
					JSON.stringify(data.imported.waveform),
					"utf8",
				).toString("hex"),
				encodeURIComponent(data.imported.fingerprint),
			].join("\n");
			await writeFile(
				join(root, "docs", "assets", "private-import-leaks.txt"),
				releaseText,
				"utf8",
			);
			await expect(
				execFileAsync(process.execPath, [LOCAL_AUDIO_CHECK], {
					cwd: root,
					timeout: 30_000,
				}),
			).rejects.toMatchObject({
				stderr: expect.stringMatching(
					/^(?=[\s\S]*imported tag)(?=[\s\S]*imported filename)(?=[\s\S]*local track ID)(?=[\s\S]*waveform)(?=[\s\S]*fingerprint)/u,
				),
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

});

describe("P03 original brand policy", () => {
	it("accepts factual original Infinite Snowball copy", async () => {
		const data = await fixture<{ accepted: Record<string, unknown> }>(
			"brand-cases.json",
		);
		expect(validateBrandMetadata(data.accepted)).toEqual({
			ok: true,
			issues: [],
		});
	});

	it("rejects affiliation, franchise, trade-dress, rating, badge, soundtrack, and comparison claims", async () => {
		const data = await fixture<{
			rejected: Array<{ name: string; value: unknown; expected: string }>;
		}>("brand-cases.json");
		for (const testCase of data.rejected) {
			const result = validateBrandMetadata(testCase.value);
			expect(result.ok, testCase.name).toBe(false);
			expect(
				result.issues.map((issue) => issue.ruleId),
				testCase.name,
			).toContain(testCase.expected);
		}
	});

	it.each([
		"Kɑtamari",
		"Kᴀtamari",
		"ᴋatamari",
		"Kaᴛamari",
		"Kataᴍari",
		"Katamaʀi",
		"Katamarɪ",
		"Katamarı",
	] as const)("rejects reviewed Latin confusable %s in manifest metadata", (value) => {
		const checked = validateBrandMetadata({
			metadata: { translations: { default: { title: value } } },
		});
		expect(checked.ok).toBe(false);
		expect(checked.issues.map((entry) => entry.ruleId)).toContain(
			"E_BRAND_FRANCHISE",
		);
	});

	it.each(["Katamari", "КАТАМАРІ", "Kаtamari"] as const)(
		"rejects nested bare or confusable prohibited brand term %s",
		(value) => {
			const checked = validateBrandMetadata({
				metadata: { translations: { default: { title: value } } },
			});
			expect(checked.ok).toBe(false);
			expect(checked.issues.map((entry) => entry.ruleId)).toContain(
				"E_BRAND_FRANCHISE",
			);
		},
	);
});

describe("P03 withdrawal and replacement policy", () => {
	it("reads the exact canonical withdrawal record through bounded file identity", async () => {
		const data = await fixture<{ valid: Record<string, unknown> }>(
			"withdrawal-cases.json",
		);
		const root = await mkdtemp(
			join(tmpdir(), "infinite-snowball-withdrawal-read-"),
		);
		const recordPath = join(
			root,
			"docs",
			"licenses",
			"withdrawals",
			"starter-rock-simulated.json",
		);
		try {
			await mkdir(join(recordPath, ".."), { recursive: true });
			await writeFile(
				recordPath,
				`${JSON.stringify(data.valid, null, "\t")}\n`,
				"utf8",
			);
			await expect(
				readCanonicalWithdrawalRecord(root),
			).resolves.toEqual(data.valid);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		[
			"an early duplicate simulationOnly override",
			(value: Record<string, unknown>) =>
				`${JSON.stringify(value, null, "\t")}\n`.replace(
					"{\n",
					'{\n\t"simulationOnly": false,\n',
				),
		],
		[
			"an early duplicate allowNewInstalls override",
			(value: Record<string, unknown>) =>
				`${JSON.stringify(value, null, "\t")}\n`.replace(
					"{\n",
					'{\n\t"allowNewInstalls": true,\n',
				),
		],
		[
			"noncanonical key order",
			(value: Record<string, unknown>) =>
				`${JSON.stringify(
					Object.fromEntries(Object.entries(value).reverse()),
					null,
					"\t",
				)}\n`,
		],
		[
			"noncanonical whitespace",
			(value: Record<string, unknown>) =>
				`${JSON.stringify(value, null, 2)}\n`,
		],
	] as const)("rejects %s before using withdrawal JSON", async (_label, raw) => {
		const data = await fixture<{ valid: Record<string, unknown> }>(
			"withdrawal-cases.json",
		);
		const root = await mkdtemp(
			join(tmpdir(), "infinite-snowball-withdrawal-canonical-"),
		);
		const recordPath = join(
			root,
			"docs",
			"licenses",
			"withdrawals",
			"starter-rock-simulated.json",
		);
		try {
			await mkdir(join(recordPath, ".."), { recursive: true });
			await writeFile(recordPath, raw(data.valid), "utf8");
			await expect(
				readCanonicalWithdrawalRecord(root),
			).rejects.toThrow(/E_WITHDRAWAL_PATH/u);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each(["symlink", "fifo", "oversized"] as const)(
		"rejects a %s canonical withdrawal record without following or blocking",
		async (variant) => {
			const root = await mkdtemp(
				join(tmpdir(), "infinite-snowball-withdrawal-read-"),
			);
			const external = await mkdtemp(
				join(tmpdir(), "infinite-snowball-withdrawal-external-"),
			);
			const directory = join(
				root,
				"docs",
				"licenses",
				"withdrawals",
			);
			const recordPath = join(
				directory,
				"starter-rock-simulated.json",
			);
			const sentinelPath = join(external, "sentinel.json");
			const sentinel = `sentinel:${variant}`;
			try {
				await mkdir(directory, { recursive: true });
				if (variant === "symlink") {
					await writeFile(sentinelPath, sentinel, "utf8");
					await symlink(sentinelPath, recordPath, "file");
				} else if (variant === "fifo") {
					await execFileAsync("mkfifo", [recordPath]);
				} else {
					await writeFile(
						recordPath,
						Buffer.alloc(256 * 1024 + 1),
					);
				}
				await expect(
					readCanonicalWithdrawalRecord(root),
				).rejects.toThrow(/E_WITHDRAWAL_PATH/u);
				if (variant === "symlink") {
					expect(await readFile(sentinelPath, "utf8")).toBe(sentinel);
				}
			} finally {
				await rm(root, { recursive: true, force: true });
				await rm(external, { recursive: true, force: true });
			}
		},
	);
	it("models exact immutable package identity and a deterministic downstream registry", async () => {
		const data = await fixture<{ valid: Record<string, unknown> }>(
			"withdrawal-cases.json",
		);
		expect(validateWithdrawalRecord(data.valid)).toEqual({
			ok: true,
			issues: [],
		});
		const registry = createWithdrawalRegistryRecord(data.valid);
		expect(registry).toMatchObject({
			simulationOnly: true,
			status: "withdrawn",
			package: data.valid.package,
			affected: {
				objectIds: ["starter-rock"],
				assetIds: ["render", "collider"],
			},
			dispatch: {
				simulationOnly: true,
				type: "withdraw-package",
				package: "@infinite-snowball/starter-objects@1.0.0",
				replacement: "@infinite-snowball/starter-objects@2.0.0",
			},
		});
	});

	it("rejects a syntactically valid withdrawal bound to stale package bytes", async () => {
		const data = await fixture<{
			valid: {
				package: {
					name: string;
					version: string;
					integrity: string;
					manifestSha256: string;
				};
			};
		}>("withdrawal-cases.json");
		const currentPackage = {
			manifest: {
				name: data.valid.package.name,
				version: data.valid.package.version,
				assets: [{ assetId: "render" }, { assetId: "collider" }],
				entries: [
					{
						objects: [
							{
								objectId: "starter-rock",
								renderAssetId: "render",
								colliderAssetId: "collider",
								lodAssetIds: [],
							},
						],
					},
				],
			},
			manifestSha256: data.valid.package.manifestSha256,
			artifact: { integrity: data.valid.package.integrity },
		};
		expect(
			validateWithdrawalPackageBinding(data.valid, [currentPackage]),
		).toEqual({ ok: true, issues: [] });
		const stale = structuredClone(data.valid);
		stale.package.manifestSha256 = "f".repeat(64);
		expect(
			validateWithdrawalPackageBinding(stale, [currentPackage]),
		).toMatchObject({
			ok: false,
			issues: [expect.objectContaining({ ruleId: "E_WITHDRAWAL_IDENTITY" })],
		});
	});

	it("binds present reviewed replacement package bytes and target IDs exactly", async () => {
		const data = await fixture<{
			valid: {
				package: PackageIdentity;
				affectedObjectIds: string[];
				affectedAssetIds: string[];
				replacement: {
					package: PackageIdentity;
					objectIdMap: Record<string, string>;
					assetIdMap: Record<string, string>;
				};
			};
		}>("withdrawal-cases.json");
		const withdrawnPackage = {
			manifest: {
				name: data.valid.package.name,
				version: data.valid.package.version,
				assets: [{ assetId: "render" }, { assetId: "collider" }],
				entries: [
					{
						objects: [
							{
								objectId: "starter-rock",
								renderAssetId: "render",
								colliderAssetId: "collider",
								lodAssetIds: [],
							},
						],
					},
				],
			},
			manifestSha256: data.valid.package.manifestSha256,
			artifact: { integrity: data.valid.package.integrity },
		};
		const reviewedReplacement = {
			manifest: {
				name: data.valid.replacement.package.name,
				version: data.valid.replacement.package.version,
				assets: Object.values(data.valid.replacement.assetIdMap).map(
					(assetId) => ({ assetId }),
				),
				entries: [
					{
						objects: Object.values(
							data.valid.replacement.objectIdMap,
						).map((objectId) => ({ objectId })),
					},
				],
			},
			manifestSha256: data.valid.replacement.package.manifestSha256,
			artifact: { integrity: data.valid.replacement.package.integrity },
		};
		expect(
			validateWithdrawalPackageBinding(data.valid, [
				withdrawnPackage,
				reviewedReplacement,
			]),
		).toEqual({ ok: true, issues: [] });

		for (const [mapName, sourceId, missingId] of [
			["objectIdMap", "starter-rock", "missing-object"],
			["assetIdMap", "render", "missing-asset"],
		] as const) {
			const missingTarget = structuredClone(data.valid);
			missingTarget.replacement[mapName][sourceId] = missingId;
			expect(
				validateWithdrawalPackageBinding(missingTarget, [
					withdrawnPackage,
					reviewedReplacement,
				]),
				`${mapName}:${missingId}`,
			).toMatchObject({
				ok: false,
				issues: [
					expect.objectContaining({ ruleId: "E_WITHDRAWAL_REPLACEMENT" }),
				],
			});
		}

		const drifted = structuredClone(data.valid);
		drifted.replacement.package.integrity = `sha512-${Buffer.alloc(
			64,
			7,
		).toString("base64")}`;
		expect(
			validateWithdrawalPackageBinding(drifted, [
				withdrawnPackage,
				reviewedReplacement,
			]),
		).toMatchObject({
			ok: false,
			issues: [
				expect.objectContaining({ ruleId: "E_WITHDRAWAL_REPLACEMENT" }),
			],
		});
	});

	it("requires every object referencing an affected asset to be in the withdrawal", async () => {
		const data = await fixture<{
			valid: {
				package: PackageIdentity;
				affectedObjectIds: string[];
				affectedAssetIds: string[];
				replacement: {
					package: PackageIdentity;
					objectIdMap: Record<string, string>;
					assetIdMap: Record<string, string>;
				};
			};
		}>("withdrawal-cases.json");
		const currentPackage = {
			manifest: {
				name: data.valid.package.name,
				version: data.valid.package.version,
				assets: [
					{ assetId: "render" },
					{ assetId: "collider" },
					{ assetId: "goal-render" },
				],
				entries: [
					{
						objects: [
							{
								objectId: "starter-rock",
								renderAssetId: "render",
								colliderAssetId: "collider",
								lodAssetIds: [],
							},
							{
								objectId: "goal-stone",
								renderAssetId: "goal-render",
								lodAssetIds: [],
							},
						],
					},
				],
			},
			manifestSha256: data.valid.package.manifestSha256,
			artifact: { integrity: data.valid.package.integrity },
		};
		const incomplete = structuredClone(data.valid);
		incomplete.affectedAssetIds.push("goal-render");
		incomplete.replacement.assetIdMap["goal-render"] = "goal-render-v2";
		expect(
			validateWithdrawalPackageBinding(incomplete, [currentPackage]),
		).toMatchObject({
			ok: false,
			issues: [expect.objectContaining({ ruleId: "E_WITHDRAWAL_AFFECTED" })],
		});
	});

	it("rejects withdrawal object and asset IDs outside the exact bound manifest", async () => {
		const data = await fixture<{
			valid: {
				package: {
					name: string;
					version: string;
					integrity: string;
					manifestSha256: string;
				};
				affectedObjectIds: string[];
				affectedAssetIds: string[];
				replacement: {
					objectIdMap: Record<string, string>;
					assetIdMap: Record<string, string>;
				};
			};
		}>("withdrawal-cases.json");
		const currentPackage = {
			manifest: {
				name: data.valid.package.name,
				version: data.valid.package.version,
				assets: [{ assetId: "render" }, { assetId: "collider" }],
				entries: [
					{
						objects: [
							{
								objectId: "starter-rock",
								renderAssetId: "render",
								colliderAssetId: "collider",
								lodAssetIds: [],
							},
						],
					},
				],
			},
			manifestSha256: data.valid.package.manifestSha256,
			artifact: { integrity: data.valid.package.integrity },
		};
		for (const field of ["object", "asset"] as const) {
			const invalid = structuredClone(data.valid);
			if (field === "object") {
				invalid.affectedObjectIds = ["missing-object"];
				invalid.replacement.objectIdMap = { "missing-object": "replacement" };
			} else {
				invalid.affectedAssetIds = ["missing-asset"];
				invalid.replacement.assetIdMap = { "missing-asset": "replacement" };
			}
			expect(
				validateWithdrawalPackageBinding(invalid, [currentPackage]),
				field,
			).toMatchObject({
				ok: false,
				issues: [expect.objectContaining({ ruleId: "E_WITHDRAWAL_AFFECTED" })],
			});
		}
	});

	it("reaches the P02 catalog and withdraw-package dispatch while preserving save and history", async () => {
		const data = await fixture<{ valid: Record<string, unknown> }>(
			"withdrawal-cases.json",
		);
		const registry = createWithdrawalRegistryRecord(data.valid);
		const catalog = validateCatalogInstallEligibility(
			registry.catalogEligibility,
		);
		expect(catalog.ok).toBe(false);
		if (catalog.ok) throw new Error("Expected withdrawn catalog rejection");
		expect(catalog.issues.map((entry) => entry.ruleId)).toContain(
			"E_PACKAGE_WITHDRAWN",
		);

		const before = createOfflineState({
			activeLock: null,
			references: { save: 2, history: 1 },
			saves: { "save:fixture": { package: registry.packageKey } },
			knownGoodShell: "shell:p02",
		});
		before.transactionHistory["transaction:installed"] = {
			transactionId: "transaction:installed",
			state: "installed",
			baselineReferences: { save: 2, history: 1 },
		} as never;
		const after = applyOfflineEvent(before, registry.dispatch);
		expect(after.withdrawals[registry.packageKey]).toBe(
			registry.replacement?.packageKey,
		);
		expect(after.references).toEqual(before.references);
		expect(after.saves).toEqual(before.saves);
		expect(after.transactionHistory).toEqual(before.transactionHistory);
	});

	it("rejects unsafe or inexact withdrawal records", async () => {
		const data = await fixture<{
			valid: Record<string, unknown>;
			invalid: Case[];
		}>("withdrawal-cases.json");
		for (const testCase of data.invalid) {
			const result = validateWithdrawalRecord(candidate(data.valid, testCase));
			expect(result.ok, testCase.name).toBe(false);
			expect(
				result.issues.map((issue) => issue.ruleId),
				testCase.name,
			).toContain(testCase.expected);
		}
	});
});
