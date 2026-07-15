# Infinite Snowball Phase 09 — Mintlify Docs, Community, Release Collateral

Phase ID: P09
Status: Planned
Owner role: Documentation, community, and release-collateral lead
Depends on: P06, P07, P08

## Goal and user value

Create trustworthy public-facing documentation and release collateral for players, creators, contributors, and maintainers. Users can understand how to play, install as a PWA, recover offline saves, create content packs, submit catalog PRs, and contribute without encountering fake claims, missing prerequisites, unclear recovery steps, or unverified screenshots.

## Prerequisites and dependencies

- P06 must provide the stable CLI contract for `init`, `validate --strict --json`, `convert`, `build`, `preview`, `pack`, authoring `install`, `catalog verify`, `submit`, and `publish --dry-run`, plus templates/examples and submission fixtures.
- P07 must provide store/install state names, offline behavior, package-lock/export/import guidance, quota/recovery language, stable rejection IDs, appeal/dispute states, and security boundaries for curated content.
- P08 must provide approved product copy, IA, CTAs, UI states, screenshot routes, responsive expectations, and accessibility handoff notes.
- P02/P03 security and licensing rules must be reflected exactly: no browser package execution, no community JS/WASM/HTML/CSS, SPDX/provenance required, soundtrack prohibition preserved, and local-only soundtrack import treated as future optional local-only behavior that never enters network, catalog, exports, diagnostics, public screenshots, or service-worker requests.

## In scope

- VG-09-DOCS: Mintlify IA and content for Start Here, Create Packs, Reference, Contribute, and Project.
- VG-09-CONTRIBUTING: contributor contracts, clean-machine creator workflow, catalog submission policy, stable rejection IDs, append-only appeal history, dispute drill, security policy pointers, license/provenance expectations, issue/PR templates, and example recovery instructions.
- VG-09-README: root README instructions, real checks/badges, project overview, setup/play/build/test commands, CLI examples, PWA/offline notes, architecture links, and release status language.
- VG-09-SCREENSHOTS: truthful screenshot capture plan, manifest, alt text, viewport/source/route metadata, and real image assets captured only from approved builds.
- Community collateral for players, content creators, contributors, and maintainers, including expected result, recovery, next step, and prerequisites for every guided journey.
- P09-owned test-only web coverage in `apps/web/tests/e2e/docs-collateral.spec.ts`, limited to docs navigation, README/collateral assertions, and release-collateral verification; this does not grant app implementation source ownership.

## Non-goals

- No application implementation source, non-P09 app tests, package manifests, lockfiles, CI workflows, deployment state, public repository conversion, npm publishing, Mintlify production deployment, or external account configuration.
- No edits to `docs/research/**` except linking to it; research remains source material, not release collateral.
- No fake ratings, fake testimonials, fake review counts, app-store badges, QR conversion funnels, generated screenshots, mocked gameplay captures, unverified badge URLs, private credentials, or unresolved placeholder copy.

## File and directory ownership boundaries

Own future documentation and collateral paths only for this phase:

- `docs/mint.json`, `docs/start-here/**`, `docs/create-packs/**`, `docs/reference/**`, `docs/contribute/**`, and `docs/project/**` for Mintlify source.
- `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/**`, and `.github/PULL_REQUEST_TEMPLATE.md` for community entry points.
- `docs/community/**`, `docs/release/screenshots/**`, `docs/release/screenshot-manifest.json`, `docs/release/badges.md`, and `docs/release/readme-checks.md` for release collateral.
- `docs/examples/**` only for documentation-facing examples that reference P06-owned example packages without changing their package content.
- Test-only exception: P09 owns `apps/web/tests/e2e/docs-collateral.spec.ts` for docs/community/release-collateral Playwright coverage, invoked from `@infinite-snowball/web` as package-relative `tests/e2e/docs-collateral.spec.ts`; this exception does not include app implementation source or other web tests.

Do not modify `docs/research/**`, app implementation source, package source, catalog registry data, service-worker/cache code, non-P09 web tests, P10 evidence reports, P11 deployment files, or `.omp-status.md`.

## Stable inputs and contracts

