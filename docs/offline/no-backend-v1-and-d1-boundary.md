# ADR: No-Backend v1 and Later D1 Boundary

- Status: Accepted for protocol 1.0.0
- Decision owner: Phase 02

## Context

The first public vertical slice has no authenticated multiplayer, cloud-save, moderation queue, mutable user content, or server-authoritative game state. Adding a hosted database now would create auth, privacy, abuse, cost, migration, and availability obligations without a proven online user story.

Accounts, cloud saves, leaderboards, multiplayer, and remote export/import are explicit v1 non-goals.

## Decision

v1 is static-first and has no backend. The primary artifact is one reproducible static application deployed to Cloudflare Pages, with GitHub Pages as a fallback. The catalog is curated static metadata and package files are immutable CDN objects. Local settings, saves, package locks, transactions, catalog cache, and reference metadata remain in the browser.

A Service Worker is not implemented in Phase 02; P07 owns any later offline-store implementation. This ADR defines its boundary only.

No hosted database, authentication service, analytics pipeline, or cloud-save service is silently introduced. In particular, this phase does not configure Supabase, create Cloudflare D1 resources, create credentials, or establish deployment state.

## Consequences

Static-first avoids accounts, secrets, server retention, mutable APIs, and backend outage coupling. Browser state must therefore support fail-closed SaveExport/import, quota/persistence handling, last-valid catalog fallback, known-good shell recovery, and transparent local reset/export guidance.

The deployment remains the same tested artifact on both static hosts. Missing network access cannot authorize uncached content, and a bad catalog refresh cannot blank the last valid snapshot.

## Later D1 gate

Cloudflare D1 is only a later option, not a selected dependency. A new measured ADR is required when a real online user story cannot be met by static files and local storage. That ADR must define:

- authentication and authorization;
- abuse, moderation, rate limits, and incident response;
- privacy, retention, deletion, export, and migration;
- schema/versioning, migration, and rollback;
- quota, cost, backup, restore, and load-test evidence;
- Cloudflare outage/fallback behavior and vendor portability;
- least-privilege credentials and deployment ownership.

Until all of those are reviewed and a dedicated later phase owns implementation, static local behavior is the contract.

## Rejected alternatives

- Add D1 preemptively: rejected because there is no qualifying online workflow or load/cost evidence.
- Add a generic hosted backend or auth provider: rejected because it expands privacy and operational scope before need.
- Implement a service worker in Phase 02: rejected because P07 owns the real store and offline runtime.
- Treat npm or a mutable registry response as the live catalog: rejected because it bypasses curation, immutable hashes, review evidence, and last-valid fallback.
