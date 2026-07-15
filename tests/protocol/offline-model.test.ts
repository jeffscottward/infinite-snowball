import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyOfflineEvent,
  collectUnreferencedAssets,
  createOfflineState,
  reconcileOfflineState,
  runInstallScenario,
  type OfflineModelState,
  type PackageLockModel,
} from "../../packages/protocol/src/offline/model.js";

const PREVIOUS_LOCK: PackageLockModel = {
  lockId: "lock:starter:1",
  packages: ["@test/starter@1.0.0"],
  files: ["asset:shared", "asset:old"],
  verified: true,
};

const CANDIDATE_LOCK: PackageLockModel = {
  lockId: "lock:starter:2",
  packages: ["@test/starter@2.0.0"],
  files: ["asset:shared", "asset:new"],
  verified: true,
};

function initialState(): OfflineModelState {
  return createOfflineState({
    activeLock: PREVIOUS_LOCK,
    references: { "asset:shared": 1, "asset:old": 1, "asset:unreferenced": 0 },
    saves: { profile: { level: "winter-garden", score: 1200 } },
    knownGoodShell: "shell:v1",
  });
}

function expectLastKnownGoodPreserved(state: OfflineModelState): void {
  expect(state.activeLock).toEqual(PREVIOUS_LOCK);
  expect(state.locks[PREVIOUS_LOCK.lockId]).toEqual(PREVIOUS_LOCK);
  expect(state.stagingFiles).toEqual([]);
  expect(state.candidateLock).toBeNull();
  expect(state.orphanReferences).toEqual([]);
  expect(state.references).toEqual({ "asset:shared": 1, "asset:old": 1, "asset:unreferenced": 0 });
  expect(state.saves).toEqual({ profile: { level: "winter-garden", score: 1200 } });
  expect(state.knownGoodShell).toBe("shell:v1");
}

