import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	access,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { MusicManifestSchema } from "../../packages/protocol/src/schema/manifests.js";
import { afterAll, describe, expect, it } from "vitest";
import {
	provenanceRecordFileName,
	reconstructProvenanceRecord,
	resolveRetainedLicenseEvidence,
} from "../../tools/assets/lib/provenance-ledger.mjs";

const ROOT = process.cwd();
const HEADLESS_SMOKE = join(ROOT, "tools", "assets", "headless-smoke.mjs");
const MUSIC_CHECK = join(ROOT, "tools", "assets", "music-check.mjs");
const temporaryRoots: string[] = [];
const REVIEWED_LATIN_CONFUSABLES = [
	{ name: "U+0251", title: "Kɑtamari soundtrack" },
	{ name: "U+1D00", title: "Kᴀtamari soundtrack" },
	{ name: "U+1D0B", title: "ᴋatamari soundtrack" },
	{ name: "U+1D1B", title: "Kaᴛamari soundtrack" },
	{ name: "U+1D0D", title: "Kataᴍari soundtrack" },
	{ name: "U+0280", title: "Katamaʀi soundtrack" },
	{ name: "U+026A", title: "Katamarɪ soundtrack" },
	{ name: "U+0131", title: "Katamarı soundtrack" },
] as const;


const CLIS = [
	{
		name: "headless smoke",
		script: HEADLESS_SMOKE,
		success: "Structural starter smoke passed",
		sentinelReadEvidence: "invalid-wav",
	},
	{
		name: "music policy",
		script: MUSIC_CHECK,
		success: "Music policy verified",
		sentinelReadEvidence: "E_WAV_STRUCTURE",
	},
] as const;

async function copiedRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "infinite-snowball-cli-path-"));
	temporaryRoots.push(root);
	await mkdir(join(root, "tools", "assets", "lib"), { recursive: true });
	await Promise.all([
		cp(join(ROOT, "content"), join(root, "content"), { recursive: true }),
		cp(join(ROOT, "docs", "licenses"), join(root, "docs", "licenses"), {
			recursive: true,
		}),
		symlink(join(ROOT, "packages"), join(root, "packages"), "dir"),
		cp(
			join(ROOT, "tools", "assets", "lib", "asset-pipeline.mjs"),
			join(root, "tools", "assets", "lib", "asset-pipeline.mjs"),
		),
	]);
	return root;
}

