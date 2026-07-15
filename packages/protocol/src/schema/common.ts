import { z } from "zod/mini";

import { CONTENT_KINDS, PACKAGE_LIMITS, PROTOCOL_SCHEMA_VERSION } from "../version.js";
import { boundedArray, recordPreflight } from "./preflight.js";

const SEMVER_NUMERIC_IDENTIFIER = "(?:0|[1-9]\\d*)";
const SEMVER_PRERELEASE_IDENTIFIER =
  `(?:${SEMVER_NUMERIC_IDENTIFIER}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER_TOKEN =
  `${SEMVER_NUMERIC_IDENTIFIER}\\.${SEMVER_NUMERIC_IDENTIFIER}\\.${SEMVER_NUMERIC_IDENTIFIER}` +
  `(?:-${SEMVER_PRERELEASE_IDENTIFIER}(?:\\.${SEMVER_PRERELEASE_IDENTIFIER})*)?` +
  "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
const EXACT_SEMVER = new RegExp(`^${SEMVER_TOKEN}$`);
const ENGINE_RANGE_OPERATOR = "(?:<=|>=|<|>|=|~|\\^)?";
const ENGINE_RANGE = new RegExp(
  `^${ENGINE_RANGE_OPERATOR}${SEMVER_TOKEN}` +
    `(?:\\s+${ENGINE_RANGE_OPERATOR}${SEMVER_TOKEN})*$`,
);
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SHA_256 = /^[a-f0-9]{64}$/;
const NPM_SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/;
const HTTP_URL = /^[Hh][Tt][Tt][Pp][Ss]?:\/\/(?![^/?#]*@)/;
const HTTPS_URL = /^[Hh][Tt][Tt][Pp][Ss]:\/\/(?![^/?#]*@)/;
const SAFE_PATH =
  /^(?!\/)(?![A-Za-z]:)(?!\\\\)(?!\.{1,2}(?:\/|$))(?![\s\S]*\/\.{1,2}(?:\/|$))(?![\s\S]*[<>:"|?*\u0000-\u001F])(?![\s\S]*%)[^/\\]+(?:\/[^/\\]+)*$/;
const WIN32_DEVICE_PATH_SEGMENT =
  /^(?:aux|con|conin\$|conout\$|nul|prn|com[1-9\u00B9\u00B2\u00B3]|lpt[1-9\u00B9\u00B2\u00B3])(?:\.|$)/i;
const CATALOG_RESOURCE_PATH =
  /^(?![\s\S]*[^A-Za-z0-9._@+\/-])(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9@_+-][A-Za-z0-9._@+-]*(?:\/[A-Za-z0-9@_+-][A-Za-z0-9._@+-]*)*$/;
const STABLE_ID = /^(?!__proto__$)[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const UTC_TIMESTAMP =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.000)?Z$/;

// JSON Schema can represent the separator, encoding, and control-character
// path pattern above. Host-specific extraction aliases and Unicode
// normalization remain runtime parser guarantees because JSON Schema has no
// portable-filesystem or NFC keywords.
function isNfcNormalized(value: string): boolean {
  return value === value.normalize("NFC");
}

function isHostPortablePathSegment(segment: string): boolean {
  if (segment.endsWith(".") || segment.endsWith(" ")) return false;
  if (segment.includes(":")) return false;
  return !WIN32_DEVICE_PATH_SEGMENT.test(segment);
}

function hasHostPortablePathSegments(value: string): boolean {
  for (const segment of value.split("/")) {
    if (!isHostPortablePathSegment(segment)) return false;
  }
  return true;
}

function isCredentialFreeNetworkUrl(value: string, httpsOnly: boolean): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || (!httpsOnly && url.protocol === "http:")) &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function isCalendarValidUtcTimestamp(value: string): boolean {
  const match = UTC_TIMESTAMP.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(hour, minute, second, 0);
  return (
    Number.isFinite(instant.getTime()) &&
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day &&
    instant.getUTCHours() === hour &&
    instant.getUTCMinutes() === minute &&
    instant.getUTCSeconds() === second
  );
}

export const ExactSemverSchema = z.pipe(
  z.string().check(z.maxLength(256)),
  z.string().check(z.regex(EXACT_SEMVER, "Expected an exact semantic version")),
).check(z.meta({ maxLength: 256 }));
export const EngineRangeSchema = z.pipe(
  z.string().check(z.maxLength(512)),
  z.string().check(z.regex(ENGINE_RANGE, "Expected a supported engine semantic-version range")),
).check(z.meta({ maxLength: 512 }));
export const PackageNameSchema = z.pipe(
  z.string().check(z.maxLength(214)),
  z.string().check(z.regex(PACKAGE_NAME, "Expected an exact npm package name")),
).check(z.meta({ maxLength: 214 }));
export const Sha256Schema = z.pipe(
  z.string().check(z.minLength(64)).check(z.maxLength(64)),
  z.string().check(z.regex(SHA_256, "Expected lowercase hexadecimal SHA-256")),
).check(z.meta({ maxLength: 64, minLength: 64 }));
export const TimestampSchema = z.pipe(
  z.string().check(z.minLength(20)).check(z.maxLength(24)),
  z
    .string()
    .check(z.regex(UTC_TIMESTAMP, "Expected an exact UTC timestamp"))
    .check(z.refine(isCalendarValidUtcTimestamp, "Expected a calendar-valid UTC timestamp")),
).check(z.meta({ maxLength: 24, minLength: 20 }));
export const StableIdSchema = z.pipe(
  z.string().check(z.maxLength(128)),
  z.string().check(z.regex(STABLE_ID, "Expected a deterministic stable identifier")),
).check(z.meta({ maxLength: 128 }));
export const CATALOG_RESOURCE_BASE_PATH = "./catalog/" as const;
export const CatalogResourceBasePathSchema = z.literal(CATALOG_RESOURCE_BASE_PATH);
export const CatalogResourcePathSchema = z.pipe(
  z.string().check(z.minLength(1)).check(z.maxLength(512)),
  z.string().check(
    z.regex(
      CATALOG_RESOURCE_PATH,
      "Expected a canonical ASCII path relative to the catalog resource base",
    ),
  ),
).check(z.meta({ maxLength: 512, minLength: 1 }));
export const SafeRelativePathSchema = z.pipe(
  z.string().check(z.minLength(1)).check(z.maxLength(512)),
  z
    .string()
    .check(z.regex(SAFE_PATH, "Expected a normalized safe relative path"))
    .check(z.refine(hasHostPortablePathSegments, "Expected a host-portable safe relative path"))
    .check(z.refine(isNfcNormalized, "Expected an NFC-normalized safe relative path")),
).check(z.meta({ maxLength: 512, minLength: 1 }));
export const ContentKindSchema = z.enum(CONTENT_KINDS);
export const ProtocolVersionSchema = z.literal(PROTOCOL_SCHEMA_VERSION);
export const IntegritySchema = z.pipe(
  z.string().check(z.minLength(95)).check(z.maxLength(95)),
  z.string().check(z.regex(NPM_SHA512_INTEGRITY, "Expected canonical npm sha512 integrity")),
).check(z.meta({ maxLength: 95, minLength: 95 }));

export const HttpUrlSchema = z.pipe(
  z.string().check(z.maxLength(2_048)),
  z
    .string()
    .check(z.regex(HTTP_URL, "Expected an HTTP(S) URL without credentials"))
    .check(z.url())
    .check(
      z.refine(
        (value) => isCredentialFreeNetworkUrl(value, false),
        "Expected an HTTP(S) URL without credentials",
      ),
    ),
).check(z.meta({ maxLength: 2_048 }));

export const HttpsUrlSchema = z.pipe(
  z.string().check(z.maxLength(2_048)),
  z
    .string()
    .check(z.regex(HTTPS_URL, "Expected an HTTPS URL without credentials"))
    .check(z.url())
    .check(
      z.refine(
        (value) => isCredentialFreeNetworkUrl(value, true),
        "Expected an HTTPS URL without credentials",
      ),
    ),
).check(z.meta({ maxLength: 2_048 }));

export const PackageLicenseSchema = z.enum([
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
]);

export const RuntimeMimeSchema = z.enum([
  "application/json",
  "audio/ogg",
  "audio/wav",
  "image/avif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "model/gltf-binary",
]);

export const LocalizedTextSchema = z.strictObject({
  default: z.string().check(z.minLength(1)).check(z.maxLength(2_000)),
  translations: z
    .pipe(
      recordPreflight(100),
      z.record(
        z.pipe(
          z.string().check(z.maxLength(35)),
          z.string().check(z.regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)),
        ).check(z.meta({ maxLength: 35 })),
        z.string().check(z.minLength(1)).check(z.maxLength(2_000)),
      ),
    )
    .check(z.meta({ maxProperties: 100 })),
});

export const DisplayMetadataSchema = z.strictObject({
  title: LocalizedTextSchema,
  description: LocalizedTextSchema,
});

export const ManifestMetadataSchema = z.strictObject({
  title: LocalizedTextSchema,
  description: LocalizedTextSchema,
  author: z.strictObject({ name: z.string().check(z.minLength(1)).check(z.maxLength(120)), url: HttpUrlSchema }),
  homepage: HttpUrlSchema,
  repository: HttpUrlSchema,
  screenshots: boundedArray(SafeRelativePathSchema, 12),
  icon: SafeRelativePathSchema,
  tags: boundedArray(z.pipe(
    z.string().check(z.maxLength(32)),
    z.string().check(z.regex(/^[a-z0-9][a-z0-9-]{0,31}$/)),
  ).check(z.meta({ maxLength: 32 })), 24),
});

export const PackageRefSchema = z.strictObject({
  name: PackageNameSchema,
  version: ExactSemverSchema,
  kind: ContentKindSchema,
  engine: EngineRangeSchema,
  integrity: IntegritySchema,
  manifestSha256: Sha256Schema,
  catalogEntryId: StableIdSchema,
});

export const TransformationSchema = z.strictObject({
  recipe: z.string().check(z.minLength(1)).check(z.maxLength(500)),
  tool: z.strictObject({
    name: z.string().check(z.minLength(1)).check(z.maxLength(120)),
    version: ExactSemverSchema,
  }),
  config: z
    .pipe(
      recordPreflight(256),
      z.record(
        z.string()
          .check(z.minLength(1))
          .check(z.maxLength(80))
          .check(z.regex(/^(?!__proto__$)/)),
        z.union([z.string().check(z.maxLength(500)), z.number(), z.boolean(), z.null()]),
      ),
    )
    .check(z.meta({ maxProperties: 256 })),
  configSha256: Sha256Schema,
});

export const ProvenanceSchema = z.strictObject({
  creator: z.string().check(z.minLength(1)).check(z.maxLength(200)),
  source: HttpUrlSchema,
  acquisition: z.string().check(z.minLength(1)).check(z.maxLength(500)),
  sourceArtifactSha256: Sha256Schema,
  attribution: z.string().check(z.minLength(1)).check(z.maxLength(2_000)),
  modifications: boundedArray(z.string().check(z.minLength(1)).check(z.maxLength(500)), 100),
  transformation: TransformationSchema,
  outputSha256: Sha256Schema,
  reviewer: z.string().check(z.minLength(1)).check(z.maxLength(200)),
  reviewedAt: TimestampSchema,
  evidenceStatus: z.enum(["verified", "incomplete", "disputed", "withdrawn"]),
  notes: z.string().check(z.maxLength(2_000)),
  replacement: z.nullable(z.string().check(z.minLength(1)).check(z.maxLength(500))),
});

export const AssetRecordSchema = z.strictObject({
  assetId: StableIdSchema,
  path: SafeRelativePathSchema,
  mime: RuntimeMimeSchema,
  bytes: z.number().check(z.int()).check(z.nonnegative()).check(z.maximum(PACKAGE_LIMITS.maxFileBytes)),
  sha256: Sha256Schema,
  role: z.string().check(z.minLength(1)).check(z.maxLength(80)),
  license: PackageLicenseSchema,
  licenseUrl: HttpUrlSchema,
  capturedLicenseSha256: Sha256Schema,
  provenance: ProvenanceSchema,
});

export const PackageTotalsSchema = z.strictObject({
  bytes: z.number().check(z.int()).check(z.nonnegative()).check(z.maximum(PACKAGE_LIMITS.maxDeclaredBytes)),
  fileCount: z.number().check(z.int()).check(z.nonnegative()).check(z.maximum(PACKAGE_LIMITS.maxFiles)),
  uncompressedBytes: z.number().check(z.int()).check(z.nonnegative()).check(z.maximum(PACKAGE_LIMITS.maxUncompressedBytes)),
  maxDepth: z.number().check(z.int()).check(z.nonnegative()).check(z.maximum(PACKAGE_LIMITS.maxDepth)),
  maxCompressionRatio: z.number().check(z.nonnegative()).check(z.maximum(PACKAGE_LIMITS.maxCompressionRatio)),
});

export const ImmutableFileSchema = z.strictObject({
  path: SafeRelativePathSchema,
  resourcePath: CatalogResourcePathSchema,
  mime: RuntimeMimeSchema,
  bytes: z.number().check(z.int()).check(z.nonnegative()).check(z.maximum(PACKAGE_LIMITS.maxFileBytes)),
  sha256: Sha256Schema,
});
