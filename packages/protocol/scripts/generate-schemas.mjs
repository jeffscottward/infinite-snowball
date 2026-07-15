import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ERROR_CODES } from "../dist/errors.js";
import { SCHEMA_ARTIFACT_NAMES, renderSchemaArtifacts } from "../dist/schema/json-schema.js";
import { PROTOCOL_SCHEMA_VERSION, VALIDATOR_VERSION } from "../dist/version.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
const SCHEMA_DIR = join(PACKAGE_ROOT, "schemas", "v1");
const HANDOFF_PATH = join(PACKAGE_ROOT, "protocol-handoff.json");
const CHECK_ONLY = process.argv.includes("--check");

async function namesIn(relativeDirectory) {
  const directory = join(REPO_ROOT, "tests", "fixtures", "protocol", relativeDirectory);
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => `${relativeDirectory}/${entry.name}`)
    .sort();
}

const RUNTIME_VALIDATION = Object.freeze({
  required: true,
  jsonSchemaRole: "structural-preflight-only",
  authoritativeExports: Object.freeze([
    "@infinite-snowball/protocol/browser#parseManifest",
    "@infinite-snowball/protocol/browser#verifySaveExportIntegrity",
    "@infinite-snowball/protocol/package-inspection#validatePackageInspection",
  ]),
  stableConstraintIds: Object.freeze([
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
  ]),
});

async function expectedHandoff() {
  return {
    protocolVersion: PROTOCOL_SCHEMA_VERSION,
    validatorVersion: VALIDATOR_VERSION,
    browserExport: "@infinite-snowball/protocol/browser",
    runtimeValidation: RUNTIME_VALIDATION,
    schemaArtifacts: SCHEMA_ARTIFACT_NAMES.map((name) => `schemas/v1/${name}.schema.json`).sort(),
    errorCodes: [...ERROR_CODES],
    fixtures: {
      adversarial: await namesIn("adversarial"),
      browserBoundary: await namesIn("browser-boundary"),
      dependencyCatalog: await namesIn("dependency-catalog"),
      golden: await namesIn("golden"),
      offline: await namesIn("offline"),
    },
    consumers: {
      P03: [
        "provenance",
        "license-allowlist",
        "music-rules",
        "local-import-exclusion",
        "asset-budgets",
        "withdrawal-states",
      ],
      P06: [
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
      ],
      P07: [
        "catalog-resource-resolver",
        "prefix-local-resource-containment",
        "offline-transaction-state-machine",
        "dexie-cache-invariants",
        "service-worker-policy",
        "migration-reconciliation-rules",
        "save-export",
        "error-codes",
        "negative-fixtures",
      ],
    },
  };
}

async function compare(path, expected) {
  try {
    return (await readFile(path, "utf8")) === expected;
  } catch {
    return false;
  }
}

const artifacts = renderSchemaArtifacts();
const handoffText = `${JSON.stringify(await expectedHandoff(), null, 2)}\n`;

if (CHECK_ONLY) {
  const expectedFiles = SCHEMA_ARTIFACT_NAMES.map((name) => `${name}.schema.json`).sort();
  let actualFiles = [];
  try {
    actualFiles = (await readdir(SCHEMA_DIR)).filter((name) => name.endsWith(".schema.json")).sort();
  } catch {
    actualFiles = [];
  }
  const drift = [];
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) drift.push("schema file set");
  for (const [name, text] of Object.entries(artifacts)) {
    if (!(await compare(join(SCHEMA_DIR, `${name}.schema.json`), text))) drift.push(`${name}.schema.json`);
  }
  if (!(await compare(HANDOFF_PATH, handoffText))) drift.push("protocol-handoff.json");
  if (drift.length > 0) {
    process.stderr.write(`Protocol schema drift: ${drift.sort().join(", ")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Protocol schema check passed for ${expectedFiles.length} artifacts and the frozen handoff.\n`);
  }
} else {
  await mkdir(SCHEMA_DIR, { recursive: true });
  for (const [name, text] of Object.entries(artifacts)) {
    await writeFile(join(SCHEMA_DIR, `${name}.schema.json`), text, "utf8");
  }
  await writeFile(HANDOFF_PATH, handoffText, "utf8");
  process.stdout.write(`Generated ${SCHEMA_ARTIFACT_NAMES.length} deterministic protocol schemas and the frozen handoff.\n`);
}
