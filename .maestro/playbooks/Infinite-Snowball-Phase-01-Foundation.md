# Infinite Snowball Phase 01 — Foundation and Quality Harness

Phase ID: P01
Status: Planned
Owner role: Foundation and quality-harness engineer
Depends on: None

## Goal and user value

Establish the future pnpm workspace, pinned dependency baseline, quality-command contract, and required CI check names without creating gameplay, UI, catalog, or deployment features. This gives every later phase a reproducible, test-first foundation and prevents agents from inventing incompatible tooling, stale pins, or missing release gates.

## Prerequisites and dependencies

- Use the reconciled authoring brief as the controlling contract.
- Use `docs/research/architecture-and-assets.md` for the dependency snapshot and repo-shape baseline.
- Respect the planning-only root boundary until this phase is intentionally executed later.
- No prior phase output is required.
- External account gates are not needed in this phase; do not guess npm, GitHub, Cloudflare, Mintlify, or Maestro IDs.

## In scope

- Future root workspace files only: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `.gitignore`, `.editorconfig`, `.npmrc`, and root quality scripts.
- Future shared quality harness locations: `tools/quality/**`, `tests/meta/**`, `tests/fixtures/meta/**`, `vitest.config.ts`, `playwright.config.ts` only when needed by harness checks.
- Future CI baseline under `.github/workflows/**` for the required check-name contract: `lockfile`, `types`, `unit`, `build`, `content-policy`, `license-provenance`, `package-pack`, `e2e-offline`, `dependency-review`, `codeql`, `secret-scan`.
- Future dependency compatibility verification and lockfile pinning for React/DOM 19.2.7, Three 0.185.1, R3F 9.6.1, Drei 10.7.7, React Three Rapier 2.2.0, Koota 0.6.6, Ecctrl 2.0.0, Dexie 4.4.4, dexie-react-hooks 4.4.0, Vite 8.1.4, vite-plugin-pwa 1.3.0, Workbox 7.4.1, Zod 4.4.3, glTF Transform 4.4.1, gltfjsx 6.5.3, Vitest 4.1.10, Playwright 1.61.1, TypeScript 7.0.2, and pnpm 11.13.0.
- CI permissions, pinned-action policy, artifact naming policy, and protected-path ownership rules as future configuration and tests.
- Future privacy/ignore controls for `.gitignore` and tests covering `.omp-sessions/`, `.omp-runs/`, `.planning/ultra-root-output.jsonl`, transient logs, credentials, and secret-bearing files while keeping `.env.example` and `.env.schema` trackable.
- Future pnpm dependency lifecycle/build-script policy: dependency scripts default denied with strict failure on unreviewed scripts, reviewed exact-version `allowBuilds` locators in `pnpm-workspace.yaml` tied to the pinned lockfile and package-level rationale, negative fixture coverage for an unapproved install script, and CI/install evidence that fails on any unapproved lifecycle execution or approval gap.

## Non-goals

- No application source, React app, package source, game route, service worker, protocol schema, asset pipeline, catalog, docs site, deployment, package publication, Git remote, or account setup.
- No task/build orchestrator unless a later measured need proves it.
- No Supabase, backend, D1, cloud save, leaderboard, multiplayer, or database setup.
- No public npm package, trusted-publishing setup, Cloudflare Pages project, GitHub Pages deployment, or Mintlify project.
- No dependency pins copied from Mario-Kart-3.js.

## File and directory ownership boundaries

P01 owns these future paths:

- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `tsconfig.base.json`
- `.editorconfig`
- `.gitignore`
- `.npmrc`
- `tools/quality/**`
- `tests/meta/**`
- `tests/fixtures/meta/**`
- `vitest.config.ts`
- `playwright.config.ts`
- `.github/workflows/**`
- `.github/dependabot.yml` if needed for dependency-review policy only
- `.github/CODEOWNERS` entries for workflows/packages/catalog/licenses/deploy paths

