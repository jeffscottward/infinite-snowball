import { createHash } from "node:crypto";

import { caseFold } from "unicode-case-folding";

import {
  formatValidationResult,
  validationFailure,
  validationIssue,
  validationSuccess,
  type ValidationIssue,
  type ValidationResult,
} from "../errors.js";
import { CONTENT_BUDGETS, PACKAGE_LIMITS } from "../version.js";
import {
  MANIFEST_INPUT_SNAPSHOT_LIMITS,
  parseManifest,
  type Manifest,
} from "../schema/manifests.js";
import { snapshotPlainData } from "../schema/preflight.js";

const MAX_INSPECTION_GLB_REFERENCES = 256;
const MAX_SNAPSHOT_FILES = PACKAGE_LIMITS.maxFiles;
const PACKAGE_INSPECTION_ROOT_KEYS = ["manifest", "archive", "files"] as const;
const PACKAGE_INSPECTION_ARCHIVE_KEYS = [
  "compressedBytes",
  "uncompressedBytes",
  "fileCount",
  "maxDepth",
] as const;
const PACKAGE_INSPECTION_FILE_KEYS = [
  "path",
  "kind",
  "declaredMime",
  "sniffedMime",
  "bytes",
  "actualSha256",
  "compressedBytes",
  "depth",
  "codec",
  "glbReferences",
  "decodedGeometry",
  "decodedTexture",
  "decodedAudio",
  "executable",
] as const;

export const PACKAGE_INSPECTION_SNAPSHOT_LIMITS = Object.freeze({
  ...MANIFEST_INPUT_SNAPSHOT_LIMITS,
  maximumDepth: MANIFEST_INPUT_SNAPSHOT_LIMITS.maximumDepth + 2,
  maximumArrayLength: MAX_SNAPSHOT_FILES,
  maximumNodes:
    MANIFEST_INPUT_SNAPSHOT_LIMITS.maximumNodes + MAX_SNAPSHOT_FILES * 5 + 3,
  maximumProperties:
    MANIFEST_INPUT_SNAPSHOT_LIMITS.maximumProperties +
    MAX_SNAPSHOT_FILES * (1 + 14 + 7 + MAX_INSPECTION_GLB_REFERENCES) +
    20,
});

function oversizedFileInventory(input: unknown): number | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const filesDescriptor = Object.getOwnPropertyDescriptor(input, "files");
  if (filesDescriptor === undefined || !("value" in filesDescriptor)) return undefined;
  const files = filesDescriptor.value;
  if (!Array.isArray(files)) return undefined;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(files, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value)
  ) {
    return undefined;
  }
  return lengthDescriptor.value > PACKAGE_LIMITS.maxFiles
    ? lengthDescriptor.value as number
    : undefined;
}

function hasExactOwnKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function strictBoundaryFailure(
  path: string,
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): ValidationResult<Manifest> {
  return validationFailure([
    validationIssue({
      ruleId: "E_SCHEMA_STRICT",
      path,
      observed: { propertyCount: Object.keys(value).length },
      allowed: { exactProperties: expectedKeys },
      remediation: "Reject extractor output with missing or unknown fields before semantic validation.",
    }),
  ]);
}

export interface PackageInspectionGeometryMetrics {
  triangles: number;
  maxTextureDimension: number;
}

export interface PackageInspectionTextureMetrics {
  width: number;
  height: number;
}

export interface PackageInspectionAudioMetrics {
  durationSeconds: number;
  channels: number;
  sampleRate: number;
}

export interface PackageInspectionFile {
  path: string;
  kind: "file" | "symlink";
  declaredMime: string;
  sniffedMime: string;
  bytes: number;
  actualSha256: string;
  compressedBytes: number;
  depth: number;
  codec: string | undefined;
  glbReferences: string[] | undefined;
  decodedGeometry: PackageInspectionGeometryMetrics | undefined;
  decodedTexture: PackageInspectionTextureMetrics | undefined;
  decodedAudio: PackageInspectionAudioMetrics | undefined;
  executable: boolean;
}

export interface PackageInspection {
  manifest: unknown;
  archive: {
    compressedBytes: number;
    uncompressedBytes: number;
    fileCount: number;
    maxDepth: number;
  };
  files: PackageInspectionFile[];
}

const FORBIDDEN_EXTENSION = /\.(?:cjs|css|dll|dylib|exe|html?|jar|js|jsx|mjs|node|sh|ts|tsx|wasm)$/i;
const FORBIDDEN_MIME = /(?:javascript|ecmascript|text\/css|text\/html|application\/wasm)/i;
const LOWER_SHA256 = /^[a-f0-9]{64}$/;
const MAX_INSPECTION_PATH_LENGTH = 512;
const MAX_INSPECTION_MIME_LENGTH = 128;
const MAX_INSPECTION_CODEC_LENGTH = 128;
const MAX_INSPECTION_REFERENCE_LENGTH = 512;
const SUPPORTED_CODEC: Record<string, true> = {
  "application/json": true,
  "audio/ogg": true,
  "audio/wav": true,
  "image/avif": true,
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
  "model/gltf-binary": true,
};
const MIME_BY_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".glb": "model/gltf-binary",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".webp": "image/webp",
};

