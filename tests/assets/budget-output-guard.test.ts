import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { buildDeterministicPackageArtifact } from "../../tools/assets/lib/asset-pipeline.mjs";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const BUDGET_SCRIPT = join(ROOT, "tools", "assets", "budget-report.mjs");
const BUDGET_PATH = join("docs", "assets", "starter-content-budget.json");
const temporaryRoots: string[] = [];

async function copiedRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "snowball-budget-output-"));
	temporaryRoots.push(root);
	await Promise.all([
		cp(join(ROOT, "content"), join(root, "content"), { recursive: true }),
		mkdir(join(root, "docs", "assets"), { recursive: true }),
	]);
	await Promise.all([
		symlink(join(ROOT, "node_modules"), join(root, "node_modules"), "dir"),
		symlink(join(ROOT, "packages"), join(root, "packages"), "dir"),
	]);
	return root;
}

async function externalSentinel(): Promise<{
	root: string;
	path: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "snowball-budget-external-"));
	temporaryRoots.push(root);
	const path = join(root, "sentinel.txt");
	await writeFile(path, "EXTERNAL_SENTINEL_UNTOUCHED", "utf8");
	return { root, path };
}

async function runBudget(root: string, ...args: string[]): Promise<{
	stdout: string;
	stderr: string;
}> {
	return execFileAsync(process.execPath, [BUDGET_SCRIPT, ...args], {
		cwd: root,
		timeout: 60_000,
	});
}

function amplifiedGlb(payload: string): Buffer {
	const json = Buffer.from(
		JSON.stringify({
			extras: { payload },
			asset: { version: "2.0" },
		}),
		"utf8",
	);
	const paddedLength = Math.ceil(json.length / 4) * 4;
	const output = Buffer.alloc(20 + paddedLength, 0x20);
	output.writeUInt32LE(0x46546c67, 0);
	output.writeUInt32LE(2, 4);
	output.writeUInt32LE(output.length, 8);
	output.writeUInt32LE(paddedLength, 12);
	output.writeUInt32LE(0x4e4f534a, 16);
	json.copy(output, 20);
	return output;
}

