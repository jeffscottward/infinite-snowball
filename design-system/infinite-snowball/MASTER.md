# Infinite Snowball Design System

> Source of truth for product presentation. Page overrides belong in
> `design-system/infinite-snowball/pages/<page>.md` and may refine, but never weaken,
> the accessibility, licensing, offline, or input requirements in this file.

## Product identity

Infinite Snowball is a web-native rolling-and-collecting game and creator ecosystem.
Its interface should feel like a handmade winter toybox: playful, tactile, surprising,
and trustworthy. It may acknowledge the joy of the rolling-collection genre, but it
must not copy Katamari names, logo treatment, story, music, characters, interface,
trade dress, or visual assets.

### Visual language

- Snow-paper fields provide quiet breathing room around the 3D world.
- Cut-paper labels create hierarchy with controlled, slightly irregular silhouettes.
- Toy-block controls communicate pressability without glossy skeuomorphism.
- Hand-drawn route lines connect steps, packs, and campaign progress.
- Collectible stickers provide concentrated color and personality.
- Shadows remain short, tinted, and restrained; depth must never become generic card chrome.
- Asymmetry is intentional, but spacing, alignment, focus order, and hit areas stay rigorous.

## Foundation tokens

### Color

| Role | Value | Token | Use |
|---|---:|---|---|
| Snow | `#F8FAFC` | `--color-snow` | Primary field and light text on dark status colors |
| Paper | `#FFF8E7` | `--color-paper` | Warm cut-paper surfaces and labels |
| Ink | `#1E293B` | `--color-ink` | Body text, outlines, and text on orange/yellow |
| Muted ink | `#475569` | `--color-ink-muted` | Secondary text on snow only |
| Action | `#2563EB` | `--color-action` | Primary actions, links, active controls |
| Action strong | `#1D4ED8` | `--color-action-strong` | Hover/pressed action state |
| Accent | `#F97316` | `--color-accent` | Playful emphasis and featured sticker fields |
| Raspberry | `#BE185D` | `--color-collectible-raspberry` | Collectible/category accent |
| Pine | `#0F766E` | `--color-collectible-pine` | Collectible/category accent |
| Grape | `#7C3AED` | `--color-collectible-grape` | Collectible/category accent |
| Sun | `#FACC15` | `--color-collectible-sun` | Warning or collectible accent with ink text |
| Success | `#15803D` | `--color-success` | Verified/installed state with snow text |
| Danger | `#B91C1C` | `--color-danger` | Fatal/integrity state with snow text |
| Outline | `#CBD5E1` | `--color-outline` | Dividers and inactive boundaries |
| Focus light | `#F8FAFC` | `--color-focus-light` | Inner focus halo over dark or scene content |
| Focus dark | `#1E293B` | `--color-focus-dark` | Outer focus halo over light or scene content |

Rules:

- Use snow text on action, success, danger, raspberry, pine, and grape.
- Use ink text on snow, paper, accent orange, and sun.
- Never communicate state through color alone; pair it with text and a consistent vector symbol.
- Use saturated collectible colors in small, meaningful areas rather than evenly across the page.
- Avoid purple-to-blue gradients, neon-on-black, decorative glows, and pure black or white.

### Typography

- Display: **Baloo 2**, weights 600 and 700, for the logo, short headings, scores, and playful labels.
- Body/interface: **Atkinson Hyperlegible**, weights 400 and 700, for controls, descriptions, status, and documentation links.
- Bundle both families locally through package assets or self-hosted font files; do not depend on a runtime Google Fonts request.
- Keep body text at least `1rem`; never use display type for dense instructions or error recovery.
- Use fluid display sizes with `clamp()` and stable numeric widths with `font-variant-numeric: tabular-nums`.

| Token | Value |
|---|---|
| `--font-display` | `"Baloo 2", ui-rounded, sans-serif` |
| `--font-body` | `"Atkinson Hyperlegible", system-ui, sans-serif` |
| `--text-xs` | `0.75rem` |
| `--text-sm` | `0.875rem` |
| `--text-md` | `1rem` |
| `--text-lg` | `1.25rem` |
| `--text-xl` | `clamp(1.5rem, 2vw, 2rem)` |
| `--text-display` | `clamp(2.75rem, 8vw, 6.5rem)` |

`--text-xs` is reserved for non-essential badge metadata and `--text-sm` for short
supporting labels; neither may carry instructions, status, error, recovery, or primary
control copy. Body and actionable copy stay at `--text-md` or larger.

