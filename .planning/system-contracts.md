# Infinite Snowball System Contracts

Status: planned and reconciled. These are stable contracts for future P01-P11 implementation work only; this file contains no application source or scaffold.

Canonical phase graph: `P01 -> P02 -> {P03 || P04}; P03 -> P06; {P03,P04} -> P05; {P05,P06} -> P07 -> P08 -> P09 -> P10 -> P11`.

## 1. Stable package and domain map

| Future path | Stable logical package/domain | Responsibility | Boundary |
|---|---|---|---|
| `apps/web/**` | web app shell | P05 first creates the minimal private Vite package, exact `/play` route, relative manifest/SW/starter precache, Dexie v1 saves/settings, isolated-prefix persistent-profile offline run, and Chromium-specific installability signal; this is not a real installed-app lifecycle. P07 may add only the existing content-runtime dependency/scripts and controlled SW/DB/catalog surfaces; P08 may add only the existing UI dependency/scripts and presentation routes, plus only the authorized `manifest.webmanifest` start/description/theme/background fields and inherited test expectation. P10 owns supported headed/manual install -> full quit -> network-off relaunch plus explicit unsupported rows. | No Node/npm/archive execution in browser, no high-frequency React game state, no future workspace dependency before its package exists, and every handoff preserves `private: true`, P05 behavior, relative identity, and prefix isolation. |
| `packages/protocol/**` | protocol | Zod schemas, generated JSON Schema, manifest/catalog/domain types, compatibility rules, adversarial fixtures. | Browser imports validators/types only. Node/archive/npm logic is forbidden here when imported by the browser. |
| `packages/engine/**` | engine | Koota core worlds, tag/AoS traits, project-owned ordered systems, deterministic reducers, simulation scheduling seams. | Imports only Koota core, never `koota/react`; owns no Rapier transform, Three resource, React state, DOM, or device API. |
| `packages/gameplay/**` | gameplay | Pure snowball controller commands, collection/growth/scoring/objective/audio reducers, camera intents. | Consumes normalized input and plain physics facts/handles; imports no React/R3F/Three/Ecctrl and never reads devices or mutates render objects. |
| `packages/runtime-r3f/**` | browser 3D runtime adapters | The sole React/R3F/React Three Rapier/Three/Ecctrl integration boundary: paused Rapier-world ownership, fixed-step bridge, collision copying, snapshot interpolation, render resource cleanup, optional Ecctrl translation. | Imports only documented installed public surfaces; cannot own gameplay facts, duplicate the clock/event queue, use Ecctrl for the snowball, or expose raw library objects to engine/gameplay. |
| `packages/input/**` | input | Keyboard, standard gamepad, touch adapters, `InputFrame`, semantic UI actions, source arbitration, edges, hysteresis, and release synthesis. | UI and gameplay consume normalized frames only; no Ecctrl or snowball-controller ownership. |
| `packages/content-runtime/**` | content runtime | Catalog rehydration, install planner, Dexie/Cache Storage coordination, catalog/install service-worker extension contracts, runtime integrity checks, P05 Dexie v1 migration preservation, and versioned SaveExport import/export logic. | Consumes curated catalog files only; never resolves npm or extracts tarballs in the browser. Save import fails closed on corrupt, oversize, incompatible, or privacy-violating payloads. |
| `packages/cli/**` | `infinite-snowball` CLI | Authoring, validation, conversion, build, preview, packing, catalog verification/submission, dry-run publishing. | Real publishing is blocked until P11 external gates pass. CLI never weakens runtime content policy. |
| `packages/ui/**` | shared UI | Tokens, accessible DOM primitives, low-frequency UI snapshots, responsive and reduced-motion patterns. | Does not read raw input devices or own gameplay simulation state. |
| `content/**` | starter content | Starter level, objects, character, campaign, music, source/evidence ledgers, reproducible transforms. | Uses only cleared assets/music and GLB-first runtime outputs. |
| `catalog/**` | curated catalog | Static registry, submissions, reviewer evidence, immutable file/hash metadata, withdrawal/replacement records. | No unreviewed npm search or implicit trust. |
| `docs/**` | Mintlify/community docs | Start Here, Create Packs, Reference, Contribute, Project docs and contributor contracts. | Docs source remains in repo; live deployment waits for Mintlify gate. |

Internal workspace package names may use the `@infinite-snowball/*` scope while private. Public scoped package publishing waits for npm organization ownership; the unscoped public CLI target remains `infinite-snowball` after P11 name recheck. The web app may depend on an internal workspace package only after that package exists: P05 must not predeclare `@infinite-snowball/content-runtime` or `@infinite-snowball/ui`, P07 may add `@infinite-snowball/content-runtime` only after `packages/content-runtime/**` exists, and P08 may add `@infinite-snowball/ui` only after `packages/ui/**` exists.

## 2. Domain object contracts

### 2.1 Common scalar rules

| Scalar | Contract |
|---|---|
| `PackageName` | Exact npm package name from manifest and catalog. Names must match the package being validated. |
| `SemverVersion` | Exact semantic version, not a range, for installable package identities and locks. |
| `EngineRange` | Declared Infinite Snowball compatibility range; rejected when incompatible with the running engine. |
| `ContentKind` | One of `level`, `character`, `object-pack`, `campaign`, `music`, `bundle`. |
| `SafeRelativePath` | Normalized relative path under allowed roots only; reject absolute, drive, UNC, `..`, NUL, symlink, encoded traversal, Unicode/case collision, and unknown files. |
| `Sha256` | Lowercase hex SHA-256 of exact bytes. Hash mismatches are fatal. |
| `Bytes` | Non-negative integer byte count. File, package, and level totals must satisfy current budgets. |
| `Mime` | Declared MIME must match extension and sniffed/parsed content where supported. |
| `StableId` | Deterministic ID used for sorting, references, saves, and tests. It must not depend on iteration order or random runtime allocation. |