async function traversalRoot(): Promise<{
	hookPath: string;
	markerPath: string;
	root: string;
	sentinelPath: string;
}> {
	const root = await copiedRoot();
	const manifestPath = join(
		root,
		"content",
		"starter-music",
		"manifest.json",
	);
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
		assets: Array<{ assetId: string; path: string }>;
	};
	const track = manifest.assets.find((asset) => asset.assetId === "track");
	if (track === undefined) throw new Error("starter track fixture is missing");
	track.path = "../../outside-sentinel.wav";
	const hookPath = join(root, "sentinel-read-guard.cjs");
	const markerPath = join(root, "outside-sentinel-read.txt");
	const sentinelPath = join(root, "outside-sentinel.wav");
	await Promise.all([
		writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
		writeFile(
			sentinelPath,
			"OUTSIDE_SENTINEL_MUST_NOT_BE_READ",
			"utf8",
		),
		writeFile(
			hookPath,
			[
				'const { writeFileSync } = require("node:fs");',
				'const promises = require("node:fs/promises");',
				'const { resolve } = require("node:path");',
				"const originalOpen = promises.open;",
				"const originalReadFile = promises.readFile;",
				"function rejectSentinelRead(target) {",
				'\tif (resolve(String(target)) !== resolve(process.env.OUTSIDE_SENTINEL_PATH)) return;',
				'\twriteFileSync(process.env.OUTSIDE_SENTINEL_MARKER, "read");',
				'\tthrow new Error("OUTSIDE_SENTINEL_READ_ATTEMPT");',
				"}",
				"promises.open = async function guardedOpen(target, ...args) {",
				"\trejectSentinelRead(target);",
				"\treturn originalOpen.call(this, target, ...args);",
				"};",
				"promises.readFile = async function guardedReadFile(target, ...args) {",
				"\trejectSentinelRead(target);",
				"\treturn originalReadFile.call(this, target, ...args);",
				"};",
				"",
			].join("\n"),
			"utf8",
		),
	]);
	return { hookPath, markerPath, root, sentinelPath };
}
async function manifestSwapRoot(): Promise<{
	hookPath: string;
	markerPath: string;
	root: string;
	sentinelPath: string;
}> {
	const root = await copiedRoot();
	const manifestPath = join(
		root,
		"content",
		"starter-music",
		"manifest.json",
	);
	const outsideManifest = JSON.parse(
		await readFile(manifestPath, "utf8"),
	) as {
		entries: Array<{ tracks: Array<{ title: string }> }>;
	};
	const track = outsideManifest.entries[0]?.tracks[0];
	if (track === undefined) throw new Error("starter track fixture is missing");
	track.title = "Kаtamari soundtrack";
	const hookPath = join(root, "manifest-swap-guard.cjs");
	const markerPath = join(root, "manifest-swap-ran.txt");
	const sentinelPath = join(root, "outside-manifest.json");
	await Promise.all([
		writeFile(
			sentinelPath,
			`${JSON.stringify(outsideManifest, null, 2)}\n`,
			"utf8",
		),
		writeFile(
			hookPath,
			[
				'const { renameSync, symlinkSync, writeFileSync } = require("node:fs");',
				'const promises = require("node:fs/promises");',
				'const { join, resolve } = require("node:path");',
				"const originalOpen = promises.open;",
				"const originalReadFile = promises.readFile;",
				'const manifest = join(process.cwd(), "content", "starter-music", "manifest.json");',
				'const backup = join(process.cwd(), "original-music-manifest.json");',
				"let swapped = false;",
				"function swapManifest(target) {",
				"\tif (swapped || resolve(String(target)) !== resolve(manifest)) return;",
				"\tswapped = true;",
				"\trenameSync(manifest, backup);",
				"\tsymlinkSync(process.env.OUTSIDE_SENTINEL_PATH, manifest);",
				'\twriteFileSync(process.env.OUTSIDE_SENTINEL_MARKER, "swapped");',
				"}",
				"promises.open = async function swappingOpen(target, ...args) {",
				"\tswapManifest(target);",
				"\treturn originalOpen.call(this, target, ...args);",
				"};",
				"promises.readFile = async function swappingReadFile(target, ...args) {",
				"\tswapManifest(target);",
				"\treturn originalReadFile.call(this, target, ...args);",
				"};",
				"",
			].join("\n"),
			"utf8",
		),
	]);
	return { hookPath, markerPath, root, sentinelPath };
}
async function sameInodeGrowthGuard(
	root: string,
	sentinelPath: string,
	name: string,
): Promise<{
	hookMode: "import";
	hookPath: string;
	markerPath: string;
	root: string;
	sentinelPath: string;
}> {
	const hookPath = join(root, `${name}-growth-guard.mjs`);
	const markerPath = join(root, `${name}-growth-ran.txt`);
	await writeFile(
		hookPath,
		[
			'import { appendFile, open, stat, writeFile } from "node:fs/promises";',
			"const target = process.env.OUTSIDE_SENTINEL_PATH;",
			"const marker = process.env.OUTSIDE_SENTINEL_MARKER;",
			"const targetStats = await stat(target);",
			"const probe = await open(new URL(import.meta.url));",
			"const prototype = Object.getPrototypeOf(probe);",
			"await probe.close();",
			"const originalRead = prototype.read;",
			"const originalReadFile = prototype.readFile;",
			"let grown = false;",
			"async function growIfTarget(handle) {",
			"\tif (grown) return;",
			"\tconst stats = await handle.stat();",
			"\tif (stats.dev !== targetStats.dev || stats.ino !== targetStats.ino) return;",
			"\tgrown = true;",
			'\tawait appendFile(target, Buffer.from("UNINVENTORIED_GROWTH"));',
			'\tawait writeFile(marker, "grown");',
			"}",
			"prototype.read = async function growingRead(...args) {",
			"\tawait growIfTarget(this);",
			"\treturn originalRead.call(this, ...args);",
			"};",
			"prototype.readFile = async function growingReadFile(...args) {",
			"\tawait growIfTarget(this);",
			"\treturn originalReadFile.call(this, ...args);",
			"};",
			"",
		].join("\n"),
		"utf8",
	);
	return {
		hookMode: "import",
		hookPath,
		markerPath,
		root,
		sentinelPath,
	};
}