- The public descriptor is “original rolling-collection arcade game.” Avoid Katamari names, comparisons that imply affiliation, copied visual language, or soundtrack suggestions.
- Docs IA must let player, creator, and contributor journeys reach the needed page in no more than three navigation choices and each journey must show prerequisites, expected result, recovery, and next step.
- README must use real commands that future CI verifies; badges must map to real configured checks and never imply unpublished stores, fake ratings, or unavailable platforms.
- Screenshot manifest entries must record route, state, viewport, commit SHA, build artifact ID, seed/data fixture, reduced-motion setting, capture command, alt text, reviewer, and license/provenance status.
- Creator docs must prove the clean-machine path: `init` to `convert` to `validate --strict --json` to `publish --dry-run` to `catalog verify`/submission evidence, without relying on local repo state.
- Catalog docs must define stable rejection IDs, maintainer evidence fields, append-only appeal history, withdrawal/replacement flow, and a dispute drill: fresh installs are blocked, existing saves/history remain preserved, and availability returns only through reviewed replacement mapping.
- Creator docs must repeat the security boundary: CLI/CI may resolve and validate exact npm tarballs without lifecycle code; browser runtime never searches npm, unpacks tarballs, imports community JS, uses eval, or follows undeclared URLs.

## Outputs and handoffs

- Handoff to P10: docs journey test cases, README command checks, screenshot manifest, badge mapping, collateral accessibility notes, clean-machine creator workflow evidence, appeal/dispute drill docs, and known editorial risks.
- Handoff to P11: release-ready README, docs source, screenshot assets, badge definitions, Mintlify source tree, public provenance/license/music paperwork, brand/trade-dress review notes, and live-link verification checklist.
- Evidence artifacts should be written by future implementation to `reports/phase-09/docs-check.md`, `reports/phase-09/readme-command-checks.md`, `reports/phase-09/creator-clean-machine.md`, and `reports/phase-09/screenshot-manifest-validation.json`.

## Ordered checklist

1. [ ] **IS-09-001 — Write failing docs navigation checks first.** Add or update the P09-owned `apps/web/tests/e2e/docs-collateral.spec.ts` test to prove player, creator, and contributor journeys complete from top-level Mintlify navigation in no more than three choices and include prerequisites, expected result, recovery, and next step.
2. [ ] **IS-09-002 — Write failing README and command checks first.** Add checks that execute README setup/play/build/CLI examples in dry-run or fixture mode and verify badges correspond to real check names.
3. [ ] **IS-09-003 — Write failing clean-machine creator checks first.** Add a clean temporary-environment check for `init`, `convert`, `validate --strict --json`, `publish --dry-run`, and `catalog verify`/submission evidence before docs claim the path works.
4. [ ] **IS-09-004 — Write failing screenshot-manifest validation first.** Require route, viewport, commit SHA, artifact, seed/state, capture command, alt text, reviewer, and provenance fields before any screenshot is accepted.
5. [ ] **IS-09-005 — Author VG-09-DOCS Mintlify IA.** Build Start Here, Create Packs, Reference, Contribute, and Project docs from P06/P07/P08 contracts with no dead links or missing recovery paths.
6. [ ] **IS-09-006 — Author VG-09-CONTRIBUTING community contracts.** Document catalog submission, content security, license/provenance evidence, withdrawal/replacement, stable rejection IDs, append-only appeal history, dispute drill, issue/PR expectations, and responsible disclosure pointers.
7. [ ] **IS-09-007 — Author VG-09-README.** Write the root README with truthful product positioning, local setup, play, PWA/offline, CLI, creator workflow, contribution, checks, badges, screenshots, and phase/playbook links.
8. [ ] **IS-09-008 — Capture VG-09-SCREENSHOTS from real approved builds.** Capture only real UI/game states from P08-approved routes and P05/P07-backed fixtures; include 375, 768, 1024, 1440, reduced-motion, keyboard-focus, and relevant store/offline states.
9. [ ] **IS-09-009 — Verify docs copy against security/licensing/brand rules.** Ensure no docs suggest arbitrary browser code execution, unreviewed package installs, bundled Katamari soundtrack, unclear “royalty-free” music, NC/ND assets, backend accounts, permanent offline storage promises, or copied brand/trade dress.
10. [ ] **IS-09-010 — Validate links, images, examples, badges, and accessibility.** Run docs preview/link checks, README command checks, clean-machine creator checks, screenshot manifest validation, alt-text/heading-order checks, and the P09-owned web docs-collateral test through its package-relative command.
11. [ ] **IS-09-011 — Record evidence and release handoff.** Save docs, screenshot, badge, README, creator-workflow, and dispute-drill verification evidence for P10/P11; block completion on any missing VG-09 gate.

## Test-first acceptance criteria

