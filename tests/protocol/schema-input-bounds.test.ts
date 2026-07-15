import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod/mini";

import { describe, expect, it } from "vitest";

import {
  CharacterEntrySchema,
  EngineRangeSchema,
  ExactSemverSchema,
  HttpUrlSchema,
  IntegritySchema,
  LocalizedTextSchema,
  MusicEntrySchema,
  PackageNameSchema,
  TimestampSchema,
  TransformationSchema,
  validateCatalogFreshness,
} from "../../packages/protocol/src/browser.js";
import { renderSchemaArtifacts } from "../../packages/protocol/src/schema/json-schema.js";
import {
  MANIFEST_INPUT_SNAPSHOT_LIMITS,
  parseManifest,
  visitLocalAssetReferences,
  type Manifest,
} from "../../packages/protocol/src/schema/manifests.js";
import {
  boundedArray,
  recordPreflight,
  snapshotPlainData,
} from "../../packages/protocol/src/schema/preflight.js";
import { MAX_VALIDATION_ISSUES } from "../../packages/protocol/src/errors.js";
import { PACKAGE_INSPECTION_SNAPSHOT_LIMITS } from "../../packages/protocol/src/validation/package-inspection.js";
import { PACKAGE_LIMITS } from "../../packages/protocol/src/version.js";

const GOLDEN_DIR = join(process.cwd(), "tests", "fixtures", "protocol", "golden");
const SHA = "a".repeat(64);

async function goldenManifest(kind: "character" | "music" | "object-pack"): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(GOLDEN_DIR, `${kind}.json`), "utf8")) as Record<string, unknown>;
}

async function goldenEntry(kind: "character" | "music"): Promise<Record<string, unknown>> {
  const manifest = (await goldenManifest(kind)) as {
    entries: Array<Record<string, unknown>>;
  };
  const entry = manifest.entries[0];
  if (entry === undefined) throw new Error(`Golden ${kind} fixture requires an entry`);
  return entry;
}

function containsValidationKeyword(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsValidationKeyword(item));
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.pattern === "string" ||
    record.format === "uri" ||
    Object.values(record).some((child) => containsValidationKeyword(child))
  );
}

function findMaxLength(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const maximum = findMaxLength(item);
      if (maximum !== undefined) return maximum;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.maxLength === "number") return record.maxLength;
  for (const child of Object.values(record)) {
    const maximum = findMaxLength(child);
    if (maximum !== undefined) return maximum;
  }
  return undefined;
}

function collectValidationKeywords(
  value: unknown,
  output: Array<Record<string, unknown>> = [],
): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) collectValidationKeywords(item, output);
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.allOf) && containsValidationKeyword(record.allOf)) {
      output.push({ maxLength: findMaxLength(record.allOf), schema: record });
      for (const [key, child] of Object.entries(record)) {
        if (key !== "allOf") collectValidationKeywords(child, output);
      }
    } else {
      if (typeof record.pattern === "string" || record.format === "uri") output.push(record);
      for (const child of Object.values(record)) collectValidationKeywords(child, output);
    }
  }
  return output;
}

function collectArraySchemas(
  value: unknown,
  output: Array<Record<string, unknown>> = [],
): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) collectArraySchemas(item, output);
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "array") output.push(record);
    for (const child of Object.values(record)) collectArraySchemas(child, output);
  }
  return output;
}

function collectRecordSchemas(
  value: unknown,
  output: Array<Record<string, unknown>> = [],
): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) collectRecordSchemas(item, output);
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      record.type === "object" &&
      record.additionalProperties !== null &&
      typeof record.additionalProperties === "object"
    ) {
      output.push(record);
    }
    for (const child of Object.values(record)) collectRecordSchemas(child, output);
  }
  return output;
}