### Space, shape, and depth

- Use a 4/8 px rhythm: `4, 8, 12, 16, 24, 32, 48, 64`.
- Product radii are `8px`, `12px`, and `16px`. Pills are reserved for compact status and tags.
- Interactive targets are at least `44px` by `44px`; gameplay touch controls may be larger.
- Use `2px` boundaries for actionable toy blocks. Focus uses a dual-contrast halo:
  `0 0 0 2px var(--color-focus-light), 0 0 0 5px var(--color-focus-dark)`.
- Preferred shadows:
  - `--shadow-paper: 0 2px 0 rgb(30 41 59 / 0.14)`
  - `--shadow-raised: 0 6px 16px rgb(30 41 59 / 0.14)`
  - `--shadow-dialog: 0 12px 32px rgb(30 41 59 / 0.20)`
- Do not wrap every section in a card or nest paper panels inside paper panels.

### Motion

| Tier | Duration | Purpose |
|---|---:|---|
| Immediate | `150ms` | Press, hover, focus acknowledgement |
| Interface | `220ms` | Menu, disclosure, and status transition |
| Scene | `300ms` | Splash or route-level presentation |

- Animate opacity and transform, not layout dimensions.
- Prefer `cubic-bezier(0.16, 1, 0.3, 1)` for entrances and direct ease-in for exits.
- Never use bounce/elastic easing or flashing effects.
- Under `prefers-reduced-motion: reduce`, remove decorative travel, parallax, rotation, and stagger; preserve instantaneous state feedback.

## Component contracts

### Toy-block button

- Always use a semantic `button` or link with an accurate accessible name.
- Primary buttons use action blue with snow text; featured orange buttons use ink text.
- Use a two-pixel ink-tinted boundary and short paper shadow.
- Hover may translate visually by at most `-1px`; pressed returns to the baseline. Transforms must not move surrounding layout.
- Disabled and busy use native `disabled`/`aria-disabled`/`aria-busy` semantics as appropriate. Ready, offline, and error are application states and require visible state text plus a typed view model; never describe them as native button states.
- Show the dual-contrast focus halo with at least two-pixel separation from the component edge. UI floating over the 3D scene also receives an opaque snow/paper focus backplate; never remove focus without a replacement.

### Cut-paper label

- Use for short headings, map steps, and contextual status—not body paragraphs.
- The silhouette may be slightly irregular through a CSS clip path, pseudo-element, or approved SVG mask.
- Keep the text baseline and focus geometry rectangular and predictable.
- Under `forced-colors: active`, remove clip paths, preserve text, use system colors, and expose a rectangular one-pixel system boundary.

### Paper panel

- Use only when grouping changes understanding: pause, settings, install details, or recovery.
- Prefer snow/paper contrast, a subtle outline, and one restrained shadow.
- Avoid generic equal-height card grids. Vary composition while preserving reading order.

### Collectible sticker

- Represents real content, category, achievement, or state; never purely decorative dashboard noise.
- Use a consistent original vector/illustration system with an accessible text equivalent.
- Rotation is decorative and capped at three degrees. Remove rotation under reduced motion; under forced colors, remove decorative fills/rotation and preserve a system-color outline plus text equivalent.

### Status message

- Include a stable status label, plain-language explanation, and concrete next action.
- Use `role="status"` for non-urgent updates and `role="alert"` only for immediate blocking failures.
- Distinguish cached, refreshing, offline-with-timestamp, unavailable, downloading, verifying, installed, update, canceled, failed, quota, and integrity states in words.

### Typed UI commands and transitions

Presentation components receive immutable view models and narrow P08-owned adapter
interfaces over documented P05/P07 public methods; they never call raw runtime,
installer, storage, service-worker, file, or device APIs. Required adapters are:

- `BootUiController`: `retryBoot()` and `startGame()`.
- `PauseUiController`: `pause(reason)`, `resume()`, `openControls()`,
  `openSettings()`, `requestRestart()`, `confirmRestart()`, `cancelRestart()`,
  and `quitToLanding()`.
- `ResultUiController`: `restartSameSeed()` and `quitToLanding()`.
- `StoreUiController`: `refreshCatalog()`, `install(packageRef)`,
  `update(packageRef)`, `cancel(transactionId)`, and `retry(transactionId)`.
- `SaveDataUiController`: `beginExport()`, `chooseImport(file)`,
  `confirmImport()`, `cancelImport()`, and `retryRollback()`.
