import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cp,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	rename,
	readFile,
	rm,
	symlink,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
	canonicalConfigSha256,
	type CanonicalConfigValue,
} from "../../tools/assets/lib/canonical-config.mjs";

import {
	checkProvenanceLedger,
	validatePackageLicensePolicy,
} from "../../tools/assets/lib/policy.mjs";
import {
	PROVENANCE_OUTPUT_LIMITS,
	type RetainedEvidenceDispatch,
	generateProvenanceLedger,
	provenanceRecordFileName,
	validateProvenanceOutputMetrics,
} from "../../tools/assets/lib/provenance-ledger.mjs";

const ROOT = process.cwd();
const FIXTURE_ROOT = join(ROOT, "tests", "fixtures", "assets");

interface CcByLedgerCase {
	readonly packageDirectory: string;
	readonly assetId: string;
	readonly license: "CC-BY-4.0";
	readonly licenseUrl: string;
	readonly author: string;
	readonly source: string;
	readonly attribution: string;
	readonly licenseText: string;
}

interface MutableAsset {
	assetId: string;
	path: string;
	bytes: number;
	sha256: string;
	license: string;
	licenseUrl: string;
	capturedLicenseSha256: string;
	provenance: {
		creator: string;
		provider?: string;
		source: string;
		sourceArtifactSha256: string;
		attribution: string;
		transformation: {
			tool: { name: string; version: string };
			config: Record<string, CanonicalConfigValue>;
			configSha256: string;
		};
	};
}

interface MutableSourceEvidence {
	[key: string]: unknown;
	archiveSha256: string;
	evidenceStatus: string;
	replacement?: unknown;
}

interface MutableManifest {
	name: string;
	license: string;
	assets: MutableAsset[];
	[key: string]: unknown;
}

interface PreparedLedgerRoot {
	readonly root: string;
	readonly contentRoot: string;
	readonly machineRoot: string;
	readonly ledgerPath: string;
	retainedEvidenceDispatch?: RetainedEvidenceDispatch[];
}


async function fixture(): Promise<CcByLedgerCase> {
	return JSON.parse(
		await readFile(join(FIXTURE_ROOT, "cc-by-ledger-case.json"), "utf8"),
	) as CcByLedgerCase;
}

async function preparedLedgerRoot(
	prefix = "infinite-snowball-license-policy-",
): Promise<PreparedLedgerRoot> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	const contentRoot = join(root, "content");
	const machineRoot = join(
		root,
		"docs",
		"licenses",
		"provenance",
		"records",
	);
	const ledgerPath = join(root, "docs", "licenses", "third-party-ledger.md");
	await cp(join(ROOT, "content"), contentRoot, { recursive: true });
	await mkdir(
		join(
			root,
			"docs",
			"licenses",
			"provenance",
			"infinite-snowball-original-content",
		),
		{ recursive: true },
	);
	await cp(
		join(
			ROOT,
			"docs",
			"licenses",
			"provenance",
			"infinite-snowball-original-content",
			"CC0-1.0.txt",
		),
		join(
			root,
			"docs",
			"licenses",
			"provenance",
			"infinite-snowball-original-content",
			"CC0-1.0.txt",
		),
	);
	await cp(
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
	);
	const modulePath = join(root, "tools", "assets", "lib", "asset-pipeline.mjs");
	await mkdir(dirname(modulePath), { recursive: true });
	const moduleBytes = await readFile(
		join(ROOT, "tools", "assets", "lib", "asset-pipeline.mjs"),
	);
	await writeFile(modulePath, moduleBytes);
	const moduleSha256 = createHash("sha256")
		.update(moduleBytes)
		.digest("hex");
	for (const packageEntry of await readdir(contentRoot, {
		withFileTypes: true,
	})) {
		if (!packageEntry.isDirectory()) continue;
		const manifestPath = join(
			contentRoot,
			packageEntry.name,
			"manifest.json",
		);
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		for (const asset of manifest.assets ?? []) {
			if (
				asset?.provenance?.creator ===
				"Infinite Snowball contributors"
			) {
				asset.provenance.sourceArtifactSha256 = moduleSha256;
			}
		}
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	}
	return { root, contentRoot, machineRoot, ledgerPath };
}

async function mutateManifest(
	prepared: PreparedLedgerRoot,
	packageDirectory: string,
	mutate: (manifest: MutableManifest) => void,
): Promise<MutableManifest> {
	const manifestPath = join(
		prepared.contentRoot,
		packageDirectory,
		"manifest.json",
	);
	const manifest = JSON.parse(
		await readFile(manifestPath, "utf8"),
	) as MutableManifest;
	mutate(manifest);
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return manifest;
}

async function ccByManifest(
	prepared: PreparedLedgerRoot,
	data: CcByLedgerCase,
): Promise<{ manifest: MutableManifest; textPath: string; textSha256: string }> {
	const textSha256 = createHash("sha256")
		.update(data.licenseText)
		.digest("hex");
	const textPath = `docs/licenses/provenance/cc-by-4.0/${textSha256}.txt`;
	const absoluteTextPath = join(prepared.root, textPath);
	await mkdir(dirname(absoluteTextPath), { recursive: true });
	await writeFile(absoluteTextPath, data.licenseText, "utf8");
	const sourceMember = "fixture/source.bin";
	const sourceFile = "source.bin";
	const sourceBytes = Buffer.from("reviewed CC BY fixture source", "utf8");
	const sourceSha256 = createHash("sha256")
		.update(sourceBytes)
		.digest("hex");
	const sourceRoot = "tools/assets/sources/cc-by-fixture";
	await mkdir(join(prepared.root, sourceRoot), { recursive: true });
	await writeFile(join(prepared.root, sourceRoot, sourceFile), sourceBytes);
	const manifest = await mutateManifest(
		prepared,
		data.packageDirectory,
		(candidate) => {
			candidate.license = data.license;
			const asset = candidate.assets.find(
				(entry) => entry.assetId === data.assetId,
			);
			if (!asset) throw new Error("CC BY fixture asset is missing");
			asset.license = data.license;
			asset.licenseUrl = data.licenseUrl;
			asset.capturedLicenseSha256 = textSha256;
			asset.provenance.creator = data.author;
			asset.provenance.source = data.source;
			asset.provenance.attribution = data.attribution;
			asset.provenance.sourceArtifactSha256 = sourceSha256;
			asset.provenance.transformation.config = {
				...asset.provenance.transformation.config,
				sourceMember,
			};
			asset.provenance.transformation.configSha256 =
				canonicalConfigSha256(
					asset.provenance.transformation.config,
				);
		},
	);
	prepared.retainedEvidenceDispatch = [
		{
			provider: data.author,
			sourceUrl: data.source,
			spdx: data.license,
			url: data.licenseUrl,
			sourceRoot,
			sourceFiles: [sourceFile],
			artifactPrefix: "cc-by-fixture.zip",
			sourceMembers: [
				{ member: sourceMember, file: sourceFile, sha256: sourceSha256 },
			],
			textPath,
			textSha256,
			grant: `Captured CC BY 4.0 license evidence for ${data.author} from ${data.source}; exact attribution retained.`,
		},
	];
	return { manifest, textPath, textSha256 };
}

