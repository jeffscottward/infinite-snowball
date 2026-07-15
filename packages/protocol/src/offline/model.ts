import { validationIssue, type ErrorCode, type ValidationIssue } from "../errors.js";

export interface PackageLockModel {
  lockId: string;
  packages: string[];
  files: string[];
  verified: boolean;
}

export type InstallState = "planned" | "staging" | "verifying" | "committing" | "installed" | "failed" | "canceled";

export interface OfflineTransactionModel {
  transactionId: string;
  state: InstallState;
  candidateLockId: string;
  requiredFiles: string[];
  verifiedFiles: string[];
  expectedBytes: number;
  baselineReferences: Record<string, number>;
  error: ValidationIssue | null;
  rollbackActions: string[];
  reconciliationStatus: "clean" | "required" | "reconciled";
  audit: string[];
}

export interface OfflineModelState {
  activeLock: PackageLockModel | null;
  locks: Record<string, PackageLockModel>;
  references: Record<string, number>;
  saves: Record<string, unknown>;
  knownGoodShell: string;
  transaction: OfflineTransactionModel | null;
  transactionHistory: Record<string, OfflineTransactionModel>;
  stagingFiles: string[];
  candidateLock: PackageLockModel | null;
  orphanReferences: string[];
  processedEventIds: string[];
  withdrawals: Record<string, string | null>;
  reconciliationLog: string[];
  migrations: Record<string, ValidationIssue>;
}

interface PlanEvent {
  type: "plan";
  eventId: string;
  transactionId: string;
  candidateLock: PackageLockModel;
  requiredFiles: string[];
  expectedBytes: number;
  quotaAvailable: number;
  persistenceGranted: boolean;
  online: boolean;
  cachedFiles: string[];
}

type OfflineEvent =
  | PlanEvent
  | { type: "start-staging"; eventId: string }
  | { type: "stage-file"; eventId: string; file: string }
  | { type: "start-verifying"; eventId: string }
  | { type: "verify-file"; eventId: string; file: string }
  | { type: "start-committing"; eventId: string }
  | { type: "commit"; eventId: string }
  | { type: "cancel"; eventId: string; at: InstallState }
  | { type: "fail"; eventId: string; faultAt: string; ruleId: ErrorCode }
  | { type: "withdraw-package"; eventId: string; package: string; replacement: string | null }
  | { type: "migration-failed"; eventId: string; migration: string; details: string };

export interface InstallScenario {
  eventId?: string | undefined;
  transactionId: string;
  candidateLock: PackageLockModel;
  requiredFiles: string[];
  expectedBytes: number;
  quotaAvailable: number;
  persistenceGranted: boolean;
  online: boolean;
  cachedFiles: string[];
  faultAt?: string | undefined;
  cancelAt?: "planned" | "staging" | "verifying" | "committing" | undefined;
}

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function cloneRecord<T>(record: Record<string, T>): Record<string, T> {
  const clone = emptyRecord<T>();
  for (const [key, value] of Object.entries(record)) clone[key] = structuredClone(value);
  return clone;
}

function cloneTransaction(transaction: OfflineTransactionModel): OfflineTransactionModel {
  const clone = structuredClone(transaction);
  clone.baselineReferences = cloneRecord(clone.baselineReferences);
  return clone;
}

function cloneTransactionHistory(
  transactionHistory: Record<string, OfflineTransactionModel>,
): Record<string, OfflineTransactionModel> {
  const clone = emptyRecord<OfflineTransactionModel>();
  for (const [transactionId, transaction] of Object.entries(transactionHistory)) {
    clone[transactionId] = cloneTransaction(transaction);
  }
  return clone;
}

function ownRecordValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function incrementCount(record: Record<string, number>, key: string): void {
  record[key] = (ownRecordValue(record, key) ?? 0) + 1;
}

function cloneOfflineState(current: OfflineModelState): OfflineModelState {
  const state = structuredClone(current);
  state.locks = cloneRecord(state.locks);
  state.references = cloneRecord(state.references);
  state.saves = cloneRecord(state.saves);
  state.transactionHistory = cloneTransactionHistory(state.transactionHistory);
  state.withdrawals = cloneRecord(state.withdrawals);
  state.migrations = cloneRecord(state.migrations);
  if (state.transaction !== null) state.transaction = cloneTransaction(state.transaction);
  return state;
}


