# Infinite Snowball Phase 02 Threat Model

## Scope and trust boundaries

This model covers declarative community packages from npm through CLI/CI inspection, curated catalog/CDN publication, browser download of immutable files, local metadata and locks, and later P07 offline installation. It is a protocol and design contract, not a claim that the store or service worker exists.

Trust crosses these boundaries:

1. A publisher-controlled npm package enters untrusted CLI/CI inspection.
2. Reviewed metadata and immutable files cross from protected catalog CI to the static catalog/CDN.
3. Catalog data and bytes cross an untrusted network into the browser.
4. Verified immutable responses enter Cache Storage while metadata, reference counts, locks, saves, settings, transactions, and migrations enter IndexedDB/Dexie.
5. A versioned SaveExport crosses a local user-controlled import/export boundary.

The browser trusts only protocol 1.0.0 validators, generated schema data, a last-valid curated snapshot, exact hashes, and an atomically committed verified lock. Community content is never trusted as code.

## Protected assets and security goals

- Preserve executable-code integrity of the application shell.
- Preserve the previous verified package lock, saves, settings, and known-good shell on every failure.
- Reject undeclared, unverified, unlicensed, incompatible, or oversized content before activation.
- Keep credentials, account/cloud identifiers, analytics, diagnostics, and local-audio data out of validation output, catalog data, SaveExport, and network egress.
- Keep reviewer evidence, withdrawal history, and failed transaction evidence actionable without retaining raw sensitive input.

## Threats, mitigations, and recovery

| Threat | Required mitigation | Recovery contract |
|---|---|---|
| Malicious npm package or lifecycle script | Resolve one exact version in CLI/CI; disable lifecycle scripts; boundedly inspect the archive; reject executable content and unknown files. | Reject before catalog approval. Never execute package code. |
| Compromised publisher or stolen npm identity | Verify npm integrity/provenance, exact manifest and per-file hashes, reviewer/date/evidence, and immutable CDN projection. | Withdraw the version, block new installs, preserve saves/history, and publish only a reviewed replacement. |
| Malicious archive | Reject traversal, absolute/drive/UNC/NUL/encoded paths, symlinks, Unicode/case collisions, executables, MIME confusion, compression abuse, excessive depth, and GLB references. | Delete staging only and retain the stable rule ID and remediation. |
| Compromised catalog or CDN data | Require a strict signed-off schema, exact snapshot linkage, immutable URLs, per-file SHA-256, and catalog evidence hash. HTTPS and protected CI/review are the v1 trust layer; v1 does not claim TUF. | Reject invalid refresh/data and keep the last valid snapshot and previous lock. |
| Network failure, truncation, replay, or stale refresh | Stream and verify size, MIME, policy, and hash before commit; enforce snapshot age and previous-snapshot linkage. | Keep last-valid catalog/shell and retry without blanking local state. |
| Quota exhaustion or quota eviction | Estimate quota and request persistence before staging; verify cache readback; reconcile Cache Storage against Dexie metadata. | Fail with `E_QUOTA` or `E_CACHE_WRITE`, remove staging, preserve prior lock/saves, and show cleanup/export guidance. |
| Stale or withdrawn content | Catalog rows carry active/withdrawn/replaced state and immutable replacement metadata. | Block new installs while preserving existing locks, save references, review evidence, and history. |
| Shared-reference garbage collection error | Reference counts are metadata owned by Dexie and derived from exact locks; uninstall removes only zero-reference assets. | Reconcile counts from retained locks before garbage collection and never delete a positive-reference object. |
| Interrupted migration or activation | Migrations are versioned, idempotent, health checked, and separate from known-good activation. | Retain prior usable data and one known-good shell; record `E_MIGRATION`; retry or roll back. |
| Corrupt, oversized, incompatible, or privacy-violating SaveExport | Validate version, bounded size, canonical section checksums, strict fields, and forbidden egress keys before mutation. | Reject atomically and preserve current saves, settings, locks, and packages. |
| Credential or sensitive-input reflection | Structured errors redact credential-like keys and URL userinfo, bound observed values, and never echo raw archives or request bodies. | Record only local rule/path/remediation evidence; rotate any independently exposed credential. |

## Abuse cases explicitly rejected

Browser-side npm search, tarball extraction, filesystem access, lifecycle execution, `eval`, `Function`, dynamic community `import()`, undeclared URL following, JS/WASM/HTML/CSS, and arbitrary package execution are forbidden. Unfiltered npm search is not a catalog. NC, ND, ambiguous, missing, disputed, incomplete, or withdrawn license evidence cannot authorize a new install.

## Residual risk

Protected CI, HTTPS, exact hashes, and human review do not eliminate maintainer compromise, CDN availability loss, browser storage eviction, reviewer error, or denial of service. v1 accepts those residual risks while keeping execution closed, retaining last-known-good local state, and making catalog evidence transparent. A future signature/TUF system or backend requires a separate measured ADR rather than silent protocol expansion.

## Incident and withdrawal response

1. Mark the exact package/version or asset `withdrawn`; do not relabel disputed bytes.
2. Block new installs and catalog activation immediately while preserving saves, existing lock history, and local failure evidence.
3. Retain the last valid catalog snapshot and known-good shell.
4. Publish a replacement only as a new exact version with new hashes, reviewer/date/evidence, and migration mapping.
5. Reconcile shared references before cleanup; delete only staging and zero-reference immutable objects.
6. Review whether credentials or private data escaped. Rotate credentials when independently exposed; never place the secret in the incident record.
