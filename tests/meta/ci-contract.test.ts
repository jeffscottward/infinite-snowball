import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");
const CODEOWNERS_CANDIDATES = [
  join(ROOT, "CODEOWNERS"),
  join(ROOT, ".github", "CODEOWNERS"),
  join(ROOT, "docs", "CODEOWNERS"),
] as const;

const REQUIRED_CHECK_NAMES = [
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
] as const;

type RequiredCheckName = (typeof REQUIRED_CHECK_NAMES)[number];
type PermissionValue = "read" | "write" | "none";
type PermissionMap = Record<string, PermissionValue>;

type WorkflowInputValue = string | boolean;

type WorkflowInput = {
  line: number;
  value: WorkflowInputValue;
};

type WorkflowStep = {
  line: number;
  name: string;
  uses: string;
  run: string;
  with: Record<string, WorkflowInput>;
};

type WorkflowUse = {
  ref: string;
  line: number;
};

type WorkflowRun = {
  command: string;
  line: number;
};

type WorkflowJob = {
  id: string;
  displayName: string;
  fileName: string;
  line: number;
  permissions: PermissionMap;
  steps: WorkflowStep[];
  uses: WorkflowUse[];
  runs: WorkflowRun[];
  body: string;
};

type WorkflowModel = {
  fileName: string;
  text: string;
  jobs: WorkflowJob[];
};

type CiContract = {
  workflows: WorkflowModel[];
  jobs: Map<string, WorkflowJob>;
};

type CodeownersEntry = {
  line: number;
  pattern: string;
  owners: string[];
};

type CodeownersModel = {
  fileName: string;
  entries: CodeownersEntry[];
};

type TopLevelKeyMatch = {
  index: number;
  value: string;
};

type ScalarRead = {
  value: string;
  nextIndex: number;
};

type DependencySnapshot = {
  packageManager?: unknown;
  lifecycleBuildCandidates?: unknown;
};

type DependencyLifecycleEvidence = {
  policy?: unknown;
  reviewedAllowBuilds?: unknown;
  reviewedOnlyBuiltDependencies?: unknown;
};

const REQUIRED_CHECK_NAMES_SORTED = [...REQUIRED_CHECK_NAMES].sort();

const EXPECTED_JOB_PERMISSIONS: Readonly<Record<RequiredCheckName, PermissionMap>> = {
  lockfile: { contents: "read" },
  types: { contents: "read" },
  unit: { contents: "read" },
  build: { contents: "read" },
  "content-policy": { contents: "read" },
  "license-provenance": { contents: "read" },
  "package-pack": { contents: "read" },
  "e2e-offline": { contents: "read" },
  "dependency-review": { contents: "read", "pull-requests": "read" },
  codeql: { actions: "read", contents: "read", "security-events": "write" },
  "secret-scan": { contents: "read" },
};

const VALID_PERMISSION_SCOPES: Readonly<Record<string, true>> = {
  actions: true,
  attestations: true,
  checks: true,
  contents: true,
  deployments: true,
  discussions: true,
  "id-token": true,
  issues: true,
  models: true,
  packages: true,
  pages: true,
  "pull-requests": true,
  "security-events": true,
  statuses: true,
};

const VALID_PERMISSION_VALUES: Readonly<Record<PermissionValue, true>> = {
  read: true,
  write: true,
  none: true,
};

const MEANINGFUL_JOB_EVIDENCE: Readonly<Partial<Record<RequiredCheckName, RegExp[]>>> = {
  lockfile: [
    /\bpnpm\s+(?:install|i)\b[^\n]*\s--frozen-lockfile\b/i,
    /\bstrict-dep-builds\b/i,
    /\ballowBuilds\b|\breviewedAllowBuilds\b|\bapprovedBuild/i,
    /dependency-snapshot\.json|dependency[-_ ]policy|lifecycle[-_ ]script/i,
  ],
  types: [/\btsc\b[^\n]*\s--noEmit\b|\s--noEmit\b[^\n]*\btsc\b/i],
  unit: [/\bvitest\b[^\n]*\brun\b|\bpnpm\s+run\s+(?:test:)?unit\b/i],
  build: [/\bpnpm\s+(?:run\s+)?build\b/i],
  "content-policy": [/content[-_ ]policy/i],
  "license-provenance": [/license[^\n]*provenance|provenance[^\n]*license/i],
  "package-pack": [/\bpnpm\b[^\n]*\bpack\b[^\n]*(?:--dry-run|--pack-destination)|\bpnpm\s+-r\b[^\n]*\bpack\b/i],
  "e2e-offline": [/e2e[-_ ]offline|playwright[^\n]*offline|offline[^\n]*playwright/i],
};

const SCANNER_ACTIONS: Readonly<Record<string, true>> = {
  "gitleaks/gitleaks-action": true,
  "trufflesecurity/trufflehog": true,
  "zricethezav/gitleaks-action": true,
};

const SCANNER_COMMAND = /\b(?:gitleaks\s+(?:detect|protect)|trufflehog\s+git|detect-secrets\s+scan|ggshield\s+secret\s+scan)\b/i;

const FORBIDDEN_MUTATION_COMMANDS = [
  /(?<![A-Za-z0-9_-])(?:npm|pnpm|yarn)(?:\.(?:cmd|exe|ps1)|@[0-9A-Za-z.-]+)?(?=\s|[;&|<>]|$)[^;&|\n]*\bpublish\b/i,
  /\bgh\s+(?:api|release|repo|secret|workflow)\b/i,
  /\bgit\s+(?:commit|push|tag)\b/i,
  /\bdocker\s+(?:login|push)\b/i,
  /\bdocker\s+buildx\s+build\b[^\n]*\s--push\b/i,
  /\b(?:aws|az|firebase|flyctl|gcloud|heroku|mintlify|netlify|vercel|wrangler)\b/i,
  /\b(?:curl|wget)\b/i,
] as const;