async function audioGrowthRoot(): Promise<{
	hookMode: "import";
	hookPath: string;
	markerPath: string;
	root: string;
	sentinelPath: string;
}> {
	const root = await selfConsistentMusicRoot();
	const manifestPath = join(
		root,
		"content",
		"starter-music",
		"manifest.json",
	);
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
		assets: Array<{ assetId: string; path: string }>;
	};
	const track = manifest.assets.find((asset) => asset.assetId === "track");
	if (track === undefined) throw new Error("starter track fixture is missing");
	return sameInodeGrowthGuard(
		root,
		join(root, "content", "starter-music", track.path),
		"audio",
	);
}

async function musicEvidencePaths(root: string): Promise<{
	grantPath: string;
	recordPath: string;
}> {
	const manifest = JSON.parse(
		await readFile(
			join(root, "content", "starter-music", "manifest.json"),
			"utf8",
		),
	) as {
		name: string;
		assets: Array<{ assetId: string }>;
	};
	const asset = manifest.assets.find((candidate) => candidate.assetId === "track");
	if (asset === undefined) throw new Error("starter track fixture is missing");
	const recordPath = join(
		root,
		"docs",
		"licenses",
		"provenance",
		"records",
		provenanceRecordFileName({
			packageName: manifest.name,
			assetId: asset.assetId,
		}),
	);
	const machine = JSON.parse(await readFile(recordPath, "utf8")) as {
		license?: { textPath?: string };
	};
	if (typeof machine.license?.textPath !== "string")
		throw new Error("starter machine grant path is missing");
	return {
		grantPath: join(root, ...machine.license.textPath.split("/")),
		recordPath,
	};
}

async function evidenceReadGuard(
	root: string,
	sentinelPath: string,
	name: string,
): Promise<{
	hookPath: string;
	markerPath: string;
	root: string;
	sentinelPath: string;
}> {
	const hookPath = join(root, `${name}-read-guard.cjs`);
	const markerPath = join(root, `${name}-read-ran.txt`);
	await writeFile(
		hookPath,
		[
			'const { writeFileSync } = require("node:fs");',
			'const promises = require("node:fs/promises");',
			'const { syncBuiltinESMExports } = require("node:module");',
			'const { resolve } = require("node:path");',
			"const originalOpen = promises.open;",
			"const originalReadFile = promises.readFile;",
			"function rejectSentinelRead(target) {",
			"\tif (resolve(String(target)) !== resolve(process.env.OUTSIDE_SENTINEL_PATH)) return;",
			'\twriteFileSync(process.env.OUTSIDE_SENTINEL_MARKER, "read");',
			'\tthrow new Error("OUTSIDE_SENTINEL_READ_ATTEMPT");',
			"}",
			"promises.open = async function guardedOpen(target, ...args) {",
			"\trejectSentinelRead(target);",
			"\treturn originalOpen.call(this, target, ...args);",
			"};",
			"promises.readFile = async function guardedReadFile(target, ...args) {",
			"\trejectSentinelRead(target);",
			"\treturn originalReadFile.call(this, target, ...args);",
			"};",
			"syncBuiltinESMExports();",
			"",
		].join("\n"),
		"utf8",
	);
	return { hookPath, markerPath, root, sentinelPath };
}

async function evidenceSymlinkRoot(
	kind: "grant" | "record",
): Promise<{
	hookPath: string;
	markerPath: string;
	root: string;
	sentinelPath: string;
}> {
	const root = await selfConsistentMusicRoot();
	const paths = await musicEvidencePaths(root);
	const sentinelPath = kind === "grant" ? paths.grantPath : paths.recordPath;
	const outsidePath = join(root, `outside-${kind}-sentinel`);
	const bytes = await readFile(sentinelPath);
	await rm(sentinelPath);
	await writeFile(outsidePath, bytes);
	await symlink(outsidePath, sentinelPath);
	return evidenceReadGuard(root, sentinelPath, `${kind}-symlink`);
}

async function machineFifoRoot(): Promise<{
	hookPath: string;
	markerPath: string;
	root: string;
	sentinelPath: string;
}> {
	const root = await selfConsistentMusicRoot();
	const { recordPath } = await musicEvidencePaths(root);
	await rm(recordPath);
	const fifo = spawnSync("mkfifo", [recordPath], { encoding: "utf8" });
	if (fifo.status !== 0)
		throw new Error(`mkfifo failed: ${fifo.stderr || fifo.stdout}`);
	return evidenceReadGuard(root, recordPath, "record-fifo");
}