export function createOfflineState(input: {
  activeLock: PackageLockModel | null;
  references: Record<string, number>;
  saves: Record<string, unknown>;
  knownGoodShell: string;
}): OfflineModelState {
  const activeLock = input.activeLock === null ? null : structuredClone(input.activeLock);
  const locks = emptyRecord<PackageLockModel>();
  if (activeLock !== null) locks[activeLock.lockId] = structuredClone(activeLock);
  return {
    activeLock,
    locks,
    references: cloneRecord(input.references),
    saves: cloneRecord(input.saves),
    knownGoodShell: input.knownGoodShell,
    transaction: null,
    transactionHistory: emptyRecord<OfflineTransactionModel>(),
    stagingFiles: [],
    candidateLock: null,
    orphanReferences: [],
    processedEventIds: [],
    withdrawals: emptyRecord<string | null>(),
    reconciliationLog: [],
    migrations: emptyRecord<ValidationIssue>(),
  };
}

function remember(state: OfflineModelState, eventId: string): OfflineModelState {
  if (!state.processedEventIds.includes(eventId)) state.processedEventIds.push(eventId);
  return state;
}
function retainCurrentTransaction(state: OfflineModelState): void {
  if (state.transaction !== null) {
    state.transactionHistory[state.transaction.transactionId] = cloneTransaction(state.transaction);
  }
}


function failedState(state: OfflineModelState, ruleId: ErrorCode, faultAt: string): OfflineModelState {
  const transaction = state.transaction;
  if (transaction === null) return state;
  transaction.state = "failed";
  transaction.error = validationIssue({
    ruleId,
    path: `/installTransactions/${transaction.transactionId}/${faultAt}`,
    package: state.candidateLock?.packages[0] ?? "unknown",
    observed: faultAt,
    allowed: "successful preflight, staged verification, and atomic commit",
    remediation: "Preserve the previous lock, remove staging, retain failure evidence, and reconcile before retry.",
  });
  transaction.rollbackActions = ["delete-staging-cache", "discard-candidate-lock", "restore-reference-counts"];
  transaction.reconciliationStatus = "required";
  transaction.audit.push("failed");
  state.references = cloneRecord(transaction.baselineReferences);
  state.stagingFiles = [];
  state.candidateLock = null;
  state.orphanReferences = [];
  retainCurrentTransaction(state);
  return state;
}

function canceledState(state: OfflineModelState): OfflineModelState {
  const transaction = state.transaction;
  if (transaction === null) return state;
  transaction.state = "canceled";
  transaction.error = null;
  transaction.rollbackActions = ["delete-staging-cache", "discard-candidate-lock", "restore-reference-counts"];
  transaction.reconciliationStatus = "required";
  transaction.audit.push("canceled");
  state.references = cloneRecord(transaction.baselineReferences);
  state.stagingFiles = [];
  state.candidateLock = null;
  state.orphanReferences = [];
  retainCurrentTransaction(state);
  return state;
}

function transitionFailure(state: OfflineModelState, event: OfflineEvent): OfflineModelState {
  return failedState(state, "E_TRANSACTION_STATE", event.type);
}

function hasExactUniqueFiles(left: string[], right: string[]): boolean {
  if (new Set(left).size !== left.length || new Set(right).size !== right.length || left.length !== right.length) {
    return false;
  }
  const sortedRight = [...right].sort();
  return [...left].sort().every((file, index) => file === sortedRight[index]);
}
function packageLocksEqual(left: PackageLockModel, right: PackageLockModel): boolean {
  return (
    left.lockId === right.lockId &&
    left.verified === right.verified &&
    left.packages.length === right.packages.length &&
    left.packages.every((packageId, index) => packageId === right.packages[index]) &&
    left.files.length === right.files.length &&
    left.files.every((file, index) => file === right.files[index])
  );
}