- P09-owned docs navigation coverage in `apps/web/tests/e2e/docs-collateral.spec.ts`, README command, clean-machine creator workflow, badge mapping, screenshot manifest, link, and accessibility checks exist before the docs and collateral are completed.
- VG-09-DOCS passes only when Start Here, Create Packs, Reference, Contribute, and Project pages are present, navigable, accurate to P06/P07/P08 contracts, and journey-tested within three choices.
- VG-09-CONTRIBUTING passes only when catalog submission, security, licensing/provenance, stable rejection IDs, append-only appeals, dispute drill, withdrawal/replacement, and contributor workflow docs contain exact prerequisites, expected output, recovery, and next step.
- VG-09-README passes only when README commands are checked, badges map to real checks, copy is truthful, screenshots are referenced through the manifest, and no fake store/review/backend claims appear.
- VG-09-SCREENSHOTS passes only when every screenshot is captured from an approved real build/state and manifest metadata plus alt text are complete.

## Smallest meaningful verification

Future implementation must run focused documentation checks before broader release validation:

```bash
pnpm docs:check
pnpm docs:journeys -- --max-nav-choices=3
pnpm readme:check
pnpm creator:clean-machine -- --workflow init,convert,validate,publish-dry-run,catalog-verify
pnpm screenshots:verify -- --manifest docs/release/screenshot-manifest.json
pnpm --filter @infinite-snowball/web exec playwright test tests/e2e/docs-collateral.spec.ts --project=chromium
```

Expected result: all commands pass; the P09-owned web docs-collateral test is invoked through `pnpm --filter @infinite-snowball/web` with package-relative `tests/e2e/docs-collateral.spec.ts`; player, creator, and contributor journeys meet the navigation limit; README examples are executable or explicitly dry-run checked; creator clean-machine flow produces catalog evidence; screenshots are real, manifest-backed, and accessible.

## Quality gates

| Area | Gate ID | Required evidence | Stop or rollback trigger |
|---|---|---|---|
| Performance | VG-09-DOCS; VG-09-SCREENSHOTS | Docs preview loads without autoplay video loops; screenshots are optimized and do not exceed documented collateral budgets; README images use appropriate dimensions and compression. | Collateral causes slow docs pages, layout shift, excessive image weight, or hides required text behind media. |
| Accessibility | VG-09-DOCS; VG-09-README | Mintlify pages and README use semantic heading order, descriptive link text, alt text, keyboard-reachable journeys, and no color-only meaning. | Missing alt text, inaccessible navigation, dead keyboard path, low-contrast badge/image use, or journey requiring more than three choices. |
| Security | VG-09-CONTRIBUTING; VG-09-README | Docs repeat no arbitrary browser code execution, no lifecycle script trust, exact package validation, responsible disclosure, no secrets in examples, clean-machine workflow, and no backend-v1 claims. | Any docs instruct unsafe npm/browser behavior, paste credentials, weaken threat rules, omit dispute blocking behavior, or imply accounts/cloud saves in v1. |
| Licensing | VG-09-CONTRIBUTING; VG-09-SCREENSHOTS | SPDX/provenance rules, attribution requirements, screenshot provenance, brand/trade-dress review, music restrictions, stable rejection IDs, appeal history, and asset withdrawal process are documented and checked. | Any unverified asset, missing license path, NC/ND suggestion, ambiguous “royalty-free” claim, soundtrack reference, copied trade dress, or missing appeal/dispute record appears. |
| Offline/recovery | VG-09-DOCS; VG-09-README | Player docs and README cover PWA install, offline limitations, save export/import, package-lock recovery, quota failure recovery, local-only audio boundaries, and no permanence promise. | Docs omit offline recovery, leak local-only audio into network/catalog/export/public captures, overpromise storage permanence, or fail to describe rollback from failed/disputed installs. |

## Completion and stop condition

P09 is complete only when VG-09-DOCS, VG-09-CONTRIBUTING, VG-09-README, and VG-09-SCREENSHOTS have evidence and the handoff package is ready for P10/P11. Stop if screenshots are mocked, badge targets are not real, docs contradict security/licensing/offline boundaries, creator clean-machine workflow lacks evidence, appeal/dispute docs are not append-only, or any required journey cannot be completed from navigation in no more than three choices.

## Rollback and recovery notes

Documentation changes are safely reversible by reverting phase-owned docs, community files, README changes, badge references, screenshot assets, and P09-owned test-only `apps/web/tests/e2e/docs-collateral.spec.ts` changes. If a screenshot is later found stale, misleading, private, or unlicensed, remove the file and manifest row, block the README reference, and recapture from the current approved build. If a README command, docs-collateral test assertion, or clean-machine creator path becomes false, remove the claim or mark it blocked by its gate until the command or package-relative test path is verified again. If appeal or dispute handling is wrong, withdraw the docs section, preserve append-only history, and block catalog guidance until P07/P10 sign off. Do not compensate for docs failures by changing source behavior in this phase.