describe("offline install transaction model", () => {
  it("models every successful transition and commits a side-by-side update atomically", () => {
    let state = initialState();
    state = applyOfflineEvent(state, {
      type: "plan",
      eventId: "event:plan",
      transactionId: "tx:2",
      candidateLock: CANDIDATE_LOCK,
      requiredFiles: CANDIDATE_LOCK.files,
      expectedBytes: 2_048,
      quotaAvailable: 4_096,
      persistenceGranted: true,
      online: true,
      cachedFiles: [],
    });
    expect(state.transaction?.state).toBe("planned");
    expect(state.activeLock).toEqual(PREVIOUS_LOCK);

    state = applyOfflineEvent(state, { type: "start-staging", eventId: "event:stage" });
    expect(state.transaction?.state).toBe("staging");
    state = applyOfflineEvent(state, { type: "stage-file", eventId: "event:file-1", file: "asset:shared" });
    state = applyOfflineEvent(state, { type: "stage-file", eventId: "event:file-2", file: "asset:new" });
    state = applyOfflineEvent(state, { type: "start-verifying", eventId: "event:verify" });
    expect(state.transaction?.state).toBe("verifying");
    state = applyOfflineEvent(state, { type: "verify-file", eventId: "event:verified-1", file: "asset:shared" });
    state = applyOfflineEvent(state, { type: "verify-file", eventId: "event:verified-2", file: "asset:new" });
    state = applyOfflineEvent(state, { type: "start-committing", eventId: "event:commit-start" });
    expect(state.transaction?.state).toBe("committing");
    state = applyOfflineEvent(state, { type: "commit", eventId: "event:commit" });

    expect(state.transaction?.state).toBe("installed");
    expect(state.activeLock).toEqual(CANDIDATE_LOCK);
    expect(state.locks).toMatchObject({ [PREVIOUS_LOCK.lockId]: PREVIOUS_LOCK, [CANDIDATE_LOCK.lockId]: CANDIDATE_LOCK });
    expect(state.references).toEqual({ "asset:shared": 2, "asset:old": 1, "asset:unreferenced": 0, "asset:new": 1 });
    expect(state.stagingFiles).toEqual([]);
    expect(state.candidateLock).toBeNull();
    expect(state.transaction?.audit).toEqual([
      "quota-preflight",
      "persistence-request",
      "planned",
      "staging",
      "verifying",
      "committing",
      "installed",
    ]);
  });

  it("rejects incomplete, duplicate, or unverified candidate file sets before staging", () => {
    const scenarios = [
      { candidateLock: CANDIDATE_LOCK, requiredFiles: [] },
      {
        candidateLock: { ...CANDIDATE_LOCK, files: [...CANDIDATE_LOCK.files, "asset:new"] },
        requiredFiles: [...CANDIDATE_LOCK.files, "asset:new"],
      },
      { candidateLock: { ...CANDIDATE_LOCK, verified: false }, requiredFiles: CANDIDATE_LOCK.files },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const result = runInstallScenario(initialState(), {
        transactionId: `tx:invalid-files:${index}`,
        candidateLock: scenario.candidateLock,
        requiredFiles: scenario.requiredFiles,
        expectedBytes: 2_048,
        quotaAvailable: 4_096,
        persistenceGranted: true,
        online: true,
        cachedFiles: [],
      });
      expect(result.transaction?.state).toBe("failed");
      expect(result.transaction?.error?.ruleId).toBe("E_LOCK_MISMATCH");
      expectLastKnownGoodPreserved(result);
    }
  });

  it("rejects divergent reuse of an existing immutable lock ID before staging", () => {
    const divergentLock: PackageLockModel = {
      ...CANDIDATE_LOCK,
      lockId: PREVIOUS_LOCK.lockId,
    };

    const result = runInstallScenario(initialState(), {
      transactionId: "tx:divergent-lock-id",
      candidateLock: divergentLock,
      requiredFiles: divergentLock.files,
      expectedBytes: 2_048,
      quotaAvailable: 4_096,
      persistenceGranted: true,
      online: true,
      cachedFiles: [],
    });

    expect(result.transaction?.state).toBe("failed");
    expect(result.transaction?.error?.ruleId).toBe("E_LOCK_MISMATCH");
    expectLastKnownGoodPreserved(result);
    expect(result.locks).toEqual({ [PREVIOUS_LOCK.lockId]: PREVIOUS_LOCK });
  });

  it("reactivates a byte-identical existing lock without double-counting file references", () => {
    const stateWithInstalledCandidate = initialState();
    stateWithInstalledCandidate.locks[CANDIDATE_LOCK.lockId] = structuredClone(CANDIDATE_LOCK);
    stateWithInstalledCandidate.references = {
      ...stateWithInstalledCandidate.references,
      "asset:shared": 2,
      "asset:new": 1,
    };
    stateWithInstalledCandidate.saves = { profile: { level: "spring-thaw", score: 2400 } };

    const result = runInstallScenario(stateWithInstalledCandidate, {
      transactionId: "tx:reactivate-identical",
      candidateLock: CANDIDATE_LOCK,
      requiredFiles: CANDIDATE_LOCK.files,
      expectedBytes: 2_048,
      quotaAvailable: 4_096,
      persistenceGranted: true,
      online: true,
      cachedFiles: [],
    });

    expect(result.transaction).toMatchObject({ transactionId: "tx:reactivate-identical", state: "installed" });
    expect(result.activeLock).toEqual(CANDIDATE_LOCK);
    expect(result.locks[CANDIDATE_LOCK.lockId]).toEqual(CANDIDATE_LOCK);
    expect(result.references).toEqual({
      "asset:shared": 2,
      "asset:old": 1,
      "asset:unreferenced": 0,
      "asset:new": 1,
    });
    expect(result.saves).toEqual({ profile: { level: "spring-thaw", score: 2400 } });
  });

  it("treats schema-valid prototype-keyed locks and file references as own records", () => {
    const prototypeLock: PackageLockModel = {
      lockId: "__proto__",
      packages: ["@test/prototype@1.0.0"],
      files: ["toString"],
      verified: true,
    };

    const result = runInstallScenario(
      createOfflineState({
        activeLock: null,
        references: {},
        saves: { constructor: { level: "prototype-cabin", score: 10 } },
        knownGoodShell: "shell:v1",
      }),
      {
        transactionId: "tx:prototype-keys",
        candidateLock: prototypeLock,
        requiredFiles: prototypeLock.files,
        expectedBytes: 1,
        quotaAvailable: 1,
        persistenceGranted: true,
        online: true,
        cachedFiles: [],
      },
    );

    expect(result.transaction?.state).toBe("installed");
    expect(Object.hasOwn(result.locks, "__proto__")).toBe(true);
    expect(result.locks["__proto__"]).toEqual(prototypeLock);
    expect(Object.hasOwn(result.references, "toString")).toBe(true);
    expect(result.references["toString"]).toBe(1);
    expect(Object.hasOwn(result.saves, "constructor")).toBe(true);
    expect(result.saves["constructor"]).toEqual({ level: "prototype-cabin", score: 10 });
  });


  it("rejects invalid transitions and leaves installed terminal transactions immutable", () => {
    let planned = applyOfflineEvent(initialState(), {
      type: "plan",
      eventId: "event:negative-plan",
      transactionId: "tx:negative",
      candidateLock: CANDIDATE_LOCK,
      requiredFiles: CANDIDATE_LOCK.files,
      expectedBytes: 2_048,
      quotaAvailable: 4_096,
      persistenceGranted: true,
      online: true,
      cachedFiles: [],
    });
    planned = applyOfflineEvent(planned, { type: "commit", eventId: "event:early-commit" });
    expect(planned.transaction?.state).toBe("failed");
    expect(planned.transaction?.error?.ruleId).toBe("E_TRANSACTION_STATE");
    expectLastKnownGoodPreserved(planned);

    const installed = runInstallScenario(initialState(), {
      transactionId: "tx:terminal",
      candidateLock: CANDIDATE_LOCK,
      requiredFiles: CANDIDATE_LOCK.files,
      expectedBytes: 2_048,
      quotaAvailable: 4_096,
      persistenceGranted: true,
      online: true,
      cachedFiles: [],
    });
    const canceled = applyOfflineEvent(installed, { type: "cancel", eventId: "event:late-cancel", at: "installed" });
    const failed = applyOfflineEvent(installed, {
      type: "fail",
      eventId: "event:late-fail",
      faultAt: "late-fail",
      ruleId: "E_CACHE_WRITE",
    });
    expect(canceled).toEqual(installed);
    expect(failed).toEqual(installed);
  });
  it("serializes plans and requires reconciliation before a failed-transaction retry", () => {
    const firstPlan = {
      type: "plan" as const,
      eventId: "event:first-plan",
      transactionId: "tx:first",
      candidateLock: CANDIDATE_LOCK,
      requiredFiles: CANDIDATE_LOCK.files,
      expectedBytes: 2_048,
      quotaAvailable: 4_096,
      persistenceGranted: true,
      online: true,
      cachedFiles: [] as string[],
    };
    const planned = applyOfflineEvent(initialState(), firstPlan);
    const competing = applyOfflineEvent(planned, {
      ...firstPlan,
      eventId: "event:competing-plan",
      transactionId: "tx:competing",
    });
    expect(competing).toEqual(planned);

    const failed = applyOfflineEvent(planned, {
      type: "fail",
      eventId: "event:first-failure",
      faultAt: "stage-write",
      ruleId: "E_CACHE_WRITE",
    });
    expect(failed.transactionHistory["tx:first"]).toMatchObject({
      state: "failed",
      reconciliationStatus: "required",
      error: { ruleId: "E_CACHE_WRITE" },
    });
    const prematureRetry = applyOfflineEvent(failed, {
      ...firstPlan,
      eventId: "event:premature-retry",
      transactionId: "tx:retry",
    });
    expect(prematureRetry).toEqual(failed);

    const reconciled = reconcileOfflineState(failed);
    const retry = applyOfflineEvent(reconciled, {
      ...firstPlan,
      eventId: "event:reconciled-retry",
      transactionId: "tx:retry",
    });
    expect(retry.transaction).toMatchObject({ transactionId: "tx:retry", state: "planned" });
    expect(retry.transactionHistory["tx:first"]).toMatchObject({
      state: "failed",
      reconciliationStatus: "reconciled",
      error: { ruleId: "E_CACHE_WRITE" },
    });
  });

  it("rejects non-finite, fractional, or negative install preflight byte values", () => {
    for (const [index, expectedBytes] of [Number.NaN, -1, 1.5].entries()) {
      const result = runInstallScenario(initialState(), {
        transactionId: `tx:invalid-expected:${index}`,
        candidateLock: CANDIDATE_LOCK,
        requiredFiles: CANDIDATE_LOCK.files,
        expectedBytes,
        quotaAvailable: 4_096,
        persistenceGranted: true,
        online: true,
        cachedFiles: [],
      });
      expect(result.transaction?.error?.ruleId, String(expectedBytes)).toBe("E_FILE_BUDGET");
      expectLastKnownGoodPreserved(result);
    }

    const invalidQuota = runInstallScenario(initialState(), {
      transactionId: "tx:invalid-quota",
      candidateLock: CANDIDATE_LOCK,
      requiredFiles: CANDIDATE_LOCK.files,
      expectedBytes: 2_048,
      quotaAvailable: Number.NaN,
      persistenceGranted: true,
      online: true,
      cachedFiles: [],
    });
    expect(invalidQuota.transaction?.error?.ruleId).toBe("E_QUOTA");
    expectLastKnownGoodPreserved(invalidQuota);
  });


  it("preserves the previous lock and removes staging/orphans at every injected failure point", async () => {
    const faultPoints = JSON.parse(
      await readFile(join(process.cwd(), "tests", "fixtures", "protocol", "offline", "fault-points.json"), "utf8"),
    ) as string[];
    expect(faultPoints).toHaveLength(12);

    for (const faultAt of faultPoints) {
      const result = runInstallScenario(initialState(), {
        transactionId: `tx:fault:${faultAt}`,
        candidateLock: CANDIDATE_LOCK,
        requiredFiles: CANDIDATE_LOCK.files,
        expectedBytes: 2_048,
        quotaAvailable: 4_096,
        persistenceGranted: true,
        online: true,
        cachedFiles: [],
        faultAt,
      });

      expect(result.transaction?.state, faultAt).toBe("failed");
      expect(result.transaction?.error?.ruleId, faultAt).toMatch(/^E_/);
      expect(result.transaction?.rollbackActions.length, faultAt).toBeGreaterThan(0);
      expect(result.transaction?.reconciliationStatus, faultAt).toBe("required");
      expectLastKnownGoodPreserved(result);
    }
  });

  it.each(["planned", "staging", "verifying", "committing"] as const)(
    "cancels from %s without mutating the active lock",
    (cancelAt) => {
      const result = runInstallScenario(initialState(), {
        transactionId: `tx:cancel:${cancelAt}`,
        candidateLock: CANDIDATE_LOCK,
        requiredFiles: CANDIDATE_LOCK.files,
        expectedBytes: 2_048,
        quotaAvailable: 4_096,
        persistenceGranted: true,
        online: true,
        cachedFiles: [],
        cancelAt,
      });

      expect(result.transaction?.state).toBe("canceled");
      expectLastKnownGoodPreserved(result);
    },
  );

  it("fails offline before mutation unless every locked object is verified and cached", () => {
    const missing = runInstallScenario(initialState(), {
      transactionId: "tx:offline-missing",
      candidateLock: CANDIDATE_LOCK,
      requiredFiles: CANDIDATE_LOCK.files,
      expectedBytes: 2_048,
      quotaAvailable: 4_096,
      persistenceGranted: true,
      online: false,
      cachedFiles: ["asset:shared"],
    });
    expect(missing.transaction?.error?.ruleId).toBe("E_OFFLINE_MISSING_ASSET");
    expectLastKnownGoodPreserved(missing);

    const cached = runInstallScenario(initialState(), {
      transactionId: "tx:offline-cached",
      candidateLock: CANDIDATE_LOCK,
      requiredFiles: CANDIDATE_LOCK.files,
      expectedBytes: 2_048,
      quotaAvailable: 4_096,
      persistenceGranted: true,
      online: false,
      cachedFiles: CANDIDATE_LOCK.files,
    });
    expect(cached.transaction?.state).toBe("installed");
    expect(cached.activeLock).toEqual(CANDIDATE_LOCK);
  });

  it("is idempotent for replayed events and transaction IDs", () => {
    const event = {
      type: "plan" as const,
      eventId: "event:once",
      transactionId: "tx:idempotent",
      candidateLock: CANDIDATE_LOCK,
      requiredFiles: CANDIDATE_LOCK.files,
      expectedBytes: 2_048,
      quotaAvailable: 4_096,
      persistenceGranted: true,
      online: true,
      cachedFiles: [] as string[],
    };
    const once = applyOfflineEvent(initialState(), event);
    expect(applyOfflineEvent(once, event)).toEqual(once);

    const firstRun = runInstallScenario(initialState(), { ...event, eventId: undefined });
    expect(runInstallScenario(firstRun, { ...event, eventId: undefined })).toEqual(firstRun);
  });

  it("blocks withdrawn new installs while retaining existing locks and history", () => {
    const withdrawn = applyOfflineEvent(initialState(), {
      type: "withdraw-package",
      eventId: "event:withdraw",
      package: "@test/starter@2.0.0",
      replacement: "@test/starter@2.0.1",
    });
    const result = runInstallScenario(withdrawn, {
      transactionId: "tx:withdrawn",
      candidateLock: CANDIDATE_LOCK,
      requiredFiles: CANDIDATE_LOCK.files,
      expectedBytes: 2_048,
      quotaAvailable: 4_096,
      persistenceGranted: true,
      online: true,
      cachedFiles: [],
    });

    expect(result.transaction?.error?.ruleId).toBe("E_PACKAGE_WITHDRAWN");
    expectLastKnownGoodPreserved(result);
    expect(result.withdrawals["@test/starter@2.0.0"]).toBe("@test/starter@2.0.1");
  });
  it("rechecks withdrawal immediately before commit to close the planning race", () => {
    let state = applyOfflineEvent(initialState(), {
      type: "plan",
      eventId: "event:race-plan",
      transactionId: "tx:withdrawal-race",
      candidateLock: CANDIDATE_LOCK,
      requiredFiles: CANDIDATE_LOCK.files,
      expectedBytes: 2_048,
      quotaAvailable: 4_096,
      persistenceGranted: true,
      online: true,
      cachedFiles: [],
    });
    state = applyOfflineEvent(state, { type: "start-staging", eventId: "event:race-stage" });
    for (const file of CANDIDATE_LOCK.files) {
      state = applyOfflineEvent(state, { type: "stage-file", eventId: `event:race-stage:${file}`, file });
    }
    state = applyOfflineEvent(state, { type: "start-verifying", eventId: "event:race-verify" });
    for (const file of CANDIDATE_LOCK.files) {
      state = applyOfflineEvent(state, { type: "verify-file", eventId: `event:race-verify:${file}`, file });
    }
    state = applyOfflineEvent(state, { type: "start-committing", eventId: "event:race-commit-start" });
    state = applyOfflineEvent(state, {
      type: "withdraw-package",
      eventId: "event:race-withdraw",
      package: "@test/starter@2.0.0",
      replacement: "@test/starter@2.0.1",
    });
    state = applyOfflineEvent(state, { type: "commit", eventId: "event:race-commit" });

    expect(state.transaction?.error?.ruleId).toBe("E_PACKAGE_WITHDRAWN");
    expectLastKnownGoodPreserved(state);
  });

  it("rechecks immutable lock ID reuse immediately before commit", () => {
    let state = applyOfflineEvent(initialState(), {
      type: "plan",
      eventId: "event:lock-race-plan",
      transactionId: "tx:lock-race",
      candidateLock: CANDIDATE_LOCK,
      requiredFiles: CANDIDATE_LOCK.files,
      expectedBytes: 2_048,
      quotaAvailable: 4_096,
      persistenceGranted: true,
      online: true,
      cachedFiles: [],
    });
    state = applyOfflineEvent(state, { type: "start-staging", eventId: "event:lock-race-stage" });
    for (const file of CANDIDATE_LOCK.files) {
      state = applyOfflineEvent(state, { type: "stage-file", eventId: `event:lock-race-stage:${file}`, file });
    }
    state = applyOfflineEvent(state, { type: "start-verifying", eventId: "event:lock-race-verify" });
    for (const file of CANDIDATE_LOCK.files) {
      state = applyOfflineEvent(state, { type: "verify-file", eventId: `event:lock-race-verify:${file}`, file });
    }
    state = applyOfflineEvent(state, { type: "start-committing", eventId: "event:lock-race-commit-start" });

    const racedLock: PackageLockModel = {
      ...CANDIDATE_LOCK,
      packages: ["@test/raced@1.0.0"],
    };
    const expectedLocks = { ...state.locks, [racedLock.lockId]: racedLock };
    state = { ...state, locks: expectedLocks };
    state = applyOfflineEvent(state, { type: "commit", eventId: "event:lock-race-commit" });

    expect(state.transaction?.state).toBe("failed");
    expect(state.transaction?.error?.ruleId).toBe("E_LOCK_MISMATCH");
    expectLastKnownGoodPreserved(state);
    expect(state.locks).toEqual(expectedLocks);
  });


  it("reconciles metadata/cache drift and garbage-collects only zero-reference assets", () => {
    const drifted = initialState();
    drifted.stagingFiles = ["asset:stale-stage"];
    drifted.orphanReferences = ["asset:orphan"];
    drifted.references["asset:shared"] = 99;
    drifted.references["asset:old"] = 0;
    const incompleteLock: PackageLockModel = {
      lockId: "lock:incomplete",
      packages: ["@test/incomplete@1.0.0"],
      files: ["asset:stale-unverified"],
      verified: false,
    };
    drifted.locks[incompleteLock.lockId] = incompleteLock;
    drifted.candidateLock = incompleteLock;
    drifted.references["asset:stale-unverified"] = 1;

    const reconciled = reconcileOfflineState(drifted);
    expect(reconciled.stagingFiles).toEqual([]);
    expect(reconciled.orphanReferences).toEqual([]);
    expect(reconciled.references["asset:shared"]).toBe(1);
    expect(reconciled.references["asset:old"]).toBe(1);
    expect(reconciled.reconciliationLog).toContain("repaired-reference-counts");
    expect(reconciled.reconciliationLog).not.toContain("repaired-active-lock-pointer");
    expect(reconciled.locks).not.toHaveProperty(incompleteLock.lockId);
    expect(reconciled.candidateLock).toBeNull();
    expect(reconciled.references["asset:stale-unverified"]).toBe(0);

    const collected = collectUnreferencedAssets(reconciled);
    expect(collected.removed).toEqual(["asset:stale-unverified", "asset:unreferenced"]);
    expect(collected.state.references).toMatchObject({ "asset:shared": 1, "asset:old": 1 });
  });
  it("reconciles the active pointer to its authoritative verified lock record", () => {
    const drifted = initialState();
    drifted.activeLock = {
      ...PREVIOUS_LOCK,
      packages: ["@test/forged@9.9.9"],
      files: ["asset:forged"],
    };
    drifted.references["asset:forged"] = 1;

    const reconciled = reconcileOfflineState(drifted);

    expect(reconciled.activeLock).toEqual(reconciled.locks[PREVIOUS_LOCK.lockId]);
    expect(reconciled.activeLock).toEqual(PREVIOUS_LOCK);
    expect(reconciled.references).toMatchObject({
      "asset:shared": 1,
      "asset:old": 1,
      "asset:forged": 0,
    });
    expect(reconciled.reconciliationLog).toContain("repaired-active-lock-pointer");
  });

  it("clears an active pointer without an authoritative verified lock record", () => {
    const drifted = initialState();
    drifted.activeLock = {
      lockId: "lock:dangling",
      packages: ["@test/dangling@1.0.0"],
      files: ["asset:dangling"],
      verified: true,
    };

    const reconciled = reconcileOfflineState(drifted);

    expect(reconciled.activeLock).toBeNull();
    expect(reconciled.locks).not.toHaveProperty("lock:dangling");
    expect(reconciled.reconciliationLog).toContain("cleared-invalid-active-lock-pointer");
  });

  it("fails and reconciles an abandoned pre-commit transaction on startup", () => {
    let state = applyOfflineEvent(initialState(), {
      type: "plan",
      eventId: "event:abandoned-plan",
      transactionId: "tx:abandoned",
      candidateLock: CANDIDATE_LOCK,
      requiredFiles: CANDIDATE_LOCK.files,
      expectedBytes: 2_048,
      quotaAvailable: 4_096,
      persistenceGranted: true,
      online: true,
      cachedFiles: [],
    });
    state = applyOfflineEvent(state, { type: "start-staging", eventId: "event:abandoned-stage" });
    state = applyOfflineEvent(state, {
      type: "stage-file",
      eventId: "event:abandoned-file",
      file: CANDIDATE_LOCK.files[0] ?? "missing",
    });

    const reconciled = reconcileOfflineState(state);
    expect(reconciled.transaction).toMatchObject({
      state: "failed",
      reconciliationStatus: "reconciled",
      error: { ruleId: "E_TRANSACTION_STATE" },
    });
    expectLastKnownGoodPreserved(reconciled);
  });


  it("retains saves, active data, and the known-good shell on migration failure", () => {
    const result = applyOfflineEvent(initialState(), {
      type: "migration-failed",
      eventId: "event:migration",
      migration: "dexie:v2",
      details: "health check failed",
    });

    expect(result.migrations["dexie:v2"]?.ruleId).toBe("E_MIGRATION");
    expectLastKnownGoodPreserved(result);
  });
});
