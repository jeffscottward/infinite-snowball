# Infinite Snowball Phase 06 — Creator CLI and Package Workflow

Phase ID: P06
Status: Planned
Owner role: Creator tooling and package workflow engineer
Depends on: P02, P03

## Goal and user value

Give creators a safe, repeatable way to create, validate, preview, pack, and submit Infinite Snowball content packages without requiring application internals. This phase proves the `npx infinite-snowball` / `pnpm dlx infinite-snowball` workflow, data-only package format, examples, packed CLI file allowlist, stable validation rule IDs, and curated submission lifecycle that P07 later installs from a static catalog.

## Prerequisites and dependencies

- P02 has delivered the Zod protocol, generated JSON Schema, threat rules, exact content kinds, strict unknown-field rejection, stable policy/error rule IDs, and no-code browser boundary.
- P03 has delivered cleared starter assets, GLB-first pipeline decisions, provenance ledgers, license policy, music policy, and starter content examples.
- P06 may overlap P05 because it edits CLI/package/example/submission files only; it must not touch P05 playable route files.
- P07 depends on both P05 stop evidence and P06 workflow evidence before it builds the secure offline catalog/store.
- P11 release will later require frozen-lock clean-room build evidence plus both `npx` and `pnpm dlx` CLI checks from an empty temp directory; P06 must expose those checks as repeatable commands without publishing.

## In scope

- `packages/cli/**`: `infinite-snowball` executable, `init` authoring template generation, command routing, strict validators, stable rule IDs, bounded extraction, hash/type/size checks, JSON output, dry-run publish gates, and packed-file allowlist tests.
- `templates/content-pack/**` and `examples/content-pack/**`: creator templates and exact fixture packages for level, character, object-pack, campaign, music, and bundle kinds.
- `catalog/submissions/fixtures/**`: reviewed-submission fixtures, rejected adversarial fixtures, and evidence records used by CI/catalog verification.
- CLI tests under `packages/cli/src/**/__tests__/**` and package workflow tests under `packages/cli/tests/**`.

## Non-goals

- No browser catalog/store UI, Dexie installer, service worker install transaction, CDN deployment, npm publication, or public dist-tag mutation.
- No arbitrary executable content in community packages; no JS/WASM/HTML/CSS content packs.
- No ownership of starter asset creation beyond consuming P03-approved fixtures.
- No backend, account, cloud save, paid marketplace, package signatures/TUF, or uncurated npm search.

## File and directory ownership boundaries

- Owns future `packages/cli/**` files, including the `init` authoring template flow, plus `templates/content-pack/**`, `examples/content-pack/**`, and `catalog/submissions/fixtures/**`.
- Consumes P02-owned `packages/protocol/**` validators and schemas without forking them.
- Consumes P03-owned source asset/provenance examples without changing evidence or licenses.
- Does not own `packages/content-runtime/**`, `apps/web/src/store/**`, `apps/web/src/routes/play/**`, `catalog/registry.json`, service worker code, deployment workflows, public docs, or `.omp-status.md`.

## Stable inputs and contracts

- Six package kinds: `level`, `character`, `object-pack`, `campaign`, `music`, and `bundle`.
- Manifest fields: `schemaVersion`, exact `name`/`version`/`kind`/`engine`, localized metadata, author/homepage/repository/screenshots/icon/tags, SPDX package license, declarative entries, exact dependencies/optional peers, totals, and flat asset inventory with path, MIME, bytes, SHA-256, role, license, and provenance.
- Strict rejections with stable rule IDs: path traversal/absolute/drive/UNC/NUL/encoded variants, symlinks, Unicode/case collisions, unknown files, JS/WASM/HTML/CSS, MIME mismatch, invalid hashes/semver/licenses, unsupported codecs, GLB external/data/network URIs, and bounded-extraction file/byte/depth/compression-ratio violations.
- CLI commands: `init`, `validate --strict --json`, `convert`, `build`, `preview`, `pack`, `install <exact-spec>` for authoring, `catalog verify`, `submit`, and `publish --dry-run`; real publish remains externally gated.
- CLI/CI may resolve npm and boundedly extract exact tarballs without lifecycle scripts; browser never does.
- Packed CLI artifact must include only the reviewed bin, compiled CLI files, schemas/types, templates/examples intended for distribution, license/readme/package metadata, and no test secrets, source provenance archives, app scaffold, lockfile rewrite artifacts, or local cache files.
- Catalog submission output is host-neutral data, not a deployed registry: canonical records expose only normalized relative targets such as `records/<sha256>.json`, `objects/<sha256>.<approved-extension>`, and `thumbnails/<sha256>.<approved-extension>`, with exact source-byte hashes/MIME/bytes and reviewer evidence. Absolute, scheme-relative, origin-bearing, traversal, encoded-escape, and mutable/non-content-addressed resource targets fail closed. P07 alone promotes approved records, creates snapshots with literal `resourceBasePath: "./catalog/"`, and materializes deployed files.