export function applyOfflineEvent(current: OfflineModelState, event: OfflineEvent): OfflineModelState {
  if (current.processedEventIds.includes(event.eventId)) return current;
  if (event.type === "plan" && current.transaction !== null) {
    if (current.transaction.transactionId === event.transactionId) return current;
    const previousIsComplete =
      current.transaction.state === "installed" ||
      (["failed", "canceled"].includes(current.transaction.state) &&
        current.transaction.reconciliationStatus === "reconciled");
    if (!previousIsComplete) return current;
  }
  if (
    event.type !== "plan" &&
    event.type !== "withdraw-package" &&
    event.type !== "migration-failed" &&
    current.transaction !== null &&
    ["installed", "failed", "canceled"].includes(current.transaction.state)
  ) {
    return current;
  }
  const state = cloneOfflineState(current);

  if (event.type === "withdraw-package") {
    state.withdrawals[event.package] = event.replacement;
    return remember(state, event.eventId);
  }
  if (event.type === "migration-failed") {
    state.migrations[event.migration] = validationIssue({
      ruleId: "E_MIGRATION",
      path: `/migrations/${event.migration}`,
      observed: event.details,
      allowed: "idempotent migration with a passing health check",
      remediation: "Retain prior usable data and the known-good shell, then repair and retry the migration.",
    });
    return remember(state, event.eventId);
  }
  if (event.type === "plan") {
    if (state.transaction?.transactionId === event.transactionId) return current;
    retainCurrentTransaction(state);
    state.candidateLock = structuredClone(event.candidateLock);
    state.transaction = {
      transactionId: event.transactionId,
      state: "planned",
      candidateLockId: event.candidateLock.lockId,
      requiredFiles: [...event.requiredFiles],
      verifiedFiles: [],
      expectedBytes: event.expectedBytes,
      baselineReferences: cloneRecord(state.references),
      error: null,
      rollbackActions: [],
      reconciliationStatus: "clean",
      audit: ["quota-preflight", "persistence-request", "planned"],
    };

    if (!Number.isSafeInteger(event.expectedBytes) || event.expectedBytes < 0) {
      return remember(failedState(state, "E_FILE_BUDGET", "expected-bytes"), event.eventId);
    }
    if (!Number.isSafeInteger(event.quotaAvailable) || event.quotaAvailable < 0) {
      return remember(failedState(state, "E_QUOTA", "quota-preflight"), event.eventId);
    }
    if (!event.candidateLock.verified || !hasExactUniqueFiles(event.requiredFiles, event.candidateLock.files)) {
      return remember(failedState(state, "E_LOCK_MISMATCH", "required-files"), event.eventId);
    }
    const existingLock = ownRecordValue(state.locks, event.candidateLock.lockId);
    if (existingLock !== undefined && !packageLocksEqual(existingLock, event.candidateLock)) {
      return remember(failedState(state, "E_LOCK_MISMATCH", "existing-lock-id"), event.eventId);
    }

    const withdrawn = event.candidateLock.packages.find((packageId) => Object.hasOwn(state.withdrawals, packageId));
    if (withdrawn !== undefined) return remember(failedState(state, "E_PACKAGE_WITHDRAWN", withdrawn), event.eventId);
    if (event.quotaAvailable < event.expectedBytes || !event.persistenceGranted) {
      return remember(failedState(state, "E_QUOTA", event.persistenceGranted ? "quota-preflight" : "persistence-request"), event.eventId);
    }
    if (!event.online) {
      const cached = new Set(event.cachedFiles);
      const missing = event.requiredFiles.find((file) => !cached.has(file));
      if (missing !== undefined) return remember(failedState(state, "E_OFFLINE_MISSING_ASSET", missing), event.eventId);
    }
    return remember(state, event.eventId);
  }

  if (event.type === "fail") return remember(failedState(state, event.ruleId, event.faultAt), event.eventId);
  if (event.type === "cancel") {
    if (state.transaction === null) return remember(state, event.eventId);
    if (state.transaction.state !== event.at) return remember(transitionFailure(state, event), event.eventId);
    return remember(canceledState(state), event.eventId);
  }
  if (state.transaction === null) return remember(state, event.eventId);

  if (event.type === "start-staging") {
    if (state.transaction.state !== "planned") return remember(transitionFailure(state, event), event.eventId);
    state.transaction.state = "staging";
    state.transaction.audit.push("staging");
    return remember(state, event.eventId);
  }
  if (event.type === "stage-file") {
    if (state.transaction.state !== "staging" || !state.transaction.requiredFiles.includes(event.file)) {
      return remember(transitionFailure(state, event), event.eventId);
    }
    if (!state.stagingFiles.includes(event.file)) state.stagingFiles.push(event.file);
    state.stagingFiles.sort();
    return remember(state, event.eventId);
  }
  if (event.type === "start-verifying") {
    if (
      state.transaction.state !== "staging" ||
      state.transaction.requiredFiles.some((file) => !state.stagingFiles.includes(file))
    ) {
      return remember(transitionFailure(state, event), event.eventId);
    }
    state.transaction.state = "verifying";
    state.transaction.audit.push("verifying");
    return remember(state, event.eventId);
  }
  if (event.type === "verify-file") {
    if (state.transaction.state !== "verifying" || !state.stagingFiles.includes(event.file)) {
      return remember(transitionFailure(state, event), event.eventId);
    }
    if (!state.transaction.verifiedFiles.includes(event.file)) state.transaction.verifiedFiles.push(event.file);
    state.transaction.verifiedFiles.sort();
    return remember(state, event.eventId);
  }
  if (event.type === "start-committing") {
    if (
      state.transaction.state !== "verifying" ||
      state.transaction.requiredFiles.some((file) => !state.transaction?.verifiedFiles.includes(file))
    ) {
      return remember(transitionFailure(state, event), event.eventId);
    }
    state.transaction.state = "committing";
    state.transaction.audit.push("committing");
    return remember(state, event.eventId);
  }
  if (event.type === "commit") {
    if (
      state.transaction.state !== "committing" ||
      state.candidateLock === null ||
      !state.candidateLock.verified ||
      !hasExactUniqueFiles(state.transaction.requiredFiles, state.candidateLock.files) ||
      !hasExactUniqueFiles(state.transaction.requiredFiles, state.stagingFiles) ||
      !hasExactUniqueFiles(state.transaction.requiredFiles, state.transaction.verifiedFiles)
    ) {
      return remember(transitionFailure(state, event), event.eventId);
    }
    const existingLock = ownRecordValue(state.locks, state.candidateLock.lockId);
    if (existingLock !== undefined && !packageLocksEqual(existingLock, state.candidateLock)) {
      return remember(failedState(state, "E_LOCK_MISMATCH", "existing-lock-id"), event.eventId);
    }
    const withdrawn = state.candidateLock.packages.find((packageId) =>
      Object.hasOwn(state.withdrawals, packageId),
    );
    if (withdrawn !== undefined) {
      return remember(failedState(state, "E_PACKAGE_WITHDRAWN", withdrawn), event.eventId);
    }
    const candidate = structuredClone(state.candidateLock);
    const references = cloneRecord(state.references);
    if (existingLock === undefined) {
      for (const file of candidate.files) incrementCount(references, file);
    }
    state.locks[candidate.lockId] = candidate;
    state.references = references;
    state.activeLock = candidate;
    state.transaction.state = "installed";
    state.transaction.error = null;
    state.transaction.reconciliationStatus = "clean";
    state.transaction.audit.push("installed");
    state.stagingFiles = [];
    state.candidateLock = null;
    state.orphanReferences = [];
    retainCurrentTransaction(state);
    return remember(state, event.eventId);
  }

  return state;
}

