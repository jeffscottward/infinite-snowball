# Phase 04 runtime API handoff

This is the implementation contract handed from P04 to P05 and P08. It records the reviewed runtime surface; it is not a promise that internal source paths remain stable.

## Installed versions

The verified workspace installation uses these exact versions:

- `koota@0.6.6`
- `@react-three/fiber@9.6.1`
- `@react-three/drei@10.7.7`
- `@react-three/rapier@2.2.0`
- `three@0.185.1`
- `ecctrl@2.0.0`
- `react@19.2.7`
- `@types/three@0.183.1` for development declarations only

Changing a pin requires the normal dependency audit, deterministic runtime tests, and production-build smoke gates. Do not infer compatibility from a semver range.

## Public imports

Consumers import only package roots:

```ts
import { createGameWorld, createPerformanceTelemetry } from "@infinite-snowball/engine";
import { createInputManager, createUiFocusNavigator } from "@infinite-snowball/input";
import { collectObjects, computeSnowballCommand } from "@infinite-snowball/gameplay";
import { ManualPhysics, PhysicsOnlyProxy } from "@infinite-snowball/runtime-r3f";
```

The 3D import boundary is capability-based, not a sole-package rule. P05 application presentation may import the public roots of `@react-three/fiber`, `@react-three/drei`, and `three` to create the web `Canvas`, visible scene, and GLB presentation. Only `@infinite-snowball/runtime-r3f` may import or use `@react-three/rapier` or `ecctrl`, retain Rapier handles, perform manual physics stepping, or own physics lifecycle. `runtime-r3f` may use public R3F/Three presentation types internally and must keep its stable physics bridge at its package root.

No supported consumer may deep-link into another package's `/src`, `/dist` children, generated declarations, package-manager store paths, Rapier internals, R3F internals, or transient Koota internals.

## Ownership

- `@infinite-snowball/engine` owns the Koota world, initialized traits, stable-ID handle registry, deterministic scheduler, fixed-step clock, seeded random source, residency, plain snapshots, and performance telemetry. It remains data-only apart from Koota core.
- `@infinite-snowball/input` owns keyboard/gamepad/touch normalization, action mapping, source arbitration, transition edges, release synthesis, UI-safe action projection, normalized `InputFrame` generation, authored focus-graph navigation, and the normalized pointer-ownership ledger. Its manager issues abstract listen/capture/release requests through an injected plain adapter; on a forwarded pointer release or cancel, it removes manager ownership before issuing the abstract release request. It never installs native DOM `PointerEvent` listeners, calls `setPointerCapture` or `releasePointerCapture`, polls devices, or reads ambient `window`, `document`, `navigator`, or `navigator.getGamepads`; it has no gameplay or DOM-focus authority.
- `@infinite-snowball/gameplay` owns the custom snowball command reducer, camera intent, growth, collection eligibility, score/objective events, and optional pure audio-cue hook. Gameplay consumes normalized frames only.
- `@infinite-snowball/runtime-r3f` is the sole owner of `@react-three/rapier` and Ecctrl integration, the paused non-interpolating physics provider, direct raw `world.step`, Rapier handles, collision queue drain, one hidden physics-only proxy per body, the one cached visible-transform writer, and physics-owned lifecycle.
- P05 application presentation owns creation of the R3F `Canvas`, visible scene, and GLB presentation through public `@react-three/fiber`, `@react-three/drei`, and `three` APIs. It consumes immutable snapshots and may bind visible objects to the runtime writer, but it cannot import Rapier or Ecctrl, step physics, retain physics handles, own physics lifecycle, or copy authoritative state back into Koota.
- P05 also owns the thin real-browser keyboard/gamepad/pointer bindings. Its adapter adds/removes native DOM `PointerEvent` and keyboard/device-lifecycle listeners, polls `navigator.getGamepads()`, forwards plain samples and release/cancel signals into `@infinite-snowball/input`, and fulfills the manager's abstract listen/capture/release requests. Each capture or release request produces exactly one native `setPointerCapture` or `releasePointerCapture` side effect. The adapter performs no normalization, action mapping, arbitration, pointer-ledger decision, or frame generation. Gameplay and UI consume normalized frames only.
- Ecctrl is an optional translator implemented only inside `runtime-r3f` through its public `setMovement` API. It never owns the rigid body, deterministic tick, collision drain, growth, or camera state.