const FORBIDDEN_MUTATING_ACTIONS = [
  /(?:^|\/)action-gh-release$/i,
  /(?:^|\/)actions-gh-pages$/i,
  /(?:^|\/)build-push-action$/i,
  /(?:^|\/)configure-pages$/i,
  /(?:^|\/)deploy-pages$/i,
  /(?:^|\/)docker-login-action$/i,
  /(?:^|\/)gh-action-pypi-publish$/i,
  /(?:^|\/)npm-publish$/i,
  /(?:^|\/)upload-pages-artifact$/i,
  /(?:^|\/)vercel-action$/i,
  /(?:^|\/)wrangler-action$/i,
] as const;

let cachedCiContract: CiContract | undefined;
let cachedCodeowners: CodeownersModel | undefined;

function relativeToRoot(filePath: string): string {
  return relative(ROOT, filePath).split("\\").join("/");
}

function assertPolicy(condition: boolean, message: string): asserts condition {
  expect(condition, message).toBe(true);
}

function readRequiredText(relativePath: string, purpose: string): string {
  const absolutePath = join(ROOT, relativePath);
  assertPolicy(existsSync(absolutePath), `${relativePath} must exist for ${purpose}.`);
  assertPolicy(statSync(absolutePath).isFile(), `${relativePath} must be a file for ${purpose}.`);
  return readFileSync(absolutePath, "utf8");
}

