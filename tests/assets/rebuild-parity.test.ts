import { execFile } from "node:child_process";
import {
	cp,
	lstat,
	mkdtemp,
	mkdir,
	readFile,
	realpath,
	rm,
	rename,
	symlink,
	writeFile,
	truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import { runRebuildStarter } from "../../tools/assets/rebuild-starter.mjs";
import {
	contentDigest,
	verifyStarterHashes,
} from "../../tools/assets/lib/asset-pipeline.mjs";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const CHECK_SCRIPT = join(ROOT, "tools", "assets", "rebuild-check.mjs");
const temporaryRoots: string[] = [];

async function copiedRoot(): Promise<string> {
	const root = await mkdtemp(
		join(tmpdir(), ".tmp-infinite-snowball-rebuild-parity-"),
	);
	temporaryRoots.push(root);
	await mkdir(join(root, "tests", "fixtures", "assets"), { recursive: true });
	await Promise.all([
		cp(join(ROOT, "package.json"), join(root, "package.json")),
		cp(join(ROOT, "content"), join(root, "content"), { recursive: true }),
		cp(join(ROOT, "docs", "assets"), join(root, "docs", "assets"), {
			recursive: true,
		}),
		cp(join(ROOT, "docs", "brand"), join(root, "docs", "brand"), {
			recursive: true,
		}),
		cp(join(ROOT, "docs", "licenses"), join(root, "docs", "licenses"), {
			recursive: true,
		}),
		cp(join(ROOT, "docs", "music"), join(root, "docs", "music"), {
			recursive: true,
		}),
		cp(
			join(ROOT, "packages", "protocol", "dist"),
			join(root, "packages", "protocol", "dist"),
			{ recursive: true },
		),
		cp(join(ROOT, "tools", "assets"), join(root, "tools", "assets"), {
			recursive: true,
		}),
		cp(
			join(ROOT, "tests", "fixtures", "assets", "local-audio-cases.json"),
			join(root, "tests", "fixtures", "assets", "local-audio-cases.json"),
		),
	]);
	await symlink(
		await realpath(join(ROOT, "packages", "protocol", "node_modules")),
		join(root, "packages", "protocol", "node_modules"),
	);
	await symlink(
		await realpath(join(ROOT, "node_modules")),
		join(root, "node_modules"),
	);
	return root;
}

function preloadEnvironment(
	preloadPath: string,
	values: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	return {
		...process.env,
		...values,
		NODE_OPTIONS: [
			process.env.NODE_OPTIONS,
			`--import=${pathToFileURL(preloadPath).href}`,
		]
			.filter(Boolean)
			.join(" "),
	};
}

const READ_PROBE = "REBUILD_LIMIT_READ_PROBE";

async function writeProbeFiles(
	root: string,
	relativeRoot: string,
	count: number,
	prefix: string,
	contents = READ_PROBE,
): Promise<void> {
	const directory = join(root, ...relativeRoot.split("/"));
	await mkdir(directory, { recursive: true });
	for (let index = 0; index < count; index += 1) {
		await writeFile(
			join(directory, `${prefix}-${String(index).padStart(4, "0")}.bin`),
			contents,
			"utf8",
		);
	}
}

async function installReadProbe(root: string): Promise<{
	env: NodeJS.ProcessEnv;
	markerPath: string;
}> {
	const preloadPath = join(root, "mark-bounded-snapshot-read.mjs");
	const markerPath = join(root, "bounded-snapshot-read.txt");
	await writeFile(
		preloadPath,
		`import { writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
const marker = Buffer.from(${JSON.stringify(READ_PROBE)}, "utf8");
const probe = await open(new URL(import.meta.url), "r");
const fileHandlePrototype = Object.getPrototypeOf(probe);
await probe.close();
const originalRead = fileHandlePrototype.read;
fileHandlePrototype.read = async function (...args) {
	const result = await originalRead.apply(this, args);
	const buffer = args[0];
	if (
		result.bytesRead >= marker.length &&
		Buffer.isBuffer(buffer) &&
		buffer.subarray(0, marker.length).equals(marker)
	) {
		writeFileSync(process.env.REBUILD_LIMIT_READ_MARKER, "used");
	}
	return result;
};
`,
		"utf8",
	);
	return {
		env: preloadEnvironment(preloadPath, {
			REBUILD_LIMIT_READ_MARKER: markerPath,
		}),
		markerPath,
	};
}

async function expectSnapshotBoundFailure(
	root: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	await expect(
		execFileAsync(
			process.execPath,
			[join(root, "tools", "assets", "rebuild-check.mjs")],
			{ cwd: root, env, timeout: 30_000 },
		),
	).rejects.toMatchObject({
		stderr: expect.stringContaining(
			"E_REBUILD_PARITY generated outputs exceed inspection bounds",
		),
	});
}

async function expectInputFailure(
	root: string,
	message: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	await expect(
		execFileAsync(
			process.execPath,
			[join(root, "tools", "assets", "rebuild-check.mjs")],
			{ cwd: root, env, timeout: 30_000 },
		),
	).rejects.toMatchObject({
		stderr: expect.stringContaining(message),
	});
}

async function stageInterruptedRebuildRecovery(
	root: string,
	transactionId: string,
) {
	await runRebuildStarter({ root });
	const manifestPath = join(root, "content", "starter-level", "manifest.json");
	const previousManifest = await readFile(manifestPath);
	const transactionRoot = `.tmp-infinite-snowball-${transactionId}`;
	const transactionPath = join(root, transactionRoot);
	const journalPath = join(
		root,
		".infinite-snowball-rebuild.transaction.json",
	);
	const lockPath = join(root, ".infinite-snowball-rebuild.lock");
	const recoveryPath = join(root, ".infinite-snowball-rebuild.recovery");
	await mkdir(transactionPath);
	await rename(
		join(root, "content"),
		join(transactionPath, "previous-content"),
	);
	await mkdir(join(root, "content"));
	await writeFile(
		join(root, "content", "interrupted-output.txt"),
		"NEW_PARTIAL_CONTENT",
		"utf8",
	);
	const journal = Buffer.from(
		`${JSON.stringify({
			version: 1,
			transactionId,
			transactionRoot,
			contentStage: "content",
			contentBackup: "previous-content",
			hadContent: true,
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
		manifestPath,
		previousManifest,
		journalPath,
		journal,
		lockPath,
		lock,
		recoveryPath,
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots
			.splice(0)
			.map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })),
	);
});

describe("P03 clean rebuild parity gate", () => {
	it("rebuilds every generated content and evidence output without mutating the checkout", async () => {
		const { stdout } = await execFileAsync(process.execPath, [CHECK_SCRIPT], {
			cwd: ROOT,
			timeout: 120_000,
		});

		expect(stdout).toContain("Clean rebuild parity verified");
	}, 150_000);

	it("preserves undeclared live content when provenance fails after rebuild", async () => {
		const root = await copiedRoot();
		const markerPath = join(root, "content", "undeclared-live-entry.txt");
		await writeFile(markerPath, "PREEXISTING_LIVE_ENTRY", "utf8");
		const ledgerPath = join(
			root,
			"docs",
			"licenses",
			"third-party-ledger.md",
		);
		const outsideLedger = join(root, "outside-ledger.md");
		await writeFile(outsideLedger, "OUTSIDE_LEDGER_SENTINEL", "utf8");
		await rm(ledgerPath);
		await symlink(outsideLedger, ledgerPath);

		await expect(
			execFileAsync(
				process.execPath,
				[join(root, "tools", "assets", "rebuild-starter.mjs")],
				{ cwd: root, timeout: 120_000 },
			),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("E_LEDGER_OUTPUT_PATH"),
		});
		expect(await readFile(markerPath, "utf8")).toBe(
			"PREEXISTING_LIVE_ENTRY",
		);
	}, 150_000);

	it("commits byte-identical valid direct rebuilds with current hashes", async () => {
		const root = await realpath(await copiedRoot());
		const script = join(root, "tools", "assets", "rebuild-starter.mjs");
		const first = await execFileAsync(process.execPath, [script], {
			cwd: root,
			timeout: 120_000,
		});
		const firstDigest = await contentDigest({
			root,
			contentRoot: join(root, "content"),
		});
		const second = await execFileAsync(process.execPath, [script], {
			cwd: root,
			timeout: 120_000,
		});
		const secondDigest = await contentDigest({
			root,
			contentRoot: join(root, "content"),
		});
		const hashes = await verifyStarterHashes({
			root,
			contentRoot: join(root, "content"),
		});

		expect(first.stdout).toContain("Starter content rebuilt:");
		expect(second.stdout).toContain("Starter content rebuilt:");
		expect(secondDigest).toBe(firstDigest);
		expect(hashes.issues).toEqual([]);
	}, 150_000);

	it("keeps committed rebuilt content when lock release cannot finish", async () => {
		const root = await realpath(await copiedRoot());
		const manifestPath = join(root, "content", "starter-level", "manifest.json");
		await writeFile(manifestPath, "PREVIOUS_CONTENT", "utf8");
		const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		try {
			const rebuilt = await runRebuildStarter({
				root,
				transactionTestHook(boundary) {
					if (boundary === "before-lock-release") {
						throw new Error("INJECTED_POSTCOMMIT_LOCK_FAILURE");
					}
				},
			});

			expect(rebuilt.hashes.issues).toEqual([]);
			expect(await readFile(manifestPath, "utf8")).not.toBe(
				"PREVIOUS_CONTENT",
			);
			expect(warning).toHaveBeenCalledWith(
				"Committed rebuild cleanup was deferred.",
				{ code: "E_REBUILD_POSTCOMMIT_CLEANUP" },
			);
			expect(
				await lstat(join(root, ".infinite-snowball-rebuild.lock")),
			).toMatchObject({ nlink: 1 });
		} finally {
			warning.mockRestore();
		}
	}, 150_000);

	it("recovers an interrupted content install to exact old content", async () => {
		const root = await realpath(await copiedRoot());
		await runRebuildStarter({ root });
		const manifestPath = join(root, "content", "starter-level", "manifest.json");
		const previousManifest = await readFile(manifestPath);
		const transactionId = "00000000-0000-4000-8000-000000000011";
		const transactionRoot = `.tmp-infinite-snowball-${transactionId}`;
		const transactionPath = join(root, transactionRoot);
		const journalPath = join(
			root,
			".infinite-snowball-rebuild.transaction.json",
		);
		await mkdir(transactionPath);
		await rename(
			join(root, "content"),
			join(transactionPath, "previous-content"),
		);
		await mkdir(join(root, "content"));
		await writeFile(
			join(root, "content", "interrupted-output.txt"),
			"NEW_PARTIAL_CONTENT",
			"utf8",
		);
		await writeFile(
			journalPath,
			`${JSON.stringify({
				version: 1,
				transactionId,
				transactionRoot,
				contentStage: "content",
				contentBackup: "previous-content",
				hadContent: true,
			})}\n`,
			"utf8",
		);

		await expect(
			runRebuildStarter({
				root,
				transactionTestHook(boundary: string) {
					if (boundary === "after-recovery") {
						throw new Error("INJECTED_AFTER_REBUILD_RECOVERY");
					}
				},
			}),
		).rejects.toThrow("INJECTED_AFTER_REBUILD_RECOVERY");
		expect(await readFile(manifestPath)).toEqual(previousManifest);
		await expect(
			readFile(join(root, "content", "interrupted-output.txt")),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readFile(journalPath)).rejects.toMatchObject({
			code: "ENOENT",
		});
	}, 150_000);

	it("serializes concurrent stale rebuild recovery with one atomic claim", async () => {
		const root = await realpath(await copiedRoot());
		const state = await stageInterruptedRebuildRecovery(
			root,
			"00000000-0000-4000-8000-000000000031",
		);
		let enterClaim!: () => void;
		let releaseClaim = () => {};
		const claimEntered = new Promise<void>((resolve) => {
			enterClaim = resolve;
		});
		const claimPaused = new Promise<void>((resolve) => {
			releaseClaim = resolve;
		});
		const first = runRebuildStarter({
			root,
			async transactionTestHook(boundary) {
				if (boundary === "after-recovery-claim") {
					enterClaim();
					await claimPaused;
				}
				if (boundary === "after-recovery") {
					throw new Error("INJECTED_AFTER_REBUILD_RECOVERY");
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
			const interrupted = await readFile(
				join(root, "content", "interrupted-output.txt"),
			);
			await expect(runRebuildStarter({ root })).rejects.toThrow(
				"E_REBUILD_TRANSACTION_LOCK",
			);
			expect(
				await readFile(join(root, "content", "interrupted-output.txt")),
			).toEqual(interrupted);
			expect(await readFile(state.journalPath)).toEqual(state.journal);
			expect(await readFile(state.lockPath)).toEqual(state.lock);
		} finally {
			releaseClaim();
		}
		await expect(first).rejects.toThrow("INJECTED_AFTER_REBUILD_RECOVERY");
		expect(await readFile(state.manifestPath)).toEqual(
			state.previousManifest,
		);
		await expect(readFile(state.journalPath)).rejects.toMatchObject({
			code: "ENOENT",
		});
	}, 150_000);

	it("blocks stale rebuild recovery when a recovery claim already exists", async () => {
		const root = await realpath(await copiedRoot());
		const state = await stageInterruptedRebuildRecovery(
			root,
			"00000000-0000-4000-8000-000000000032",
		);
		await mkdir(state.recoveryPath, { mode: 0o700 });
		const interrupted = await readFile(
			join(root, "content", "interrupted-output.txt"),
		);

		await expect(runRebuildStarter({ root })).rejects.toThrow(
			"E_REBUILD_TRANSACTION_LOCK",
		);
		expect(
			await readFile(join(root, "content", "interrupted-output.txt")),
		).toEqual(interrupted);
		expect(await readFile(state.journalPath)).toEqual(state.journal);
		expect(await readFile(state.lockPath)).toEqual(state.lock);
	}, 150_000);

	it("fails a live rebuild writer lock without touching old content", async () => {
		const root = await realpath(await copiedRoot());
		await runRebuildStarter({ root });
		const manifestPath = join(root, "content", "starter-level", "manifest.json");
		const previousManifest = await readFile(manifestPath);
		await writeFile(
			join(root, ".infinite-snowball-rebuild.lock"),
			`${JSON.stringify({
				version: 1,
				pid: process.pid,
				transactionId: "00000000-0000-4000-8000-000000000012",
			})}\n`,
			"utf8",
		);

		await expect(runRebuildStarter({ root })).rejects.toThrow(
			"E_REBUILD_TRANSACTION_LOCK",
		);
		expect(await readFile(manifestPath)).toEqual(previousManifest);
	}, 150_000);

	it.each([
		["corrupt", Buffer.from("{not-json", "utf8")],
		["oversize", Buffer.alloc(4_097, 0x78)],
	])("fails closed on a %s rebuild journal", async (_label, journal) => {
		const root = await realpath(await copiedRoot());
		await runRebuildStarter({ root });
		const manifestPath = join(root, "content", "starter-level", "manifest.json");
		const previousManifest = await readFile(manifestPath);
		const journalPath = join(
			root,
			".infinite-snowball-rebuild.transaction.json",
		);
		await writeFile(journalPath, journal);
		await expect(runRebuildStarter({ root })).rejects.toThrow(
			"E_REBUILD_TRANSACTION_JOURNAL",
		);
		expect(await readFile(manifestPath)).toEqual(previousManifest);
		expect(await readFile(journalPath)).toEqual(journal);
	}, 150_000);

	it("fails closed when the copied root audited runtime pin drifts", async () => {
		const root = await copiedRoot();
		const packagePath = join(root, "package.json");
		const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
			devEngines: { runtime: { version: string } };
		};
		packageJson.devEngines.runtime.version = "22.13.2";
		await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

		await expect(
			execFileAsync(
				process.execPath,
				[join(root, "tools", "assets", "rebuild-check.mjs")],
				{ cwd: root, timeout: 30_000 },
			),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("E_REBUILD_INPUT package.json"),
		});
	}, 30_000);

	it("runs the non-mutating parity check from the aggregate asset gate", async () => {
		const packageJson = JSON.parse(
			await readFile(join(ROOT, "package.json"), "utf8"),
		) as { scripts: Record<string, string> };

		expect(packageJson.scripts["assets:rebuild-check"]).toBe(
			"node tools/quality/run-audited-pnpm.mjs run protocol:build && node tools/assets/rebuild-check.mjs",
		);
		expect((packageJson.scripts["assets:check"] ?? "").split(" && ")).toContain(
			"node tools/quality/run-audited-pnpm.mjs run assets:rebuild-check",
		);
	});

	it("creates owned output parents and preserves empty input directories", async () => {
		const root = await copiedRoot();
		const markerPath = join(root, "sandbox-docs-assets-marker.txt");
		await mkdir(join(root, "docs/music/required-empty-input"));
		await writeFile(
			join(root, "tools/assets/rebuild-starter.mjs"),
			`import { lstat, writeFile } from "node:fs/promises";
let status = "owned-directories";
for (const path of ["docs/assets", "docs/music/required-empty-input"]) {
	try {
		const metadata = await lstat(path);
		if (!metadata.isDirectory()) status = "wrong-type";
	} catch {
		status = "missing";
	}
}
await writeFile(process.env.REBUILD_SANDBOX_ASSETS_MARKER, status, "utf8");
if (status !== "owned-directories") throw new Error("E_SANDBOX_OWNED_DIRECTORIES");
`,
			"utf8",
		);

		await expect(
			execFileAsync(
				process.execPath,
				[join(root, "tools", "assets", "rebuild-check.mjs")],
				{
					cwd: root,
					env: {
						...process.env,
						REBUILD_SANDBOX_ASSETS_MARKER: markerPath,
					},
					timeout: 30_000,
				},
			),
		).rejects.toThrow();
		expect(await readFile(markerPath, "utf8")).toBe("owned-directories");
	});

	it("rejects input trees beyond the fixed depth before sandbox copying", async () => {
		const root = await copiedRoot();
		await mkdir(
			join(
				root,
				"docs/music",
				...Array.from({ length: 17 }, (_, index) => `deep-${index}`),
			),
			{ recursive: true },
		);
		await expectInputFailure(
			root,
			"E_REBUILD_INPUT input trees exceed inspection bounds",
		);
	}, 30_000);

	it("rejects too many input directories before sandbox copying", async () => {
		const root = await copiedRoot();
		const musicRoot = join(root, "docs/music");
		for (let index = 0; index < 4_097; index += 1) {
			await mkdir(
				join(musicRoot, `00-empty-${String(index).padStart(4, "0")}`),
			);
		}
		await expectInputFailure(
			root,
			"E_REBUILD_INPUT input trees exceed inspection bounds",
		);
	}, 30_000);

	it("applies the remaining global file budget across input roots", async () => {
		const root = await copiedRoot();
		await writeProbeFiles(root, "docs/brand", 1_025, "00-brand", "SAFE_INPUT");
		await writeProbeFiles(root, "docs/music", 1_025, "00-music", "SAFE_INPUT");
		await expectInputFailure(
			root,
			"E_REBUILD_INPUT input trees exceed inspection bounds",
		);
	}, 30_000);

	it("applies the remaining global byte budget across input roots", async () => {
		const root = await copiedRoot();
		const sparseBytes = 64 * 1024 * 1024;
		for (const [relativeRoot, prefix] of [
			["docs/brand", "00-brand-bytes"],
			["docs/music", "00-music-bytes"],
		] as const) {
			await writeProbeFiles(root, relativeRoot, 2, prefix, "SAFE_INPUT_BYTES");
			for (let index = 0; index < 2; index += 1) {
				await truncate(
					join(
						root,
						...relativeRoot.split("/"),
						`${prefix}-${String(index).padStart(4, "0")}.bin`,
					),
					sparseBytes,
				);
			}
		}
		await expectInputFailure(
			root,
			"E_REBUILD_INPUT input trees exceed inspection bounds",
		);
	}, 30_000);

	it("rejects non-NFC input paths before sandbox copying", async () => {
		const root = await copiedRoot();
		await writeFile(join(root, "docs/music", "cafe\u0301.txt"), "not canonical");
		await expectInputFailure(root, "E_REBUILD_INPUT input path must be NFC");
	}, 30_000);

	it("rejects a post-inventory input symlink swap without executing outside", async () => {
		const root = await copiedRoot();
		const targetPath = join(root, "tools/assets/rebuild-starter.mjs");
		const triggerPath = join(
			root,
			"docs/assets/starter-content-budget.json",
		);
		const outsidePath = join(root, "outside-rebuild-starter.mjs");
		const outsideMarkerPath = join(root, "outside-input-executed.txt");
		const preloadPath = join(root, "swap-rebuild-input.mjs");
		await writeFile(
			outsidePath,
			`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(outsideMarkerPath)}, "executed");
throw new Error("outside input executed");
`,
			"utf8",
		);
		await writeFile(
			preloadPath,
			`import { renameSync, symlinkSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
const target = resolve(process.env.REBUILD_INPUT_SWAP_TARGET);
const outside = resolve(process.env.REBUILD_INPUT_SWAP_OUTSIDE);
const trigger = resolve(process.env.REBUILD_INPUT_SWAP_TRIGGER);
const marker = (await readFile(trigger)).subarray(0, 64);
const probe = await open(trigger, "r");
const fileHandlePrototype = Object.getPrototypeOf(probe);
await probe.close();
const originalRead = fileHandlePrototype.read;
let swapped = false;
fileHandlePrototype.read = async function (...args) {
	const result = await originalRead.apply(this, args);
	const buffer = args[0];
	if (
		!swapped &&
		result.bytesRead >= marker.length &&
		Buffer.isBuffer(buffer) &&
		buffer.subarray(0, marker.length).equals(marker)
	) {
		swapped = true;
		renameSync(target, target + ".before-swap");
		symlinkSync(outside, target);
	}
	return result;
};
`,
			"utf8",
		);
		await expectInputFailure(
			root,
			"E_REBUILD_INPUT",
			preloadEnvironment(preloadPath, {
				REBUILD_INPUT_SWAP_OUTSIDE: outsidePath,
				REBUILD_INPUT_SWAP_TARGET: targetPath,
				REBUILD_INPUT_SWAP_TRIGGER: triggerPath,
			}),
		);
		await expect(readFile(outsideMarkerPath)).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect((await lstat(targetPath)).isSymbolicLink()).toBe(true);
	}, 30_000);

	it("rejects too many generated empty directories at the entry preflight", async () => {
		const root = await copiedRoot();
		const contentRoot = join(root, "content");
		for (let index = 0; index < 1_025; index += 1) {
			await mkdir(
				join(contentRoot, `00-empty-${String(index).padStart(4, "0")}`),
			);
		}
		await expectSnapshotBoundFailure(root);
	}, 30_000);

	it("rejects generated trees beyond the fixed depth preflight", async () => {
		const root = await copiedRoot();
		await mkdir(
			join(
				root,
				"content",
				...Array.from({ length: 13 }, (_, index) => `deep-${index}`),
			),
			{ recursive: true },
		);
		await expectSnapshotBoundFailure(root);
	}, 30_000);

	it("rejects too many tiny generated files before reading their contents", async () => {
		const root = await copiedRoot();
		await writeProbeFiles(root, "content", 513, "00-tiny");
		const probe = await installReadProbe(root);
		await expectSnapshotBoundFailure(root, probe.env);
		await expect(readFile(probe.markerPath)).rejects.toMatchObject({
			code: "ENOENT",
		});
	}, 30_000);

	it("applies the remaining global file budget across generated roots", async () => {
		const root = await copiedRoot();
		await writeProbeFiles(root, "content", 250, "00-content", "SAFE_TINY");
		await writeProbeFiles(
			root,
			"docs/assets/reference-renders",
			250,
			"00-reference",
		);
		const probe = await installReadProbe(root);
		await expectSnapshotBoundFailure(root, probe.env);
		await expect(readFile(probe.markerPath)).rejects.toMatchObject({
			code: "ENOENT",
		});
	}, 30_000);

	it("applies the remaining global byte budget across generated roots", async () => {
		const root = await copiedRoot();
		const sparseBytes = 16 * 1024 * 1024;
		for (const [relativeRoot, prefix, contents] of [
			["content", "00-content-bytes", "SAFE_BYTES"],
			[
				"docs/assets/reference-renders",
				"00-reference-bytes",
				READ_PROBE,
			],
		] as const) {
			await writeProbeFiles(root, relativeRoot, 2, prefix, contents);
			for (let index = 0; index < 2; index += 1) {
				await truncate(
					join(
						root,
						...relativeRoot.split("/"),
						`${prefix}-${String(index).padStart(4, "0")}.bin`,
					),
					sparseBytes,
				);
			}
		}
		const probe = await installReadProbe(root);
		await expectSnapshotBoundFailure(root, probe.env);
		await expect(readFile(probe.markerPath)).rejects.toMatchObject({
			code: "ENOENT",
		});
	}, 30_000);

	it("rejects same-inode growth while snapshotting a generated file", async () => {
		const root = await copiedRoot();
		const targetPath = join(root, "docs/assets/starter-content-budget.json");
		const preloadPath = join(root, "grow-rebuild-snapshot.mjs");
		const unboundedMarkerPath = join(root, "unbounded-snapshot-read.txt");
		await writeFile(
			preloadPath,
			`import fs, { writeFileSync } from "node:fs";
import { appendFile, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
const target = resolve(process.env.REBUILD_GROW_TARGET);
const unboundedMarker = process.env.REBUILD_UNBOUNDED_MARKER;
const marker = (await readFile(target)).subarray(0, 64);
const probe = await open(target, "r");
const fileHandlePrototype = Object.getPrototypeOf(probe);
await probe.close();
const originalRead = fileHandlePrototype.read;
let grown = false;
fileHandlePrototype.read = async function (...args) {
	const result = await originalRead.apply(this, args);
	const buffer = args[0];
	if (
		!grown &&
		result.bytesRead > 0 &&
		Buffer.isBuffer(buffer) &&
		buffer.subarray(0, marker.length).equals(marker)
	) {
		grown = true;
		await appendFile(target, Buffer.from([0x21]));
	}
	return result;
};
const originalReadFile = fs.promises.readFile;
fs.promises.readFile = async function (path, ...args) {
	if (resolve(String(path)) === target) {
		writeFileSync(unboundedMarker, "used");
	}
	return originalReadFile.call(this, path, ...args);
};
syncBuiltinESMExports();
`,
		);
		await expect(
			execFileAsync(
				process.execPath,
				[join(root, "tools/assets/rebuild-check.mjs")],
				{
					cwd: root,
					env: preloadEnvironment(preloadPath, {
						REBUILD_GROW_TARGET: targetPath,
						REBUILD_UNBOUNDED_MARKER: unboundedMarkerPath,
					}),
					timeout: 30_000,
				},
			),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("E_REBUILD_PARITY"),
		});
		expect((await readFile(targetPath)).at(-1)).toBe(0x21);
		await expect(readFile(unboundedMarkerPath)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("rejects a symlink swap while reading a generated file", async () => {
		const root = await copiedRoot();
		const targetPath = join(root, "docs/assets/starter-content-budget.json");
		const outsidePath = join(root, "outside-budget-sentinel.json");
		const preloadPath = join(root, "swap-rebuild-snapshot.mjs");
		await writeFile(outsidePath, "OUTSIDE_SENTINEL_UNTOUCHED", "utf8");
		await writeFile(
			preloadPath,
			`import { renameSync, symlinkSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
const target = process.env.REBUILD_SWAP_TARGET;
const outside = process.env.REBUILD_SWAP_OUTSIDE;
const marker = (await readFile(target)).subarray(0, 64);
const probe = await open(target, "r");
const fileHandlePrototype = Object.getPrototypeOf(probe);
await probe.close();
const originalRead = fileHandlePrototype.read;
let swapped = false;
fileHandlePrototype.read = async function (...args) {
	const result = await originalRead.apply(this, args);
	const buffer = args[0];
	if (
		!swapped &&
		result.bytesRead > 0 &&
		Buffer.isBuffer(buffer) &&
		buffer.subarray(0, marker.length).equals(marker)
	) {
		swapped = true;
		renameSync(target, target + ".before-swap");
		symlinkSync(outside, target);
	}
	return result;
};
`,
			"utf8",
		);
		await expect(
			execFileAsync(
				process.execPath,
				[join(root, "tools/assets/rebuild-check.mjs")],
				{
					cwd: root,
					env: preloadEnvironment(preloadPath, {
						REBUILD_SWAP_OUTSIDE: outsidePath,
						REBUILD_SWAP_TARGET: targetPath,
					}),
					timeout: 30_000,
				},
			),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("E_REBUILD_PARITY"),
		});
		expect(await readFile(outsidePath, "utf8")).toBe(
			"OUTSIDE_SENTINEL_UNTOUCHED",
		);
		expect((await lstat(targetPath)).isSymbolicLink()).toBe(true);
	});

	it("fails when a generator source drifts from checked-in outputs", async () => {
		const root = await copiedRoot();
		const templatePath = join(
			root,
			"tools",
			"assets",
			"templates",
			"object-pack.json",
		);
		const template = JSON.parse(await readFile(templatePath, "utf8")) as {
			entries: Array<{
				objects: Array<{ material: { roughness: number } }>;
			}>;
		};
		const object = template.entries[0]?.objects[0];
		if (object === undefined) throw new Error("object template fixture is missing");
		object.material.roughness = 0.65;
		await writeFile(
			templatePath,
			`${JSON.stringify(template, null, "\t")}\n`,
			"utf8",
		);

		await expect(
			execFileAsync(
				process.execPath,
				[join(root, "tools", "assets", "rebuild-check.mjs")],
				{ cwd: root, timeout: 120_000 },
			),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("E_WITHDRAWAL_IDENTITY:/package"),
		});
	}, 150_000);
});