### 2.2 `PackageRef`

| Field | Contract |
|---|---|
| `name` | Exact package name. |
| `version` | Exact version; ranges are invalid inside locks and catalog entries. |
| `kind` | Content kind. |
| `engine` | Compatible engine range copied from the manifest. |
| `integrity` | npm tarball integrity recorded by catalog CI. |
| `manifestSha256` | Hash of the approved manifest bytes. |
| `catalogEntryId` | Stable catalog entry that approved this exact package/version. |

### 2.3 Manifest

The manifest file is `dist/infinite-snowball.json`. Strict validation rejects unknown fields.

| Field | Contract |
|---|---|
| `schemaVersion` | Protocol schema version. Migrations must be explicit and idempotent. |
| `name`, `version`, `kind`, `engine` | Exact identity, kind, and compatibility fields. |
| `metadata` | Localized title/description plus author, homepage, repository, screenshots, icon, and tags. No fake ratings/reviews/store badges. |
| `license` | SPDX package license. Per-asset licenses still required. |
| `entries` | Declarative entries matching the package kind. No executable fields. |
| `dependencies` | Exact required `PackageRef` dependencies. DAG must be acyclic. |
| `optionalPeers` | Exact optional peer refs; absence must not break base validation. |
| `assets` | Flat `AssetRecord[]` inventory for every runtime file. |
| `totals` | Declared bytes, file count, uncompressed size, and kind-specific budgets. |
| `capabilities` | Empty object in v1. Non-empty capabilities are rejected until a later security ADR. |

### 2.4 Declarative entry shapes

| Kind | Required declarative shape |
|---|---|
| `level` | `levelId`, localized display metadata, arena/layout asset refs, spawn pose, final goal object, 90-second starter-compatible timer support, size bands, collectible groups, objective rules, win/time-out rules, music refs, camera bounds, performance budgets. |
| `character` | `characterId`, display metadata, GLB model asset ref, animation clips, scale/bounds, optional humanoid controller preset, icon/screenshot refs, license/provenance refs. Character entries do not control the snowball. |
| `object-pack` | `objectPackId`, collectible object definitions with stable IDs, required radius, authored volume, integer points, category, collider/render asset refs, attach policy, material/LOD metadata, per-object budget hints. |
| `campaign` | `campaignId`, ordered exact level refs, unlock/progression rules, default starter package refs, localized copy, recovery behavior for missing optional content. |
| `music` | `musicPackId`, track list with asset refs, title/creator/source/attribution, license, duration, loop/cue metadata, bus defaults, byte/track limits. NC/ND/ambiguous grants are invalid. |
| `bundle` | `bundleId`, exact refs to levels, object packs, characters, campaigns, and music packages, install order hints, default activation set. Bundle entries contain no new executable behavior. |

### 2.5 `AssetRecord` and `Provenance`

| Field | Contract |
|---|---|
| `assetId` | Stable manifest-local ID. |
| `path`, `mime`, `bytes`, `sha256`, `role` | Flat inventory values for one runtime asset. |
| `license`, `licenseUrl`, `capturedLicenseSha256` | SPDX/license evidence. Missing or incompatible evidence is fatal for catalog approval. |
| `creator`, `source`, `acquisition` | Human-verifiable origin. OS3A is discovery-only until this evidence points to the original creator/source/license. |
| `sourceArtifactSha256` | Hash of retained source artifact outside runtime output. |
| `modifications` | Transform summary, including whether Blender/headless conversion, glTF Transform, compression, atlas, LOD, or render checks were applied. |
| `outputSha256` | Hash of final runtime bytes; must equal inventory `sha256`. |
| `reviewer`, `reviewedAt`, `evidenceStatus` | `verified`, `incomplete`, `disputed`, or `withdrawn`. New installs require `verified`. |
| `notes`, `replacement` | Withdrawal/replacement context. Withdrawal blocks new installs but preserves saves/history. |

### 2.6 Catalog objects

| Object | Contract |
|---|---|
| `CatalogSnapshot` | Snapshot ID, schema version, generated timestamp, ETag/version metadata, entry IDs, literal `resourceBasePath: "./catalog/"`, evidence hash, and previous snapshot pointer. Legacy `cdnBaseUrl` is forbidden. Dexie keeps the last valid snapshot during refresh. |
| `CatalogEntry` | Curated row keyed by `(snapshotId, packageName, version)`, with exact ref/kind/display, `screenshots`, `icon`, and `packageRecordPath` using `CatalogResourcePath`, npm/review evidence, status/replacement, and normalized package key. |
| `CatalogPackage` | Distinct `(name, version)` row containing immutable files whose package-local `path` is separate from prefix-local `resourcePath`, plus MIME/bytes/hashes/budgets/licenses/engine/manifest/eligibility. Never collapse it into an entry. |
| `CatalogPackageAsset` | Join for exact package/version with package-local `path`, immutable catalog `resourcePath`, hash, and reference-count eligibility. Legacy absolute `url` is forbidden. |

`CatalogResourcePath` is a dedicated canonical ASCII relative-path type, not generic `SafeRelativePath`: it rejects empty/double/dot segments, absolute/root/scheme-relative paths, drive/UNC/backslash forms, colon/schemes, percent/encoded variants, query, and fragment aliases. V1 resources live under frozen `./catalog/`; a browser-safe resolver takes an injected app base. Page and worker callers derive it from `document.baseURI` and `self.registration.scope`; each resolution must stay same-origin inside that prefix's `catalog/`. External CDN/base configuration requires a later ADR/schema/CSP/availability migration.

### 2.7 Install and save objects

