# Infinite Snowball Phase 03 — Assets, Music, and Starter Content

Phase ID: P03
Status: Planned
Owner role: Assets, music, provenance, and starter-content engineer
Depends on: P02

## Goal and user value

Create a small, legally safer, reproducible starter content set with fail-closed asset, music, license, provenance, brand, and local-audio rules. Users get original starter content that can feed the first playable slice later; creators get clear evidence expectations before public catalog ingestion.

## Prerequisites and dependencies

- P02 strict protocol, provenance fields, license allowlist hooks, asset inventory schema, rejection rule IDs, and no-code browser boundary are complete and verified.
- Use the reconciled authoring brief decisions 22–26 and the assets/music/legal research as the controlling asset policy.
- P03 may start in parallel with P04 after P02 because it owns content data, source evidence, tooling, and ledgers only, while P04 owns runtime/input/simulation code and performance telemetry.
- Use only exact-artifact-cleared Quaternius, KayKit, or Kenney CC0 assets for prototype/starter content unless original commissioned/in-house material is available with written grant evidence.
- OS3A is discovery-only and requires independent original creator/source/license proof. Pelican is rejected as unverified.
- No account credentials, npm publishing, public catalog merge, gameplay runtime, store install, or deployment is required.

## In scope

- Future asset pipeline tools and fixtures under `tools/assets/**`, `tests/assets/**`, and `tests/fixtures/assets/**`.
- Future starter source-evidence records and retained-source hashes under `docs/licenses/provenance/**` or the approved evidence path.
- Future human-readable third-party ledger and machine provenance records for every runtime asset.
- Future starter content under `content/starter-level/**`, `content/starter-objects/**`, `content/starter-character/**`, `content/starter-campaign/**`, and `content/starter-music/**` as data-only packages/content, validated by P02 schemas.
- GLB-first reproducible retained-source -> normalized GLB pipeline, reference renders, budget reports, structural checks, headless load/render smoke, and deterministic output hashes.
- Starter music policy: original/commissioned preferred; CC0 or CC-BY only when fully evidenced and attributed; no NC/ND/ambiguous/royalty-free-without-grant material.
- Local-only soundtrack import boundary as a future policy contract, not vertical-slice blocker.
- Brand/trade-dress/public-copy checks that preserve original “playful winter toybox / rolling scrapbook” identity and prohibit Katamari naming, art, logo, UI, story, sound, music, soundtrack references, fake ratings, and store badges.

## Non-goals

- No runtime game code, R3F scenes, physics, Koota systems, input adapters, service worker, Dexie store, catalog installer, package publishing, npm submission, deployment, Mintlify site, or full store implementation.
- No browser execution of community package JavaScript and no asset tool code shipped as runtime content.
- No copyrighted soundtrack bundling, mirroring, streaming, suggesting, cataloging, auto-installing, identifying, or linking as a product feature.
- No legal guarantee of non-infringement; this phase records evidence and blocks unsafe content.
- No P04-owned runtime profiling claims. P03 enforces asset budgets and provides measured asset reports; P04/P10 own runtime frame performance.

## File and directory ownership boundaries

P03 owns these future paths:

- `tools/assets/**`
- `tests/assets/**`
- `tests/fixtures/assets/**`
- `content/starter-level/**`
- `content/starter-objects/**`
- `content/starter-character/**`
- `content/starter-campaign/**`
- `content/starter-music/**`
- `docs/licenses/third-party-ledger.md`
- `docs/licenses/provenance/**`
- `docs/licenses/withdrawals/**`
- `docs/music/original-music-policy.md`
- `docs/music/local-import-boundary.md`
- `docs/brand/original-content-review.md` if no later UI/docs phase has already claimed that exact file

P03 must not edit P04 runtime paths: `packages/engine/**`, `packages/gameplay/**`, `packages/runtime-r3f/**`, `packages/input/**`, `apps/web/**`, runtime camera/controller code, service-worker code, Dexie/cache implementation, or P06 CLI publication workflow. If a shared protocol change is needed, stop and coordinate with the P02 owner rather than changing `packages/protocol/**` directly.

## Stable inputs and contracts

