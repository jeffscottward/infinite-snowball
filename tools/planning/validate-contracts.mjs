#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PHASES = [
  ["P01", "Infinite-Snowball-Phase-01-Foundation.md", []],
  ["P02", "Infinite-Snowball-Phase-02-Protocol-Security-Offline-Design.md", ["P01"]],
  ["P03", "Infinite-Snowball-Phase-03-Assets-Music-Starter-Content.md", ["P02"]],
  ["P04", "Infinite-Snowball-Phase-04-Runtime-Input-Simulation.md", ["P01", "P02"]],
  ["P05", "Infinite-Snowball-Phase-05-First-Playable-Vertical-Slice.md", ["P03", "P04"]],
  ["P06", "Infinite-Snowball-Phase-06-Creator-CLI-Package-Workflow.md", ["P02", "P03"]],
  ["P07", "Infinite-Snowball-Phase-07-Secure-Offline-Catalog-Store.md", ["P05", "P06"]],
  ["P08", "Infinite-Snowball-Phase-08-Product-UI-PWA-Landing.md", ["P05", "P07"]],
  ["P09", "Infinite-Snowball-Phase-09-Docs-Community-Release-Collateral.md", ["P06", "P07", "P08"]],
  ["P10", "Infinite-Snowball-Phase-10-Cross-Device-QA-Performance-Review.md", ["P09"]],
  ["P11", "Infinite-Snowball-Phase-11-Public-Release-Deployment-Audit.md", ["P10"]],
];

const REQUIRED_CHECKS = [
  "lockfile",
  "types",
  "unit",
  "build",
  "content-policy",
  "license-provenance",
  "package-pack",
  "e2e-offline",
  "dependency-review",
  "codeql",
  "secret-scan",
];

const EXPECTED_FORBIDDEN_PATHS = [
  ":(glob)**/.omp-sessions/**",
  ":(glob)**/.omp-runs/**",
  ":(glob)**/.omp-workarounds/**",
  ":(glob).omp-status.md",
  ":(glob)**/.planning/ultra-root-output.jsonl",
  ":(glob)**/.planning/ultra-root-prompt.md",
  ":(glob)**/.planning/ultra-root-exit.json",
  ":(glob)**/node_modules/**",
  ":(glob)**/.pnpm-store/**",
  ":(glob)**/dist/**",
  ":(glob)**/coverage/**",
  ":(glob)**/playwright-report/**",
  ":(glob)**/test-results/**",
  ":(glob)**/*.tsbuildinfo",
  ":(glob)**/*.log",
  ":(glob)**/*.log.*",
  ":(glob)**/logs/**",
  ":(glob)**/.logs/**",
  ":(glob)**/tmp/**",
  ":(glob)**/.tmp/**",
  ":(glob)**/.npmrc.local",
  ":(glob)**/.netrc",
  ":(glob)**/.pypirc",
  ":(glob)**/.aws/**",
  ":(glob)**/.docker/**",
  ":(glob)**/.gnupg/**",
  ":(glob)**/.ssh/**",
  ":(glob)**/credentials/**",
  ":(glob)**/.credentials/**",
  ":(glob)**/credentials.*",
  ":(glob)**/*.credentials",
  ":(glob)**/*.pem",
  ":(glob)**/*.key",
  ":(glob)**/*.jks",
  ":(glob)**/*.kdbx",
  ":(glob)**/*.keystore",
  ":(glob)**/*.p12",
  ":(glob)**/*.pfx",
  ":(glob)**/id_dsa*",
  ":(glob)**/id_ecdsa*",
  ":(glob)**/id_rsa*",
  ":(glob)**/id_ed25519*",
  ":(glob)**/secrets.*",
  ":(glob)**/.DS_Store",
  ":(glob)**/.env",
  ":(glob)**/.env.*",
  ":(exclude,glob)**/.env.example",
  ":(exclude,glob)**/.env.schema",
];

const CANONICAL_COMMAND = "node tools/planning/validate-contracts.mjs --write .planning/validation-report.json";
const HISTORY_SOURCE = ".planning/architecture-decisions.md";

