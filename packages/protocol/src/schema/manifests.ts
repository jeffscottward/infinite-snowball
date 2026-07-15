import { z } from "zod/mini";

import {
  MAX_VALIDATION_ISSUES,
  validationFailure,
  validationIssue,
  validationSuccess,
  type ErrorCode,
  type ValidationResult,
} from "../errors.js";
import { CONTENT_BUDGETS, CONTENT_KINDS, PACKAGE_LIMITS } from "../version.js";
import {
  AssetRecordSchema,
  ContentKindSchema,
  EngineRangeSchema,
  ExactSemverSchema,
  ManifestMetadataSchema,
  PackageLicenseSchema,
  PackageNameSchema,
  PackageRefSchema,
  PackageTotalsSchema,
  ProtocolVersionSchema,
} from "./common.js";
import { boundedArray, snapshotPlainData } from "./preflight.js";
import {
  BundleEntrySchema,
  CampaignEntrySchema,
  CharacterEntrySchema,
  LevelEntrySchema,
  MusicEntrySchema,
  ObjectPackEntrySchema,
} from "./entries.js";
// Level manifests dominate the property bound: each of 64 entries may contain
// 128 collectible groups with 1,024 object IDs, plus its other bounded fields.
const MAX_LEVEL_MANIFEST_SNAPSHOT_PROPERTIES =
  CONTENT_BUDGETS.level.maxFiles * 386 + 64 * 133_500 + 10_000;
const MAX_CAMPAIGN_MANIFEST_SNAPSHOT_PROPERTIES =
  PACKAGE_LIMITS.maxFiles * 386 + 64 * 69_116 + 10_000;
const MAX_MANIFEST_SNAPSHOT_PROPERTIES = Math.max(
  MAX_LEVEL_MANIFEST_SNAPSHOT_PROPERTIES,
  MAX_CAMPAIGN_MANIFEST_SNAPSHOT_PROPERTIES,
);
// Worst-case containers come from 64 object packs with 2,048 objects, each
// carrying material, LOD, and budget containers, plus full provenance assets.
const MAX_MANIFEST_SNAPSHOT_NODES =
  PACKAGE_LIMITS.maxFiles * 6 + 64 * (5 + PACKAGE_LIMITS.maxFiles * 4) + 2_000;

export const MANIFEST_INPUT_SNAPSHOT_LIMITS = Object.freeze({
  maximumDepth: PACKAGE_LIMITS.maxDepth + 8,
  maximumNodes: MAX_MANIFEST_SNAPSHOT_NODES,
  maximumProperties: MAX_MANIFEST_SNAPSHOT_PROPERTIES,
  maximumArrayLength: PACKAGE_LIMITS.maxFiles,
  maximumObjectProperties: 4_096,
});

const CommonManifestShape = {
  schemaVersion: ProtocolVersionSchema,
  name: PackageNameSchema,
  version: ExactSemverSchema,
  engine: EngineRangeSchema,
  metadata: ManifestMetadataSchema,
  license: PackageLicenseSchema,
  dependencies: boundedArray(PackageRefSchema, 256),
  optionalPeers: boundedArray(PackageRefSchema, 256),
  assets: boundedArray(AssetRecordSchema, 2_048),
  totals: PackageTotalsSchema,
  capabilities: z.strictObject({}),
};

const LevelAssetRecordSchema = z.extend(AssetRecordSchema, {
  bytes: z.number().check(z.int()).check(z.nonnegative()).check(z.maximum(CONTENT_BUDGETS.level.maxFileBytes)),
});
const LevelTotalsSchema = z.extend(PackageTotalsSchema, {
  bytes: z.number().check(z.int()).check(z.nonnegative()).check(z.maximum(CONTENT_BUDGETS.level.maxDownloadBytes)),
  fileCount: z.number().check(z.int()).check(z.nonnegative()).check(z.maximum(CONTENT_BUDGETS.level.maxFiles)),
  uncompressedBytes: z.number().check(z.int()).check(z.nonnegative()).check(z.maximum(CONTENT_BUDGETS.level.maxUncompressedBytes)),
});
const MusicAssetRecordSchema = z.extend(AssetRecordSchema, {
  bytes: z.number().check(z.int()).check(z.nonnegative()).check(z.maximum(CONTENT_BUDGETS.music.maxTrackBytes)),
});
const MusicTotalsSchema = z.extend(PackageTotalsSchema, {
  bytes: z.number().check(z.int()).check(z.nonnegative()).check(z.maximum(CONTENT_BUDGETS.music.maxPackBytes)),
  uncompressedBytes: z.number().check(z.int()).check(z.nonnegative()).check(z.maximum(CONTENT_BUDGETS.music.maxPackBytes)),
});

