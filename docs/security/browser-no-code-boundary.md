# Browser No-Code Boundary

## Decision

Infinite Snowball protocol 1.0.0 treats community packages as declarative data, not application extensions. CLI/CI performs exact npm resolution and bounded extraction. The browser consumes only curated immutable files described by an approved catalog and exact lock.

Community code is forbidden in the browser graph; only reviewed declarative community data may cross this boundary.

This boundary implements ADR-008 and ADR-009. It does not implement the future CLI, catalog store, or service worker.

## CLI/CI responsibilities

Trusted, reviewable CLI/CI tooling may:

- resolve one exact npm package/version and verify integrity and npm provenance;
- inspect an archive with hard file, byte, depth, and compression-ratio limits;
- normalize paths and reject traversal, absolute/drive/UNC/NUL/encoded paths, symlinks, collisions, and unknown files;
- sniff/parse MIME, hash streamed bytes, inspect codecs and self-contained GLB structure;
- validate strict manifests, exact DAGs, licenses/provenance, budgets, and reviewer evidence;
- project approved files to immutable CDN URLs and emit a curated static catalog.

Lifecycle scripts are never executed during package resolution, install, extraction, validation, preview, or catalog review. CLI/CI does not trust package entry points or run package binaries.

## Browser-safe export graph

`@infinite-snowball/protocol/browser` may export only validators, types, constants, and generated schema data. The real bundled export graph is checked through Vite/Rollup resolution and AST inspection, not only source-name matching.

No reachable browser module may provide or import:

- Node built-ins or filesystem access;
- npm search/resolution, registry clients, archive extraction, or lifecycle execution;
- undeclared network-following logic;
- `eval` or the `Function` constructor;
- static or dynamic community `import()`;
- JS, WASM, HTML, CSS, native executable, or arbitrary package execution logic;
- scripts or the offline transaction design model.

The browser validates catalog/manifest records, downloads declared curated immutable files, verifies the expected size/MIME/hash/policy metadata, and hands only verified declarative records to later runtime code. It never opens tarballs, follows GLB external/data/network URIs, or uses npm as a store API.

## Allowed data flow

1. Protected catalog CI publishes a last-valid strict snapshot and immutable file URLs.
2. The browser validates the snapshot and exact entry.
3. Later P07 code fetches only declared immutable URLs.
4. Streamed bytes must match size, MIME, hash, codec, license, and policy evidence before an atomic lock commit.
5. Runtime consumers receive typed declarative entries; missing metadata is never inferred.

## Verification and failures

`protocol:browser-boundary` bundles the actual browser entry in memory, records every resolved module, permits only the entry, approved protocol source root, and exact installed `zod` package tree, and rejects every other local, external, or `node_modules` executable module regardless of extension or query suffix. Reachable AST inspection rejects direct and member-form `eval`, `Function`, network-following, archive/decompression, and dynamic-import calls. Mutation fixtures prove each forbidden class is caught. Failure blocks Phase 02; no regex allowlist or generated minified text may hide a reachable execution path.

Structured failure evidence contains a stable boundary rule, module ID, and remediation without copying module source or credentials. Any future executable capability requires a separate security ADR and reviewed core-code change; a non-empty v1 `capabilities` object remains invalid.
