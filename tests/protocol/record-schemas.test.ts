import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AssetRecordSchema,
  CATALOG_RESOURCE_BASE_PATH,
  CatalogEntrySchema,
  CatalogPackageAssetSchema,
  CatalogPackageSchema,
  CatalogResourcePathSchema,
  CatalogSnapshotSchema,
  InstallPlanSchema,
  InstallRecordSchema,
  InstallTransactionSchema,
  PackageLockSchema,
  PACKAGE_LIMITS,
  PackageRefSchema,
  ProvenanceSchema,
  SaveExportSchema,
  computeSaveExportIntegrity,
  parseSaveExport,
  resolveCatalogResourceUrl,
  verifySaveExportIntegrity,
} from "../../packages/protocol/src/browser.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const INTEGRITY_B = `sha512-${"B".repeat(85)}Q==`;
const NOW = "2026-07-14T00:00:00.000Z";
const PACKAGE_REF = {
  name: "@infinite-snowball/golden-level",
  version: "1.0.0",
  kind: "level",
  engine: ">=1.0.0 <2.0.0",
  integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  manifestSha256: SHA_A,
  catalogEntryId: "catalog:golden-level:1.0.0",
} as const;

const IMMUTABLE_FILE = {
  path: "assets/arena.glb",
  resourcePath: "packages/golden-level/1.0.0/assets/arena.glb",
  mime: "model/gltf-binary",
  bytes: 1_024,
  sha256: SHA_A,
} as const;

const TOTALS = {
  bytes: 1_024,
  fileCount: 1,
  uncompressedBytes: 1_024,
  maxDepth: 2,
  maxCompressionRatio: 1,
} as const;

const LOCALIZED = { default: "Golden Level", translations: {} } as const;

async function goldenAsset(): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(
    await readFile(join(process.cwd(), "tests", "fixtures", "protocol", "golden", "level.json"), "utf8"),
  ) as { assets: Array<Record<string, unknown>> };
  const asset = manifest.assets[0];
  if (asset === undefined) throw new Error("Golden level requires an asset");
  return asset;
}

type SchemaParseResult =
  | { readonly success: true }
  | {
      readonly success: false;
      readonly error: {
        readonly issues: ReadonlyArray<{ readonly path: readonly PropertyKey[]; readonly message: string }>;
      };
    };

function expectSchemaIssue(result: SchemaParseResult, path: readonly PropertyKey[], message: string): void {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: [...path], message })]),
    );
  }
}