const PACKAGE_INSPECTION_GEOMETRY_KEYS = ["triangles", "maxTextureDimension"] as const;
const PACKAGE_INSPECTION_TEXTURE_KEYS = ["width", "height"] as const;
const PACKAGE_INSPECTION_AUDIO_KEYS = ["durationSeconds", "channels", "sampleRate"] as const;
const WIN32_DEVICE_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/u;
const WIN32_FORBIDDEN_PATH_CHARACTERS = /[<>:"|?*\u0000-\u001F]/u;

type JsonConfigValue = string | number | boolean | null;
type DerivedAssetRole =
  | "arena"
  | "layout"
  | "icon"
  | "screenshot"
  | "character-model"
  | "render-model"
  | "lod-model"
  | "collider"
  | "music-track";
type MimeFamily = "audio" | "image" | "model";

interface RoleProfile {
  role: DerivedAssetRole;
  mimeFamily: MimeFamily;
  maxFileBytes: number;
  maxDeclaredBytes: number;
  maxTriangles?: number;
  maxTextureDimension?: number;
  maxDurationSeconds?: number;
  maxChannels?: number;
  maxSampleRate?: number;
  priority: number;
}

interface RoleAddition {
  role: DerivedAssetRole;
  referencePath: string;
  declaredMaxBytes?: number;
  declaredMaxBytesPath?: string;
  declaredMaxTriangles?: number;
  declaredMaxTrianglesPath?: string;
  declaredAudio?: PackageInspectionAudioMetrics;
}

interface AssetInspectionContract extends RoleProfile {
  requiredMimeFamilies: readonly MimeFamily[];
  semanticRoles: readonly DerivedAssetRole[];
  referencePaths: string[];
  declaredMaxBytes: number | undefined;
  declaredMaxBytesPath: string | undefined;
  declaredMaxTriangles: number | undefined;
  declaredMaxTrianglesPath: string | undefined;
  declaredAudio: PackageInspectionAudioMetrics | undefined;
  declaredAudioFacts: readonly PackageInspectionAudioMetrics[];
}

const ROLE_PROFILES = {
  arena: {
    role: "arena",
    mimeFamily: "model",
    maxFileBytes: CONTENT_BUDGETS.level.maxFileBytes,
    maxDeclaredBytes: CONTENT_BUDGETS.level.maxUncompressedBytes,
    maxTextureDimension: CONTENT_BUDGETS.level.maxTextureDimension,
    priority: 50,
  },
  layout: {
    role: "layout",
    mimeFamily: "model",
    maxFileBytes: CONTENT_BUDGETS.level.maxFileBytes,
    maxDeclaredBytes: CONTENT_BUDGETS.level.maxUncompressedBytes,
    maxTextureDimension: CONTENT_BUDGETS.level.maxTextureDimension,
    priority: 51,
  },
  icon: {
    role: "icon",
    mimeFamily: "image",
    maxFileBytes: CONTENT_BUDGETS.level.maxFileBytes,
    maxDeclaredBytes: CONTENT_BUDGETS.level.maxFileBytes,
    maxTextureDimension: CONTENT_BUDGETS.level.maxTextureDimension,
    priority: 80,
  },
  screenshot: {
    role: "screenshot",
    mimeFamily: "image",
    maxFileBytes: CONTENT_BUDGETS.level.maxFileBytes,
    maxDeclaredBytes: CONTENT_BUDGETS.level.maxFileBytes,
    maxTextureDimension: CONTENT_BUDGETS.level.maxTextureDimension,
    priority: 81,
  },
  "character-model": {
    role: "character-model",
    mimeFamily: "model",
    maxFileBytes: CONTENT_BUDGETS.hero.maxBytes,
    maxDeclaredBytes: CONTENT_BUDGETS.hero.maxBytes,
    maxTriangles: CONTENT_BUDGETS.hero.maxTriangles,
    maxTextureDimension: CONTENT_BUDGETS.hero.maxTextureDimension,
    priority: 30,
  },
  "render-model": {
    role: "render-model",
    mimeFamily: "model",
    maxFileBytes: CONTENT_BUDGETS.collectible.maxBytes,
    maxDeclaredBytes: CONTENT_BUDGETS.collectible.maxBytes,
    maxTriangles: CONTENT_BUDGETS.collectible.maxTriangles,
    maxTextureDimension: CONTENT_BUDGETS.collectible.maxTextureDimension,
    priority: 20,
  },
  "lod-model": {
    role: "lod-model",
    mimeFamily: "model",
    maxFileBytes: CONTENT_BUDGETS.collectible.maxBytes,
    maxDeclaredBytes: CONTENT_BUDGETS.collectible.maxBytes,
    maxTriangles: CONTENT_BUDGETS.collectible.maxTriangles,
    maxTextureDimension: CONTENT_BUDGETS.collectible.maxTextureDimension,
    priority: 21,
  },
  collider: {
    role: "collider",
    mimeFamily: "model",
    maxFileBytes: CONTENT_BUDGETS.collectible.maxBytes,
    maxDeclaredBytes: CONTENT_BUDGETS.collectible.maxBytes,
    maxTriangles: CONTENT_BUDGETS.collectible.maxTriangles,
    maxTextureDimension: CONTENT_BUDGETS.collectible.maxTextureDimension,
    priority: 10,
  },
  "music-track": {
    role: "music-track",
    mimeFamily: "audio",
    maxFileBytes: CONTENT_BUDGETS.music.maxTrackBytes,
    maxDeclaredBytes: CONTENT_BUDGETS.music.maxTrackBytes,
    maxDurationSeconds: CONTENT_BUDGETS.music.maxTrackSeconds,
    maxChannels: CONTENT_BUDGETS.music.maxChannels,
    maxSampleRate: CONTENT_BUDGETS.music.maxSampleRate,
    priority: 40,
  },
} as const satisfies Record<DerivedAssetRole, RoleProfile>;

function finiteLimit(value: number | undefined): number {
  return value ?? Number.POSITIVE_INFINITY;
}

function isRoleStricter(candidate: DerivedAssetRole, current: DerivedAssetRole): boolean {
  const left: RoleProfile = ROLE_PROFILES[candidate];
  const right: RoleProfile = ROLE_PROFILES[current];
  if (left.maxFileBytes !== right.maxFileBytes) return left.maxFileBytes < right.maxFileBytes;
  if (finiteLimit(left.maxTriangles) !== finiteLimit(right.maxTriangles)) {
    return finiteLimit(left.maxTriangles) < finiteLimit(right.maxTriangles);
  }
  if (finiteLimit(left.maxTextureDimension) !== finiteLimit(right.maxTextureDimension)) {
    return finiteLimit(left.maxTextureDimension) < finiteLimit(right.maxTextureDimension);
  }
  return left.priority < right.priority;
}

function minimumMetric(
  currentValue: number | undefined,
  currentPath: string | undefined,
  nextValue: number | undefined,
  nextPath: string | undefined,
): { value: number | undefined; path: string | undefined } {
  if (nextValue === undefined) return { value: currentValue, path: currentPath };
  if (currentValue === undefined || nextValue < currentValue) return { value: nextValue, path: nextPath };
  return { value: currentValue, path: currentPath };
}

function minimumAudioMetric(
  current: PackageInspectionAudioMetrics | undefined,
  next: PackageInspectionAudioMetrics | undefined,
): PackageInspectionAudioMetrics | undefined {
  if (next === undefined) return current;
  if (current === undefined) return next;
  return {
    durationSeconds: Math.min(current.durationSeconds, next.durationSeconds),
    channels: Math.min(current.channels, next.channels),
    sampleRate: Math.min(current.sampleRate, next.sampleRate),
  };
}

function mergeAssetContract(
  current: AssetInspectionContract | undefined,
  addition: RoleAddition,
): AssetInspectionContract {
  const additionProfile = ROLE_PROFILES[addition.role];
  const role =
    current === undefined ||
      (current.mimeFamily === additionProfile.mimeFamily &&
        isRoleStricter(addition.role, current.role))
      ? addition.role
      : current.role;
  const profile = ROLE_PROFILES[role];
  const declaredMaxBytes = minimumMetric(
    current?.declaredMaxBytes,
    current?.declaredMaxBytesPath,
    addition.declaredMaxBytes,
    addition.declaredMaxBytesPath,
  );
  const declaredMaxTriangles = minimumMetric(
    current?.declaredMaxTriangles,
    current?.declaredMaxTrianglesPath,
    addition.declaredMaxTriangles,
    addition.declaredMaxTrianglesPath,
  );
  const requiredMimeFamilies = current?.requiredMimeFamilies ?? [];
  const semanticRoles = current?.semanticRoles ?? [];
  return {
    ...profile,
    requiredMimeFamilies: requiredMimeFamilies.includes(additionProfile.mimeFamily)
      ? requiredMimeFamilies
      : [...requiredMimeFamilies, additionProfile.mimeFamily],
    semanticRoles: semanticRoles.includes(addition.role)
      ? semanticRoles
      : [...semanticRoles, addition.role],
    referencePaths: [...(current?.referencePaths ?? []), addition.referencePath],
    declaredMaxBytes: declaredMaxBytes.value,
    declaredMaxBytesPath: declaredMaxBytes.path,
    declaredMaxTriangles: declaredMaxTriangles.value,
    declaredMaxTrianglesPath: declaredMaxTriangles.path,
    declaredAudio: minimumAudioMetric(current?.declaredAudio, addition.declaredAudio),
    declaredAudioFacts:
      addition.declaredAudio === undefined
        ? (current?.declaredAudioFacts ?? [])
        : [...(current?.declaredAudioFacts ?? []), addition.declaredAudio],
  };
}

function deriveAssetContracts(manifest: Manifest): Map<string, AssetInspectionContract> {
  const contracts = new Map<string, AssetInspectionContract>();
  const assetsById = new Map(manifest.assets.map((asset) => [asset.assetId, asset]));
  const assetsByPath = new Map(manifest.assets.map((asset) => [asset.path, asset]));
  const addAssetId = (assetId: string, addition: RoleAddition): void => {
    if (!assetsById.has(assetId)) return;
    contracts.set(assetId, mergeAssetContract(contracts.get(assetId), addition));
  };
  const addAssetPath = (assetPath: string, addition: RoleAddition): void => {
    const asset = assetsByPath.get(assetPath);
    if (asset !== undefined) addAssetId(asset.assetId, addition);
  };

  addAssetPath(manifest.metadata.icon, { role: "icon", referencePath: "/metadata/icon" });
  for (const [index, screenshot] of manifest.metadata.screenshots.entries()) {
    addAssetPath(screenshot, { role: "screenshot", referencePath: `/metadata/screenshots/${index}` });
  }

  switch (manifest.kind) {
    case "level":
      for (const [entryIndex, entry] of manifest.entries.entries()) {
        const budgetPath = `/entries/${entryIndex}/budgets`;
        const budget = {
          declaredMaxBytes: entry.budgets.maxBytes,
          declaredMaxBytesPath: `${budgetPath}/maxBytes`,
          declaredMaxTriangles: entry.budgets.maxTriangles,
          declaredMaxTrianglesPath: `${budgetPath}/maxTriangles`,
        };
        addAssetId(entry.arenaAssetId, { role: "arena", referencePath: `/entries/${entryIndex}/arenaAssetId`, ...budget });
        addAssetId(entry.layoutAssetId, { role: "layout", referencePath: `/entries/${entryIndex}/layoutAssetId`, ...budget });
      }
      break;
    case "character":
      for (const [entryIndex, entry] of manifest.entries.entries()) {
        addAssetId(entry.modelAssetId, { role: "character-model", referencePath: `/entries/${entryIndex}/modelAssetId` });
        addAssetId(entry.iconAssetId, { role: "icon", referencePath: `/entries/${entryIndex}/iconAssetId` });
        for (const [index, assetId] of entry.screenshotAssetIds.entries()) {
          addAssetId(assetId, { role: "screenshot", referencePath: `/entries/${entryIndex}/screenshotAssetIds/${index}` });
        }
      }
      break;
    case "object-pack":
      for (const [entryIndex, entry] of manifest.entries.entries()) {
        for (const [objectIndex, object] of entry.objects.entries()) {
          const budgetPath = `/entries/${entryIndex}/objects/${objectIndex}/budgets`;
          const budget = {
            declaredMaxBytes: object.budgets.maxBytes,
            declaredMaxBytesPath: `${budgetPath}/maxBytes`,
            declaredMaxTriangles: object.budgets.maxTriangles,
            declaredMaxTrianglesPath: `${budgetPath}/maxTriangles`,
          };
          addAssetId(object.colliderAssetId, {
            role: "collider",
            referencePath: `/entries/${entryIndex}/objects/${objectIndex}/colliderAssetId`,
            ...budget,
          });
          addAssetId(object.renderAssetId, {
            role: "render-model",
            referencePath: `/entries/${entryIndex}/objects/${objectIndex}/renderAssetId`,
            ...budget,
          });
          for (const [index, assetId] of object.lodAssetIds.entries()) {
            addAssetId(assetId, {
              role: "lod-model",
              referencePath: `/entries/${entryIndex}/objects/${objectIndex}/lodAssetIds/${index}`,
              ...budget,
            });
          }
        }
      }
      break;
    case "music":
      for (const [entryIndex, entry] of manifest.entries.entries()) {
        for (const [trackIndex, track] of entry.tracks.entries()) {
          addAssetId(track.assetId, {
            role: "music-track",
            referencePath: `/entries/${entryIndex}/tracks/${trackIndex}/assetId`,
            declaredAudio: {
              durationSeconds: track.durationSeconds,
              channels: track.channels,
              sampleRate: track.sampleRate,
            },
          });
        }
      }
      break;
    case "campaign":
    case "bundle":
      break;
  }

  return contracts;
}

function canonicalConfigSha256(config: Record<string, JsonConfigValue>): string {
  const canonical = `{${Object.keys(config)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(config[key])}`)
    .join(",")}}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function portableSegmentCollisionKey(casedSegment: string): string {
  const streamBase = casedSegment.slice(
    0,
    casedSegment.indexOf(":") < 0 ? casedSegment.length : casedSegment.indexOf(":"),
  );
  const trimmed = streamBase.replace(/[. ]+$/u, "");
  const deviceBase = trimmed.slice(0, trimmed.indexOf(".") < 0 ? trimmed.length : trimmed.indexOf("."));
  const normalizedDeviceBase = deviceBase.toLowerCase();
  return WIN32_DEVICE_BASENAME.test(normalizedDeviceBase) ? `<device:${normalizedDeviceBase}>` : trimmed;
}