const RULE_BY_FAULT: Record<string, ErrorCode> = {
  "quota-preflight": "E_QUOTA",
  "persistence-request": "E_QUOTA",
  "stage-write": "E_CACHE_WRITE",
  "stage-readback": "E_CACHE_WRITE",
  "verify-hash": "E_HASH_MISMATCH",
  "verify-mime": "E_MIME_MISMATCH",
  "verify-size": "E_FILE_BUDGET",
  "verify-policy": "E_CODE_FORBIDDEN",
  "commit-lock": "E_CACHE_WRITE",
  "commit-refs": "E_CACHE_WRITE",
  "commit-pointer": "E_CACHE_WRITE",
  "commit-finalize": "E_CACHE_WRITE",
};

function ruleForFault(faultAt: string): ErrorCode {
  return ownRecordValue(RULE_BY_FAULT, faultAt) ?? "E_TRANSACTION_STATE";
}

export function runInstallScenario(current: OfflineModelState, scenario: InstallScenario): OfflineModelState {
  if (current.transaction?.transactionId === scenario.transactionId && ["installed", "failed", "canceled"].includes(current.transaction.state)) {
    return current;
  }
  let state = applyOfflineEvent(current, {
    type: "plan",
    eventId: scenario.eventId ?? `${scenario.transactionId}:plan`,
    transactionId: scenario.transactionId,
    candidateLock: scenario.candidateLock,
    requiredFiles: scenario.requiredFiles,
    expectedBytes: scenario.expectedBytes,
    quotaAvailable: scenario.faultAt === "quota-preflight" ? 0 : scenario.quotaAvailable,
    persistenceGranted: scenario.faultAt === "persistence-request" ? false : scenario.persistenceGranted,
    online: scenario.online,
    cachedFiles: scenario.cachedFiles,
  });
  if (state.transaction?.state === "failed") return state;
  if (scenario.cancelAt === "planned") return applyOfflineEvent(state, { type: "cancel", eventId: `${scenario.transactionId}:cancel`, at: "planned" });

  state = applyOfflineEvent(state, { type: "start-staging", eventId: `${scenario.transactionId}:staging` });
  if (scenario.cancelAt === "staging") return applyOfflineEvent(state, { type: "cancel", eventId: `${scenario.transactionId}:cancel`, at: "staging" });
  if (scenario.faultAt === "stage-write" || scenario.faultAt === "stage-readback") {
    return applyOfflineEvent(state, { type: "fail", eventId: `${scenario.transactionId}:fault`, faultAt: scenario.faultAt, ruleId: ruleForFault(scenario.faultAt) });
  }
  for (const file of scenario.requiredFiles) {
    state = applyOfflineEvent(state, { type: "stage-file", eventId: `${scenario.transactionId}:stage:${file}`, file });
  }

  state = applyOfflineEvent(state, { type: "start-verifying", eventId: `${scenario.transactionId}:verifying` });
  if (scenario.cancelAt === "verifying") return applyOfflineEvent(state, { type: "cancel", eventId: `${scenario.transactionId}:cancel`, at: "verifying" });
  if (scenario.faultAt?.startsWith("verify-") === true) {
    return applyOfflineEvent(state, { type: "fail", eventId: `${scenario.transactionId}:fault`, faultAt: scenario.faultAt, ruleId: ruleForFault(scenario.faultAt) });
  }
  for (const file of scenario.requiredFiles) {
    state = applyOfflineEvent(state, { type: "verify-file", eventId: `${scenario.transactionId}:verify:${file}`, file });
  }

  state = applyOfflineEvent(state, { type: "start-committing", eventId: `${scenario.transactionId}:committing` });
  if (scenario.cancelAt === "committing") return applyOfflineEvent(state, { type: "cancel", eventId: `${scenario.transactionId}:cancel`, at: "committing" });
  if (scenario.faultAt?.startsWith("commit-") === true) {
    return applyOfflineEvent(state, { type: "fail", eventId: `${scenario.transactionId}:fault`, faultAt: scenario.faultAt, ruleId: ruleForFault(scenario.faultAt) });
  }
  return applyOfflineEvent(state, { type: "commit", eventId: `${scenario.transactionId}:installed` });
}