async function machineGrowthRoot(): Promise<{
	hookMode: "import";
	hookPath: string;
	markerPath: string;
	root: string;
	sentinelPath: string;
}> {
	const root = await selfConsistentMusicRoot();
	const { recordPath } = await musicEvidencePaths(root);
	return sameInodeGrowthGuard(root, recordPath, "machine-record");
}



async function musicTitleRoot(title: string): Promise<string> {
	const root = await selfConsistentMusicRoot();
	const manifestPath = join(
		root,
		"content",
		"starter-music",
		"manifest.json",
	);
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
		entries: Array<{ tracks: Array<{ title: string }> }>;
	};
	const track = manifest.entries[0]?.tracks[0];
	if (track === undefined) throw new Error("starter track fixture is missing");
	track.title = title;
	await writeFile(
		manifestPath,
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf8",
	);
	return root;
}
async function musicManifestRoot(manifest: string): Promise<string> {
	const root = await copiedRoot();
	await writeFile(
		join(root, "content", "starter-music", "manifest.json"),
		manifest,
		"utf8",
	);
	return root;
}

async function writeSelfConsistentMusicMachine(root: string): Promise<void> {
	const packageDirectory = "starter-music";
	const manifestPath = join(
		root,
		"content",
		packageDirectory,
		"manifest.json",
	);
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
		assets: Array<{
			assetId: string;
			path: string;
			provenance: {
				creator: string;
				sourceArtifactSha256: string;
			};
		}>;
	};
	const moduleBytes = await readFile(
		join(root, "tools", "assets", "lib", "asset-pipeline.mjs"),
	);
	const moduleSha256 = createHash("sha256")
		.update(moduleBytes)
		.digest("hex");
	for (const candidate of manifest.assets) {
		if (
			candidate.provenance.creator ===
			"Infinite Snowball contributors"
		) {
			candidate.provenance.sourceArtifactSha256 = moduleSha256;
		}
	}
	await writeFile(
		manifestPath,
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf8",
	);
	const recordManifest = MusicManifestSchema.parse(manifest);
	const asset = recordManifest.assets.find(
		(candidate) => candidate.assetId === "track",
	);
	if (asset === undefined) throw new Error("starter track fixture is missing");
	const runtimeBytes = await readFile(
		join(root, "content", packageDirectory, asset.path),
	);
	const retainedLicenseEvidence =
		await resolveRetainedLicenseEvidence(root, asset);
	const machine = reconstructProvenanceRecord({
		packageDirectory,
		manifest: recordManifest,
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
		"utf8",
	);
}

async function selfConsistentMusicRoot(): Promise<string> {
	const root = await copiedRoot();
	await writeSelfConsistentMusicMachine(root);
	return root;
}
type MusicTrackFixture = {
	trackId: string;
	loop: { endSeconds: number; startSeconds: number };
	cues: Array<{ atSeconds: number; id: string }>;
};

type MusicEntryFixture = {
	musicPackId: string;
	tracks: MusicTrackFixture[];
};

type MusicManifestFixture = {
	entries: MusicEntryFixture[];
};

function requiredMusicEntry(
	manifest: MusicManifestFixture,
): MusicEntryFixture {
	const entry = manifest.entries[0];
	if (entry === undefined) throw new Error("starter music entry is missing");
	return entry;
}

function requiredMusicTrack(
	manifest: MusicManifestFixture,
): MusicTrackFixture {
	const track = requiredMusicEntry(manifest).tracks[0];
	if (track === undefined) throw new Error("starter track fixture is missing");
	return track;
}

async function mutatedMusicRoot(
	mutate: (manifest: MusicManifestFixture) => void,
): Promise<string> {
	const root = await selfConsistentMusicRoot();
	const manifestPath = join(
		root,
		"content",
		"starter-music",
		"manifest.json",
	);
	const manifest = JSON.parse(
		await readFile(manifestPath, "utf8"),
	) as MusicManifestFixture;
	mutate(manifest);
	await writeFile(
		manifestPath,
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf8",
	);
	return root;
}
function riffChunk(id: string, payload: Buffer): Buffer {
	if (Buffer.byteLength(id, "ascii") !== 4)
		throw new Error("RIFF chunk IDs must contain four ASCII bytes");
	const padding = payload.length % 2;
	const chunk = Buffer.alloc(8 + payload.length + padding);
	chunk.write(id, 0, 4, "ascii");
	chunk.writeUInt32LE(payload.length, 4);
	payload.copy(chunk, 8);
	return chunk;
}


