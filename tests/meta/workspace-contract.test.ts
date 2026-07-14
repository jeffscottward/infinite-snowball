import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const META_FIXTURES = join(ROOT, "tests", "fixtures", "meta");

const FORBIDDEN_LOCK_AUTHORITIES = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb"] as const;
const FORBIDDEN_P01_SCAFFOLDS = ["apps", "packages", "src", "app", "public", "catalog", "content"] as const;
const AUDITED_PNPM_RUNNER = join(ROOT, "tools", "quality", "run-audited-pnpm.mjs");
const FORBIDDEN_TRACKED_PATH_AUDIT = join(ROOT, "tools", "quality", "forbidden-tracked-paths.mjs");

async function runAuditedPnpm(
  args: string[],
  cwd: string,
  npmExecPath: string | null = process.env.npm_execpath ?? null,
) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, CI: "1" };
  if (npmExecPath === null) {
    delete childEnv.npm_execpath;
  } else {
    childEnv.npm_execpath = npmExecPath;
  }

  return execFileAsync(process.execPath, [AUDITED_PNPM_RUNNER, ...args], {
    cwd,
    env: childEnv,
  });
}

type PrivacyManifest = {
  ignored: string[];
  trackable: string[];
};

type DependencySnapshot = {
  packageManager: string;
  nodeFloor: string;
  rootPackage: {
    name: string;
    private: true;
  };
  workspaceGlobs: string[];
  dependencies: Array<{
    name: string;
    version: string;
    reason: string;
  }>;
  lifecycleBuildCandidates: LifecycleAllowlistEntry[];
};

type LifecycleAllowlistEntry = {
  package: string;
  version: string;
  rationale: string;
  reviewedBy: string;
  reviewedOn: string;
};

type PackageJson = {
  name?: string;
  private?: boolean;
  packageManager?: string;
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  pnpm?: Record<string, unknown>;
  infiniteSnowball?: {
    dependencyLifecycle?: {
      policy?: string;
      reviewedAllowBuilds?: LifecycleAllowlistEntry[];
      reviewedOnlyBuiltDependencies?: unknown;
    };
  };
};


async function readRootFile(path: string) {
  const fullPath = join(ROOT, path);
  expect(existsSync(fullPath), `${path} must exist`).toBe(true);
  return readFile(fullPath, "utf8");
}

async function readFixtureJson<T>(path: string): Promise<T> {
  const fullPath = join(META_FIXTURES, path);
  expect(existsSync(fullPath), `${relative(ROOT, fullPath)} must exist`).toBe(true);
  return JSON.parse(await readFile(fullPath, "utf8")) as T;
}

async function readRootPackageJson() {
  return JSON.parse(await readRootFile("package.json")) as PackageJson;
}

function assertProbePathIsSafe(probePath: string) {
  expect(probePath, "probe path must not be blank").toMatch(/\S/);
  expect(probePath, `${probePath} must be repository-relative`).not.toMatch(/^(?:[a-zA-Z]:)?[\\/]/);
  expect(probePath, `${probePath} must not traverse upward`).not.toMatch(/(?:^|[\\/])\.\.(?:[\\/]|$)/);
  expect(probePath, `${probePath} must not contain NUL`).not.toContain("\0");
}

async function materializeProbe(tempRoot: string, probePath: string) {
  assertProbePathIsSafe(probePath);
  const destination = join(tempRoot, probePath);
  const relativeDestination = relative(tempRoot, destination);
  expect(relativeDestination.startsWith("..")).toBe(false);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, "Infinite Snowball privacy probe fixture\n", { flag: "wx" });
}

async function runGit(cwd: string, args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? "",
    };
  }
}

async function runNodeTool(scriptPath: string, cwd: string) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath], { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? "",
    };
  }
}

function checkIgnorePaths(stdout: string) {
  return stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("\t").at(-1) ?? "");
}

async function listRelativeFiles(directory: string): Promise<string[]> {
  if (!existsSync(directory)) {
    return [];
  }

  const entries = await readdir(directory);
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(directory, entry);
      const entryStat = await stat(fullPath);
      if (entryStat.isDirectory()) {
        return listRelativeFiles(fullPath);
      }
      return [relative(META_FIXTURES, fullPath).split(sep).join("/")];
    }),
  );

  return files.flat();
}