- `PwaUiController`: `requestInstall()`, `dismissInstall()`, `applyUpdate()`,
  `deferUpdate()`, and `retryUpdate()`.

Each adapter implements `getSnapshot(): Readonly<ViewModel>` and
`subscribe(listener): () => void` for `useSyncExternalStore`. Repeated reads return the
same object reference until a committed state version; each commit creates one new
immutable snapshot and emits exactly one notification. Snapshots carry the monotonic
version, current busy command, and stable errors. Async commands return a typed
committed version or stable failure; duplicates reject as busy without side effects.
Components never infer success from click completion or navigate before required
cleanup succeeds.

Cancel retains the previous known-good state; destructive import always pauses at
`import-confirmation-required` until explicitly confirmed.

Required transition vocabulary:

- Boot: `booting -> ready | offline-ready | fatal`; Retry returns to `booting`.
- Pause/gameplay: `running -> paused`; Resume returns to `running`; Restart pauses at
  `restart-confirmation-required` before the P05 same-seed restart; Quit invokes the
  P05 run cleanup/save-preservation command before landing. Controls and Settings keep
  simulation paused and return focus to the invoking Pause action.
- Store: `idle/cached -> refreshing`; install/update progress through
  `downloading -> verifying -> installed`; cancel returns `canceled`; failure exposes a
  stable code and permitted retry/recovery command.
- Save Data: `export-ready -> exporting -> export-success | export-error`;
  `import-pending -> import-confirmation-required -> importing -> import-success |
  corrupt-import-error | oversize-import-error | incompatible-import-error |
  rollback-running -> rollback-complete | rollback-failed | rollback-canceled`.
- PWA: `eligible -> prompting -> accepted | dismissed`; also represent
  `already-installed`, `unsupported`, `applying`, `deferred`, and `failed`.

Announce each meaningful state transition once. Progress updates use a polite live
region with deduplication; blocking integrity, rollback, and fatal boot failures use an
assertive alert and move focus only to the owning dialog heading or recovery action.

## Product surfaces

### Splash and Press Start

- The logo treatment must be original and readable against the 3D scene.
- Press Start is a real button, disabled until boot readiness is known.
- Support Enter, Space, gamepad Confirm, pointer, and touch through shared input contracts.
- State booting, ready, offline-ready, and fatal error explicitly; fatal errors offer Retry.
- Audio unlock occurs only inside the activating user gesture.

### Gameplay HUD and pause

- Let the 3D scene dominate; place only objective, size, score, timer, active-input prompt, and essential offline status in the HUD.
- HUD consumes throttled snapshots and never updates React state from the render frame loop.
- Keep changing numeric labels fixed-width/tabular so the layout does not jump.
- Pause must stop simulation through the gameplay contract, trap focus, and restore focus after close.
- Account for safe areas and 375 px landscape without covering critical play space.

### Win and time-out result

- Both outcomes render a named result dialog with final objective, score, size, and plain-language status.
- On open, announce the outcome once and focus the result heading; then expose **Restart Same Seed** and **Quit to Landing**. A future Next Level action stays absent until an authoritative campaign command exists.
- Restart invokes the P05 restart contract without changing level version or seed. Quit navigates to `/` only after pause/cleanup authority confirms the run is closed.
- Keyboard, gamepad, pointer, and touch can reach and activate every result action; Back does not silently dismiss a completed run.

### Store and Save Data

- Present package provenance, integrity, offline availability, storage impact, and recovery clearly.
- Do not use fake ratings, reviews, scarcity, store badges, or misleading installation promises.
- Export/import copy says local-only and does not imply browser storage is permanent.
- UI consumes typed view models only; it never reads npm archives, Cache Storage, IndexedDB/Dexie, raw SaveExport data, or device APIs directly.

- Store, Save Data, PWA, and boot surfaces may invoke only the typed commands above. Confirmation, cancel, retry, rollback, and announcement behavior must be covered as state transitions, not ad-hoc callbacks.

### Landing

- Required primary paths: **Play**, **Browse Packs**, and **Create a Pack**.
- Explain the mechanic with real captures when available; labeled capture slots remain visibly truthful until then.
- Cover curated packs, offline/save portability, creator path, controls/accessibility, contribution/docs, and footer without an app-store clone layout.
- Use an asymmetric paper route through the page instead of a repeated icon-card grid.

Exact route map and CTA hierarchy:

| Path | Surface | Entry behavior |
|---|---|---|
| `/` | Landing | Default document route and **Quit to Landing** destination |
| `/start` | Splash/Press Start | **Play** destination; Press Start advances to `/play` |
| `/play` | Existing P05 gameplay route | Preserved byte-for-behavior; direct deep links remain valid |
| `/packs` | Cached pack store | **Browse Packs** destination |
| `/settings` | Settings and Save Data | May be deep-linked; unavailable commands retain explanatory state |
| `/create` | Creator gateway | **Create a Pack** destination; links onward to the P09 authoring docs |

Known routes are app-shell navigations and must resolve from a closed/reopened installed
PWA. If a deep-linked surface lacks required cached data, keep the route and render its
typed offline/unavailable state rather than redirecting. Unknown routes render an
offline-safe Not Found surface with a link to `/`; they never silently enter gameplay.

## Responsive and accessibility gates

- Validate at 375, 768, 1024, and 1440 px, plus 375 px landscape gameplay.
- Adapt hierarchy and controls; do not hide critical actions on small screens.
- Meet WCAG 2.2 AA, including text/non-text contrast, logical focus order, named controls, state semantics, and no-color-only communication.
- All interactive targets are at least 44 px; coarse-pointer gameplay targets should be at least 48 px.
- Support keyboard-only, standards-based gamepad, pointer, touch, screen reader, zoom, and reduced motion.
- Avoid horizontal overflow, hidden fixed-header content, focus clipping, and UI beneath notches/home indicators.

- Validate reflow at 320 CSS px and 400% zoom, text resizing to 200%, WCAG text-spacing overrides, screen-reader traversal and live announcements, and `forced-colors: active`.
- The shared normalized UI action set is `up`, `down`, `left`, `right`, `confirm`, `back`, and `pause`. Gamepad input maps those actions to deterministic DOM focus navigation; keyboard uses equivalent keys; pointer/touch directly focus and activate the same semantic controls. No presentation module samples a device API.
- Every splash, pause, result, store, settings, Save Data, PWA, landing, and creator-gateway scenario has a four-input parity check or a written exception where an operating-system dialog is not programmatically controllable.

## Anti-patterns

- No direct Katamari logo, characters, story, soundtrack, UI, vocabulary, asset, or trade-dress imitation.
- No CRT, cyberpunk, synthwave, pharmacy, community-forum, or generic app-store visual template.
- No Comic Neue, Space Grotesk-only system, runtime Google Font dependency, or unreadable novelty body font.
- No purple/pink AI gradients, gradient display text, neon glow, glassmorphism layer stacks, or fake 3D chrome.
- No emoji as structural icons; use one cleared vector icon family plus original collectible art.
- No autoplay high-resolution video loops, layout-shifting hover effects, inaccessible canvas-only actions, or pointer-only controls.
- No fake ratings, reviews, user counts, app-store badges, or placeholder content represented as shipped truth.
- No raw package/runtime/storage/input API access from presentation components.

## Pre-delivery checklist

- [ ] Baloo 2 and Atkinson Hyperlegible are bundled locally and used by role.
- [ ] Snow/paper/ink/action/accent tokens drive every surface; no ad-hoc palette competes with them.
- [ ] Press Start and the Play, Browse Packs, and Create a Pack paths are semantic and correctly ranked.
- [ ] All target states have visible text, accessible semantics, and recovery copy.
- [ ] Keyboard, gamepad, pointer, and touch actions are equivalent.
- [ ] Dual-contrast focus, text/non-text contrast, 44 px general targets, 48 px coarse-pointer gameplay targets, safe areas, and screen-reader order pass.
- [ ] Reflow at 320 CSS px/400% zoom, 200% text, text-spacing overrides, and forced-colors pass without lost content or action.
- [ ] Reduced-motion behavior removes decorative motion without hiding state changes; no interface flashes.
- [ ] 375, 768, 1024, 1440, 375 landscape, and 320 reflow layouts have no critical overlap or overflow.
- [ ] UI performs no frame-loop state churn and imports no raw package, storage, service-worker, or input APIs.
- [ ] Root/default routes, all CTA destinations, direct deep links, offline fallback, result actions, and preservation of `/play` match the route contract.
- [ ] Typed boot/store/save/PWA controllers cover confirmation, cancel, retry, rollback, and announcement transitions without raw API access.
- [ ] Every visual asset and capture is original or license-cleared, and every claim is truthful.
