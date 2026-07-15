# Infinite Snowball architecture and asset research

> Research brief for the OMP Ultra planning root and its delegated architecture, package, offline, gameplay, UI, documentation, and delivery agents. This is evidence and a recommended baseline, not a substitute for phase specifications.

## Product intent

Infinite Snowball is an original, web-native rolling-collection arcade game and open mod ecosystem. It should:

- run as an installable offline-capable browser PWA;
- support keyboard, standards-based gamepads, and touch controls;
- use React Three Fiber, Three.js, Rapier, Koota, and Ecctrl where each tool is technically appropriate;
- install declarative levels, characters, object packs, campaigns, music, and bundles distributed as npm packages;
- expose an `npx`/`pnpm dlx` CLI for authoring, validation, conversion, installation, and publishing;
- provide an in-game catalog/store that renders cached data immediately, revalidates in the background, and supports offline use of installed content;
- ship a colorful landing site, Mintlify documentation, contribution contracts, screenshots, badges, examples, and public releases;
- remain understandable, transparent, permissively licensed, and easy to extend.

## Verified OMP Ultra prerequisite

The current Homebrew OMP 16.4.8 release does not contain PR #5117. A current-main-compatible local port was built and verified before this project-planning work began.

- Installed command: `/opt/homebrew/bin/omp`
- Installed symlink target: `/Users/jeffscottward/.local/bin/omp-ultra-pr5117-16.4.8`
- Verified selector: `openai-codex/gpt-5.6-sol:ultra`
- Verified behavior: Ultra remains visible in session state; provider-facing effort resolves to `max`; the Ultra context/reset records persist; a real Codex turn completed successfully.
- Source worktree: `/Users/jeffscottward/Github/tools/Oh-My-Pi-ultra-current`
- Durable workaround ledger: `/Users/jeffscottward/Github/tools/Oh-My-Pi-ultra-current/.omp-status.md`
- Upstream PR: <https://github.com/can1357/oh-my-pi/pull/5117>

Project planning and phase generation must run from an OMP root session explicitly selected as `openai-codex/gpt-5.6-sol:ultra`, and that root must delegate independent swim lanes through OMP's built-in `task` tool.

## Important corrections and boundaries

### Do not run npm packages in the browser

A browser cannot safely invoke `npm`, `pnpm`, or `npx`, and the game must never `import()`, `eval()`, or execute arbitrary JavaScript from community packages. The correct split is:

- **CLI/build time:** `npx infinite-snowball ...` or `pnpm dlx infinite-snowball ...` resolves npm package specs, converts assets, validates manifests, and can install trusted tooling.
- **Game runtime:** a content-only installer downloads files described by a strict declarative manifest from a curated, version-pinned catalog. It validates schema, paths, types, sizes, hashes, and engine compatibility before caching immutable files.

Code extensions belong in reviewed core contributions. If programmable content is ever needed, design a narrowly scoped capability/DSL or sandbox in a later security-focused phase; do not smuggle executable JS into v1 content packs.

### Ecctrl is not the snowball physics controller

Ecctrl 2.0.0 is a floating-capsule character controller. It is technically wrong as the sole controller for a dynamically rolling sphere. Use it for humanoid characters, NPCs, an optional on-foot hub, and/or its touch input primitives. The primary snowball needs a small custom Rapier sphere controller that applies torque/impulses and owns rolling-specific camera behavior.

Ecctrl still integrates cleanly through its public `EcctrlHandle.setMovement()` API and `MovementInput` shape (`forward`, `backward`, `leftward`, `rightward`, analog `joystick`, `run`, `jump`). Its touch stores expose `setJoystick(x, y, id?)`, `resetJoystick(id?)`, and `setButtonActive(id, active)`.

### Do not start with OffscreenCanvas rendering

Moving a React Three Fiber scene into a worker is not a drop-in optimization. It complicates React/DOM input, loaders, debugging, and scene synchronization. Start with a profiled main-thread R3F renderer. Offload only isolated CPU work first: package hashing/validation, archive parsing, procedural generation, spatial planning, and supported texture/mesh decode workers. Reconsider worker-hosted rendering only after a trace proves the renderer is the bottleneck and browser support/fallback costs are acceptable.

### The linked soundtrack is not redistributable evidence

The Internet Archive item identifies the creator as `Katamari Damacy Series SOUND TEAM & Bandai Namco Game Music`, has no `licenseurl` and no rights grant, and was uploaded through the generic HTML5 uploader. An Archive upload is provenance, not permission. Do not bundle, mirror, stream, or auto-install that soundtrack.

