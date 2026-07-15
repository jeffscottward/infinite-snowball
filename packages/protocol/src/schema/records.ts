import { z } from "zod/mini";

import {
  ValidationIssueSchema,
  validationFailure,
  validationIssue,
  validationSuccess,
  type ValidationResult,
} from "../errors.js";
import { PACKAGE_LIMITS, PROTOCOL_SCHEMA_VERSION } from "../version.js";
import {
  CatalogResourceBasePathSchema,
  CatalogResourcePathSchema,
  ContentKindSchema,
  DisplayMetadataSchema,
  EngineRangeSchema,
  ExactSemverSchema,
  ImmutableFileSchema,
  IntegritySchema,
  PackageLicenseSchema,
  PackageNameSchema,
  PackageRefSchema,
  PackageTotalsSchema,
  ProtocolVersionSchema,
  SafeRelativePathSchema,
  Sha256Schema,
  StableIdSchema,
  TimestampSchema,
} from "./common.js";
import { boundedArray, recordPreflight, snapshotPlainData } from "./preflight.js";

const MAX_SAVE_EXPORT_COLLECTION_ITEMS = 1_024;
const MAX_SAVE_EXPORT_PAYLOAD_BYTES = 16 * 1024 * 1024;

type PackageRefInvariantFields = {
  name: string;
  version: string;
  kind: string;
  engine: string;
  integrity: string;
  manifestSha256: string;
  catalogEntryId: string;
};

type CatalogEntryParityRecord = {
  entryId: string;
  package: PackageRefInvariantFields;
  kind: string;
  npm: { integrity: string };
  packageKey: string;
};

type CatalogPackageParityRecord = {
  package: Pick<PackageRefInvariantFields, "engine" | "manifestSha256">;
  engine: string;
  manifestSha256: string;
};

type ImmutableFileIdentity = {
  path: string;
  resourcePath: string;
};

type InvariantIssueContext = {
  addIssue(issue: { code: "custom"; path: PropertyKey[]; message: string }): void;
};

function addInvariantIssue(context: InvariantIssueContext, path: PropertyKey[], message: string): void {
  context.addIssue({ code: "custom", path, message });
}

function expectedPackageKey(packageRef: Pick<PackageRefInvariantFields, "name" | "version">): string {
  return `${packageRef.name}@${packageRef.version}`;
}

function firstDuplicateIndex<T>(items: readonly T[], select: (item: T) => string): number | undefined {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const value = select(item);
    if (seen.has(value)) return index;
    seen.add(value);
  }
  return undefined;
}

function enforceUniqueImmutableFileReferences(
  recordName: "PackageLock" | "InstallPlan",
  files: readonly ImmutableFileIdentity[],
  context: InvariantIssueContext,
): void {
  const duplicatePathIndex = firstDuplicateIndex(files, (file) => file.path);
  if (duplicatePathIndex !== undefined) {
    addInvariantIssue(
      context,
      ["files", duplicatePathIndex, "path"],
      `Expected ${recordName} immutable file paths to be unique`,
    );
  }

  const duplicateResourcePathIndex = firstDuplicateIndex(files, (file) => file.resourcePath);
  if (duplicateResourcePathIndex !== undefined) {
    addInvariantIssue(
      context,
      ["files", duplicateResourcePathIndex, "resourcePath"],
      `Expected ${recordName} immutable file resource paths to be unique`,
    );
  }
}

function enforceCatalogEntryPackageParity(entry: CatalogEntryParityRecord, context: InvariantIssueContext): void {
  if (entry.entryId !== entry.package.catalogEntryId) {
    addInvariantIssue(context, ["entryId"], "Expected CatalogEntry entryId to match package catalogEntryId");
  }
  if (entry.kind !== entry.package.kind) {
    addInvariantIssue(context, ["kind"], "Expected CatalogEntry kind to match package kind");
  }
  if (entry.npm.integrity !== entry.package.integrity) {
    addInvariantIssue(context, ["npm", "integrity"], "Expected CatalogEntry npm integrity to match package integrity");
  }
  if (entry.packageKey !== expectedPackageKey(entry.package)) {
    addInvariantIssue(context, ["packageKey"], "Expected CatalogEntry packageKey to match package name and version");
  }
}