describe("bounded protocol string and collection inputs", () => {
  it("rejects over-cap arrays before validating a poison element", () => {
    let poisonTouched = false;
    const poison = new Proxy(
      {},
      {
        ownKeys() {
          poisonTouched = true;
          throw new Error("poison element traversed");
        },
      },
    );
    const hostileArray = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") throw new Error("hostile length getter");
        return Reflect.get(target, property, receiver);
      },
    });

    const schema = boundedArray(z.strictObject({ id: z.string() }), 1);

    expect(() => schema.safeParse([poison, {}])).not.toThrow();
    expect(schema.safeParse([poison, {}]).success).toBe(false);
    expect(() => schema.safeParse(hostileArray)).not.toThrow();
    expect(poisonTouched).toBe(false);

    let oversizedOwnKeysTouched = false;
    const oversizedArray = new Proxy(new Array(2), {
      ownKeys(target) {
        oversizedOwnKeysTouched = true;
        return Reflect.ownKeys(target);
      },
    });
    expect(snapshotPlainData(oversizedArray, {
      maximumDepth: 2,
      maximumNodes: 4,
      maximumProperties: 4,
      maximumArrayLength: 1,
      maximumObjectProperties: 4,
    })).toMatchObject({ ok: false, reason: "array-length" });
    expect(oversizedOwnKeysTouched).toBe(false);
  });


  it("reserves snapshot budget for every bounded package-inspection reference", () => {
    expect(
      PACKAGE_INSPECTION_SNAPSHOT_LIMITS.maximumProperties -
        MANIFEST_INPUT_SNAPSHOT_LIMITS.maximumProperties,
    ).toBeGreaterThanOrEqual(PACKAGE_LIMITS.maxFiles * (1 + 11 + 256));
    expect(
      PACKAGE_INSPECTION_SNAPSHOT_LIMITS.maximumNodes -
        MANIFEST_INPUT_SNAPSHOT_LIMITS.maximumNodes,
    ).toBeGreaterThanOrEqual(PACKAGE_LIMITS.maxFiles * 2);
  });

  it("stops local asset reference visiting when the callback returns false", () => {
    let renderTouched = false;
    let lodTouched = false;
    let laterObjectTouched = false;
    const manifest = {
      kind: "object-pack",
      entries: [
        {
          objects: [
            {
              colliderAssetId: "asset:first",
              get renderAssetId() {
                renderTouched = true;
                return "asset:render";
              },
              get lodAssetIds() {
                lodTouched = true;
                return ["asset:lod"];
              },
            },
            {
              get colliderAssetId() {
                laterObjectTouched = true;
                return "asset:later";
              },
              renderAssetId: "asset:later-render",
              lodAssetIds: [],
            },
          ],
        },
      ],
    } as unknown as Manifest;
    const visited: Array<{ assetId: string; path: string }> = [];

    const completed = visitLocalAssetReferences(manifest, (reference) => {
      visited.push(reference);
      return false;
    });

    expect(completed).toBe(false);
    expect(visited).toEqual([
      { assetId: "asset:first", path: "/entries/0/objects/0/colliderAssetId" },
    ]);
    expect(renderTouched).toBe(false);
    expect(lodTouched).toBe(false);
    expect(laterObjectTouched).toBe(false);
  });

  it("caps missing object-pack local references at the deterministic first issue window", async () => {
    const manifest = await goldenManifest("object-pack");
    const [entry] = manifest.entries as Array<{ objects: Array<Record<string, unknown>> }>;
    if (!entry) throw new Error("Expected object-pack golden manifest entry");
    const [baseObject] = entry.objects;
    if (!baseObject) throw new Error("Expected object-pack golden manifest object");
    entry.objects = Array.from({ length: MAX_VALIDATION_ISSUES + 4 }, (_, index) => ({
      ...structuredClone(baseObject),
      objectId: `missing-object-${index}`,
      colliderAssetId: `missing-collider-${index}`,
      renderAssetId: `missing-render-${index}`,
      lodAssetIds: [],
    }));

    const result = parseManifest(manifest);
    const expectedFirstIssuePaths = Array.from({ length: MAX_VALIDATION_ISSUES }, (_, index) => {
      const objectIndex = Math.floor(index / 2);
      const field = index % 2 === 0 ? "colliderAssetId" : "renderAssetId";
      return `/entries/0/objects/${objectIndex}/${field}`;
    }).sort();

    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(MAX_VALIDATION_ISSUES);
    expect(result.issues.map((issue) => issue.path)).toEqual(expectedFirstIssuePaths);
    expect(result.issues.every((issue) => issue.ruleId === "E_PATH_POLICY")).toBe(true);
  });
  it("rejects reserved, symbol, and non-enumerable record keys before Zod", () => {
    const schema = z.pipe(recordPreflight(4), z.record(z.string(), z.boolean()));
    const reserved = JSON.parse('{"__proto__":true}') as Record<string, unknown>;
    const symbolKey = { safe: true };
    Object.defineProperty(symbolKey, Symbol("hidden"), {
      enumerable: true,
      value: true,
    });
    const nonEnumerable = { safe: true };
    Object.defineProperty(nonEnumerable, "hidden", {
      enumerable: false,
      value: true,
    });

    for (const record of [reserved, symbolKey, nonEnumerable]) {
      expect(schema.safeParse(record).success).toBe(false);
    }
  });

  it("rejects oversized regex and URL inputs before expensive validation", () => {
    const oversizedRange = Array.from({ length: 500 }, () => ">=1.0.0").join(" ");

    expect(ExactSemverSchema.safeParse(`1.0.0-${"a".repeat(10_000)}`).success).toBe(false);
    expect(EngineRangeSchema.safeParse(oversizedRange).success).toBe(false);
    expect(PackageNameSchema.safeParse(`@scope/${"a".repeat(10_000)}`).success).toBe(false);
    expect(IntegritySchema.safeParse(`sha512-${"A".repeat(10_000)}`).success).toBe(false);
    expect(HttpUrlSchema.safeParse(`https://example.com/${"a".repeat(10_000)}`).success).toBe(false);
    expect(HttpUrlSchema.safeParse("https://user:password@example.com/file").success).toBe(false);
  });

  it("enforces strict SemVer identifiers and supported engine operators", () => {
    for (const version of ["1.0.0", "1.0.0-0", "1.0.0-alpha.01a", "1.0.0+01"]) {
      expect(ExactSemverSchema.safeParse(version).success, version).toBe(true);
    }
    for (const version of ["1.0.0-01", "1.0.0-alpha..1", "1.0.0-"]) {
      expect(ExactSemverSchema.safeParse(version).success, version).toBe(false);
    }
    for (const range of [">=1.0.0 <2.0.0", "^1.2.3", "~1.2.3-beta.1", "1.0.0"]) {
      expect(EngineRangeSchema.safeParse(range).success, range).toBe(true);
    }
    for (const range of ["^^^1.0.0", "01.0.0", "1.0.0-.."]) {
      expect(EngineRangeSchema.safeParse(range).success, range).toBe(false);
    }
  });

  it("accepts only one canonical 64-byte SHA-512 npm integrity", () => {
    const canonical = `sha512-${"A".repeat(86)}==`;
    expect(canonical.length).toBe(95);
    for (const terminal of ["A", "Q", "g", "w"]) {
      const integrity = `sha512-${"A".repeat(85)}${terminal}==`;
      expect(IntegritySchema.safeParse(integrity).success, integrity).toBe(true);
    }
    for (const integrity of [
      "sha512-A",
      `sha512-${"A".repeat(86)}=`,
      `sha512-${"A".repeat(85)}B==`,
      `${canonical} sha512-${"A".repeat(86)}==`,
    ]) {
      expect(IntegritySchema.safeParse(integrity).success, integrity).toBe(false);
    }
  });

  it("accepts only calendar-valid exact UTC timestamps with optional .000", () => {
    for (const timestamp of ["2026-02-28T00:00:00Z", "2024-02-29T23:59:59.000Z"]) {
      expect(TimestampSchema.safeParse(timestamp).success, timestamp).toBe(true);
    }
    for (const timestamp of [
      "2026-02-29T00:00:00Z",
      "2026-02-31T00:00:00Z",
      "2026-04-31T00:00:00.000Z",
      "2026-01-01T00:00:00.123Z",
      "2026-01-01T00:00:00+00:00",
      `2026-01-01T00:00:00Z${"0".repeat(10_000)}`,
    ]) {
      expect(TimestampSchema.safeParse(timestamp).success, timestamp).toBe(false);
    }

    expect(
      validateCatalogFreshness({
        snapshotId: "snapshot:new",
        generatedAt: "2026-02-31T00:00:00Z",
        now: "2026-03-01T00:00:00Z",
        maxAgeSeconds: 86_400,
        previousValidSnapshotId: "snapshot:old",
      }),
    ).toMatchObject({ ok: false, issues: [{ ruleId: "E_CATALOG_STALE" }] });
  });

  it("caps translations, transformation config, and character provenance arrays", async () => {
    const translations = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`en-x${index}`, `Translation ${index}`]),
    );
    expect(LocalizedTextSchema.safeParse({ default: "Default", translations }).success).toBe(false);

    const config = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`option-${index}`, index]),
    );
    expect(
      TransformationSchema.safeParse({
        recipe: "Convert source asset",
        tool: { name: "converter", version: "1.0.0" },
        config,
        configSha256: SHA,
      }).success,
    ).toBe(false);

    const character = await goldenEntry("character");
    expect(
      CharacterEntrySchema.safeParse({
        ...character,
        provenanceAssetIds: Array.from(
          { length: PACKAGE_LIMITS.maxFiles + 1 },
          (_, index) => `asset:${index}`,
        ),
      }).success,
    ).toBe(false);
  });

  it("reuses credential-safe bounded HTTP URLs for music provenance", async () => {
    const music = await goldenEntry("music");
    const tracks = music.tracks as Array<Record<string, unknown>>;
    expect(
      MusicEntrySchema.safeParse({
        ...music,
        tracks: [{ ...tracks[0], source: "https://user:password@example.com/source" }],
      }).success,
    ).toBe(false);
    expect(
      MusicEntrySchema.safeParse({
        ...music,
        tracks: [{ ...tracks[0], source: `https://example.com/${"a".repeat(10_000)}` }],
      }).success,
    ).toBe(false);
  });

  it("emits maxItems for every generated array schema", () => {
    const nodes = Object.values(renderSchemaArtifacts()).flatMap((text) =>
      collectArraySchemas(JSON.parse(text)),
    );
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.maxItems, JSON.stringify(node)).toEqual(expect.any(Number));
      expect(node.maxItems).toBeGreaterThanOrEqual(0);
    }
  });

  it("emits property-name rules that reject __proto__ for every generated record", () => {
    const nodes = Object.values(renderSchemaArtifacts()).flatMap((text) =>
      collectRecordSchemas(JSON.parse(text)),
    );
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      const propertyNames = node.propertyNames as Record<string, unknown> | undefined;
      expect(propertyNames?.pattern, JSON.stringify(node)).toEqual(expect.any(String));
      expect(new RegExp(propertyNames?.pattern as string).test("__proto__")).toBe(false);
    }
  });

  it("emits maxLength before every generated regex and URI validation", () => {
    const nodes = Object.values(renderSchemaArtifacts()).flatMap((text) =>
      collectValidationKeywords(JSON.parse(text)),
    );
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.maxLength, JSON.stringify(node)).toEqual(expect.any(Number));
      expect(node.maxLength).toBeGreaterThan(0);
    }
  });
});
