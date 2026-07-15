import { describe, expect, it } from "vitest";

import {
  SaveExportSchema,
  computeSaveExportIntegrity,
  parseSaveExport,
  verifySaveExportIntegrity,
} from "../../packages/protocol/src/browser.js";

const NOW = "2026-07-14T00:00:00.000Z";

const PAYLOAD = {
  schemaVersion: "1.0.0" as const,
  gameVersion: "1.0.0",
  createdAt: NOW,
  localProfileId: "local:profile:1",
  campaignProgress: [{ campaignId: "starter", unlockedLevelIds: ["winter-garden"] }],
  levelProgress: [
    {
      levelId: "winter-garden",
      levelVersion: "1.0.0",
      seed: "seed:1",
      score: 1_200,
      objectives: { "collect-ten": true },
    },
  ],
  settings: { audioVolume: 0.8, reducedMotion: false, inputPreset: "default" },
  activePackageLockIds: ["lock:golden:1"],
  migrationVersion: "1",
  checksumAlgorithm: "sha256" as const,
};

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJsonForTest(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonForTest(item) ?? "null").join(",")}]`;
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const entries: string[] = [];
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    const child = canonicalJsonForTest((value as Record<string, unknown>)[key]);
    if (child !== undefined) entries.push(`${JSON.stringify(key)}:${child}`);
  }
  return `{${entries.join(",")}}`;
}

function canonicalBytes(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(canonicalJsonForTest(value) ?? "null");
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createSave() {
  return { ...PAYLOAD, ...(await computeSaveExportIntegrity(PAYLOAD)) };
}

describe("SaveExport integrity and hostile-input boundary", () => {
  it("hashes the documented canonical UTF-8 domains with Web Crypto", async () => {
    const save = await createSave();
    const { payloadBytes: _payloadBytes, sectionChecksums: _sectionChecksums, checksum: _checksum, ...payload } =
      save;
    const payloadEncoding = canonicalBytes(payload);

    expect(save.payloadBytes).toBe(payloadEncoding.byteLength);
    expect(save.checksum).toBe(await sha256(payloadEncoding));
    expect(save.sectionChecksums.progress).toBe(
      await sha256(
        canonicalBytes({
          campaignProgress: PAYLOAD.campaignProgress,
          levelProgress: PAYLOAD.levelProgress,
        }),
      ),
    );
    expect(save.sectionChecksums.settings).toBe(await sha256(canonicalBytes(PAYLOAD.settings)));
    expect(save.sectionChecksums.locks).toBe(
      await sha256(canonicalBytes(PAYLOAD.activePackageLockIds)),
    );
  });

  it("defensively hashes direct-input record keys, including __proto__", async () => {
    const progress = PAYLOAD.levelProgress[0];
    if (progress === undefined) throw new Error("SaveExport fixture requires level progress.");
    const withTrue = {
      ...PAYLOAD,
      levelProgress: [
        {
          ...progress,
          objectives: Object.fromEntries([["__proto__", true]]),
        },
      ],
    };
    const withFalse = {
      ...PAYLOAD,
      levelProgress: [
        {
          ...progress,
          objectives: Object.fromEntries([["__proto__", false]]),
        },
      ],
    };

    expect(Object.hasOwn(withTrue.levelProgress[0]?.objectives ?? {}, "__proto__")).toBe(true);
    expect((await computeSaveExportIntegrity(withTrue)).checksum).not.toBe(
      (await computeSaveExportIntegrity(withFalse)).checksum,
    );
  });

  it("rejects reserved objective keys instead of silently normalizing them", async () => {
    const save = await createSave();
    const progress = save.levelProgress[0];
    if (progress === undefined) throw new Error("SaveExport fixture requires level progress.");
    const objectives = JSON.parse('{"__proto__":true}') as Record<string, boolean>;
    const candidate = {
      ...save,
      levelProgress: [{ ...progress, objectives }],
    };

    expect(Object.hasOwn(objectives, "__proto__")).toBe(true);
    expect(SaveExportSchema.safeParse(candidate).success).toBe(false);
    expect(parseSaveExport(candidate)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_SCHEMA_STRICT" }],
    });
  });

  it("orders integer-like record keys by UTF-16 code units", async () => {
    const progress = PAYLOAD.levelProgress[0];
    if (progress === undefined) throw new Error("SaveExport fixture requires level progress.");
    const payload = {
      ...PAYLOAD,
      levelProgress: [
        {
          ...progress,
          objectives: { "2": true, "10": false },
        },
      ],
    };
    const expectedProgress = canonicalBytes({
      campaignProgress: payload.campaignProgress,
      levelProgress: payload.levelProgress,
    });

    expect(new TextDecoder().decode(expectedProgress)).toContain(
      '"objectives":{"10":false,"2":true}',
    );
    expect((await computeSaveExportIntegrity(payload)).sectionChecksums.progress).toBe(
      await sha256(expectedProgress),
    );
  });

  it("keeps structural parsing synchronous and rejects every stale declaration asynchronously", async () => {
    const save = await createSave();

    expect(parseSaveExport(save)).toMatchObject({ ok: true, issues: [] });
    await expect(verifySaveExportIntegrity(save)).resolves.toMatchObject({ ok: true, issues: [] });
    await expect(
      verifySaveExportIntegrity({ ...save, payloadBytes: save.payloadBytes + 1 }),
    ).resolves.toMatchObject({ ok: false, issues: [{ ruleId: "E_SAVE_EXPORT_SIZE" }] });
    await expect(
      verifySaveExportIntegrity({
        ...save,
        sectionChecksums: { ...save.sectionChecksums, progress: "e".repeat(64) },
      }),
    ).resolves.toMatchObject({ ok: false, issues: [{ ruleId: "E_SAVE_EXPORT_INTEGRITY" }] });
    await expect(
      verifySaveExportIntegrity({ ...save, checksum: "e".repeat(64) }),
    ).resolves.toMatchObject({ ok: false, issues: [{ ruleId: "E_SAVE_EXPORT_INTEGRITY" }] });
    await expect(
      verifySaveExportIntegrity({
        ...save,
        levelProgress: [{ ...save.levelProgress[0], score: 9_999 }],
      }),
    ).resolves.toMatchObject({ ok: false, issues: [{ ruleId: "E_SAVE_EXPORT_INTEGRITY" }] });
  });

  it("classifies malformed integrity declaration schema paths exactly", async () => {
    const save = await createSave();

    await expect(
      verifySaveExportIntegrity({
        ...save,
        sectionChecksums: { ...save.sectionChecksums, progress: "not-a-sha" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_SAVE_EXPORT_INTEGRITY", path: "/sectionChecksums/progress" }],
    });
    await expect(
      verifySaveExportIntegrity({ ...save, checksum: "not-a-sha" }),
    ).resolves.toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_SAVE_EXPORT_INTEGRITY", path: "/checksum" }],
    });
    await expect(
      verifySaveExportIntegrity({ ...save, checksumAlgorithm: "sha512" }),
    ).resolves.toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_SAVE_EXPORT_VERSION", path: "/checksumAlgorithm" }],
    });
    await expect(
      verifySaveExportIntegrity({
        ...save,
        settings: { ...save.settings, audioVolume: 2 },
      }),
    ).resolves.toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_SCHEMA_STRICT", path: "/settings/audioVolume" }],
    });
  });

  it("fails closed with bounded results for cyclic, deep, and oversized raw input", async () => {
    const save = await createSave();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const cyclicResult = parseSaveExport({ ...save, unknown: cycle });

    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < 80; depth += 1) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }
    const deepResult = parseSaveExport({ ...save, unknown: deep });

    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 40_000; index += 1) wide[`field-${index}`] = index;
    const wideResult = parseSaveExport({ ...save, unknown: wide });
    const sparseResult = parseSaveExport({ ...save, unknown: new Array(1_000_000) });

    expect(cyclicResult).toMatchObject({ ok: false, issues: [{ ruleId: "E_SCHEMA_STRICT" }] });
    for (const result of [deepResult, wideResult, sparseResult]) {
      expect(result).toMatchObject({ ok: false, issues: [{ ruleId: "E_SAVE_EXPORT_SIZE" }] });
    }
    for (const result of [cyclicResult, deepResult, wideResult, sparseResult]) {
      expect(JSON.stringify(result).length).toBeLessThan(10_000);
    }
  });

  it("keeps privacy preflight budgets above schema-valid nested collections", async () => {
    const save = await createSave();
    const nestedCampaigns = Array.from({ length: 33 }, (_, campaignIndex) => ({
      campaignId: `campaign:${campaignIndex}`,
      unlockedLevelIds: Array.from(
        { length: 1_024 },
        (_, levelIndex) => `level:${levelIndex}`,
      ),
    }));
    const candidate = { ...save, campaignProgress: nestedCampaigns };

    expect(SaveExportSchema.safeParse(candidate).success).toBe(true);
    expect(parseSaveExport(candidate)).toMatchObject({ ok: true, issues: [] });
  });

  it("rejects a schema-valid aggregate above the canonical 16 MiB ceiling before Zod", async () => {
    const save = await createSave();
    const maxLengthId = "a".repeat(128);
    const campaignProgress = Array.from({ length: 130 }, (_, campaignIndex) => ({
      campaignId: `campaign:${campaignIndex}`,
      unlockedLevelIds: Array.from({ length: 1_024 }, () => maxLengthId),
    }));
    const candidate = { ...save, campaignProgress };

    expect(SaveExportSchema.safeParse(candidate).success).toBe(true);
    expect(parseSaveExport(candidate)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_SAVE_EXPORT_SIZE" }],
    });
    await expect(
      computeSaveExportIntegrity({ ...PAYLOAD, campaignProgress }),
    ).rejects.toThrow(RangeError);
  });

  it("rejects sparse, accessor-backed, and exotic arrays before Zod reads them", async () => {
    const save = await createSave();
    let accessorRead = false;
    const accessorProgress: unknown[] = [];
    Object.defineProperty(accessorProgress, "0", {
      configurable: true,
      get: () => {
        accessorRead = true;
        throw new Error("Zod must not read this accessor");
      },
    });
    accessorProgress.length = 1;
    const sparseProgress = new Array(1);
    const exoticProgress = [...save.campaignProgress];
    Object.setPrototypeOf(exoticProgress, null);

    const attempts = [accessorProgress, sparseProgress, exoticProgress].map((campaignProgress) =>
      parseSaveExport({ ...save, campaignProgress }),
    );

    expect(accessorRead).toBe(false);
    for (const result of attempts) {
      expect(result).toMatchObject({ ok: false, issues: [{ ruleId: "E_SCHEMA_STRICT" }] });
    }
  });

  it("rejects non-enumerable root accessors before structural parsing", async () => {
    const save = await createSave();
    let accessorRead = false;
    const hostile = { ...save };
    Object.defineProperty(hostile, "campaignProgress", {
      enumerable: false,
      configurable: true,
      get: () => {
        accessorRead = true;
        throw new Error("Zod must not read this root accessor");
      },
    });

    expect(Object.getOwnPropertyDescriptor(hostile, "campaignProgress")?.enumerable).toBe(false);
    expect(() => parseSaveExport(hostile)).not.toThrow();
    expect(accessorRead).toBe(false);
    expect(parseSaveExport(hostile)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_SCHEMA_STRICT" }],
    });
  });

  it("snapshots proxy data descriptors before structural parsing", async () => {
    const save = await createSave();
    let proxyGetReads = 0;
    const hostile = new Proxy({ ...save }, {
      get(target, key, receiver) {
        proxyGetReads += 1;
        if (key === "campaignProgress") {
          throw new Error("structural parsing proxy trap");
        }
        return Reflect.get(target, key, receiver);
      },
    });

    expect(() => parseSaveExport(hostile)).not.toThrow();
    expect(parseSaveExport(hostile)).toMatchObject({ ok: true, issues: [] });
    expect(proxyGetReads).toBe(0);
  });

  it("treats objective IDs as data while detecting every named privacy category", async () => {
    const save = await createSave();
    const progress = save.levelProgress[0];
    if (progress === undefined) throw new Error("SaveExport fixture requires level progress.");
    const objectiveSave = {
      ...save,
      levelProgress: [{ ...progress, objectives: { secret: true } }],
    };

    expect(SaveExportSchema.safeParse(objectiveSave).success).toBe(true);
    expect(parseSaveExport(objectiveSave)).toMatchObject({ ok: true, issues: [] });

    for (const field of [
      "localAudioBytes",
      "localAudioTags",
      "localAudioArtwork",
      "analyticsEvents",
      "diagnosticData",
    ]) {
      expect(parseSaveExport({ ...save, [field]: [] })).toMatchObject({
        ok: false,
        issues: [{ ruleId: "E_PRIVACY_EGRESS" }],
      });
    }
  });

  it("preflights privacy and caps every SaveExport collection and version string", async () => {
    const save = await createSave();
    const fixture = { value: ["private-", "token"].join("") };
    const privateResult = parseSaveExport({ ...save, credentials: { token: fixture.value } });
    expect(privateResult).toMatchObject({ ok: false, issues: [{ ruleId: "E_PRIVACY_EGRESS" }] });
    expect(JSON.stringify(privateResult)).not.toContain(fixture.value);

    expect(
      SaveExportSchema.safeParse({
        ...save,
        campaignProgress: Array.from({ length: 1_025 }, () => save.campaignProgress[0]),
      }).success,
    ).toBe(false);
    expect(
      SaveExportSchema.safeParse({
        ...save,
        levelProgress: Array.from({ length: 1_025 }, () => save.levelProgress[0]),
      }).success,
    ).toBe(false);
    expect(
      SaveExportSchema.safeParse({
        ...save,
        levelProgress: [
          {
            ...save.levelProgress[0],
            objectives: Object.fromEntries(
              Array.from({ length: 1_025 }, (_, index) => [`objective:${index}`, true]),
            ),
          },
        ],
      }).success,
    ).toBe(false);
    expect(SaveExportSchema.safeParse({ ...save, migrationVersion: "1".repeat(10_000) }).success).toBe(
      false,
    );
  });
});