- P02 manifest and asset inventory schema is authoritative; P03 cannot add unknown fields or bypass validation.
- Every runtime asset has exactly one machine provenance record with `assetId`, package/version/path/role/MIME/bytes/SHA-256, creator/source/acquisition, source artifact hash, SPDX/license URL/captured license hash, attribution, modifications, transformation recipe/tool/config, output hash, reviewer/date, evidence status, notes, and replacement.
- Human ledger is generated from machine records and reviewed for readable credits; machine records remain authoritative.
- Evidence states are `verified`, `incomplete`, `disputed`, `withdrawn`; only `verified` content may ship in starter packages.
- Initial asset budgets to enforce as fail-closed checks until profiled: collectible <=150 KiB, <=10k triangles, <=2 material slots, one 1024 texture set; hero <=1.5 MiB, <=40k triangles, <=4 slots, two 2048 sets; level <=12 MiB initial download, <=25 MiB uncompressed, no file >8 MiB, <=256 files; starter level compressed textures <=8 MiB and max 2048 textures.
- Initial music budgets: track <=8 MiB, <=10 minutes, stereo, <=48 kHz; pack <=32 MiB and <=8 tracks.
- GLB output must be self-contained or policy-approved, structurally valid, normalized, free of network/data/external references, reproducible from retained source, and headless-loadable.
- Local soundtrack import remains future local-only: bytes, filenames, tags, artwork/waveforms, hashes, playlists, and rights assertions never enter network, catalog, npm, analytics, diagnostics, cloud/export, screenshots, or service-worker requests.

## Outputs and handoffs

- Handoff to P04: asset metadata, collider hints, bounds, scale, size bands, LOD/instance groups, and reference scenes as data-only inputs; no runtime transform ownership.
- Handoff to P05: starter level/object/character/campaign/music content sufficient for the 90-second one-arena starter run, final goal object, authored score values, and visual/audio feedback assets.
- Handoff to P06: reproducible convert/validate evidence, package-author journey fixtures, rejection/appeal fixture examples, and dry-run packaging inputs.
- Handoff to P07: withdrawal/quarantine/replacement metadata and immutable asset hashes for store install behavior.
- Handoff to P09/P10: human ledger, credits, attribution, screenshots/reference renders, public-copy checklist, license/provenance audit evidence, and dispute drill records.
- Traceability deliverables owned here: D008 through `VG-03-ASSETS`; D009 through `VG-03-LICENSES`; D010 through `VG-03-MUSIC`; D011 through `VG-03-LOCAL-AUDIO`.

## Ordered checklist

1. [ ] IS-03-001 — Write failing license/provenance tests and fixtures for missing source, missing source hash, missing license text/hash, missing creator, missing reviewer, `incomplete`, `disputed`, `withdrawn`, NC, ND, ambiguous, royalty-free-without-grant, OS3A-only, Pelican, and Katamari-soundtrack cases.
2. [ ] IS-03-002 — Write failing asset-budget and GLB-structure tests for bytes, triangles, materials, texture dimensions, compressed texture totals, file counts, external references, data/network URIs, invalid bounds, unsupported extensions, and non-reproducible output hashes.
3. [ ] IS-03-003 — Write failing music-policy tests for track size, duration, channel count, sample rate, codec allowlist, missing attribution, missing grant, pack size/count, and prohibited soundtrack references.
4. [ ] IS-03-004 — Write failing local-import boundary tests proving imported audio bytes and metadata cannot enter catalog/package/export/diagnostic/network/service-worker/screenshot paths.
5. [ ] IS-03-005 — Write failing brand/public-copy tests for prohibited affiliation phrases, franchise names in product metadata, copied trade dress, fake ratings/reviews, store badges, soundtrack suggestions, and direct comparisons used as marketing.
6. [ ] IS-03-006 — Select exactly one initial prototype source from Quaternius, KayKit, or Kenney only after recording original URL, exact artifact, creator, acquisition date, source SHA-256, captured license text/hash, and reviewer.
7. [ ] IS-03-007 — Build the retained-source -> GLB pipeline with pinned tool versions, deterministic config digests, normalization, optimization, texture/audio derivative rules, reference renders, and headless load/render smoke.
8. [ ] IS-03-008 — Produce the starter level, object, character, campaign, and music data-only content with P02 manifest validation and no executable files.
9. [ ] IS-03-009 — Generate machine provenance records and `docs/licenses/third-party-ledger.md`; review that every runtime asset has exactly one ledger entry and no orphan ledger entries exist.
10. [ ] IS-03-010 — Create withdrawal/dispute/replacement fixture records that block new installs while preserving save/history references for P07.
11. [ ] IS-03-011 — Run the P03 verification commands and capture evidence for `VG-03-ASSETS`, `VG-03-LICENSES`, `VG-03-MUSIC`, and `VG-03-LOCAL-AUDIO`.
12. [ ] IS-03-012 — Hand off content hashes, budgets, collider hints, size bands, reference renders, credits, and unresolved caveats to P04, P05, P06, P07, and P09.

## Test-first acceptance criteria