| Object | Contract |
|---|---|
| `PackageLock` | Active installed content lock containing exact package DAG, catalog snapshot ID, file hashes, engine version, created timestamp, and active pointer. Side-by-side updates create a new lock before activation. |
| `InstallPlan` | Exact acyclic package DAG, required immutable files, expected bytes, quota estimate, dependency order, and offline availability result. |
| `InstallTransaction` | Transaction ID, state (`planned`, `staging`, `verifying`, `committing`, `installed`, `failed`, `canceled`), staging cache namespace, verified file set, error code/details, rollback actions, reconciliation status, timestamps, and retention marker. Failed/canceled rows are retained until explicit retention cleanup. |
| `InstallRecord` | Installed package ref, active lock pointer, ref counts, installed timestamp, source catalog snapshot, and reconciliation status. |
| `SaveExport` | Versioned local-only payload with frozen `checksumAlgorithm: "sha256"`, exact canonical UTF-8 payload size, and SHA-256 checksums for the full payload plus progress, settings, and lock sections. Structural parsing is synchronous; Web Crypto integrity verification is asynchronous and mandatory before atomic import. It contains no account IDs, cloud IDs, local soundtrack bytes/tags/artwork, credentials, analytics, diagnostics, or undeclared network refs. |

SaveExport integrity domain:

- Canonical JSON emits sorted object-key/value tokens directly in explicit UTF-16 code-unit order, preserves array order, and uses normal `JSON.stringify` scalar encoding; it never relies on JavaScript object enumeration order.
- Canonical bytes are exactly `new TextEncoder().encode(canonicalJson)`.
- The full payload domain contains every SaveExport field except the self-referential `payloadBytes`, `sectionChecksums`, and `checksum` fields; it includes the frozen `checksumAlgorithm: "sha256"` field.
- `payloadBytes` equals the canonical full-payload byte length and `checksum` is Web Crypto `SHA-256` over those exact bytes.
- `sectionChecksums.progress` hashes canonical `{ campaignProgress, levelProgress }`, `sectionChecksums.settings` hashes canonical `settings`, and `sectionChecksums.locks` hashes canonical `activePackageLockIds`.
- `parseSaveExport` performs bounded privacy preflight and synchronous structural validation only. `verifySaveExportIntegrity` must succeed asynchronously before import accepts or mutates any state.
- Before Zod traversal, a descriptor-only iterative preflight rejects cycles, accessors, sparse/exotic arrays, non-plain objects, reserved record keys, and over-cap nodes/properties. It counts the exact canonical payload-domain UTF-8 bytes while excluding only the three self-referential integrity fields and fails with `E_SAVE_EXPORT_SIZE` above 16 MiB. The aggregate walk budget is derived to admit every schema-valid composition that remains below that byte ceiling; objective record keys are data IDs, not privacy field names.

## 3. Runtime ownership and ordered tick contract

### 3.1 Ownership

| Owner | Owns | Must not own |
|---|---|---|
| Koota core world | Gameplay facts, tag/AoS traits, stable content IDs, residency, project-owned ordered-system inputs, low-frequency UI snapshots, deterministic reducer state. | Dynamic body transforms/velocities/collisions; Three resources; React state; implicit query ordering; persisted/reused packed entity numbers. |
| Rapier world | Dynamic rigid bodies, colliders, velocities, collision/intersection events, authoritative snowball sphere body/collider/mass. | Render object transforms after snapshot export; menu state; catalog data; automatic stepping alongside the project clock. |
| `runtime-r3f` adapter | A paused/non-interpolating React Three Rapier provider, one fixed-step world bridge, one event queue, collision copying, cleanup, and optional Ecctrl translation. | Gameplay facts/reducers, a second clock/event queue, wrapper collision callbacks mixed with raw stepping, or Ecctrl snowball authority. |
| Three/R3F | Geometry, materials, textures, instances, cameras, lights, render resources. | Gameplay truth or physics state. |
| Render bridge | Copies/interpolates previous/current plain physics snapshots to objects/instances and attaches collected visuals. | Physics stepping, gameplay eligibility, controller decisions, React state writes per frame. |
| Camera rig | Horizon-stable camera transform, collision-aware placement, reset, sensitivity, invert-Y, optional auto-recenter. | Ball roll transform or gameplay state. |
| React DOM state | Menus, forms, pause overlay, store UI, routing, low-frequency HUD snapshots. | Per-tick simulation state, raw device polling, physics transforms. |

### 3.2 Tick order

1. Dequeue normalized input for the tick.
2. Compute snowball/controller and camera intents.
3. Step Rapier.
4. Sort and consume physics events.
5. Apply eligibility, ownership, and collection rules.
6. Disable collected body and attach visual instance/local pose.
7. Apply growth, mass, score, objectives, and audio events.
8. Commit streaming/residency updates.
9. Publish physics/render snapshot.
10. Publish throttled low-frequency UI snapshot.

### 3.3 Timing invariants

- Simulation ticks at fixed 60 Hz.
- Visible frames may execute at most four catch-up ticks.
- Hidden tab, tab loss, blur, or long pause executes zero catch-up ticks and resumes from a paused state.
- Excess wall-clock accumulation is clamped and counted in telemetry.
- Pure gameplay reducers are exact-testable; Rapier pose expectations use documented tolerances.
- No phase may claim cross-browser bitwise physics determinism.

## 4. Input, device, and bridge contracts

### 4.1 `InputFrame`

| Field | Contract |
|---|---|
| `version` | Input protocol version. |
| `tick` | Simulation tick the frame applies to. |
| `timestampMs` | Monotonic timestamp in milliseconds. |
| `move` | `{x,y}` vector, unit-clamped; keyboard diagonals normalized. |
| `look` | `{x,y}` vector, unit-clamped after deadzone/curve. |
| `held` | Map of active semantic actions, including movement/action/camera reset plus UI `up`, `down`, `left`, `right`, `pause`, `confirm`, and `back` where present. |
| `pressed` | Edge map derived once per tick; raw key repeat is ignored. Directional UI edges fire once per neutral-to-active transition. |
| `released` | Edge map derived once per tick, including synthetic releases and analog direction release below hysteresis. |
| `source` | `keyboard`, `gamepad`, or `touch`. |
| `deviceId` | Session-stable device identifier; no persistent fingerprinting. |