P01 must not create or edit these later-phase paths except for CODEOWNERS references to them: `apps/**`, `packages/protocol/**`, `packages/engine/**`, `packages/gameplay/**`, `packages/runtime-r3f/**`, `packages/input/**`, `packages/content-runtime/**`, `packages/cli/**`, `packages/ui/**`, `content/**`, `catalog/**`, `docs/**`, deployment config, or release state.

## Stable inputs and contracts

- Workspace manager: pnpm workspace; Bun may run compatible local TypeScript scripts, but pnpm remains the package manager and lockfile authority.
- Root package must remain private.
- The private root package is `@infinite-snowball/root`; the distinct unscoped `infinite-snowball` name remains reserved for the future public CLI under `packages/cli/**`.
- Required CI check names are stable inputs for P10 and P11 and must exist even when early jobs only prove the baseline.
- All GitHub Actions must be pinned by full commit SHA, use least privilege, avoid secrets on forked pull requests, and avoid publication or deployment in P01.
- Internal scoped package names stay private until npm organization/scope ownership is verified later. Public CLI target remains unscoped `infinite-snowball`, rechecked at release.
- No root command may require a browser app, external account, deployment target, or existing content package to pass in P01.
- Privacy controls are a first-class foundation contract: create `.gitignore` rules and negative fixtures before any future Git staging; verify the rules first with repository-independent privacy fixture tests; only then run future `git init`; immediately after initialization, verify the same probes with fail-closed raw `git check-ignore` output. Complete strict install/test verification and every reviewed evidence update before intentionally staging only P01-owned paths; then audit staged names with `git diff --cached --name-only`, audit tracked forbidden paths with `git ls-files`, and make the staged-content secret scan the final gate immediately before commit and first push. Any later tracked-content or evidence mutation requires restaging and repeating both audits and the staged scan. Raw agent/session transcripts and outputs stay local and are never pasted into tracked docs; only reviewed summaries may be committed.
- Practical ignore patterns must cover `.omp-sessions/`, `.omp-runs/`, `.planning/ultra-root-output.jsonl`, transient logs such as `*.log`, `*.log.*`, `logs/`, `.logs/`, temp/run output such as `tmp/` and `.tmp/`, credentials and secret-bearing files such as `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `.npmrc.local`, and `secrets.*`, with explicit negations for trackable `.env.example` and `.env.schema`.
- pnpm dependency lifecycle scripts fail closed: `.npmrc` must set `strict-dep-builds=true`, `dangerouslyAllowAllBuilds`, broad `onlyBuiltDependencies`, false/silencing approvals, and generated approval placeholders are prohibited, and every `allowBuilds` key must be an exact `package@version` locator present in the lockfile with matching reviewed rationale in package evidence. Any unapproved install/build lifecycle script in fixtures, install logs, CI, or evidence fails P01.

## Outputs and handoffs

- Handoff to P02: reproducible root install, strict TypeScript/Vitest harness, and root scripts that P02 can use for protocol schema and adversarial fixtures.
- Handoff to P03: asset-tooling command slots and license-provenance CI check name without owning asset content.
- Handoff to P04/P05: workspace/package boundaries and test harness for runtime/input/simulation packages.
- Handoff to P10/P11: required check-name contract, pinned-action policy, CODEOWNERS baseline, and artifact naming rules.
- Traceability deliverables owned here: D001 through `VG-01-WORKSPACE`; D002 through `VG-01-CI-CONTRACT`.

## Ordered checklist

1. [ ] IS-01-000 — Write failing privacy/ignore contract tests in `tests/meta/workspace-contract.test.ts` plus negative fixtures in `tests/fixtures/meta/privacy-ignore/**` before any future Git staging. Fixtures must include `.omp-sessions/`, `.omp-runs/`, `.planning/ultra-root-output.jsonl`, transient logs, credentials, secret-bearing files, and positive fixtures proving `.env.example`/`.env.schema` remain trackable.
2. [ ] IS-01-001 — Write failing meta tests in `tests/meta/workspace-contract.test.ts` that assert the root is private, pnpm is the only lock authority, package workspaces match the approved repo shape, root privacy controls are enforced, and no application package is scaffolded by this phase.
3. [ ] IS-01-002 — Write failing dependency-policy fixtures in `tests/fixtures/meta/dependency-snapshot.json` plus lifecycle-script fixtures that verify approved dependency versions are resolved intentionally, approved build-script dependencies appear only in reviewed exact-version `allowBuilds` entries with matching pinned lockfile versions and rationale, every resolved version of an allowed package is reviewed, and an unapproved install script fails rather than executing or being silently ignored.
4. [ ] IS-01-003 — Write failing CI-contract tests in `tests/meta/ci-contract.test.ts` that require every check name: `lockfile`, `types`, `unit`, `build`, `content-policy`, `license-provenance`, `package-pack`, `e2e-offline`, `dependency-review`, `codeql`, `secret-scan`.
5. [ ] IS-01-004 — Write failing security-policy tests that reject unpinned GitHub Actions, broad workflow permissions, release/deploy jobs, secret use in fork-unsafe contexts, tracked raw agent/session transcripts, tracked raw outputs, non-strict pnpm dependency-build settings, `dangerouslyAllowAllBuilds`, and unreviewed dependency lifecycle scripts.
6. [ ] IS-01-005 — Create `.gitignore` privacy/ignore controls and negative fixture files first—before future `git init`, `git add`, first staging, commit, or first push—then create the minimal root pnpm workspace files, `.npmrc` strict dependency-build policy, and root `package.json` scripts needed to run only the P01 meta tests and future phase commands.
7. [ ] IS-01-006 — Resolve and pin the approved dependency snapshot with pnpm 11.13.0; add only reviewed exact-version `allowBuilds` locators tied to lockfile versions and rationale; document any compatibility or lifecycle-script conflict in the evidence log and stop rather than silently substituting versions, accepting generated placeholders, or approving scripts broadly by package name.
8. [ ] IS-01-007 — Add TypeScript, Vitest, and Playwright baseline config only to the extent needed for later packages and meta checks; keep all app routes absent.
9. [ ] IS-01-008 — Add CI workflows with the required check names, pinned actions, least privileges, no publication, no deployment, no external-account mutation, and install evidence that fails on any unapproved dependency lifecycle script.
10. [ ] IS-01-009 — Add CODEOWNERS coverage for workflows, package directories, catalog, licenses/provenance, and deploy paths so later ownership reviews are enforceable.
11. [ ] IS-01-010 — Run the smallest P01 verification sequence: repository-independent privacy fixture tests, future `git init`, immediate raw `git check-ignore` verification, strict install/lifecycle and full P01 test evidence, capture all reviewed evidence and update the future implementation-phase evidence trail, intentionally stage only P01-owned paths, audit staged names with `git diff --cached --name-only`, audit forbidden tracked paths with `git ls-files`, and run the staged-content secret scan as the final gate immediately before commit/first push. If any tracked content or evidence changes after staging or scanning, restage it and repeat both audits and the staged scan.

## Test-first acceptance criteria

- `VG-01-WORKSPACE`: meta tests fail before the workspace, privacy baseline, and dependency lifecycle policy exist and pass only when root privacy, pnpm workspace shape, lockfile authority, approved dependency pins, strict dependency-build denial, and no-app-scaffold constraints are true.
- Privacy/ignore tests fail until `.gitignore` explicitly ignores `.omp-sessions/`, `.omp-runs/`, `.planning/ultra-root-output.jsonl`, transient logs, credentials, and secret-bearing files, while `.env.example` and `.env.schema` remain trackable.
- `VG-01-CI-CONTRACT`: CI-contract tests fail before workflows exist and pass only when every required check name is present, actions are pinned by full SHA, permissions are least-privilege, publish/deploy jobs are absent, `secret-scan` is required, and install evidence fails on any unapproved dependency lifecycle script.
- Raw agent/session transcripts and outputs stay local and are never pasted into tracked docs; only reviewed summaries may be committed.
- P01 cannot commit or push until the ordered privacy sequence is clean: repository-independent ignore-rule tests and negative fixtures pass before future `git init`; raw `git check-ignore` verification passes immediately after initialization; strict install/tests and all reviewed evidence updates finish before staging; staging is intentional and limited to P01-owned paths; `git diff --cached --name-only` shows only intended staged paths; `git ls-files` shows no forbidden private/raw-output paths; and the staged-content secret scan is the final gate immediately before commit and first push. Any later tracked-content or evidence mutation invalidates the gate and requires restaging plus repetition of both audits and the staged scan.
- Dependency compatibility and lifecycle-script conflicts are blocking evidence, not warnings; the phase cannot pass with unreviewed substitutions, non-strict dependency-build settings, broad or incomplete build approvals, false/silencing `allowBuilds` entries, or an unapproved install script that executes or is merely ignored without failing evidence.
- Later-phase path ownership is represented in CODEOWNERS without creating later-phase implementation files.

## Smallest meaningful verification

Future commands and expected results:

```bash
corepack pnpm --version
```

Expected: prints `11.13.0` or the exact pinned pnpm version from the resolved P01 evidence; otherwise stop and fix toolchain pinning.

```bash
corepack pnpm vitest run tests/meta/workspace-contract.test.ts --testNamePattern "privacy|ignore"
```

Expected: fails before privacy controls exist and passes, without requiring repository context, only when direct inspection of `.gitignore` plus negative fixtures proves `.omp-sessions/`, `.omp-runs/`, `.planning/ultra-root-output.jsonl`, transient logs, credentials, and secret-bearing files are ignored while `.env.example` and `.env.schema` remain trackable. Only after this repository-independent test passes may `git init` run.

```bash
git init
```

Expected: runs only after the repository-independent privacy fixture test is clean. It creates local repository context but configures no remote and performs no staging, commit, push, publication, or deployment. Run both raw `git check-ignore` commands immediately afterward and stop before staging if either result is wrong.

```bash
git check-ignore -v -- .omp-sessions/probe.jsonl .omp-runs/probe.jsonl .omp-workarounds/cleanup.json .omp-status.md .planning/ultra-root-output.jsonl logs/probe.log .logs/probe.log tmp/probe.tmp .tmp/probe.tmp .env .env.local .env.production .npmrc.local .netrc .pypirc .aws/credentials .docker/config.json .gnupg/private-keys-v1.d/probe.key .ssh/id_dsa .ssh/id_ecdsa .ssh/id_rsa .ssh/id_ed25519 credentials/local.json .credentials/local.json credentials.local.json account.credentials secret.pem private.key private.jks vault.kdbx release.keystore certificate.p12 identity.pfx id_dsa id_ecdsa id_rsa id_ed25519 secrets.local.json .DS_Store
```

Expected: immediately after `git init` and before `git add`, every listed representative root private/session/output/log/temp/environment/credential/key probe is matched by `.gitignore`; missing or ambiguous raw output fails closed. The preceding repository-independent contract test remains the exhaustive root-and-nested manifest proof.

```bash
! git check-ignore --quiet -- .env.example
! git check-ignore --quiet -- .env.schema
git check-ignore -v -- .env.example .env.schema || test "$?" -eq 1
```

Expected: each quiet check exits non-zero because `.env.example` and `.env.schema` are intentionally trackable public contracts. The verbose command may exit 0 while reporting explicit `!` negation provenance on Git 2.54+, or exit 1 when no rule matches; an actual ignored result fails the quiet checks.



```bash
corepack pnpm vitest run tests/meta/workspace-contract.test.ts --testNamePattern "dependency lifecycle|allowBuilds|install script"
```

Expected: fails until `.npmrc` sets `strict-dep-builds=true`, `dangerouslyAllowAllBuilds` and broad/silencing approvals are absent, every exact-version `allowBuilds` locator has a matching pinned lockfile version and reviewed rationale, every resolved version of an allowed package is covered, and the unapproved install-script fixture makes the evidence fail rather than executing or being silently ignored.

```bash
corepack pnpm install --frozen-lockfile
```

Expected: completes without modifying `pnpm-lock.yaml` only when `.npmrc` enforces `strict-dep-builds=true`, approved build scripts are limited to reviewed exact-version `allowBuilds` locators tied to pinned lock versions and rationale, and no unapproved lifecycle script executes or is reported as merely ignored. Any `approve-builds` prompt, generated approval placeholder, ignored-build warning, unapproved script execution, publication, deployment, scaffold, or lifecycle side effect fails P01.

```bash
corepack pnpm vitest run tests/meta/workspace-contract.test.ts tests/meta/ci-contract.test.ts
```

Expected: passes all P01 meta checks and proves `VG-01-WORKSPACE` and `VG-01-CI-CONTRACT`.

```bash
corepack pnpm run lockfile && corepack pnpm run types && corepack pnpm run unit
```

Expected: each command exits 0 against the minimal harness; commands that are placeholders, no-ops, or skipped without evidence fail the phase.

After every command above passes, capture only reviewed P01 evidence summaries and update the required implementation-phase evidence trail. Finish all tracked-content changes before staging. If any tracked content or evidence changes after the following staging, audits, or scan, restage it and repeat the complete staged-name audit, forbidden tracked-path audit, and staged-content scan.

```bash
git add -- package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json .editorconfig .gitignore .npmrc tools/quality tests/meta tests/fixtures/meta vitest.config.ts playwright.config.ts .github/workflows .github/CODEOWNERS
```

Expected: first staging is intentional and evidence records the exact expanded path list; blanket staging such as `git add .`, any later-phase path, or any private/raw-output path fails closed.

```bash
git diff --cached --name-only
node tools/quality/forbidden-tracked-paths.mjs
```

Expected: staged-name output is non-empty and contains only intended P01-owned paths; the shared forbidden tracked-path audit exits 0 and reports no findings. Empty staged output, unexpected paths, or any root/nested manifest-owned private/session/output/log/temp/environment/credential/key path fails closed. Contract tests must prove the audit catches every ignored probe, including public-env filenames beneath forbidden parent directories, while excluding `.env.example` and `.env.schema` only outside forbidden parents.

```bash
corepack pnpm run secret-scan
```

Expected: as the final gate immediately before commit and first push, the staged-content secret scan reads the staged blob set from `git diff --cached`, exits 0, and reports no credentials or secret-bearing files. Missing staged mode, skipped paths, warnings, scanner raw output that cannot be tied to staged content, or any later tracked-content/evidence mutation fails closed and requires restaging plus repetition of both audits and this scan.

## Quality gates

| Gate area | Gate ID | Required evidence | Stop condition |
|---|---:|---|---|
| Performance | VG-01-WORKSPACE | Not applicable — P01 has no runtime code. Evidence must show no runtime performance claims were made and that later performance check slots remain available for P04/P10. | Stop if P01 invents runtime budgets beyond the brief or marks performance green for an unbuilt app. |
| Accessibility | VG-01-WORKSPACE | Not applicable — P01 has no UI. Evidence must show later Playwright/accessibility harness can be added without app scaffolding. | Stop if P01 creates UI or claims WCAG coverage. |
| Security/privacy | VG-01-CI-CONTRACT | Workflow tests prove pinned actions by full SHA, least privilege, required `dependency-review`, `codeql`, and `secret-scan` checks, no fork-unsafe secrets, privacy tests for `.omp-sessions/`, `.omp-runs/`, `.planning/ultra-root-output.jsonl`, transient logs, credentials, secret-bearing files, trackable `.env.example`/`.env.schema`, ordered repository-independent-ignore-test-before-init-before-raw-check-ignore-before-staging evidence, clean `git diff --cached --name-only` staged-name audit, clean `git ls-files` forbidden tracked-path audit, staged-content secret scan before commit/first push, and strict pnpm dependency lifecycle denial with reviewed exact-version `allowBuilds` locators only. | Stop on unpinned actions, write-all permissions, fake/no-op checks, fork-unsafe secrets, raw/private paths, ambiguous staging, non-staged-content scanning, broad or silencing build approvals, ignored lifecycle warnings, or any publish/deploy side effect. |
| Licensing | VG-01-CI-CONTRACT | CI contract reserves `license-provenance` and `content-policy`; root package license policy is explicit and does not clear any asset by assumption. | Stop if P01 approves third-party assets/music or bypasses provenance review. |
| Offline/recovery | VG-01-WORKSPACE | Not applicable — P01 creates no service worker, Dexie schema, or Cache Storage. Evidence must show no offline behavior was implemented or claimed. | Stop if P01 mutates browser persistence, service-worker state, or catalog install behavior. |

## Completion and stop condition

P01 is complete only when the smallest verification commands pass, `VG-01-WORKSPACE` and `VG-01-CI-CONTRACT` evidence is captured, the dependency snapshot is intentionally resolved or a blocking conflict is documented, strict pnpm dependency-build denial and reviewed exact-version `allowBuilds` evidence are clean, repository-independent privacy/ignore tests pass before future `git init`, raw `git check-ignore` evidence is clean immediately after initialization, and all strict install/tests plus reviewed evidence updates finish before staging. Intentional staging must include only P01-owned paths; `git diff --cached --name-only` and the exhaustive `git ls-files` forbidden-path audit must be clean; and the staged-content secret scan must be the final clean gate immediately before commit and first push. Any later tracked-content or evidence mutation invalidates completion until restaged and all three gates are repeated. P01 must leave the repository private/local, must not commit or push during execution, and must not create application source, browser persistence, content packages, catalog/store logic, deployment, publication, or release state.

## Rollback and recovery notes

P01 changes are root configuration and CI-only. Safe rollback is to revert the P01-owned root files, workflows, lockfile, and `tools/quality/**`/`tests/meta/**` additions together, then rerun the meta tests to confirm later-phase files were not removed. If a dependency resolution creates an unusable lockfile or lifecycle policy gap, restore the last passing `pnpm-lock.yaml`, remove only the unreviewed exact-version `allowBuilds` locator and its matching package evidence, keep strict dependency-build denial enabled, and rerun `corepack pnpm install --frozen-lockfile`; never repair by deleting security checks, weakening pins, allowing all builds, accepting generated placeholders, using broad name-only approvals, or silently approving scripts.

If a repository-independent privacy fixture test fails before `git init`, repair only `.gitignore` and its fixtures without running any Git index command, then rerun that test. If repository context already exists and private material was staged or tracked, stop before commit or first push, remove only the exact offending paths from the index with `git rm --cached -- <audited-paths>`, preserve only reviewed summaries, rotate any exposed credentials, purge raw agent/session transcripts and raw outputs from tracked docs, and restore the `.gitignore` patterns. After either branch is clean, initialize the repository if needed, rerun raw `git check-ignore` before any staging, finish strict install/tests and reviewed evidence updates, then repeat intentional staging, `git diff --cached --name-only`, the exhaustive `git ls-files` audit, and the final staged-content secret scan. Recovery is not complete until `.omp-sessions/`, `.omp-runs/`, `.planning/ultra-root-output.jsonl`, transient and rotated logs, temp/run output, credentials, and secret-bearing files are ignored and absent from staged/tracked content while exactly `.env.example` and `.env.schema` remain trackable.