function segmentIsHostUnsafe(segment: string): boolean {
  const folded = caseFold(segment.normalize("NFC")).normalize("NFC");
  const trimmed = folded.replace(/[. ]+$/u, "");
  const deviceBase = trimmed.slice(0, trimmed.indexOf(".") < 0 ? trimmed.length : trimmed.indexOf("."));
  return (
    segment.endsWith(".") ||
    segment.endsWith(" ") ||
    segment.includes(":") ||
    WIN32_DEVICE_BASENAME.test(deviceBase)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseGeometryMetrics(value: unknown): PackageInspectionGeometryMetrics | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value) || !hasExactOwnKeys(value, PACKAGE_INSPECTION_GEOMETRY_KEYS)) return undefined;
  return isNonNegativeSafeInteger(value.triangles) && isNonNegativeSafeInteger(value.maxTextureDimension)
    ? { triangles: value.triangles, maxTextureDimension: value.maxTextureDimension }
    : undefined;
}

function parseTextureMetrics(value: unknown): PackageInspectionTextureMetrics | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value) || !hasExactOwnKeys(value, PACKAGE_INSPECTION_TEXTURE_KEYS)) return undefined;
  return isPositiveSafeInteger(value.width) && isPositiveSafeInteger(value.height)
    ? { width: value.width, height: value.height }
    : undefined;
}

function parseAudioMetrics(value: unknown): PackageInspectionAudioMetrics | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value) || !hasExactOwnKeys(value, PACKAGE_INSPECTION_AUDIO_KEYS)) return undefined;
  return (
    typeof value.durationSeconds === "number" &&
    Number.isFinite(value.durationSeconds) &&
    value.durationSeconds > 0 &&
    isPositiveSafeInteger(value.channels) &&
    isPositiveSafeInteger(value.sampleRate)
  )
    ? {
        durationSeconds: value.durationSeconds,
        channels: value.channels,
        sampleRate: value.sampleRate,
      }
    : undefined;
}

function packageIdentity(manifest: Manifest): string {
  return `${manifest.name}@${manifest.version}`;
}

function pathIsUnsafe(path: string): boolean {
  if (path === "" || path.includes("\\") || WIN32_FORBIDDEN_PATH_CHARACTERS.test(path)) return true;
  if (path.startsWith("/") || path.startsWith("//") || /^[A-Za-z]:/.test(path)) return true;
  if (
    path.split("/").some(
      (segment) =>
        segment === ".." ||
        segment === "." ||
        segment === "" ||
        segmentIsHostUnsafe(segment),
    )
  ) {
    return true;
  }
  let decoded = path;
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return true;
    }
  }
  return decoded !== path || decoded.split(/[\\/]/).some((segment) => segment === "..") || /^(?:\/|[A-Za-z]:|\\\\)/.test(decoded);
}
function extensionFor(path: string): string {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  return dot < 0 ? "" : basename.slice(dot).toLowerCase();
}