async function wavMetadataRoot(chunk: Buffer): Promise<string> {
	const root = await copiedRoot();
	const packageDirectory = "starter-music";
	const manifestPath = join(
		root,
		"content",
		packageDirectory,
		"manifest.json",
	);
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
		assets: Array<{
			assetId: string;
			bytes: number;
			path: string;
			provenance: { outputSha256: string };
			sha256: string;
		}>;
	};
	const asset = manifest.assets.find((candidate) => candidate.assetId === "track");
	if (asset === undefined) throw new Error("starter track fixture is missing");
	const runtimePath = join(root, "content", packageDirectory, asset.path);
	const wav = await readFile(runtimePath);
	const withMetadata = Buffer.concat([wav.subarray(0, 12), chunk, wav.subarray(12)]);
	withMetadata.writeUInt32LE(withMetadata.length - 8, 4);
	const digest = createHash("sha256").update(withMetadata).digest("hex");
	asset.bytes = withMetadata.length;
	asset.sha256 = digest;
	asset.provenance.outputSha256 = digest;
	await Promise.all([
		writeFile(runtimePath, withMetadata),
		writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
	]);
	await writeSelfConsistentMusicMachine(root);
	return root;
}




function runCli(
	script: string,
	cwd: string,
	readGuard?: {
		hookMode?: "import" | "require";
		hookPath: string;
		markerPath: string;
		sentinelPath: string;
	},
) {
	const result = spawnSync(
		process.execPath,
		readGuard
			? [
					readGuard.hookMode === "import" ? "--import" : "--require",
					readGuard.hookPath,
					script,
				]
			: [script],
		{
			cwd,
			encoding: "utf8",
			env:
				readGuard === undefined
					? process.env
					: {
							...process.env,
							OUTSIDE_SENTINEL_MARKER: readGuard.markerPath,
							OUTSIDE_SENTINEL_PATH: readGuard.sentinelPath,
						},
			timeout: 30_000,
		},
	);
	return {
		error: result.error,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
		status: result.status,
	};
}