export const LevelManifestSchema = z.strictObject({
  ...CommonManifestShape,
  kind: z.literal("level"),
  assets: boundedArray(LevelAssetRecordSchema, CONTENT_BUDGETS.level.maxFiles),
  totals: LevelTotalsSchema,
  entries: boundedArray(LevelEntrySchema, 64, 1),
});

export const CharacterManifestSchema = z.strictObject({
  ...CommonManifestShape,
  kind: z.literal("character"),
  entries: boundedArray(CharacterEntrySchema, 64, 1),
});

export const ObjectPackManifestSchema = z.strictObject({
  ...CommonManifestShape,
  kind: z.literal("object-pack"),
  entries: boundedArray(ObjectPackEntrySchema, 64, 1),
});

export const CampaignManifestSchema = z.strictObject({
  ...CommonManifestShape,
  kind: z.literal("campaign"),
  entries: boundedArray(CampaignEntrySchema, 64, 1),
});

export const MusicManifestSchema = z.strictObject({
  ...CommonManifestShape,
  kind: z.literal("music"),
  assets: boundedArray(MusicAssetRecordSchema, CONTENT_BUDGETS.music.maxTracks + 16),
  totals: MusicTotalsSchema,
  entries: boundedArray(MusicEntrySchema, 64, 1),
});

export const BundleManifestSchema = z.strictObject({
  ...CommonManifestShape,
  kind: z.literal("bundle"),
  entries: boundedArray(BundleEntrySchema, 64, 1),
});

export const ManifestSchema = z.discriminatedUnion("kind", [
  LevelManifestSchema,
  CharacterManifestSchema,
  ObjectPackManifestSchema,
  CampaignManifestSchema,
  MusicManifestSchema,
  BundleManifestSchema,
]);

export const ManifestSchemasByKind = {
  level: LevelManifestSchema,
  character: CharacterManifestSchema,
  "object-pack": ObjectPackManifestSchema,
  campaign: CampaignManifestSchema,
  music: MusicManifestSchema,
  bundle: BundleManifestSchema,
} as const satisfies Record<(typeof CONTENT_KINDS)[number], z.core.$ZodType>;

export type Manifest = z.infer<typeof ManifestSchema>;
export interface LocalAssetReference {
  assetId: string;
  path: string;
}

type LocalAssetReferenceVisitor = (reference: LocalAssetReference) => boolean | void;

function* iterateLocalAssetReferences(manifest: Manifest): Generator<LocalAssetReference, void, undefined> {
  switch (manifest.kind) {
    case "level":
      for (const [entryIndex, entry] of manifest.entries.entries()) {
        yield { assetId: entry.arenaAssetId, path: `/entries/${entryIndex}/arenaAssetId` };
        yield { assetId: entry.layoutAssetId, path: `/entries/${entryIndex}/layoutAssetId` };
      }
      break;
    case "character":
      for (const [entryIndex, entry] of manifest.entries.entries()) {
        yield { assetId: entry.modelAssetId, path: `/entries/${entryIndex}/modelAssetId` };
        yield { assetId: entry.iconAssetId, path: `/entries/${entryIndex}/iconAssetId` };
        for (const [index, assetId] of entry.screenshotAssetIds.entries()) {
          yield { assetId, path: `/entries/${entryIndex}/screenshotAssetIds/${index}` };
        }
        for (const [index, assetId] of entry.provenanceAssetIds.entries()) {
          yield { assetId, path: `/entries/${entryIndex}/provenanceAssetIds/${index}` };
        }
      }
      break;
    case "object-pack":
      for (const [entryIndex, entry] of manifest.entries.entries()) {
        for (const [objectIndex, object] of entry.objects.entries()) {
          yield {
            assetId: object.colliderAssetId,
            path: `/entries/${entryIndex}/objects/${objectIndex}/colliderAssetId`,
          };
          yield {
            assetId: object.renderAssetId,
            path: `/entries/${entryIndex}/objects/${objectIndex}/renderAssetId`,
          };
          for (const [index, assetId] of object.lodAssetIds.entries()) {
            yield { assetId, path: `/entries/${entryIndex}/objects/${objectIndex}/lodAssetIds/${index}` };
          }
        }
      }
      break;
    case "music":
      for (const [entryIndex, entry] of manifest.entries.entries()) {
        for (const [trackIndex, track] of entry.tracks.entries()) {
          yield { assetId: track.assetId, path: `/entries/${entryIndex}/tracks/${trackIndex}/assetId` };
        }
      }
      break;
    case "campaign":
    case "bundle":
      break;
  }
}