const REQUIRED_REGISTRY_ENTRIES = [
  { name: CANONICAL_COMMAND, owner: "Planning meta-test" },
  { name: "apps/web/playwright.release-candidate.config.ts", owner: "P10" },
  { name: "reports/qa/phase-10-device-matrix.schema.json", owner: "P10" },
  { name: "reports/qa/phase-10-device-matrix.json", owner: "P10" },
  { name: "node tools/qa/release-candidate/validate-manual-matrix.mjs", owner: "P10" },
  { name: "node tools/qa/release-candidate/profile-performance.mjs", owner: "P10" },
  { name: "node tools/qa/release-candidate/run-review-checks.mjs", owner: "P10" },
  { name: "node tools/release/assert-clean-cutover-state.mjs", owner: "P11" },
  { name: "node tools/release/preflight.mjs", owner: "P11" },
  { name: "node tools/release/verify-checks.mjs", owner: "P11" },
  { name: "node tools/release/cutover-repo.mjs", owner: "P11" },
  { name: "node tools/release/promote-web.mjs", owner: "P11" },
  { name: "node tools/release/verify-web.mjs", owner: "P11" },
  { name: "node tools/release/promote-docs.mjs", owner: "P11" },
  { name: "node tools/release/verify-docs.mjs", owner: "P11" },
  { name: "node tools/release/dispatch-npm-publisher.mjs", owner: "P11" },
  { name: "node tools/release/verify-npm.mjs", owner: "P11" },
  { name: "node tools/release/verify-readme.mjs", owner: "P11" },
  { name: "node tools/release/audit-deliverables.mjs", owner: "P11" },
];

const REQUIRED_REGISTRY_NAMES = REQUIRED_REGISTRY_ENTRIES.map((entry) => entry.name);

const REQUIRED_RELEASE_PROJECTS = [
  "chromium",
  "firefox",
  "playwright-webkit",
  "mobile-chromium",
  "mobile-webkit",
  "shipping macOS Safari",
  "real iPhone Safari",
];

const REQUIRED_RELEASE_PROJECT_ENTRIES = REQUIRED_RELEASE_PROJECTS.map((name) => ({ name, owner: "P10" }));

const STALE_COMMAND_PATTERNS = [
  /mobile-chrome/,
  /mobile-safari/,
  /--project=webkit\b/,
  /\bperf:profile\b/,
  /\baudit:accessibility\b/,
  /\breview:release-candidate\b/,
  /\bpnpm\s+release:/,
];

function parseArgs(argv) {
  const result = { root: process.cwd(), write: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") result.root = argv[++index];
    else if (arg === "--write") result.write = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function readText(root, rel) {
  return readFileSync(join(root, rel), "utf8");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function artifact(root, rel, role = "source") {
  const absolute = join(root, rel);
  if (!existsSync(absolute)) return { path: rel, exists: false, role };
  const stats = statSync(absolute);
  return { path: rel, exists: true, role, sizeBytes: stats.size, sha256: sha256File(absolute) };
}

function listMarkdownSources(root) {
  const planning = [".planning/architecture-decisions.md", ".planning/system-contracts.md", ".planning/deliverable-traceability.md"];
  const playbookRoot = join(root, ".maestro/playbooks");
  const playbooks = readdirSync(playbookRoot)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => `.maestro/playbooks/${name}`);
  return [...planning, ...playbooks];
}

function parseDeliverables(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\|\s*(D\d{3})\s*\|\s*([^|]+?)\s*\|\s*(P\d{2})\s*\|\s*(VG-\d{2}-[A-Z0-9-]+)\s*\|$/.exec(line);
    if (match) rows.push({ id: match[1], title: match[2].trim(), owner: match[3], gate: match[4] });
  }
  return rows;
}

function parseGates(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\|\s*(VG-\d{2}-[A-Z0-9-]+)\s*\|\s*(P\d{2})\s*\|\s*([^|]+)\|\s*([^|]+)\|$/.exec(line);
    if (match) rows.push({ id: match[1], owner: match[2], expectedEvidence: match[3].trim(), stopCondition: match[4].trim() });
  }
  return rows;
}