Use original music or explicitly compatible CC0/CC-BY music. A later local-only importer may let a player use audio they already possess, but those files must stay local and must never be uploaded, cataloged, or redistributed by Infinite Snowball.

### Keep the identity original

Use the rolling-collection mechanic as genre inspiration, but do not copy Katamari names, logo treatment, characters, exact UI trade dress, levels, art, sounds, story, or music. Public copy should describe an original rolling-collection arcade game, not market it as an official Katamari product.

## Recommended monorepo shape

Use a pnpm workspace without adding a build orchestrator until the workspace actually needs one. Bun can run compatible local TypeScript scripts and tasks.

```text
apps/
  web/                  # landing, splash, game, in-game store; lazy game route
packages/
  protocol/             # Zod schemas + generated JSON Schema + compatibility rules
  engine/               # Koota worlds, traits, deterministic system ordering
  gameplay/             # snowball controller, collection/growth/scoring systems
  input/                # keyboard, Gamepad API, touch, normalized InputFrame
  content-runtime/      # catalog, installer, integrity, cache/DB coordination
  cli/                  # `infinite-snowball` executable
  create-game/          # optional project/template creator
  ui/                   # shared tokens and accessible DOM UI primitives
content/
  starter-level/
  starter-objects/
  starter-character/
  starter-campaign/
  starter-music/
catalog/
  registry.json         # generated, versioned static catalog
  submissions/          # reviewed package records
docs/                    # Mintlify source and research
.maestro/playbooks/      # explicit phase documents and validation gates
```

Possible public packages:

- `infinite-snowball` — unscoped CLI (verified unclaimed on npm during research)
- `@infinite-snowball/protocol`
- `@infinite-snowball/engine`
- `@infinite-snowball/content-runtime`

Do not assume the `@infinite-snowball` organization scope is owned merely because no package currently exists. Until the npm organization is created and verified, keep workspace packages private or use the owner's verified scope.

## Content package contract

Every installable npm package is data-only and contains a publish-time output such as:

```text
dist/
  infinite-snowball.json
  content/*.json
  assets/*.glb
  textures/*.{ktx2,webp,png}
  audio/*.{mp3,m4a,ogg,opus}
  LICENSES/*
```

Recommended manifest fields:

- `schemaVersion`
- exact npm `name` and semantic `version`
- `kind`: `level`, `character`, `object-pack`, `campaign`, `music`, or `bundle`
- `engine`: supported Infinite Snowball semver range
- localized display metadata, author, homepage, repository, screenshots, icon, tags
- SPDX package license and per-asset provenance/license records
- type-specific declarative entry points
- exact package dependencies and optional peer content
- flat asset inventory: normalized relative path, MIME/type, byte count, SHA-256, role, license, source
- total uncompressed/download sizes and file count
- capabilities/permissions, empty in v1

Validation must reject:

- absolute paths, `..`, encoded traversal, symlinks, and case-collision paths;
- files outside allowed roots or extensions;
- unbounded file counts, individual sizes, or total sizes;
- unknown manifest fields when strict mode is enabled;
- executable JS/WASM/HTML/CSS in community content;
- external references embedded in GLTF/GLB where policy requires self-contained assets;
- MIME/extension mismatches, invalid GLB structure, unsupported audio codecs, missing licenses, hash mismatches, and incompatible engine versions.

The browser should not unpack npm tarballs. CI should transform each approved package version into a curated catalog entry with exact CDN file URLs and hashes. The runtime downloads those already-extracted immutable files.

## Catalog and store lifecycle

Use a curated static catalog in the public repository rather than unfiltered npm search. Anyone can submit a package through a PR; automation validates the npm provenance, manifest, asset budgets, licenses, exact version, and hashes. A maintainer review controls listing, but the process remains transparent.

Store behavior:

1. On startup, render the last valid catalog snapshot from Dexie immediately.
2. Revalidate the catalog in the background with ETag/version metadata.
3. Update normalized Dexie rows transactionally; never blank the store during refresh.
4. Cache catalog responses and thumbnails with stale-while-revalidate.
5. When a card enters the viewport, prefetch only its manifest/icon/thumbnail, not the full pack.
6. On install, resolve exact versions/dependencies, preflight quota, fetch every file, verify SHA-256, and commit the install record only after the whole transaction succeeds.
7. Store immutable URL responses in a versioned Cache Storage cache; store metadata, dependency graph, status, and lockfile in Dexie.
8. On failure/cancel, remove staged cache entries and preserve the last known-good installation.
9. Uninstall only files no longer referenced by another installed package.
10. Offline, show installed and previously browsed entries with explicit freshness/install state.