export function visitLocalAssetReferences(
  manifest: Manifest,
  visitor: LocalAssetReferenceVisitor,
): boolean {
  for (const reference of iterateLocalAssetReferences(manifest)) {
    if (visitor(reference) === false) return false;
  }
  return true;
}


function valueAtPath(input: unknown, path: PropertyKey[]): unknown {
  let value = input;
  for (const segment of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<PropertyKey, unknown>)[segment];
  }
  return value;
}

function classifySchemaIssue(path: string): ErrorCode {
  if (/(?:^|\.)(?:version|dependencies|optionalPeers)(?:\.|$)/.test(path)) return "E_DEPENDENCY_EXACT";
  if (/(?:license|provenance|evidenceStatus|attribution)/.test(path)) return "E_LICENSE_POLICY";
  if (/sha256/i.test(path)) return "E_HASH_MISMATCH";
  if (/(?:totals|bytes|maxDepth|maxCompressionRatio|fileCount)/.test(path)) return "E_FILE_BUDGET";
  if (/(?:^|\.)engine(?:\.|$)/.test(path)) return "E_ENGINE_RANGE";
  return "E_SCHEMA_STRICT";
}

function parseManifestUnchecked(input: unknown): ValidationResult<Manifest> {
  const parsed = ManifestSchema.safeParse(input);
  if (parsed.success) {
    const semanticIssues = [];
    const assetIds = new Set<string>();
    const assetPaths = new Set<string>();
    const assetIdCounts = new Map<string, number>();
    const assetPathCounts = new Map<string, number>();
    let declaredAssetBytes = 0;
    let declaredMaxDepth = 0;
    for (const [index, asset] of parsed.data.assets.entries()) {
      declaredAssetBytes += asset.bytes;
      declaredMaxDepth = Math.max(declaredMaxDepth, asset.path.split("/").length);
      if (assetIds.has(asset.assetId)) {
        semanticIssues.push(
          validationIssue({
            ruleId: "E_SCHEMA_STRICT",
            path: `/assets/${index}/assetId`,
            observed: asset.assetId,
            allowed: "one unique assetId per manifest inventory record",
            remediation: "Assign a stable unique assetId and regenerate the flat asset inventory.",
          }),
        );
      }
      if (assetPaths.has(asset.path)) {
        semanticIssues.push(
          validationIssue({
            ruleId: "E_PATH_POLICY",
            path: `/assets/${index}/path`,
            observed: asset.path,
            allowed: "one unique normalized path per manifest inventory record",
            remediation: "Remove the duplicate path and regenerate the flat asset inventory.",
          }),
        );
      }
      assetIdCounts.set(asset.assetId, (assetIdCounts.get(asset.assetId) ?? 0) + 1);
      assetPathCounts.set(asset.path, (assetPathCounts.get(asset.path) ?? 0) + 1);
      assetIds.add(asset.assetId);
      assetPaths.add(asset.path);
    }
    if (semanticIssues.length < MAX_VALIDATION_ISSUES) {
      visitLocalAssetReferences(parsed.data, (reference) => {
        if (assetIdCounts.get(reference.assetId) === 1) return;
        semanticIssues.push(
          validationIssue({
            ruleId: "E_PATH_POLICY",
            path: reference.path,
            observed: reference.assetId,
            allowed: "exactly one declared local assetId",
            remediation: "Declare the referenced local asset exactly once or correct the entry reference.",
          }),
        );
        return semanticIssues.length < MAX_VALIDATION_ISSUES;
      });
    }
    const metadataPaths = [
      { path: "/metadata/icon", value: parsed.data.metadata.icon },
      ...parsed.data.metadata.screenshots.map((value, index) => ({
        path: `/metadata/screenshots/${index}`,
        value,
      })),
    ];
    for (const reference of metadataPaths) {
      if (assetPathCounts.get(reference.value) !== 1) {
        semanticIssues.push(
          validationIssue({
            ruleId: "E_PATH_POLICY",
            path: reference.path,
            observed: reference.value,
            allowed: "exactly one declared normalized asset path",
            remediation: "Declare the metadata asset path exactly once or correct the metadata reference.",
          }),
        );
      }
    }
    if (parsed.data.totals.fileCount !== parsed.data.assets.length) {
      semanticIssues.push(
        validationIssue({
          ruleId: "E_FILE_BUDGET",
          path: "/totals/fileCount",
          observed: parsed.data.totals.fileCount,
          allowed: parsed.data.assets.length,
          remediation: "Set totals.fileCount to the exact flat asset inventory length.",
        }),
      );
    }
    if (parsed.data.totals.uncompressedBytes !== declaredAssetBytes) {
      semanticIssues.push(
        validationIssue({
          ruleId: "E_FILE_BUDGET",
          path: "/totals/uncompressedBytes",
          observed: parsed.data.totals.uncompressedBytes,
          allowed: declaredAssetBytes,
          remediation: "Set totals.uncompressedBytes to the exact sum of the flat asset inventory.",
        }),
      );
    }
    const declaredCompressionRatio =
      parsed.data.totals.bytes === 0
        ? parsed.data.totals.uncompressedBytes === 0
          ? 0
          : Number.POSITIVE_INFINITY
        : parsed.data.totals.uncompressedBytes / parsed.data.totals.bytes;
    if (declaredCompressionRatio > parsed.data.totals.maxCompressionRatio) {
      semanticIssues.push(
        validationIssue({
          ruleId: "E_FILE_BUDGET",
          path: "/totals/maxCompressionRatio",
          observed: declaredCompressionRatio,
          allowed: parsed.data.totals.maxCompressionRatio,
          remediation: "Declare measured download bytes and a compression-ratio ceiling that covers the package.",
        }),
      );
    }
    if (parsed.data.totals.maxDepth !== declaredMaxDepth) {
      semanticIssues.push(
        validationIssue({
          ruleId: "E_FILE_BUDGET",
          path: "/totals/maxDepth",
          observed: parsed.data.totals.maxDepth,
          allowed: declaredMaxDepth,
          remediation: "Set totals.maxDepth to the exact deepest normalized asset path.",
        }),
      );
    }
    return semanticIssues.length === 0 ? validationSuccess(parsed.data) : validationFailure(semanticIssues);
  }

  const issues = parsed.error.issues.slice(0, MAX_VALIDATION_ISSUES).map((zodIssue) => {
    const path = `/${zodIssue.path.map(String).join("/")}`;
    const unrecognizedKeys = "keys" in zodIssue && Array.isArray(zodIssue.keys) ? zodIssue.keys : [];
    const observed =
      unrecognizedKeys.length > 0 && input !== null && typeof input === "object"
        ? Object.fromEntries(
            unrecognizedKeys.map((key) => [key, valueAtPath(input, [...zodIssue.path, key])]),
          )
        : valueAtPath(input, zodIssue.path);
    const ruleId = classifySchemaIssue(zodIssue.path.map(String).join("."));

    return validationIssue({
      ruleId,
      path,
      observed,
      allowed: zodIssue.message,
      remediation:
        ruleId === "E_SCHEMA_STRICT"
          ? "Remove unknown fields and provide every required field from protocol schema 1.0.0."
          : "Replace the rejected value with one permitted by protocol schema 1.0.0 and regenerate the package.",
    });
  });

  return validationFailure(issues);
}

export function parseManifest(input: unknown): ValidationResult<Manifest> {
  try {
    const snapshot = snapshotPlainData(input, MANIFEST_INPUT_SNAPSHOT_LIMITS);
    if (!snapshot.ok) {
      return validationFailure([
        validationIssue({
          ruleId: "E_SCHEMA_STRICT",
          path: "/",
          observed: { reason: snapshot.reason },
          allowed: "plain bounded manifest data",
          remediation: "Reject accessor-backed or mutable hostile input before package validation.",
        }),
      ]);
    }
    return parseManifestUnchecked(snapshot.value);
  } catch {
    return validationFailure([
      validationIssue({
        ruleId: "E_SCHEMA_STRICT",
        path: "/",
        observed: "uninspectable manifest input",
        allowed: "plain bounded manifest data",
        remediation: "Reject accessor-backed or mutable hostile input before package validation.",
      }),
    ]);
  }
}

export { ContentKindSchema };