function parseRegistryOwners(text) {
  const ownersByName = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("| `")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const owner = cells[2];
    if (!owner) continue;
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const name = match[1];
      const owners = ownersByName.get(name) ?? new Set();
      owners.add(owner);
      ownersByName.set(name, owners);
    }
  }
  return new Map([...ownersByName.entries()].map(([name, owners]) => [name, sortedUnique(owners)]));
}

function expectedPhaseFiles() {
  return PHASES.map(([, file]) => file).sort();
}

function actualPhaseFiles(root) {
  return readdirSync(join(root, ".maestro/playbooks"))
    .filter((name) => /^Infinite-Snowball-Phase-\d{2}-.*\.md$/.test(name))
    .sort();
}

function isMarkdownFenceBalanced(text) {
  return (text.match(/^```/gm) ?? []).length % 2 === 0;
}

function parsePhaseDocuments(root) {
  return PHASES.map(([phase, file, expectedDependencies]) => {
    const rel = `.maestro/playbooks/${file}`;
    const text = readText(root, rel);
    const phaseId = /^Phase ID:\s*(P\d{2})\s*$/m.exec(text)?.[1] ?? null;
    const dependsRaw = /^Depends on:\s*(.+?)\s*$/m.exec(text)?.[1] ?? "";
    const dependencies = dependsRaw === "none" || dependsRaw === "None" ? [] : dependsRaw.split(/,\s*/).filter(Boolean);
    return {
      phase,
      file,
      exists: existsSync(join(root, rel)),
      phaseId,
      dependencies,
      expectedDependencies,
      statusPlanned: /^Status:\s*Planned\s*$/m.test(text),
      ownerRole: /^Owner role:\s*\S/m.test(text),
      markdownFenceBalanced: isMarkdownFenceBalanced(text),
      requiredHeadings: [
        "## Goal and user value",
        "## Prerequisites and dependencies",
        "## In scope",
        "## Non-goals",
        "## File and directory ownership boundaries",
        "## Stable inputs and contracts",
        "## Outputs and handoffs",
        "## Ordered checklist",
        "## Test-first acceptance criteria",
        "## Smallest meaningful verification",
        "## Quality gates",
        "## Completion and stop condition",
        "## Rollback and recovery notes",
      ].filter((heading) => !text.includes(heading)),
    };
  });
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) return null;
  return result.stdout.replace(/\r?\n$/, "");
}


function repoState(root, historyText) {
  const porcelain = git(root, ["status", "--porcelain=v1"]) ?? "";
  const statusLines = porcelain ? porcelain.split(/\r?\n/) : [];
  const untracked = statusLines.filter((line) => line.startsWith("??")).length;
  const staged = statusLines.filter((line) => !line.startsWith("??") && line[0] !== " ").length;
  const unstaged = statusLines.filter((line) => !line.startsWith("??") && line[1] !== " ").length;
  const branch = git(root, ["branch", "--show-current"]);
  const publicRepositoryLine =
    /^Historical repository fact.*public repository.*$/m.exec(historyText)?.[0] ??
    /^- Public repository:.*$/m.exec(historyText)?.[0] ??
    null;
  const publicationBoundaryLine =
    /^Historical repository fact.*only the existing Phase 01 commit was pushed.*$/m.exec(historyText)?.[0] ??
    /^- Publication boundary:.*$/m.exec(historyText)?.[0] ??
    null;
  return {
    current: {
      head: git(root, ["rev-parse", "HEAD"]),
      branch: branch || null,
      detachedHead: branch === "",
      remoteOrigin: git(root, ["config", "--get", "remote.origin.url"]),
      status: { staged, unstaged, untracked, total: statusLines.length, dirty: statusLines.length > 0 },
    },
    history: {
      sourcePath: HISTORY_SOURCE,
      publicRepositoryLine,
      publicationBoundaryLine,
      preservesPublicInitialization: Boolean(publicRepositoryLine?.includes("PUBLIC") && publicationBoundaryLine),
    },
    separatedHistoricalAndCurrent: true,
  };
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function buildReport(options) {
  const root = resolve(options.root);
  const errors = [];
  const assert = (condition, message) => {
    if (!condition) errors.push(message);
  };

  const architecture = readText(root, HISTORY_SOURCE);
  const traceability = readText(root, ".planning/deliverable-traceability.md");
  const systemContracts = readText(root, ".planning/system-contracts.md");
  const phase10 = readText(root, ".maestro/playbooks/Infinite-Snowball-Phase-10-Cross-Device-QA-Performance-Review.md");
  const phase11 = readText(root, ".maestro/playbooks/Infinite-Snowball-Phase-11-Public-Release-Deployment-Audit.md");

  const deliverables = parseDeliverables(traceability);
  const gates = parseGates(traceability);
  const gatesById = new Map(gates.map((gate) => [gate.id, gate]));
  const primaryGateIds = sortedUnique(deliverables.map((row) => row.gate));
  const supplementalGateIds = ["VG-05-CSP-WASM"].filter((gate) => gatesById.has(gate) && !primaryGateIds.includes(gate));
  const expectedIds = Array.from({ length: 42 }, (_, index) => `D${String(index + 1).padStart(3, "0")}`);
  const actualIds = deliverables.map((row) => row.id).sort();
  const gateCatalogIds = sortedUnique(gates.map((gate) => gate.id));
  const expectedGateCatalogIds = sortedUnique([...primaryGateIds, "VG-05-CSP-WASM"]);

  assert(deliverables.length === 42, `expected 42 deliverables, found ${deliverables.length}`);
  assert(JSON.stringify(actualIds) === JSON.stringify(expectedIds), "deliverable IDs must be exactly D001-D042");
  assert(primaryGateIds.length === 42, `expected 42 unique primary gates, found ${primaryGateIds.length}`);
  assert(supplementalGateIds.length === 1 && supplementalGateIds[0] === "VG-05-CSP-WASM", "expected exactly one supplemental VG-05-CSP-WASM gate");
  assert(gates.length === 43 && gateCatalogIds.length === 43, `expected exactly 43 unique gate definitions, found ${gates.length} rows and ${gateCatalogIds.length} unique IDs`);
  assert(JSON.stringify(gateCatalogIds) === JSON.stringify(expectedGateCatalogIds), "gate definitions must equal the 42 primary gates plus VG-05-CSP-WASM");
  assert(gatesById.get("VG-05-CSP-WASM")?.owner === "P05", "VG-05-CSP-WASM must be owned by P05");
  assert(gatesById.get("VG-11-AUDIT")?.expectedEvidence.includes("VG-05-CSP-WASM"), "VG-11-AUDIT must audit supplemental VG-05-CSP-WASM");
  assert(gatesById.get("VG-11-AUDIT")?.expectedEvidence.includes("D001-D042"), "VG-11-AUDIT must audit D001-D042");

  for (const row of deliverables) {
    assert(gatesById.has(row.gate), `${row.id} references undefined gate ${row.gate}`);
    assert(gatesById.get(row.gate)?.owner === row.owner, `${row.id} gate ${row.gate} owner mismatch`);
  }

  const p05SystemRow = systemContracts.split(/\r?\n/).find((line) => line.startsWith("| P05 `")) ?? "";
  const p05PrimaryGateCell = p05SystemRow.split("|").at(-2) ?? "";
  assert(!p05PrimaryGateCell.includes("VG-05-CSP-WASM"), "system-contracts P05 primary gate cell must not include supplemental VG-05-CSP-WASM");
  assert(p05SystemRow.includes("supplemental"), "system-contracts P05 row must describe supplemental CSP gate outside primary cell");

  const markdownSources = listMarkdownSources(root);
  const definedGateIds = new Set(gates.map((gate) => gate.id));
  const gateRefs = [];
  for (const rel of markdownSources) {
    const text = readText(root, rel);
    for (const match of text.matchAll(/VG-\d{2}-[A-Z0-9-]+/g)) gateRefs.push({ gate: match[0], path: rel });
  }
  const orphanGateRefs = gateRefs.filter((ref) => !definedGateIds.has(ref.gate));
  assert(orphanGateRefs.length === 0, `found orphan gate refs: ${orphanGateRefs.map((ref) => `${ref.gate}@${ref.path}`).join(", ")}`);

  const phaseDocuments = parsePhaseDocuments(root);
  const actualPhaseFileNames = actualPhaseFiles(root);
  const expectedPhaseFileNames = expectedPhaseFiles();
  const missingPhaseFiles = expectedPhaseFileNames.filter((file) => !actualPhaseFileNames.includes(file));
  const extraPhaseFiles = actualPhaseFileNames.filter((file) => !expectedPhaseFileNames.includes(file));
  assert(JSON.stringify(actualPhaseFileNames) === JSON.stringify(expectedPhaseFileNames), `phase files must be exactly the expected 11; missing=${missingPhaseFiles.join(", ") || "none"} extra=${extraPhaseFiles.join(", ") || "none"}`);
  for (const phaseDoc of phaseDocuments) {
    assert(phaseDoc.exists, `${phaseDoc.file} must exist`);
    assert(phaseDoc.markdownFenceBalanced, `${phaseDoc.phase} has unbalanced Markdown code fences`);
    assert(phaseDoc.phaseId === phaseDoc.phase, `${phaseDoc.file} must declare ${phaseDoc.phase}`);
    assert(JSON.stringify(phaseDoc.dependencies) === JSON.stringify(phaseDoc.expectedDependencies), `${phaseDoc.phase} dependencies mismatch`);
    assert(phaseDoc.statusPlanned, `${phaseDoc.phase} must be planned`);
    assert(phaseDoc.ownerRole, `${phaseDoc.phase} must declare owner role`);
    assert(phaseDoc.requiredHeadings.length === 0, `${phaseDoc.phase} missing headings: ${phaseDoc.requiredHeadings.join(", ")}`);
  }

  const registryOwners = parseRegistryOwners(systemContracts);
  const registryMissing = REQUIRED_REGISTRY_ENTRIES.filter((entry) => !registryOwners.has(entry.name)).map((entry) => entry.name);
  const registryOwnerMismatches = REQUIRED_REGISTRY_ENTRIES.filter((entry) => {
    const owners = registryOwners.get(entry.name) ?? [];
    return owners.length !== 1 || owners[0] !== entry.owner;
  }).map((entry) => `${entry.name} expected ${entry.owner} got ${(registryOwners.get(entry.name) ?? []).join(",") || "missing"}`);
  assert(registryMissing.length === 0, `missing planned command/config registry entries: ${registryMissing.join(", ")}`);
  assert(registryOwnerMismatches.length === 0, `planned command/config owner mismatches: ${registryOwnerMismatches.join("; ")}`);
  const projectMissing = REQUIRED_RELEASE_PROJECT_ENTRIES.filter((entry) => !registryOwners.has(entry.name)).map((entry) => entry.name);
  const projectOwnerMismatches = REQUIRED_RELEASE_PROJECT_ENTRIES.filter((entry) => {
    const owners = registryOwners.get(entry.name) ?? [];
    return owners.length !== 1 || owners[0] !== entry.owner;
  }).map((entry) => `${entry.name} expected ${entry.owner} got ${(registryOwners.get(entry.name) ?? []).join(",") || "missing"}`);
  assert(projectMissing.length === 0, `missing owned project/manual row names: ${projectMissing.join(", ")}`);
  assert(projectOwnerMismatches.length === 0, `owned project/manual row owner mismatches: ${projectOwnerMismatches.join("; ")}`);
  const staleRefs = [];
  for (const [path, text] of [
    ["P10", phase10],
    ["P11", phase11],
  ]) {
    for (const pattern of STALE_COMMAND_PATTERNS) {
      if (pattern.test(text)) staleRefs.push(`${path}:${pattern}`);
    }
  }
  assert(staleRefs.length === 0, `stale or undefined command/project refs remain: ${staleRefs.join(", ")}`);
  assert(phase10.includes("apps/web/playwright.release-candidate.config.ts"), "P10 must own release-candidate Playwright config");
  assert(phase10.includes("validate-manual-matrix.mjs"), "P10 must own manual matrix validator");
  assert(phase11.includes("dispatch-npm-publisher.mjs") && phase11.includes("--no-local-publish"), "P11 must dispatch/monitor protected npm publisher, not publish locally");
  assert(phase11.includes("preserve-public") && phase11.includes("convert-private"), "P11 must support preserve-public and convert-private modes");
  assert(phase11.includes("Cloudflare") && phase11.includes("header+meta intersection") && phase11.includes("GitHub Pages") && phase11.includes("meta-only"), "P11 must distinguish Cloudflare header+meta from GitHub Pages meta-only");

  const forbiddenTool = readText(root, "tools/quality/forbidden-tracked-paths.mjs");
  const forbiddenExtracted = sortedUnique([...forbiddenTool.matchAll(/"(:\([^"\n]+)"/g)].map((match) => match[1]));
  const missingForbidden = EXPECTED_FORBIDDEN_PATHS.filter((pathspec) => !forbiddenExtracted.includes(pathspec));
  assert(missingForbidden.length === 0, `forbidden tracked path audit missing pathspecs: ${missingForbidden.join(", ")}`);

  const sourceHashPaths = [
    ".planning/architecture-decisions.md",
    ".planning/system-contracts.md",
    ".planning/deliverable-traceability.md",
    ".maestro/playbooks/README.md",
    ...PHASES.map(([, file]) => `.maestro/playbooks/${file}`),
    "tools/planning/validate-contracts.mjs",
    "tools/quality/forbidden-tracked-paths.mjs",
    "tests/meta/planning-contracts.test.ts",
  ];

  const artifacts = sourceHashPaths.map((rel) => artifact(root, rel));
  for (const entry of artifacts) assert(entry.exists, `${entry.path} must exist for current source hashes`);

  const repo = repoState(root, architecture);
  assert(repo.current.head !== null, "current git HEAD must be reported");
  assert(repo.current.branch !== null || repo.current.detachedHead, "current git branch or detached HEAD state must be reported");
  assert(repo.history.preservesPublicInitialization, `${HISTORY_SOURCE} must preserve historical public repository facts separately from current state`);

  const report = {
    schemaVersion: 3,
    generatedByCommand: CANONICAL_COMMAND,
    overallPass: errors.length === 0,
    counts: {
      phases: actualPhaseFileNames.length,
      expectedPhases: 11,
      primaryGates: primaryGateIds.length,
      expectedPrimaryGates: 42,
      supplementalGates: supplementalGateIds.length,
      expectedSupplementalGates: 1,
      deliverables: deliverables.length,
      expectedDeliverables: 42,
      orphanGateRefs: orphanGateRefs.length,
      forbiddenPathspecs: forbiddenExtracted.length,
      expectedForbiddenPathspecs: EXPECTED_FORBIDDEN_PATHS.length,
      gateDefinitions: gateCatalogIds.length,
      expectedGateDefinitions: 43,
    },
    errors,
    deliverables: { rows: deliverables, primaryGateIds, supplementalGateIds },
    gates: { defined: gates, orphanRefs: orphanGateRefs },
    phases: { order: PHASES.map(([phase]) => phase), actualFiles: actualPhaseFileNames, expectedFiles: expectedPhaseFileNames, missingFiles: missingPhaseFiles, extraFiles: extraPhaseFiles, documents: phaseDocuments },
    commandOwnership: {
      registryMissing,
      registryOwnerMismatches,
      projectMissing,
      projectOwnerMismatches,
      requiredRegistryNames: REQUIRED_REGISTRY_NAMES,
      requiredReleaseProjects: REQUIRED_RELEASE_PROJECTS,
      staleRefs,
      owned: registryMissing.length === 0 && registryOwnerMismatches.length === 0 && projectMissing.length === 0 && projectOwnerMismatches.length === 0 && staleRefs.length === 0,
    },
    forbiddenTrackedPaths: { pathspecs: forbiddenExtracted, missing: missingForbidden, complete: missingForbidden.length === 0 },
    sourceHashes: artifacts,
    repoState: repo,
  };

  report.overallPass = errors.length === 0;
  return report;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = resolve(options.root);
  const report = buildReport({ ...options, root });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.write) {
    const destination = resolve(root, options.write);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, output);
  }
  if (report.overallPass) {
    console.log(`Planning contract validation PASS: phases=${report.counts.phases}, primary=${report.counts.primaryGates}, supplemental=${report.counts.supplementalGates}, orphanGateRefs=${report.counts.orphanGateRefs}`);
  } else {
    console.error(`Planning contract validation FAIL: ${report.errors.length} error(s)`);
    for (const error of report.errors) console.error(`- ${error}`);
  }
  process.exit(report.overallPass ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export { buildReport };