function replacePackageReference(
	value: unknown,
	replacement: Readonly<Record<string, string>>,
): void {
	if (Array.isArray(value)) {
		for (const entry of value) replacePackageReference(entry, replacement);
		return;
	}
	if (value === null || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	if (record.name === replacement.name && "manifestSha256" in record) {
		for (const key of Object.keys(record))
			if (Object.hasOwn(replacement, key)) record[key] = replacement[key];
	}
	for (const entry of Object.values(record))
		replacePackageReference(entry, replacement);
}

async function writeReconciledPackage(
	root: string,
	directory: string,
	mutate?: (manifest: Record<string, unknown>) => void,
): Promise<Readonly<Record<string, string>>> {
	const packageRoot = join(root, "content", directory);
	const manifestPath = join(packageRoot, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
		string,
		unknown
	>;
	mutate?.(manifest);
	const assets = manifest.assets as Array<{ path: string }>;
	const assetBytes = new Map<string, Buffer>(
		await Promise.all(
			assets.map(
				async (asset) =>
					[asset.path, await readFile(join(packageRoot, asset.path))] as const,
			),
		),
	);
	const artifact = buildDeterministicPackageArtifact(
		manifest as never,
		assetBytes,
	);
	await writeFile(
		manifestPath,
		`${JSON.stringify(artifact.manifest, null, 2)}\n`,
	);
	return {
		name: artifact.manifest.name,
		version: artifact.manifest.version,
		kind: artifact.manifest.kind,
		engine: artifact.manifest.engine,
		integrity: artifact.integrity,
		manifestSha256: artifact.manifestSha256,
		catalogEntryId: `catalog:${artifact.manifest.name.replace("@infinite-snowball/", "")}:${artifact.manifest.version}`,
	};
}

async function addBudgetAmplificationAssets(root: string): Promise<string> {
	const packageRoot = join(root, "content", "starter-level");
	const manifestPath = join(packageRoot, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
		assets: Array<Record<string, unknown>>;
	};
	const template = manifest.assets.find(
		(asset) => asset.mime === "model/gltf-binary",
	);
	if (template === undefined) throw new Error("missing level GLB test fixture");
	const sentinel = "AMPLIFICATION_SENTINEL_";
	let deterministicText = sentinel;
	for (let index = 0; deterministicText.length < 140 * 1024; index += 1)
		deterministicText += createHash("sha256")
			.update(`budget-amplification-${index}`, "utf8")
			.digest("hex");
	const bytes = amplifiedGlb(deterministicText.slice(0, 140 * 1024));
	const digest = createHash("sha256").update(bytes).digest("hex");
	const additions = Array.from({ length: 120 }, (_, index) => {
		const path = `assets/amplified-${String(index).padStart(3, "0")}.glb`;
		return {
			...structuredClone(template),
			assetId: `amplified-${index}`,
			role: index % 2 === 0 ? "arena" : "layout",
			path,
			bytes: bytes.length,
			sha256: digest,
			provenance: {
				...structuredClone(template.provenance as Record<string, unknown>),
				outputSha256: digest,
			},
		};
	});
	await Promise.all(
		additions.map((asset) => writeFile(join(packageRoot, asset.path), bytes)),
	);
	const levelReference = await writeReconciledPackage(
		root,
		"starter-level",
		(levelManifest) => {
			(levelManifest.assets as Array<Record<string, unknown>>).push(...additions);
			const entries = levelManifest.entries as Array<Record<string, unknown>>;
			const templateEntry = entries[0];
			if (templateEntry === undefined) {
				throw new Error("Missing starter level entry fixture");
			}
			for (let index = 0; index < additions.length; index += 2) {
				const arenaAsset = additions[index];
				const layoutAsset = additions[index + 1];
				if (arenaAsset === undefined || layoutAsset === undefined) {
					throw new Error("Missing amplified level asset pair");
				}
				entries.push({
					...structuredClone(templateEntry),
					levelId: `amplified-level-${index / 2}`,
					arenaAssetId: arenaAsset.assetId,
					layoutAssetId: layoutAsset.assetId,
					budgets: {
						...(templateEntry.budgets as Record<string, unknown>),
						maxBytes: bytes.length,
					},
				});
			}
		},
	);
	await writeReconciledPackage(root, "starter-campaign", (campaignManifest) => {
		replacePackageReference(campaignManifest, levelReference);
	});
	return sentinel;
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots
			.splice(0)
			.map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("P03 budget evidence output guard", () => {
	it.each(["docs", "docs/assets"])(
		"rejects a symlinked %s parent without writing outside the project",
		async (parentPath) => {
			const root = await copiedRoot();
			const external = await externalSentinel();
			const parent = join(root, parentPath);
			await rm(parent, { recursive: true, force: true });
			await symlink(external.root, parent, "dir");

			await expect(runBudget(root)).rejects.toMatchObject({
				stderr: expect.stringContaining("E_BUDGET_OUTPUT_PATH"),
			});
			expect(await readFile(external.path, "utf8")).toBe(
				"EXTERNAL_SENTINEL_UNTOUCHED",
			);
			expect(await readdir(external.root)).toEqual(["sentinel.txt"]);
		},
	);

	it.each([
		["generate", []],
		["check", ["--check"]],
	] as const)(
		"rejects a symlinked target during %s without changing its external file",
		async (_mode, args) => {
			const root = await copiedRoot();
			const external = await externalSentinel();
			await symlink(external.path, join(root, BUDGET_PATH));

			await expect(runBudget(root, ...args)).rejects.toMatchObject({
				stderr: expect.stringContaining("E_BUDGET_OUTPUT_PATH"),
			});
			expect(await readFile(external.path, "utf8")).toBe(
				"EXTERNAL_SENTINEL_UNTOUCHED",
			);
		},
	);

	it("preserves valid atomic generation and bounded checking", async () => {
		const root = await copiedRoot();
		await expect(runBudget(root)).resolves.toMatchObject({
			stdout: expect.stringContaining("Starter asset budget verified"),
		});
		await expect(runBudget(root, "--check")).resolves.toMatchObject({
			stdout: expect.stringContaining("Starter asset budget verified"),
		});
	});

	it("keeps amplified GLB text out of bounded generate and check evidence", async () => {
		const root = await copiedRoot();
		const sentinel = await addBudgetAmplificationAssets(root);
		await expect(runBudget(root)).resolves.toMatchObject({
			stdout: expect.stringContaining("Starter asset budget verified"),
		});
		const evidence = await readFile(join(root, BUDGET_PATH));
		expect(evidence.length).toBeLessThanOrEqual(16 * 1024 * 1024);
		expect(evidence.toString("utf8")).not.toContain(sentinel);
		await expect(runBudget(root, "--check")).resolves.toMatchObject({
			stdout: expect.stringContaining("Starter asset budget verified"),
		});
	});
});