describe("strict remaining protocol records", () => {
  it("validates PackageRef, AssetRecord, and authoritative Provenance records", async () => {
    expect(PackageRefSchema.safeParse(PACKAGE_REF).success).toBe(true);
    const asset = await goldenAsset();
    expect(AssetRecordSchema.safeParse(asset).success).toBe(true);
    expect(ProvenanceSchema.safeParse(asset.provenance).success).toBe(true);

    expect(PackageRefSchema.safeParse({ ...PACKAGE_REF, version: "latest" }).success).toBe(false);
    expect(AssetRecordSchema.safeParse({ ...asset, unknown: true }).success).toBe(false);
    expect(ProvenanceSchema.safeParse({ ...(asset.provenance as object), attribution: undefined }).success).toBe(false);
  });

  it("validates strict normalized catalog snapshot, listing, package, and asset rows", () => {
    const snapshot = {
      snapshotId: "snapshot:2026-07-14",
      schemaVersion: "1.0.0",
      generatedAt: NOW,
      etag: '"catalog-v1"',
      version: "2026.07.14",
      entryIds: [PACKAGE_REF.catalogEntryId],
      resourceBasePath: CATALOG_RESOURCE_BASE_PATH,
      evidenceSha256: SHA_B,
      previousSnapshotId: "snapshot:2026-07-13",
    };
    const entry = {
      entryId: PACKAGE_REF.catalogEntryId,
      snapshotId: snapshot.snapshotId,
      package: PACKAGE_REF,
      kind: "level",
      display: { title: LOCALIZED, description: LOCALIZED },
      screenshots: ["entries/golden-level/1.0.0/screenshots/arena.png"],
      icon: "entries/golden-level/1.0.0/icon.png",
      packageRecordPath: "packages/golden-level/1.0.0/package.json",
      npm: { integrity: PACKAGE_REF.integrity, provenanceVerified: true },
      review: { reviewer: "catalog-maintainer", reviewedAt: NOW, evidenceSha256: SHA_B },
      status: "active",
      replacement: null,
      packageKey: `${PACKAGE_REF.name}@${PACKAGE_REF.version}`,
    };
    const catalogPackage = {
      package: PACKAGE_REF,
      immutableFiles: [IMMUTABLE_FILE],
      totals: TOTALS,
      licenses: ["CC-BY-4.0"],
      engine: PACKAGE_REF.engine,
      manifestSha256: PACKAGE_REF.manifestSha256,
      installEligibility: "eligible",
    };
    const packageAsset = {
      packageName: PACKAGE_REF.name,
      version: PACKAGE_REF.version,
      path: IMMUTABLE_FILE.path,
      resourcePath: IMMUTABLE_FILE.resourcePath,
      sha256: IMMUTABLE_FILE.sha256,
      referenceCountEligible: true,
    };

    expect(CatalogSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(CatalogEntrySchema.safeParse(entry).success).toBe(true);
    expect(CatalogPackageSchema.safeParse(catalogPackage).success).toBe(true);
    expect(CatalogPackageAssetSchema.safeParse(packageAsset).success).toBe(true);

    expectSchemaIssue(
      CatalogEntrySchema.safeParse({ ...entry, entryId: "catalog:wrong:1.0.0" }),
      ["entryId"],
      "Expected CatalogEntry entryId to match package catalogEntryId",
    );
    expectSchemaIssue(
      CatalogEntrySchema.safeParse({ ...entry, kind: "character" }),
      ["kind"],
      "Expected CatalogEntry kind to match package kind",
    );
    expectSchemaIssue(
      CatalogEntrySchema.safeParse({ ...entry, npm: { ...entry.npm, integrity: INTEGRITY_B } }),
      ["npm", "integrity"],
      "Expected CatalogEntry npm integrity to match package integrity",
    );
    expectSchemaIssue(
      CatalogEntrySchema.safeParse({ ...entry, packageKey: `${PACKAGE_REF.name}@9.9.9` }),
      ["packageKey"],
      "Expected CatalogEntry packageKey to match package name and version",
    );
    expectSchemaIssue(
      CatalogPackageSchema.safeParse({ ...catalogPackage, engine: ">=2.0.0 <3.0.0" }),
      ["engine"],
      "Expected CatalogPackage engine to match package engine",
    );
    expectSchemaIssue(
      CatalogPackageSchema.safeParse({ ...catalogPackage, manifestSha256: SHA_B }),
      ["manifestSha256"],
      "Expected CatalogPackage manifestSha256 to match package manifest SHA-256",
    );
    expect(CatalogSnapshotSchema.safeParse({ ...snapshot, unexpected: true }).success).toBe(false);
    expect(CatalogEntrySchema.safeParse({ ...entry, unexpected: true }).success).toBe(false);
    expect(CatalogPackageSchema.safeParse({ ...catalogPackage, unexpected: true }).success).toBe(false);
    expect(CatalogPackageAssetSchema.safeParse({ ...packageAsset, unexpected: true }).success).toBe(false);
    expect(
      CatalogSnapshotSchema.safeParse({
        ...snapshot,
        cdnBaseUrl: "https://cdn.example.com/",
      }).success,
    ).toBe(false);
    expect(
      CatalogPackageSchema.safeParse({
        ...catalogPackage,
        immutableFiles: [{ ...IMMUTABLE_FILE, url: "https://cdn.example.com/arena.glb" }],
      }).success,
    ).toBe(false);
    expect(
      CatalogPackageAssetSchema.safeParse({
        ...packageAsset,
        url: "https://cdn.example.com/arena.glb",
      }).success,
    ).toBe(false);
    for (const resourceBasePath of ["catalog/", "./catalog", "/catalog/", "https://cdn.example/"]) {
      expect(
        CatalogSnapshotSchema.safeParse({ ...snapshot, resourceBasePath }).success,
        resourceBasePath,
      ).toBe(false);
    }

    const invalidResourcePaths = [
      "",
      "/asset.glb",
      "//cdn.example/asset.glb",
      "../asset.glb",
      "a/../asset.glb",
      "./asset.glb",
      "a/./asset.glb",
      "a//asset.glb",
      "a/",
      "https://cdn.example/asset.glb",
      "C:/asset.glb",
      "\\\\server\\asset.glb",
      "a\\asset.glb",
      "a:b/asset.glb",
      "a%2fasset.glb",
      "%2e%2e/asset.glb",
      "%252e%252e/asset.glb",
      "asset.glb?version=1",
      "asset.glb#fragment",
      "café.glb",
      "a\u0000b.glb",
      "a\nb.glb",
      "a\u001fb.glb",
      "asset.glb\n",
      "asset.glb\r",
      "asset.glb\r\n",
      "asset.glb\u2028",
      "asset.glb\u2029",
    ];
    for (const resourcePath of invalidResourcePaths) {
      expect(() => CatalogResourcePathSchema.safeParse(resourcePath)).not.toThrow();
      expect(CatalogResourcePathSchema.safeParse(resourcePath).success, resourcePath).toBe(false);
      expect(
        CatalogEntrySchema.safeParse({
          ...entry,
          packageRecordPath: resourcePath,
        }).success,
        resourcePath,
      ).toBe(false);
      expect(
        CatalogEntrySchema.safeParse({ ...entry, screenshots: [resourcePath] }).success,
        `screenshot:${JSON.stringify(resourcePath)}`,
      ).toBe(false);
      expect(
        CatalogEntrySchema.safeParse({ ...entry, icon: resourcePath }).success,
        `icon:${JSON.stringify(resourcePath)}`,
      ).toBe(false);
      expect(
        CatalogPackageSchema.safeParse({
          ...catalogPackage,
          immutableFiles: [{ ...IMMUTABLE_FILE, resourcePath }],
        }).success,
        `immutable:${JSON.stringify(resourcePath)}`,
      ).toBe(false);
      expect(
        CatalogPackageAssetSchema.safeParse({ ...packageAsset, resourcePath }).success,
        `package-asset:${JSON.stringify(resourcePath)}`,
      ).toBe(false);
    }
  });

  it("resolves catalog resources inside root and project-prefix catalog subtrees without throwing", () => {
    const resourcePath = "packages/golden-level/1.0.0/assets/arena.glb";
    expect(CatalogResourcePathSchema.safeParse(resourcePath).success).toBe(true);
    expect(
      resolveCatalogResourceUrl("https://game.example/", CATALOG_RESOURCE_BASE_PATH, resourcePath),
    ).toEqual({
      ok: true,
      url: "https://game.example/catalog/packages/golden-level/1.0.0/assets/arena.glb",
    });
    expect(
      resolveCatalogResourceUrl(
        "https://game.example/infinite-snowball/",
        CATALOG_RESOURCE_BASE_PATH,
        resourcePath,
      ),
    ).toEqual({
      ok: true,
      url: "https://game.example/infinite-snowball/catalog/packages/golden-level/1.0.0/assets/arena.glb",
    });

    for (const input of [
      ["not-a-url", CATALOG_RESOURCE_BASE_PATH, resourcePath],
      ["https://game.example/", "https://cdn.example/", resourcePath],
      ["https://game.example/", CATALOG_RESOURCE_BASE_PATH, "../escape.glb"],
      ["https://user:secret@game.example/", CATALOG_RESOURCE_BASE_PATH, resourcePath],
    ] as const) {
      const [appBaseUrl, resourceBasePath, candidatePath] = input;
      expect(() => resolveCatalogResourceUrl(appBaseUrl, resourceBasePath, candidatePath)).not.toThrow();
      expect(resolveCatalogResourceUrl(appBaseUrl, resourceBasePath, candidatePath).ok).toBe(false);
    }
  });

  it("validates strict locks, plans, transactions, and install records", () => {
    const lock = {
      lockId: "lock:golden:1",
      schemaVersion: "1.0.0",
      catalogSnapshotId: "snapshot:2026-07-14",
      engineVersion: "1.0.0",
      packages: [{ package: PACKAGE_REF, dependencies: [] }],
      files: [IMMUTABLE_FILE],
      createdAt: NOW,
      active: true,
    };
    const plan = {
      planId: "plan:golden:1",
      schemaVersion: "1.0.0",
      packages: [PACKAGE_REF],
      dependencyOrder: [`${PACKAGE_REF.name}@${PACKAGE_REF.version}`],
      files: [IMMUTABLE_FILE],
      expectedBytes: 1_024,
      quota: { requiredBytes: 1_024, availableBytes: 4_096, persistenceRequested: true },
      offline: { available: true, missingFiles: [] },
    };
    const secondPackage = {
      ...PACKAGE_REF,
      name: "@infinite-snowball/bonus-level",
      version: "1.1.0",
      manifestSha256: SHA_B,
      catalogEntryId: "catalog:bonus-level:1.1.0",
    };
    const secondImmutableFile = {
      ...IMMUTABLE_FILE,
      path: "assets/bonus.glb",
      resourcePath: "packages/golden-level/1.0.0/assets/bonus.glb",
      sha256: SHA_B,
    };
    const missingFilePath = "assets/missing.glb";
    const packageKey = `${PACKAGE_REF.name}@${PACKAGE_REF.version}`;
    const secondPackageKey = `${secondPackage.name}@${secondPackage.version}`;
    const phantomPackageKey = "@infinite-snowball/phantom-level@9.9.9";
    const installPlanMutations = [
      [
        "duplicate package identities",
        { ...plan, packages: [PACKAGE_REF, { ...PACKAGE_REF }] },
      ],
      [
        "duplicate dependency order rows",
        { ...plan, packages: [PACKAGE_REF, secondPackage], dependencyOrder: [packageKey, packageKey] },
      ],
      [
        "phantom dependency order row",
        { ...plan, packages: [PACKAGE_REF, secondPackage], dependencyOrder: [packageKey, phantomPackageKey] },
      ],
      [
        "missing dependency order row",
        { ...plan, packages: [PACKAGE_REF, secondPackage], dependencyOrder: [packageKey] },
      ],
      [
        "expected byte sum mismatch",
        { ...plan, expectedBytes: 2_048, quota: { ...plan.quota, requiredBytes: 2_048 } },
      ],
      [
        "required quota below expected bytes",
        { ...plan, quota: { ...plan.quota, requiredBytes: plan.expectedBytes - 1 } },
      ],
      [
        "available quota below required bytes",
        { ...plan, quota: { ...plan.quota, availableBytes: plan.quota.requiredBytes - 1 } },
      ],
      [
        "duplicate offline missing file paths",
        { ...plan, offline: { available: false, missingFiles: [missingFilePath, missingFilePath] } },
      ],
      [
        "offline available with missing files",
        { ...plan, offline: { available: true, missingFiles: [missingFilePath] } },
      ],
      [
        "offline unavailable without missing files",
        { ...plan, offline: { available: false, missingFiles: [] } },
      ],
    ] as const;

    const transaction = {
      transactionId: "tx:golden:1",
      schemaVersion: "1.0.0",
      planId: plan.planId,
      state: "planned",
      stagingCacheNamespace: "is-stage-tx-golden-1",
      verifiedFiles: [],
      error: null,
      rollbackActions: [],
      reconciliationStatus: "clean",
      createdAt: NOW,
      updatedAt: NOW,
      retentionUntil: "2026-08-14T00:00:00.000Z",
    };
    const record = {
      package: PACKAGE_REF,
      activeLockId: lock.lockId,
      referenceCounts: { [IMMUTABLE_FILE.sha256]: 1 },
      installedAt: NOW,
      catalogSnapshotId: lock.catalogSnapshotId,
      reconciliationStatus: "clean",
    };

    expect(PackageLockSchema.safeParse(lock).success).toBe(true);
    expect(InstallPlanSchema.safeParse(plan).success).toBe(true);
    expectSchemaIssue(
      PackageLockSchema.safeParse({
        ...lock,
        files: [IMMUTABLE_FILE, { ...secondImmutableFile, path: IMMUTABLE_FILE.path }],
      }),
      ["files", 1, "path"],
      "Expected PackageLock immutable file paths to be unique",
    );
    expectSchemaIssue(
      PackageLockSchema.safeParse({
        ...lock,
        files: [IMMUTABLE_FILE, { ...secondImmutableFile, resourcePath: IMMUTABLE_FILE.resourcePath }],
      }),
      ["files", 1, "resourcePath"],
      "Expected PackageLock immutable file resource paths to be unique",
    );
    expectSchemaIssue(
      InstallPlanSchema.safeParse({
        ...plan,
        files: [IMMUTABLE_FILE, { ...secondImmutableFile, path: IMMUTABLE_FILE.path }],
        expectedBytes: 2_048,
        quota: { ...plan.quota, requiredBytes: 2_048 },
      }),
      ["files", 1, "path"],
      "Expected InstallPlan immutable file paths to be unique",
    );
    expectSchemaIssue(
      InstallPlanSchema.safeParse({
        ...plan,
        files: [IMMUTABLE_FILE, { ...secondImmutableFile, resourcePath: IMMUTABLE_FILE.resourcePath }],
        expectedBytes: 2_048,
        quota: { ...plan.quota, requiredBytes: 2_048 },
      }),
      ["files", 1, "resourcePath"],
      "Expected InstallPlan immutable file resource paths to be unique",
    );
    expect(
      InstallPlanSchema.safeParse({
        ...plan,
        packages: [PACKAGE_REF, secondPackage],
        dependencyOrder: [packageKey, secondPackageKey],
      }).success,
    ).toBe(true);
    for (const [caseName, mutatedPlan] of installPlanMutations) {
      expect(InstallPlanSchema.safeParse(mutatedPlan).success, caseName).toBe(false);
    }
    expect(InstallTransactionSchema.safeParse(transaction).success).toBe(true);
    expect(InstallRecordSchema.safeParse(record).success).toBe(true);
    const excessiveReferenceCounts = Object.fromEntries(
      Array.from({ length: PACKAGE_LIMITS.maxFiles + 1 }, (_, index) => [
        index.toString(16).padStart(64, "0"),
        1,
      ]),
    );
    expect(
      InstallRecordSchema.safeParse({ ...record, referenceCounts: excessiveReferenceCounts }).success,
    ).toBe(false);
    expect(PackageLockSchema.safeParse({ ...lock, npmCommand: "install" }).success).toBe(false);
    expect(InstallTransactionSchema.safeParse({ ...transaction, state: "rollback" }).success).toBe(false);
  });

  it("validates an atomic versioned SaveExport and rejects privacy egress", async () => {
    const payload = {
      schemaVersion: "1.0.0" as const,
      gameVersion: "1.0.0",
      createdAt: NOW,
      localProfileId: "local:profile:1",
      campaignProgress: [{ campaignId: "starter", unlockedLevelIds: ["winter-garden"] }],
      levelProgress: [
        {
          levelId: "winter-garden",
          levelVersion: "1.0.0",
          seed: "seed:1",
          score: 1_200,
          objectives: { "collect-ten": true },
        },
      ],
      settings: { audioVolume: 0.8, reducedMotion: false, inputPreset: "default" },
      activePackageLockIds: ["lock:golden:1"],
      migrationVersion: "1",
      checksumAlgorithm: "sha256" as const,
    };
    const save = { ...payload, ...(await computeSaveExportIntegrity(payload)) };

    expect(SaveExportSchema.safeParse(save).success).toBe(true);
    expect(parseSaveExport(save)).toMatchObject({ ok: true, issues: [] });
    await expect(
      verifySaveExportIntegrity({ ...save, payloadBytes: save.payloadBytes + 1 }),
    ).resolves.toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_SAVE_EXPORT_SIZE" }],
    });
    await expect(
      verifySaveExportIntegrity({ ...save, checksum: "e".repeat(64) }),
    ).resolves.toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_SAVE_EXPORT_INTEGRITY" }],
    });
    const excessiveObjectives = Object.fromEntries(
      Array.from({ length: 1_025 }, (_, index) => [`objective:${index}`, true]),
    );
    expect(
      SaveExportSchema.safeParse({
        ...save,
        campaignProgress: Array.from({ length: 1_025 }, () => save.campaignProgress[0]),
      }).success,
    ).toBe(false);
    expect(
      SaveExportSchema.safeParse({
        ...save,
        levelProgress: [{ ...save.levelProgress[0], objectives: excessiveObjectives }],
      }).success,
    ).toBe(false);
    expect(SaveExportSchema.safeParse({ ...save, createdAt: "2026-02-30T00:00:00.000Z" }).success).toBe(
      false,
    );
    const privatePayload = { ...save, accountId: "cloud-account", credentials: { token: "secret" } };
    const result = parseSaveExport(privatePayload);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.ruleId).toBe("E_PRIVACY_EGRESS");
  });
});