function enforceCatalogPackagePackageParity(record: CatalogPackageParityRecord, context: InvariantIssueContext): void {
  if (record.engine !== record.package.engine) {
    addInvariantIssue(context, ["engine"], "Expected CatalogPackage engine to match package engine");
  }
  if (record.manifestSha256 !== record.package.manifestSha256) {
    addInvariantIssue(
      context,
      ["manifestSha256"],
      "Expected CatalogPackage manifestSha256 to match package manifest SHA-256",
    );
  }
}

function enforcePackageLockFileUniqueness(
  record: { files: readonly ImmutableFileIdentity[] },
  context: InvariantIssueContext,
): void {
  enforceUniqueImmutableFileReferences("PackageLock", record.files, context);
}

function enforceInstallPlanFileUniqueness(
  record: { files: readonly ImmutableFileIdentity[] },
  context: InvariantIssueContext,
): void {
  enforceUniqueImmutableFileReferences("InstallPlan", record.files, context);
}


export const CatalogSnapshotSchema = z.strictObject({
  snapshotId: StableIdSchema,
  schemaVersion: ProtocolVersionSchema,
  generatedAt: TimestampSchema,
  etag: z.string().check(z.minLength(1)).check(z.maxLength(256)),
  version: z.string().check(z.minLength(1)).check(z.maxLength(80)),
  entryIds: boundedArray(StableIdSchema, 100_000),
  resourceBasePath: CatalogResourceBasePathSchema,
  evidenceSha256: Sha256Schema,
  previousSnapshotId: z.nullable(StableIdSchema),
});

export const CatalogEntrySchema = z
  .strictObject({
    entryId: StableIdSchema,
    snapshotId: StableIdSchema,
    package: PackageRefSchema,
    kind: ContentKindSchema,
    display: DisplayMetadataSchema,
    screenshots: boundedArray(CatalogResourcePathSchema, 12),
    icon: CatalogResourcePathSchema,
    packageRecordPath: CatalogResourcePathSchema,
    npm: z.strictObject({ integrity: IntegritySchema, provenanceVerified: z.literal(true) }),
    review: z.strictObject({ reviewer: z.string().check(z.minLength(1)).check(z.maxLength(200)), reviewedAt: TimestampSchema, evidenceSha256: Sha256Schema }),
    status: z.enum(["active", "withdrawn", "replaced"]),
    replacement: z.nullable(PackageRefSchema),
    packageKey: z.string().check(z.minLength(1)).check(z.maxLength(300)),
  })
  .check(z.superRefine<CatalogEntryParityRecord>(enforceCatalogEntryPackageParity));

export const CatalogPackageSchema = z
  .strictObject({
    package: PackageRefSchema,
    immutableFiles: boundedArray(ImmutableFileSchema, PACKAGE_LIMITS.maxFiles),
    totals: PackageTotalsSchema,
    licenses: boundedArray(PackageLicenseSchema, 256, 1),
    engine: EngineRangeSchema,
    manifestSha256: Sha256Schema,
    installEligibility: z.enum(["eligible", "withdrawn", "quarantined", "incompatible"]),
  })
  .check(z.superRefine<CatalogPackageParityRecord>(enforceCatalogPackagePackageParity));

export const CatalogPackageAssetSchema = z.strictObject({
  packageName: PackageNameSchema,
  version: ExactSemverSchema,
  path: SafeRelativePathSchema,
  resourcePath: CatalogResourcePathSchema,
  sha256: Sha256Schema,
  referenceCountEligible: z.boolean(),
});

export const PackageLockSchema = z
  .strictObject({
    lockId: StableIdSchema,
    schemaVersion: ProtocolVersionSchema,
    catalogSnapshotId: StableIdSchema,
    engineVersion: ExactSemverSchema,
    packages: boundedArray(z.strictObject({ package: PackageRefSchema, dependencies: boundedArray(StableIdSchema, 256) }), 1_024, 1),
    files: boundedArray(ImmutableFileSchema, PACKAGE_LIMITS.maxFiles),
    createdAt: TimestampSchema,
    active: z.boolean(),
  })
  .check(z.superRefine<{ files: readonly ImmutableFileIdentity[] }>(enforcePackageLockFileUniqueness));

type InstallPlanPackageIdentity = {
  name: string;
  version: string;
};

