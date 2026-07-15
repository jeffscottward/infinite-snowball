# Offline Install Transaction Design

## Status and scope

This is the deterministic Phase 02 design/model contract for P07. It does not implement IndexedDB, Dexie, Cache Storage, a service worker, background sync, or a production installer.

This document is design only, not an implementation. P07 owns production code and may later use Workbox `injectManifest` only after its service-worker tests and recovery gates pass.

## Storage ownership

- Cache Storage owns immutable content bytes and one known-good shell cache.
- IndexedDB/Dexie owns catalog metadata, exact plans, transactions, locks, active-lock pointer, file hashes, reference counts, saves, settings, migrations, and reconciliation evidence.

The planned Dexie schema keeps `catalogSnapshots`, `catalogEntries`, `packages`, `assets`, `packageAssets`, `packageLocks`, `installTransactions`, `saves`, `settings`, and `migrations` as separate stores with explicit ownership.
- SaveExport is the explicit portable backup/import boundary; it never contains credentials, analytics, local-audio data, or undeclared cloud identifiers.

## State machine

The only successful install path is:

`planned -> staging -> verifying -> committing -> installed`

`planned`, `staging`, `verifying`, or `committing` may transition to `failed` or `canceled`. A terminal event ID and transaction ID are idempotent: replay cannot duplicate references, swap a lock twice, or repeat a migration.

The active lock remains the last-known-good verified lock until the final atomic commit. Candidate package versions remain side-by-side in staging and cannot overwrite active bytes. Saves and settings are never part of install rollback.

## Plan and preflight

An `InstallPlan` contains one exact acyclic package DAG, exact immutable files/hashes, expected bytes, dependency order, candidate lock, engine compatibility, catalog eligibility, and offline availability. Quota preflight and a persistence request occur before staging. Insufficient capacity or denied persistence produces `E_QUOTA` before activation and presents cleanup/export guidance.

When offline, every required immutable file must already be cached and verified; otherwise `E_OFFLINE_MISSING_ASSET` fails before mutation. Withdrawn/disputed candidates fail with `E_PACKAGE_WITHDRAWN` while existing locks and saves remain usable.

## Staging and verification

Staging uses a transaction-specific cache namespace. Each streamed response is bounded and then read back. Verification checks exact path, bytes, MIME, SHA-256, codec/media policy, self-contained GLB policy, license/provenance state, and the flat manifest inventory. No staged file becomes active during this phase.

Failure at cache write/readback, hash, MIME, size, codec, policy, or cancellation removes staging, candidate-lock metadata, and orphan references. It preserves the previous lock, previous reference counts, saves, settings, known-good shell, and structured failure evidence.

## Atomic commit order

After every required file is verified:

1. Write the complete verified candidate lock as a new immutable Dexie record.
2. Update shared reference counts in the same metadata transaction.
3. Atomically swap the active-lock pointer.
4. Mark the transaction `installed` and finalize audit evidence.
5. Remove only transaction staging metadata; immutable side-by-side bytes remain reference managed.

A failure at `commit-lock`, `commit-refs`, `commit-pointer`, or `commit-finalize` rolls back the entire metadata transaction. The prior active lock and reference counts remain authoritative. There is no partially active candidate.

## Rollback, garbage collection, and uninstall

Rollback actions are explicit: delete staging cache, discard candidate lock, and restore reference counts. Uninstall decrements exact lock-owned references only after reconciliation. Garbage collection removes an asset only when its reconciled count is zero; shared positive-reference assets survive. Withdrawal blocks new installs but does not trigger destructive deletion.

## Startup reconciliation

Before install/uninstall, reconciliation compares retained lock records, active pointer, reference-count metadata, transaction rows, and cache namespaces. It:

1. Deletes abandoned transaction staging.
2. Removes orphan references and incomplete candidate locks.
3. Recomputes shared counts from retained verified locks.
4. Preserves zero-count objects for a separate auditable garbage-collection step.
5. Marks failed/canceled transactions reconciled while keeping bounded failure evidence.

Reconciliation never derives a new active lock from cache contents and never deletes a positive-reference object.

## Migrations and shell recovery

Schema/cache migrations are versioned, idempotent, and health checked. A migration writes a new version side-by-side and promotes it only after verification. On failure, `E_MIGRATION` retains prior usable data and the known-good shell. At least one usable shell/cache version remains until the new one passes startup health checks.

## Fault-injection matrix

The pure model tests failures at quota preflight, persistence request, staging write, staging readback, hash, MIME, size, policy, lock write, reference update, pointer swap, and finalization. They also cancel at every pre-commit state, simulate offline cached/uncached installs, stale metadata reconciliation, shared-reference garbage collection, duplicate event replay, withdrawal/replacement, and migration failure.

For every injected failure the invariant is identical: previous active lock, saves, settings, and known-good shell are preserved; staging and orphan references are absent; the failure has a stable rule ID and rollback/reconciliation evidence.