Developer mode may support an exact unlisted package URL/spec with a strong warning, but the default store must never silently trust arbitrary npm search results.

## Browser persistence decision

The earlier Cache Storage + IndexedDB recommendation is correct, with OPFS deferred:

- **Cache Storage:** URL-addressable GLB, texture, audio, catalog, thumbnail, JS, and CSS responses.
- **Dexie/IndexedDB:** saves, settings, progression, installed-package records, manifests, catalog metadata, dependency locks, migration versions, and cache reference counts.
- **OPFS:** not required for v1. Reconsider only for large mutable imports or workflows needing file-like random access.
- **localStorage:** only tiny boot preferences if synchronous access is truly needed.

Use a custom Vite PWA `injectManifest` service worker rather than a fully generated opaque worker. Strategy baseline:

- precache the app shell and minimal starter content;
- stale-while-revalidate for catalog records and thumbnails;
- cache-first for immutable, hash-pinned package assets;
- network-first with a cached fallback for mutable metadata when freshness matters;
- version cache namespaces and garbage-collect only unreferenced old entries.

After a meaningful user gesture/install action, call `navigator.storage.persist()` and report whether persistence was granted; do not promise permanence. Use `navigator.storage.estimate()` before large installs. Saves need import/export backup before cloud sync exists.

## Runtime architecture

### ECS ownership

Use Koota for simulation state and system ordering, not for every React DOM concern. Keep transient menus/forms in React state. Use Rapier as the source of truth for dynamic physics transforms; do not duplicate mutable transforms in Koota without a clear synchronization owner.

Candidate traits/components:

- identity: `Player`, `Collectible`, `LevelEntity`, `PackOwner`
- snowball: radius, mass, growth, score, size band
- collection: required radius, volume, points, category, attach policy
- physics bridge: stable entity/body/collider handles
- rendering: asset ID, instance group/index, visibility, LOD tier
- attachment: parent snowball, local pose, visual protrusion
- input: normalized per-frame sticks/buttons/source/timestamp
- progression: objectives, timer, campaign flags, unlocks
- audio: event/loop ID, bus, gain, spatial settings

Candidate system order:

1. sample and normalize input;
2. update snowball controller/camera intents;
3. step physics;
4. consume collision/intersection events;
5. validate collection threshold and ownership;
6. attach collected visuals and remove/disable their world physics;
7. update growth collider, score, objectives, audio, and feedback;
8. stream size-band/chunk entities;
9. synchronize physics/render instances;
10. persist only checkpoint-worthy state outside the frame loop.

For the first vertical slice, collected objects should become visual attachments and contribute to an aggregate sphere radius/mass; do not keep hundreds of independent rigid bodies attached to the ball. Later profiling can justify compound approximations.

### Performance baseline

- pool and instance repeated collectibles; use `InstancedRigidBodies` where physics instances are appropriate;
- favor atlas materials and shared geometries/materials;
- compress/optimize GLB with glTF Transform and Meshopt; use KTX2/Basis where the quality/size tradeoff wins;
- use LOD, distance/size-band streaming, frustum culling, and object budgets;
- never call React `setState` for high-frequency frame data; mutate refs/ECS/physics and publish low-frequency UI snapshots;
- avoid creating vectors, matrices, closures, materials, or geometries inside frame loops;
- use adaptive DPR/quality and explicit low/mobile presets;
- profile draw calls, triangles, physics bodies, heap, long tasks, input latency, and frame-time percentiles on representative phones before adding speculative workers;
- use the browser's worker-capable decoders where supported before considering a worker-hosted renderer.

### Mario-Kart-3.js lessons

The reference uses R3F, Drei, Rapier, Zustand, BVH, GLSL effects/particles, mobile joystick controls, and Vite PWA. Borrow its visible patterns—physics wrapping, controller/camera separation, particles, mobile UI, and PWA structure—but not its large-component coupling or older dependency pins. Its scanned source did not expose standards-based gamepad support, so Infinite Snowball needs its own Gamepad API adapter and tests.

## Input contract

Every device adapter writes the same normalized `InputFrame`:

- left/right stick vectors with deadzone and response curve;
- digital movement fallback;
- primary/secondary action, pause, confirm/back, camera reset;
- active source and device identity;
- monotonic timestamp and edge transitions.