function hasUniqueInstallPlanValues(values: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return false;
    seen.add(value);
  }
  return true;
}

function hasUniqueInstallPlanPackages(packages: readonly InstallPlanPackageIdentity[]): boolean {
  const packageKeys = packages.map((packageRef) => `${packageRef.name}@${packageRef.version}`);
  return hasUniqueInstallPlanValues(packageKeys);
}

function dependencyOrderMatchesInstallPlanPackages(plan: {
  packages: readonly InstallPlanPackageIdentity[];
  dependencyOrder: readonly string[];
}): boolean {
  const packageKeys = plan.packages.map((packageRef) => `${packageRef.name}@${packageRef.version}`);
  if (!hasUniqueInstallPlanValues(plan.dependencyOrder) || plan.dependencyOrder.length !== packageKeys.length) {
    return false;
  }
  const packageKeySet = new Set(packageKeys);
  return plan.dependencyOrder.every((dependency) => packageKeySet.has(dependency));
}

function expectedBytesMatchInstallPlanFiles(plan: {
  files: readonly { bytes: number }[];
  expectedBytes: number;
}): boolean {
  let expectedBytes = 0;
  for (const file of plan.files) {
    expectedBytes += file.bytes;
    if (!Number.isSafeInteger(expectedBytes)) return false;
  }
  return expectedBytes === plan.expectedBytes;
}


export const InstallPlanSchema = z
  .strictObject({
    planId: StableIdSchema,
    schemaVersion: ProtocolVersionSchema,
    packages: boundedArray(PackageRefSchema, 1_024, 1),
    dependencyOrder: boundedArray(z.string().check(z.minLength(1)).check(z.maxLength(300)), 1_024, 1),
    files: boundedArray(ImmutableFileSchema, PACKAGE_LIMITS.maxFiles),
    expectedBytes: z.number().check(z.int()).check(z.nonnegative()).check(z.maximum(PACKAGE_LIMITS.maxDeclaredBytes)),
    quota: z.strictObject({
      requiredBytes: z.number().check(z.int()).check(z.nonnegative()),
      availableBytes: z.number().check(z.int()).check(z.nonnegative()),
      persistenceRequested: z.boolean(),
    }),
    offline: z.strictObject({ available: z.boolean(), missingFiles: boundedArray(SafeRelativePathSchema, PACKAGE_LIMITS.maxFiles) }),
  })
  .check(z.refine((plan) => hasUniqueInstallPlanPackages(plan.packages), "Expected unique package name/version identities"))
  .check(z.refine(dependencyOrderMatchesInstallPlanPackages, "Expected dependency order to match package identities exactly"))
  .check(z.refine(expectedBytesMatchInstallPlanFiles, "Expected bytes to equal the exact file byte sum"))
  .check(z.refine((plan) => {
    const { availableBytes, requiredBytes } = plan.quota;
    return requiredBytes >= plan.expectedBytes && availableBytes >= requiredBytes;
  }, "Expected quota to cover expected and required bytes"))
  .check(z.refine((plan) => hasUniqueInstallPlanValues(plan.offline.missingFiles), "Expected unique offline missing file paths"))
  .check(z.superRefine<{ files: readonly ImmutableFileIdentity[] }>(enforceInstallPlanFileUniqueness))
  .check(z.refine((plan) => plan.offline.available === (plan.offline.missingFiles.length === 0), "Expected offline availability to match missing files"));