async function outputSnapshot(prepared: PreparedLedgerRoot) {
	const files = (await readdir(prepared.machineRoot)).sort();
	return {
		ledger: await readFile(prepared.ledgerPath, "utf8"),
		machineRecords: await Promise.all(
			files.map(
				async (file): Promise<readonly [string, string]> => [
					file,
					await readFile(join(prepared.machineRoot, file), "utf8"),
				],
			),
		),
	};
}

async function generatedSnapshot(prepared: PreparedLedgerRoot) {
	const generated = await generateProvenanceLedger(prepared);
	return {
		ledgerSha256: generated.ledgerSha256,
		...(await outputSnapshot(prepared)),
	};
}

async function stageInterruptedProvenanceRecovery(
	prepared: PreparedLedgerRoot,
	transactionId: string,
) {
	await generatedSnapshot(prepared);
	const previous = await outputSnapshot(prepared);
	const machineParent = dirname(prepared.machineRoot);
	const ledgerParent = dirname(prepared.ledgerPath);
	const machineStage = `.provenance-records-${transactionId}.stage`;
	const machineBackup = `.provenance-records-${transactionId}.backup`;
	const ledgerStage = `.provenance-ledger-${transactionId}.stage`;
	const ledgerBackup = `.provenance-ledger-${transactionId}.backup`;
	const journalPath = join(
		ledgerParent,
		".provenance-ledger.transaction.json",
	);
	const lockPath = join(ledgerParent, ".provenance-ledger.lock");
	const recoveryPath = join(ledgerParent, ".provenance-ledger.recovery");
	await rename(prepared.machineRoot, join(machineParent, machineBackup));
	await mkdir(prepared.machineRoot);
	await writeFile(
		join(prepared.machineRoot, "interrupted.json"),
		"NEW_PARTIAL_OUTPUT",
		"utf8",
	);
	const journal = Buffer.from(
		`${JSON.stringify({
			version: 1,
			transactionId,
			machineStage,
			machineBackup,
			ledgerStage,
			ledgerBackup,
			hadMachine: true,
			hadLedger: true,
		})}\n`,
		"utf8",
	);
	const lock = Buffer.from(
		`${JSON.stringify({
			version: 1,
			pid: 2_147_483_647,
			transactionId,
		})}\n`,
		"utf8",
	);
	await writeFile(journalPath, journal);
	await writeFile(lockPath, lock);
	return {
		previous,
		journalPath,
		journal,
		lockPath,
		lock,
		recoveryPath,
	};
}

