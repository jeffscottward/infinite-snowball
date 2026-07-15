# Infinite Snowball Phase 04 — Runtime, Input, Deterministic Simulation

Phase ID: P04
Status: Planned
Owner role: Runtime/Input/Simulation engineer
Depends on: P01, P02

## Goal and user value

Create source-verified runtime seams before a feature slice depends on them: pure Koota/gameplay/input packages, a sole `runtime-r3f` browser adapter boundary, deterministic fixed-step Rapier ownership, normalized keyboard/gamepad/touch input, custom snowball control, camera intents, and performance telemetry for P05.

## Prerequisites and dependencies

- P01 has created the pnpm workspace, package boundaries, TypeScript/Vitest/Playwright harness, CI check names, and root scripts.
- P02 has frozen the strict protocol/security contracts, including `InputFrame`, no arbitrary browser package execution, and the shared schema/type generation path.
- P03 may run in parallel after P02 because it owns starter assets and content; P04 must not edit P03 asset/provenance files.
- Use the settled architecture decisions: Koota owns gameplay facts and ordered systems/residency, Rapier owns dynamic physics, Three owns render resources, the render bridge alone writes dynamic Three transforms, the camera rig alone writes camera transforms from gameplay intents, and React owns low-frequency DOM state only.

## In scope

- `packages/engine/**`: Koota core world setup, tag/AoS traits, project-owned ordered systems, fixed-step clock, deterministic ID-sorted spatial residency, PRNG, and plain snapshot interfaces.
- `packages/input/**`: keyboard, standards-based Gamepad API, touch adapters, semantic UI actions, arbitration, edge/hysteresis derivation, release synthesis, and tests.
- `packages/gameplay/**`: pure snowball controller commands, growth/mass/collection reducers, camera intents, and tests; no React/R3F/Three/Ecctrl imports.
- `packages/runtime-r3f/**`: sole React/R3F/React Three Rapier/Three/Ecctrl adapter package, paused raw-world stepping/event copying, physics proxies, visible render interpolation, cleanup, and optional Ecctrl translation.
- `packages/performance/**` or `packages/engine/src/performance/**`: frame, physics, input-latency, heap, draw-call, and long-task telemetry helpers consumed by later phases.
- Runtime-facing test fixtures under `packages/*/test-fixtures/**` that do not include starter art or catalog content.

## Non-goals

- No playable route, 90-second arena, public splash/HUD/pause UI, landing page, docs, catalog/store implementation, package CLI, or asset conversion.
- No OffscreenCanvas renderer, worker renderer, backend, cloud save, leaderboard, multiplayer, or arbitrary content scripting.
- No Ecctrl ownership of the snowball and no React Three Rapier transform synchronization for visible meshes; Ecctrl is optional humanoid/on-foot/touch translation only, while separate visible objects are written solely by the project render bridge.
- No promise of bitwise-identical Rapier results across browsers; tests use documented pose tolerances.

## File and directory ownership boundaries

- Owns future files under `packages/engine/**`, `packages/input/**`, `packages/gameplay/**`, `packages/runtime-r3f/**`, and their colocated tests.
- May add shared runtime types only through P02-approved exports in `packages/protocol/**`; coordinate protocol changes rather than editing around the contract.
- Does not own content/catalog/CLI/content-runtime, app routes/UI, other phase playbooks, or `.omp-status.md`.
- P05 owns route composition and may depend on these packages only after P04 gates pass; it may not bypass the adapter boundary or import library internals.

## Stable inputs and contracts