## Outputs and handoffs

- Gate `VG-06-CLI` for local and package-run CLI command behavior, JSON diagnostics, stable rule IDs, strict validation, bounded extraction, packed-file allowlist, and no lifecycle execution.
- Gate `VG-06-AUTHOR-JOURNEY` for templates/examples that a creator can initialize, validate, convert, build, preview, and pack with exact commands.
- Gate `VG-06-SUBMISSION` for curated submission fixtures, reviewer evidence, exact-version catalog/provenance data, budget/license/provenance checks, deterministic host-neutral content-addressed relative target mappings, and dry-run publish safeguards.
- Handoff to P07: immutable package fixture bytes, exact manifest/hash records, canonical catalog verification output with relative content-addressed record/object/thumbnail targets and no host/base URL, install-plan expectations, browser offline smoke fixture path, and rejected-fixture corpus. P06 does not write the public registry or materialize the web catalog subtree.
- Handoff to P09: creator documentation contracts, command examples, contribution journey prerequisites, expected results, and recovery steps.
- Handoff to P11: clean-room package-run command templates that use the reviewed local tarball (`npx --yes --package file:<tarball> -- infinite-snowball ...` and `pnpm dlx file:<tarball> ...`) from empty temp directories before any public release.

## Ordered checklist

1. [ ] IS-06-001 — Add failing CLI contract tests for command discovery, help text, exit codes, `--json` diagnostics, strict unknown-field errors, stable validation rule IDs, and stable machine-readable error codes.
2. [ ] IS-06-002 — Add failing adversarial package tests for traversal, absolute/drive/UNC/NUL/encoded paths, symlinks, Unicode/case collisions, unknown files, executable JS/WASM/HTML/CSS, MIME/hash/license/semver errors, GLB external/data/network references, and extraction limits.
3. [ ] IS-06-003 — Add failing author journey tests for `init`, `validate --strict --json`, `convert`, `build`, `preview`, `pack`, and local `install <exact-spec>` using P03-cleared fixtures.
4. [ ] IS-06-004 — Add failing catalog workflow tests for `catalog verify`, `submit`, and `publish --dry-run`: reviewer/npm provenance, exact version/integrity, deterministic canonical relative `records/`/`objects/`/`thumbnails/` targets, hashes/MIME/bytes, host/base absence, path/origin escape rejection, and refusal of real publication without an explicit release gate.
5. [ ] IS-06-005 — Add failing packed CLI artifact tests that assert the package allowlist and prove test secrets, source archives, app source, generated cache files, and undeclared outputs are excluded.
6. [ ] IS-06-006 — Add fixture packages for all six kinds with exact dependencies, empty v1 capabilities, asset inventory, SPDX licenses, provenance, totals, deterministic hashes, and deterministic content-addressed catalog target mappings.
7. [ ] IS-06-007 — Implement the CLI command router and public `infinite-snowball` binary entry with no dependency on browser/runtime store code.
8. [ ] IS-06-008 — Implement strict manifest loading through P02 schemas and generated JSON Schema; keep one protocol source of truth and one stable rule-ID map.
9. [ ] IS-06-009 — Implement bounded tarball/archive inspection with lifecycle scripts disabled, file/byte/depth/compression-ratio limits, hash streaming, and safe staging cleanup.
10. [ ] IS-06-010 — Implement `convert` and `build` for approved asset transformations using P03 GLB-first recipes, deterministic outputs, reference renders/headless load checks, and provenance updates.
11. [ ] IS-06-011 — Implement `preview` as a local authoring preview that consumes built data and never becomes the public in-game store.
12. [ ] IS-06-012 — Implement `pack` and authoring `install <exact-spec>` for exact local specs with immutable output records and no undeclared dependency fetching in the browser.
13. [ ] IS-06-013 — Implement `catalog verify` and `submit` outputs for curated PR review: canonical JSON, exact version/integrity, per-file hashes/MIME/bytes, deterministic relative `records/<sha>.json`/`objects/<sha>.<ext>`/`thumbnails/<sha>.<ext>` targets, budgets, licenses, reviewer/date/evidence, withdrawal/replacement fields, and no origin/base URL.
14. [ ] IS-06-014 — Implement `publish --dry-run` checks and explicit stop with instructions for later P11 trusted-publishing gates; do not publish to npm in this phase.
15. [ ] IS-06-015 — Run clean-room package-run simulations by packing once, inspecting the allowlist/hash, then invoking the exact reviewed local tarball from empty directories with `npx --yes --package file:<tarball> -- infinite-snowball ...` and `pnpm dlx file:<tarball> ...`; never use the workspace directory or duplicate the binary argument.
16. [ ] IS-06-016 — Record `VG-06-CLI`, `VG-06-AUTHOR-JOURNEY`, and `VG-06-SUBMISSION` evidence and hand rejected fixtures plus successful canonical host-neutral package records/target mappings to P07 without writing registry or deployed catalog files.

