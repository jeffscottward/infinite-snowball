import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONTENT_BUDGETS,
  PACKAGE_LIMITS,
  PROTOCOL_SCHEMA_VERSION,
  SafeRelativePathSchema,
  VALIDATOR_VERSION,
  parseManifest,
  type Manifest,
} from "../../packages/protocol/src/browser.js";

const ROOT = process.cwd();
const GOLDEN_DIR = join(ROOT, "tests", "fixtures", "protocol", "golden");
const KINDS = ["level", "character", "object-pack", "campaign", "music", "bundle"] as const;

async function readGolden(kind: (typeof KINDS)[number]): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(GOLDEN_DIR, `${kind}.json`), "utf8")) as Record<string, unknown>;
}


describe("strict manifest protocol", () => {
  it("accepts complete golden fixtures for all six declarative content kinds", async () => {
    for (const kind of KINDS) {
      const result = parseManifest(await readGolden(kind));
      expect(result, kind).toMatchObject({ ok: true, issues: [] });
      if (result.ok) {
        expect(result.value.kind).toBe(kind);
        expect(result.value.schemaVersion).toBe(PROTOCOL_SCHEMA_VERSION);
      }
    }

    expect(PROTOCOL_SCHEMA_VERSION).toBe("1.0.0");
    expect(VALIDATOR_VERSION).toBe("1.0.0");
  });

  it("rejects missing and unknown fields at every strict object boundary", async () => {
    const missing = await readGolden("level");
    delete missing.name;
    const missingResult = parseManifest(missing);
    expect(missingResult.ok).toBe(false);
    expect(missingResult.issues[0]?.ruleId).toBe("E_SCHEMA_STRICT");

    const unknown = await readGolden("level");
    (unknown.metadata as Record<string, unknown>).unexpected = true;
    const unknownResult = parseManifest(unknown);
    expect(unknownResult.ok).toBe(false);
    expect(unknownResult.issues[0]?.ruleId).toBe("E_SCHEMA_STRICT");

    const nestedUnknown = await readGolden("level");
    const firstAsset = (nestedUnknown.assets as Array<Record<string, unknown>>)[0];
    const provenance = firstAsset?.provenance as Record<string, unknown>;
    provenance.unreviewed = "forbidden";
    expect(parseManifest(nestedUnknown).ok).toBe(false);
  });

  it("requires exact identities, exact dependency refs, and an empty v1 capabilities object", async () => {
    const ranged = await readGolden("level");
    const dependency = structuredClone((await readGolden("object-pack")) as Manifest);
    (ranged.dependencies as unknown[]).push({
      name: dependency.name,
      version: "^1.0.0",
      kind: dependency.kind,
      engine: dependency.engine,
      integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
      manifestSha256: "a".repeat(64),
      catalogEntryId: "catalog:ranged",
    });
    const rangedResult = parseManifest(ranged);
    expect(rangedResult.ok).toBe(false);
    expect(rangedResult.issues[0]?.ruleId).toBe("E_DEPENDENCY_EXACT");

    const capabilities = await readGolden("level");
    capabilities.capabilities = { scripts: true };
    expect(parseManifest(capabilities)).toMatchObject({ ok: false });

    const invalidVersion = await readGolden("level");
    invalidVersion.version = "latest";
    const versionResult = parseManifest(invalidVersion);
    expect(versionResult.ok).toBe(false);
    expect(versionResult.issues[0]?.ruleId).toBe("E_DEPENDENCY_EXACT");
  });

  it("requires allowlisted package and per-asset licenses with complete provenance", async () => {
    const unsafeLicense = await readGolden("music");
    unsafeLicense.license = "CC-BY-NC-4.0";
    const licenseResult = parseManifest(unsafeLicense);
    expect(licenseResult.ok).toBe(false);
    expect(licenseResult.issues[0]?.ruleId).toBe("E_LICENSE_POLICY");

    const incomplete = await readGolden("music");
    const firstAsset = (incomplete.assets as Array<Record<string, unknown>>)[0];
    const provenance = firstAsset?.provenance as Record<string, unknown>;
    delete provenance.attribution;
    expect(parseManifest(incomplete).ok).toBe(false);

    const missingTransform = await readGolden("level");
    const transformedAsset = (missingTransform.assets as Array<Record<string, unknown>>)[0];
    const transformedProvenance = transformedAsset?.provenance as Record<string, unknown>;
    delete transformedProvenance.transformation;
    expect(parseManifest(missingTransform).ok).toBe(false);
  });

  it("rejects non-normalized paths at direct schema and manifest boundaries", async () => {
    const invalidPaths = ["a//b", "./a", "a/.", "a/", "cafe\u0301/file.glb"];

    for (const path of invalidPaths) {
      expect(SafeRelativePathSchema.safeParse(path).success, path).toBe(false);

      const manifest = await readGolden("level");
      const asset = (manifest.assets as Array<Record<string, unknown>>)[0];
      if (asset === undefined) throw new Error("Golden level fixture must contain an asset.");
      asset.path = path;
      expect(parseManifest(manifest).ok, path).toBe(false);
    }

    expect(SafeRelativePathSchema.safeParse("café/file.glb").success).toBe(true);
  });

  it("enforces deterministic package budget ceilings before fetch or install", async () => {
    const overFiles = await readGolden("bundle");
    (overFiles.totals as Record<string, unknown>).fileCount = PACKAGE_LIMITS.maxFiles + 1;
    expect(parseManifest(overFiles).ok).toBe(false);

    const overBytes = await readGolden("bundle");
    (overBytes.totals as Record<string, unknown>).bytes = PACKAGE_LIMITS.maxDeclaredBytes + 1;
    expect(parseManifest(overBytes).ok).toBe(false);

    const overDepth = await readGolden("bundle");
    (overDepth.totals as Record<string, unknown>).maxDepth = PACKAGE_LIMITS.maxDepth + 1;
    expect(parseManifest(overDepth).ok).toBe(false);

    const overRatio = await readGolden("bundle");
    (overRatio.totals as Record<string, unknown>).maxCompressionRatio = PACKAGE_LIMITS.maxCompressionRatio + 1;
    expect(parseManifest(overRatio).ok).toBe(false);
  });
  it("validates inventory-derived totals while allowing measured download bytes", async () => {
    const underreportedBytes = await readGolden("bundle");
    (underreportedBytes.totals as Record<string, unknown>).uncompressedBytes = 1;
    const bytesResult = parseManifest(underreportedBytes);
    expect(bytesResult.ok).toBe(false);
    expect(bytesResult.issues[0]).toMatchObject({ ruleId: "E_FILE_BUDGET", path: "/totals/uncompressedBytes" });

    const underreportedDepth = await readGolden("bundle");
    (underreportedDepth.totals as Record<string, unknown>).maxDepth = 1;
    const depthResult = parseManifest(underreportedDepth);
    expect(depthResult.ok).toBe(false);
    expect(depthResult.issues[0]).toMatchObject({ ruleId: "E_FILE_BUDGET", path: "/totals/maxDepth" });
    const compressedDownload = await readGolden("bundle");
    (compressedDownload.totals as Record<string, unknown>).bytes = 512;
    (compressedDownload.totals as Record<string, unknown>).maxCompressionRatio = 2;
    expect(parseManifest(compressedDownload)).toMatchObject({ ok: true, issues: [] });
  });
  it("rejects missing scalar, array, and metadata-path asset references", async () => {
    const missingScalar = await readGolden("level");
    ((missingScalar.entries as Array<Record<string, unknown>>)[0] as Record<string, unknown>).arenaAssetId =
      "missing-arena";
    const scalarResult = parseManifest(missingScalar);
    expect(scalarResult.ok).toBe(false);
    expect(scalarResult.issues[0]).toMatchObject({
      ruleId: "E_PATH_POLICY",
      path: "/entries/0/arenaAssetId",
    });

    const missingArray = await readGolden("character");
    ((missingArray.entries as Array<Record<string, unknown>>)[0] as Record<string, unknown>).screenshotAssetIds = [
      "missing-shot",
    ];
    const arrayResult = parseManifest(missingArray);
    expect(arrayResult.ok).toBe(false);
    expect(arrayResult.issues[0]).toMatchObject({
      ruleId: "E_PATH_POLICY",
      path: "/entries/0/screenshotAssetIds/0",
    });

    const missingMetadataPath = await readGolden("bundle");
    ((missingMetadataPath.metadata as Record<string, unknown>).screenshots as unknown[]) = ["assets/missing.png"];
    const metadataResult = parseManifest(missingMetadataPath);
    expect(metadataResult.ok).toBe(false);
    expect(metadataResult.issues[0]).toMatchObject({
      ruleId: "E_PATH_POLICY",
      path: "/metadata/screenshots/0",
    });
  });



  describe("frozen P03 level and music handoff budgets", () => {
    type BudgetIssueExpectation = { path: string; ruleId?: string };
    type BudgetCase = {
      name: string;
      kind: "level" | "music";
      mutate: (manifest: Record<string, unknown>) => void;
      expectedIssues: BudgetIssueExpectation[];
    };

    function expectBudgetIssues(manifest: Record<string, unknown>, expectedIssues: BudgetIssueExpectation[]): void {
      const result = parseManifest(manifest);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      const actualIssues = result.issues.map((issue) => ({ path: issue.path, ruleId: issue.ruleId }));
      expect(actualIssues.map((issue) => issue.path).sort()).toEqual(
        expectedIssues.map((issue) => issue.path).sort(),
      );
      for (const expectedIssue of expectedIssues) {
        const actualIssue = actualIssues.find((issue) => issue.path === expectedIssue.path);
        expect(actualIssue).toBeDefined();
        if (actualIssue !== undefined && expectedIssue.ruleId !== undefined) {
          expect(actualIssue.ruleId).toBe(expectedIssue.ruleId);
        }
      }
    }

    const frozenBudgetCases: BudgetCase[] = [
      {
        name: "rejects level download bytes above the frozen ceiling",
        kind: "level",
        mutate: (manifest) => {
          (manifest.totals as Record<string, unknown>).bytes = CONTENT_BUDGETS.level.maxDownloadBytes + 1;
        },
        expectedIssues: [{ path: "/totals/bytes", ruleId: "E_FILE_BUDGET" }],
      },
      {
        name: "rejects level uncompressed bytes above the frozen ceiling with matching asset totals",
        kind: "level",
        mutate: (manifest) => {
          const assets = manifest.assets as Array<Record<string, unknown>>;
          const template = assets[0];
          if (template === undefined) throw new Error("Golden level requires an asset");

          const overBudgetBytes = CONTENT_BUDGETS.level.maxUncompressedBytes + 1;
          const replacementBytes = [
            CONTENT_BUDGETS.level.maxFileBytes,
            CONTENT_BUDGETS.level.maxFileBytes,
            CONTENT_BUDGETS.level.maxFileBytes,
            overBudgetBytes - CONTENT_BUDGETS.level.maxFileBytes * 3,
          ];
          manifest.assets = replacementBytes.map((bytes, index) => {
            const asset = structuredClone(assets[index] ?? template);
            asset.bytes = bytes;
            if (index >= assets.length) {
              asset.assetId = `uncompressed-budget-evidence-${index}`;
              asset.path = `assets/uncompressed-budget-evidence-${index}.json`;
              asset.mime = "application/json";
              asset.role = "budget-evidence";
            }
            return asset;
          });

          const totals = manifest.totals as Record<string, unknown>;
          totals.fileCount = (manifest.assets as Array<Record<string, unknown>>).length;
          totals.uncompressedBytes = overBudgetBytes;
          totals.bytes = Math.ceil(overBudgetBytes / PACKAGE_LIMITS.maxCompressionRatio);
          totals.maxCompressionRatio = PACKAGE_LIMITS.maxCompressionRatio;
        },
        expectedIssues: [{ path: "/totals/uncompressedBytes", ruleId: "E_FILE_BUDGET" }],
      },
      {
        name: "rejects a level file above the frozen per-file ceiling with matching aggregate totals",
        kind: "level",
        mutate: (manifest) => {
          const firstAsset = (manifest.assets as Array<Record<string, unknown>>)[0];
          if (firstAsset === undefined) throw new Error("Golden level requires an asset");

          firstAsset.bytes = CONTENT_BUDGETS.level.maxFileBytes + 1;
          const totalBytes = (manifest.assets as Array<Record<string, unknown>>).reduce(
            (total, asset) => total + (asset.bytes as number),
            0,
          );
          const totals = manifest.totals as Record<string, unknown>;
          totals.bytes = totalBytes;
          totals.uncompressedBytes = totalBytes;
        },
        expectedIssues: [{ path: "/assets/0/bytes", ruleId: "E_FILE_BUDGET" }],
      },
      {
        name: "rejects level file count above the frozen ceiling with coherent asset inventory evidence",
        kind: "level",
        mutate: (manifest) => {
          const assets = manifest.assets as Array<Record<string, unknown>>;
          const template = assets[0];
          if (template === undefined) throw new Error("Golden level requires an asset");

          for (let index = assets.length; index < CONTENT_BUDGETS.level.maxFiles + 1; index += 1) {
            const asset = structuredClone(template);
            asset.assetId = `file-count-evidence-${index}`;
            asset.path = `assets/file-count-evidence-${index}.json`;
            asset.mime = "application/json";
            asset.bytes = 1;
            asset.role = "file-count-evidence";
            assets.push(asset);
          }

          const totalBytes = (manifest.assets as Array<Record<string, unknown>>).reduce(
            (total, asset) => total + (asset.bytes as number),
            0,
          );
          const totals = manifest.totals as Record<string, unknown>;
          totals.bytes = totalBytes;
          totals.fileCount = assets.length;
          totals.uncompressedBytes = totalBytes;
        },
        expectedIssues: [
          { path: "/totals/fileCount", ruleId: "E_FILE_BUDGET" },
          { path: "/assets", ruleId: "E_SCHEMA_STRICT" },
        ],
      },
      {
        name: "rejects music pack download bytes above the frozen ceiling",
        kind: "music",
        mutate: (manifest) => {
          (manifest.totals as Record<string, unknown>).bytes = CONTENT_BUDGETS.music.maxPackBytes + 1;
        },
        expectedIssues: [{ path: "/totals/bytes", ruleId: "E_FILE_BUDGET" }],
      },
      {
        name: "rejects music track duration above the frozen ceiling",
        kind: "music",
        mutate: (manifest) => {
          const entry = (manifest.entries as Array<Record<string, unknown>>)[0];
          if (entry === undefined) throw new Error("Golden music requires an entry");
          const track = (entry.tracks as Array<Record<string, unknown>>)[0];
          if (track === undefined) throw new Error("Golden music requires a track");
          track.durationSeconds = CONTENT_BUDGETS.music.maxTrackSeconds + 1;
        },
        // Duration is currently surfaced by generic schema classification, not a stable budget rule.
        expectedIssues: [{ path: "/entries/0/tracks/0/durationSeconds" }],
      },
    ];

    it.each(frozenBudgetCases)("$name", async ({ kind, mutate, expectedIssues }) => {
      const manifest = await readGolden(kind);
      mutate(manifest);
      expectBudgetIssues(manifest, expectedIssues);
    });
  });

  it("admits a max-cardinality level entry within the derived snapshot budget", async () => {
    const level = await readGolden("level");
    const entry = (level.entries as Array<Record<string, unknown>>)[0];
    if (entry === undefined) throw new Error("Golden level requires an entry");
    const groupTemplate = (entry.collectibleGroups as Array<Record<string, unknown>>)[0];
    if (groupTemplate === undefined) throw new Error("Golden level requires a collectible group");
    entry.collectibleGroups = Array.from({ length: 128 }, (_, groupIndex) => ({
      ...structuredClone(groupTemplate),
      id: `group:${groupIndex}`,
      objectIds: Array.from(
        { length: 1_024 },
        (_, objectIndex) => `collectible:${groupIndex}:${objectIndex}`,
      ),
    }));

    expect(parseManifest(level)).toMatchObject({ ok: true, issues: [] });
  });
});