- `InputFrame { version, tick, timestampMs, move:{x,y}, look:{x,y}, held, pressed, released, source:'keyboard'|'gamepad'|'touch', deviceId }` from P02. Semantic action maps include UI `up`, `down`, `left`, `right`, `pause`, `confirm`, and `back`; directional edges fire once per neutral-to-active transition, gamepad activation/release thresholds are `0.55`/`0.35`, and raw browser key repeat never creates edges.
- Tick order: normalized input dequeue -> snowball/controller and camera intents -> Rapier step -> sorted events -> eligibility/ownership/collection -> disable body and attach visual -> growth/mass/score/objectives/audio -> streaming commit -> physics/render snapshot -> low-frequency UI snapshot.
- Fixed 60 Hz simulation with seeded PRNG, stable IDs, sorted events, at most four catch-up ticks on visible frames, zero hidden-tab ticks, and deterministic ID-sorted spatial cells with three-or-more size bands, look-ahead, and load/unload hysteresis at tick boundaries.
- Growth formula: `newRadius = cbrt(oldRadius^3 + growthVolume)`. Between ticks, preserve the one authoritative collider handle, call `setRadius` and `setMass`, then `recomputeMassPropertiesFromColliders`; never recreate the body or let JSX prop changes own growth.
- Controller contract: pure commands drive a custom dynamic Rapier sphere using torque/impulses, braking, speed/slope/air limits, horizon-stable camera intents, reset/sensitivity/invert-Y, and reduced-motion-safe feedback.
- Worker policy: no OffscreenCanvas unless a later ADR has two traces showing at least 20% frame-budget recovery, transfer overhead under 25% of saved time, parity tests, and fallback.
- Koota 0.6.6 contract: `packages/engine` imports only `createQuery`, `createWorld`, `trait`, and public types from `koota`, never deep paths or `koota/react`. Project traits use only tags or AoS callbacks (`trait(() => value)`); a JS dynamic-code guard blocks `Function`, instantiates every trait, and forbids SoA object schemas, `eval`, and JS `unsafe-eval`. This is not the full browser CSP gate.
- Koota order/lifecycle contract: use a project-owned explicit readonly system array; sort every order-sensitive query snapshot by unique stable content ID; never rely on dense-set/entity-ID order or `queryFirst` without a uniqueness assertion. Persist stable IDs, never packed entity numbers. Register render cleanup with `world.onRemove`, destroy/reset in tested order, and rebootstrap singleton traits/subscriptions after reset.
- React Three Rapier 2.2.0 contract: only `runtime-r3f` imports installed public APIs. Under `<Physics paused interpolate={false}>`, obtain `{ rapier, world }` via `useRapier`, own exactly one `rapier.EventQueue`, and execute `world.timestep = 1/60; world.step(queue)` exactly once per admitted engine tick. Do not call the wrapper `step`, mix wrapper collision callbacks, deep-import Rapier, or add a direct `@dimforge/rapier3d-compat` dependency.
- Rapier CSP handoff: the pinned runtime calls `WebAssembly.instantiateStreaming`/`instantiate`; P04 must not claim it runs under a policy that blocks all WASM compilation. P05 owns a production-build browser smoke under `script-src 'self' 'wasm-unsafe-eval'` with no JS `'unsafe-eval'`, same-origin pinned engine WASM served as `application/wasm`, and community WASM still forbidden by P02. P10 verifies the target browser matrix and P11 verifies deployment policy delivery.
- Transform contract: physics-only proxy groups contain no visible render children. After sorted event/gameplay processing, copy scalar previous/current poses; a separate visible-object render bridge is the only Three transform writer and uses cached math objects. Tests count one raw world step and one visible-transform writer per tick.
- Ecctrl 2.0.0 contract: optional adapters use public `EcctrlHandle.setMovement(MovementInput)`, send every field including releases, disable toggle-run for held semantics, and treat Ecctrl's own `useFrame` consumption as nondeterministic integration—not the P04 clock or snowball controller.

## Outputs and handoffs

- Gate `VG-04-RUNTIME` for pure Koota/gameplay boundaries, no JS dynamic-code/`unsafe-eval`, stable query/system order and lifecycle, one paused raw Rapier step/event queue, physics-only proxies, plain snapshots, exactly one visible transform writer, custom controller/growth, residency, camera seams, and an explicit pinned-WASM CSP/MIME handoff to P05/P10/P11.
- Gate `VG-04-ECCTRL` for installed public `setMovement` translation with complete state/releases, cleanup, and proof that Ecctrl neither steps deterministic simulation nor owns the snowball.
- Gate `VG-04-INPUT-CONTRACT` for keyboard/gamepad/touch normalized movement plus `up/down/left/right/pause/confirm/back` parity, analog direction hysteresis, once-per-transition edges, release synthesis, direct touch activation, and arbitration.
- Gate `VG-04-PERFORMANCE` for telemetry hooks and initial budget checks used by P05 and P10.
- Handoff to P05/P08: documented public package exports, source-verified adapter constraints, fixture seeds, controller defaults, normalized UI actions, deterministic edge/hysteresis rules, lifecycle/cleanup requirements, and telemetry helpers.

## Ordered checklist