## Test-first acceptance criteria

- `VG-06-CLI`: CLI contract, packed-file allowlist, and adversarial tests are committed before implementation and then pass for strict validation, stable rule IDs, JSON diagnostics, safe extraction, disabled lifecycle scripts, deterministic hashes, and stable errors.
- `VG-06-AUTHOR-JOURNEY`: a creator can use the documented command sequence to initialize, validate, convert, build, preview, pack, and locally install an exact content package from P03-cleared fixtures.
- `VG-06-SUBMISSION`: submission fixtures capture npm provenance, exact version/integrity, per-file hashes/MIME/bytes, reviewer/date/evidence, budgets, licenses, withdrawal/replacement data, deterministic content-addressed relative targets, host/base absence and path/origin-escape rejection, plus dry-run publish refusal until P11.
- Clean-room package-run acceptance: one reviewed local tarball is packed once, allowlist/hash-inspected, then exercised from empty directories with `npx --yes --package file:<tarball> -- infinite-snowball ...` and `pnpm dlx file:<tarball> ...` before any public npm release.

## Smallest meaningful verification

- `pnpm --filter infinite-snowball test -- cli-contract adversarial-packages packed-file-allowlist` -> passes command, strict validation, stable rule ID, JSON diagnostics, security rejection, package allowlist, and extraction-limit tests.
- `pnpm --filter infinite-snowball test -- author-journey` -> passes `init`, `validate --strict --json`, `convert`, `build`, `preview`, `pack`, and local `install <exact-spec>` journey on fixtures.
- `pnpm --filter infinite-snowball test -- catalog-workflow` -> proves deterministic canonical `catalog verify`/`submit` output, relative content-addressed targets, source-byte hashes/MIME/bytes, rejection of host/base/path escapes, and `publish --dry-run` refusal.
- `pnpm --filter infinite-snowball exec infinite-snowball validate --strict --json ../../examples/content-pack/level/infinite-snowball.json` -> prints valid JSON diagnostics with zero errors and stable rule IDs for a good fixture.
- `rm -rf /tmp/infinite-snowball-cli-pack && mkdir -p /tmp/infinite-snowball-cli-pack && pnpm --filter infinite-snowball pack --pack-destination /tmp/infinite-snowball-cli-pack && TARBALL="$(printf "%s\n" /tmp/infinite-snowball-cli-pack/*.tgz)" && shasum -a 256 "$TARBALL" && tar -tf "$TARBALL"` -> packs once, records the reviewed tarball hash, and compares contents to the packed-file allowlist; both clean-room runners below must use this exact tarball without repacking.
- `REPO_ROOT="$(pwd)" && TARBALL="$(printf "%s\n" /tmp/infinite-snowball-cli-pack/*.tgz)" && rm -rf /tmp/infinite-snowball-npx-clean && mkdir -p /tmp/infinite-snowball-npx-clean && cd /tmp/infinite-snowball-npx-clean && npx --yes --package "file:$TARBALL" -- infinite-snowball validate --strict --json "$REPO_ROOT/examples/content-pack/level/infinite-snowball.json"` -> exercises the reviewed local tarball through `npx` from an empty directory without public npm publication, workspace-directory install, or duplicated binary argument.
- `REPO_ROOT="$(pwd)" && TARBALL="$(printf "%s\n" /tmp/infinite-snowball-cli-pack/*.tgz)" && rm -rf /tmp/infinite-snowball-dlx-clean && mkdir -p /tmp/infinite-snowball-dlx-clean && cd /tmp/infinite-snowball-dlx-clean && pnpm dlx "file:$TARBALL" validate --strict --json "$REPO_ROOT/examples/content-pack/level/infinite-snowball.json"` -> exercises the same reviewed local tarball through `pnpm dlx` from an empty directory without public npm publication, workspace-directory install, or duplicated binary argument.
- Manual scenario: create a new package from `templates/content-pack`, add one rejected adversarial file, run strict validation, then remove it and pack; expected result is a precise rule-ID rejection first and deterministic package record second.

