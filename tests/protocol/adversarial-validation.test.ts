import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { validationFailure, validationIssue } from "../../packages/protocol/src/errors.js";
import { CONTENT_BUDGETS, PACKAGE_LIMITS } from "../../packages/protocol/src/version.js";
import { parseManifest } from "../../packages/protocol/src/schema/manifests.js";
import {
  formatValidationResult,
  validatePackageInspection,
  type PackageInspection,
} from "../../packages/protocol/src/validation/package-inspection.js";

interface AdversarialFixture {
  id: string;
  expectedRuleId: string;
  mutation: {
    type: string;
    value?: unknown;
    values?: string[];
    key?: string;
  };
}

const ROOT = process.cwd();
const FIXTURE_DIR = join(ROOT, "tests", "fixtures", "protocol", "adversarial");
const GOLDEN_DIR = join(ROOT, "tests", "fixtures", "protocol", "golden");

type GoldenKind = "level" | "character" | "music" | "object-pack";
type JsonPrimitive = string | number | boolean | null;

function canonicalConfigSha256(config: Record<string, JsonPrimitive>): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.keys(config).sort().map((key) => [key, config[key]])),
  );
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function refreshProvenanceConfigHashes(assets: Array<Record<string, unknown>>): void {
  for (const asset of assets) {
    const provenance = asset.provenance as Record<string, unknown>;
    const transformation = provenance.transformation as Record<string, unknown>;
    const config = transformation.config as Record<string, JsonPrimitive>;
    transformation.configSha256 = canonicalConfigSha256(config);
  }
}

function fileDecodedMetrics(asset: Record<string, unknown>): Pick<
  PackageInspection["files"][number],
  "decodedGeometry" | "decodedTexture" | "decodedAudio"
> {
  const mime = asset.mime as string;
  return {
    decodedGeometry:
      mime === "model/gltf-binary"
        ? { triangles: 1_000, maxTextureDimension: 1_024 }
        : undefined,
    decodedTexture:
      mime.startsWith("image/")
        ? { width: 1_024, height: 1_024 }
        : undefined,
    decodedAudio:
      mime.startsWith("audio/")
        ? { durationSeconds: 90, channels: CONTENT_BUDGETS.music.maxChannels, sampleRate: 48_000 }
        : undefined,
  };
}

async function createInspection(kind: GoldenKind = "level"): Promise<PackageInspection> {
  const manifest = JSON.parse(await readFile(join(GOLDEN_DIR, `${kind}.json`), "utf8")) as Record<string, unknown>;
  const assets = manifest.assets as Array<Record<string, unknown>>;
  refreshProvenanceConfigHashes(assets);
  const files = assets.map((asset) => ({
    path: asset.path as string,
    kind: "file" as const,
    declaredMime: asset.mime as string,
    sniffedMime: asset.mime as string,
    bytes: asset.bytes as number,
    actualSha256: asset.sha256 as string,
    compressedBytes: asset.bytes as number,
    depth: (asset.path as string).split("/").length,
    codec: asset.mime === "audio/ogg" ? "audio/ogg" : undefined,
    glbReferences: asset.mime === "model/gltf-binary" ? [] : undefined,
    executable: false,
    ...fileDecodedMetrics(asset),
  }));

  return {
    manifest,
    archive: {
      compressedBytes: files.reduce((total, file) => total + file.compressedBytes, 0),
      uncompressedBytes: files.reduce((total, file) => total + file.bytes, 0),
      fileCount: files.length,
      maxDepth: Math.max(...files.map((file) => file.depth)),
    },
    files,
  };
}

function addDistinctMusicTrack(inspection: PackageInspection): void {
  const manifest = inspection.manifest as Record<string, unknown>;
  const assets = manifest.assets as Array<Record<string, unknown>>;
  const [entry] = manifest.entries as Array<{ tracks: Array<Record<string, unknown>> }>;
  const sourceTrack = entry?.tracks[0];
  const sourceAsset = assets.find((asset) => asset.assetId === sourceTrack?.assetId);
  const sourceFile = inspection.files.find((file) => file.path === sourceAsset?.path);
  if (entry === undefined || sourceTrack === undefined || sourceAsset === undefined || sourceFile === undefined) {
    throw new Error("Golden music inspection requires one track asset");
  }

  const secondAsset = structuredClone(sourceAsset);
  secondAsset.assetId = "track-two";
  secondAsset.path = "assets/winter-loop-two.ogg";
  assets.push(secondAsset);
  entry.tracks.push({
    ...structuredClone(sourceTrack),
    trackId: "winter-loop-two",
    assetId: secondAsset.assetId,
  });

  const secondFile = structuredClone(sourceFile);
  secondFile.path = secondAsset.path as string;
  inspection.files.push(secondFile);
  inspection.archive.compressedBytes += secondFile.compressedBytes;
  inspection.archive.uncompressedBytes += secondFile.bytes;
  inspection.archive.fileCount += 1;
  inspection.archive.maxDepth = Math.max(inspection.archive.maxDepth, secondFile.depth);

  const totals = manifest.totals as Record<string, number>;
  const { bytes, uncompressedBytes, fileCount } = totals;
  if (bytes === undefined || uncompressedBytes === undefined || fileCount === undefined) {
    throw new Error("Golden music manifest requires archive totals");
  }
  totals.bytes = bytes + secondFile.compressedBytes;
  totals.uncompressedBytes = uncompressedBytes + secondFile.bytes;
  totals.fileCount = fileCount + 1;
}

