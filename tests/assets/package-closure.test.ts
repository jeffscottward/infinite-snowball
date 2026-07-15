import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { inspectStarterPackages } from "../../tools/assets/lib/asset-pipeline.mjs";

const ROOT = process.cwd();
const CONTENT_ROOT = join(ROOT, "content");

async function copiedContent(): Promise<string> {
	const output = await mkdtemp(join(tmpdir(), "infinite-snowball-closure-"));
	await cp(CONTENT_ROOT, output, { recursive: true });
	return output;
}

async function mutateManifest(
	contentRoot: string,
	packageName: string,
	mutate: (manifest: Record<string, any>) => void,
): Promise<void> {
	const path = join(contentRoot, packageName, "manifest.json");
	const manifest = JSON.parse(await readFile(path, "utf8"));
	mutate(manifest);
	await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function expectReferenceFailure(
	packageName: string,
	remediation: RegExp,
	mutate: (manifest: Record<string, any>) => void,
): Promise<void> {
	const contentRoot = await copiedContent();
	try {
		await mutateManifest(contentRoot, packageName, mutate);
		const inspected = await inspectStarterPackages({ root: ROOT, contentRoot });
		expect(inspected.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					ruleId: "E_PACKAGE_REF",
					path: `/${packageName}`,
					remediation: expect.stringMatching(remediation),
				}),
			]),
		);
	} finally {
		await rm(contentRoot, { recursive: true, force: true });
	}
}

describe("starter package closure", () => {
	it("requires entry-used package refs to remain declared dependencies", async () => {
		await expectReferenceFailure("starter-level", /entry-used package/u, (manifest) => {
			manifest.dependencies = [];
		});
	});

	it("resolves campaign level IDs in the exact referenced level package", async () => {
		await expectReferenceFailure("starter-campaign", /campaign level ID/u, (manifest) => {
			manifest.entries[0].levels[0].levelId = "missing-snowfield";
		});
	});

	it("resolves collectible and final-goal object IDs", async () => {
		await expectReferenceFailure("starter-level", /collectible object ID/u, (manifest) => {
			manifest.entries[0].collectibleGroups[0].objectIds = ["missing-rock"];
		});
		await expectReferenceFailure("starter-level", /final-goal object ID/u, (manifest) => {
			manifest.entries[0].finalGoal.objectId = "lost-stone";
		});
	});

	it("requires level music refs to resolve to exact music packages", async () => {
		await expectReferenceFailure("starter-level", /music package reference/u, (manifest) => {
			const objectPack = manifest.dependencies.find(
				(reference: { kind: string }) => reference.kind === "object-pack",
			);
			manifest.entries[0].musicRefs = [objectPack];
		});
	});

	it("permits an absent optional peer without weakening required closure", async () => {
		const contentRoot = await copiedContent();
		try {
			await mutateManifest(contentRoot, "starter-campaign", (manifest) => {
				manifest.optionalPeers = [
					{
						...manifest.dependencies[0],
						name: "@community/missing-pack",
						catalogEntryId: "catalog:missing-pack:1.0.0",
					},
				];
			});
			const inspected = await inspectStarterPackages({ root: ROOT, contentRoot });
			expect(
				inspected.issues.filter((issue) => issue.ruleId === "E_PACKAGE_REF"),
			).toEqual([]);
		} finally {
			await rm(contentRoot, { recursive: true, force: true });
		}
	});

	it("binds each fixed directory to its exact package name and kind", async () => {
		const contentRoot = await copiedContent();
		const temporary = join(contentRoot, "starter-swap");
		try {
			await rename(join(contentRoot, "starter-objects"), temporary);
			await rename(
				join(contentRoot, "starter-music"),
				join(contentRoot, "starter-objects"),
			);
			await rename(temporary, join(contentRoot, "starter-music"));
			const inspected = await inspectStarterPackages({ root: ROOT, contentRoot });
			expect(inspected.issues).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						ruleId: "E_PACKAGE_REF",
						remediation: expect.stringMatching(/fixed starter directory/u),
					}),
				]),
			);
		} finally {
			await rm(contentRoot, { recursive: true, force: true });
		}
	});
});