## Quality gates

| Gate area | Required evidence |
| --- | --- |
| Performance | Bounded archive inspection enforces file count, byte, depth, and compression-ratio limits; hash/type checks stream without loading entire large assets when avoidable; conversion/build steps record elapsed time and size budgets for P10. |
| Accessibility | CLI help, errors, and JSON diagnostics use clear text, stable codes, and non-color-only terminal output; generated preview controls follow P08/P05 semantic control contracts where a preview UI exists. |
| Security | No lifecycle scripts run; no community JS/WASM/HTML/CSS passes validation; npm specs must be exact; path, symlink, Unicode/case, GLB external/data/network, MIME, hash, semver, license, extraction, and catalog target origin/path attacks are rejected with stable rule IDs. |
| Licensing | SPDX package and per-asset licenses are required; provenance records include creator/source/acquisition, source artifact hash, license URL/captured hash, attribution, modifications, transformation recipe, output hash, reviewer/date, and evidence status; target mapping preserves the evidence relationship. |
| Offline/recovery | Local authoring install and preview use exact built artifacts; failure removes staging output and preserves the last valid record. P06 hands deterministic host-neutral mappings to P07 but never writes registry/deployed files; public offline runtime install and prefix-local materialization are P07 work. |

## Completion and stop condition

P06 is complete only when `VG-06-CLI`, `VG-06-AUTHOR-JOURNEY`, and `VG-06-SUBMISSION` pass with positive/adversarial fixtures for all six kinds, stable rule IDs, packed-file allowlist evidence, exact-version/provenance evidence, deterministic canonical host-neutral content-addressed mappings, and clean-room `npx`/`pnpm dlx` simulations. Completion is blocked if output contains an origin/base, unsafe/mutable target, or writes registry/deployed catalog files. Real npm publication, catalog promotion/materialization, runtime installer, and public release remain later phases. P06 may finish while P05 runs, but P07 stays blocked until both P06 evidence and the P05 stop gate complete.

## Rollback and recovery notes

If CLI/package workflow changes fail, revert P06-owned `packages/cli/**`, template/example, and submission-fixture files. Delete temporary CLI staging directories and local packed artifacts created by tests, but keep P02 schemas and P03 source/provenance untouched. If a bad dry-run package record is produced, mark it rejected in the fixture evidence and regenerate from source rather than editing hashes by hand.