### 4.2 Adapter requirements

| Adapter | Contract |
|---|---|
| Keyboard | WASD/arrows baseline, configurable bindings later, no key-repeat edges, focus-safe handling, blur synthesizes releases. |
| Gamepad | Standard mapping, radial movement deadzone `0.20` with rescaling, connect/disconnect polling, no unreviewed unmapped profiles, capability-checked rumble only after review. UI directions use D-pad or left-stick activation at `0.55` and release at `0.35`, yielding one edge per neutral-to-active transition. |
| Touch | Pointer capture, safe area support, left move stick, right camera drag, visible action/pause/reset controls >=48px for coarse gameplay pointers, pointercancel synthesizes releases. Touch UI directly focuses/activates the same DOM controls and may emit normalized directions where a virtual control is present. |
| UI commands | `up`, `down`, `left`, `right`, `pause`, `confirm`, and `back` are normalized semantic actions. Directional edges never use browser key-repeat timing; keyboard/gamepad/touch tests prove matching pressed/held/released semantics. UI never reads raw device APIs. |
| Arbitration | Last meaningful gameplay activity owns gameplay input for two seconds. UI safety/navigation commands remain source-agnostic and do not steal gameplay source ownership merely by moving DOM focus. |
| Ecctrl bridge | Converts normalized frames to public Ecctrl movement APIs only for humanoid/on-foot/touch-supported modes. |
| Snowball bridge | Converts normalized frames to torque, braking, turn, boost/action, and camera intents for the custom sphere controller. |

## 5. Persistence, cache, install, and service-worker contracts

### 5.1 Dexie tables

| Table | Contract |
|---|---|
| `catalogSnapshots` | Last valid and historical static catalog snapshots. |
| `catalogEntries` | Curated listing/freshness rows keyed by `(snapshotId, packageName, version)`. |
| `packages` | Distinct normalized manifest/install/withdrawal rows keyed by `(name, version)` and referenced by catalog entries and locks. |
| `assets` | Immutable asset metadata keyed by URL/path/hash. |
| `packageAssets` | Package-to-asset joins and reference counts. |
| `packageLocks` | Installed exact DAG locks and active pointers. |
| `installTransactions` | State machine records, failed/canceled audit rows, rollback actions, verified sets, and rollback/reconciliation data. |
| `saves` | Local save slots and export/import metadata; P05 creates v1 for starter progress and P07 migrates it atomically. |
| `settings` | Local settings, input preferences, accessibility preferences, storage-persistence result; P05 creates v1 and P07 migrates it atomically. |
| `migrations` | Applied schema/content migrations; migrations are atomic and idempotent. |

### 5.2 Cache and service worker
Phase ownership for future web-shell files is split deliberately: P05 creates `apps/web/package.json` with `private: true` and no future package dependencies, `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/src/main.tsx`, exact `apps/web/src/app/router.tsx` initial play-route registration, the minimal `apps/web/src/routes/play/**` shell, `apps/web/public/manifest.webmanifest`, `apps/web/src/sw.ts`, `apps/web/src/pwa/register-service-worker.ts`, `apps/web/src/pwa/starter-precache.ts`, and versioned Dexie v1 `apps/web/src/db/schema.ts`, `apps/web/src/db/starter-save-adapter.ts`, and `apps/web/src/db/starter-save-adapter.test.ts` for `VG-05-OFFLINE-RUN`. P07 consumes that passing baseline and may modify only `apps/web/package.json` dependencies/scripts to add/use `@infinite-snowball/content-runtime` while preserving `private: true`, existing scripts, and P05 behavior, plus `apps/web/src/sw.ts` and later `apps/web/src/db/**` migration/catalog/store code to add catalog/thumbnail/immutable package caching, install/cache coordination, and atomic Dexie migrations. P08 consumes the P07 handoff and may modify only `apps/web/package.json` dependencies/scripts for `@infinite-snowball/ui`, exact `apps/web/src/app/router.tsx` presentation routes, and `apps/web/public/manifest.webmanifest` plus its inherited test expectation only for `start_url`, `description`, `theme_color`, and `background_color`, preserving `private: true`, P05 gameplay, and every other manifest/icon/SW field and byte.


| Area | Contract |
|---|---|
| Cache Storage | Owns immutable URL responses for package assets plus app/catalog/media responses according to the service-worker strategy. |
| Version namespaces | Cache and DB schema namespaces include app/content protocol version. Retain one known-good shell. |
| Precache | P05 precaches the P05-owned app shell and exact P03 starter content needed for `VG-05-OFFLINE-RUN`; P07 may append catalog/package strategies without broadening the starter offline contract. |
| Catalog/thumbnails | Stale-while-revalidate. Last valid snapshot remains visible when refresh fails. |
| Immutable assets | Cache-first and hash-pinned. |
| Mutable metadata | Network-first with last-valid fallback. |
| Activation | Activate only after schema and boot health checks. |
| Persistence | Call `navigator.storage.persist()` only after a gesture; estimate quota before large installs; never promise permanence. |

#### PWA evidence boundary