Adapters:

- keyboard: configurable bindings, arrows/WASD, accessibility-safe focus handling;
- gamepad: `navigator.getGamepads()` sampled per animation frame, connect/disconnect handling, mapping profiles, deadzones, rumble only after capability checks;
- touch: responsive twin-stick or one-stick-plus-camera layout with 44–48px minimum targets and safe-area handling;
- optional Ecctrl bridge: convert the normalized frame to `EcctrlHandle.setMovement()` for character modes;
- snowball bridge: translate the normalized frame to torque, brake, turn, boost, and camera intents.

Do not make UI code read raw device APIs directly. Rebinding, pause menus, gameplay, and tests should all consume the normalized contract.

## GLB-first asset pipeline

Accepted runtime 3D content should be GLB/glTF. Do not require `gltfjsx` output for community packs: declarative packs need runtime-loadable assets, not arbitrary generated React modules. Use `gltfjsx` for curated core scenes/components and inspection when it produces a measurable maintenance or tree-shaking benefit.

Suggested authoring pipeline:

1. preserve the original source file and provenance outside the runtime bundle;
2. convert FBX/OBJ/Blend through a reproducible Blender headless script when necessary;
3. validate GLB structure, embedded/relative references, scale, axes, transforms, bounds, animations, and materials;
4. deduplicate/prune/weld/quantize/compress with glTF Transform/gltfpack as quality permits;
5. atlas compatible textures/materials, generate LODs deliberately, and transcode suitable textures to KTX2 plus a documented fallback;
6. calculate hashes, byte budgets, screenshots, and license records;
7. run a headless render/loader smoke test before publishing.

## Asset-source findings

### Recommended prototype sources

- **Quaternius:** all models are CC0 and may be used, modified, and combined without attribution in personal, educational, and commercial work. Many packs use atlas textures. Universal Base Characters advertises 26 models and FBX, OBJ, Blend, and glTF formats. <https://quaternius.com/faq.html> and <https://quaternius.com/packs/universalbasecharacters.html>
- **KayKit:** the Adventurers character pack license file is CC0 and permits personal, educational, and commercial use. <https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0>
- **Kenney:** Blocky Characters is explicitly CC0 and animated. <https://kenney.nl/assets/blocky-characters>
- **Dust3D:** MIT-licensed low-poly modeling software with built-in rigging, procedural animation, UV unwrapping, and GLB/FBX export. It is a modeler, not a wardrobe-style runtime character generator. <https://github.com/huxingyi/dust3d>
- **CharacterStudio:** MIT-licensed web avatar studio with GLB/VRM export, animation, skinned-mesh merging, and texture atlasing. Its visual/VRM assumptions need evaluation before adoption. <https://github.com/M3-org/CharacterStudio>
- **OS3A:** potentially useful as a GLB discovery source, but the inspected page appeared beta/incompletely rendered. Verify the original creator and license for every selected asset rather than treating the gallery as blanket provenance. <https://www.opensource3dassets.com/en/about>

No reliable open-source low-poly character generator named **Pelican** was found. The earlier recommendation appears to be a mistaken or conflated name and must not be placed in contributor docs as a verified tool.

Keep a machine-readable provenance record and human-readable third-party asset ledger even for CC0 assets. Attribution may be optional, but provenance is operationally necessary.

## Hosting and backend decision

### v1: no backend

Accounts, cloud saves, multiplayer state, and leaderboards are not needed to prove the game or package ecosystem. A static curated catalog plus browser-local saves eliminates cost, auth, abuse, and availability risk. Build export/import for saves and package locks first.

### Static hosting

Cloudflare Pages is the preferred primary target:

- free plan advertises unlimited sites, static requests, and bandwidth;
- 500 builds/month and 20,000 files/site on the inspected free plan;
- 25 MiB maximum per individual Pages asset, which reinforces package asset budgets and CDN-hosted content.

GitHub Pages is a useful fallback/mirror, but its published site limit is 1 GB and its documented bandwidth limit is a soft 100 GB/month. Keep deployment base paths configurable either way.

Mintlify's public pricing page advertises a no-card Starter path. Keep all docs source in-repo so hosting can change without losing documentation.

### Later backend

If cloud saves/accounts/leaderboards become justified, evaluate Cloudflare Workers + D1 first because it fits the deployment platform and current free allowance: 5 million rows read/day, 100,000 rows written/day, and 5 GB total storage. Do not add D1 or any database until a concrete online user story and abuse model exist. Neon/Turso remain alternatives if SQL portability or embedded sync becomes more important.