function parseWorkspaceStringList(workspaceYaml: string, key: string) {
  const lines = workspaceYaml.split(/\r?\n/);
  const keyIndex = lines.findIndex((line) => new RegExp(`^${escapeRegExp(key)}\\s*:\\s*$`).test(line));
  expect(keyIndex, `pnpm-workspace.yaml must declare ${key}:`).toBeGreaterThanOrEqual(0);

  const values: string[] = [];
  for (const line of lines.slice(keyIndex + 1)) {
    if (/^\S/.test(line)) {
      break;
    }

    const match = /^\s*-\s*["']?([^"'#]+)["']?\s*(?:#.*)?$/.exec(line);
    const value = match?.[1];
    if (value) {
      values.push(value.trim());
    }
  }

  return values;
}
function parseWorkspaceBooleanMap(workspaceYaml: string, key: string) {
  const lines = workspaceYaml.split(/\r?\n/);
  const keyIndex = lines.findIndex((line) => new RegExp(`^${escapeRegExp(key)}\\s*:\\s*$`).test(line));
  expect(keyIndex, `pnpm-workspace.yaml must declare ${key}:`).toBeGreaterThanOrEqual(0);

  const entries = new Map<string, boolean>();
  for (const line of lines.slice(keyIndex + 1)) {
    if (/^\S/.test(line)) {
      break;
    }
    if (!line.trim()) {
      continue;
    }

    const match = /^\s+(.+):\s*(true|false)\s*(?:#.*)?$/.exec(line);
    expect(match, `${key} entries must be explicit booleans, not approval placeholders`).not.toBeNull();
    const locator = match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
    expect(entries.has(locator), `${key} locator ${locator} must be unique`).toBe(false);
    entries.set(locator, match?.[2] === "true");
  }

  return entries;
}


function parseNpmrc(npmrc: string) {
  const settings = new Map<string, string>();
  for (const line of npmrc.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    expect(separator, `${trimmed} must use key=value syntax`).toBeGreaterThan(0);
    settings.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim());
  }

  return settings;
}

function dependencyVersion(packageJson: PackageJson, dependencyName: string) {
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
    const version = packageJson[section]?.[dependencyName];
    if (version) {
      return version;
    }
  }

  return undefined;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lockHasImporterPin(lockfile: string, dependencyName: string, version: string) {
  const dependency = escapeRegExp(dependencyName);
  const exactVersion = escapeRegExp(version);
  return new RegExp(`'?${dependency}'?:\\s*\\n\\s+specifier:\\s+${exactVersion}\\s*\\n\\s+version:\\s+${exactVersion}(?:\\(|\\s|$)`, "m").test(lockfile);
}

function lockHasPackageResolution(lockfile: string, packageName: string, version: string) {
  const packageKey = `${escapeRegExp(packageName)}@${escapeRegExp(version)}`;
  return new RegExp(`(?:^|\\n)\\s{2}'?${packageKey}(?:\\([^'\\n]*\\))?'?:`, "m").test(lockfile);
}
function lockPackageVersions(lockfile: string, packageName: string) {
  const versions = new Set<string>();
  const versionPattern = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.source;
  const resolutionPattern = new RegExp(
    `(?:^|\\n)\\s{2}'?${escapeRegExp(packageName)}@(${versionPattern})(?:\\([^'\\n]*\\))?'?:`,
    "g",
  );

  for (const match of lockfile.matchAll(resolutionPattern)) {
    const version = match[1];
    if (version) {
      versions.add(version);
    }
  }

  return [...versions].sort();
}

function validateLifecycleAllowlist(entries: unknown, schema: { items?: { required?: string[] } }) {
  expect(Array.isArray(entries), "reviewedAllowBuilds must be an array").toBe(true);
  const required = schema.items?.required ?? [];

  for (const entry of entries as Array<Record<string, unknown>>) {
    for (const field of required) {
      expect(entry[field], `lifecycle allowlist entry must include ${field}`).toBeTruthy();
    }
    expect(entry.package, "allowlist package name must be exact").toMatch(/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/);
    expect(entry.version, `${entry.package} allowlist version must be exact`).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(entry.rationale, `${entry.package} rationale must be reviewed prose`).toEqual(expect.stringMatching(/\S.{24,}/));
    expect(entry.reviewedOn, `${entry.package} review date must be ISO yyyy-mm-dd`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
}

describe("IS-01-000 privacy and ignore contract", () => {
  it("keeps privacy probes as JSON data instead of fixture files", async () => {
    const manifest = await readFixtureJson<PrivacyManifest>("privacy-ignore/manifest.json");
    const fixtureFiles = await listRelativeFiles(META_FIXTURES);

    for (const probePath of [...manifest.ignored, ...manifest.trackable]) {
      assertProbePathIsSafe(probePath);
    }

    expect(new Set(manifest.ignored).size, "ignored probes must be unique").toBe(manifest.ignored.length);
    expect(new Set(manifest.trackable).size, "trackable probes must be unique").toBe(manifest.trackable.length);
    expect(fixtureFiles, "ignored probes must not be materialized under tests/fixtures/meta").not.toEqual(
      expect.arrayContaining(manifest.ignored),
    );
  });

  it("proves the future .gitignore with git check-ignore inside a temporary Git repository", async () => {
    const manifest = await readFixtureJson<PrivacyManifest>("privacy-ignore/manifest.json");
    const sourceGitignore = join(ROOT, ".gitignore");
    expect(existsSync(sourceGitignore), ".gitignore must exist before Git privacy probes run").toBe(true);

    const tempRoot = await mkdtemp(join(tmpdir(), "infinite-snowball-privacy-"));
    try {
      await copyFile(sourceGitignore, join(tempRoot, ".gitignore"));
      const init = await runGit(tempRoot, ["init", "--quiet"]);
      expect(init.code, init.stderr).toBe(0);

      for (const probePath of [...manifest.ignored, ...manifest.trackable]) {
        await materializeProbe(tempRoot, probePath);
      }

      const ignored = await runGit(tempRoot, ["check-ignore", "-v", "--", ...manifest.ignored]);
      expect(ignored.code, ignored.stderr || ignored.stdout).toBe(0);
      expect(checkIgnorePaths(ignored.stdout)).toEqual(expect.arrayContaining(manifest.ignored));

      const trackableVerbose = await runGit(tempRoot, ["check-ignore", "-v", "--", ...manifest.trackable]);
      expect([0, 1], trackableVerbose.stderr).toContain(trackableVerbose.code);
      if (trackableVerbose.code === 0) {
        expect(
          trackableVerbose.stdout.split(/\r?\n/).filter(Boolean),
          "verbose matches for public env contracts must come only from explicit negation rules",
        ).toEqual(expect.arrayContaining(manifest.trackable.map((probePath) => expect.stringMatching(`:!.*\\t${probePath}$`))));
      } else {
        expect(trackableVerbose.stdout.trim()).toBe("");
      }

      for (const probePath of manifest.trackable) {
        const trackable = await runGit(tempRoot, ["check-ignore", "--quiet", "--", probePath]);
        expect(trackable.code, `${probePath} must remain trackable`).not.toBe(0);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps the shared forbidden tracked-path audit aligned with every privacy probe", async () => {
    const manifest = await readFixtureJson<PrivacyManifest>("privacy-ignore/manifest.json");
    expect(existsSync(FORBIDDEN_TRACKED_PATH_AUDIT), "the shared tracked-path audit must exist").toBe(true);

    const tempRoot = await mkdtemp(join(tmpdir(), "infinite-snowball-tracked-audit-"));
    try {
      expect((await runGit(tempRoot, ["init", "--quiet"])).code).toBe(0);
      for (const probePath of [...manifest.ignored, ...manifest.trackable]) {
        await materializeProbe(tempRoot, probePath);
      }
      expect(
        (await runGit(tempRoot, ["add", "--force", "--", ...manifest.ignored, ...manifest.trackable])).code,
      ).toBe(0);

      const audit = await runNodeTool(FORBIDDEN_TRACKED_PATH_AUDIT, tempRoot);
      expect(audit.code, "the audit must reject tracked private probes").not.toBe(0);
      const auditedPaths = `${audit.stdout}\n${audit.stderr}`
        .split(/\r?\n/)
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2))
        .sort();
      expect(auditedPaths).toEqual([...manifest.ignored].sort());
      expect(auditedPaths).not.toEqual(expect.arrayContaining(manifest.trackable));

      expect((await runGit(tempRoot, ["rm", "--cached", "--force", "--", ...manifest.ignored])).code).toBe(0);
      const publicContractsOnly = await runNodeTool(FORBIDDEN_TRACKED_PATH_AUDIT, tempRoot);
      expect(publicContractsOnly.code, publicContractsOnly.stderr).toBe(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("IS-01-001 private pnpm workspace contract", () => {
  it("keeps the root package private and pnpm as the only lock authority", async () => {
    const snapshot = await readFixtureJson<DependencySnapshot>("dependency-snapshot.json");
    const packageJson = await readRootPackageJson();

    expect(packageJson.name).toBe(snapshot.rootPackage.name);
    expect(packageJson.private, "root package must never be publishable").toBe(true);
    expect(packageJson.packageManager).toBe(snapshot.packageManager);
    expect(packageJson.engines?.node, "root package must enforce the audited Node floor").toBe(snapshot.nodeFloor);
    expect(existsSync(join(ROOT, "pnpm-lock.yaml")), "pnpm-lock.yaml must be the only lockfile").toBe(true);

    for (const forbiddenLockfile of FORBIDDEN_LOCK_AUTHORITIES) {
      expect(existsSync(join(ROOT, forbiddenLockfile)), `${forbiddenLockfile} must not exist`).toBe(false);
    }
  });

  it("declares only the approved workspace globs and does not scaffold app/package roots", async () => {
    const snapshot = await readFixtureJson<DependencySnapshot>("dependency-snapshot.json");
    const workspaceYaml = await readRootFile("pnpm-workspace.yaml");

    expect(parseWorkspaceStringList(workspaceYaml, "packages")).toEqual(snapshot.workspaceGlobs);

    for (const scaffoldPath of FORBIDDEN_P01_SCAFFOLDS) {
      expect(existsSync(join(ROOT, scaffoldPath)), `${scaffoldPath}/ belongs to later phases, not P01`).toBe(false);
    }
  });

  it("exposes real root commands for the mandatory Phase 01 slice gates", async () => {
    const scripts = (await readRootPackageJson()).scripts ?? {};
    const requiredScripts: Record<string, RegExp[]> = {
      lockfile: [/\brun-audited-pnpm\.mjs\s+install\s+--frozen-lockfile\b/, /\bvitest\s+run\b/],
      types: [/\btsc\s+-p\s+tests\/meta\/tsconfig\.json\s+--noEmit\b/],
      unit: [/\bvitest\s+run\b/],
    };

    for (const [scriptName, patterns] of Object.entries(requiredScripts)) {
      const command = scripts[scriptName] ?? "";
      expect(command, `package.json must define the ${scriptName} Phase 01 gate.`).not.toBe("");
      expect(command, `${scriptName} must not be a placeholder command.`).not.toMatch(/^\s*(?:echo\b.*|true|exit\s+0)\s*$/i);
      expect(command, `${scriptName} must inherit the audited pnpm script context instead of starting another CLI.`).not.toMatch(
        /\b(?:corepack\s+pnpm|pnpm\s+(?:exec\s+)?vitest)\b/i,
      );
      for (const pattern of patterns) {
        expect(command, `${scriptName} must contain real evidence matching ${pattern}.`).toMatch(pattern);
      }
    }
  });

  it("never starts an ambient package manager from a root package script", async () => {
    const scripts = (await readRootPackageJson()).scripts ?? {};
    for (const [scriptName, command] of Object.entries(scripts)) {
      const withoutAuditedRunner = command.replace(/\bnode\s+tools\/quality\/run-audited-pnpm\.mjs\b/g, "");
      expect(
        withoutAuditedRunner,
        `${scriptName} must use direct tools or the audited pnpm runner, never a nested package manager.`,
      ).not.toMatch(/\b(?:bun|corepack|npm|npx|pnpm|yarn)\b/i);
    }
  });

  it("defines strict shared toolchain configs without creating application source", async () => {
    const tsconfig = JSON.parse(await readRootFile("tsconfig.base.json")) as {
      compilerOptions?: Record<string, unknown>;
      include?: string[];
    };
    const testTsconfig = JSON.parse(await readRootFile("tests/meta/tsconfig.json")) as {
      extends?: string;
      compilerOptions?: Record<string, unknown>;
      include?: string[];
      exclude?: string[];
    };
    const editorConfig = await readRootFile(".editorconfig");
    const vitestConfig = await readRootFile("vitest.config.ts");
    const playwrightConfig = await readRootFile("playwright.config.ts");

    expect(tsconfig.compilerOptions).toEqual(
      expect.objectContaining({
        strict: true,
        noEmit: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        forceConsistentCasingInFileNames: true,
        types: [],
      }),
    );
    expect(tsconfig.include, "shared production defaults must not pull in root tests or configs").toBeUndefined();
    expect(testTsconfig.extends).toBe("../../tsconfig.base.json");
    expect(testTsconfig.compilerOptions?.types).toEqual(["node"]);
    expect(testTsconfig.include).toEqual(["../**/*.ts", "../../tools/**/*.ts", "../../*.config.ts"]);
    expect(testTsconfig.exclude).toEqual(
      expect.arrayContaining(["../../node_modules", "../../dist", "../../coverage", "../../test-results"]),
    );

    expect(editorConfig).toMatch(/^root = true/m);
    expect(editorConfig).toMatch(/^\[\*\]\s*$/m);
    expect(editorConfig).toMatch(/^end_of_line = lf/m);
    expect(editorConfig).toMatch(/^insert_final_newline = true/m);

    expect(vitestConfig).toMatch(/include:\s*\["tests\/\*\*\/\*\.test\.ts"\]/);
    expect(vitestConfig).toMatch(/exclude:\s*\[[^\]]*"tests\/e2e\/\*\*"/s);
    expect(playwrightConfig).toMatch(/testDir:\s*["']\.\/tests\/e2e["']/);
    expect(playwrightConfig).toMatch(/outputDir:\s*["']test-results\/playwright["']/);
    expect(playwrightConfig, "P01 must not invent an application server before P05").not.toMatch(/\bwebServer\s*:/);
  });
});

describe("IS-01-002 dependency snapshot and lifecycle policy", () => {
  it("pins every approved dependency exactly in package.json and pnpm-lock.yaml", async () => {
    const snapshot = await readFixtureJson<DependencySnapshot>("dependency-snapshot.json");
    const packageJson = await readRootPackageJson();
    const lockfile = await readRootFile("pnpm-lock.yaml");

    for (const dependency of snapshot.dependencies) {
      expect(dependency.version, `${dependency.name} fixture version must be exact`).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
      expect(dependencyVersion(packageJson, dependency.name), `${dependency.name} must be exactly pinned`).toBe(dependency.version);
      expect(lockHasImporterPin(lockfile, dependency.name, dependency.version), `${dependency.name} importer pin missing`).toBe(true);
      expect(lockHasPackageResolution(lockfile, dependency.name, dependency.version), `${dependency.name} lock resolution missing`).toBe(true);
    }
  });

  it("accepts only an explicit absolute pnpm npm_execpath without ambient fallback", async () => {
    expect(existsSync(AUDITED_PNPM_RUNNER), "the shared audited pnpm runner must exist").toBe(true);
    await expect(runAuditedPnpm(["--version"], ROOT, null)).rejects.toMatchObject({
      stderr: expect.stringMatching(/npm_execpath/i),
    });
    await expect(runAuditedPnpm(["--version"], ROOT, "pnpm.cjs")).rejects.toMatchObject({
      stderr: expect.stringMatching(/absolute/i),
    });
    const untrustedExecutableName = "opaque-env-value.cjs";
    const unrecognizedFailure = await runAuditedPnpm(
      ["--version"],
      ROOT,
      join(tmpdir(), untrustedExecutableName),
    ).then(
      () => undefined,
      (error: unknown) => error as { stderr?: string },
    );
    expect(unrecognizedFailure?.stderr).toMatch(/recognized pnpm entry/i);
    expect(unrecognizedFailure?.stderr).not.toContain(untrustedExecutableName);
    const missingNativeRoot = await mkdtemp(join(tmpdir(), "infinite-snowball-missing-pnpm-native-"));
    try {
      const missingNativePnpmFailure = await runAuditedPnpm(
        ["--version"],
        ROOT,
        join(missingNativeRoot, "pnpm.exe"),
      ).then(
        () => undefined,
        (error: unknown) => error as { stderr?: string },
      );
      expect(missingNativePnpmFailure?.stderr).toMatch(/could not report its version/i);
      expect(missingNativePnpmFailure?.stderr).not.toMatch(/recognized pnpm entry/i);
    } finally {
      await rm(missingNativeRoot, { recursive: true, force: true });
    }
  });

  it("rejects a pnpm executable that does not report exactly 11.13.0 before install", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "infinite-snowball-pnpm-version-"));
    const fakePnpm = join(tempRoot, "pnpm.cjs");
    const installSentinel = join(tempRoot, "INSTALL_RAN");

    try {
      await writeFile(
        fakePnpm,
        `if (process.argv[2] === "--version") process.stdout.write("11.12.0\\n"); else require("node:fs").writeFileSync(${JSON.stringify(
          installSentinel,
        )}, "ran\\n");\n`,
      );

      await expect(runAuditedPnpm(["install", "--offline"], tempRoot, fakePnpm)).rejects.toThrow(
        /expected exactly pnpm 11\.13\.0/i,
      );
      expect(existsSync(installSentinel), "the requested command must not run after a version mismatch").toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("proves strict pnpm rejects an unapproved local install script without executing it", async () => {
    const unapprovedFixture = await readFixtureJson<{ name: string; scripts?: Record<string, string> }>(
      "unapproved-install-script/package.json",
    );
    const tempRoot = await mkdtemp(join(tmpdir(), "infinite-snowball-lifecycle-"));
    const dependencyRoot = join(tempRoot, "dependency");
    const sourceManifest = join(META_FIXTURES, "unapproved-install-script", "package.json");
    const sourceSentinel = join(dependencyRoot, "LIFECYCLE_SENTINEL");
    const installedSentinel = join(tempRoot, "node_modules", unapprovedFixture.name, "LIFECYCLE_SENTINEL");

    try {
      await mkdir(dependencyRoot, { recursive: true });
      await copyFile(sourceManifest, join(dependencyRoot, "package.json"));
      await writeFile(
        join(dependencyRoot, "should-never-run.js"),
        'require("node:fs").writeFileSync(require("node:path").join(__dirname, "LIFECYCLE_SENTINEL"), "executed\\n");\n',
      );
      await writeFile(
        join(tempRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "infinite-snowball-lifecycle-probe",
            version: "0.0.0-private",
            private: true,
            packageManager: "pnpm@11.13.0",
            dependencies: {
              [unapprovedFixture.name]: "file:./dependency",
            },
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(join(tempRoot, ".npmrc"), "strict-dep-builds=true\n");

      let installFailure = "";
      let installCode = 0;
      try {
        await runAuditedPnpm(["install", "--offline"], tempRoot);
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
        installCode = typeof failure.code === "number" ? failure.code : 1;
        installFailure = `${failure.stdout ?? ""}\n${failure.stderr ?? failure.message ?? ""}`;
      }

      expect(installCode, "strict-dep-builds must reject the unapproved install script").not.toBe(0);
      expect(installFailure, "pnpm must report the ignored-build failure explicitly").toMatch(/ERR_PNPM_IGNORED_BUILDS/);
      expect(existsSync(sourceSentinel), "the source dependency lifecycle script must never execute").toBe(false);
      expect(existsSync(installedSentinel), "the installed dependency lifecycle script must never execute").toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed on dependency lifecycle scripts unless every build is reviewed and exact", async () => {
    const snapshot = await readFixtureJson<DependencySnapshot>("dependency-snapshot.json");
    const schema = await readFixtureJson<{ items?: { required?: string[] } }>("lifecycle-allowlist.schema.json");
    const unapprovedFixture = await readFixtureJson<{ name: string; scripts?: Record<string, string> }>(
      "unapproved-install-script/package.json",
    );
    const packageJson = await readRootPackageJson();
    const lockfile = await readRootFile("pnpm-lock.yaml");
    const npmrc = parseNpmrc(await readRootFile(".npmrc"));
    const workspaceYaml = await readRootFile("pnpm-workspace.yaml");

    expect(npmrc.get("strict-dep-builds"), ".npmrc must fail closed on unapproved build scripts").toBe("true");
    expect(npmrc.has("dangerouslyAllowAllBuilds"), ".npmrc must not opt into arbitrary dependency builds").toBe(false);
    expect(workspaceYaml).not.toMatch(/^dangerouslyAllowAllBuilds\s*:/m);
    expect(workspaceYaml).not.toMatch(/^ignoredBuiltDependencies\s*:/m);
    expect(workspaceYaml).not.toMatch(/^onlyBuiltDependencies\s*:/m);
    expect(packageJson.pnpm, "pnpm 11 ignores package.json#pnpm settings; policy must live in pnpm-workspace.yaml").toBeUndefined();
    const lifecycleEvidence = packageJson.infiniteSnowball?.dependencyLifecycle;
    expect(
      lifecycleEvidence?.reviewedOnlyBuiltDependencies,
      "package evidence must not retain the rejected onlyBuiltDependencies terminology",
    ).toBeUndefined();

    const expectedApprovals = snapshot.lifecycleBuildCandidates.filter((entry) =>
      lockHasPackageResolution(lockfile, entry.package, entry.version),
    );
    const reviewedAllowlist = lifecycleEvidence?.reviewedAllowBuilds ?? [];
    const allowBuilds = parseWorkspaceBooleanMap(workspaceYaml, "allowBuilds");
    const approvedLocators = [...allowBuilds.entries()]
      .filter(([, approved]) => approved)
      .map(([locator]) => locator)
      .sort();
    const reviewedLocators = reviewedAllowlist.map((entry) => `${entry.package}@${entry.version}`).sort();
    const resolvedReviewedLocators = [...new Set(reviewedAllowlist.map((entry) => entry.package))]
      .flatMap((packageName) => lockPackageVersions(lockfile, packageName).map((version) => `${packageName}@${version}`))
      .sort();

    expect([...allowBuilds.values()].every(Boolean), "allowBuilds must not silently ignore denied scripts").toBe(true);
    expect(packageJson.infiniteSnowball?.dependencyLifecycle?.policy).toBe("fail-closed");
    validateLifecycleAllowlist(reviewedAllowlist, schema);
    expect(approvedLocators).toEqual(reviewedLocators);
    expect(resolvedReviewedLocators, "every resolved version of an allowed package must have exact review evidence").toEqual(
      reviewedLocators,
    );
    expect(reviewedAllowlist).toEqual(expect.arrayContaining(expectedApprovals));
    expect(reviewedAllowlist).toHaveLength(expectedApprovals.length);

    for (const approval of expectedApprovals) {
      expect(lockHasPackageResolution(lockfile, approval.package, approval.version), `${approval.package} approval must match lock`).toBe(
        true,
      );
    }

    expect(Object.keys(unapprovedFixture.scripts ?? {})).toEqual(expect.arrayContaining(["install"]));
    expect(
      approvedLocators.some(
        (locator) => locator === unapprovedFixture.name || locator.startsWith(`${unapprovedFixture.name}@`),
      ),
      "unapproved install-script fixture must never be silently allowed",
    ).toBe(false);
    expect(reviewedAllowlist.map((entry) => entry.package)).not.toContain(unapprovedFixture.name);
  });
});
