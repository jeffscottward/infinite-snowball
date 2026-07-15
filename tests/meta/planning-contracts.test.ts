import { execFile } from "node:child_process";
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const VALIDATOR = join(ROOT, "tools", "planning", "validate-contracts.mjs");

type PlanningReport = {
  schemaVersion: number;
  overallPass: boolean;
  generatedByCommand: string;
  counts: {
    phases: number;
    primaryGates: number;
    supplementalGates: number;
    orphanGateRefs: number;
    gateDefinitions: number;
    expectedGateDefinitions: number;
    forbiddenPathspecs: number;
    expectedForbiddenPathspecs: number;
  };
  deliverables: {
    primaryGateIds: string[];
    supplementalGateIds: string[];
  };
  commandOwnership: {
    owned: boolean;
    registryMissing: string[];
    staleRefs: string[];
    requiredReleaseProjects: string[];
  };
  forbiddenTrackedPaths: {
    complete: boolean;
    missing: string[];
  };
  sourceHashes: Array<{ path: string; exists: boolean; sha256?: string }>;
  repoState: {
    current: { head: string | null; branch: string | null; detachedHead: boolean; status: { total: number; dirty: boolean } };
    history: {
      sourcePath: string;
      publicRepositoryLine: string | null;
      publicationBoundaryLine: string | null;
      preservesPublicInitialization: boolean;
    };
    separatedHistoricalAndCurrent: boolean;
  };
};

async function runValidator(): Promise<PlanningReport> {
  const tempRoot = await mkdtemp(join(tmpdir(), "infinite-snowball-planning-contracts-"));
  const reportPath = join(tempRoot, "validation-report.json");
  try {
    await mkdir(join(tempRoot, ".maestro"), { recursive: true });
    await cp(join(ROOT, ".maestro", "playbooks"), join(tempRoot, ".maestro", "playbooks"), { recursive: true });
    await Promise.all(
      [
        ".planning/architecture-decisions.md",
        ".planning/deliverable-traceability.md",
        ".planning/system-contracts.md",
        "tools/planning/validate-contracts.mjs",
        "tools/quality/forbidden-tracked-paths.mjs",
        "tests/meta/planning-contracts.test.ts",
      ].map(async (path) => {
        const destination = join(tempRoot, path);
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(join(ROOT, path), destination);
      }),
    );
    await expect(access(join(tempRoot, ".omp-status.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await execFileAsync(process.execPath, [VALIDATOR, "--root", tempRoot, "--write", reportPath], {
      cwd: ROOT,
      env: {
        ...process.env,
        CI: "1",
        GIT_DIR: join(ROOT, ".git"),
        GIT_WORK_TREE: tempRoot,
      },
    });
    return JSON.parse(await readFile(reportPath, "utf8")) as PlanningReport;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function normalizeForFreshness(report: PlanningReport): Omit<PlanningReport, "repoState"> & {
  repoState: Omit<PlanningReport["repoState"], "current">;
} {
  const { current: _current, ...stableRepoState } = report.repoState;
  return { ...report, repoState: stableRepoState };
}

describe("planning contract validator", () => {
  it("reports the executable gate contract shape", async () => {
    const report = await runValidator();

    expect(report.overallPass).toBe(true);
    expect(report.schemaVersion).toBe(3);
    expect(report.generatedByCommand).toBe("node tools/planning/validate-contracts.mjs --write .planning/validation-report.json");
    expect(report.counts.phases).toBe(11);
    expect(report.counts.primaryGates).toBe(42);
    expect(report.counts.supplementalGates).toBe(1);
    expect(report.counts.orphanGateRefs).toBe(0);
    expect(report.counts.gateDefinitions).toBe(43);
    expect(report.counts.expectedGateDefinitions).toBe(43);
    expect(report.deliverables.supplementalGateIds).toEqual(["VG-05-CSP-WASM"]);
    expect(report.deliverables.primaryGateIds).not.toContain("VG-05-CSP-WASM");
  });

  it("requires owned planning commands, matrix projects, and the full forbidden-path set", async () => {
    const report = await runValidator();

    expect(report.commandOwnership.owned).toBe(true);
    expect(report.commandOwnership.registryMissing).toEqual([]);
    expect(report.commandOwnership.staleRefs).toEqual([]);
    expect(report.commandOwnership.requiredReleaseProjects).toEqual(
      expect.arrayContaining([
        "chromium",
        "firefox",
        "playwright-webkit",
        "mobile-chromium",
        "mobile-webkit",
        "shipping macOS Safari",
        "real iPhone Safari",
      ]),
    );
    expect(report.forbiddenTrackedPaths.complete).toBe(true);
    expect(report.forbiddenTrackedPaths.missing).toEqual([]);
    expect(report.counts.forbiddenPathspecs).toBeGreaterThanOrEqual(report.counts.expectedForbiddenPathspecs);
  });

  it("records current source hashes while preserving tracked history separately", async () => {
    const report = await runValidator();
    const hashedPaths = new Map(report.sourceHashes.map((entry) => [entry.path, entry]));

    for (const path of [
      ".planning/deliverable-traceability.md",
      ".planning/system-contracts.md",
      ".maestro/playbooks/Infinite-Snowball-Phase-05-First-Playable-Vertical-Slice.md",
      ".maestro/playbooks/Infinite-Snowball-Phase-10-Cross-Device-QA-Performance-Review.md",
      ".maestro/playbooks/Infinite-Snowball-Phase-11-Public-Release-Deployment-Audit.md",
      "tools/planning/validate-contracts.mjs",
      "tools/quality/forbidden-tracked-paths.mjs",
      "tests/meta/planning-contracts.test.ts",
    ]) {
      expect(hashedPaths.get(path)?.exists, `${path} hash must be present`).toBe(true);
      expect(hashedPaths.get(path)?.sha256, `${path} hash must be sha256`).toMatch(/^[a-f0-9]{64}$/);
    }

    expect(hashedPaths.has(".omp-status.md")).toBe(false);

    expect(report.repoState.current.head).toMatch(/^[a-f0-9]{40}$/);
    expect(report.repoState.current.branch || report.repoState.current.detachedHead).toBeTruthy();
    expect(report.repoState.separatedHistoricalAndCurrent).toBe(true);
    expect(report.repoState.history.sourcePath).toBe(".planning/architecture-decisions.md");
    expect(report.repoState.history.preservesPublicInitialization).toBe(true);
    expect(report.repoState.history.publicRepositoryLine).toContain("PUBLIC");
    expect(report.repoState.history.publicationBoundaryLine).toContain("only the existing Phase 01 commit was pushed");
  });

  it("rejects the ignored checkpoint as a validator input", async () => {
    await expect(
      execFileAsync(process.execPath, [VALIDATOR, "--checkpoint", ".omp-status.md"], {
        cwd: ROOT,
        env: { ...process.env, CI: "1" },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown argument: --checkpoint"),
    });
  });

  it("keeps the checked-in validation report fresh", async () => {
    const report = await runValidator();
    const checkedIn = JSON.parse(await readFile(join(ROOT, ".planning", "validation-report.json"), "utf8")) as PlanningReport;

    expect(normalizeForFreshness(checkedIn)).toEqual(normalizeForFreshness(report));
  });
});