export const InstallTransactionSchema = z.strictObject({
  transactionId: StableIdSchema,
  schemaVersion: ProtocolVersionSchema,
  planId: StableIdSchema,
  state: z.enum(["planned", "staging", "verifying", "committing", "installed", "failed", "canceled"]),
  stagingCacheNamespace: z.string().check(z.minLength(1)).check(z.maxLength(200)),
  verifiedFiles: boundedArray(SafeRelativePathSchema, PACKAGE_LIMITS.maxFiles),
  error: z.nullable(ValidationIssueSchema),
  rollbackActions: boundedArray(z.string().check(z.minLength(1)).check(z.maxLength(500)), 256),
  reconciliationStatus: z.enum(["clean", "required", "running", "reconciled"]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  retentionUntil: TimestampSchema,
});

export const InstallRecordSchema = z.strictObject({
  package: PackageRefSchema,
  activeLockId: StableIdSchema,
  referenceCounts: z
    .pipe(
      recordPreflight(PACKAGE_LIMITS.maxFiles),
      z.record(Sha256Schema, z.number().check(z.int()).check(z.nonnegative())),
    )
    .check(z.meta({ maxProperties: PACKAGE_LIMITS.maxFiles })),
  installedAt: TimestampSchema,
  catalogSnapshotId: StableIdSchema,
  reconciliationStatus: z.enum(["clean", "required", "running", "reconciled"]),
});

export const SaveExportSchema = z.strictObject({
  schemaVersion: ProtocolVersionSchema,
  gameVersion: ExactSemverSchema,
  createdAt: TimestampSchema,
  localProfileId: StableIdSchema,
  campaignProgress: boundedArray(z.strictObject({
    campaignId: StableIdSchema,
    unlockedLevelIds: boundedArray(StableIdSchema, MAX_SAVE_EXPORT_COLLECTION_ITEMS),
  }), MAX_SAVE_EXPORT_COLLECTION_ITEMS),
  levelProgress: boundedArray(z.strictObject({
    levelId: StableIdSchema,
    levelVersion: ExactSemverSchema,
    seed: StableIdSchema,
    score: z.number().check(z.int()).check(z.nonnegative()),
    objectives: z
      .pipe(
        recordPreflight(MAX_SAVE_EXPORT_COLLECTION_ITEMS),
        z.record(StableIdSchema, z.boolean()),
      )
      .check(z.meta({ maxProperties: MAX_SAVE_EXPORT_COLLECTION_ITEMS })),
  }), MAX_SAVE_EXPORT_COLLECTION_ITEMS),
  settings: z.strictObject({
    audioVolume: z.number().check(z.minimum(0)).check(z.maximum(1)),
    reducedMotion: z.boolean(),
    inputPreset: StableIdSchema,
  }),
  activePackageLockIds: boundedArray(StableIdSchema, MAX_SAVE_EXPORT_COLLECTION_ITEMS),
  migrationVersion: z.pipe(
    z.string().check(z.maxLength(32)),
    z.string().check(z.regex(/^\d+$/)),
  ).check(z.meta({ maxLength: 32 })),
  payloadBytes: z.number().check(z.int()).check(z.nonnegative()).check(z.maximum(MAX_SAVE_EXPORT_PAYLOAD_BYTES)),
  checksumAlgorithm: z.literal("sha256"),
  sectionChecksums: z.strictObject({ progress: Sha256Schema, settings: Sha256Schema, locks: Sha256Schema }),
  checksum: Sha256Schema,
});

export type SaveExport = z.infer<typeof SaveExportSchema>;
export type SaveExportPayload = Omit<
  SaveExport,
  "payloadBytes" | "sectionChecksums" | "checksum"
>;

export interface SaveExportIntegrity {
  payloadBytes: number;
  sectionChecksums: {
    progress: string;
    settings: string;
    locks: string;
  };
  checksum: string;
}

const MAX_EXPORT_PREFLIGHT_DEPTH = 32;
const MAX_EXPORT_PREFLIGHT_NODES = 8_192;
// Covers both 1,024² nested domains plus every valid row, array index, and object field.
const MAX_EXPORT_PREFLIGHT_PROPERTIES =
  128 + 2 * MAX_SAVE_EXPORT_COLLECTION_ITEMS ** 2 + 16 * MAX_SAVE_EXPORT_COLLECTION_ITEMS;
const MAX_EXPORT_PREFLIGHT_ARRAY_LENGTH = 2_048;
const MAX_EXPORT_PREFLIGHT_OBJECT_PROPERTIES = 1_024;
const MAX_EXPORT_PREFLIGHT_KEY_LENGTH = 512;
const FORBIDDEN_EXPORT_KEY =
  /^(?:accountIds?|cloudIds?|credentials?|analytics(?:Data|Events)?|diagnostics?|diagnosticData|localAudio(?:Bytes|Tags|Artwork)?|localSoundtrack(?:Bytes|Tags|Artwork)?|networkRefs?|accessToken|password|secret)$/i;
const ROOT_INTEGRITY_FIELDS: ReadonlySet<string> = new Set([
  "payloadBytes",
  "sectionChecksums",
  "checksum",
]);

type ExportPreflightReason =
  | "forbidden"
  | "cycle"
  | "depth"
  | "nodes"
  | "properties"
  | "array-length"
  | "key-length"
  | "prototype"
  | "accessor"
  | "sparse"
  | "encoded-bytes"
  | "inspection";

const SAVE_EXPORT_SNAPSHOT_LIMITS = Object.freeze({
  maximumDepth: MAX_EXPORT_PREFLIGHT_DEPTH,
  maximumNodes: MAX_EXPORT_PREFLIGHT_NODES,
  maximumProperties: MAX_EXPORT_PREFLIGHT_PROPERTIES,
  maximumArrayLength: MAX_EXPORT_PREFLIGHT_ARRAY_LENGTH,
  maximumObjectProperties: MAX_EXPORT_PREFLIGHT_OBJECT_PROPERTIES,
  rejectPrototypeKey: false,
});

interface ExportPreflightFailure {
  ok: false;
  path: string[];
  reason: ExportPreflightReason;
}

function isObjectiveIdRecord(path: readonly string[]): boolean {
  return (
    path.length === 3 &&
    path[0] === "levelProgress" &&
    path[2] === "objectives"
  );
}

function jsonStringUtf8Length(value: string, maximum: number): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += [0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(code) ? 2 : 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
    if (bytes > maximum) return maximum + 1;
  }
  return bytes;
}