## Lifecycle

Every stateful runtime resource follows `create -> reset as needed -> destroy once`. Reset clears ticks, queues, subscriptions, cached transforms, source state, and transient handles while preserving the declared configuration. Destroy is idempotent, releases callbacks/subscriptions/maps, and makes later mutation or snapshot calls fail closed.

App teardown order is: stop P05 browser-adapter publication; forward release/cancel for active pointers so the input manager removes ledger ownership before issuing each abstract release request; execute every requested native `releasePointerCapture` exactly once; detach native listeners and pollers; stop the fixed-step loop; drain no further physics events; unbind visible/proxy objects; destroy retirement queues, writer, raw stepper, event buffer, telemetry, input, and camera resources; then destroy the game world and paused physics provider. P05 likewise forwards page hide, blur, device disconnect, and pointer cancellation as plain lifecycle signals so `@infinite-snowball/input` synthesizes releases before normal processing resumes.

## Unsupported paths

- No `useFrame` loop, autonomous `<Physics>` stepping, wrapper `world.step`, second collision queue, or second visible transform writer.
- No dynamic `Function`, `eval`, untrusted dynamic import, browser npm/tarball execution, packed entity objects, or function-valued Koota traits.
- No React state updates for per-tick physics/render data and no per-body React state bridge.
- No live Rapier joints or retained rigid bodies for collected visuals; collection disables the body by the next tick and later retires it in stable-ID order.
- No Ecctrl character body, Ecctrl camera loop, or undocumented/deep-linked Ecctrl API.
- No `@react-three/rapier` or Ecctrl import/use, manual physics step, Rapier handle, or physics-owned lifecycle outside `runtime-r3f`; it does not own the P05 `Canvas` or visible GLB scene composition.
- No ambient browser-global/device reads inside `packages/input`, and no raw DOM/device objects consumed by gameplay or UI; those consumers receive normalized frames only.
- No community JS, WASM, HTML, or CSS execution path.

## P05 production CSP/MIME handoff to P10/P11, preserved by P08

P05 owns the first production artifact smoke. Its embedded GitHub-Pages-compatible meta policy must include `default-src 'self'` and `script-src 'self' 'wasm-unsafe-eval'`, with no JS `'unsafe-eval'`, no inline script allowance, `object-src 'none'`, `base-uri 'self'`, and `form-action 'self'`.

The pinned `@react-three/rapier@2.2.0` runtime resolves `@dimforge/rapier3d-compat@0.19.2`. Its compat entry decodes base64-inlined WASM bytes and passes them to `WebAssembly.instantiate`; it does not fetch a standalone `.wasm`, so there is no Rapier WASM response or `application/wasm` MIME assertion. The P05 smoke records the decoded embedded-byte SHA-256 and the containing JS chunk/artifact hashes, proves a real physics step under the policy, inventories the build for zero emitted `.wasm` files, and observes zero runtime `.wasm` requests; community WASM remains forbidden by the protocol boundary.

Curated declarative assets retain their validated MIME types: GLB as `model/gltf-binary`; JSON as `application/json`; Ogg and WAV as `audio/ogg` and `audio/wav`; AVIF, JPEG, PNG, and WebP as their matching image types. MIME fallback to executable or octet-stream content is unsupported.

P08 may integrate the same public UI/runtime surfaces into the product shell, store, and offline UI, but it preserves the P05 presentation-versus-physics and browser-binding-versus-input-normalization boundaries and consumes normalized frames only. It must not weaken ownership, CSP, MIME, no-code, or immutable-content boundaries. P10 owns cross-device verification of those frozen boundaries and the trace matrix; P11 owns live-host policy delivery, inherited-boundary audit, and no-standalone-WASM verification.
