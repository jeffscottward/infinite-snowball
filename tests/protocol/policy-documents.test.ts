import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const PATHS = {
  threat: "docs/security/threat-model.md",
  browser: "docs/security/browser-no-code-boundary.md",
  manifest: "docs/content-policy/manifest-policy.md",
  catalog: "docs/content-policy/catalog-review-policy.md",
  install: "docs/offline/install-transaction-design.md",
  backend: "docs/offline/no-backend-v1-and-d1-boundary.md",
} as const;

async function readPolicy(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

function expectAll(text: string, patterns: RegExp[]): void {
  for (const pattern of patterns) expect(text).toMatch(pattern);
}

describe("Phase 02 security, content, and offline policy handoff", () => {
  it("defines an actionable supply-chain and offline threat model", async () => {
    const text = await readPolicy(PATHS.threat);
    expectAll(text, [
      /^# .*Threat Model/m,
      /trust boundar/i,
      /npm package/i,
      /CDN|catalog compromise/i,
      /network failure/i,
      /compromised publisher/i,
      /malicious archive/i,
      /quota eviction/i,
      /stale.*withdrawn|withdrawn.*stale/i,
      /shared-reference garbage collection/i,
      /interrupted migration/i,
      /credential.*redact|redact.*credential/i,
      /mitigation/i,
      /residual risk/i,
      /incident|withdrawal response/i,
    ]);
  });

  it("freezes the strict manifest, provenance, and hostile-input policy", async () => {
    const text = await readPolicy(PATHS.manifest);
    expectAll(text, [
      /schemaVersion.*1\.0\.0/i,
      /level.*character.*object-pack.*campaign.*music.*bundle/is,
      /unknown fields.*reject/i,
      /empty.*capabilities/i,
      /traversal/i,
      /absolute.*drive.*UNC.*NUL/is,
      /encoded traversal/i,
      /Unicode.*case collision/is,
      /symlink/i,
      /unknown files/i,
      /JS.*WASM.*HTML.*CSS/is,
      /MIME/i,
      /SHA-256/i,
      /exact semver/i,
      /SPDX|license/i,
      /codec/i,
      /GLB.*external.*data.*network/is,
      /2,?048 files/i,
      /256 MiB/i,
      /512 MiB/i,
      /depth.*12/i,
      /compression ratio.*100/i,
      /verified.*incomplete.*disputed.*withdrawn/is,
      /attribution/i,
      /transformation.*recipe.*tool.*config/is,
      /rule ID/i,
      /remediation/i,
    ]);
  });

  it("requires curated exact catalog review and last-valid fallback", async () => {
    const text = await readPolicy(PATHS.catalog);
    expectAll(text, [
      /exact version/i,
      /integrity/i,
      /npm provenance/i,
      /immutable.*resourcePath/i,
      /per-file hash/i,
      /resourceBasePath.*\.\/catalog\//i,
      /CatalogResourcePath/i,
      /document\.baseURI.*self\.registration\.scope/is,
      /same-origin.*catalog\//is,
      /legacy.*cdnBaseUrl|cdnBaseUrl.*reject/is,
      /legacy catalog `url` fields fail closed/i,
      /reviewer.*date.*evidence/is,
      /acyclic|cycle/i,
      /optional peer/i,
      /exact lock/i,
      /stale refresh/i,
      /last valid/i,
      /withdrawal.*replacement/is,
      /unfiltered npm/i,
      /block new installs/i,
      /preserve.*save.*history/is,
    ]);
  });

  it("separates CLI/CI package inspection from the browser immutable-file graph", async () => {
    const text = await readPolicy(PATHS.browser);
    expectAll(text, [
      /CLI\/CI/i,
      /bounded extraction/i,
      /lifecycle scripts?.*(?:never|disabled|forbidden)/i,
      /curated immutable files/i,
      /Node/i,
      /npm/i,
      /archive/i,
      /filesystem/i,
      /undeclared.*network|network-following/i,
      /eval/i,
      /Function/i,
      /dynamic.*import/i,
      /community.*code/i,
      /validators.*types.*schema data/is,
    ]);
  });

  it("defines the P07 transaction, cache, migration, and service-worker contract without implementing it", async () => {
    const text = await readPolicy(PATHS.install);
    expectAll(text, [
      /design only|not an implementation/i,
      /Dexie/i,
      /Cache Storage/i,
      /catalogSnapshots.*catalogEntries.*packages.*assets.*packageAssets.*packageLocks.*installTransactions.*saves.*settings.*migrations/is,
      /planned.*staging.*verifying.*committing.*installed.*failed.*canceled/is,
      /quota.*persistence.*before.*staging/is,
      /side-by-side/i,
      /previous.*lock/i,
      /reference count/i,
      /garbage collection/i,
      /rollback/i,
      /reconciliation/i,
      /idempotent/i,
      /offline.*verified.*cached/is,
      /SaveExport/i,
      /injectManifest/i,
      /known-good shell/i,
    ]);
  });

  it("blocks any v1 backend and defines the complete evidence gate for a later D1 ADR", async () => {
    const text = await readPolicy(PATHS.backend);
    expectAll(text, [
      /ADR/i,
      /v1.*no backend/i,
      /Supabase/i,
      /D1/i,
      /accounts/i,
      /cloud saves/i,
      /leaderboards/i,
      /multiplayer/i,
      /export\/import/i,
      /online user story/i,
      /authentication|auth/i,
      /abuse/i,
      /privacy/i,
      /retention.*deletion.*export/is,
      /schema.*migration/is,
      /quota.*cost/is,
      /backup.*restore/is,
      /load[- ]test/i,
    ]);
    expect(text).not.toMatch(/Supabase is configured|D1 database is created|service worker is implemented/i);
  });
});