function scalarJsonUtf8Length(value: unknown, maximum: number): number | undefined {
  if (typeof value === "string") return jsonStringUtf8Length(value, maximum);
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") return (JSON.stringify(value) ?? "null").length;
  return undefined;
}

function inspectSaveExportInput(value: unknown): { ok: true } | ExportPreflightFailure {
  const stack: Array<{
    countBytes: boolean;
    depth: number;
    path: string[];
    value: unknown;
  }> = [{ countBytes: true, depth: 0, path: [], value }];
  const seen = new WeakSet<object>();
  let canonicalBytes = 0;
  let nodes = 0;
  let properties = 0;

  const consumeBytes = (
    amount: number,
    path: string[],
  ): ExportPreflightFailure | undefined => {
    canonicalBytes += amount;
    return canonicalBytes > MAX_SAVE_EXPORT_PAYLOAD_BYTES
      ? { ok: false, path, reason: "encoded-bytes" }
      : undefined;
  };

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || current.value === null || typeof current.value !== "object") {
      continue;
    }
    if (current.depth > MAX_EXPORT_PREFLIGHT_DEPTH) {
      return { ok: false, path: current.path, reason: "depth" };
    }
    nodes += 1;
    if (nodes > MAX_EXPORT_PREFLIGHT_NODES) {
      return { ok: false, path: current.path, reason: "nodes" };
    }
    if (seen.has(current.value)) {
      return { ok: false, path: current.path, reason: "cycle" };
    }
    seen.add(current.value);

    try {
      const isArray = Array.isArray(current.value);
      const prototype = Object.getPrototypeOf(current.value);
      if (
        (isArray && prototype !== Array.prototype) ||
        (!isArray && prototype !== Object.prototype && prototype !== null)
      ) {
        return { ok: false, path: current.path, reason: "prototype" };
      }

      const children: Array<{
        countBytes: boolean;
        depth: number;
        path: string[];
        value: object;
      }> = [];
      if (current.countBytes) {
        const failure = consumeBytes(2, current.path);
        if (failure !== undefined) return failure;
      }

      if (isArray) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(current.value, "length");
        if (
          lengthDescriptor === undefined ||
          !("value" in lengthDescriptor) ||
          typeof lengthDescriptor.value !== "number" ||
          !Number.isInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0
        ) {
          return { ok: false, path: current.path, reason: "inspection" };
        }
        const length = lengthDescriptor.value;
        if (length > MAX_EXPORT_PREFLIGHT_ARRAY_LENGTH) {
          return { ok: false, path: current.path, reason: "array-length" };
        }
        for (let index = 0; index < length; index += 1) {
          properties += 1;
          const nextPath = [...current.path, String(index)];
          if (properties > MAX_EXPORT_PREFLIGHT_PROPERTIES) {
            return { ok: false, path: nextPath, reason: "properties" };
          }
          if (current.countBytes && index > 0) {
            const failure = consumeBytes(1, nextPath);
            if (failure !== undefined) return failure;
          }
          const descriptor = Object.getOwnPropertyDescriptor(current.value, String(index));
          if (descriptor === undefined) {
            return { ok: false, path: nextPath, reason: "sparse" };
          }
          if (!("value" in descriptor)) {
            return { ok: false, path: nextPath, reason: "accessor" };
          }
          if (descriptor.value !== null && typeof descriptor.value === "object") {
            children.push({
              countBytes: current.countBytes,
              depth: current.depth + 1,
              path: nextPath,
              value: descriptor.value,
            });
          } else if (current.countBytes) {
            const length = scalarJsonUtf8Length(
              descriptor.value,
              MAX_SAVE_EXPORT_PAYLOAD_BYTES - canonicalBytes,
            );
            if (length === undefined) {
              return { ok: false, path: nextPath, reason: "inspection" };
            }
            const failure = consumeBytes(length, nextPath);
            if (failure !== undefined) return failure;
          }
        }
        for (const key in current.value) {
          if (!Object.hasOwn(current.value, key)) continue;
          const index = Number(key);
          if (
            Number.isInteger(index) &&
            index >= 0 &&
            index < length &&
            String(index) === key
          ) {
            continue;
          }
          return { ok: false, path: [...current.path, key], reason: "inspection" };
        }
      } else {
        const keys = Reflect.ownKeys(current.value);
        if (keys.length > MAX_EXPORT_PREFLIGHT_OBJECT_PROPERTIES) {
          return { ok: false, path: current.path, reason: "properties" };
        }
        let countedProperties = 0;
        for (const key of keys) {
          if (typeof key !== "string") {
            return { ok: false, path: current.path, reason: "inspection" };
          }
          properties += 1;
          const nextPath = [...current.path, key];
          if (properties > MAX_EXPORT_PREFLIGHT_PROPERTIES) {
            return { ok: false, path: nextPath, reason: "properties" };
          }
          if (key.length > MAX_EXPORT_PREFLIGHT_KEY_LENGTH) {
            return { ok: false, path: current.path, reason: "key-length" };
          }
          if (!isObjectiveIdRecord(current.path) && FORBIDDEN_EXPORT_KEY.test(key)) {
            return { ok: false, path: nextPath, reason: "forbidden" };
          }

          const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
          if (descriptor === undefined || !("value" in descriptor)) {
            return { ok: false, path: nextPath, reason: "accessor" };
          }
          if (!descriptor.enumerable) {
            return { ok: false, path: nextPath, reason: "inspection" };
          }

          const countBytes =
            current.countBytes &&
            !(current.path.length === 0 && ROOT_INTEGRITY_FIELDS.has(key));
          if (countBytes) {
            if (countedProperties > 0) {
              const failure = consumeBytes(1, nextPath);
              if (failure !== undefined) return failure;
            }
            const keyLength = jsonStringUtf8Length(
              key,
              MAX_SAVE_EXPORT_PAYLOAD_BYTES - canonicalBytes,
            );
            const failure = consumeBytes(keyLength + 1, nextPath);
            if (failure !== undefined) return failure;
            countedProperties += 1;
          }

          if (descriptor.value !== null && typeof descriptor.value === "object") {
            children.push({
              countBytes,
              depth: current.depth + 1,
              path: nextPath,
              value: descriptor.value,
            });
          } else if (countBytes) {
            const length = scalarJsonUtf8Length(
              descriptor.value,
              MAX_SAVE_EXPORT_PAYLOAD_BYTES - canonicalBytes,
            );
            if (length === undefined) {
              return { ok: false, path: nextPath, reason: "inspection" };
            }
            const failure = consumeBytes(length, nextPath);
            if (failure !== undefined) return failure;
          }
        }
      }
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) stack.push(child);
      }
    } catch {
      return { ok: false, path: current.path, reason: "inspection" };
    }
  }

  return { ok: true };
}

