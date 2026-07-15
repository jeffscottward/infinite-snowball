import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const HANDOFF_PATH = join(ROOT, "packages", "protocol", "protocol-handoff.json");
const FIXTURE_ROOT = join(ROOT, "tests", "fixtures", "protocol");

const REQUIRED_SCHEMA_ARTIFACTS = [
  "schemas/v1/asset-record.schema.json",
  "schemas/v1/bundle-manifest.schema.json",
  "schemas/v1/campaign-manifest.schema.json",
  "schemas/v1/catalog-entry.schema.json",
  "schemas/v1/catalog-package-asset.schema.json",
  "schemas/v1/catalog-package.schema.json",
  "schemas/v1/catalog-snapshot.schema.json",
  "schemas/v1/character-manifest.schema.json",
  "schemas/v1/install-plan.schema.json",
  "schemas/v1/install-record.schema.json",
  "schemas/v1/install-transaction.schema.json",
  "schemas/v1/level-manifest.schema.json",
  "schemas/v1/manifest.schema.json",
  "schemas/v1/music-manifest.schema.json",
  "schemas/v1/object-pack-manifest.schema.json",
  "schemas/v1/package-lock.schema.json",
  "schemas/v1/package-ref.schema.json",
  "schemas/v1/provenance.schema.json",
  "schemas/v1/save-export.schema.json",
  "schemas/v1/validation-issue.schema.json",
] as const;

const REQUIRED_ERROR_CODES = [
  "E_CACHE_WRITE",
  "E_CATALOG_STALE",
  "E_CODEC_UNSUPPORTED",
  "E_CODE_FORBIDDEN",
  "E_DAG_CYCLE",
  "E_DEPENDENCY_EXACT",
  "E_ENGINE_RANGE",
  "E_FILE_BUDGET",
  "E_GLB_REFERENCE",
  "E_HASH_MISMATCH",
  "E_LICENSE_POLICY",
  "E_LOCK_MISMATCH",
  "E_MIGRATION",
  "E_MIME_MISMATCH",
  "E_NPM_PROVENANCE",
  "E_OFFLINE_MISSING_ASSET",
  "E_OPTIONAL_PEER_CONFLICT",
  "E_PACKAGE_WITHDRAWN",
  "E_PATH_POLICY",
  "E_PRIVACY_EGRESS",
  "E_QUOTA",
  "E_SAVE_EXPORT_INTEGRITY",
  "E_SAVE_EXPORT_SIZE",
  "E_SAVE_EXPORT_VERSION",
  "E_SCHEMA_STRICT",
  "E_TRANSACTION_STATE",
] as const;

const REQUIRED_RUNTIME_VALIDATION = {
  required: true,
  jsonSchemaRole: "structural-preflight-only",
  authoritativeExports: [
    "@infinite-snowball/protocol/browser#parseManifest",
    "@infinite-snowball/protocol/browser#verifySaveExportIntegrity",
    "@infinite-snowball/protocol/package-inspection#validatePackageInspection",
  ],
  stableConstraintIds: [
    "RV-NFC-SAFE-RELATIVE-PATHS",
    "RV-CALENDAR-UTC-TIMESTAMPS",
    "RV-PLAIN-DATA-HOSTILE-INPUTS",
    "RV-MANIFEST-REFERENCES",
    "RV-MANIFEST-DERIVED-TOTALS",
    "RV-PACKAGE-HOST-PORTABLE-PATHS",
    "RV-PACKAGE-SEMANTIC-ROLES",
    "RV-PACKAGE-DECODED-MEDIA",
    "RV-PACKAGE-PROVENANCE-CONFIG-HASH",
    "RV-SAVE-EXPORT-PRIVACY",
    "RV-SAVE-EXPORT-CANONICAL-HASHES",
  ],
} as const;

async function fixtureNames(directory: string): Promise<string[]> {
  return (await readdir(join(FIXTURE_ROOT, directory), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => `${directory}/${entry.name}`)
    .sort();
}

describe("frozen P02 downstream handoff", () => {
  it("hands exact protocol, schema, fixture, and error registries to P03, P06, and P07", async () => {
    const handoff = JSON.parse(await readFile(HANDOFF_PATH, "utf8")) as {
      protocolVersion: string;
      validatorVersion: string;
      browserExport: string;
      runtimeValidation: unknown;
      schemaArtifacts: string[];
      errorCodes: string[];
      fixtures: Record<string, string[]>;
      consumers: Record<string, string[]>;
    };

    expect(Object.keys(handoff)).toEqual([
      "protocolVersion",
      "validatorVersion",
      "browserExport",
      "runtimeValidation",
      "schemaArtifacts",
      "errorCodes",
      "fixtures",
      "consumers",
    ]);
    expect(handoff.protocolVersion).toBe("1.0.0");
    expect(handoff.validatorVersion).toBe("1.0.0");
    expect(handoff.browserExport).toBe("@infinite-snowball/protocol/browser");
    expect(handoff.schemaArtifacts).toEqual(REQUIRED_SCHEMA_ARTIFACTS);
    expect(handoff.errorCodes).toEqual(REQUIRED_ERROR_CODES);
    expect(Object.keys(handoff.fixtures)).toEqual([
      "adversarial",
      "browserBoundary",
      "dependencyCatalog",
      "golden",
      "offline",
    ]);
    expect(handoff.fixtures).toEqual({
      adversarial: await fixtureNames("adversarial"),
      browserBoundary: await fixtureNames("browser-boundary"),
      dependencyCatalog: await fixtureNames("dependency-catalog"),
      golden: await fixtureNames("golden"),
      offline: await fixtureNames("offline"),
    });
    expect(Object.keys(handoff.consumers)).toEqual(["P03", "P06", "P07"]);
    expect(handoff.consumers.P03).toEqual([
      "provenance",
      "license-allowlist",
      "music-rules",
      "local-import-exclusion",
      "asset-budgets",
      "withdrawal-states",
    ]);
    expect(handoff.consumers.P06).toEqual([
      "strict-fixture-suite",
      "init",
      "catalog-relative-resource-contract",
      "validate --strict --json",
      "convert",
      "build",
      "preview",
      "pack",
      "install <exact-spec>",
      "catalog verify",
      "submit",
      "publish --dry-run",
      "real-publish-gate",
    ]);
    expect(handoff.consumers.P07).toEqual([
      "catalog-resource-resolver",
      "prefix-local-resource-containment",
      "offline-transaction-state-machine",
      "dexie-cache-invariants",
      "service-worker-policy",
      "migration-reconciliation-rules",
      "save-export",
      "error-codes",
      "negative-fixtures",
    ]);
  });

  it("requires authoritative runtime validation metadata beyond structural JSON Schema", async () => {
    const handoff = JSON.parse(await readFile(HANDOFF_PATH, "utf8")) as {
      runtimeValidation?: unknown;
    };

    expect(handoff.runtimeValidation).toEqual(REQUIRED_RUNTIME_VALIDATION);
  });

  it("is deterministic and contains no machine-local paths or timestamps", async () => {
    const text = await readFile(HANDOFF_PATH, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain(ROOT);
    expect(text).not.toMatch(/generatedAt|\/Users\//);
    expect(`${JSON.stringify(JSON.parse(text), null, 2)}\n`).toBe(text);
  });
});