1. [ ] IS-04-001 — Add failing input fixture tests for keyboard diagonals, ignored key repeat, gamepad radial movement deadzone 0.20 with rescaling, UI D-pad/left-stick direction activation `0.55` and release `0.35`, one directional edge per neutral transition, touch direct focus/activation and pointer capture/cancel, edge derivation once per tick, blur/disconnect releases, four-input UI action parity, and two-second last-meaningful-gameplay-source arbitration without UI focus stealing source ownership.
2. [ ] IS-04-002 — Add failing deterministic-clock/residency/Koota tests for 60 Hz, four catch-up ticks, hidden/blurred zero ticks, clamp telemetry, seeded replay, explicit system order, unique stable-ID sorting under swap-filled entity removal, forbidden implicit/queryFirst order, reset rebootstrap, terminal destroy cleanup, size bands, and hysteresis.
3. [ ] IS-04-003 — Add failing Rapier/bridge tolerance fixtures for exactly one raw `world.step` and one event queue per admitted tick, no wrapper step/callback path, physics-only proxies with no visible children, one visible-transform writer, pose snapshots, sorted copied collisions, in-place collider/mass growth, and collected-body removal by the next tick.
4. [ ] IS-04-004 — Add failing performance telemetry tests for frame p95, physics p95, draw calls, visible triangles, active bodies, heap, long tasks, and input-to-simulation latency without React state churn.
5. [ ] IS-04-005 — Implement pure `packages/engine` contracts using only Koota core public imports: fixed-step accumulator, explicit readonly scheduler, stable-ID sorted queries/events, seeded PRNG, deterministic residency, plain snapshot buffers, and tested reset/destroy/subscription cleanup.
6. [ ] IS-04-006 — Implement only Koota tag/AoS-callback traits for player, collectible, level entity, pack owner, snowball facts, requirements, stable physics/render handle keys, attachments, objectives, residency, and low-frequency UI snapshots; never persist packed entities or mutate AoS state invisibly; pass the blocked-`Function` JS dynamic-code guard with no SoA/`koota/react`, without mislabeling it as the full Rapier CSP test.
7. [ ] IS-04-007 — Implement `packages/runtime-r3f` with `<Physics paused interpolate={false}>`, one raw world/event-queue fixed-step bridge, physics-only proxies, scalar snapshot copying after sorted gameplay, separate cached-object render interpolation, and lifecycle cleanup; no visible wrapper children or second transform writer.
8. [ ] IS-04-008 — Implement pure custom snowball controller commands with torque/impulse, braking, speed/slope/air limits, camera intent output, and deterministic reducer seams.
9. [ ] IS-04-009 — Implement collection eligibility/ownership, body disablement, local-pose attachment facts, growth volume, in-place collider `setRadius`/`setMass` plus mass-property recomputation, score/objective events, and audio hooks.
10. [ ] IS-04-010 — Implement input adapters for keyboard, standards-based Gamepad API, and touch that all emit only `InputFrame`; include normalized UI directions/actions, `0.55`/`0.35` analog hysteresis, once-per-transition edges, blur, disconnect, pointercancel, pause, and visibility release synthesis.
11. [ ] IS-04-011 — Implement UI-safe input exports so menus/gameplay consume the same normalized `up/down/left/right/pause/confirm/back` action maps, deterministic focus navigation never depends on browser key-repeat timing, UI navigation does not steal gameplay source arbitration, and no UI module reads raw browser device APIs.
12. [ ] IS-04-012 — Implement optional Ecctrl translation only in `runtime-r3f` through public `EcctrlHandle.setMovement`; send a complete `MovementInput` including releases, use held run without toggle behavior, test cleanup/sticky-state prevention, and prove Ecctrl cannot step the project clock or own the snowball.
13. [ ] IS-04-013 — Implement horizon-stable camera intent calculations with collision awareness hooks, reset, sensitivity, invert-Y, auto-recenter option, and reduced-motion suppression of shake/FOV pulses.
14. [ ] IS-04-014 — Implement performance telemetry helpers with low/mobile, mid, and high tier thresholds from the brief and export trace labels for P05/P10 evidence.
15. [ ] IS-04-015 — Document exact installed Koota/R3F/React Three Rapier/Three/Ecctrl public imports, ownership, lifecycle, and unsupported paths in package API handoffs; do not deep-link transient internals or create marketing docs.
16. [ ] IS-04-016 — Record gate evidence paths for `VG-04-RUNTIME`, `VG-04-ECCTRL`, `VG-04-INPUT-CONTRACT`, and `VG-04-PERFORMANCE` for P05 handoff.

## Test-first acceptance criteria

