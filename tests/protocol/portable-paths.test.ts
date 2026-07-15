import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SafeRelativePathSchema, parseManifest } from "../../packages/protocol/src/browser.js";

const GOLDEN_LEVEL_PATH = join(process.cwd(), "tests", "fixtures", "protocol", "golden", "level.json");

const REJECTED_PORTABLE_EXTRACTION_ALIASES = [
  "assets/arena./model.glb",
  "assets/arena /model.glb",
  "assets/model.glb.",
  "assets/model.glb ",
  "CON",
  "assets/con.glb",
  "assets/AuX.preview.png",
  "assets/COM1/model.glb",
  "assets/lpt9.mesh",
  "assets/com¹.glb",
  "assets/LPT².wav",
  "assets/arena.glb:Zone.Identifier",
] as const;

const WINDOWS_FORBIDDEN_PATH_CASES = [
  ["less-than", "<"],
  ["greater-than", ">"],
  ["double quote", "\""],
  ["colon", ":"],
  ["backslash", "\\"],
  ["pipe", "|"],
  ["question mark", "?"],
  ["asterisk", "*"],
  ["NUL", "\u0000"],
  ["C0 start of heading", "\u0001"],
  ["C0 unit separator", "\u001f"],
] as const;

const UNICODE_SEPARATOR_BYPASS_PATHS = [
  ["U+2028 before question mark", "assets/unsafe\u2028?name.glb"],
  ["U+2028 before percent escape", "assets/unsafe\u2028%2ename.glb"],
  ["U+2028 before dot segment", "assets/unsafe\u2028/../model.glb"],
  ["U+2029 before question mark", "assets/unsafe\u2029?name.glb"],
  ["U+2029 before percent escape", "assets/unsafe\u2029%2ename.glb"],
  ["U+2029 before dot segment", "assets/unsafe\u2029/../model.glb"],
] as const;

const VALID_PORTABLE_RELATIVE_PATHS = [
  "assets/.well-known/model.glb",
  "assets/v1.0/model.v2.glb",
  "assets/auxiliary/model.glb",
  "assets/com10/model.glb",
  "assets/lpt9-port/model.glb",
  "café/models/arena.glb",
] as const;

async function levelManifestWithAssetPath(path: string): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(await readFile(GOLDEN_LEVEL_PATH, "utf8")) as Record<string, unknown>;
  const firstAsset = (manifest.assets as Array<Record<string, unknown>>)[0];
  if (firstAsset === undefined) throw new Error("Golden level fixture must contain an asset.");
  firstAsset.path = path;
  return manifest;
}

describe("portable safe relative paths", () => {
  it.each(REJECTED_PORTABLE_EXTRACTION_ALIASES)("rejects host extraction alias %s", async (path) => {
    const schemaResult = SafeRelativePathSchema.safeParse(path);
    expect(schemaResult.success, path).toBe(false);
    if (!schemaResult.success) {
      expect(schemaResult.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: [] })]),
      );
    }

    const manifestResult = parseManifest(await levelManifestWithAssetPath(path));
    expect(manifestResult.ok, path).toBe(false);
    if (!manifestResult.ok) {
      expect(manifestResult.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ observed: path, path: "/assets/0/path" })]),
      );
    }
  });


  it.each(WINDOWS_FORBIDDEN_PATH_CASES)(
    "rejects Windows-forbidden or control character %s",
    async (_name, character) => {
      const path = `assets/unsafe${character}name.glb`;
      expect(SafeRelativePathSchema.safeParse(path).success, path).toBe(false);

      const manifestResult = parseManifest(await levelManifestWithAssetPath(path));
      expect(manifestResult.ok, path).toBe(false);
      if (!manifestResult.ok) {
        expect(manifestResult.issues).toEqual(
          expect.arrayContaining([expect.objectContaining({ observed: path, path: "/assets/0/path" })]),
        );
      }
    },
  );
  it.each(UNICODE_SEPARATOR_BYPASS_PATHS)(
    "rejects Unicode separator lookahead bypass %s",
    async (_name, path) => {
      expect(SafeRelativePathSchema.safeParse(path).success, path).toBe(false);

      const manifestResult = parseManifest(await levelManifestWithAssetPath(path));
      expect(manifestResult.ok, path).toBe(false);
      if (!manifestResult.ok) {
        expect(manifestResult.issues).toEqual(
          expect.arrayContaining([expect.objectContaining({ observed: path, path: "/assets/0/path" })]),
        );
      }
    },
  );
  it.each(VALID_PORTABLE_RELATIVE_PATHS)("accepts portable dotted POSIX path %s", (path) => {
    expect(SafeRelativePathSchema.safeParse(path).success, path).toBe(true);
  });
});