- The response-backed manifest floor is exact: P05 creates `name: "Infinite Snowball"`, `short_name: "Snowball"`, `display: "standalone"`, `id: "./"`, `start_url: "./#/play"`, `scope: "./"`, omits `prefer_related_applications`, and supplies real relative 192x192/512x512 PNG purpose-any icons. Icon responses must match recorded bytes/MIME/dimensions/hash and SW fetch must work. P08 may change only start to `./#/start` plus description/theme/background; all other values, the required absence, and icon bytes persist. P10 freezes/revalidates them. Manifest-only parsing never suffices.
- Automated Chromium installability means only this observable: for each `{artifact-or-stage hash, project, origin}` start a fresh/proven-empty non-incognito `chromium.launchPersistentContext(userDataDir)`, verify online document/SW/cache response hashes, wait for control, send real CDP `Browser.getVersion`, `Page.enable`, and `Page.getInstallabilityErrors`, require an empty error array, then fully close and reuse that profile only for the same run's offline relaunch. Record logical profile/options, Playwright package version, full Browser/installability responses, and hashes; never use `context.browser()`/`browser.version()`, ephemeral contexts, synthetic prompts, mocks, stale profiles, or cross-stage/project/origin/rerun reuse. Unsupported/nonempty including `IN_INCOGNITO` blocks the Chromium row.
- P05 proves the exact criteria plus browser observable at each isolated origin/project. P08 uses distinct fresh profiles for every `{pre/post artifact hash, project, origin}`, proves only authorized manifest fields changed and icon evidence stayed fixed, and never reuses across stages, projects, origins, or reruns. P10 repeats the frozen criteria, icon responses, and observable per `{candidate hash, project, origin}`. None is OS-install proof.
- Native PWA lifecycle is a separate P10 headed/manual row: supported shipping platforms must use native install UI, launch from the OS surface, fully terminate the app/browser (or recorded platform-equivalent action), disable network outside page automation and prove a live probe fails, then relaunch from the OS surface and play/save offline. Unsupported rows name the absent capability and reason; profile reopening, history, bookmarks, and Playwright contexts cannot satisfy it.

### 5.3 Install transaction invariants

- Resolve exact dependencies into an acyclic DAG before fetch.
- Validate the literal catalog base and every `CatalogResourcePath`; resolve through the browser-safe helper against the caller's injected app base and require same-origin containment inside that prefix's `catalog/` before fetch/cache. Page and worker resolutions for a record must identify corresponding prefix-local bytes; never accept legacy absolute URL fields.
- Preflight quota and request persistence before staging.
- Stage files into a transaction-specific cache namespace.
- Stream and verify hash, MIME, size, and policy for every file before commit.
- Commit package lock, refs, active pointer, and transaction status atomically.
- Update side-by-side; previous active lock remains usable until the new lock commits.
- Failure or cancellation deletes staging bytes only and preserves the previous lock plus the failed/canceled transaction row with error, verified set, rollback actions, and reconciliation status until explicit retention cleanup.
- Offline install is allowed only when every locked object is already verified and cached.
- Uninstall deletes only assets whose reference count reaches zero.
- Reconciliation repairs drift between Dexie records and Cache Storage responses.
- SaveExport import/export is versioned and atomic; corrupt, oversize, incompatible-version, checksum-mismatched, or privacy-violating imports fail closed without modifying existing saves, settings, locks, or packages.

### 5.4 Error and invariant codes

| Code | Meaning | Recovery contract |
|---|---|---|
| `E_SCHEMA_STRICT` | Unknown/missing/invalid manifest or catalog field. | Reject package; show actionable validation path. |
| `E_ENGINE_RANGE` | Package incompatible with current engine. | Do not install; suggest compatible version when catalog knows one. |
| `E_PATH_POLICY` | Path traversal, absolute path, symlink, Unicode/case collision, encoded variant, or unknown file. | Reject package and preserve prior state. |
| `E_FILE_BUDGET` | File count, file bytes, total bytes, depth, or compression ratio exceeds policy. | Reject or require author-side optimization. |
| `E_MIME_MISMATCH` | Declared MIME/extension/content mismatch. | Reject asset. |
| `E_HASH_MISMATCH` | SHA-256 mismatch. | Delete staged bytes only, retain failed transaction evidence, preserve previous lock, and require catalog/author fix. |
| `E_LICENSE_POLICY` | Missing, incompatible, disputed, withdrawn, NC/ND, ambiguous, or unverified license evidence. | Block new installs; preserve existing saves/history. |
| `E_CODE_FORBIDDEN` | JS/WASM/HTML/CSS or executable behavior detected in community content. | Reject package. |
| `E_GLB_REFERENCE` | GLB external/data/network reference violates self-contained policy. | Reject asset until converted. |
| `E_CODEC_UNSUPPORTED` | Audio/texture/media codec outside approved runtime support. | Reject or require supported transcode. |
| `E_DAG_CYCLE` | Dependency graph is cyclic. | Reject install plan. |
| `E_NPM_PROVENANCE` | Catalog CI cannot verify npm version/integrity/provenance. | Block catalog approval. |
| `E_QUOTA` | Estimated or actual quota unavailable. | Delete staging bytes only, retain failed transaction evidence, preserve prior lock, and show cleanup/export guidance. |
| `E_CACHE_WRITE` | Cache write or readback verification failed. | Delete staged bytes only, retain failed transaction evidence, and preserve previous lock. |
| `E_OFFLINE_MISSING_ASSET` | Offline install requested but a required verified object is absent from cache. | Keep package unavailable offline; show freshness/install state. |
| `E_MIGRATION` | Migration failed health check. | Retain prior usable data, failed migration evidence, and known-good shell. |
| `E_SAVE_EXPORT_VERSION` | Save export schema or game/migration version is incompatible. | Reject import before mutation and preserve current saves/settings/locks. |
| `E_SAVE_EXPORT_SIZE` | Save export exceeds configured size budget. | Reject import before mutation and advise cleanup/new export. |
| `E_SAVE_EXPORT_INTEGRITY` | Save export is corrupt or checksum validation fails. | Reject import before mutation and preserve current data. |
| `E_PRIVACY_EGRESS` | Export/import payload includes forbidden private, credential, analytics, cloud, undeclared network, or local-audio data. | Reject payload, record evidence locally, and do not transmit it. |
| `E_INPUT_RELEASE` | Device loss/cancel/visibility change required synthetic releases. | Release held actions and continue paused/safe. |
| `E_PHYSICS_TOLERANCE` | Pinned physics expectation outside documented tolerance. | Fail targeted test/profile; do not mask with looser runtime rules. |