function applyMutation(inspection: PackageInspection, fixture: AdversarialFixture): void {
  const firstFile = inspection.files[0];
  const manifest = inspection.manifest as Record<string, unknown>;
  const firstAsset = (manifest.assets as Array<Record<string, unknown>>)[0];
  if (firstFile === undefined || firstAsset === undefined) throw new Error("Golden inspection requires at least one file");

  switch (fixture.mutation.type) {
    case "file-path":
      firstFile.path = fixture.mutation.value as string;
      break;
    case "collision-paths":
      for (const [index, path] of (fixture.mutation.values ?? []).entries()) {
        const file = inspection.files[index];
        if (file === undefined) throw new Error("Golden inspection requires one file per collision path");
        file.path = path;
      }
      break;
    case "file-kind":
      firstFile.kind = fixture.mutation.value as "symlink";
      break;
    case "add-file":
      firstFile.path = fixture.mutation.value as string;
      break;
    case "executable":
      firstFile.executable = fixture.mutation.value as boolean;
      break;
    case "sniffed-mime":
      firstFile.sniffedMime = fixture.mutation.value as string;
      break;
    case "manifest-hash":
      firstAsset.sha256 = fixture.mutation.value;
      break;
    case "actual-hash":
      firstFile.actualSha256 = fixture.mutation.value as string;
      break;
    case "manifest-version":
      manifest.version = fixture.mutation.value;
      break;
    case "manifest-license":
      manifest.license = fixture.mutation.value;
      break;
    case "provenance-state":
      (firstAsset.provenance as Record<string, unknown>).evidenceStatus = fixture.mutation.value;
      break;
    case "codec":
      firstFile.codec = fixture.mutation.value as string;
      break;
    case "glb-references": {
      const glb = inspection.files.find((file) => file.declaredMime === "model/gltf-binary");
      if (glb === undefined) throw new Error("Golden inspection requires a GLB file");
      glb.glbReferences = fixture.mutation.value as string[];
      break;
    }
    case "file-bytes":
      firstFile.bytes = fixture.mutation.value as number;
      break;
    case "archive-uncompressed-bytes":
      inspection.archive.uncompressedBytes = fixture.mutation.value as number;
      break;
    case "archive-depth":
      inspection.archive.maxDepth = fixture.mutation.value as number;
      break;
    case "archive-compression-ratio":
      inspection.archive.uncompressedBytes = fixture.mutation.value as number;
      inspection.archive.compressedBytes = 1;
      break;
    case "manifest-total-bytes":
      (manifest.totals as Record<string, unknown>).bytes = fixture.mutation.value;
      break;
    case "duplicate-asset": {
      const assets = manifest.assets as Array<Record<string, unknown>>;
      assets.push(structuredClone(firstAsset));
      inspection.files.push(structuredClone(firstFile));
      inspection.archive.fileCount = inspection.files.length;
      inspection.archive.uncompressedBytes += firstFile.bytes;
      inspection.archive.compressedBytes += firstFile.compressedBytes;
      const totals = manifest.totals as Record<string, unknown>;
      totals.fileCount = assets.length;
      totals.bytes = assets.reduce((sum, asset) => sum + (asset.bytes as number), 0);
      totals.uncompressedBytes = assets.reduce((sum, asset) => sum + (asset.bytes as number), 0);
      break;
    }
    case "manifest-unknown-field":
      manifest[fixture.mutation.key ?? "unknown"] = fixture.mutation.value;
      break;
    default:
      throw new Error(`Unhandled fixture mutation: ${fixture.mutation.type}`);
  }
}