function failure(input: {
  ruleId: ValidationIssue["ruleId"];
  path: string;
  observed: unknown;
  allowed: unknown;
  remediation: string;
  manifest: Manifest;
  assetId?: string | undefined;
}): ValidationResult<Manifest> {
  return validationFailure([
    validationIssue({
      ...input,
      package: packageIdentity(input.manifest),
    }),
  ]);
}

function validatePackageInspectionUnchecked(input: unknown): ValidationResult<Manifest> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return validationFailure([
      validationIssue({
        ruleId: "E_SCHEMA_STRICT",
        path: "/",
        observed: input,
        allowed: "one package-inspection object with manifest, archive, and files",
        remediation: "Reject malformed extractor output before reading inspection fields.",
      }),
    ]);
  }

  const root = input as Record<string, unknown>;
  if (!hasExactOwnKeys(root, PACKAGE_INSPECTION_ROOT_KEYS)) {
    return strictBoundaryFailure("/", root, PACKAGE_INSPECTION_ROOT_KEYS);
  }
  if (
    root.archive === null ||
    typeof root.archive !== "object" ||
    Array.isArray(root.archive) ||
    !Array.isArray(root.files)
  ) {
    return validationFailure([
      validationIssue({
        ruleId: "E_SCHEMA_STRICT",
        path: !Array.isArray(root.files) ? "/files" : "/archive",
        observed: !Array.isArray(root.files) ? root.files : root.archive,
        allowed: "bounded files array and archive metadata object",
        remediation: "Reject missing or malformed extractor root fields before validation.",
      }),
    ]);
  }

  const archive = root.archive as Record<string, unknown>;
  if (!hasExactOwnKeys(archive, PACKAGE_INSPECTION_ARCHIVE_KEYS)) {
    return strictBoundaryFailure("/archive", archive, PACKAGE_INSPECTION_ARCHIVE_KEYS);
  }

  for (let index = 0; index < root.files.length; index += 1) {
    if (!Object.hasOwn(root.files, index)) {
      return validationFailure([
        validationIssue({
          ruleId: "E_SCHEMA_STRICT",
          path: `/files/${index}`,
          observed: "sparse file record",
          allowed: { exactProperties: PACKAGE_INSPECTION_FILE_KEYS },
          remediation: "Reject extractor output with missing file records before semantic validation.",
        }),
      ]);
    }
    const file = root.files[index];
    if (file === null || typeof file !== "object" || Array.isArray(file)) {
      return validationFailure([
        validationIssue({
          ruleId: "E_SCHEMA_STRICT",
          path: `/files/${index}`,
          observed: "malformed file record",
          allowed: { exactProperties: PACKAGE_INSPECTION_FILE_KEYS },
          remediation: "Reject malformed extractor file records before semantic validation.",
        }),
      ]);
    }
    const fileRecord = file as Record<string, unknown>;
    if (!hasExactOwnKeys(fileRecord, PACKAGE_INSPECTION_FILE_KEYS)) {
      return strictBoundaryFailure(`/files/${index}`, fileRecord, PACKAGE_INSPECTION_FILE_KEYS);
    }
  }

  const inspection = input as PackageInspection;
  const manifestResult = parseManifest(inspection.manifest);
  if (!manifestResult.ok) return manifestResult;
  const manifest = manifestResult.value;

  const archiveFields = [
    ["compressedBytes", inspection.archive.compressedBytes, 1],
    ["uncompressedBytes", inspection.archive.uncompressedBytes, 0],
    ["fileCount", inspection.archive.fileCount, 0],
    ["maxDepth", inspection.archive.maxDepth, 0],
  ] as const;
  for (const [field, value, minimum] of archiveFields) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      return failure({
        ruleId: "E_FILE_BUDGET",
        path: `/archive/${field}`,
        observed: value,
        allowed: `safe integer >= ${minimum}`,
        remediation: "Recompute archive metadata from the bounded extractor before validation.",
        manifest,
      });
    }
  }

  if (
    inspection.files.length > PACKAGE_LIMITS.maxFiles ||
    inspection.archive.fileCount > PACKAGE_LIMITS.maxFiles ||
    inspection.archive.fileCount !== inspection.files.length
  ) {
    return failure({
      ruleId: "E_FILE_BUDGET",
      path: "/archive/fileCount",
      observed: { declared: inspection.archive.fileCount, inspected: inspection.files.length },
      allowed: { exact: inspection.files.length, maximum: PACKAGE_LIMITS.maxFiles },
      remediation: "Reject the archive unless its bounded entry count exactly matches the inspected file inventory.",
      manifest,
    });
  }

  for (const [index, file] of inspection.files.entries()) {
    const path = `/files/${index}`;
    if (file === null || typeof file !== "object" || Array.isArray(file)) {
      return failure({
        ruleId: "E_SCHEMA_STRICT",
        path,
        observed: file,
        allowed: "one bounded plain file-inspection record",
        remediation: "Reject malformed extractor output before inspecting archive entry metadata.",
        manifest,
      });
    }
    if (file.kind !== "file" && file.kind !== "symlink") {
      return failure({
        ruleId: "E_SCHEMA_STRICT",
        path: `${path}/kind`,
        observed: file.kind,
        allowed: ["file", "symlink"],
        remediation: "Reject directories and unknown extractor entry kinds before validation.",
        manifest,
      });
    }
    if (typeof file.executable !== "boolean") {
      return failure({
        ruleId: "E_SCHEMA_STRICT",
        path: `${path}/executable`,
        observed: file.executable,
        allowed: "a boolean executable flag",
        remediation: "Reject malformed executable metadata before enforcing the no-code policy.",
        manifest,
      });
    }
    if (
      typeof file.path !== "string" ||
      file.path.length === 0 ||
      file.path.length > MAX_INSPECTION_PATH_LENGTH
    ) {
      return failure({
        ruleId: "E_PATH_POLICY",
        path: `${path}/path`,
        observed: file.path,
        allowed: `1 through ${MAX_INSPECTION_PATH_LENGTH} path characters`,
        remediation: "Reject oversized or non-string paths before normalization or pattern checks.",
        manifest,
      });
    }
    if (
      typeof file.declaredMime !== "string" ||
      file.declaredMime.length > MAX_INSPECTION_MIME_LENGTH ||
      typeof file.sniffedMime !== "string" ||
      file.sniffedMime.length > MAX_INSPECTION_MIME_LENGTH
    ) {
      return failure({
        ruleId: "E_MIME_MISMATCH",
        path: `${path}/declaredMime`,
        observed: { declared: file.declaredMime, sniffed: file.sniffedMime },
        allowed: `MIME strings no longer than ${MAX_INSPECTION_MIME_LENGTH} characters`,
        remediation: "Reject oversized MIME metadata before forbidden-type or matching checks.",
        manifest,
      });
    }
    if (typeof file.actualSha256 !== "string" || file.actualSha256.length !== 64) {
      return failure({
        ruleId: "E_HASH_MISMATCH",
        path: `${path}/actualSha256`,
        observed: file.actualSha256,
        allowed: "exactly 64 lowercase hexadecimal SHA-256 characters",
        remediation: "Reject malformed hashes before hexadecimal pattern validation.",
        manifest,
      });
    }
    if (
      file.codec !== undefined &&
      (typeof file.codec !== "string" || file.codec.length > MAX_INSPECTION_CODEC_LENGTH)
    ) {
      return failure({
        ruleId: "E_CODEC_UNSUPPORTED",
        path: `${path}/codec`,
        observed: file.codec,
        allowed: `a supported codec no longer than ${MAX_INSPECTION_CODEC_LENGTH} characters`,
        remediation: "Reject oversized codec metadata before allowlist lookup.",
        manifest,
      });
    }
    if (
      file.glbReferences !== undefined &&
      (!Array.isArray(file.glbReferences) ||
        file.glbReferences.length > MAX_INSPECTION_GLB_REFERENCES ||
        file.glbReferences.some(
          (reference) =>
            typeof reference !== "string" ||
            reference.length > MAX_INSPECTION_REFERENCE_LENGTH,
        ))
    ) {
      return failure({
        ruleId: "E_GLB_REFERENCE",
        path: `${path}/glbReferences`,
        observed: file.glbReferences,
        allowed: `at most ${MAX_INSPECTION_GLB_REFERENCES} references of ${MAX_INSPECTION_REFERENCE_LENGTH} characters`,
        remediation: "Reject oversized parser evidence before examining GLB references.",
        manifest,
      });
    }
    const geometryMetrics = parseGeometryMetrics(file.decodedGeometry);
    if (file.decodedGeometry !== undefined && geometryMetrics === undefined) {
      return failure({
        ruleId: "E_FILE_BUDGET",
        path: `${path}/decodedGeometry`,
        observed: file.decodedGeometry,
        allowed: { exactProperties: PACKAGE_INSPECTION_GEOMETRY_KEYS, nonNegativeSafeIntegers: true },
        remediation: "Record trusted decoded GLB geometry measurements before budget validation.",
        manifest,
      });
    }
    const textureMetrics = parseTextureMetrics(file.decodedTexture);
    if (file.decodedTexture !== undefined && textureMetrics === undefined) {
      return failure({
        ruleId: "E_FILE_BUDGET",
        path: `${path}/decodedTexture`,
        observed: file.decodedTexture,
        allowed: { exactProperties: PACKAGE_INSPECTION_TEXTURE_KEYS, positiveSafeIntegers: true },
        remediation: "Record trusted decoded texture dimensions before budget validation.",
        manifest,
      });
    }
    const audioMetrics = parseAudioMetrics(file.decodedAudio);
    if (file.decodedAudio !== undefined && audioMetrics === undefined) {
      return failure({
        ruleId: "E_FILE_BUDGET",
        path: `${path}/decodedAudio`,
        observed: file.decodedAudio,
        allowed: { exactProperties: PACKAGE_INSPECTION_AUDIO_KEYS, trustedPositiveAudioMetrics: true },
        remediation: "Record trusted decoded audio duration, channel, and sample-rate measurements.",
        manifest,
      });
    }
  }

  const caseFoldedPaths = new Map<string, string>();
  const win32UpcasedPaths = new Map<string, string>();
  for (const file of inspection.files) {
    const segments = file.path.normalize("NFC").split("/");
    const caseFolded = segments
      .map((segment) =>
        portableSegmentCollisionKey(caseFold(segment).normalize("NFC"))
      )
      .join("/");
    const win32Upcased = segments
      .map((segment) =>
        portableSegmentCollisionKey(segment.toUpperCase().normalize("NFC"))
      )
      .join("/");
    const existing = caseFoldedPaths.get(caseFolded) ?? win32UpcasedPaths.get(win32Upcased);
    if (existing !== undefined) {
      return failure({
        ruleId: "E_PATH_POLICY",
        path: "/files",
        observed: [existing, file.path],
        allowed: "exactly one member per host-portable NFC, case-folded, Win32-upcased, trailing-dot/space, device, and ADS collision key",
        remediation: "Remove duplicate members or rename colliding files so every host-portable normalized path is unique.",
        manifest,
      });
    }
    caseFoldedPaths.set(caseFolded, file.path);
    win32UpcasedPaths.set(win32Upcased, file.path);
  }
  for (const [index, file] of inspection.files.entries()) {
    const canonicalPath = file.path.normalize("NFC");
    if (pathIsUnsafe(canonicalPath)) {
      return failure({
        ruleId: "E_PATH_POLICY",
        path: `/files/${index}/path`,
        observed: file.path,
        allowed: "normalized relative non-symlink path without traversal, encoding, drive, UNC, Windows-forbidden or C0 control characters, trailing-dot/space, device, or ADS forms",
        remediation: "Replace the entry with a declared regular file beneath an allowed package root.",
        manifest,
      });
    }
  }

  let inspectedUncompressedBytes = 0;
  let inspectedCompressedBytes = 0;
  let inspectedMaxDepth = 0;
  for (const [index, file] of inspection.files.entries()) {
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      return failure({
        ruleId: "E_FILE_BUDGET",
        path: `/files/${index}/bytes`,
        observed: file.bytes,
        allowed: "non-negative safe integer",
        remediation: "Recompute each file size from extracted bytes before validation.",
        manifest,
      });
    }
    if (!Number.isSafeInteger(file.compressedBytes) || file.compressedBytes < 0) {
      return failure({
        ruleId: "E_FILE_BUDGET",
        path: `/files/${index}/compressedBytes`,
        observed: file.compressedBytes,
        allowed: "non-negative safe integer",
        remediation: "Recompute each compressed entry size from the bounded extractor.",
        manifest,
      });
    }
    const entryCompressionRatio =
      file.compressedBytes === 0 ? Number.POSITIVE_INFINITY : file.bytes / file.compressedBytes;
    if (
      file.bytes > 0 &&
      (file.compressedBytes === 0 || entryCompressionRatio > PACKAGE_LIMITS.maxCompressionRatio)
    ) {
      return failure({
        ruleId: "E_FILE_BUDGET",
        path: `/files/${index}/compressedBytes`,
        observed: { bytes: file.bytes, compressedBytes: file.compressedBytes, entryCompressionRatio },
        allowed: {
          minimumCompressedBytes: 1,
          maximumCompressionRatio: PACKAGE_LIMITS.maxCompressionRatio,
        },
        remediation: "Reject nonempty entries with zero compressed bytes or an excessive per-entry compression ratio.",
        manifest,
      });
    }
    inspectedCompressedBytes += file.compressedBytes;
    if (!Number.isSafeInteger(inspectedCompressedBytes)) {
      return failure({
        ruleId: "E_FILE_BUDGET",
        path: "/archive/compressedBytes",
        observed: inspectedCompressedBytes,
        allowed: `safe integer <= ${PACKAGE_LIMITS.maxDeclaredBytes}`,
        remediation: "Stop extraction when aggregate compressed bytes exceed the safe integer or package budget.",
        manifest,
      });
    }
    if (!Number.isSafeInteger(file.depth) || file.depth < 1) {
      return failure({
        ruleId: "E_FILE_BUDGET",
        path: `/files/${index}/depth`,
        observed: file.depth,
        allowed: `safe integer from 1 through ${PACKAGE_LIMITS.maxDepth}`,
        remediation: "Reject malformed archive depth metadata and inspect normalized relative paths again.",
        manifest,
      });
    }
    const derivedDepth = file.path.normalize("NFC").split("/").length;
    if (file.depth !== derivedDepth) {
      return failure({
        ruleId: "E_FILE_BUDGET",
        path: `/files/${index}/depth`,
        observed: { supplied: file.depth, derived: derivedDepth, path: file.path },
        allowed: derivedDepth,
        remediation: "Reject forged archive depth metadata and recompute each entry depth from its canonical safe path.",
        manifest,
      });
    }
    inspectedUncompressedBytes += file.bytes;
    if (!Number.isSafeInteger(inspectedUncompressedBytes)) {
      return failure({
        ruleId: "E_FILE_BUDGET",
        path: "/archive/uncompressedBytes",
        observed: inspectedUncompressedBytes,
        allowed: `safe integer <= ${PACKAGE_LIMITS.maxUncompressedBytes}`,
        remediation: "Stop extraction when aggregate uncompressed bytes exceed the safe integer or package budget.",
        manifest,
      });
    }
    inspectedMaxDepth = Math.max(inspectedMaxDepth, derivedDepth);
  }

  if (
    inspection.archive.compressedBytes !== manifest.totals.bytes ||
    inspectedCompressedBytes > inspection.archive.compressedBytes
  ) {
    return failure({
      ruleId: "E_FILE_BUDGET",
      path: "/archive/compressedBytes",
      observed: inspection.archive.compressedBytes,
      allowed: {
        exactDownloadBytes: manifest.totals.bytes,
        minimumEntryPayloadBytes: inspectedCompressedBytes,
      },
      remediation: "Use measured archive bytes for totals.bytes and reject entry payloads larger than their archive.",
      manifest,
    });
  }
  if (
    inspection.archive.uncompressedBytes !== inspectedUncompressedBytes ||
    inspection.archive.uncompressedBytes !== manifest.totals.uncompressedBytes
  ) {
    return failure({
      ruleId: "E_FILE_BUDGET",
      path: "/archive/uncompressedBytes",
      observed: inspection.archive.uncompressedBytes,
      allowed: inspectedUncompressedBytes,
      remediation: "Reject underreported archive totals and recompute them from every inspected file.",
      manifest,
    });
  }
  if (inspection.archive.maxDepth !== inspectedMaxDepth || inspection.archive.maxDepth !== manifest.totals.maxDepth) {
    return failure({
      ruleId: "E_FILE_BUDGET",
      path: "/archive/maxDepth",
      observed: inspection.archive.maxDepth,
      allowed: inspectedMaxDepth,
      remediation: "Reject underreported nesting and recompute maximum depth from normalized file paths.",
      manifest,
    });
  }

  const compressionRatio = inspection.archive.uncompressedBytes / inspection.archive.compressedBytes;
  if (
    inspection.archive.compressedBytes > PACKAGE_LIMITS.maxDeclaredBytes ||
    inspection.archive.uncompressedBytes > PACKAGE_LIMITS.maxUncompressedBytes ||
    inspection.archive.maxDepth > PACKAGE_LIMITS.maxDepth ||
    compressionRatio > PACKAGE_LIMITS.maxCompressionRatio ||
    compressionRatio > manifest.totals.maxCompressionRatio
  ) {
    return failure({
      ruleId: "E_FILE_BUDGET",
      path: "/archive",
      observed: { ...inspection.archive, compressionRatio },
      allowed: {
        ...PACKAGE_LIMITS,
        declaredMaxCompressionRatio: manifest.totals.maxCompressionRatio,
      },
      remediation: "Reduce archive bytes, nesting depth, or compression ratio before validation.",
      manifest,
    });
  }


  const declaredAssets = new Map(manifest.assets.map((asset) => [asset.path, asset]));
  const assetIndexesByPath = new Map(manifest.assets.map((asset, index) => [asset.path, index]));
  const assetContracts = deriveAssetContracts(manifest);
  if (manifest.kind === "music") {
    const assetsById = new Map(manifest.assets.map((asset) => [asset.assetId, asset]));
    for (const [entryIndex, entry] of manifest.entries.entries()) {
      const referencedAssetIds = new Set(entry.tracks.map((track) => track.assetId));
      const referencedBytes = [...referencedAssetIds].reduce(
        (total, assetId) => total + (assetsById.get(assetId)?.bytes ?? 0),
        0,
      );
      if (referencedAssetIds.size > entry.maxTracks) {
        return failure({
          ruleId: "E_FILE_BUDGET",
          path: `/entries/${entryIndex}/maxTracks`,
          observed: referencedAssetIds.size,
          allowed: entry.maxTracks,
          remediation: "Raise the reviewed entry ceiling or remove unique track asset references.",
          manifest,
        });
      }
      if (referencedBytes > entry.maxBytes) {
        return failure({
          ruleId: "E_FILE_BUDGET",
          path: `/entries/${entryIndex}/maxBytes`,
          observed: referencedBytes,
          allowed: entry.maxBytes,
          remediation: "Raise the reviewed entry ceiling or reduce bytes across uniquely referenced track assets.",
          manifest,
        });
      }
    }
  }
  for (const [index, file] of inspection.files.entries()) {
    const path = `/files/${index}`;
    const asset = declaredAssets.get(file.path);

    if (file.kind === "symlink" || pathIsUnsafe(file.path)) {
      return failure({
        ruleId: "E_PATH_POLICY",
        path: `${path}/path`,
        observed: file.path,
        allowed: "normalized relative non-symlink path without traversal, encoding, drive, UNC, or NUL forms",
        remediation: "Replace the entry with a declared regular file beneath an allowed package root.",
        manifest,
        assetId: asset?.assetId,
      });
    }
    if (file.executable || FORBIDDEN_EXTENSION.test(file.path) || FORBIDDEN_MIME.test(file.declaredMime)) {
      return failure({
        ruleId: "E_CODE_FORBIDDEN",
        path,
        observed: { path: file.path, declaredMime: file.declaredMime, executable: file.executable },
        allowed: "declarative runtime data only; no JS, WASM, HTML, CSS, binaries, or executable mode",
        remediation: "Remove executable content and express behavior through the closed declarative protocol.",
        manifest,
        assetId: asset?.assetId,
      });
    }
    if (asset === undefined) {
      return failure({
        ruleId: "E_PATH_POLICY",
        path: `${path}/path`,
        observed: file.path,
        allowed: [...declaredAssets.keys()].sort(),
        remediation: "Remove undeclared files or add the exact safe file to the flat manifest inventory.",
        manifest,
      });
    }
    if (asset.provenance.evidenceStatus !== "verified") {
      return failure({
        ruleId: "E_LICENSE_POLICY",
        path: `${path}/provenance/evidenceStatus`,
        observed: asset.provenance.evidenceStatus,
        allowed: "verified",
        remediation: "Block new installation until authoritative license and provenance evidence is verified.",
        manifest,
        assetId: asset.assetId,
      });
    }

    const assetIndex = assetIndexesByPath.get(asset.path) ?? -1;
    const transformation = asset.provenance.transformation;
    const expectedConfigSha256 = canonicalConfigSha256(transformation.config as Record<string, JsonConfigValue>);
    if (transformation.configSha256 !== expectedConfigSha256) {
      return failure({
        ruleId: "E_HASH_MISMATCH",
        path: `/assets/${assetIndex}/provenance/transformation/configSha256`,
        observed: transformation.configSha256,
        allowed: expectedConfigSha256,
        remediation: "Canonicalize provenance transformation config deterministically and record its SHA-256.",
        manifest,
        assetId: asset.assetId,
      });
    }

    const assetContract = assetContracts.get(asset.assetId);
    if (assetContract !== undefined && assetContract.requiredMimeFamilies.length > 1) {
      return failure({
        ruleId: "E_MIME_MISMATCH",
        path: `/assets/${assetIndex}/mime`,
        observed: {
          mime: asset.mime,
          requiredMimeFamilies: assetContract.requiredMimeFamilies,
          semanticRoles: assetContract.semanticRoles,
          references: assetContract.referencePaths,
        },
        allowed: "one asset referenced only by semantic roles from one MIME family",
        remediation: "Split incompatible semantic references across assets from their required MIME families.",
        manifest,
        assetId: asset.assetId,
      });
    }
    if (
      assetContract !== undefined &&
      !asset.mime.startsWith(`${assetContract.mimeFamily}/`)
    ) {
      return failure({
        ruleId: "E_MIME_MISMATCH",
        path: `/assets/${assetIndex}/mime`,
        observed: {
          mime: asset.mime,
          semanticRoles: assetContract.semanticRoles,
          references: assetContract.referencePaths,
        },
        allowed: `${assetContract.mimeFamily}/*`,
        remediation: "Publish the semantic role with an asset from its frozen allowed MIME family.",
        manifest,
        assetId: asset.assetId,
      });
    }
    if (assetContract !== undefined && asset.role !== assetContract.role) {
      return failure({
        ruleId: "E_FILE_BUDGET",
        path: `/assets/${assetIndex}/role`,
        observed: { declared: asset.role, derived: assetContract.role, references: assetContract.referencePaths },
        allowed: assetContract.role,
        remediation: "Derive asset role from semantic manifest references and reject publisher-supplied conflicts.",
        manifest,
        assetId: asset.assetId,
      });
    }

    if (file.bytes !== asset.bytes) {
      return failure({
        ruleId: "E_FILE_BUDGET",
        path: `${path}/bytes`,
        observed: file.bytes,
        allowed: asset.bytes,
        remediation: "Reject the archive and publish bytes whose inspected size exactly matches the reviewed inventory.",
        manifest,
        assetId: asset.assetId,
      });
    }
    const roleLimit =
      assetContract?.maxFileBytes ??
      (manifest.kind === "level" ? CONTENT_BUDGETS.level.maxFileBytes : PACKAGE_LIMITS.maxFileBytes);
    if (file.bytes > roleLimit || file.depth > PACKAGE_LIMITS.maxDepth) {
      return failure({
        ruleId: "E_FILE_BUDGET",
        path: `${path}/bytes`,
        observed: file.bytes,
        allowed: roleLimit,
        remediation: "Optimize the asset to the frozen semantically derived role byte budget and rebuild deterministic output.",
        manifest,
        assetId: asset.assetId,
      });
    }
    if (
      assetContract?.declaredMaxBytes !== undefined &&
      (asset.bytes > assetContract.declaredMaxBytes ||
        assetContract.declaredMaxBytes > assetContract.maxDeclaredBytes)
    ) {
      return failure({
        ruleId: "E_FILE_BUDGET",
        path: `${path}/bytes`,
        observed: {
          actual: file.bytes,
          declared: asset.bytes,
          semanticDeclared: assetContract.declaredMaxBytes,
          semanticDeclaredPath: assetContract.declaredMaxBytesPath,
        },
        allowed: {
          actualAtMostDeclared: asset.bytes,
          declaredAtMostSemantic: assetContract.declaredMaxBytes,
          semanticAtMostFrozen: assetContract.maxDeclaredBytes,
        },
        remediation: "Enforce actual file bytes <= declared inventory bytes <= semantic declared budget <= frozen role budget.",
        manifest,
        assetId: asset.assetId,
      });
    }
    const requiresCodecEvidence = file.declaredMime.startsWith("audio/");
    if (
      (requiresCodecEvidence && file.codec === undefined) ||
      (file.codec !== undefined &&
        (!Object.hasOwn(SUPPORTED_CODEC, file.codec) || file.codec !== file.declaredMime))
    ) {
      return failure({
        ruleId: "E_CODEC_UNSUPPORTED",
        path: `${path}/codec`,
        observed: file.codec,
        allowed: requiresCodecEvidence ? file.declaredMime : [undefined, file.declaredMime],
        remediation: "Parse applicable media and record its supported codec before accepting the inspection.",
        manifest,
        assetId: asset?.assetId,
      });
    }
    if (
      file.declaredMime === "model/gltf-binary" &&
      (!Array.isArray(file.glbReferences) || file.glbReferences.length > 0)
    ) {
      return failure({
        ruleId: "E_GLB_REFERENCE",
        path: `${path}/glbReferences`,
        observed: file.glbReferences,
        allowed: [],
        remediation: "Parse the GLB and record an empty URI reference list only after every resource is embedded.",
        manifest,
        assetId: asset?.assetId,
      });
    }
    const geometryMetrics = parseGeometryMetrics(file.decodedGeometry);
    if (file.declaredMime === "model/gltf-binary") {
      if (geometryMetrics === undefined) {
        return failure({
          ruleId: "E_FILE_BUDGET",
          path: `${path}/decodedGeometry`,
          observed: file.decodedGeometry,
          allowed: "trusted decoded GLB geometry metrics",
          remediation: "Parse model bytes and record decoded geometry before enforcing semantic budgets.",
          manifest,
          assetId: asset.assetId,
        });
      }
      const triangleLimit =
        assetContract?.declaredMaxTriangles ?? assetContract?.maxTriangles;
      if (
        triangleLimit !== undefined &&
        (geometryMetrics.triangles > triangleLimit ||
          (assetContract?.declaredMaxTriangles !== undefined &&
            assetContract.maxTriangles !== undefined &&
            assetContract.declaredMaxTriangles > assetContract.maxTriangles))
      ) {
        return failure({
          ruleId: "E_FILE_BUDGET",
          path: `${path}/decodedGeometry`,
          observed: {
            triangles: geometryMetrics.triangles,
            declared: assetContract?.declaredMaxTriangles,
            declaredPath: assetContract?.declaredMaxTrianglesPath,
          },
          allowed: {
            actualAtMostDeclared: triangleLimit,
            declaredAtMostFrozen: assetContract?.maxTriangles,
          },
          remediation: "Enforce decoded model triangles <= semantic declaration <= frozen role triangle budget.",
          manifest,
          assetId: asset.assetId,
        });
      }
      if (
        assetContract?.maxTextureDimension !== undefined &&
        geometryMetrics.maxTextureDimension > assetContract.maxTextureDimension
      ) {
        return failure({
          ruleId: "E_FILE_BUDGET",
          path: `${path}/decodedGeometry`,
          observed: geometryMetrics,
          allowed: { maxTextureDimension: assetContract.maxTextureDimension },
          remediation: "Enforce decoded embedded texture dimensions against the frozen role texture budget.",
          manifest,
          assetId: asset.assetId,
        });
      }
    } else if (file.decodedGeometry !== undefined) {
      return failure({
        ruleId: "E_FILE_BUDGET",
        path: `${path}/decodedGeometry`,
        observed: file.decodedGeometry,
        allowed: undefined,
        remediation: "Only GLB assets may carry decoded geometry inspection evidence.",
        manifest,
        assetId: asset.assetId,
      });
    }

    const textureMetrics = parseTextureMetrics(file.decodedTexture);
    if (file.declaredMime.startsWith("image/")) {
      if (textureMetrics === undefined) {
        return failure({
          ruleId: "E_FILE_BUDGET",
          path: `${path}/decodedTexture`,
          observed: file.decodedTexture,
          allowed: "trusted decoded texture dimensions",
          remediation: "Decode image bytes and record texture dimensions before enforcing frozen budgets.",
          manifest,
          assetId: asset.assetId,
        });
      }
      const decodedTextureMaxDimension = Math.max(textureMetrics.width, textureMetrics.height);
      const textureLimit = assetContract?.maxTextureDimension ?? CONTENT_BUDGETS.level.maxTextureDimension;
      if (decodedTextureMaxDimension > textureLimit) {
        return failure({
          ruleId: "E_FILE_BUDGET",
          path: `${path}/decodedTexture`,
          observed: textureMetrics,
          allowed: { maxTextureDimension: textureLimit },
          remediation: "Enforce decoded texture dimensions against the frozen role texture budget.",
          manifest,
          assetId: asset.assetId,
        });
      }
    } else if (file.decodedTexture !== undefined) {
      return failure({
        ruleId: "E_FILE_BUDGET",
        path: `${path}/decodedTexture`,
        observed: file.decodedTexture,
        allowed: undefined,
        remediation: "Only image assets may carry decoded texture inspection evidence.",
        manifest,
        assetId: asset.assetId,
      });
    }

    const audioMetrics = parseAudioMetrics(file.decodedAudio);
    if (requiresCodecEvidence) {
      if (audioMetrics === undefined) {
        return failure({
          ruleId: "E_FILE_BUDGET",
          path: `${path}/decodedAudio`,
          observed: file.decodedAudio,
          allowed: "trusted decoded audio duration, channel, and sample-rate metrics",
          remediation: "Decode audio bytes and record playback metrics before enforcing semantic budgets.",
          manifest,
          assetId: asset.assetId,
        });
      }
      const declaredAudio = assetContract?.declaredAudio;
      const durationLimit = declaredAudio?.durationSeconds ?? CONTENT_BUDGETS.music.maxTrackSeconds;
      const channelLimit = declaredAudio?.channels ?? CONTENT_BUDGETS.music.maxChannels;
      const sampleRateLimit = declaredAudio?.sampleRate ?? CONTENT_BUDGETS.music.maxSampleRate;
      const declaredAudioFacts = assetContract?.declaredAudioFacts ?? [];
      const channelsMatchDeclarations = declaredAudioFacts.every(
        (declared) => audioMetrics.channels === declared.channels,
      );
      const sampleRateMatchesDeclarations = declaredAudioFacts.every(
        (declared) => audioMetrics.sampleRate === declared.sampleRate,
      );
      if (
        !channelsMatchDeclarations ||
        !sampleRateMatchesDeclarations ||
        audioMetrics.durationSeconds > durationLimit ||
        audioMetrics.channels > channelLimit ||
        audioMetrics.sampleRate > sampleRateLimit ||
        durationLimit > CONTENT_BUDGETS.music.maxTrackSeconds ||
        channelLimit > CONTENT_BUDGETS.music.maxChannels ||
        sampleRateLimit > CONTENT_BUDGETS.music.maxSampleRate
      ) {
        return failure({
          ruleId: "E_FILE_BUDGET",
          path: `${path}/decodedAudio`,
          observed: {
            decoded: audioMetrics,
            declaredFacts: declaredAudioFacts.map(({ channels, sampleRate }) => ({
              channels,
              sampleRate,
            })),
          },
          allowed: {
            durationSecondsAtMost: durationLimit,
            channelsExactly: declaredAudioFacts.map((declared) => declared.channels),
            sampleRatesExactly: declaredAudioFacts.map((declared) => declared.sampleRate),
            frozen: {
              durationSeconds: CONTENT_BUDGETS.music.maxTrackSeconds,
              channels: CONTENT_BUDGETS.music.maxChannels,
              sampleRate: CONTENT_BUDGETS.music.maxSampleRate,
            },
          },
          remediation: "Match decoded channel and sample-rate facts to every track declaration and keep audio within frozen budgets.",
          manifest,
          assetId: asset.assetId,
        });
      }
    } else if (file.decodedAudio !== undefined) {
      return failure({
        ruleId: "E_FILE_BUDGET",
        path: `${path}/decodedAudio`,
        observed: file.decodedAudio,
        allowed: undefined,
        remediation: "Only audio assets may carry decoded audio inspection evidence.",
        manifest,
        assetId: asset.assetId,
      });
    }

    const expectedMime = MIME_BY_EXTENSION[extensionFor(file.path)];
    if (
      asset.mime !== file.declaredMime ||
      file.declaredMime !== file.sniffedMime ||
      expectedMime === undefined ||
      expectedMime !== file.declaredMime
    ) {
      return failure({
        ruleId: "E_MIME_MISMATCH",
        path: `${path}/declaredMime`,
        observed: {
          manifest: asset.mime,
          declared: file.declaredMime,
          sniffed: file.sniffedMime,
          extension: expectedMime,
        },
        allowed: "matching manifest, extension, declared MIME, and sniffed/parsed content",
        remediation: "Correct the manifest, extension, and declaration or rebuild the asset in the declared format.",
        manifest,
        assetId: asset.assetId,
      });
    }
    if (!LOWER_SHA256.test(file.actualSha256) || asset === undefined || file.actualSha256 !== asset.sha256 || asset.provenance.outputSha256 !== asset.sha256) {
      return failure({
        ruleId: "E_HASH_MISMATCH",
        path: `${path}/actualSha256`,
        observed: file.actualSha256,
        allowed: asset?.sha256 ?? "a declared lowercase SHA-256",
        remediation: "Delete staged bytes, rebuild the immutable file, and update reviewed hashes together.",
        manifest,
        assetId: asset?.assetId,
      });
    }
  }

  const actualPaths = new Set(inspection.files.map((file) => file.path));
  const unknown = inspection.files.find((file) => !declaredAssets.has(file.path));
  const missing = manifest.assets.find((asset) => !actualPaths.has(asset.path));
  if (
    unknown !== undefined ||
    missing !== undefined ||
    actualPaths.size !== inspection.files.length ||
    inspection.files.length !== manifest.assets.length ||
    inspection.archive.fileCount !== inspection.files.length
  ) {
    return failure({
      ruleId: "E_PATH_POLICY",
      path: "/files",
      observed: unknown?.path ?? missing?.path ?? inspection.archive.fileCount,
      allowed: [...declaredAssets.keys()].sort(),
      remediation: "Make the archive file set exactly match the flat manifest asset inventory.",
      manifest,
      assetId: missing?.assetId,
    });
  }


  return validationSuccess(manifest);
}