function stripInlineComment(value: string): string {
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === "'" || char === '"') && value[index - 1] !== "\\") {
      quote = quote === char ? "" : quote || char;
    }
    if (char === "#" && !quote && (index === 0 || /\s/.test(value[index - 1] ?? ""))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function unquoteScalar(value: string): string {
  const trimmed = stripInlineComment(value).trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function leadingSpaces(line: string): number {
  const match = /^( *)/.exec(line);
  return match?.[1]?.length ?? 0;
}

function isIgnorableYamlLine(line: string): boolean {
  return line.trim() === "" || line.trimStart().startsWith("#");
}

function blockEnd(lines: string[], startIndex: number, parentIndent: number): number {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (!isIgnorableYamlLine(lines[index] ?? "") && leadingSpaces(lines[index] ?? "") <= parentIndent) {
      return index;
    }
  }
  return lines.length;
}

function assertConservativeWorkflowYaml(fileName: string, text: string, lines: string[]): void {
  assertPolicy(!text.includes("\t"), `${fileName} must not use tabs; policy parsing is space-indentation only.`);
  assertPolicy(!/^\s*---\s*$/m.test(text), `${fileName} must not use YAML document separators.`);
  assertPolicy(!/^\s*!\S/m.test(text), `${fileName} must not use YAML custom tags.`);
  assertPolicy(!/^\s*<<\s*:/m.test(text), `${fileName} must not use YAML merge keys.`);

  for (const [index, line] of lines.entries()) {
    if (isIgnorableYamlLine(line)) continue;
    const withoutComments = stripInlineComment(line);
    assertPolicy(
      !/(^|[\s[{,])-?\s*&[A-Za-z0-9_-]+(?:\s|$)/.test(withoutComments),
      `${fileName}:${index + 1} must not use YAML anchors.`,
    );
    assertPolicy(
      !/(^|[\s[{,])-?\s*\*[A-Za-z0-9_-]+(?:\s|$)/.test(withoutComments),
      `${fileName}:${index + 1} must not use YAML aliases.`,
    );
  }
}

function findSingleTopLevelKey(fileName: string, lines: string[], key: string): TopLevelKeyMatch {
  const matches: TopLevelKeyMatch[] = [];
  const expression = new RegExp(`^${key}:\\s*(.*)$`);
  for (const [index, line] of lines.entries()) {
    const match = expression.exec(stripInlineComment(line));
    if (match !== null) matches.push({ index, value: match[1] ?? "" });
  }

  assertPolicy(matches.length === 1, `${fileName} must define exactly one top-level ${key}: block.`);
  return matches[0] as TopLevelKeyMatch;
}

function parseInlinePermissions(fileName: string, lineNumber: number, rawValue: string): PermissionMap {
  const value = unquoteScalar(rawValue);
  if (value === "{}") return {};

  const inlineMatch = /^\{\s*(.*?)\s*\}$/.exec(value);
  assertPolicy(inlineMatch !== null, `${fileName}:${lineNumber} permissions must be an explicit mapping, not ${value}.`);

  const permissions: PermissionMap = {};
  for (const entry of (inlineMatch[1] ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const match = /^([a-z-]+)\s*:\s*(read|write|none)$/.exec(trimmed);
    assertPolicy(match !== null, `${fileName}:${lineNumber} has unsupported inline permission entry ${trimmed}.`);
    const scope = match[1] as string;
    const value = match[2] as PermissionValue;
    permissions[scope] = value;
  }
  return permissions;
}

function parsePermissionsAt(fileName: string, lines: string[], index: number, parentIndent: number): PermissionMap {
  const rawLine = stripInlineComment(lines[index] ?? "");
  const rawValue = rawLine.slice(rawLine.indexOf(":") + 1).trim();
  if (rawValue) return parseInlinePermissions(fileName, index + 1, rawValue);

  const permissions: PermissionMap = {};
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor] ?? "";
    if (isIgnorableYamlLine(line)) continue;

    const indent = leadingSpaces(line);
    if (indent <= parentIndent) break;

    assertPolicy(
      indent === parentIndent + 2,
      `${fileName}:${cursor + 1} permissions must use ${parentIndent + 2}-space child keys.`,
    );

    const match = /^\s*([a-z-]+):\s*(.+)$/.exec(stripInlineComment(line));
    assertPolicy(match !== null, `${fileName}:${cursor + 1} permission entries must be key: read|write|none.`);

    const scope = match[1] as string;
    const normalizedValue = unquoteScalar(match[2] ?? "");
    assertPolicy(scope in VALID_PERMISSION_SCOPES, `${fileName}:${cursor + 1} uses unknown permission scope ${scope}.`);
    assertPolicy(
      normalizedValue in VALID_PERMISSION_VALUES,
      `${fileName}:${cursor + 1} permission ${scope} must be read, write, or none.`,
    );
    assertPolicy(!(scope in permissions), `${fileName}:${cursor + 1} duplicates permission scope ${scope}.`);
    permissions[scope] = normalizedValue as PermissionValue;
  }

  assertPolicy(Object.keys(permissions).length > 0, `${fileName}:${index + 1} permissions block must not be empty.`);
  return permissions;
}

function findJobKeyLine(fileName: string, lines: string[], start: number, end: number, key: string): TopLevelKeyMatch {
  const matches: TopLevelKeyMatch[] = [];
  const expression = new RegExp(`^ {4}${key}:\\s*(.*)$`);
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    if (isIgnorableYamlLine(line)) continue;
    const match = expression.exec(stripInlineComment(line));
    if (match !== null) matches.push({ index, value: match[1]?.trim() ?? "" });
  }

  assertPolicy(matches.length === 1, `${fileName}:${start + 1} job must define exactly one ${key}: key.`);
  return matches[0] as TopLevelKeyMatch;
}

function readScalarField(fileName: string, lines: string[], index: number, keyIndent: number, rawValue: string): ScalarRead {
  const value = stripInlineComment(rawValue).trim();
  assertPolicy(value !== "", `${fileName}:${index + 1} scalar value must not be empty.`);
  assertPolicy(value !== ">" && value !== ">-" && value !== ">+", `${fileName}:${index + 1} folded scalars are ambiguous for policy parsing.`);

  if (value === "|" || value === "|-" || value === "|+") {
    const contentIndent = keyIndent + 2;
    const content: string[] = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (line.trim() !== "" && leadingSpaces(line) < contentIndent) break;
      content.push(line.trim() === "" ? "" : line.slice(contentIndent));
    }

    assertPolicy(content.some((line) => line.trim() !== ""), `${fileName}:${index + 1} literal scalar must not be empty.`);
    return { value: content.join("\n").trimEnd(), nextIndex: cursor - 1 };
  }

  return { value: unquoteScalar(value), nextIndex: index };
}

function parseWorkflowInputValue(fileName: string, lineNumber: number, rawValue: string): WorkflowInputValue {
  const value = stripInlineComment(rawValue).trim();
  assertPolicy(value !== "", `${fileName}:${lineNumber} action input must not be empty.`);
  assertPolicy(!/^[>|]/.test(value), `${fileName}:${lineNumber} action inputs must use explicit scalar values.`);
  if (value === "true") return true;
  if (value === "false") return false;
  return unquoteScalar(value);
}

function parseStepInputs(
  fileName: string,
  lines: string[],
  index: number,
  parentIndent: number,
  rawValue: string,
): { values: Record<string, WorkflowInput>; nextIndex: number } {
  assertPolicy(stripInlineComment(rawValue).trim() === "", `${fileName}:${index + 1} with: must use a simple block mapping.`);
  const end = blockEnd(lines, index, parentIndent);
  const inputIndent = parentIndent + 2;
  const values: Record<string, WorkflowInput> = {};

  for (let cursor = index + 1; cursor < end; cursor += 1) {
    const line = lines[cursor] ?? "";
    if (isIgnorableYamlLine(line)) continue;
    assertPolicy(leadingSpaces(line) === inputIndent, `${fileName}:${cursor + 1} action inputs must use two-space indentation.`);
    const match = new RegExp(`^ {${inputIndent}}([A-Za-z_-][A-Za-z0-9_-]*):\\s*(.*)$`).exec(line);
    assertPolicy(match !== null, `${fileName}:${cursor + 1} action input must be a simple mapping entry.`);
    const key = match[1] as string;
    assertPolicy(!(key in values), `${fileName}:${cursor + 1} duplicates action input ${key}.`);
    values[key] = {
      line: cursor + 1,
      value: parseWorkflowInputValue(fileName, cursor + 1, match[2] ?? ""),
    };
  }

  assertPolicy(Object.keys(values).length > 0, `${fileName}:${index + 1} with: block must not be empty.`);
  return { values, nextIndex: end - 1 };
}

function parseSteps(fileName: string, lines: string[], start: number, end: number): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  let currentStep: WorkflowStep | undefined;

  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    if (isIgnorableYamlLine(line)) continue;

    const compactMatch = /^( {6})-\s+([A-Za-z_-][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (compactMatch !== null) {
      currentStep = { line: index + 1, name: "", uses: "", run: "", with: {} };
      steps.push(currentStep);
      const key = compactMatch[2] as string;
      if (key === "name" || key === "uses" || key === "run") {
        const field = readScalarField(fileName, lines, index, (compactMatch[1]?.length ?? 0) + 2, compactMatch[3] ?? "");
        currentStep[key] = field.value;
        index = field.nextIndex;
      }
      continue;
    }

    if (/^ {6}-\s*$/.test(line)) {
      currentStep = { line: index + 1, name: "", uses: "", run: "", with: {} };
      steps.push(currentStep);
      continue;
    }

    const nestedMatch = /^( {8})([A-Za-z_-][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (nestedMatch !== null) {
      const key = nestedMatch[2] as string;
      assertPolicy(currentStep !== undefined, `${fileName}:${index + 1} step field appears before a step item.`);
      if (key === "name" || key === "uses" || key === "run") {
        const field = readScalarField(fileName, lines, index, nestedMatch[1]?.length ?? 0, nestedMatch[3] ?? "");
        currentStep[key] = field.value;
        index = field.nextIndex;
      } else if (key === "with") {
        const inputs = parseStepInputs(
          fileName,
          lines,
          index,
          nestedMatch[1]?.length ?? 0,
          nestedMatch[3] ?? "",
        );
        currentStep.with = inputs.values;
        index = inputs.nextIndex;
      }
    }
  }

  assertPolicy(steps.length > 0, `${fileName}:${start + 1} job must define at least one step.`);
  for (const step of steps) {
    assertPolicy(Boolean(step.uses || step.run), `${fileName}:${step.line} step must have a uses: action or a run: command.`);
  }

  return steps;
}

function parseJobs(fileName: string, lines: string[], jobsIndex: number): WorkflowJob[] {
  const end = blockEnd(lines, jobsIndex, 0);
  const jobs: WorkflowJob[] = [];

  for (let index = jobsIndex + 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    if (isIgnorableYamlLine(line)) continue;

    const indent = leadingSpaces(line);
    assertPolicy(indent === 2, `${fileName}:${index + 1} jobs must use simple two-space job ids.`);

    const match = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(stripInlineComment(line));
    assertPolicy(match !== null, `${fileName}:${index + 1} job id must be an unquoted lower-kebab key.`);

    const id = match[1] as string;
    const jobEnd = blockEnd(lines, index, 2);
    const jobLines = lines.slice(index + 1, jobEnd);
    const jobBody = jobLines.join("\n");

    assertPolicy(!/^ {4}uses:\s*/m.test(jobBody), `${fileName}:${index + 1} reusable workflow jobs hide policy details and are not allowed.`);
    assertPolicy(!/^ {4}strategy:\s*/m.test(jobBody), `${fileName}:${index + 1} matrix jobs change check names and are not allowed.`);
    assertPolicy(!/^ {4}environment:\s*/m.test(jobBody), `${fileName}:${index + 1} protected environments imply deployment or secret contexts and are not allowed in P01 CI.`);

    const nameLine = findJobKeyLine(fileName, lines, index, jobEnd, "name");
    const displayName = unquoteScalar(nameLine.value);
    assertPolicy(!displayName.includes("${{"), `${fileName}:${nameLine.index + 1} job name must be a literal check name.`);

    const permissionsLine = findJobKeyLine(fileName, lines, index, jobEnd, "permissions");
    const permissions = parsePermissionsAt(fileName, lines, permissionsLine.index, 4);

    const stepsLine = findJobKeyLine(fileName, lines, index, jobEnd, "steps");
    const steps = parseSteps(fileName, lines, stepsLine.index, jobEnd);

    jobs.push({
      id,
      displayName,
      fileName,
      line: index + 1,
      permissions,
      steps,
      uses: steps.filter((step) => step.uses).map((step) => ({ ref: step.uses, line: step.line })),
      runs: steps.filter((step) => step.run).map((step) => ({ command: step.run, line: step.line })),
      body: jobBody,
    });

    index = jobEnd - 1;
  }

  assertPolicy(jobs.length > 0, `${fileName} must define at least one job.`);
  return jobs;
}

function parseTopLevelTriggerNames(fileName: string, lines: string[]): Set<string> {
  const onKey = findSingleTopLevelKey(fileName, lines, "on");
  assertPolicy(
    unquoteScalar(onKey.value) === "",
    `${fileName}:${onKey.index + 1} top-level on: must be an explicit mapping.`,
  );

  const triggers = new Set<string>();
  let hasParentTrigger = false;
  const end = blockEnd(lines, onKey.index, 0);
  for (let cursor = onKey.index + 1; cursor < end; cursor += 1) {
    const line = lines[cursor] ?? "";
    if (isIgnorableYamlLine(line)) continue;

    const indent = leadingSpaces(line);
    if (indent === 2) {
      const match = /^ {2}([A-Za-z0-9_-]+):(?:\s*.*)?$/.exec(stripInlineComment(line));
      assertPolicy(match !== null, `${fileName}:${cursor + 1} top-level on: entries must be event-name mappings.`);
      const trigger = (match[1] as string).toLowerCase();
      assertPolicy(!triggers.has(trigger), `${fileName}:${cursor + 1} duplicates the ${trigger} top-level trigger.`);
      triggers.add(trigger);
      hasParentTrigger = true;
      continue;
    }

    assertPolicy(
      hasParentTrigger && indent >= 4 && indent % 2 === 0,
      `${fileName}:${cursor + 1} has unsupported indentation inside the top-level on: block.`,
    );
  }

  assertPolicy(triggers.size > 0, `${fileName} top-level on: block must define at least one trigger.`);
  return triggers;
}

function assertForkSafeTriggers(fileName: string, text: string): void {
  const lines = text.split(/\r?\n/u);
  const uncommented = lines
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  const triggers = parseTopLevelTriggerNames(fileName, lines);

  assertPolicy(!triggers.has("pull_request_target"), `${fileName} top-level on: must not use pull_request_target.`);
  assertPolicy(triggers.has("pull_request"), `${fileName} must declare pull_request in the top-level on: block for fork-safe CI coverage.`);
  assertPolicy(!/\$\{\{\s*(?:secrets\.|github\.token\b)/i.test(uncommented), `${fileName} must not interpolate secrets or github.token into fork-reachable CI.`);
  assertPolicy(!/\b(?:GH_TOKEN|GITHUB_TOKEN|NODE_AUTH_TOKEN|NPM_TOKEN|CLOUDFLARE_API_TOKEN|VERCEL_TOKEN)\s*:/i.test(uncommented), `${fileName} must not define explicit secret-bearing token environment variables.`);
}

function parseWorkflowText(fileName: string, text: string): WorkflowModel {
  const lines = text.split(/\r?\n/u);

  assertConservativeWorkflowYaml(fileName, text, lines);
  assertForkSafeTriggers(fileName, text);

  const jobsKey = findSingleTopLevelKey(fileName, lines, "jobs");
  const permissionsKey = findSingleTopLevelKey(fileName, lines, "permissions");
  const topLevelPermissions = parsePermissionsAt(fileName, lines, permissionsKey.index, 0);
  expect(topLevelPermissions, `${fileName} must disable default token permissions at workflow scope with permissions: {}`).toEqual({});

  return { fileName, text, jobs: parseJobs(fileName, lines, jobsKey.index) };
}

function parseWorkflowFile(filePath: string): WorkflowModel {
  return parseWorkflowText(relativeToRoot(filePath), readFileSync(filePath, "utf8"));
}

function loadCiContract(): CiContract {
  if (cachedCiContract !== undefined) return cachedCiContract;

  assertPolicy(existsSync(WORKFLOW_DIR), ".github/workflows must exist before VG-01-CI-CONTRACT can pass.");
  assertPolicy(statSync(WORKFLOW_DIR).isDirectory(), ".github/workflows must be a directory.");

  const workflowFiles = readdirSync(WORKFLOW_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => join(WORKFLOW_DIR, entry.name))
    .sort();

  assertPolicy(workflowFiles.length > 0, ".github/workflows must contain at least one YAML workflow.");

  const workflows = workflowFiles.map(parseWorkflowFile);
  const jobs = new Map<string, WorkflowJob>();

  for (const workflow of workflows) {
    for (const job of workflow.jobs) {
      assertPolicy(!jobs.has(job.id), `CI job ${job.id} is defined more than once.`);
      jobs.set(job.id, job);
    }
  }

  cachedCiContract = { workflows, jobs };
  return cachedCiContract;
}

function commandWithoutComments(command: string): string {
  return command
    .split(/\r?\n/u)
    .map((line) => stripInlineComment(line).trim())
    .filter(Boolean)
    .join("\n");
}

function isNoOpCommand(command: string): boolean {
  const meaningful = commandWithoutComments(command);
  if (!meaningful) return true;
  if (/\b(?:todo|placeholder|no-?op)\b/i.test(meaningful)) return true;

  const statements = meaningful
    .split(/\n|&&|;/u)
    .map((statement) => statement.trim())
    .filter(Boolean);

  return statements.every((statement) => /^(?:echo|printf|true|false|:|pwd|ls(?:\s|$)|sleep\s+\d+|exit\s+0)(?:\s|$)/i.test(statement));
}

function normalizedJobEvidence(job: WorkflowJob): string {
  return [
    ...job.runs.map((run) => commandWithoutComments(run.command)),
    ...job.uses.map((use) => use.ref),
  ].join("\n");
}

function actionPath(actionRef: string): string {
  return actionRef.split("@")[0]?.toLowerCase() ?? "";
}

const PNPM_ACTION_SETUP_PATH = "pnpm/action-setup";
const EXPECTED_CI_PNPM_VERSION = "11.13.0";
const PINNED_PNPM_SETUP_REF = "pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320";
const PNPM_COMMAND = /(?<![A-Za-z0-9_-])pnpm(?:\.(?:cmd|exe|ps1)|@[0-9A-Za-z.-]+)?(?=\s|[)\]};&|<>]|$)/imu;

function jobInvokesPnpm(job: WorkflowJob): boolean {
  return job.runs.some((run) => PNPM_COMMAND.test(commandWithoutComments(run.command)));
}

function assertPnpmBootstrapPolicy(workflows: WorkflowModel[]): void {
  for (const workflow of workflows) {
    let pnpmJobCount = 0;
    let setupCount = 0;

    for (const job of workflow.jobs) {
      const setupSteps = job.steps.filter((step) => actionPath(step.uses) === PNPM_ACTION_SETUP_PATH);
      setupCount += setupSteps.length;

      for (const setup of setupSteps) {
        assertPolicy(
          /^pnpm\/action-setup@[0-9a-f]{40}$/i.test(setup.uses),
          `${job.fileName}:${setup.line} pnpm/action-setup must use an immutable full commit SHA.`,
        );
        const version = setup.with.version;
        assertPolicy(
          typeof version?.value === "string" && version.value === EXPECTED_CI_PNPM_VERSION,
          `${job.fileName}:${version?.line ?? setup.line} pnpm/action-setup with.version must be the string "${EXPECTED_CI_PNPM_VERSION}".`,
        );
        const runInstall = setup.with.run_install;
        assertPolicy(
          typeof runInstall?.value === "boolean" && runInstall.value === false,
          `${job.fileName}:${runInstall?.line ?? setup.line} pnpm/action-setup with.run_install must be the boolean false.`,
        );
      }

      if (jobInvokesPnpm(job)) {
        pnpmJobCount += 1;
        assertPolicy(
          setupSteps.length === 1,
          `${job.fileName}:${job.line} pnpm-invoking job ${job.id} must contain exactly one pnpm/action-setup step.`,
        );
      }
    }

    if (pnpmJobCount > 0) {
      assertPolicy(setupCount > 0, `${workflow.fileName} invokes pnpm but defines no pnpm/action-setup step.`);
    }
  }
}

function syntheticPnpmSetup(overrides: {
  reference?: string;
  version?: string;
  runInstall?: string;
  name?: string;
} = {}): string {
  return [
    `      - name: ${overrides.name ?? "Install pnpm"}`,
    `        uses: ${overrides.reference ?? PINNED_PNPM_SETUP_REF}`,
    "        with:",
    `          version: ${overrides.version ?? `"${EXPECTED_CI_PNPM_VERSION}"`}`,
    `          run_install: ${overrides.runInstall ?? "false"}`,
  ].join("\n");
}

function syntheticPnpmWorkflowText(setupSteps: string[]): string {
  return [
    "name: Synthetic pnpm contract",
    "on:",
    "  pull_request:",
    "permissions: {}",
    "jobs:",
    "  unit:",
    "    name: unit",
    "    permissions:",
    "      contents: read",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...setupSteps,
    "      - name: Run unit",
    "        run: pnpm run unit",
    "",
  ].join("\n");
}

function syntheticCrossJobMissingSetupText(): string {
  return [
    "name: Synthetic job-local pnpm contract",
    "on:",
    "  pull_request:",
    "permissions: {}",
    "jobs:",
    "  bootstrap:",
    "    name: bootstrap",
    "    permissions:",
    "      contents: read",
    "    runs-on: ubuntu-latest",
    "    steps:",
    syntheticPnpmSetup(),
    "      - name: Check Node",
    "        run: node --version",
    "  unit:",
    "    name: unit",
    "    permissions:",
    "      contents: read",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Run unit",
    "        run: ./node_modules/.bin/pnpm.cmd; node --version",
    "",
  ].join("\n");
}

function syntheticPushOnlyTriggerText(): string {
  return [
    "name: Synthetic push-only trigger contract",
    "on:",
    "  push:",
    "permissions: {}",
    "jobs:",
    "  unit:",
    "    name: unit",
    "    permissions:",
    "      contents: read",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Mention pull request context",
    '        run: node -e "console.log(\'github.event.pull_request\')"',
    "",
  ].join("\n");
}

function syntheticPnpmBootstrapMutations(): Array<{ name: string; text: string }> {
  const valid = syntheticPnpmSetup();
  return [
    { name: "job-local-missing-setup", text: syntheticCrossJobMissingSetupText() },
    {
      name: "duplicate-setup",
      text: syntheticPnpmWorkflowText([valid, syntheticPnpmSetup({ name: "Install pnpm again" })]),
    },
    {
      name: "wrong-version",
      text: syntheticPnpmWorkflowText([syntheticPnpmSetup({ version: '"11.12.0"' })]),
    },
    {
      name: "non-sha-reference",
      text: syntheticPnpmWorkflowText([syntheticPnpmSetup({ reference: "pnpm/action-setup@v4.4.0" })]),
    },
    {
      name: "quoted-run-install",
      text: syntheticPnpmWorkflowText([syntheticPnpmSetup({ runInstall: '"false"' })]),
    },
  ];
}

function assertNoMutationCommands(job: WorkflowJob): void {
  for (const run of job.runs) {
    const command = commandWithoutComments(run.command);
    for (const forbidden of FORBIDDEN_MUTATION_COMMANDS) {
      expect(command, `${job.id} run step at ${job.fileName}:${run.line} must not publish, deploy, release, or mutate external services.`).not.toMatch(forbidden);
    }
  }

  for (const use of job.uses) {
    const action = actionPath(use.ref);
    for (const forbidden of FORBIDDEN_MUTATING_ACTIONS) {
      expect(action, `${job.id} action at ${job.fileName}:${use.line} must not publish, deploy, release, or mutate external services.`).not.toMatch(forbidden);
    }
  }
}

function parseJsonEvidence(relativePath: string): unknown {
  const text = readRequiredText(relativePath, "reviewed dependency-policy evidence");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${relativePath} must contain strict JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function parseAllowBuildsEvidence(workspaceYaml: string): Map<string, boolean> {
  const lines = workspaceYaml.split(/\r?\n/u);
  const allowBuildsIndex = lines.findIndex((line) => /^allowBuilds:\s*$/.test(stripInlineComment(line)));
  assertPolicy(allowBuildsIndex >= 0, "pnpm-workspace.yaml must declare version-specific allowBuilds.");

  const entries = new Map<string, boolean>();
  for (let index = allowBuildsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isIgnorableYamlLine(line)) continue;
    if (leadingSpaces(line) === 0) break;

    const match = /^\s+(.+):\s*(true|false)\s*$/.exec(stripInlineComment(line));
    assertPolicy(match !== null, `pnpm-workspace.yaml:${index + 1} allowBuilds entries must be explicit booleans.`);
    const locator = unquoteScalar(match[1] ?? "");
    assertPolicy(locator.length > 0, `pnpm-workspace.yaml:${index + 1} allowBuilds locator must not be blank.`);
    assertPolicy(!entries.has(locator), `pnpm-workspace.yaml:${index + 1} duplicates allowBuilds locator ${locator}.`);
    entries.set(locator, match[2] === "true");
  }

  assertPolicy(entries.size > 0, "pnpm-workspace.yaml allowBuilds must contain reviewed exact-version entries.");
  return entries;
}

function loadCodeowners(): CodeownersModel {
  if (cachedCodeowners !== undefined) return cachedCodeowners;

  const existing = CODEOWNERS_CANDIDATES.filter((candidate) => existsSync(candidate));
  assertPolicy(existing.length === 1, "Exactly one CODEOWNERS file must exist at CODEOWNERS, .github/CODEOWNERS, or docs/CODEOWNERS.");

  const filePath = existing[0] as string;
  assertPolicy(statSync(filePath).isFile(), `${relativeToRoot(filePath)} must be a CODEOWNERS file.`);

  const fileName = relativeToRoot(filePath);
  const entries = readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .map((line, index) => ({ line: index + 1, raw: line.trim() }))
    .filter(({ raw }) => raw && !raw.startsWith("#"))
    .map(({ line, raw }): CodeownersEntry => {
      const parts = raw.split(/\s+/u);
      const pattern = parts[0] ?? "";
      const owners = parts.slice(1);
      assertPolicy(pattern.length > 0, `${fileName}:${line} must declare a CODEOWNERS pattern.`);
      assertPolicy(owners.length > 0, `${fileName}:${line} must assign at least one owner.`);
      for (const owner of owners) {
        assertPolicy(/^@[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(owner), `${fileName}:${line} owner ${owner} must be an @user or @org/team.`);
      }
      return { line, pattern: pattern.replace(/^\//, ""), owners };
    });

  assertPolicy(entries.length > 0, `${fileName} must contain CODEOWNERS entries.`);
  cachedCodeowners = { fileName, entries };
  return cachedCodeowners;
}

describe("IS-01-003 CI check contract", () => {
  it("defines exactly the eleven required job/check names and no extras", () => {
    const { jobs } = loadCiContract();

    expect([...jobs.keys()].sort()).toEqual(REQUIRED_CHECK_NAMES_SORTED);
    for (const checkName of REQUIRED_CHECK_NAMES) {
      const job = jobs.get(checkName);
      assertPolicy(job !== undefined, `required CI check ${checkName} must be present.`);
      expect(job.displayName, `${checkName} must publish the exact GitHub check name.`).toBe(checkName);
    }
  });

  it("pins every workflow action uses reference to a full forty-character commit SHA", () => {
    const { jobs } = loadCiContract();
    const pinnedAction = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/;

    for (const job of jobs.values()) {
      for (const use of job.uses) {
        expect(use.ref, `${job.fileName}:${use.line} uses: must be pinned to a full 40-hex SHA.`).toMatch(pinnedAction);
      }
    }
  });

  it("uses least-privilege workflow and job token permissions", () => {
    const { jobs } = loadCiContract();

    for (const job of jobs.values()) {
      assertPolicy(
        REQUIRED_CHECK_NAMES.includes(job.id as RequiredCheckName),
        `${job.id} must be one of the required checks before permissions can be evaluated.`,
      );
      expect(job.permissions, `${job.id} must declare only its required token permissions.`).toEqual(EXPECTED_JOB_PERMISSIONS[job.id as RequiredCheckName]);
    }
  });

  it("uses meaningful commands or security actions for every required check", () => {
    const { jobs } = loadCiContract();

    for (const job of jobs.values()) {
      for (const run of job.runs) {
        assertPolicy(!isNoOpCommand(run.command), `${job.id} run step at ${job.fileName}:${run.line} must not be echo/printf/true/ls/pwd/no-op evidence.`);
      }
    }

    for (const [jobName, patterns] of Object.entries(MEANINGFUL_JOB_EVIDENCE)) {
      const job = jobs.get(jobName);
      assertPolicy(job !== undefined, `${jobName} job must exist before evidence assertions can run.`);
      const evidence = normalizedJobEvidence(job);
      for (const pattern of patterns) {
        expect(evidence, `${jobName} must contain meaningful command evidence matching ${pattern}.`).toMatch(pattern);
      }
    }
  });

  it("requires pull_request in the top-level on block rather than step text", () => {
    expect(() =>
      parseWorkflowText("synthetic-push-only-trigger.yml", syntheticPushOnlyTriggerText()),
    ).toThrow(/pull_request.*top-level on:/i);
  });


  it("pins one typed non-installing pnpm bootstrap in every pnpm-invoking job", () => {
    assertPnpmBootstrapPolicy(loadCiContract().workflows);
  });

  it("rejects missing, duplicate, unpinned, wrong-version, and quoted-false pnpm bootstraps", () => {
    const validWorkflow = parseWorkflowText(
      "synthetic-valid-bootstrap.yml",
      syntheticPnpmWorkflowText([syntheticPnpmSetup()]),
    );
    expect(() => assertPnpmBootstrapPolicy([validWorkflow])).not.toThrow();

    for (const mutation of syntheticPnpmBootstrapMutations()) {
      const workflow = parseWorkflowText(`synthetic-${mutation.name}.yml`, mutation.text);
      expect(
        () => assertPnpmBootstrapPolicy([workflow]),
        mutation.name,
      ).toThrow();
    }
  });

  it("uses real dependency-review, CodeQL, and secret-scan evidence", () => {
    const { jobs } = loadCiContract();

    const dependencyReview = jobs.get("dependency-review");
    assertPolicy(dependencyReview !== undefined, "dependency-review job must exist.");
    expect(dependencyReview.uses.map((use) => actionPath(use.ref))).toContain("actions/dependency-review-action");

    const codeql = jobs.get("codeql");
    assertPolicy(codeql !== undefined, "codeql job must exist.");
    expect(codeql.uses.map((use) => actionPath(use.ref))).toEqual(
      expect.arrayContaining(["github/codeql-action/init", "github/codeql-action/analyze"]),
    );

    const secretScan = jobs.get("secret-scan");
    assertPolicy(secretScan !== undefined, "secret-scan job must exist.");
    const scannerActions = secretScan.uses.map((use) => actionPath(use.ref)).filter((action) => action in SCANNER_ACTIONS);
    const scannerCommands = secretScan.runs.map((run) => commandWithoutComments(run.command)).filter((command) => SCANNER_COMMAND.test(command));
    assertPolicy(scannerActions.length + scannerCommands.length > 0, "secret-scan must run a recognized secret scanner, not a placeholder command.");
  });
});

describe("IS-01-004 CI security policy", () => {
  it("rejects publication, deployment, release, and external mutation paths", () => {
    const { jobs } = loadCiContract();

    for (const job of jobs.values()) {
      expect(job.id, `${job.id} job id must not be a release/deploy/publish job.`).not.toMatch(/publish|deploy|release/i);
      expect(job.displayName, `${job.id} check name must not be a release/deploy/publish check.`).not.toMatch(/publish|deploy|release/i);
      assertNoMutationCommands(job);
    }
  });

  it("rejects path-qualified package publication with intervening flags", () => {
    const workflow = parseWorkflowText(
      "synthetic-package-publish.yml",
      syntheticPnpmWorkflowText([syntheticPnpmSetup()]).replace(
        "pnpm run unit",
        "./node_modules/.bin/pnpm.exe --filter demo publish",
      ),
    );
    const job = workflow.jobs[0];
    assertPolicy(job !== undefined, "synthetic publication mutation must contain one job.");
    expect(() => assertNoMutationCommands(job)).toThrow();
  });

  it("rejects fork-unsafe secret interpolation and token-bearing environments", () => {
    const { workflows } = loadCiContract();

    for (const workflow of workflows) {
      assertForkSafeTriggers(workflow.fileName, workflow.text);
    }
  });

  it("does not restrict secret scanning to verified findings only", () => {
    const { workflows } = loadCiContract();

    for (const workflow of workflows) {
      expect(
        workflow.text,
        `${workflow.fileName} must not suppress unknown potential secrets with --only-verified.`,
      ).not.toMatch(/--only-verified\b/i);
    }
  });

  it("runs lifecycle-bearing Vitest checks through audited root script context", () => {
    const { jobs } = loadCiContract();
    const workflowCommands = [...jobs.values()].flatMap((job) =>
      job.runs.map((run) => commandWithoutComments(run.command)),
    );
    expect(workflowCommands.join("\n"), "CI must not start Vitest through ambient pnpm exec semantics.").not.toMatch(
      /\b(?:corepack\s+pnpm|pnpm\s+(?:exec\s+)?vitest)\b/i,
    );

    const lockfile = jobs.get("lockfile");
    const unit = jobs.get("unit");
    assertPolicy(lockfile !== undefined, "lockfile job must exist.");
    assertPolicy(unit !== undefined, "unit job must exist.");
    expect(lockfile.runs.some((run) => /\bpnpm\s+run\s+test:workspace\b/.test(commandWithoutComments(run.command)))).toBe(true);
    expect(unit.runs.some((run) => /\bpnpm\s+run\s+unit\b/.test(commandWithoutComments(run.command)))).toBe(true);
  });

  it("requires frozen pnpm installs and reviewed dependency-build policy evidence", () => {
    const { jobs } = loadCiContract();
    const allRuns = [...jobs.values()].flatMap((job) => job.runs.map((run) => ({ ...run, job: job.id, fileName: job.fileName })));
    const installRuns = allRuns.filter((run) => /\bpnpm\s+(?:install|i)\b/i.test(commandWithoutComments(run.command)));

    assertPolicy(installRuns.length > 0, "CI must run pnpm install with a frozen lockfile.");
    for (const run of installRuns) {
      const command = commandWithoutComments(run.command);
      expect(command, `${run.job} install at ${run.fileName}:${run.line} must use --frozen-lockfile.`).toMatch(/\bpnpm\s+(?:install|i)\b[^\n]*\s--frozen-lockfile\b/i);
      expect(command, `${run.job} install at ${run.fileName}:${run.line} must not disable lockfile freezing.`).not.toMatch(/\s--no-frozen-lockfile\b/i);
      expect(command, `${run.job} install at ${run.fileName}:${run.line} must not hide lifecycle scripts with --ignore-scripts.`).not.toMatch(/\s--ignore-scripts\b/i);
    }

    const npmrc = readRequiredText(".npmrc", "pnpm strict dependency-build policy");
    expect(npmrc, ".npmrc must default-deny dependency build scripts.").toMatch(/^strict-dep-builds=true$/m);
    expect(npmrc, ".npmrc must not allow every dependency build script.").not.toMatch(/^dangerously-allow-all-builds\s*=\s*true$/im);

    const packageJson = existsSync(join(ROOT, "package.json")) ? readFileSync(join(ROOT, "package.json"), "utf8") : "";
    const workspaceYaml = existsSync(join(ROOT, "pnpm-workspace.yaml")) ? readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8") : "";
    expect(`${packageJson}\n${workspaceYaml}`, "Project policy must not set dangerouslyAllowAllBuilds.").not.toMatch(/dangerouslyAllowAllBuilds\s*[:=]\s*true/i);

    const snapshot = parseJsonEvidence("tests/fixtures/meta/dependency-snapshot.json") as DependencySnapshot;
    expect(snapshot.packageManager, "dependency evidence must pin the approved pnpm release.").toBe("pnpm@11.13.0");
    assertPolicy(Array.isArray(snapshot.lifecycleBuildCandidates), "dependency evidence must list reviewed lifecycle build candidates.");

    let packageEvidence: { infiniteSnowball?: { dependencyLifecycle?: DependencyLifecycleEvidence } };
    try {
      packageEvidence = JSON.parse(packageJson) as {
        infiniteSnowball?: { dependencyLifecycle?: DependencyLifecycleEvidence };
      };
    } catch (error) {
      throw new Error(`package.json must contain strict JSON: ${error instanceof Error ? error.message : String(error)}`);
    }

    const lifecycleEvidence = packageEvidence.infiniteSnowball?.dependencyLifecycle;
    expect(lifecycleEvidence?.policy, "package evidence must document fail-closed lifecycle handling.").toBe("fail-closed");
    expect(
      lifecycleEvidence?.reviewedOnlyBuiltDependencies,
      "package evidence must not retain rejected onlyBuiltDependencies terminology.",
    ).toBeUndefined();
    assertPolicy(Array.isArray(lifecycleEvidence?.reviewedAllowBuilds), "package evidence must list reviewed exact-version allowBuilds approvals.");

    const snapshotApprovals = snapshot.lifecycleBuildCandidates as Array<Record<string, unknown>>;
    const reviewedApprovals = lifecycleEvidence?.reviewedAllowBuilds as Array<Record<string, unknown>>;
    const approvalLocators: string[] = [];

    for (const entry of reviewedApprovals) {
      assertPolicy(typeof entry.package === "string", "reviewed build-script entries must name the package.");
      assertPolicy(typeof entry.version === "string", `${entry.package} must include an exact version.`);
      assertPolicy(typeof entry.rationale === "string", `${entry.package} must include reviewed rationale.`);
      assertPolicy(typeof entry.reviewedBy === "string", `${entry.package} must identify the reviewer.`);
      assertPolicy(typeof entry.reviewedOn === "string", `${entry.package} must include a review date.`);

      expect(entry.package).toMatch(/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/);
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
      expect(entry.rationale).toMatch(/\S.{24,}/);
      expect(entry.reviewedBy).toMatch(/\S.{2,}/);
      expect(entry.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      approvalLocators.push(`${entry.package}@${entry.version}`);
    }

    expect(reviewedApprovals).toEqual(snapshotApprovals);
    expect(new Set(approvalLocators).size, "reviewed lifecycle locators must be unique.").toBe(approvalLocators.length);

    const allowBuilds = parseAllowBuildsEvidence(workspaceYaml);
    expect([...allowBuilds.values()].every(Boolean), "allowBuilds must not silence denied scripts with false entries.").toBe(true);
    expect([...allowBuilds.keys()].sort(), "allowBuilds must contain only reviewed exact package versions.").toEqual(
      approvalLocators.sort(),
    );
  });
});

describe("IS-01-009 CODEOWNERS coverage for CI/security-owned paths", () => {
  it("covers workflows, security tooling, future packages, catalog, license/provenance, and deploy paths", () => {
    const { entries } = loadCodeowners();
    const patterns = entries.map((entry) => entry.pattern);

    const categories: Array<[string, (pattern: string) => boolean]> = [
      ["workflow definitions", (pattern) => /^\.github\/workflows(?:\/|$|\*)/.test(pattern)],
      ["quality security tooling", (pattern) => /^tools\/quality(?:\/|$|\*)/.test(pattern)],
      ["future packages", (pattern) => /^packages(?:\/|$|\*)/.test(pattern)],
      ["catalog policy or registry", (pattern) => /catalog/i.test(pattern)],
      ["license/provenance records", (pattern) => /license|notice|provenance|third[-_]?party/i.test(pattern)],
      ["deploy paths", (pattern) => /deploy|cloudflare|wrangler|pages|mintlify/i.test(pattern)],
    ];

    for (const [label, predicate] of categories) {
      assertPolicy(patterns.some(predicate), `CODEOWNERS must include an owner pattern for ${label}.`);
    }
  });
});