describe("adversarial package inspection", () => {
  it.each([
    ["null root", null],
    ["missing root fields", {}],
    ["missing archive", { manifest: {}, files: [] }],
    ["missing files", { manifest: {}, archive: {} }],
    ["null archive", { manifest: {}, archive: null, files: [] }],
  ])("fails closed for %s extractor output", (_name, input) => {
    expect(() => validatePackageInspection(input as PackageInspection)).not.toThrow();
    expect(validatePackageInspection(input as PackageInspection)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_SCHEMA_STRICT" }],
    });
  });

  it.each([
    [
      "inspection root",
      "/",
      (inspection: PackageInspection) => {
        (inspection as unknown as Record<string, unknown>).unexpected = true;
      },
    ],
    [
      "archive metadata",
      "/archive",
      (inspection: PackageInspection) => {
        (inspection.archive as unknown as Record<string, unknown>).unexpected = true;
      },
    ],
    [
      "file record",
      "/files/0",
      (inspection: PackageInspection) => {
        const firstFile = inspection.files[0];
        if (firstFile === undefined) throw new Error("Golden inspection requires a file");
        (firstFile as unknown as Record<string, unknown>).unexpected = true;
      },
    ],
  ] as const)("rejects unknown fields at the %s extractor boundary", async (_name, path, mutate) => {
    const inspection = await createInspection();
    mutate(inspection);

    expect(() => validatePackageInspection(inspection)).not.toThrow();
    expect(validatePackageInspection(inspection)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_SCHEMA_STRICT", path }],
    });
  });

  it.each([
    [
      "manifest at the inspection root",
      "/",
      (inspection: PackageInspection) => {
        delete (inspection as unknown as Record<string, unknown>).manifest;
      },
    ],
    [
      "maxDepth in archive metadata",
      "/archive",
      (inspection: PackageInspection) => {
        delete (inspection.archive as unknown as Record<string, unknown>).maxDepth;
      },
    ],
    [
      "codec in a file record",
      "/files/0",
      (inspection: PackageInspection) => {
        const firstFile = inspection.files[0];
        if (firstFile === undefined) throw new Error("Golden inspection requires a file");
        delete (firstFile as unknown as Record<string, unknown>).codec;
      },
    ],
    [
      "glbReferences in a file record",
      "/files/0",
      (inspection: PackageInspection) => {
        const firstFile = inspection.files[0];
        if (firstFile === undefined) throw new Error("Golden inspection requires a file");
        delete (firstFile as unknown as Record<string, unknown>).glbReferences;
      },
    ],
  ] as const)("rejects a missing %s extractor field", async (_name, path, mutate) => {
    const inspection = await createInspection();
    mutate(inspection);

    expect(validatePackageInspection(inspection)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_SCHEMA_STRICT", path }],
    });
  });

  it("fails closed for hostile manifest and extractor accessors", async () => {
    const hostileManifest: Record<string, unknown> = {};
    Object.defineProperty(hostileManifest, "kind", {
      enumerable: true,
      get() {
        throw new Error("hostile manifest getter");
      },
    });
    const hostileInspection = new Proxy({}, {
      get() {
        throw new Error("hostile extractor getter");
      },
    });

    expect(() => parseManifest(hostileManifest)).not.toThrow();
    expect(parseManifest(hostileManifest)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_SCHEMA_STRICT" }],
    });
    expect(() => validatePackageInspection(hostileInspection)).not.toThrow();
    expect(validatePackageInspection(hostileInspection)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_SCHEMA_STRICT" }],
    });

    const accessorManifest = JSON.parse(
      await readFile(join(GOLDEN_DIR, "level.json"), "utf8"),
    ) as Record<string, unknown>;
    const manifestKind = accessorManifest.kind;
    let manifestAccessorReads = 0;
    Object.defineProperty(accessorManifest, "kind", {
      enumerable: true,
      get() {
        manifestAccessorReads += 1;
        return manifestKind;
      },
    });
    const accessorInspection = await createInspection();
    const inspectionArchive = accessorInspection.archive;
    let inspectionAccessorReads = 0;
    Object.defineProperty(accessorInspection, "archive", {
      enumerable: true,
      get() {
        inspectionAccessorReads += 1;
        return inspectionArchive;
      },
    });

    expect(parseManifest(accessorManifest)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_SCHEMA_STRICT" }],
    });
    expect(manifestAccessorReads).toBe(0);
    expect(validatePackageInspection(accessorInspection)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_SCHEMA_STRICT" }],
    });
    expect(inspectionAccessorReads).toBe(0);

    const nestedManifest = JSON.parse(
      await readFile(join(GOLDEN_DIR, "level.json"), "utf8"),
    ) as Record<string, unknown>;
    const nestedManifestAsset = (nestedManifest.assets as Array<Record<string, unknown>>)[0];
    if (nestedManifestAsset === undefined) throw new Error("Golden manifest requires an asset");
    const manifestAssetPath = nestedManifestAsset.path;
    let nestedManifestAccessorReads = 0;
    Object.defineProperty(nestedManifestAsset, "path", {
      enumerable: true,
      get() {
        nestedManifestAccessorReads += 1;
        return manifestAssetPath;
      },
    });
    const nestedInspection = await createInspection();
    const nestedInspectionFile = nestedInspection.files[0];
    if (nestedInspectionFile === undefined) throw new Error("Golden inspection requires a file");
    const inspectionFilePath = nestedInspectionFile.path;
    let nestedInspectionAccessorReads = 0;
    Object.defineProperty(nestedInspectionFile, "path", {
      enumerable: true,
      get() {
        nestedInspectionAccessorReads += 1;
        return inspectionFilePath;
      },
    });

    expect(parseManifest(nestedManifest)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_SCHEMA_STRICT" }],
    });
    expect(nestedManifestAccessorReads).toBe(0);
    expect(validatePackageInspection(nestedInspection)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_SCHEMA_STRICT" }],
    });
    expect(nestedInspectionAccessorReads).toBe(0);
  });
  it.each([
    ["unknown entry kind", "kind", "directory"],
    ["non-boolean executable flag", "executable", 0],
  ])("fails closed for %s", async (_name, field, value) => {
    const inspection = await createInspection();
    const firstFile = inspection.files[0];
    if (firstFile === undefined) throw new Error("Golden inspection requires a file");
    (firstFile as unknown as Record<string, unknown>)[field] = value;

    expect(validatePackageInspection(inspection)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_SCHEMA_STRICT", path: `/files/0/${field}` }],
    });
  });
  it("accepts the complete declared golden package inspection", async () => {
    expect(validatePackageInspection(await createInspection())).toMatchObject({ ok: true, issues: [] });
  });
  it("fails before file traversal when archive aggregates are forged or inconsistent", async () => {
    const cases: Array<{
      name: string;
      path: string;
      mutate: (inspection: PackageInspection) => void;
    }> = [
      {
        name: "underreported uncompressed bytes",
        path: "/archive/uncompressedBytes",
        mutate: (inspection) => {
          inspection.archive.uncompressedBytes -= 1;
        },
      },
      {
        name: "inflated compressed bytes",
        path: "/archive/compressedBytes",
        mutate: (inspection) => {
          inspection.archive.compressedBytes += 1;
        },
      },
      {
        name: "underreported maximum depth",
        path: "/archive/maxDepth",
        mutate: (inspection) => {
          inspection.archive.maxDepth -= 1;
        },
      },
      {
        name: "mismatched file count",
        path: "/archive/fileCount",
        mutate: (inspection) => {
          inspection.archive.fileCount -= 1;
        },
      },
      {
        name: "non-finite aggregate",
        path: "/archive/uncompressedBytes",
        mutate: (inspection) => {
          inspection.archive.uncompressedBytes = Number.NaN;
        },
      },
      {
        name: "actual file inventory over the hard limit",
        path: "/archive/fileCount",
        mutate: (inspection) => {
          const firstFile = inspection.files[0];
          if (firstFile === undefined) throw new Error("Golden inspection requires a file");
          for (let index = inspection.files.length; index <= PACKAGE_LIMITS.maxFiles; index += 1) {
            inspection.files.push({ ...firstFile, path: `assets/extra-${index}.json` });
          }
          (inspection as unknown as Record<string, unknown>).unexpected = true;
          (inspection.archive as unknown as Record<string, unknown>).unexpected = true;
          (firstFile as unknown as Record<string, unknown>).unexpected = true;
          Object.defineProperty(firstFile, "path", {
            enumerable: true,
            get() {
              throw new Error("over-limit files must fail before entry traversal");
            },
          });
        },
      },
    ];

    for (const testCase of cases) {
      const result = validatePackageInspection(
        await createInspection().then((inspection) => {
          testCase.mutate(inspection);
          return inspection;
        }),
      );
      expect(result.ok, testCase.name).toBe(false);
      expect(result.issues[0], testCase.name).toMatchObject({
        ruleId: "E_FILE_BUDGET",
        path: testCase.path,
      });
    }
  });
  it("allows bounded archive container overhead while binding measured download bytes", async () => {
    const inspection = await createInspection();
    const firstFile = inspection.files[0];
    if (firstFile === undefined || firstFile.compressedBytes < 1) throw new Error("Golden inspection requires bytes");
    firstFile.compressedBytes -= 1;

    expect(validatePackageInspection(inspection)).toMatchObject({ ok: true, issues: [] });
  });
  it("rejects a nonempty entry with zero compressed bytes before parsing", async () => {
    const inspection = await createInspection();
    const firstFile = inspection.files[0];
    if (firstFile === undefined || firstFile.bytes === 0) {
      throw new Error("Golden inspection requires a nonempty file");
    }
    firstFile.compressedBytes = 0;

    const result = validatePackageInspection(inspection);
    expect(result).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_FILE_BUDGET", path: "/files/0/compressedBytes" }],
    });
  });
  it("rejects a padded archive whose offending entry exceeds the ratio ceiling", async () => {
    const inspection = await createInspection();
    const firstFile = inspection.files[0];
    if (firstFile === undefined || firstFile.bytes <= PACKAGE_LIMITS.maxCompressionRatio) {
      throw new Error("Golden inspection requires a compressible nonempty file");
    }
    firstFile.compressedBytes = Math.max(
      1,
      Math.floor(firstFile.bytes / (PACKAGE_LIMITS.maxCompressionRatio + 1)),
    );

    const entryRatio = firstFile.bytes / firstFile.compressedBytes;
    const aggregateRatio =
      inspection.archive.uncompressedBytes / inspection.archive.compressedBytes;
    expect(firstFile.compressedBytes).toBeGreaterThan(0);
    expect(entryRatio).toBeGreaterThan(PACKAGE_LIMITS.maxCompressionRatio);
    expect(aggregateRatio).toBeLessThanOrEqual(PACKAGE_LIMITS.maxCompressionRatio);

    const result = validatePackageInspection(inspection);
    expect(result).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_FILE_BUDGET", path: "/files/0/compressedBytes" }],
    });
  });
  it("requires successful parser evidence for every audio and GLB asset", async () => {
    const missingGlbEvidence = await createInspection();
    const glb = missingGlbEvidence.files.find((file) => file.declaredMime === "model/gltf-binary");
    if (glb === undefined) throw new Error("Golden level requires a GLB");
    glb.glbReferences = undefined;
    const glbResult = validatePackageInspection(missingGlbEvidence);
    expect(glbResult.ok).toBe(false);
    expect(glbResult.issues[0]).toMatchObject({
      ruleId: "E_GLB_REFERENCE",
      path: expect.stringMatching(/\/glbReferences$/),
    });

    const missingCodecEvidence = await createInspection("music");
    const audio = missingCodecEvidence.files.find((file) => file.declaredMime.startsWith("audio/"));
    if (audio === undefined) throw new Error("Golden music requires an audio file");
    audio.codec = undefined;
    const codecResult = validatePackageInspection(missingCodecEvidence);
    expect(codecResult.ok).toBe(false);
    expect(codecResult.issues[0]).toMatchObject({
      ruleId: "E_CODEC_UNSUPPORTED",
      path: expect.stringMatching(/\/codec$/),
    });
  });

  it("requires manifest asset MIME to match extractor declaration and sniffed content", async () => {
    const inspection = await createInspection();
    const manifest = inspection.manifest as Record<string, unknown>;
    const [asset] = manifest.assets as Array<Record<string, unknown>>;
    if (asset === undefined) throw new Error("Golden level requires an asset");
    asset.mime = "image/webp";

    expect(validatePackageInspection(inspection)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_MIME_MISMATCH", path: "/files/0/declaredMime", assetId: "icon" }],
    });
  });

  it.each([
    ["model", "level", "arena", "assets/arena.png", "image/png"],
    ["image", "level", "icon", "assets/icon.glb", "model/gltf-binary"],
    ["audio", "music", "track", "assets/winter-loop.png", "image/png"],
  ] as const)(
    "binds %s semantic roles to their allowed MIME family",
    async (_family, kind, assetId, replacementPath, replacementMime) => {
      const inspection = await createInspection(kind);
      const manifest = inspection.manifest as Record<string, unknown>;
      const assets = manifest.assets as Array<Record<string, unknown>>;
      const assetIndex = assets.findIndex((candidate) => candidate.assetId === assetId);
      const asset = assets[assetIndex];
      const originalPath = asset?.path;
      const file = inspection.files.find((candidate) => candidate.path === originalPath);
      if (asset === undefined || typeof originalPath !== "string" || file === undefined) {
        throw new Error(`Golden ${kind} requires asset ${assetId}`);
      }

      asset.path = replacementPath;
      asset.mime = replacementMime;
      file.path = replacementPath;
      file.declaredMime = replacementMime;
      file.sniffedMime = replacementMime;
      file.codec = replacementMime.startsWith("audio/") ? replacementMime : undefined;
      file.glbReferences = replacementMime === "model/gltf-binary" ? [] : undefined;
      Object.assign(file, fileDecodedMetrics(asset));

      const metadata = manifest.metadata as { icon: string; screenshots: string[] };
      if (metadata.icon === originalPath) metadata.icon = replacementPath;
      metadata.screenshots = metadata.screenshots.map((path) =>
        path === originalPath ? replacementPath : path
      );

      expect(validatePackageInspection(inspection)).toMatchObject({
        ok: false,
        issues: [{
          ruleId: "E_MIME_MISMATCH",
          path: `/assets/${assetIndex}/mime`,
          assetId,
        }],
      });
    },
  );

  it("rejects one asset referenced by semantic roles from incompatible MIME families", async () => {
    const inspection = await createInspection("character");
    const manifest = inspection.manifest as Record<string, unknown>;
    const metadata = manifest.metadata as Record<string, unknown>;
    metadata.icon = "assets/character.glb";

    expect(validatePackageInspection(inspection)).toMatchObject({
      ok: false,
      issues: [{
        ruleId: "E_MIME_MISMATCH",
        path: "/assets/1/mime",
        assetId: "model",
        observed: {
          requiredMimeFamilies: ["image", "model"],
          semanticRoles: ["icon", "character-model"],
        },
      }],
    });
  });

  it("rejects publisher role labels that conflict with the strictest semantic reference", async () => {
    const conflicted = await createInspection("object-pack");
    const conflictedManifest = conflicted.manifest as Record<string, unknown>;
    const [entry] = conflictedManifest.entries as Array<{ objects: Array<Record<string, unknown>> }>;
    const object = entry?.objects[0];
    if (object === undefined) throw new Error("Golden object pack requires an object");
    object.budgets = { ...object.budgets as Record<string, unknown>, maxBytes: CONTENT_BUDGETS.collectible.maxBytes };
    object.colliderAssetId = object.renderAssetId;

    const conflictedResult = validatePackageInspection(conflicted);
    expect(conflictedResult).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_FILE_BUDGET", path: "/assets/1/role", assetId: "render" }],
    });

    const strictest = await createInspection("object-pack");
    const strictestManifest = strictest.manifest as Record<string, unknown>;
    const [strictestEntry] = strictestManifest.entries as Array<{ objects: Array<Record<string, unknown>> }>;
    const strictestObject = strictestEntry?.objects[0];
    if (strictestObject === undefined) throw new Error("Golden object pack requires an object");
    strictestObject.budgets = {
      ...strictestObject.budgets as Record<string, unknown>,
      maxBytes: CONTENT_BUDGETS.collectible.maxBytes,
    };
    strictestObject.colliderAssetId = strictestObject.renderAssetId;
    const renderAsset = (strictestManifest.assets as Array<Record<string, unknown>>)
      .find((asset) => asset.assetId === "render");
    if (renderAsset === undefined) throw new Error("Golden object pack requires a render asset");
    renderAsset.role = "collider";

    expect(validatePackageInspection(strictest)).toMatchObject({ ok: true, issues: [] });
  });

  it("requires trusted decoded geometry, texture, and audio measurements", async () => {
    const missingGeometry = await createInspection();
    const glb = missingGeometry.files.find((file) => file.declaredMime === "model/gltf-binary");
    if (glb === undefined) throw new Error("Golden level requires a GLB");
    glb.decodedGeometry = undefined;
    expect(validatePackageInspection(missingGeometry)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_FILE_BUDGET", path: expect.stringMatching(/\/decodedGeometry$/) }],
    });

    const missingTexture = await createInspection();
    const texture = missingTexture.files.find((file) => file.declaredMime.startsWith("image/"));
    if (texture === undefined) throw new Error("Golden level requires an image");
    texture.decodedTexture = undefined;
    expect(validatePackageInspection(missingTexture)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_FILE_BUDGET", path: expect.stringMatching(/\/decodedTexture$/) }],
    });

    const missingAudio = await createInspection("music");
    const audio = missingAudio.files.find((file) => file.declaredMime.startsWith("audio/"));
    if (audio === undefined) throw new Error("Golden music requires audio");
    audio.decodedAudio = undefined;
    expect(validatePackageInspection(missingAudio)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_FILE_BUDGET", path: expect.stringMatching(/\/decodedAudio$/) }],
    });
  });

  it("enforces decoded measurements against semantic declarations and frozen budgets", async () => {
    const oversizedGeometry = await createInspection("object-pack");
    const manifest = oversizedGeometry.manifest as Record<string, unknown>;
    const [entry] = manifest.entries as Array<{ objects: Array<Record<string, unknown>> }>;
    const object = entry?.objects[0];
    if (object === undefined) throw new Error("Golden object pack requires an object");
    object.budgets = { ...object.budgets as Record<string, unknown>, maxBytes: CONTENT_BUDGETS.collectible.maxBytes };
    const renderFile = oversizedGeometry.files.find((file) => file.path === "assets/gift.glb");
    if (renderFile?.decodedGeometry === undefined) throw new Error("Golden object pack requires decoded geometry");
    const maxTriangles = (object.budgets as Record<string, unknown>).maxTriangles;
    if (typeof maxTriangles !== "number") throw new Error("Golden object pack requires a triangle budget");
    renderFile.decodedGeometry.triangles = maxTriangles + 1;
    expect(validatePackageInspection(oversizedGeometry)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_FILE_BUDGET", path: expect.stringMatching(/\/decodedGeometry$/) }],
    });

    const oversizedAudio = await createInspection("music");
    const audioFile = oversizedAudio.files.find((file) => file.declaredMime.startsWith("audio/"));
    if (audioFile?.decodedAudio === undefined) throw new Error("Golden music requires decoded audio");
    audioFile.decodedAudio.durationSeconds = CONTENT_BUDGETS.music.maxTrackSeconds + 1;
    expect(validatePackageInspection(oversizedAudio)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_FILE_BUDGET", path: expect.stringMatching(/\/decodedAudio$/) }],
    });
  });

  it("always enforces the frozen character triangle ceiling", async () => {
    const inspection = await createInspection("character");
    const model = inspection.files.find((file) => file.path === "assets/character.glb");
    if (model?.decodedGeometry === undefined) throw new Error("Golden character requires decoded geometry");
    model.decodedGeometry.triangles = CONTENT_BUDGETS.hero.maxTriangles + 1;

    expect(validatePackageInspection(inspection)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_FILE_BUDGET", path: expect.stringMatching(/\/decodedGeometry$/) }],
    });
  });

  it("rejects decoded audio with a zero duration", async () => {
    const inspection = await createInspection("music");
    const audio = inspection.files.find((file) => file.decodedAudio !== undefined);
    if (audio?.decodedAudio === undefined) throw new Error("Golden music requires decoded audio");
    audio.decodedAudio.durationSeconds = 0;

    expect(validatePackageInspection(inspection)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_FILE_BUDGET", path: expect.stringMatching(/\/decodedAudio$/) }],
    });
  });

  it.each([
    ["channel count", "channels", 1],
    ["sample rate", "sampleRate", 44_100],
  ] as const)(
    "requires decoded audio %s to equal its declared track fact",
    async (_name, field, decodedValue) => {
      const inspection = await createInspection("music");
      const audio = inspection.files.find((file) => file.decodedAudio !== undefined);
      if (audio?.decodedAudio === undefined) throw new Error("Golden music requires decoded audio");
      audio.decodedAudio[field] = decodedValue;

      expect(validatePackageInspection(inspection)).toMatchObject({
        ok: false,
        issues: [{ ruleId: "E_FILE_BUDGET", path: expect.stringMatching(/\/decodedAudio$/) }],
      });
    },
  );

  it("rejects conflicting declared audio facts for one shared track asset", async () => {
    const inspection = await createInspection("music");
    const manifest = inspection.manifest as Record<string, unknown>;
    const [entry] = manifest.entries as Array<{ tracks: Array<Record<string, unknown>> }>;
    const sourceTrack = entry?.tracks[0];
    const audio = inspection.files.find((file) => file.decodedAudio !== undefined);
    if (entry === undefined || sourceTrack === undefined || audio?.decodedAudio === undefined) {
      throw new Error("Golden music requires a track and decoded audio");
    }
    entry.tracks.push({
      ...structuredClone(sourceTrack),
      trackId: "winter-loop-downsampled",
      sampleRate: 44_100,
    });
    audio.decodedAudio.sampleRate = 44_100;

    expect(validatePackageInspection(inspection)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_FILE_BUDGET", path: expect.stringMatching(/\/decodedAudio$/) }],
    });
  });

  it("enforces music entry maxTracks and maxBytes over unique referenced assets", async () => {
    const overTracks = await createInspection("music");
    addDistinctMusicTrack(overTracks);
    const [trackEntry] = (overTracks.manifest as Record<string, unknown>).entries as Array<Record<string, unknown>>;
    if (trackEntry === undefined) throw new Error("Golden music requires an entry");
    trackEntry.maxTracks = 1;
    expect(validatePackageInspection(overTracks)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_FILE_BUDGET", path: "/entries/0/maxTracks" }],
    });

    const overBytes = await createInspection("music");
    addDistinctMusicTrack(overBytes);
    const overBytesManifest = overBytes.manifest as Record<string, unknown>;
    const [byteEntry] = overBytesManifest.entries as Array<Record<string, unknown>>;
    const audioAsset = (overBytesManifest.assets as Array<Record<string, unknown>>)
      .find((asset) => asset.assetId === "track");
    if (byteEntry === undefined || typeof audioAsset?.bytes !== "number") {
      throw new Error("Golden music requires an entry and audio asset");
    }
    byteEntry.maxTracks = 2;
    byteEntry.maxBytes = audioAsset.bytes;
    expect(validatePackageInspection(overBytes)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_FILE_BUDGET", path: "/entries/0/maxBytes" }],
    });

    const duplicateReference = await createInspection("music");
    const duplicateManifest = duplicateReference.manifest as Record<string, unknown>;
    const [duplicateEntry] = duplicateManifest.entries as Array<{
      tracks: Array<Record<string, unknown>>;
      maxBytes: number;
      maxTracks: number;
    }>;
    const sourceTrack = duplicateEntry?.tracks[0];
    const sourceAsset = (duplicateManifest.assets as Array<Record<string, unknown>>)
      .find((asset) => asset.assetId === sourceTrack?.assetId);
    if (duplicateEntry === undefined || sourceTrack === undefined || typeof sourceAsset?.bytes !== "number") {
      throw new Error("Golden music requires one referenced track");
    }
    duplicateEntry.tracks.push({
      ...structuredClone(sourceTrack),
      trackId: "winter-loop-alternate",
    });
    duplicateEntry.maxTracks = 1;
    duplicateEntry.maxBytes = sourceAsset.bytes;
    expect(validatePackageInspection(duplicateReference)).toMatchObject({ ok: true, issues: [] });
  });

  it("canonicalizes provenance transformation configs before comparing configSha256", async () => {
    const valid = await createInspection();
    const validManifest = valid.manifest as Record<string, unknown>;
    const [validAsset] = validManifest.assets as Array<Record<string, unknown>>;
    if (validAsset === undefined) throw new Error("Golden level requires an asset");
    const validTransformation = (validAsset.provenance as Record<string, unknown>).transformation as Record<string, unknown>;
    const validConfig = validTransformation.config as Record<string, JsonPrimitive>;
    validTransformation.config = {
      format: validConfig.format,
      deterministic: validConfig.deterministic,
    };
    validTransformation.configSha256 = canonicalConfigSha256(validTransformation.config as Record<string, JsonPrimitive>);
    expect(validatePackageInspection(valid)).toMatchObject({ ok: true, issues: [] });

    const tampered = await createInspection();
    const tamperedManifest = tampered.manifest as Record<string, unknown>;
    const [tamperedAsset] = tamperedManifest.assets as Array<Record<string, unknown>>;
    if (tamperedAsset === undefined) throw new Error("Golden level requires an asset");
    const tamperedTransformation = (tamperedAsset.provenance as Record<string, unknown>).transformation as Record<string, unknown>;
    const tamperedConfig = tamperedTransformation.config as Record<string, JsonPrimitive>;
    tamperedConfig.format = "runtime-ready-but-unsigned";

    expect(validatePackageInspection(tampered)).toMatchObject({
      ok: false,
      issues: [{
        ruleId: "E_HASH_MISMATCH",
        path: "/assets/0/provenance/transformation/configSha256",
        assetId: "icon",
      }],
    });
  });

  it("matches an independently frozen code-unit canonical config SHA-256 vector", async () => {
    const inspection = await createInspection();
    const manifest = inspection.manifest as Record<string, unknown>;
    const [asset] = manifest.assets as Array<Record<string, unknown>>;
    if (asset === undefined) throw new Error("Golden level requires an asset");
    const transformation = (asset.provenance as Record<string, unknown>).transformation as Record<string, unknown>;
    transformation.config = { "2": "two", "10": "ten", "é": "snow", Z: 0, a: true };
    transformation.configSha256 = "05a205ed7cd1d713281f91af5ffb9265cd7d1355acee69711fbed5b8ea37bfac";

    expect(validatePackageInspection(inspection)).toMatchObject({ ok: true, issues: [] });
  });

  it.each([
    ["trailing dot", "assets/portable.glb", "assets/portable.glb."],
    ["trailing space", "assets/portable.glb", "assets/portable.glb "],
    ["device basename", "assets/CON.glb", "assets/con.txt"],
    ["alternate data stream", "assets/portable.glb", "assets/portable.glb:stream"],
  ] as const)(
    "rejects host-portable archive member path collisions before asset validation (%s)",
    async (_name, firstPath, secondPath) => {
      const inspection = await createInspection();
      const firstFile = inspection.files[0];
      const secondFile = inspection.files[1];
      if (firstFile === undefined || secondFile === undefined) {
        throw new Error("Golden inspection requires at least two archive members");
      }
      firstFile.path = firstPath;
      secondFile.path = secondPath;

      expect(validatePackageInspection(inspection)).toMatchObject({
        ok: false,
        issues: [{
          ruleId: "E_PATH_POLICY",
          path: "/files",
          observed: [firstPath, secondPath],
        }],
      });
    },
  );

  it.each([
    ["question mark", "assets/icon?.png"],
    ["C0 unit separator", "assets/icon\u001f.png"],
  ] as const)(
    "rejects Windows-forbidden archive path characters before asset matching (%s)",
    async (_name, unsafePath) => {
      const inspection = await createInspection();
      const firstFile = inspection.files[0];
      if (firstFile === undefined) throw new Error("Golden level requires an archive member");
      firstFile.path = unsafePath;

      expect(validatePackageInspection(inspection)).toMatchObject({
        ok: false,
        issues: [{
          ruleId: "E_PATH_POLICY",
          path: "/files/0/path",
          allowed: expect.stringContaining("Windows-forbidden"),
        }],
      });
    },
  );

  it("accepts dotted POSIX archive names that are not host-portable aliases", async () => {
    const inspection = await createInspection();
    const manifest = inspection.manifest as Record<string, unknown>;
    const assets = manifest.assets as Array<Record<string, unknown>>;
    const iconAsset = assets[0];
    const arenaAsset = assets[1];
    const iconFile = inspection.files[0];
    const arenaFile = inspection.files[1];
    if (iconAsset === undefined || arenaAsset === undefined || iconFile === undefined || arenaFile === undefined) {
      throw new Error("Golden level requires icon and arena assets");
    }
    const iconPath = "assets/icon.v1.png";
    const arenaPath = "assets/arena.v1.glb";
    iconAsset.path = iconPath;
    arenaAsset.path = arenaPath;
    iconFile.path = iconPath;
    arenaFile.path = arenaPath;
    (manifest.metadata as Record<string, unknown>).icon = iconPath;
    (manifest.metadata as Record<string, unknown>).screenshots = [iconPath];

    expect(validatePackageInspection(inspection)).toMatchObject({ ok: true, issues: [] });
  });




  it("rejects exact duplicate archive member paths before asset validation", async () => {
    const inspection = await createInspection();
    const firstFile = inspection.files[0];
    const secondFile = inspection.files[1];
    if (firstFile === undefined || secondFile === undefined) {
      throw new Error("Golden inspection requires at least two archive members");
    }
    secondFile.path = firstFile.path;

    expect(validatePackageInspection(inspection)).toMatchObject({
      ok: false,
      issues: [
        {
          ruleId: "E_PATH_POLICY",
          path: "/files",
          observed: [firstFile.path, firstFile.path],
        },
      ],
    });
  });

  it.each([
    ["lowercase sharp-s", "assets/straße.glb", "assets/STRASSE.glb"],
    ["capital sharp-s", "assets/STRAẞE.glb", "assets/STRASSE.glb"],
    ["ligature", "assets/ﬀ.glb", "assets/ff.glb"],
    ["Greek final sigma", "assets/ς.glb", "assets/σ.glb"],
  ] as const)(
    "rejects full Unicode case-fold archive member path collisions before asset validation (%s)",
    async (_name, firstPath, secondPath) => {
      const inspection = await createInspection();
      const firstFile = inspection.files[0];
      const secondFile = inspection.files[1];
      if (firstFile === undefined || secondFile === undefined) {
        throw new Error("Golden inspection requires at least two archive members");
      }
      firstFile.path = firstPath;
      secondFile.path = secondPath;

      expect(validatePackageInspection(inspection)).toMatchObject({
        ok: false,
        issues: [
          {
            ruleId: "E_PATH_POLICY",
            path: "/files",
            observed: [firstPath, secondPath],
          },
        ],
      });
    },
  );

  it("rejects Win32 upcase collisions that full Unicode case folding keeps distinct", async () => {
    const inspection = await createInspection();
    const firstFile = inspection.files[0];
    const secondFile = inspection.files[1];
    if (firstFile === undefined || secondFile === undefined) {
      throw new Error("Golden inspection requires at least two archive members");
    }
    firstFile.path = "assets/ı.glb";
    secondFile.path = "assets/i.glb";

    expect(validatePackageInspection(inspection)).toMatchObject({
      ok: false,
      issues: [
        {
          ruleId: "E_PATH_POLICY",
          path: "/files",
          observed: [firstFile.path, secondFile.path],
        },
      ],
    });
  });

  it("rejects forged non-maximum per-file depth evidence", async () => {
    const inspection = await createInspection();
    const firstFile = inspection.files[0];
    if (firstFile === undefined || inspection.files[1] === undefined) {
      throw new Error("Golden inspection requires at least two archive members");
    }
    firstFile.depth -= 1;

    expect(validatePackageInspection(inspection)).toMatchObject({
      ok: false,
      issues: [
        {
          ruleId: "E_FILE_BUDGET",
          path: "/files/0/depth",
          observed: { supplied: 1, derived: 2, path: firstFile.path },
          allowed: 2,
        },
      ],
    });
  });

  it("fails closed with the stable rule ID for every named hostile fixture", async () => {
    const fixtureNames = (await readdir(FIXTURE_DIR)).filter((name) => name.endsWith(".json")).sort();
    expect(fixtureNames).toHaveLength(34);

    for (const fixtureName of fixtureNames) {
      const fixture = JSON.parse(await readFile(join(FIXTURE_DIR, fixtureName), "utf8")) as AdversarialFixture;
      const inspection = await createInspection();
      applyMutation(inspection, fixture);

      const result = validatePackageInspection(inspection);
      expect(result.ok, fixture.id).toBe(false);
      expect(result.issues[0]?.ruleId, fixture.id).toBe(fixture.expectedRuleId);
      expect(result.issues[0]?.path, fixture.id).toBeTruthy();
      expect(result.issues[0]?.allowed, fixture.id).toBeDefined();
      expect(result.issues[0]?.validatorVersion, fixture.id).toBe("1.0.0");
      expect(result.issues[0]?.remediation, fixture.id).toBeTruthy();
      expect(formatValidationResult(result), fixture.id).toBe(formatValidationResult(validatePackageInspection(inspection)));
    }
  });

  it("redacts credentials and bounds raw observed input in actionable JSON", async () => {
    const inspection = await createInspection();
    const manifest = inspection.manifest as Record<string, unknown>;
    const fixtureValues = {
      access: ["super-secret-", "token-value"].join(""),
      password: ["pass", "word"].join(""),
    };
    manifest.accessToken = fixtureValues.access;
    (manifest.metadata as Record<string, unknown>).repository =
      `https://user:${fixtureValues.password}@example.com/private.git`;

    const result = validatePackageInspection(inspection);
    const json = formatValidationResult(result);

    expect(result.ok).toBe(false);
    expect(json).not.toContain(fixtureValues.access);
    expect(json).not.toContain(fixtureValues.password);
    expect(json).toContain("[REDACTED]");
    expect(json.length).toBeLessThan(8_192);
  });

  it("redacts prefixed credential keys and URL query or fragment secrets", () => {
    const fixtureValues = {
      path: ["path-secret-", "value"].join(""),
      asset: ["asset-secret-", "value"].join(""),
      package: ["package-password-", "value"].join(""),
      auth: ["auth-secret-", "value"].join(""),
      bearer: ["bearer-secret-", "value"].join(""),
      client: ["client-secret-", "value"].join(""),
      query: ["query-secret-", "value"].join(""),
      fragment: ["fragment-secret-", "value"].join(""),
      genericQuery: ["generic-query-secret-", "value"].join(""),
      databasePassword: ["database-password-", "value"].join(""),
      databaseQuery: ["database-query-", "value"].join(""),
    };
    const accessTokenKey = ["access_", "token"].join("");
    const result = validationFailure([
      validationIssue({
        ruleId: "E_SCHEMA_STRICT",
        path: `/token/${fixtureValues.path}`,
        assetId: `${accessTokenKey}=${fixtureValues.asset}`,
        package: `postgres://admin:${fixtureValues.package}@example.com/game`,
        observed: {
          authToken: fixtureValues.auth,
          bearerToken: fixtureValues.bearer,
          clientSecret: fixtureValues.client,
          callbackUrl:
            `https://example.com/callback?${accessTokenKey}=${fixtureValues.query}#${fixtureValues.fragment}`,
          ordinaryQueryUrl: `https://example.com/callback?q=${fixtureValues.genericQuery}`,
          ordinaryDatabaseUrl:
            `postgres://admin:${fixtureValues.databasePassword}@example.com/game?sslkey=${fixtureValues.databaseQuery}`,
        },
        allowed: "non-sensitive protocol data",
        remediation: "Remove credential-bearing input.",
      }),
    ]);
    const json = formatValidationResult(result);

    for (const secret of Object.values(fixtureValues)) {
      expect(json).not.toContain(secret);
    }
    expect(json).toContain("[REDACTED]");
  });
});