export function reconcileOfflineState(current: OfflineModelState): OfflineModelState {
  const state = cloneOfflineState(current);
  if (
    state.transaction !== null &&
    ["planned", "staging", "verifying", "committing"].includes(state.transaction.state)
  ) {
    failedState(state, "E_TRANSACTION_STATE", "startup-reconciliation");
  }
  for (const [lockId, lock] of Object.entries(state.locks)) {
    if (!lock.verified || lock.lockId !== lockId) delete state.locks[lockId];
  }
  if (state.activeLock !== null) {
    const authoritativeLock = ownRecordValue(state.locks, state.activeLock.lockId);
    if (authoritativeLock === undefined) {
      state.activeLock = null;
      state.reconciliationLog.push("cleared-invalid-active-lock-pointer");
    } else {
      const pointerNeedsRepair = !packageLocksEqual(state.activeLock, authoritativeLock);
      state.activeLock = structuredClone(authoritativeLock);
      if (pointerNeedsRepair) state.reconciliationLog.push("repaired-active-lock-pointer");
    }
  }
  state.candidateLock = null;
  const calculated = emptyRecord<number>();
  for (const lock of Object.values(state.locks)) {
    for (const file of lock.files) incrementCount(calculated, file);
  }
  for (const key of Object.keys(state.references)) {
    state.references[key] = ownRecordValue(calculated, key) ?? 0;
  }
  for (const [key, count] of Object.entries(calculated)) state.references[key] = count;
  state.stagingFiles = [];
  state.orphanReferences = [];
  state.reconciliationLog.push(
    "removed-staging-and-orphan-references",
    "removed-incomplete-locks",
    "repaired-reference-counts",
  );
  if (state.transaction !== null && (state.transaction.state === "failed" || state.transaction.state === "canceled")) {
    state.transaction.reconciliationStatus = "reconciled";
    retainCurrentTransaction(state);
  }
  return state;
}

export function collectUnreferencedAssets(current: OfflineModelState): {
  state: OfflineModelState;
  removed: string[];
} {
  const state = cloneOfflineState(current);
  const removed = Object.entries(state.references)
    .filter(([, count]) => count === 0)
    .map(([file]) => file)
    .sort();
  for (const file of removed) delete state.references[file];
  return { state, removed };
}