- `VG-04-RUNTIME`: tests fail first and pass for Koota core-only tag/AoS use with `Function` blocked, no JS `eval`/`unsafe-eval`, explicit stable-ID system/query order, reset/destroy cleanup, one paused raw Rapier step/event queue per admitted tick, physics-only proxies, one visible-transform writer, plain snapshots, controller/growth, residency, camera intent, and explicit production Rapier CSP/MIME handoff.
- `VG-04-ECCTRL`: installed-API tests prove optional Ecctrl receives complete state/releases through `setMovement`, cleans up without sticky input, remains outside deterministic stepping, and cannot own snowball physics.
- `VG-04-INPUT-CONTRACT`: one fixture matrix drives keyboard, gamepad, pointer/touch into identical `InputFrame` semantics for movement, look, UI directions, edges, pause/confirm/back, direct DOM activation, disconnect/cancel, analog hysteresis, and arbitration without focus navigation stealing gameplay ownership.
- `VG-04-PERFORMANCE`: telemetry records the initial tier budgets and exposes evidence fields without high-frequency React state updates or avoidable frame-loop allocations.

## Smallest meaningful verification

- `pnpm --filter @infinite-snowball/input test -- input-contract` -> passes keyboard/gamepad/touch normalization, `up/down/left/right/pause/confirm/back` parity, direction hysteresis/edges, release synthesis, and gameplay-source arbitration.
- `pnpm --filter @infinite-snowball/engine test -- deterministic-clock system-order residency koota-no-dynamic-js koota-lifecycle` -> passes fixed stepping, stable-ID order under removal, reset/destroy cleanup, residency, and every tag/AoS trait under blocked `Function`; this proves only the JS dynamic-code boundary.
- `pnpm --filter @infinite-snowball/runtime-r3f test -- rapier-step transform-writer collider-growth ecctrl-boundary cleanup` -> passes one raw step/event queue, no wrapper transform sync, physics-only proxies, one visible writer, in-place growth/mass recomputation, complete Ecctrl state/releases, and cleanup.
- `pnpm --filter @infinite-snowball/engine test -- performance-telemetry` -> passes telemetry field capture and budget-label tests without asserting unprofiled optimization claims.
- Manual scenario: run the P05 dev route once it exists, collect three objects with keyboard, then repeat with a standard gamepad and touch emulator; expected result is matching tick-level `InputFrame` events and no raw input reads outside `packages/input`.

## Quality gates

| Gate area | Required evidence |
| --- | --- |
| Performance | `VG-04-PERFORMANCE` captures low/mobile, mid, and high tier thresholds; frame-loop code allocates no avoidable vectors/matrices/materials/closures; physics p95 and input latency fields are observable for P05. |
| Accessibility | `VG-04-INPUT-CONTRACT` includes keyboard access, normalized `up/down/left/right/pause/confirm/back`, gamepad analog hysteresis, safe release on blur/disconnect, source arbitration that ignores focus-only navigation, touch direct activation, reduced-motion camera feedback suppression, and 48px coarse-pointer gameplay-control contract for P05/P08. |
| Security | Engine uses Koota core tag/AoS traits under blocked `Function`; no `koota/react`, SoA generated accessors, JS `eval`/`unsafe-eval`, deep library imports, untrusted dynamic imports, Node/npm/archive browser logic, executable community content, community WASM, or persisted packed entity IDs. The required pinned Rapier WASM allowance is narrow, same-origin, MIME-checked, and browser-tested by P05/P10/P11. |
| Licensing | No assets, music, third-party content, or catalog packages are introduced in P04; any Ecctrl/Rapier/Koota dependency use remains within P01 lock/license policy. |
| Offline/recovery | Hidden-tab, pause, blur, and visibility transitions produce zero simulation ticks and synthetic releases; deterministic replay fixtures survive closed/reopened PWA scenarios handed to P05. |

## Completion and stop condition

P04 is complete only when all four P04 verification gates pass, evidence paths are recorded, and P05 can import the runtime/input/gameplay APIs without owning their internals. Completion cannot be claimed from package scaffolding alone, from visual smoke only, or before the normalized input and performance telemetry gates pass. P04 may finish independently of P03 but must preserve the P03/P04 parallel boundary.

## Rollback and recovery notes

P04 is code/test work with no persistent user data. Revert `packages/engine`, `packages/input`, `packages/gameplay`, `packages/runtime-r3f`, and telemetry exports introduced here, then restore only approved P02 type additions. If a public API already reached P05, block P05 until callers migrate; never leave duplicate clocks/event queues/transform writers, compatibility shims, or controller paths.
