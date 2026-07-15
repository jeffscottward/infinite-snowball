import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SCHEMA_ARTIFACT_NAMES,
  renderSchemaArtifacts,
} from "../../packages/protocol/src/schema/json-schema.js";

const SCHEMA_DIR = join(process.cwd(), "packages", "protocol", "schemas", "v1");

function assertKeysAreSorted(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertKeysAreSorted(item);
    return;
  }
  if (value === null || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  expect(Object.keys(record)).toEqual([...Object.keys(record)].sort());
  for (const child of Object.values(record)) assertKeysAreSorted(child);
}

function assertObjectSchemasAreBounded(value: unknown, path = "#"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertObjectSchemasAreBounded(item, `${path}/${index}`));
    return;
  }
  if (value === null || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const isObjectSchema =
    record.type === "object" ||
    Object.hasOwn(record, "properties") ||
    Object.hasOwn(record, "additionalProperties");
  if (isObjectSchema) {
    expect(record.maxProperties, path).toBeTypeOf("number");
    if (record.additionalProperties === false) {
      const properties =
        record.properties !== null && typeof record.properties === "object"
          ? Object.keys(record.properties)
          : [];
      expect(record.maxProperties, path).toBe(properties.length);
    }
  }
  for (const [key, child] of Object.entries(record)) {
    assertObjectSchemasAreBounded(child, `${path}/${key}`);
  }
}

describe("generated JSON Schema", () => {
  it("renders every named protocol record deterministically", () => {
    const first = renderSchemaArtifacts();
    const second = renderSchemaArtifacts();

    expect(second).toEqual(first);
    expect(Object.keys(first)).toEqual([...SCHEMA_ARTIFACT_NAMES]);
    expect(SCHEMA_ARTIFACT_NAMES).toEqual([
      "asset-record",
      "bundle-manifest",
      "campaign-manifest",
      "catalog-entry",
      "catalog-package",
      "catalog-package-asset",
      "catalog-snapshot",
      "character-manifest",
      "install-plan",
      "install-record",
      "install-transaction",
      "level-manifest",
      "manifest",
      "music-manifest",
      "object-pack-manifest",
      "package-lock",
      "package-ref",
      "provenance",
      "save-export",
      "validation-issue",
    ]);

    for (const text of Object.values(first)) {
      expect(text.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      expect(parsed.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(parsed.$id).toMatch(/^https:\/\/schemas\.infinite-snowball\.local\/protocol\/1\.0\.0\//);
      assertKeysAreSorted(parsed);
    }
  });

  it("keeps checked-in artifacts byte-identical to the Zod source", async () => {
    const rendered = renderSchemaArtifacts();
    for (const [name, expected] of Object.entries(rendered)) {
      expect(await readFile(join(SCHEMA_DIR, `${name}.schema.json`), "utf8"), name).toBe(expected);
    }
  });
  it("preserves normalized path segment rules in generated JSON Schema", () => {
    const artifact = JSON.parse(renderSchemaArtifacts()["asset-record"] ?? "null") as {
      properties?: { path?: { pattern?: string } };
    };
    const pattern = artifact.properties?.path?.pattern;
    expect(pattern).toBeTypeOf("string");
    if (pattern === undefined) throw new Error("Asset path JSON Schema must expose a pattern.");

    const pathPattern = new RegExp(pattern);
    expect(pathPattern.test("models/café.glb")).toBe(true);
    for (const path of ["a//b", "./a", "a/.", "a/"]) {
      expect(pathPattern.test(path), path).toBe(false);
    }
  });
  it("emits only frozen relative catalog resource contracts", () => {
    const snapshot = JSON.parse(renderSchemaArtifacts()["catalog-snapshot"]) as {
      properties: Record<string, { const?: unknown; pattern?: string }>;
      required: string[];
    };
    const entry = JSON.parse(renderSchemaArtifacts()["catalog-entry"]) as {
      properties: Record<string, { pattern?: string; items?: { pattern?: string } }>;
      required: string[];
    };
    const catalogPackage = JSON.parse(renderSchemaArtifacts()["catalog-package"]) as {
      properties: {
        immutableFiles: {
          items: { properties: Record<string, { pattern?: string }>; required: string[] };
        };
      };
    };
    const packageAsset = JSON.parse(renderSchemaArtifacts()["catalog-package-asset"]) as {
      properties: Record<string, { pattern?: string }>;
      required: string[];
    };

    expect(snapshot.properties.resourceBasePath?.const).toBe("./catalog/");
    expect(snapshot.required).toContain("resourceBasePath");
    expect(Object.hasOwn(snapshot.properties, "cdnBaseUrl")).toBe(false);
    expect(entry.required).toContain("packageRecordPath");
    expect(Object.hasOwn(catalogPackage.properties.immutableFiles.items.properties, "url")).toBe(false);
    expect(catalogPackage.properties.immutableFiles.items.required).toContain("resourcePath");
    expect(Object.hasOwn(packageAsset.properties, "url")).toBe(false);
    expect(packageAsset.required).toContain("resourcePath");

    const patterns = [
      entry.properties.icon?.pattern,
      entry.properties.packageRecordPath?.pattern,
      entry.properties.screenshots?.items?.pattern,
      catalogPackage.properties.immutableFiles.items.properties.resourcePath?.pattern,
      packageAsset.properties.resourcePath?.pattern,
    ];
    for (const pattern of patterns) {
      expect(pattern).toBeTypeOf("string");
      if (pattern === undefined) throw new Error("Catalog resource fields must expose a pattern.");
      const resourcePattern = new RegExp(pattern);
      expect(resourcePattern.test("packages/golden-level/1.0.0/arena.glb")).toBe(true);
      for (const invalid of [
        "/arena.glb",
        "../arena.glb",
        "a/./arena.glb",
        "a//b",
        "a:b/arena.glb",
        "https://cdn.example/a",
        "%2e%2e/arena.glb",
        "%252e%252e/arena.glb",
        "a?x",
        "a#x",
        "café.glb",
        "a\u0000b.glb",
        "a\nb.glb",
        "a\u001fb.glb",
        "asset.glb\n",
        "asset.glb\r",
        "asset.glb\r\n",
        "asset.glb\u2028",
        "asset.glb\u2029",
      ]) {
        expect(resourcePattern.test(invalid), JSON.stringify(invalid)).toBe(false);
      }
    }
  });
  it("preserves HTTP-only and no-userinfo URL rules in generated JSON Schema", () => {
    const artifact = JSON.parse(renderSchemaArtifacts()["asset-record"] ?? "null") as {
      properties?: {
        provenance?: { properties?: { source?: { format?: string; pattern?: string } } };
      };
    };
    const sourceSchema = artifact.properties?.provenance?.properties?.source;
    expect(sourceSchema?.format).toBe("uri");
    expect(sourceSchema?.pattern).toBeTypeOf("string");
    if (sourceSchema?.pattern === undefined) {
      throw new Error("Provenance source JSON Schema must expose an HTTP URL pattern.");
    }

    const urlPattern = new RegExp(sourceSchema.pattern);
    expect(urlPattern.test("https://example.com/source")).toBe(true);
    expect(urlPattern.test("HTTP://example.com/source")).toBe(true);
    expect(urlPattern.test("ftp://example.com/source")).toBe(false);
    expect(urlPattern.test("https://user:password@example.com/source")).toBe(false);
  });

  it("emits maxProperties for every generated object schema", () => {
    for (const [name, text] of Object.entries(renderSchemaArtifacts())) {
      assertObjectSchemasAreBounded(JSON.parse(text), `#/${name}`);
    }
  });


});