export function validatePackageInspection(input: unknown): ValidationResult<Manifest> {
  try {
    const oversizedFileCount = oversizedFileInventory(input);
    if (oversizedFileCount !== undefined) {
      return validationFailure([
        validationIssue({
          ruleId: "E_FILE_BUDGET",
          path: "/archive/fileCount",
          observed: oversizedFileCount,
          allowed: `at most ${PACKAGE_LIMITS.maxFiles} extracted files`,
          remediation: "Reject the archive from aggregate metadata before traversing any file entry.",
        }),
      ]);
    }
    const snapshot = snapshotPlainData(input, PACKAGE_INSPECTION_SNAPSHOT_LIMITS);
    if (!snapshot.ok) {
      return validationFailure([
        validationIssue({
          ruleId: "E_SCHEMA_STRICT",
          path: "/",
          observed: { reason: snapshot.reason },
          allowed: "plain bounded extractor output",
          remediation: "Reject accessor-backed or mutable hostile extractor data before inspection.",
        }),
      ]);
    }
    return validatePackageInspectionUnchecked(snapshot.value);
  } catch {
    return validationFailure([
      validationIssue({
        ruleId: "E_SCHEMA_STRICT",
        path: "/",
        observed: "uninspectable package-inspection input",
        allowed: "plain bounded extractor output",
        remediation: "Reject accessor-backed or mutable hostile extractor data before inspection.",
      }),
    ]);
  }
}

export { formatValidationResult };