describe("P03 package license policy", () => {
	it("uses one frozen output budget for generator and checker preflight", () => {
		expect(Object.isFrozen(PROVENANCE_OUTPUT_LIMITS)).toBe(true);
		expect(
			validateProvenanceOutputMetrics({
				recordCount: 33,
				maxRecordBytes: 1,
				machineBytes: 33,
				humanLedgerBytes: 1,
			}),
		).toBe(true);
		expect(
			validateProvenanceOutputMetrics({
				recordCount: PROVENANCE_OUTPUT_LIMITS.maxRecords,
				maxRecordBytes: PROVENANCE_OUTPUT_LIMITS.maxRecordBytes,
				machineBytes: PROVENANCE_OUTPUT_LIMITS.maxMachineBytes,
				humanLedgerBytes: PROVENANCE_OUTPUT_LIMITS.maxHumanLedgerBytes,
			}),
		).toBe(true);
		for (const metrics of [
			{
				recordCount: PROVENANCE_OUTPUT_LIMITS.maxRecords + 1,
				maxRecordBytes: 1,
				machineBytes: 1,
				humanLedgerBytes: 1,
			},
			{
				recordCount: 1,
				maxRecordBytes: PROVENANCE_OUTPUT_LIMITS.maxRecordBytes + 1,
				machineBytes: 1,
				humanLedgerBytes: 1,
			},
			{
				recordCount: 1,
				maxRecordBytes: 1,
				machineBytes: PROVENANCE_OUTPUT_LIMITS.maxMachineBytes + 1,
				humanLedgerBytes: 1,
			},
			{
				recordCount: 1,
				maxRecordBytes: 1,
				machineBytes: 1,
				humanLedgerBytes:
					PROVENANCE_OUTPUT_LIMITS.maxHumanLedgerBytes + 1,
			},
		]) {
			expect(validateProvenanceOutputMetrics(metrics)).toBe(false);
		}
	});
	it.each(["CC0-1.0", "CC-BY-4.0"] as const)(
		"accepts and exposes the exact %s package license",
		(license) => {
			expect(
				validatePackageLicensePolicy({
					license,
					assets: [{ assetId: "fixture", license }],
				}),
			).toEqual({ ok: true, issues: [], license });
		},
	);

	it("allows a CC BY package to retain individually identified CC0 assets", () => {
		expect(
			validatePackageLicensePolicy({
				license: "CC-BY-4.0",
				assets: [
					{ assetId: "attributed", license: "CC-BY-4.0" },
					{ assetId: "dedicated", license: "CC0-1.0" },
				],
			}),
		).toEqual({ ok: true, issues: [], license: "CC-BY-4.0" });
	});

	it("rejects unsupported package licenses and asset/package license drift", () => {
		const unsupported = validatePackageLicensePolicy({
			license: "MIT",
			assets: [{ assetId: "fixture", license: "MIT" }],
		});
		expect(unsupported.ok).toBe(false);
		expect(unsupported.license).toBeUndefined();
		expect(unsupported.issues.map((entry) => entry.ruleId)).toContain(
			"E_PACKAGE_LICENSE",
		);

		const mismatched = validatePackageLicensePolicy({
			license: "CC0-1.0",
			assets: [{ assetId: "fixture", license: "CC-BY-4.0" }],
		});
		expect(mismatched.ok).toBe(false);
		expect(mismatched.license).toBeUndefined();
		expect(mismatched.issues.map((entry) => entry.ruleId)).toContain(
			"E_PACKAGE_LICENSE_MISMATCH",
		);
	});

	it("refuses to generate evidence for an unsupported manifest license", async () => {
		const prepared = await preparedLedgerRoot();
		try {
			await mutateManifest(prepared, "starter-campaign", (manifest) => {
				manifest.license = "MIT";
			});
			await expect(generateProvenanceLedger(prepared)).rejects.toThrow(
				/E_LEDGER_PACKAGE_LICENSE/u,
			);
		} finally {
			await rm(prepared.root, { recursive: true, force: true });
		}
	});

	it("rejects a protocol-invalid 29 MiB manifest field before retaining provenance output", async () => {
		const prepared = await preparedLedgerRoot();
		try {
			await mutateManifest(prepared, "starter-campaign", (manifest) => {
				manifest.version = "1".repeat(29 * 1024 * 1024);
			});
			await expect(generateProvenanceLedger(prepared)).rejects.toThrow(
				/E_LEDGER_CONTENT_INSPECTION.*E_LEDGER_PACKAGE_MANIFEST/u,
			);
			await expect(readdir(prepared.machineRoot)).rejects.toMatchObject({
				code: "ENOENT",
			});
			await expect(readFile(prepared.ledgerPath)).rejects.toMatchObject({
				code: "ENOENT",
			});
		} finally {
			await rm(prepared.root, { recursive: true, force: true });
		}
	});

	it("generates identical validated CC0 evidence on repeated runs", async () => {
		const prepared = await preparedLedgerRoot();
		try {
			const first = await generatedSnapshot(prepared);
			const second = await generatedSnapshot(prepared);
			expect(second).toEqual(first);
			const checked = await checkProvenanceLedger(prepared);
			expect(checked.issues).toEqual([]);
			for (const [, recordText] of second.machineRecords) {
				const record = JSON.parse(recordText);
				expect(record.packageLicense).toBe("CC0-1.0");
			}
		} finally {
			await rm(prepared.root, { recursive: true, force: true });
		}
	});

	it("restores exact prior provenance outputs when a staged commit fails", async () => {
		const prepared = await preparedLedgerRoot(
			".tmp-infinite-snowball-provenance-transaction-",
		);
		try {
			const previous = await generatedSnapshot(prepared);
			await mutateManifest(prepared, "starter-level", (manifest) => {
				const asset = manifest.assets[0];
				if (asset === undefined) throw new Error("missing level asset fixture");
				asset.provenance.attribution = "transaction replacement evidence";
			});

			await expect(
				generateProvenanceLedger({
					...prepared,
					transactionTestHook(boundary) {
						if (boundary === "after-machine-install") {
							throw new Error("INJECTED_PROVENANCE_COMMIT_FAILURE");
						}
					},
				}),
			).rejects.toThrow("INJECTED_PROVENANCE_COMMIT_FAILURE");

			const files = (await readdir(prepared.machineRoot)).sort();
			expect(await readFile(prepared.ledgerPath, "utf8")).toBe(
				previous.ledger,
			);
			expect(
				await Promise.all(
					files.map(
						async (file): Promise<readonly [string, string]> => [
							file,
							await readFile(join(prepared.machineRoot, file), "utf8"),
						],
					),
				),
			).toEqual(previous.machineRecords);
		} finally {
			await rm(prepared.root, { recursive: true, force: true });
		}
	});

	it("keeps committed provenance outputs when post-commit cleanup cannot finish", async () => {
		const prepared = await preparedLedgerRoot(
			".tmp-infinite-snowball-provenance-postcommit-",
		);
		const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		try {
			await rm(prepared.machineRoot, { recursive: true, force: true });
			await mkdir(prepared.machineRoot, { recursive: true });
			await writeFile(
				join(prepared.machineRoot, "previous.json"),
				"PREVIOUS_MACHINE_OUTPUT",
				"utf8",
			);
			await writeFile(
				prepared.ledgerPath,
				"PREVIOUS_HUMAN_LEDGER",
				"utf8",
			);

			const generated = await generateProvenanceLedger({
				...prepared,
				transactionTestHook(boundary) {
					if (boundary === "before-postcommit-cleanup") {
						throw new Error("INJECTED_POSTCOMMIT_CLEANUP_FAILURE");
					}
				},
			});

			expect(generated.records).toBeGreaterThan(0);
			expect(await readFile(prepared.ledgerPath, "utf8")).not.toBe(
				"PREVIOUS_HUMAN_LEDGER",
			);
			expect(await readdir(prepared.machineRoot)).not.toContain(
				"previous.json",
			);
			expect(warning).toHaveBeenCalledWith(
				"Committed provenance output cleanup was deferred.",
				{ code: "E_LEDGER_POSTCOMMIT_CLEANUP" },
			);
			expect(
				await lstat(
					join(
						dirname(prepared.ledgerPath),
						".provenance-ledger.lock",
					),
				),
			).toMatchObject({ nlink: 1 });
		} finally {
			warning.mockRestore();
			await rm(prepared.root, { recursive: true, force: true });
		}
	});

	it("recovers an interrupted machine install to the exact old outputs", async () => {
		const prepared = await preparedLedgerRoot(
			".tmp-infinite-snowball-provenance-recovery-",
		);
		const transactionId = "00000000-0000-4000-8000-000000000001";
		const machineParent = dirname(prepared.machineRoot);
		const ledgerParent = dirname(prepared.ledgerPath);
		const machineStage = `.provenance-records-${transactionId}.stage`;
		const machineBackup = `.provenance-records-${transactionId}.backup`;
		const ledgerStage = `.provenance-ledger-${transactionId}.stage`;
		const ledgerBackup = `.provenance-ledger-${transactionId}.backup`;
		const journalPath = join(
			ledgerParent,
			".provenance-ledger.transaction.json",
		);
		try {
			await generatedSnapshot(prepared);
			const previous = await outputSnapshot(prepared);
			await rename(
				prepared.machineRoot,
				join(machineParent, machineBackup),
			);
			await mkdir(prepared.machineRoot);
			await writeFile(
				join(prepared.machineRoot, "interrupted.json"),
				"NEW_PARTIAL_OUTPUT",
				"utf8",
			);
			await writeFile(
				journalPath,
				`${JSON.stringify({
					version: 1,
					transactionId,
					machineStage,
					machineBackup,
					ledgerStage,
					ledgerBackup,
					hadMachine: true,
					hadLedger: true,
				})}\n`,
				"utf8",
			);

			await expect(
				generateProvenanceLedger({
					...prepared,
					transactionTestHook(boundary) {
						if (boundary === "after-recovery") {
							throw new Error("INJECTED_AFTER_PROVENANCE_RECOVERY");
						}
					},
				}),
			).rejects.toThrow("INJECTED_AFTER_PROVENANCE_RECOVERY");
			expect(await outputSnapshot(prepared)).toEqual(previous);
			await expect(readFile(journalPath)).rejects.toMatchObject({
				code: "ENOENT",
			});
		} finally {
			await rm(prepared.root, { recursive: true, force: true });
		}
	});

	it("serializes concurrent stale provenance recovery with one atomic claim", async () => {
		const prepared = await preparedLedgerRoot(
			".tmp-infinite-snowball-provenance-claim-race-",
		);
		let releaseClaim = () => {};
		try {
			const state = await stageInterruptedProvenanceRecovery(
				prepared,
				"00000000-0000-4000-8000-000000000021",
			);
			let enterClaim!: () => void;
			const claimEntered = new Promise<void>((resolve) => {
				enterClaim = resolve;
			});
			const claimPaused = new Promise<void>((resolve) => {
				releaseClaim = resolve;
			});
			const first = generateProvenanceLedger({
				...prepared,
				async transactionTestHook(boundary) {
					if (boundary === "after-recovery-claim") {
						enterClaim();
						await claimPaused;
					}
					if (boundary === "after-recovery") {
						throw new Error("INJECTED_AFTER_PROVENANCE_RECOVERY");
					}
				},
			});
			const firstState = await Promise.race([
				claimEntered.then(() => "paused" as const),
				first.then(
					() => "completed" as const,
					() => "failed" as const,
				),
			]);
			try {
				expect(firstState).toBe("paused");
				const pausedOutputs = await outputSnapshot(prepared);
				await expect(generateProvenanceLedger(prepared)).rejects.toThrow(
					"E_LEDGER_TRANSACTION_LOCK",
				);
				expect(await outputSnapshot(prepared)).toEqual(pausedOutputs);
			} finally {
				releaseClaim();
			}
			await expect(first).rejects.toThrow(
				"INJECTED_AFTER_PROVENANCE_RECOVERY",
			);
			expect(await outputSnapshot(prepared)).toEqual(state.previous);
			await expect(readFile(state.journalPath)).rejects.toMatchObject({
				code: "ENOENT",
			});
		} finally {
			releaseClaim();
			await rm(prepared.root, { recursive: true, force: true });
		}
	});

	it("blocks stale provenance recovery when a recovery claim already exists", async () => {
		const prepared = await preparedLedgerRoot(
			".tmp-infinite-snowball-provenance-claim-block-",
		);
		try {
			const state = await stageInterruptedProvenanceRecovery(
				prepared,
				"00000000-0000-4000-8000-000000000022",
			);
			await mkdir(state.recoveryPath, { mode: 0o700 });
			const before = await outputSnapshot(prepared);

			await expect(generateProvenanceLedger(prepared)).rejects.toThrow(
				"E_LEDGER_TRANSACTION_LOCK",
			);
			expect(await outputSnapshot(prepared)).toEqual(before);
			expect(await readFile(state.journalPath)).toEqual(state.journal);
			expect(await readFile(state.lockPath)).toEqual(state.lock);
		} finally {
			await rm(prepared.root, { recursive: true, force: true });
		}
	});

	it("fails a live provenance writer lock without touching old outputs", async () => {
		const prepared = await preparedLedgerRoot(
			".tmp-infinite-snowball-provenance-lock-",
		);
		const lockPath = join(
			dirname(prepared.ledgerPath),
			".provenance-ledger.lock",
		);
		try {
			await generatedSnapshot(prepared);
			const previous = await outputSnapshot(prepared);
			await writeFile(
				lockPath,
				`${JSON.stringify({
					version: 1,
					pid: process.pid,
					transactionId: "00000000-0000-4000-8000-000000000002",
				})}\n`,
				"utf8",
			);
			await expect(generateProvenanceLedger(prepared)).rejects.toThrow(
				"E_LEDGER_TRANSACTION_LOCK",
			);
			expect(await outputSnapshot(prepared)).toEqual(previous);
		} finally {
			await rm(prepared.root, { recursive: true, force: true });
		}
	});

	it.each([
		["corrupt", Buffer.from("{not-json", "utf8")],
		["oversize", Buffer.alloc(4_097, 0x78)],
	])("fails closed on a %s provenance journal", async (_label, journal) => {
		const prepared = await preparedLedgerRoot(
			".tmp-infinite-snowball-provenance-journal-",
		);
		const journalPath = join(
			dirname(prepared.ledgerPath),
			".provenance-ledger.transaction.json",
		);
		try {
			await generatedSnapshot(prepared);
			const previous = await outputSnapshot(prepared);
			await writeFile(journalPath, journal);
			await expect(generateProvenanceLedger(prepared)).rejects.toThrow(
				"E_LEDGER_TRANSACTION_JOURNAL",
			);
			expect(await outputSnapshot(prepared)).toEqual(previous);
			expect(await readFile(journalPath)).toEqual(journal);
		} finally {
			await rm(prepared.root, { recursive: true, force: true });
		}
	});

	it.each([
		[
			"a missing fixed package directory",
			async (prepared: PreparedLedgerRoot) =>
				rm(join(prepared.contentRoot, "starter-campaign"), {
					recursive: true,
					force: true,
				}),
		],
		[
			"a malformed fixed package manifest",
			async (prepared: PreparedLedgerRoot) =>
				writeFile(
					join(prepared.contentRoot, "starter-campaign", "manifest.json"),
					"{not-json",
					"utf8",
				),
		],
	] as const)(
		"fails closed when %s and matching evidence is absent",
		async (_label, corruptPackage) => {
			const prepared = await preparedLedgerRoot();
			const packageName = "@infinite-snowball/starter-campaign";
			try {
				await generateProvenanceLedger(prepared);
				await rm(
					join(
						prepared.machineRoot,
						provenanceRecordFileName({
							packageName,
							assetId: "icon",
						}),
					),
				);
				const ledger = await readFile(prepared.ledgerPath, "utf8");
				await writeFile(
					prepared.ledgerPath,
					ledger
						.split(/\r?\n/u)
						.filter((line) => !line.includes(`asset:${packageName}:`))
						.join("\n"),
					"utf8",
				);
				await corruptPackage(prepared);
				const checked = await checkProvenanceLedger(prepared);
				expect(checked.ok).toBe(false);
				expect(checked.issues.map((entry) => entry.ruleId)).toContain(
					"E_LEDGER_PACKAGE_MANIFEST",
				);
			} finally {
				await rm(prepared.root, { recursive: true, force: true });
			}
		},
	);

	it.each([
		[
			"a traversal asset path",
			async (prepared: PreparedLedgerRoot) => {
				const bytes = Buffer.from("outside-runtime", "utf8");
				await writeFile(join(prepared.root, "outside.bin"), bytes);
				await mutateManifest(
					prepared,
					"starter-campaign",
					(manifest) => {
						const asset = manifest.assets[0];
						if (!asset) {
							throw new Error("Traversal fixture asset is missing");
						}
						asset.path = "../../outside.bin";
						asset.bytes = bytes.length;
						asset.sha256 = createHash("sha256").update(bytes).digest("hex");
					},
				);
			},
			"E_PATH_POLICY",
		],
		[
			"a symlinked declared asset",
			async (prepared: PreparedLedgerRoot) => {
				const path = join(
					prepared.contentRoot,
					"starter-campaign",
					"assets",
					"icon.png",
				);
				const outside = join(prepared.root, "outside-icon.png");
				await writeFile(outside, await readFile(path));
				await rm(path);
				await symlink(outside, path);
			},
			"E_PATH_POLICY",
		],
		[
			"a non-NFC undeclared asset",
			async (prepared: PreparedLedgerRoot) => {
				await writeFile(
					join(
						prepared.contentRoot,
						"starter-campaign",
						"assets",
						"cafe\u0301.png",
					),
					"orphan",
				);
			},
			"E_PATH_POLICY",
		],
		[
			"a top-level orphan file",
			async (prepared: PreparedLedgerRoot) => {
				await writeFile(join(prepared.contentRoot, "orphan.json"), "{}\n");
			},
			"E_LEDGER_CONTENT_ORPHAN",
		],
	] as const)(
		"rejects %s before provenance reads",
		async (_label, mutateContent, expectedRule) => {
			const prepared = await preparedLedgerRoot();
			try {
				await generateProvenanceLedger(prepared);
				await mutateContent(prepared);
				const checked = await checkProvenanceLedger(prepared);
				expect(checked.ok).toBe(false);
				expect(checked.issues.map((entry) => entry.ruleId)).toContain(
					expectedRule,
				);
			} finally {
				await rm(prepared.root, { recursive: true, force: true });
			}
		},
	);

	it.each(["header", "policy footer"] as const)(
		"rejects a falsified human ledger %s outside asset rows",
		async (section) => {
			const prepared = await preparedLedgerRoot();
			try {
				await generateProvenanceLedger(prepared);
				const ledger = await readFile(prepared.ledgerPath, "utf8");
				const falsified =
					section === "header"
						? ledger.replace(
								"# Infinite Snowball starter-content provenance ledger",
								"# Falsified provenance ledger",
							)
						: ledger.replace(
								"- No commercial soundtrack files, franchise assets, user ratings, or store-install claims are included.",
								"- Falsified policy.",
							);
				await writeFile(prepared.ledgerPath, falsified, "utf8");
				const checked = await checkProvenanceLedger(prepared);
				expect(checked.ok).toBe(false);
				expect(checked.issues.map((entry) => entry.ruleId)).toContain(
					"E_LEDGER_HUMAN_STALE",
				);
			} finally {
				await rm(prepared.root, { recursive: true, force: true });
			}
		},
	);

	it.each(["renamed", "nested"] as const)(
		"rejects a %s machine record path even when embedded JSON is canonical",
		async (variant) => {
			const prepared = await preparedLedgerRoot();
			try {
				await generateProvenanceLedger(prepared);
				const source = join(
					prepared.machineRoot,
					(await readdir(prepared.machineRoot)).sort()[0] as string,
				);
				const destination =
					variant === "nested"
						? join(prepared.machineRoot, "nested", "record.json")
						: join(prepared.machineRoot, "renamed.json");
				await mkdir(dirname(destination), { recursive: true });
				await rename(source, destination);
				const checked = await checkProvenanceLedger(prepared);
				expect(checked.ok).toBe(false);
				expect(checked.issues.map((entry) => entry.ruleId)).toContain(
					"E_LEDGER_MACHINE_PATH",
				);
			} finally {
				await rm(prepared.root, { recursive: true, force: true });
			}
		},
	);

	it.each(["duplicate-key", "reordered"] as const)(
		"rejects %s machine JSON even when it parses to the canonical record",
		async (variant) => {
			const prepared = await preparedLedgerRoot();
			try {
				await generateProvenanceLedger(prepared);
				const [recordFile] = (await readdir(prepared.machineRoot)).sort();
				if (recordFile === undefined) {
					throw new Error("machine record fixture is missing");
				}
				const recordPath = join(prepared.machineRoot, recordFile);
				const canonical = await readFile(recordPath, "utf8");
				const corrupted =
					variant === "duplicate-key"
						? canonical.replace(
								"{\n",
								'{\n  "evidenceStatus": "withdrawn",\n',
							)
						: `${JSON.stringify(
								Object.fromEntries(
									Object.entries(JSON.parse(canonical)).reverse(),
								),
								null,
								2,
							)}\n`;
				await writeFile(recordPath, corrupted, "utf8");
				const checked = await checkProvenanceLedger(prepared);
				expect(checked.ok).toBe(false);
				expect(checked.issues.map((entry) => entry.ruleId)).toContain(
					"E_LEDGER_MACHINE_NONCANONICAL",
				);
			} finally {
				await rm(prepared.root, { recursive: true, force: true });
			}
		},
	);

	it.each([
		[
			"a deeply nested record",
			async (prepared: PreparedLedgerRoot) => {
				const path = join(
					prepared.machineRoot,
					"nested",
					"deeper",
					"record.json",
				);
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, "{}", "utf8");
			},
		],
		[
			"an oversized record",
			async (prepared: PreparedLedgerRoot) => {
				const path = join(prepared.machineRoot, "oversized.json");
				await writeFile(path, "");
				await truncate(
					path,
					PROVENANCE_OUTPUT_LIMITS.maxRecordBytes + 1,
				);
			},
		],
	] as const)(
		"bounds machine record inventory against %s",
		async (_label, corrupt) => {
			const prepared = await preparedLedgerRoot();
			try {
				await generateProvenanceLedger(prepared);
				await corrupt(prepared);
				const checked = await checkProvenanceLedger(prepared);
				expect(checked.ok).toBe(false);
				expect(
					checked.issues.map((entry) => entry.ruleId),
				).toContain("E_LEDGER_MACHINE_INVENTORY");
			} finally {
				await rm(prepared.root, { recursive: true, force: true });
			}
		},
	);

	it.each([
		["machine parent", "machine-parent"],
		["machine target", "machine-target"],
		["ledger parent", "ledger-parent"],
		["ledger target", "ledger-target"],
	] as const)(
		"rejects a symlinked %s without modifying the external sentinel",
		async (_label, variant) => {
			const prepared = await preparedLedgerRoot();
			const external = await mkdtemp(
				join(tmpdir(), "infinite-snowball-ledger-output-"),
			);
			const sentinelPath = join(external, "sentinel.txt");
			const sentinel = `sentinel:${variant}`;
			await writeFile(sentinelPath, sentinel, "utf8");
			try {
				if (variant === "machine-parent") {
					const parent = join(
						prepared.root,
						"docs",
						"licenses",
						"provenance",
					);
					await rm(parent, { recursive: true, force: true });
					await symlink(external, parent, "dir");
				} else if (variant === "ledger-parent") {
					const parent = join(prepared.root, "docs", "licenses");
					await rm(parent, { recursive: true, force: true });
					await symlink(external, parent, "dir");
				} else if (variant === "machine-target") {
					await mkdir(dirname(prepared.machineRoot), { recursive: true });
					await symlink(external, prepared.machineRoot, "dir");
				} else {
					await mkdir(dirname(prepared.ledgerPath), { recursive: true });
					await symlink(sentinelPath, prepared.ledgerPath, "file");
				}
				await expect(
					generateProvenanceLedger(prepared),
				).rejects.toThrow(/E_LEDGER_OUTPUT_PATH/u);
				expect(await readFile(sentinelPath, "utf8")).toBe(sentinel);
			} finally {
				await rm(prepared.root, { recursive: true, force: true });
				await rm(external, { recursive: true, force: true });
			}
		},
	);

	it("atomically replaces a hardlinked human-ledger target without mutating the outside inode", async () => {
		const prepared = await preparedLedgerRoot();
		const external = await mkdtemp(
			join(tmpdir(), "infinite-snowball-ledger-hardlink-"),
		);
		const sentinelPath = join(external, "sentinel.md");
		const sentinel = "OUTSIDE_LEDGER_SENTINEL";
		try {
			await mkdir(dirname(prepared.ledgerPath), { recursive: true });
			await writeFile(sentinelPath, sentinel, "utf8");
			await link(sentinelPath, prepared.ledgerPath);

			await generateProvenanceLedger(prepared);

			expect(await readFile(sentinelPath, "utf8")).toBe(sentinel);
			expect(await readFile(prepared.ledgerPath, "utf8")).toContain(
				"# Infinite Snowball starter-content provenance ledger",
			);
		} finally {
			await rm(prepared.root, { recursive: true, force: true });
			await rm(external, { recursive: true, force: true });
		}
	});

	it.each([
		["machineRoot", "package.json"],
		["ledgerPath", "templates/package-template.json"],
	] as const)(
		"does not permit %s to overwrite a contained non-output sentinel",
		async (field, relativePath) => {
			const prepared = await preparedLedgerRoot();
			const sentinelPath = join(prepared.root, relativePath);
			const sentinel = `sentinel:${field}`;
			try {
				await mkdir(dirname(sentinelPath), { recursive: true });
				await writeFile(sentinelPath, sentinel, "utf8");
				const options =
					field === "machineRoot"
						? { ...prepared, machineRoot: sentinelPath }
						: { ...prepared, ledgerPath: sentinelPath };
				await expect(
					generateProvenanceLedger(options),
				).rejects.toThrow(/E_LEDGER_OUTPUT_PATH/u);
				expect(await readFile(sentinelPath, "utf8")).toBe(sentinel);
			} finally {
				await rm(prepared.root, { recursive: true, force: true });
			}
		},
	);

	it.each(["symlink", "fifo", "oversized"] as const)(
		"rejects a %s human ledger through the bounded canonical checker",
		async (variant) => {
			const prepared = await preparedLedgerRoot();
			const external = await mkdtemp(
				join(tmpdir(), "infinite-snowball-human-ledger-"),
			);
			const sentinelPath = join(external, "sentinel.md");
			const sentinel = `sentinel:${variant}`;
			try {
				await generateProvenanceLedger(prepared);
				await rm(prepared.ledgerPath, { force: true });
				if (variant === "symlink") {
					await writeFile(sentinelPath, sentinel, "utf8");
					await symlink(sentinelPath, prepared.ledgerPath, "file");
				} else if (variant === "fifo") {
					const created = spawnSync("mkfifo", [prepared.ledgerPath]);
					if (created.status !== 0) {
						throw new Error("mkfifo fixture setup failed");
					}
				} else {
					await writeFile(prepared.ledgerPath, "");
					await truncate(
						prepared.ledgerPath,
						PROVENANCE_OUTPUT_LIMITS.maxHumanLedgerBytes + 1,
					);
				}
				const checked = await checkProvenanceLedger(prepared);
				expect(checked.ok).toBe(false);
				expect(
					checked.issues.map((entry) => entry.ruleId),
				).toContain("E_LEDGER_HUMAN_MISSING");
				if (variant === "symlink") {
					expect(await readFile(sentinelPath, "utf8")).toBe(sentinel);
				}
			} finally {
				await rm(prepared.root, { recursive: true, force: true });
				await rm(external, { recursive: true, force: true });
			}
		},
	);

	it("dispatches fully evidenced CC BY into deterministic machine and human ledgers", async () => {
		const prepared = await preparedLedgerRoot();
		const data = await fixture();
		try {
			const { manifest, textPath, textSha256 } = await ccByManifest(
				prepared,
				data,
			);
			const first = await generatedSnapshot(prepared);
			const second = await generatedSnapshot(prepared);
			expect(second).toEqual(first);
			const recordPath = join(
				prepared.machineRoot,
				provenanceRecordFileName({
					packageName: manifest.name,
					assetId: data.assetId,
				}),
			);
			const record = JSON.parse(await readFile(recordPath, "utf8"));
			expect(record).toMatchObject({
				packageLicense: data.license,
				provider: data.author,
				creator: data.author,
				sourceUrl: data.source,
				license: {
					spdx: data.license,
					url: data.licenseUrl,
					textPath,
					textSha256,
					author: data.author,
					source: data.source,
				},
			});
			const checked = await checkProvenanceLedger(prepared);
			expect(checked.issues).toEqual([]);
		} finally {
			await rm(prepared.root, { recursive: true, force: true });
		}
	});

	it("matches a real retained source across one trailing DNS root dot", async () => {
		const prepared = await preparedLedgerRoot();
		const data = await fixture();
		try {
			await ccByManifest(prepared, data);
			const retained = prepared.retainedEvidenceDispatch?.[0];
			if (!retained) throw new Error("CC BY retained dispatch is missing");
			const sourceUrl = new URL(retained.sourceUrl);
			sourceUrl.hostname = `${sourceUrl.hostname}.`;
			prepared.retainedEvidenceDispatch = [
				{ ...retained, sourceUrl: sourceUrl.href },
			];
			await expect(generateProvenanceLedger(prepared)).resolves.toMatchObject({
				records: expect.any(Number),
			});
		} finally {
			await rm(prepared.root, { recursive: true, force: true });
		}
	});

	it.each([
		[
			"external source",
			(asset: MutableAsset): void => {
				asset.provenance.source = "https://example.com/forged-original";
			},
		],
		[
			"forged generator identity",
			(asset: MutableAsset): void => {
				asset.provenance.transformation.tool.name = "forged-generator";
			},
		],
	] as const)(
		"rejects project-original creator text with a %s",
		async (_label, mutate) => {
			const prepared = await preparedLedgerRoot();
			try {
				await mutateManifest(
					prepared,
					"starter-campaign",
					(manifest) => {
						const asset = manifest.assets.find(
							(entry) => entry.assetId === "icon",
						);
						if (!asset) throw new Error("Original fixture is missing");
						mutate(asset);
					},
				);
				await expect(
					generateProvenanceLedger(prepared),
				).rejects.toThrow(/E_LEDGER_LICENSE_EVIDENCE/u);
			} finally {
				await rm(prepared.root, { recursive: true, force: true });
			}
		},
	);

	it("rejects mutated project CC0 dedication bytes before creating outputs", async () => {
		const prepared = await preparedLedgerRoot();
		try {
			await writeFile(
				join(
					prepared.root,
					"docs",
					"licenses",
					"provenance",
					"infinite-snowball-original-content",
					"CC0-1.0.txt",
				),
				"mutated dedication",
				"utf8",
			);
			await expect(generateProvenanceLedger(prepared)).rejects.toThrow(
				/E_LEDGER_LICENSE_EVIDENCE/u,
			);
			await expect(readdir(prepared.machineRoot)).rejects.toMatchObject({
				code: "ENOENT",
			});
		} finally {
			await rm(prepared.root, { recursive: true, force: true });
		}
	});

	it("validates live retained Kenney GLB and preview members", async () => {
		const prepared = await preparedLedgerRoot();
		try {
			const snapshot = await generatedSnapshot(prepared);
			const records = snapshot.machineRecords.map(([, text]) =>
				JSON.parse(text),
			);
			expect(records).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						assetId: "model",
						sourceArtifact:
							"kenney-nature-kit.zip#Models/GLTF format/rock_smallA.glb",
						sourceArtifactSha256:
							"df9fff9d711e61370e8df0caa2514c89b8f8a8dc6c6fafaf4eb2ec79c5ae07c1",
					}),
					expect.objectContaining({
						assetId: "shot",
						sourceArtifact:
							"kenney-nature-kit.zip#Isometric/rock_smallA_NE.png",
						sourceArtifactSha256:
							"9ac0749d7657e4b46020e260ef0b8b09c2a829fb2950fdcc1f64b9ffcdd77875",
					}),
				]),
			);
			expect((await checkProvenanceLedger(prepared)).issues).toEqual([]);
		} finally {
			await rm(prepared.root, { recursive: true, force: true });
		}
	});

	it.each(["rock_smallA.glb", "rock_smallA-preview.png"] as const)(
		"rejects retained source byte drift in %s",
		async (fileName) => {
			const prepared = await preparedLedgerRoot();
			try {
				await writeFile(
					join(
						prepared.root,
						"tools",
						"assets",
						"sources",
						"kenney-nature-kit",
						fileName,
					),
					Buffer.from("drift", "utf8"),
				);
				await expect(
					generateProvenanceLedger(prepared),
				).rejects.toThrow(/E_LEDGER_LICENSE_EVIDENCE/u);
			} finally {
				await rm(prepared.root, { recursive: true, force: true });
			}
		},
	);

	it("rejects unexpected retained bundle members", async () => {
		const prepared = await preparedLedgerRoot();
		try {
			await writeFile(
				join(
					prepared.root,
					"tools",
					"assets",
					"sources",
					"kenney-nature-kit",
					"unexpected.bin",
				),
				"unexpected",
				"utf8",
			);
			await expect(generateProvenanceLedger(prepared)).rejects.toThrow(
				/E_LEDGER_LICENSE_EVIDENCE/u,
			);
		} finally {
			await rm(prepared.root, { recursive: true, force: true });
		}
	});

	it.each(["missing retained source bytes", "unknown retained member"] as const)(
		"rejects CC BY with %s",
		async (variant) => {
			const prepared = await preparedLedgerRoot();
			const data = await fixture();
			try {
				await ccByManifest(prepared, data);
				if (variant === "missing retained source bytes") {
					await rm(
						join(
							prepared.root,
							"tools",
							"assets",
							"sources",
							"cc-by-fixture",
							"source.bin",
						),
					);
				} else {
					await mutateManifest(
						prepared,
						data.packageDirectory,
						(manifest) => {
							const asset = manifest.assets.find(
								(entry) => entry.assetId === data.assetId,
							);
							if (!asset) {
								throw new Error("Retained source fixture asset is missing");
							}
							asset.provenance.transformation.config.sourceMember =
								"fixture/spoof.bin";
							asset.provenance.transformation.configSha256 =
								canonicalConfigSha256(
									asset.provenance.transformation.config,
								);
						},
					);
				}
				await expect(
					generateProvenanceLedger(prepared),
				).rejects.toThrow(/E_LEDGER_LICENSE_EVIDENCE/u);
			} finally {
				await rm(prepared.root, { recursive: true, force: true });
			}
		},
	);

	it.each([
		"extra-field",
		"fabricated-archive-sha",
		"withdrawn-status",
		"missing-replacement",
		"duplicate-key",
		"noncanonical-bytes",
	] as const)(
		"rejects retained source evidence with %s",
		async (variant) => {
			const prepared = await preparedLedgerRoot();
			const evidencePath = join(
				prepared.root,
				"tools",
				"assets",
				"sources",
				"kenney-nature-kit",
				"source-evidence.json",
			);
			try {
				const canonical = await readFile(evidencePath, "utf8");
				const evidence = JSON.parse(canonical) as MutableSourceEvidence;
				let corrupted: string;
				if (variant === "extra-field") {
					evidence["unreviewed"] = true;
					corrupted = `${JSON.stringify(evidence, null, "\t")}\n`;
				} else if (variant === "fabricated-archive-sha") {
					evidence.archiveSha256 = "0".repeat(64);
					corrupted = `${JSON.stringify(evidence, null, "\t")}\n`;
				} else if (variant === "withdrawn-status") {
					evidence.evidenceStatus = "withdrawn";
					corrupted = `${JSON.stringify(evidence, null, "\t")}\n`;
				} else if (variant === "missing-replacement") {
					delete evidence.replacement;
					corrupted = `${JSON.stringify(evidence, null, "\t")}\n`;
				} else if (variant === "duplicate-key") {
					corrupted = canonical.replace(
						"{\n",
						`{\n\t"archiveSha256": "${"0".repeat(64)}",\n`,
					);
				} else {
					corrupted = `${JSON.stringify(evidence, null, 2)}\n`;
				}
				await writeFile(evidencePath, corrupted, "utf8");
				await expect(
					generateProvenanceLedger(prepared),
				).rejects.toThrow(/E_LEDGER_LICENSE_EVIDENCE/u);
			} finally {
				await rm(prepared.root, { recursive: true, force: true });
			}
		},
	);

	it("binds a non-Kenney third-party CC0 provider to reviewed retained license evidence", async () => {
		const prepared = await preparedLedgerRoot();
		const licenseText = "Creative Commons CC0 1.0 Universal\nKayKit fixture.\n";
		const textSha256 = createHash("sha256")
			.update(licenseText)
			.digest("hex");
		const sourceBytes = Buffer.from("reviewed KayKit source asset", "utf8");
		const sourceSha256 = createHash("sha256")
			.update(sourceBytes)
			.digest("hex");
		const sourceMember = "Models/reviewed-source.bin";
		const reviewedEvidence: RetainedEvidenceDispatch = {
			provider: "KayKit",
			sourceUrl: "https://kaylousberg.com/game-assets",
			spdx: "CC0-1.0",
			url: "https://creativecommons.org/publicdomain/zero/1.0/",
			sourceRoot: "tools/assets/sources/kaykit-test",
			sourceFiles: ["License.txt", "reviewed-source.bin"],
			artifactPrefix: "kaykit-reviewed.zip",
			sourceMembers: [
				{
					member: sourceMember,
					file: "reviewed-source.bin",
					sha256: sourceSha256,
				},
			],
			textPath: "tools/assets/sources/kaykit-test/License.txt",
			textSha256,
			grant:
				"Captured CC0 1.0 dedication from the exact reviewed KayKit source evidence.",
		};
		const options: PreparedLedgerRoot = {
			...prepared,
			retainedEvidenceDispatch: [reviewedEvidence],
		};
		try {
			await mkdir(
				join(prepared.root, "tools", "assets", "sources", "kaykit-test"),
				{ recursive: true },
			);
			await writeFile(
				join(prepared.root, reviewedEvidence.textPath),
				licenseText,
				"utf8",
			);
			await writeFile(
				join(
					prepared.root,
					reviewedEvidence.sourceRoot,
					"reviewed-source.bin",
				),
				sourceBytes,
			);
			const manifest = await mutateManifest(
				prepared,
				"starter-character",
				(candidate) => {
					const asset = candidate.assets.find(
						(entry) => entry.assetId === "icon",
					);
					if (!asset) throw new Error("KayKit fixture asset is missing");
					asset.provenance.creator = reviewedEvidence.provider;
					asset.provenance.source = reviewedEvidence.sourceUrl;
					asset.provenance.sourceArtifactSha256 = sourceSha256;
					asset.provenance.transformation.config = {
						...asset.provenance.transformation.config,
						sourceMember,
					};
					asset.provenance.transformation.configSha256 =
						canonicalConfigSha256(
							asset.provenance.transformation.config,
						);
					asset.capturedLicenseSha256 = textSha256;
				},
			);
			await generateProvenanceLedger(options);
			const recordPath = join(
				prepared.machineRoot,
				provenanceRecordFileName({
					packageName: manifest.name,
					assetId: "icon",
				}),
			);
			const record = JSON.parse(await readFile(recordPath, "utf8"));
			expect(record).toMatchObject({
				provider: reviewedEvidence.provider,
				creator: reviewedEvidence.provider,
				sourceUrl: reviewedEvidence.sourceUrl,
				license: {
					spdx: reviewedEvidence.spdx,
					url: reviewedEvidence.url,
					textPath: reviewedEvidence.textPath,
					textSha256: reviewedEvidence.textSha256,
					grant: reviewedEvidence.grant,
				},
			});
			const checked = await checkProvenanceLedger(options);
			expect(checked.issues).toEqual([]);
		} finally {
			await rm(prepared.root, { recursive: true, force: true });
		}
	});

	it.each([
		[
			"author",
			(asset: MutableAsset): void => {
				asset.provenance.creator = "Different Original Artist";
			},
		],
		[
			"source",
			(asset: MutableAsset): void => {
				asset.provenance.source = "http://example.com/insecure-source";
			},
		],
		[
			"original source distinct from the license URL",
			(asset: MutableAsset): void => {
				asset.provenance.source =
					"https://creativecommons.org/licenses/by/4.0/";
			},
		],
		[
			"license URL",
			(asset: MutableAsset): void => {
				asset.licenseUrl = "https://example.com/not-the-cc-by-license";
			},
		],
	] as const)("rejects CC BY evidence without its exact %s", async (_field, mutate) => {
		const prepared = await preparedLedgerRoot();
		const data = await fixture();
		try {
			await ccByManifest(prepared, data);
			await mutateManifest(prepared, data.packageDirectory, (manifest) => {
				const asset = manifest.assets.find(
					(entry) => entry.assetId === data.assetId,
				);
				if (!asset) throw new Error("CC BY fixture asset is missing");
				mutate(asset);
			});
			await expect(generateProvenanceLedger(prepared)).rejects.toThrow(
				/E_LEDGER_LICENSE_EVIDENCE/u,
			);
		} finally {
			await rm(prepared.root, { recursive: true, force: true });
		}
	});

	it.each([
		"https://creativecommons.org/licenses/by/4.0/?candidate=1",
		"https://CREATIVECOMMONS.ORG:443/licenses/by/4.0#original",
		"https://creativecommons.org./licenses/by/4.0/",
	])(
		"rejects a retained CC BY dispatch whose source is license-equivalent: %s",
		async (sourceUrl) => {
			const prepared = await preparedLedgerRoot();
			const data = await fixture();
			try {
				await ccByManifest(prepared, data);
				await mutateManifest(
					prepared,
					data.packageDirectory,
					(manifest) => {
						const asset = manifest.assets.find(
							(entry) => entry.assetId === data.assetId,
						);
						if (!asset) {
							throw new Error("CC BY fixture asset is missing");
						}
						asset.provenance.source = sourceUrl;
					},
				);
				const retained = prepared.retainedEvidenceDispatch?.[0];
				if (!retained) {
					throw new Error("CC BY retained dispatch is missing");
				}
				prepared.retainedEvidenceDispatch = [
					{ ...retained, sourceUrl },
				];
				await expect(
					generateProvenanceLedger(prepared),
				).rejects.toThrow(/E_LEDGER_LICENSE_EVIDENCE/u);
			} finally {
				await rm(prepared.root, { recursive: true, force: true });
			}
		},
	);
});