## 6. Catalog and CLI command contracts

| Command | Phase owner | Contract |
|---|---|---|
| `init` | P06 | Create authoring project/package skeleton only in the requested target path, with strict manifest defaults and no runtime app scaffold. |
| `validate --strict --json` | P02/P06 | Validate manifest, asset inventory, schemas, policies, dependencies, budgets, licenses, and output machine-readable errors using the codes above. |
| `convert` | P03/P06 | Run reproducible asset conversion/normalization into GLB-first outputs with source hashes and provenance updates. |
| `build` | P06 | Produce a deterministic data-only package output under `dist/` without executable community code. |
| `preview` | P06 | Preview package metadata/assets locally using safe validators and no catalog trust bypass. |
| `pack` | P06 | Create a package artifact suitable for npm dry-run/catalog CI validation, preserving exact hashes. |
| `install <exact-spec>` | P06 for authoring, P07 for runtime semantics | Install exact local/developer package specs into an authoring/test environment with strong warnings; runtime store still uses curated catalog entries. |
| `catalog verify` | P06/P07 | Verify npm provenance, exact version, integrity, manifest, files, hashes, budgets, licenses, and reviewer evidence for catalog submissions. |
| `submit` | P06/P09 | Prepare transparent catalog PR/submission materials with evidence, not automatic approval. |
| `publish --dry-run` | P06/P11 | Always safe before external gates. Real npm publication is blocked until P11 npm account/scope/2FA/trusted-publishing gate and protected CI evidence pass. |

Browser runtime never exposes npm resolution, tarball extraction, lifecycle hooks, `import()` of community packages, `eval`, undeclared URL following, or arbitrary code execution.

## 7. Security, licensing, offline, and local-audio boundaries

- Manifest, catalog, CLI, and browser validators share the same closed protocol and strict unknown-field rejection.
- Community packages are data-only; code extensions are reviewed core changes.
- Catalog entries require exact npm version/integrity, per-file hashes, reviewer/date/evidence, budgets, licenses, and withdrawal/replacement data.
- Prototype assets are limited to exact-artifact-cleared Quaternius, KayKit, or Kenney CC0 unless stronger evidence is reviewed; OS3A remains discovery-only; Pelican is rejected.
- Music is original/commissioned/CC0/CC-BY with complete attribution. NC/ND/ambiguous royalty-free grants are rejected.
- The linked Katamari soundtrack is never bundled, mirrored, streamed, suggested, cataloged, or auto-installed.
- Future local soundtrack import is local-only: bytes, filenames, tags, artwork/waveforms, hashes, playlists, and rights assertions never enter network, catalog, npm, analytics, diagnostics, cloud/export, screenshots, or service-worker network requests. Clear-all removes references. The product never identifies famous works or implies rights.
- v1 has no backend, accounts, cloud saves, leaderboards, multiplayer, or D1. Export/import is the save portability contract: P05 owns persisted starter `saves`/`settings`, P07 owns fail-closed versioned SaveExport import/export, P08 owns accessible Settings Save Data UI, and P10 owns browser/device restore QA.

## 8. P01-P11 interface contracts