afterAll(async () => {
	await Promise.all(
		temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("asset CLI path safety", () => {
	it.each(CLIS)(
		"rejects $name traversal before reading the outside sentinel",
		async ({ script, sentinelReadEvidence }) => {
			const fixture = await traversalRoot();
			const result = runCli(script, fixture.root, fixture);

			expect(result.error).toBeUndefined();
			expect(result.status).not.toBe(0);
			expect(result.output).toContain("E_PATH_POLICY");
			expect(result.output).not.toContain("OUTSIDE_SENTINEL_READ_ATTEMPT");
			expect(result.output).not.toContain(sentinelReadEvidence);
			await expect(access(fixture.markerPath)).rejects.toThrow();
		},
		30_000,
	);

	it("rejects a manifest symlink swap before reading outside JSON", async () => {
		const fixture = await manifestSwapRoot();
		const result = runCli(MUSIC_CHECK, fixture.root, fixture);

		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.output).toContain("E_PATH_POLICY");
		expect(result.output).not.toContain("E_SOUNDTRACK_PROHIBITED");
		await expect(access(fixture.markerPath)).resolves.toBeUndefined();
	});
	it.each([
		{
			name: "10,000-level manifest",
			createManifest: () => {
				const depth = 10_000;
				return `${'{"nested":'.repeat(depth)}"safe"${"}".repeat(depth)}`;
			},
		},
		{
			name: "4,097-entry manifest object",
			createManifest: () =>
				JSON.stringify(
					Object.fromEntries(
						Array.from({ length: 4_097 }, (_, index) => [
							`key-${index}`,
							null,
						]),
					),
				),
		},
		{
			name: "262,145-node manifest",
			createManifest: () =>
				JSON.stringify(
					Array.from({ length: 4_096 }, () =>
						Array.from({ length: 63 }, () => null),
					),
				),
		},
	] as const)(
		"rejects a $name with a stable bounds issue",
		async ({ createManifest }) => {
			const root = await musicManifestRoot(createManifest());
			const result = runCli(MUSIC_CHECK, root);

			expect(result.error).toBeUndefined();
			expect(result.status).not.toBe(0);
			expect(result.output).toContain("E_MANIFEST_BOUNDS /manifest.json");
			expect(result.output).not.toMatch(/RangeError|Maximum call stack/u);
		},
	);

	it("rejects same-inode audio growth as an inventory identity change", async () => {
		const fixture = await audioGrowthRoot();
		const result = runCli(MUSIC_CHECK, fixture.root, fixture);

		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.output).toContain("E_PATH_POLICY");
		expect(result.output).not.toContain("Music policy verified");
		await expect(access(fixture.markerPath)).resolves.toBeUndefined();
	});
	it.each([
		{ kind: "record", name: "machine record", ruleId: "E_PATH_POLICY" },
		{ kind: "grant", name: "retained grant", ruleId: "E_MUSIC_GRANT" },
	] as const)(
		"rejects a symlinked $name before reading its external sentinel",
		async ({ kind, ruleId }) => {
			const fixture = await evidenceSymlinkRoot(kind);
			const result = runCli(MUSIC_CHECK, fixture.root, fixture);

			expect(result.error).toBeUndefined();
			expect(result.status).not.toBe(0);
			expect(result.output).toContain(ruleId);
			expect(result.output).not.toContain("OUTSIDE_SENTINEL_READ_ATTEMPT");
			await expect(access(fixture.markerPath)).rejects.toThrow();
		},
	);

	it("rejects a machine-record FIFO before attempting to read it", async () => {
		const fixture = await machineFifoRoot();
		const result = runCli(MUSIC_CHECK, fixture.root, fixture);

		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.output).toContain("E_PATH_POLICY");
		expect(result.output).not.toContain("OUTSIDE_SENTINEL_READ_ATTEMPT");
		await expect(access(fixture.markerPath)).rejects.toThrow();
	});

	it("rejects same-inode machine-record growth as a path-policy failure", async () => {
		const fixture = await machineGrowthRoot();
		const result = runCli(MUSIC_CHECK, fixture.root, fixture);

		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.output).toContain("E_PATH_POLICY");
		expect(result.output).not.toContain("Music policy verified");
		await expect(access(fixture.markerPath)).resolves.toBeUndefined();
	});



	it.each([
		{ name: "mixed-script Cyrillic-a", title: "Kаtamari soundtrack" },
		{ name: "Cyrillic Ukrainian-I", title: "КАТАМАРІ soundtrack" },
		{ name: "Cyrillic-I", title: "КАТАМАРИ soundtrack" },
		{ name: "Greek", title: "ΚΑΤΑΜΑΡΙ soundtrack" },
		...REVIEWED_LATIN_CONFUSABLES,
	])("rejects a $name Katamari claim in standalone music policy", async ({ title }) => {
		const root = await musicTitleRoot(title);
		const result = runCli(MUSIC_CHECK, root);

		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.output).toContain("E_SOUNDTRACK_PROHIBITED");
		expect(result.output).not.toContain("Music policy verified");
	});

	it("accepts unrelated non-Latin original music text", async () => {
		const root = await musicTitleRoot("雪だるま soundtrack");
		const result = runCli(MUSIC_CHECK, root);

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.output).toContain("Music policy verified");
	});

	it.each([
		{
			name: "loop end beyond decoded duration",
			path: "/tracks/snowdrift-signal/loop",
			mutate: (manifest: MusicManifestFixture) => {
				requiredMusicTrack(manifest).loop.endSeconds = 999;
			},
		},
		{
			name: "cue after decoded duration",
			path: "/tracks/snowdrift-signal/cues/0/atSeconds",
			mutate: (manifest: MusicManifestFixture) => {
				const track = requiredMusicTrack(manifest);
				const cue = track.cues[0];
				if (cue === undefined) throw new Error("starter cue fixture is missing");
				track.cues[0] = { ...cue, atSeconds: 999 };
			},
		},
		{
			name: "duplicate track ID",
			path: "/tracks/1/trackId",
			mutate: (manifest: MusicManifestFixture) => {
				const entry = requiredMusicEntry(manifest);
				entry.tracks.push(structuredClone(requiredMusicTrack(manifest)));
			},
		},
		{
			name: "duplicate music-pack ID",
			path: "/entries/1/musicPackId",
			mutate: (manifest: MusicManifestFixture) => {
				const duplicate = structuredClone(requiredMusicEntry(manifest));
				duplicate.tracks = [];
				manifest.entries.push(duplicate);
			},
		},
		{
			name: "duplicate cue ID",
			path: "/tracks/snowdrift-signal/cues/1/id",
			mutate: (manifest: MusicManifestFixture) => {
				const track = requiredMusicTrack(manifest);
				const cue = track.cues[0];
				if (cue === undefined) throw new Error("starter cue fixture is missing");
				track.cues.push({ ...cue, atSeconds: 1 });
			},
		},
	] as const)("rejects $name", async ({ mutate, path }) => {
		const root = await mutatedMusicRoot(mutate);
		const result = runCli(MUSIC_CHECK, root);

		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.output).toContain(`E_MUSIC_BINDING ${path}`);
	});

	it("allows lawful whitespace boundaries in LIST/INFO metadata", async () => {
		const title = riffChunk(
			"INAM",
			Buffer.from("Look at a marina\0", "utf8"),
		);
		const list = riffChunk(
			"LIST",
			Buffer.concat([Buffer.from("INFO", "ascii"), title]),
		);
		const root = await wavMetadataRoot(list);
		const result = runCli(MUSIC_CHECK, root);

		expect(result.error).toBeUndefined();
		expect(result.status, result.output).toBe(0);
		expect(result.output).toContain("Music policy verified");
	});

	it.each([
		{ chunkId: "INAM", name: "CC0 license", value: "Licensed under CC0-1.0." },
		{
			chunkId: "ICMT",
			name: "first-party original soundtrack",
			value: "We composed an original soundtrack.",
		},
		{
			chunkId: "ICMT",
			name: "five-star review",
			value: "Rated 5-stars by playtesters.",
		},
	] as const)(
		"accepts lawful $name LIST/INFO metadata",
		async ({ chunkId, value }) => {
			const title = riffChunk(chunkId, Buffer.from(`${value}\0`, "utf8"));
			const list = riffChunk(
				"LIST",
				Buffer.concat([Buffer.from("INFO", "ascii"), title]),
			);
			const root = await wavMetadataRoot(list);
			const result = runCli(MUSIC_CHECK, root);

			expect(result.error).toBeUndefined();
			expect(result.status, result.output).toBe(0);
			expect(result.output).toContain("Music policy verified");
		},
	);

	it.each([
		{
			chunkId: "INAM",
			name: "protected publisher license",
			value: "Licensed by Bandai Namco Entertainment.",
		},
		{
			chunkId: "ICMT",
			name: "commercial soundtrack transfer",
			value: "Download the commercial soundtrack for this game.",
		},
	] as const)(
		"rejects contextual protected $name LIST/INFO metadata",
		async ({ chunkId, value }) => {
			const title = riffChunk(chunkId, Buffer.from(`${value}\0`, "utf8"));
			const list = riffChunk(
				"LIST",
				Buffer.concat([Buffer.from("INFO", "ascii"), title]),
			);
			const root = await wavMetadataRoot(list);
			const result = runCli(MUSIC_CHECK, root);

			expect(result.error).toBeUndefined();
			expect(result.status).not.toBe(0);
			expect(result.output).toContain(
				"E_SOUNDTRACK_PROHIBITED /tracks/snowdrift-signal/decodedAudio/metadata",
			);
		},
	);
	it.each([
		{
			name: "truncated nested header",
			nested: Buffer.from("INAM", "ascii"),
		},
		{
			name: "overflowing nested payload",
			nested: Buffer.from([
				0x49, 0x4e, 0x41, 0x4d,
				0x20, 0x00, 0x00, 0x00,
				0x41,
			]),
		},
		{
			name: "nonzero nested pad byte",
			nested: Buffer.from([
				0x49, 0x4e, 0x41, 0x4d,
				0x01, 0x00, 0x00, 0x00,
				0x41, 0x7f,
			]),
		},
		{
			name: "nested chunk count overflow",
			nested: Buffer.concat(
				Array.from({ length: 257 }, () =>
					riffChunk("INAM", Buffer.alloc(0)),
				),
			),
		},
		{
			name: "nested metadata byte overflow",
			nested: riffChunk(
				"ICMT",
				Buffer.alloc(256 * 1024 + 1, 0x41),
			),
		},
	] as const)("rejects malformed LIST/INFO $name", async ({ nested }) => {
		const list = riffChunk(
			"LIST",
			Buffer.concat([Buffer.from("INFO", "ascii"), nested]),
		);
		const root = await wavMetadataRoot(list);
		const result = runCli(MUSIC_CHECK, root);

		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.output).toContain(
			"E_MUSIC_BINDING /tracks/snowdrift-signal/decodedAudio/metadata",
		);
	});


	it.each(REVIEWED_LATIN_CONFUSABLES)(
		"rejects reviewed Latin confusable $name in LIST/INFO soundtrack metadata",
		async ({ title: value }) => {
			const title = riffChunk(
				"INAM",
				Buffer.from(`${value}\0`, "utf8"),
			);
			const list = riffChunk(
				"LIST",
				Buffer.concat([Buffer.from("INFO", "ascii"), title]),
			);
			const root = await wavMetadataRoot(list);
			const result = runCli(MUSIC_CHECK, root);

			expect(result.error).toBeUndefined();
			expect(result.status).not.toBe(0);
			expect(result.output).toContain(
				"E_SOUNDTRACK_PROHIBITED /tracks/snowdrift-signal/decodedAudio/metadata",
			);
		},
	);
	it("rejects odd-sized UTF-16LE prohibited LIST metadata", async () => {
		const title = riffChunk(
			"INAM",
			Buffer.concat([
				Buffer.from("Kаtamari soundtrack\0", "utf16le"),
				Buffer.from([0x7f]),
			]),
		);
		const list = riffChunk(
			"LIST",
			Buffer.concat([Buffer.from("INFO", "ascii"), title]),
		);
		const root = await wavMetadataRoot(list);
		const result = runCli(MUSIC_CHECK, root);

		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.output).toContain(
			"E_SOUNDTRACK_PROHIBITED /tracks/snowdrift-signal/decodedAudio/metadata",
		);
	});
	it("rejects UTF-16BE prohibited LIST/INFO metadata", async () => {
		const title = riffChunk(
			"INAM",
			Buffer.from("Kаtamari soundtrack\0", "utf16le").swap16(),
		);
		const list = riffChunk(
			"LIST",
			Buffer.concat([Buffer.from("INFO", "ascii"), title]),
		);
		const root = await wavMetadataRoot(list);
		const result = runCli(MUSIC_CHECK, root);

		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.output).toContain(
			"E_SOUNDTRACK_PROHIBITED /tracks/snowdrift-signal/decodedAudio/metadata",
		);
	});

	it.each([
		{
			encoding: "UTF-8",
			payload: Buffer.from("Original CC0 music\0", "utf8"),
		},
		{
			encoding: "UTF-16LE",
			payload: Buffer.from("Original CC0 music\0", "utf16le"),
		},
		{
			encoding: "UTF-16BE",
			payload: Buffer.from("Original CC0 music\0", "utf16le").swap16(),
		},
	] as const)("accepts lawful $encoding LIST/INFO metadata", async ({ payload }) => {
		const title = riffChunk("INAM", payload);
		const list = riffChunk(
			"LIST",
			Buffer.concat([Buffer.from("INFO", "ascii"), title]),
		);
		const root = await wavMetadataRoot(list);
		const result = runCli(MUSIC_CHECK, root);

		expect(result.error).toBeUndefined();
		expect(result.status, result.output).toBe(0);
		expect(result.output).toContain("Music policy verified");
	});

	it("rejects UTF-16LE prohibited metadata after non-Latin text", async () => {
		const root = await wavMetadataRoot(
			riffChunk(
				"JUNK",
				Buffer.from(`${"界".repeat(19)}Kаtamari soundtrack`, "utf16le"),
			),
		);
		const result = runCli(MUSIC_CHECK, root);

		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.output).toContain(
			"E_SOUNDTRACK_PROHIBITED /tracks/snowdrift-signal/decodedAudio/metadata",
		);
	});



	it("accepts an innocuous leading JUNK chunk", async () => {
		const root = await wavMetadataRoot(
			riffChunk("JUNK", Buffer.from("reviewed build marker", "utf8")),
		);
		const result = runCli(MUSIC_CHECK, root);

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.output).toContain("Music policy verified");
	});

	it("passes the exact repository music policy without fixture reserialization", () => {
		const result = runCli(MUSIC_CHECK, ROOT);

		expect(result.error).toBeUndefined();
		expect(result.status, result.output).toBe(0);
		expect(result.output).toContain("Music policy verified");
	});

	it.each(CLIS)("passes the valid $name CLI", async ({ script, success }) => {
		const cwd =
			script === MUSIC_CHECK ? await selfConsistentMusicRoot() : ROOT;
		const result = runCli(script, cwd);

		expect(result.status).toBe(0);
		expect(result.output).toContain(success);
	});
});