type PreparedSaveExportInput =
  | { ok: true; value: unknown }
  | ExportPreflightFailure;

function snapshotFailureReason(reason: string): ExportPreflightReason {
  if (reason === "cycle-or-alias") return "cycle";
  if (reason === "depth" || reason === "nodes" || reason === "properties") return reason;
  if (reason === "array-length") return "array-length";
  if (reason === "object-properties") return "properties";
  if (reason === "prototype") return "prototype";
  if (reason === "array-descriptor" || reason === "object-descriptor") return "accessor";
  if (reason === "array-shape") return "sparse";
  return "inspection";
}

function prepareSaveExportInput(input: unknown): PreparedSaveExportInput {
  const snapshot = snapshotPlainData(input, SAVE_EXPORT_SNAPSHOT_LIMITS);
  if (!snapshot.ok) {
    return {
      ok: false,
      path: [],
      reason: snapshotFailureReason(snapshot.reason),
    };
  }
  const preflight = inspectSaveExportInput(snapshot.value);
  return preflight.ok ? { ok: true, value: snapshot.value } : preflight;
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function canonicalJsonValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonValue(item) ?? "null").join(",")}]`;
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);

  const entries: string[] = [];
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    const child = canonicalJsonValue((value as Record<string, unknown>)[key]);
    if (child !== undefined) entries.push(`${JSON.stringify(key)}:${child}`);
  }
  return `{${entries.join(",")}}`;
}

function canonicalJson(value: unknown): string {
  return canonicalJsonValue(value) ?? "null";
}

function saveExportPayload(input: SaveExportPayload): Record<string, unknown> {
  return {
    schemaVersion: input.schemaVersion,
    gameVersion: input.gameVersion,
    createdAt: input.createdAt,
    localProfileId: input.localProfileId,
    campaignProgress: input.campaignProgress,
    levelProgress: input.levelProgress,
    settings: input.settings,
    activePackageLockIds: input.activePackageLockIds,
    migrationVersion: input.migrationVersion,
    checksumAlgorithm: input.checksumAlgorithm,
  };
}

async function digestSha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function computeSaveExportIntegrity(
  input: SaveExportPayload,
): Promise<SaveExportIntegrity> {
  const prepared = prepareSaveExportInput(input);
  if (!prepared.ok) {
    if (prepared.reason === "encoded-bytes") {
      throw new RangeError("SaveExport canonical payload exceeds 16 MiB.");
    }
    throw new TypeError(`SaveExport payload failed bounded preflight: ${prepared.reason}.`);
  }
  const stableInput = prepared.value as SaveExportPayload;
  const encoder = new TextEncoder();
  const payload = encoder.encode(canonicalJson(saveExportPayload(stableInput)));
  const progress = encoder.encode(
    canonicalJson({
      campaignProgress: stableInput.campaignProgress,
      levelProgress: stableInput.levelProgress,
    }),
  );
  const settings = encoder.encode(canonicalJson(stableInput.settings));
  const locks = encoder.encode(canonicalJson(stableInput.activePackageLockIds));
  const [progressChecksum, settingsChecksum, locksChecksum, checksum] = await Promise.all([
    digestSha256(progress),
    digestSha256(settings),
    digestSha256(locks),
    digestSha256(payload),
  ]);

  return {
    payloadBytes: payload.byteLength,
    sectionChecksums: {
      progress: progressChecksum,
      settings: settingsChecksum,
      locks: locksChecksum,
    },
    checksum,
  };
}

export function parseSaveExport(input: unknown): ValidationResult<SaveExport> {
  const prepared = prepareSaveExportInput(input);
  if (!prepared.ok) {
    const privacyFailure = prepared.reason === "forbidden";
    return validationFailure([
      validationIssue({
        ruleId: privacyFailure
          ? "E_PRIVACY_EGRESS"
          : [
                "depth",
                "nodes",
                "properties",
                "array-length",
                "key-length",
                "encoded-bytes",
              ].includes(prepared.reason)
            ? "E_SAVE_EXPORT_SIZE"
            : "E_SCHEMA_STRICT",
        path: prepared.path.length === 0 ? "/" : `/${prepared.path.join("/")}`,
        observed: { reason: prepared.reason },
        allowed: privacyFailure
          ? "local-only versioned save data without account, credential, analytics, diagnostic, network, or local-audio fields"
          : {
              maximumArrayLength: MAX_EXPORT_PREFLIGHT_ARRAY_LENGTH,
              maximumDepth: MAX_EXPORT_PREFLIGHT_DEPTH,
              maximumNodes: MAX_EXPORT_PREFLIGHT_NODES,
              maximumProperties: MAX_EXPORT_PREFLIGHT_PROPERTIES,
              maximumObjectProperties: MAX_EXPORT_PREFLIGHT_OBJECT_PROPERTIES,
              maximumPayloadBytes: MAX_SAVE_EXPORT_PAYLOAD_BYTES,
            },
        remediation: privacyFailure
          ? "Remove private or network-derived data and create a new local SaveExport."
          : "Reject the hostile export before schema traversal and create a bounded plain-data SaveExport.",
      }),
    ]);
  }

  const parsed = (() => {
    try {
      return SaveExportSchema.safeParse(prepared.value);
    } catch {
      return undefined;
    }
  })();
  if (parsed === undefined) {
    return validationFailure([
      validationIssue({
        ruleId: "E_SCHEMA_STRICT",
        path: "/",
        observed: "structural parser rejected hostile input",
        allowed: `SaveExport protocol ${PROTOCOL_SCHEMA_VERSION}`,
        remediation: "Reject the hostile input before import and create a plain-data SaveExport.",
      }),
    ]);
  }
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first === undefined ? "/" : `/${first.path.map(String).join("/")}`;
    const firstPathSegment = first?.path[0];
    const ruleId =
      firstPathSegment === "payloadBytes"
        ? "E_SAVE_EXPORT_SIZE"
        : firstPathSegment === "checksum" || firstPathSegment === "sectionChecksums"
          ? "E_SAVE_EXPORT_INTEGRITY"
          : firstPathSegment === "schemaVersion" ||
              firstPathSegment === "gameVersion" ||
              firstPathSegment === "migrationVersion" ||
              firstPathSegment === "checksumAlgorithm"
            ? "E_SAVE_EXPORT_VERSION"
            : "E_SCHEMA_STRICT";

    return validationFailure([
      validationIssue({
        ruleId,
        path,
        observed: prepared.value,
        allowed: `SaveExport protocol ${PROTOCOL_SCHEMA_VERSION}`,
        remediation: "Reject the import before mutation and create a compatible, checksummed export.",
      }),
    ]);
  }

  return validationSuccess(parsed.data);
}

export async function verifySaveExportIntegrity(
  input: unknown,
): Promise<ValidationResult<SaveExport>> {
  const parsed = parseSaveExport(input);
  if (!parsed.ok) return parsed;

  let expected: SaveExportIntegrity;
  try {
    expected = await computeSaveExportIntegrity(parsed.value);
  } catch {
    return validationFailure([
      validationIssue({
        ruleId: "E_SAVE_EXPORT_INTEGRITY",
        path: "/checksum",
        observed: "SHA-256 verification unavailable",
        allowed: "browser-native Web Crypto SHA-256",
        remediation: "Reject the import unless Web Crypto can verify every canonical checksum.",
      }),
    ]);
  }

  if (parsed.value.payloadBytes !== expected.payloadBytes) {
    return validationFailure([
      validationIssue({
        ruleId: "E_SAVE_EXPORT_SIZE",
        path: "/payloadBytes",
        observed: parsed.value.payloadBytes,
        allowed: expected.payloadBytes,
        remediation: "Reject the stale export and recompute its canonical UTF-8 payload byte count.",
      }),
    ]);
  }

  for (const section of ["progress", "settings", "locks"] as const) {
    if (parsed.value.sectionChecksums[section] !== expected.sectionChecksums[section]) {
      return validationFailure([
        validationIssue({
          ruleId: "E_SAVE_EXPORT_INTEGRITY",
          path: `/sectionChecksums/${section}`,
          observed: parsed.value.sectionChecksums[section],
          allowed: expected.sectionChecksums[section],
          remediation: "Reject the stale export and recompute every canonical section checksum before import.",
        }),
      ]);
    }
  }
  if (parsed.value.checksum !== expected.checksum) {
    return validationFailure([
      validationIssue({
        ruleId: "E_SAVE_EXPORT_INTEGRITY",
        path: "/checksum",
        observed: parsed.value.checksum,
        allowed: expected.checksum,
        remediation: "Reject the stale export and recompute its canonical payload SHA-256 before import.",
      }),
    ]);
  }

  return validationSuccess(parsed.value);
}