- `VG-03-ASSETS`: asset fixtures fail before the pipeline and pass only when one exact-artifact-cleared CC0 prototype source is retained, rebuilt reproducibly, normalized to valid self-contained GLB, within budgets, and headless-load/render verified.
- `VG-03-LICENSES`: license/provenance fixtures fail before ledgers and pass only when every runtime file has one verified machine provenance record, appears in the human ledger, has captured license evidence, and unsafe evidence states fail closed.
- `VG-03-MUSIC`: music fixtures fail before policy enforcement and pass only when original/commissioned, CC0, or CC-BY with full attribution can pass, while NC/ND/ambiguous/royalty-free-without-grant and Katamari soundtrack references fail.
- `VG-03-LOCAL-AUDIO`: local-import boundary fixtures fail before exclusion rules and pass only when imported local audio bytes and metadata are excluded from catalog, npm, analytics, diagnostics, cloud/export, screenshots, and service-worker network requests.
- P03 content is parallel-safe with P04: tests prove no P03 task modifies runtime/input/simulation source paths or claims store/runtime readiness.

## Smallest meaningful verification

Future commands and expected results:

```bash
corepack pnpm vitest run tests/assets tests/fixtures/assets
```

Expected: all asset, music, license, local-import, brand, and withdrawal fixtures pass with stable fail-closed rule IDs.

```bash
corepack pnpm run assets:rebuild-starter && corepack pnpm run assets:verify-hashes
```

Expected: retained sources rebuild starter outputs with declared hashes, deterministic config digest, and no untracked runtime files.

```bash
corepack pnpm run assets:budget-report && corepack pnpm run assets:headless-smoke
```

Expected: budget report is within P03 initial limits; headless loader/render opens every starter GLB/audio manifest without external references or runtime-package code.

```bash
corepack pnpm run licenses:ledger-check && corepack pnpm run music:policy-check && corepack pnpm run brand:originality-check
```

Expected: zero orphan runtime files, zero missing ledger rows, zero unapproved licenses, zero prohibited soundtrack references, zero fake store/ratings patterns, and explicit evidence for each accepted asset or track.

```bash
corepack pnpm run local-audio:boundary-check
```

Expected: simulated local imports produce no catalog/package/export/diagnostic/network/service-worker/screenshot records containing imported bytes, names, tags, artwork, waveforms, hashes, playlists, or rights assertions.

## Quality gates

| Gate area | Gate ID | Required evidence | Stop condition |
|---|---:|---|---|
| Performance | VG-03-ASSETS | Asset budget report enforces file sizes, triangles, material slots, texture dimensions, texture totals, pack counts, and headless load/render; no runtime FPS claim is made. | Stop on any over-budget asset without reviewed measured exception, non-reproducible output, external GLB reference, or unbounded starter package. |
| Accessibility | VG-03-ASSETS / VG-03-MUSIC | Starter content handoff includes semantic names, non-color-only role/category metadata, captions/credits data for music attribution, and no autoplay/high-flash visual assumptions. | Stop if content requires color-only identification, lacks accessible names/credits metadata, or includes flashing/audio behavior that later UI cannot control. |
| Security | VG-03-ASSETS | P02 validation passes for every starter package; runtime content contains no JS/WASM/HTML/CSS, no external/data/network GLB references, no unknown files, and exact SHA-256 hashes. | Stop if any content bypasses protocol validation, ships executable code, follows undeclared URLs, or lacks exact hashes. |
| Licensing | VG-03-LICENSES / VG-03-MUSIC | Every asset/music item has verified provenance, captured license text/hash, SPDX where valid, attribution if required, reviewer/date, and evidence state `verified`; unsafe states fail closed. | Stop if provenance is incomplete, OS3A is treated as blanket clearance, Pelican is recommended, NC/ND/ambiguous/royalty-free material passes, or Katamari soundtrack material is bundled/suggested/cataloged. |
| Offline/recovery | VG-03-LOCAL-AUDIO | Content packages are immutable data with exact hashes; withdrawal/replacement fixtures block new installs without deleting saves/history; local audio import remains local-only and clear-all removes references. | Stop if starter content depends on network-only undeclared files, local imports leak to network/catalog/export/diagnostics, or withdrawn bytes can be newly installed. |

## Completion and stop condition

P03 is complete only when `VG-03-ASSETS`, `VG-03-LICENSES`, `VG-03-MUSIC`, and `VG-03-LOCAL-AUDIO` have passing evidence, starter content validates against P02 schemas, every runtime file is reproducible and ledgered, unsafe license/provenance/music cases fail closed, and P04 can proceed in parallel without shared-file collisions. Do not declare success because assets look good; evidence, hashes, licenses, budgets, and boundary tests are mandatory.

## Rollback and recovery notes

P03 changes are content, asset tooling, fixtures, and ledgers. Safe rollback is to revert the P03-owned `tools/assets/**`, `tests/assets/**`, `tests/fixtures/assets/**`, `content/starter-*`, `docs/licenses/**`, `docs/music/**`, and P03 brand-review files together, then rerun P02 protocol validation and P03 ledger checks. If a license dispute appears after content is consumed by later phases, mark the asset/version `withdrawn`, block new installs, preserve saves/history, and replace only through a new reviewed version with migration mapping; never relabel disputed bytes as cleared.