| Phase | Depends on | Consumes | Produces and hands off | Primary gate IDs |
|---|---|---|---|---|
| P01 `Infinite-Snowball-Phase-01-Foundation.md` | None | Reconciled decisions, dependency snapshot, planning-only package/domain map. | Future private pnpm workspace, exact lock, root quality harness, baseline CI/security check contract, no app feature claims. Hands workspace and check contract to all later phases. | `VG-01-WORKSPACE`, `VG-01-CI-CONTRACT` |
| P02 `Infinite-Snowball-Phase-02-Protocol-Security-Offline-Design.md` | P01 | Workspace/check contract; this protocol and error contract. | `packages/protocol/**`, generated schema, adversarial fixtures, threat/policy docs, no-code package rule, offline/install transaction design, no-backend/D1 boundary. Hands stable schemas to P03/P04/P06/P07. | `VG-02-SCHEMA`, `VG-02-NO-CODE`, `VG-02-THREATS`, `VG-02-OFFLINE-DESIGN`, `VG-02-D1-BOUNDARY` |
| P03 `Infinite-Snowball-Phase-03-Assets-Music-Starter-Content.md` | P02 | Protocol, license policy, asset budgets, provenance shape. | Cleared starter assets/music/content fixtures, GLB-first pipeline evidence, provenance and third-party ledgers, local-audio boundary notes. Hands starter packages and evidence to P05/P06. | `VG-03-ASSETS`, `VG-03-LICENSES`, `VG-03-MUSIC`, `VG-03-LOCAL-AUDIO` |
| P04 `Infinite-Snowball-Phase-04-Runtime-Input-Simulation.md` | P01, P02 | Workspace, protocol types, runtime ownership/tick/input contracts. | Pure engine/input/gameplay packages plus `packages/runtime-r3f/**` as the sole browser 3D adapter boundary; Koota core CSP/order/lifecycle tests, one paused Rapier fixed-step/event bridge, render snapshot interpolation, custom sphere controller, optional Ecctrl translation, normalized input adapters, deterministic reducers, and performance telemetry. Hands tested runtime foundation to P05. | `VG-04-RUNTIME`, `VG-04-ECCTRL`, `VG-04-INPUT-CONTRACT`, `VG-04-PERFORMANCE` |
| P05 `Infinite-Snowball-Phase-05-First-Playable-Vertical-Slice.md` | P03, P04 | Cleared starter content, runtime/input/controller seams, and private workspace/check contract. | Private web app/starter run, Dexie v1 saves/settings, exact response-backed manifest installability floor with 192/512 purpose-any PNG icons, dual-origin manifest/SW/cache, fresh-profile offline completion, Chromium installability observable, and supplemental meta-only CSP/Rapier proof using a build-emitted inert same-origin external probe asset with recorded path/hash. Not OS installation; P10 owns supported native lifecycles. Hands exact web, artifact, policy, probe, and WASM hash evidence to P07/P08. | `VG-05-PLAYABLE`, `VG-05-INPUT-PARITY`, `VG-05-OFFLINE-RUN` |
| P06 `Infinite-Snowball-Phase-06-Creator-CLI-Package-Workflow.md` | P02, P03 | Protocol, starter content/provenance, catalog policy. | CLI authoring/validation/conversion/build/preview/pack/install exact-spec workflow, package examples/templates, catalog submission fixtures and contributor path. Hands package workflow to P07/P09/P11. | `VG-06-CLI`, `VG-06-AUTHOR-JOURNEY`, `VG-06-SUBMISSION` |
| P07 `Infinite-Snowball-Phase-07-Secure-Offline-Catalog-Store.md` | P05, P06 | Passing P05 web-shell/offline-run/Dexie v1 baseline, supplemental P05 CSP/probe/WASM hash set, `apps/web/package.json` private/no-future-dependency evidence, controlled `apps/web/src/sw.ts` handoff, CLI/catalog submissions, offline design. | `packages/content-runtime/**`, controlled `apps/web/package.json` dependencies/scripts update only for `@infinite-snowball/content-runtime` while preserving `private: true`, existing scripts, P05 behavior, Dexie migration from P05 v1 plus distinct catalog/store tables, installer state machine, catalog registry, rollback/quota/migration/offline behavior, versioned SaveExport import/export, store controller layer, controlled extension of `apps/web/src/sw.ts`, and rerun of P05 offline/CSP gates after build-affecting changes. | `VG-07-REHYDRATE`, `VG-07-INSTALL`, `VG-07-RECOVERY` |
| P08 `Infinite-Snowball-Phase-08-Product-UI-PWA-Landing.md` | P05, P07 | Playable route, P07 updated private web package, store and SaveExport controllers, design identity, accessibility rules, and P05/P07 latest artifact/policy/probe/WASM hashes. | `packages/ui/**`, controlled `apps/web/package.json` dependencies/scripts update only for `@infinite-snowball/ui`, exact `apps/web/src/app/router.tsx` registration for landing/splash/store/settings without rewriting P05 gameplay behavior, original logo/splash/Press Start, HUD, pause, store UI states, Settings Save Data export/import UI, landing IA, responsive/mobile/WCAG/reduced-motion behavior, PWA prompts, paired manifest proof, and post-build-affecting CSP proof. | `VG-08-SPLASH`, `VG-08-GAME-UI`, `VG-08-LANDING`, `VG-08-A11Y` |
| P09 `Infinite-Snowball-Phase-09-Docs-Community-Release-Collateral.md` | P06, P07, P08 | CLI workflow, catalog/store behavior, final UI capture targets. | Mintlify IA/source, contributor contracts, README screenshots/badges/instructions, screenshot manifest/captures, community policies and examples. Hands release collateral to P10/P11 without ceding P09 authorship. | `VG-09-DOCS`, `VG-09-CONTRIBUTING`, `VG-09-README`, `VG-09-SCREENSHOTS` |
| P10 `Infinite-Snowball-Phase-10-Cross-Device-QA-Performance-Review.md` | P09 | Full release candidate, docs/collateral, all prior gate evidence, and the latest post-P08 CSP/manifest proof. | Release-candidate Playwright config, frozen matrix schema, automated Chromium/Firefox/Playwright-WebKit plus `mobile-chromium`/`mobile-webkit` rows, distinct manual shipping macOS Safari and real-iPhone Safari rows, manual matrix validator, browser/device QA, performance profiles, save export/import, reinstall/offline restore, corrupt import and private/local-audio exclusion QA, mandatory code/security/license/accessibility/matrix reviews, targeted fixes coordinated with owning areas, and release-candidate evidence. Hands green RC evidence plus approved matrix to P11. | `VG-10-DEVICES`, `VG-10-PERF`, `VG-10-REVIEWS` |
| P11 `Infinite-Snowball-Phase-11-Public-Release-Deployment-Audit.md` | P10 | Frozen RC, approved matrix, credentials, collateral, terminal CI, and release SHA/artifact/policy/probe/WASM hashes. | Concrete `tools/release/**` preflight/cutover/verification tooling; preserve-public or convert-private repo mode; protected controls before/after visibility; inert tag; web host delivery rerun in Chromium only plus selected clean native lifecycle; Cloudflare header+meta intersection and GitHub Pages meta-only proof; docs verification; protected-CI OIDC npm dispatch/monitor last; purpose-separated evidence; final audits. Failure rolls back/deprecates and stops. | `VG-11-PUBLIC-REPO`, `VG-11-NPM`, `VG-11-WEB`, `VG-11-DOCS-LIVE`, `VG-11-CHECKS`, `VG-11-README-LIVE`, `VG-11-AUDIT` |

Phase interface invariants:

- Downstream phases consume only the outputs and evidence listed above unless they coordinate an owning-phase fix.
- P03 and P04 may run in parallel after P02 because they own disjoint content and runtime files.
- P05 is the first phase allowed to create the minimal `apps/web/**` shell needed by its own vertical-slice and offline PWA gates, including `apps/web/package.json` with `private: true` and no `@infinite-snowball/content-runtime`/`@infinite-snowball/ui` predeclarations, plus `apps/web/src/app/router.tsx` with only the initial play route.
- P06 may overlap P05 after P03 because CLI/package workflow is disjoint from playable route and web-shell integration.
- P07 never starts before P05 stop-gate evidence and P06 package workflow evidence exist; it becomes the only sequential owner of `apps/web/package.json` dependencies/scripts for `@infinite-snowball/content-runtime`, consumes P05's `apps/web/src/sw.ts` handoff, does not own `apps/web/src/app/router.tsx`, and does not claim a P01-defined worker.
- P08 never starts before P07 handoff evidence; it becomes the only sequential owner of `apps/web/package.json` dependencies/scripts for `@infinite-snowball/ui` and exact `apps/web/src/app/router.tsx` landing/splash/store/settings route registration while preserving the P05 play route and `private: true`.
- Manifest and CSP ownership are sequential and narrow: P05 creates/tests the exact installability floor, icon bytes, and supplemental meta-only Chromium CSP/Rapier proof with a build-emitted inert same-origin external probe asset and recorded path/hash; P08 may change only start/description/theme/background with paired pre/post proof and must rerun the CSP/probe proof after build-affecting changes; P10 freezes and revalidates every required manifest/icon/CSP/probe response. No downstream phase may weaken, mock, or waive it.
- P10 fixes must route back to the original owning area; it does not silently seize unrelated ownership. P10 defines/freeze-reviews the cross-browser/device matrix schema before execution, owns the release-candidate Playwright config and QA/review tools, and uses `mobile-chromium`/`mobile-webkit` project names plus distinct shipping macOS Safari and real-iPhone Safari manual rows.
- P11 web checks rerun live host delivery in Chromium plus one selected clean native lifecycle where supported, not the full P10 matrix. Cloudflare must prove the approved CSP header and meta intersect without weakening; GitHub Pages must prove the approved meta-only fallback. Both bind release SHA/artifact/policy/probe/WASM hashes.
- P11 cutover order is fixed: preverify, assert clean HEAD/index at the P10-approved SHA, verify forbidden tracked paths and terminal-green CI `secret-scan` for that SHA, activate/preconfigure and reverify repository controls, create an inert tag that triggers nothing, explicitly promote/verify web, explicitly promote/verify docs, then dispatch/monitor the protected-CI OIDC npm publisher last. `secret-scan --staged` is only for committing pre-freeze edits; local npm publish and continuation after failure are forbidden.
## 9. Planned command, config, and project registry

Every command or project name below is either an existing root script or a future tool/config path owned by the named phase. Playbooks may reference only these concrete names unless the same playbook first declares a new owner/path before use.

| Name | Owner | Kind | Definition / ownership |
|---|---|---|---|
| `node tools/planning/validate-contracts.mjs --write .planning/validation-report.json` | Planning meta-test | current validator command | Deterministic planning contract validator and report writer using only tracked planning inputs. |
| `apps/web/playwright.release-candidate.config.ts` | P10 | future Playwright config | Release-candidate QA config defining `chromium`, `firefox`, `playwright-webkit`, `mobile-chromium`, and `mobile-webkit`; manual shipping Safari rows live in the matrix JSON, not as Playwright projects. |
| `reports/qa/phase-10-device-matrix.schema.json` | P10 | future matrix schema | Schema frozen and review-approved before `VG-10-DEVICES` execution. |
| `reports/qa/phase-10-device-matrix.json` | P10 | future matrix data | Frozen matrix with automated browser rows and manual `shipping macOS Safari` / `real iPhone Safari` rows. |
| `node tools/qa/release-candidate/validate-manual-matrix.mjs` | P10 | future QA tool | Validates manual matrix rows, unsupported reasons, evidence paths, versions, and review signoff before execution is accepted. |
| `node tools/qa/release-candidate/profile-performance.mjs` | P10 | future QA tool | Runs the P10 performance profile scenarios and emits reports. |
| `node tools/qa/release-candidate/run-review-checks.mjs` | P10 | future review tool | Collects mandatory code/security/license/brand/accessibility/matrix review signoffs. |
| `node tools/release/assert-clean-cutover-state.mjs` | P11 | future release tool | Verifies preserve-public/convert-private mode, clean HEAD/index/worktree at the P10-approved SHA, forbidden tracked paths, and terminal-green CI `secret-scan` before each cutover mutation. |
| `node tools/release/preflight.mjs` | P11 | future release tool | Stages previews, tarball allowlists, rollback rehearsal, and release SHA/artifact/policy/probe/WASM hash ledger. |
| `node tools/release/verify-checks.mjs` | P11 | future release tool | Monitors all eleven required checks to terminal green for the exact release SHA. |
| `node tools/release/cutover-repo.mjs` | P11 | future release tool | Applies preserve-public or convert-private repository cutover after controls are verified. |
| `node tools/release/promote-web.mjs` / `node tools/release/verify-web.mjs` | P11 | future release tools | Promote the P10 artifact and verify Cloudflare header+meta intersection, GitHub Pages meta-only fallback, Chromium web-check rows, and selected clean native lifecycle. |
| `node tools/release/promote-docs.mjs` / `node tools/release/verify-docs.mjs` | P11 | future release tools | Publish and verify Mintlify from approved P09 repo source without stealing docs authorship. |
| `node tools/release/dispatch-npm-publisher.mjs` / `node tools/release/verify-npm.mjs` | P11 | future release tools | Dispatch and monitor protected-CI trusted-publishing OIDC job; verify npm integrity/provenance/dist-tags and clean-room CLI. |
| `node tools/release/verify-readme.mjs` / `node tools/release/audit-deliverables.mjs` | P11 | future release tools | Verify live README surfaces and final D001-D042 plus supplemental-gate audit. |