Sources: <https://developers.cloudflare.com/d1/platform/pricing/>, <https://pages.cloudflare.com/>, <https://developers.cloudflare.com/pages/platform/limits/>, and <https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits>.

## UI/UX baseline

The mandatory `ui-ux-pro-max` workflow was run before delegating UI work and persisted files at:

```text
design-system/infinite-snowball/MASTER.md
design-system/infinite-snowball/pages/landing.md
```

Useful output to preserve:

- vibrant, block-based, bold, energetic, playful visual language;
- large spacing rhythm, large expressive headings, 150–300ms feedback;
- Baloo 2 as a candidate display typeface;
- high-contrast blue/orange baseline;
- visible keyboard focus, reduced-motion support, semantic controls, 44–48px touch targets, and 375/768/1024/1440 responsive checks.

Generated suggestions that are **not** product requirements and should be rejected/refined:

- fake ratings/reviews, App Store/Play Store buttons, and device-store conversion patterns;
- CRT scanlines/cyberpunk retro-futurism, which conflicts with the organic snow/play-object identity;
- Comic Neue as an automatic body font without legibility/brand comparison;
- direct imitation of Katamari logo/UI trade dress.

The design worker should refine the persisted baseline into an original “playful winter toybox / rolling scrapbook” identity, then provide tokens and page overrides to every UI implementation worker. Primary calls to action should be `Play`, `Browse Packs`, and `Create a Pack`.

## Current dependency compatibility snapshot (2026-07-13)

Resolve exact pins through the lockfile during scaffolding. The current npm snapshot was:

- React / React DOM 19.2.7
- Three 0.185.1
- `@react-three/fiber` 9.6.1 (React 19, Three >=0.156)
- `@react-three/drei` 10.7.7
- `@react-three/rapier` 2.2.0 (R3F 9, React 19)
- Koota 0.6.6
- Ecctrl 2.0.0 (React >=19.2.7, Three >=0.184, R3F >=9.4, Drei >=10.7, Rapier >=2.2)
- Dexie 4.4.4 / `dexie-react-hooks` 4.4.0
- Vite 8.1.4 / `vite-plugin-pwa` 1.3.0 / Workbox 7.4.1
- Zod 4.4.3
- glTF Transform CLI 4.4.1 / gltfjsx 6.5.3
- Vitest 4.1.10 / Playwright 1.61.1
- TypeScript 7.0.2 / pnpm 11.13.0

Do not copy dependency versions from Mario-Kart-3.js; its role is architectural inspiration, not a current compatibility matrix.

## Primary technical sources

- R3F performance pitfalls: <https://r3f.docs.pmnd.rs/advanced/pitfalls>
- R3F scaling performance: <https://r3f.docs.pmnd.rs/advanced/scaling-performance>
- Three.js OffscreenCanvas manual: <https://threejs.org/manual/en/offscreencanvas.html>
- Koota: <https://github.com/pmndrs/koota>
- Ecctrl: <https://github.com/pmndrs/ecctrl>
- React Three Rapier: <https://pmndrs.github.io/react-three-rapier/>
- gltfjsx: <https://github.com/pmndrs/gltfjsx>
- Mario-Kart-3.js: <https://github.com/mustache-dev/Mario-Kart-3.js>
- MDN Cache Storage: <https://developer.mozilla.org/en-US/docs/Web/API/CacheStorage>
- MDN IndexedDB: <https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API>
- MDN persistent storage: <https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist>
- MDN storage quotas/eviction: <https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria>
- Workbox strategies: <https://developer.chrome.com/docs/workbox/modules/workbox-strategies>
- Vite PWA Workbox guide: <https://vite-pwa-org.netlify.app/workbox/>

## Planning gates the Ultra root must resolve

1. exact v1 vertical-slice acceptance test for movement, collection, growth, scoring, restart, and offline replay;
2. manifest JSON Schema and threat model before the browser installer;
3. package/CDN/catalog publication workflow and npm scope ownership;
4. game asset draw-call/body/triangle/byte budgets by device tier;
5. input mapping, deadzone, touch layout, and test matrix;
6. refined original visual identity and splash/landing/store page contracts;
7. license policy for catalog submissions and original music acquisition;
8. Cloudflare Pages versus initial GitHub Pages deployment credentials/automation;
9. when a database is actually justified and the migration boundary from local-only state;
10. phase ownership, dependencies, validation commands, handoffs, and stop conditions in `.maestro/playbooks/`.
