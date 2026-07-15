import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  validateCatalogFreshness,
  validateCatalogInstallEligibility,
  validateDependencyGraph,
  validateExactLock,
} from "../../packages/protocol/src/validation/dependency-catalog.js";

interface DependencyFixture {
  id: string;
  expectedRuleId: string;
  input: unknown;
}

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "protocol", "dependency-catalog");

const INTEGRITY_A =
  "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const INTEGRITY_B = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const PACKAGE_REF = {
  name: "@test/a",
  version: "1.0.0",
  kind: "level",
  engine: ">=1.0.0 <2.0.0",
  integrity: INTEGRITY_A,
  manifestSha256: "a".repeat(64),
  catalogEntryId: "catalog:test-a:1.0.0",
} as const;

async function readFixture(name: string): Promise<DependencyFixture> {
  return JSON.parse(await readFile(join(FIXTURE_DIR, `${name}.json`), "utf8")) as DependencyFixture;
}

function withParsedPrototypeKey<T extends Record<string, unknown>>(value: T): T {
  return JSON.parse(`{"__proto__":{"polluted":true},${JSON.stringify(value).slice(1)}`) as T;
}

function withHiddenKey<T extends object>(value: T): T {
  const copy = { ...value };
  Object.defineProperty(copy, "unexpected", {
    enumerable: false,
    value: true,
  });
  return copy;
}

function withSymbolKey<T extends object>(value: T): T {
  return Object.assign({ ...value }, { [Symbol("unexpected")]: true });
}

describe("exact dependency and catalog validation", () => {
  it("accepts a deterministic exact acyclic dependency graph", () => {
    const result = validateDependencyGraph({
      root: "@test/root@1.0.0",
      packages: [
        {
          name: "@test/root",
          version: "1.0.0",
          dependencies: [
            { name: "@test/a", version: "1.2.3" },
            { name: "@test/b", version: "2.0.0" },
          ],
          optionalPeers: [],
        },
        { name: "@test/a", version: "1.2.3", dependencies: [], optionalPeers: [] },
        { name: "@test/b", version: "2.0.0", dependencies: [], optionalPeers: [] },
      ],
    });

    expect(result).toMatchObject({ ok: true, issues: [] });
    if (result.ok) expect(result.value.order).toEqual(["@test/a@1.2.3", "@test/b@2.0.0", "@test/root@1.0.0"]);
  });

  it("orders graph dependencies by code units instead of locale collation", () => {
    const result = validateDependencyGraph({
      root: "@test/root@1.0.0",
      packages: [
        {
          name: "@test/root",
          version: "1.0.0",
          dependencies: [
            { name: "@test/a_a", version: "1.0.0" },
            { name: "@test/a-a", version: "1.0.0" },
          ],
          optionalPeers: [],
        },
        { name: "@test/a_a", version: "1.0.0", dependencies: [], optionalPeers: [] },
        { name: "@test/a-a", version: "1.0.0", dependencies: [], optionalPeers: [] },
      ],
    });

    expect(result).toMatchObject({ ok: true, issues: [] });
    if (result.ok) {
      expect(result.value.order).toEqual([
        "@test/a-a@1.0.0",
        "@test/a_a@1.0.0",
        "@test/root@1.0.0",
      ]);
    }
  });

  it("reports peer conflicts by code-unit package name order", () => {
    const result = validateDependencyGraph({
      root: "@test/root@1.0.0",
      packages: [
        {
          name: "@test/root",
          version: "1.0.0",
          dependencies: [{ name: "@test/leaf", version: "1.0.0" }],
          optionalPeers: [
            { name: "@test/a_a", version: "1.0.0" },
            { name: "@test/a-a", version: "1.0.0" },
          ],
        },
        {
          name: "@test/leaf",
          version: "1.0.0",
          dependencies: [],
          optionalPeers: [
            { name: "@test/a_a", version: "2.0.0" },
            { name: "@test/a-a", version: "2.0.0" },
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [
        {
          ruleId: "E_OPTIONAL_PEER_CONFLICT",
          package: "@test/a-a",
          observed: ["1.0.0", "2.0.0"],
        },
      ],
    });
  });
  it("accepts an absent optional peer", () => {
    expect(
      validateDependencyGraph({
        root: "@test/root@1.0.0",
        packages: [
          {
            name: "@test/root",
            version: "1.0.0",
            dependencies: [],
            optionalPeers: [{ name: "@test/integration", version: "1.0.0" }],
          },
        ],
      }),
    ).toMatchObject({ ok: true, issues: [] });
  });

  it("accepts an installed optional peer at its declared exact version", () => {
    const peer = { name: "@test/integration", version: "1.0.0" };
    expect(
      validateDependencyGraph({
        root: "@test/root@1.0.0",
        packages: [
          {
            name: "@test/root",
            version: "1.0.0",
            dependencies: [peer],
            optionalPeers: [peer],
          },
          { ...peer, dependencies: [], optionalPeers: [] },
        ],
      }),
    ).toMatchObject({ ok: true, issues: [] });
  });

  it("rejects an installed optional peer at a different exact version", () => {
    expect(
      validateDependencyGraph({
        root: "@test/root@1.0.0",
        packages: [
          {
            name: "@test/root",
            version: "1.0.0",
            dependencies: [{ name: "@test/integration", version: "2.0.0" }],
            optionalPeers: [{ name: "@test/integration", version: "1.0.0" }],
          },
          {
            name: "@test/integration",
            version: "2.0.0",
            dependencies: [],
            optionalPeers: [],
          },
        ],
      }),
    ).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_OPTIONAL_PEER_CONFLICT", package: "@test/root@1.0.0" }],
    });
  });

  it("rejects duplicate, malformed, and unreachable dependency graph rows", () => {
    const root = { name: "@test/root", version: "1.0.0", dependencies: [], optionalPeers: [] };
    const duplicate = validateDependencyGraph({
      root: "@test/root@1.0.0",
      packages: [root, structuredClone(root)],
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.issues[0]?.ruleId).toBe("E_DEPENDENCY_EXACT");

    const malformed = validateDependencyGraph({
      root: "@test/root@1.0.0-..",
      packages: [{ ...root, version: "1.0.0-.." }],
    });
    expect(malformed.ok).toBe(false);
    expect(malformed.issues[0]?.ruleId).toBe("E_DEPENDENCY_EXACT");

    const unreachable = validateDependencyGraph({
      root: "@test/root@1.0.0",
      packages: [
        root,
        { name: "@test/unreachable", version: "1.0.0", dependencies: [], optionalPeers: [] },
      ],
    });
    expect(unreachable.ok).toBe(false);
    expect(unreachable.issues[0]?.ruleId).toBe("E_DEPENDENCY_EXACT");
  });

  it("rejects unknown and parsed __proto__ keys at graph, row, ref, and lock boundaries", () => {
    const leaf = { name: "@test/a", version: "1.0.0", dependencies: [], optionalPeers: [] };
    const dependency = { name: leaf.name, version: leaf.version };
    const root = {
      name: "@test/root",
      version: "1.0.0",
      dependencies: [dependency],
      optionalPeers: [],
    };
    const graph = {
      root: "@test/root@1.0.0",
      packages: [root, leaf],
    };
    const graphMutations = [
      { ...graph, unexpected: true },
      withParsedPrototypeKey(graph),
      { ...graph, packages: [{ ...root, unexpected: true }, leaf] },
      { ...graph, packages: [withParsedPrototypeKey(root), leaf] },
      {
        ...graph,
        packages: [{ ...root, dependencies: [{ ...dependency, unexpected: true }] }, leaf],
      },
      {
        ...graph,
        packages: [{ ...root, dependencies: [withParsedPrototypeKey(dependency)] }, leaf],
      },
      withHiddenKey(graph),
      withSymbolKey(graph),
      { ...graph, packages: [withHiddenKey(root), leaf] },
      { ...graph, packages: [withSymbolKey(root), leaf] },
      {
        ...graph,
        packages: [{ ...root, dependencies: [withHiddenKey(dependency)] }, leaf],
      },
      {
        ...graph,
        packages: [{ ...root, dependencies: [withSymbolKey(dependency)] }, leaf],
      },
    ];

    for (const mutation of graphMutations) {
      expect(() => validateDependencyGraph(mutation as never)).not.toThrow();
      expect(validateDependencyGraph(mutation as never)).toMatchObject({
        ok: false,
        issues: [{ ruleId: "E_DEPENDENCY_EXACT" }],
      });
    }

    const row = PACKAGE_REF;
    const lock = { planned: [row], locked: [structuredClone(row)] };
    const lockMutations = [
      { ...lock, unexpected: true },
      withParsedPrototypeKey(lock),
      { ...lock, planned: [{ ...row, unexpected: true }] },
      { ...lock, planned: [withParsedPrototypeKey(row)] },
      withHiddenKey(lock),
      withSymbolKey(lock),
      { ...lock, planned: [withHiddenKey(row)] },
      { ...lock, planned: [withSymbolKey(row)] },
    ];
    for (const mutation of lockMutations) {
      expect(() => validateExactLock(mutation as never)).not.toThrow();
      expect(validateExactLock(mutation as never)).toMatchObject({
        ok: false,
        issues: [{ ruleId: "E_LOCK_MISMATCH" }],
      });
    }
  });

  it("rejects over-wide graph and package rows before copying property descriptors", () => {
    const overWideRecord = <T extends object>(value: T) => {
      let descriptorReads = 0;
      const target = {
        ...value,
        ...Object.fromEntries(
          Array.from({ length: 1_024 }, (_, index) => [`extra${index}`, index]),
        ),
      };
      return {
        descriptorReads: () => descriptorReads,
        value: new Proxy(target, {
          getOwnPropertyDescriptor(record, property) {
            descriptorReads += 1;
            return Reflect.getOwnPropertyDescriptor(record, property);
          },
        }),
      };
    };

    const root = {
      name: "@test/root",
      version: "1.0.0",
      dependencies: [],
      optionalPeers: [],
    };
    const wideGraph = overWideRecord({
      root: "@test/root@1.0.0",
      packages: [root],
    });
    expect(validateDependencyGraph(wideGraph.value)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_DEPENDENCY_EXACT" }],
    });
    expect(wideGraph.descriptorReads()).toBe(0);

    const widePackage = overWideRecord(root);
    expect(
      validateDependencyGraph({
        root: "@test/root@1.0.0",
        packages: [widePackage.value],
      }),
    ).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_DEPENDENCY_EXACT" }],
    });
    expect(widePackage.descriptorReads()).toBe(0);
  });

  it("fails closed on hostile or non-plain dependency and lock arrays", () => {
    const root = {
      name: "@test/root",
      version: "1.0.0",
      dependencies: [],
      optionalPeers: [],
    };
    const poisonedArray = new Proxy([] as unknown[], {
      get(target, property, receiver) {
        if (property === "length") throw new Error("hostile array length");
        return Reflect.get(target, property, receiver);
      },
    });
    const dependencyWithAccessor = [{ name: "@test/a", version: "1.0.0" }];
    Object.defineProperty(dependencyWithAccessor, 0, {
      enumerable: true,
      get() {
        throw new Error("hostile dependency entry");
      },
    });
    const packagesWithExtraKey = [root];
    Object.assign(packagesWithExtraKey, { unexpected: true });

    const graphInputs = [
      { root: "@test/root@1.0.0", packages: poisonedArray },
      {
        root: "@test/root@1.0.0",
        packages: [{ ...root, dependencies: dependencyWithAccessor }],
      },
      { root: "@test/root@1.0.0", packages: packagesWithExtraKey },
    ];
    for (const input of graphInputs) {
      expect(() => validateDependencyGraph(input)).not.toThrow();
      expect(validateDependencyGraph(input)).toMatchObject({
        ok: false,
        issues: [{ ruleId: "E_DEPENDENCY_EXACT" }],
      });
    }

    const lockInputs = [
      { planned: poisonedArray, locked: [PACKAGE_REF] },
      {
        planned: Object.assign([PACKAGE_REF], { unexpected: true }),
        locked: [PACKAGE_REF],
      },
    ];
    for (const input of lockInputs) {
      expect(() => validateExactLock(input)).not.toThrow();
      expect(validateExactLock(input)).toMatchObject({
        ok: false,
        issues: [{ ruleId: "E_LOCK_MISMATCH" }],
      });
    }
  });


  it.each([
    ["cycle", validateDependencyGraph],
    ["missing-exact-version", validateDependencyGraph],
    ["optional-peer-conflict", validateDependencyGraph],
    ["stale-catalog-refresh", validateCatalogFreshness],
    ["withdrawn-package", validateCatalogInstallEligibility],
    ["exact-lock-mismatch", validateExactLock],
  ] as const)("rejects %s with its deterministic rule ID", async (name, validator) => {
    const fixture = await readFixture(name);
    const result = validator(fixture.input as never);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.ruleId).toBe(fixture.expectedRuleId);
    expect(result.issues[0]?.package ?? result.issues[0]?.path).toBeTruthy();
    expect(result.issues[0]?.remediation).toBeTruthy();
  });

  it("preserves the last valid snapshot when refresh input is stale", async () => {
    const fixture = await readFixture("stale-catalog-refresh");
    const result = validateCatalogFreshness(fixture.input as Parameters<typeof validateCatalogFreshness>[0]);

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({
      ruleId: "E_CATALOG_STALE",
      observed: "snapshot-old",
      allowed: "snapshot-good",
    });
  });
  it("rejects malformed timestamps and non-finite catalog freshness limits", () => {
    const base = {
      snapshotId: "snapshot-candidate",
      generatedAt: "2026-07-14T00:00:00.000Z",
      now: "2026-07-14T00:00:01.000Z",
      maxAgeSeconds: 60,
      previousValidSnapshotId: "snapshot-good",
    };
    expect(validateCatalogFreshness({ ...base, generatedAt: "07/14/2026" }).issues[0]?.ruleId).toBe(
      "E_CATALOG_STALE",
    );
    expect(validateCatalogFreshness({ ...base, maxAgeSeconds: Number.NaN }).issues[0]?.ruleId).toBe(
      "E_CATALOG_STALE",
    );
  });
  it.each([
    ["null freshness input", null],
    ["missing freshness fields", {}],
  ])("fails closed instead of throwing for %s", (_name, malformed) => {
    expect(() => validateCatalogFreshness(malformed as never)).not.toThrow();
    expect(validateCatalogFreshness(malformed as never)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_CATALOG_STALE" }],
    });
  });



  it.each([
    ["null eligibility input", null],
    ["malformed active package", { status: "active", package: {}, existingInstall: false }],
    [
      "non-boolean existing-install flag",
      {
        status: "active",
        package: { name: "@test/a", version: "1.0.0" },
        existingInstall: 0,
      },
    ],
    [
      "malformed replacement",
      {
        status: "replaced",
        package: { name: "@test/a", version: "1.0.0" },
        existingInstall: true,
        replacement: {},
      },
    ],
  ])("fails closed instead of throwing for %s", (_name, malformed) => {
    expect(() => validateCatalogInstallEligibility(malformed as never)).not.toThrow();
    expect(validateCatalogInstallEligibility(malformed as never).ok).toBe(false);
  });

  it("blocks new withdrawn installs without deleting existing history", async () => {
    const fixture = await readFixture("withdrawn-package");
    const result = validateCatalogInstallEligibility(
      fixture.input as Parameters<typeof validateCatalogInstallEligibility>[0],
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ ruleId: "E_PACKAGE_WITHDRAWN", package: "@test/a@1.0.0" });
    expect(fixture.input).toMatchObject({ existingInstall: true });
  });

  it("accepts only a complete byte-for-byte exact PackageRef lock projection", () => {
    const exact = [PACKAGE_REF];
    expect(validateExactLock({ planned: exact, locked: structuredClone(exact) })).toMatchObject({
      ok: true,
      issues: [],
    });
  });

  it("rejects a permutation of otherwise identical exact-lock rows", () => {
    const second = {
      ...PACKAGE_REF,
      name: "@test/b",
      manifestSha256: "b".repeat(64),
      catalogEntryId: "catalog:test-b:1.0.0",
    };
    expect(
      validateExactLock({
        planned: [PACKAGE_REF, second],
        locked: [second, PACKAGE_REF],
      }),
    ).toMatchObject({ ok: false, issues: [{ ruleId: "E_LOCK_MISMATCH" }] });
  });

  it.each([
    ["name", { name: "@test/b" }],
    ["version", { version: "1.0.1" }],
    ["kind", { kind: "music" }],
    ["engine", { engine: ">=2.0.0 <3.0.0" }],
    ["integrity", { integrity: INTEGRITY_B }],
    ["manifestSha256", { manifestSha256: "b".repeat(64) }],
    ["catalogEntryId", { catalogEntryId: "catalog:test-a:alternate" }],
  ] as const)("rejects an exact-lock mismatch in %s", (_field, replacement) => {
    expect(
      validateExactLock({
        planned: [PACKAGE_REF],
        locked: [{ ...PACKAGE_REF, ...replacement }],
      }),
    ).toMatchObject({ ok: false, issues: [{ ruleId: "E_LOCK_MISMATCH" }] });
  });

  it("rejects additions and removals from either side of the exact lock", () => {
    const second = {
      ...PACKAGE_REF,
      name: "@test/b",
      manifestSha256: "b".repeat(64),
      catalogEntryId: "catalog:test-b:1.0.0",
    };
    expect(validateExactLock({ planned: [PACKAGE_REF, second], locked: [PACKAGE_REF] }).ok).toBe(false);
    expect(validateExactLock({ planned: [PACKAGE_REF], locked: [PACKAGE_REF, second] }).ok).toBe(false);
  });

  it("rejects duplicate, partial, malformed, and unknown-field rows even when both sides match", () => {
    const duplicate = [PACKAGE_REF, structuredClone(PACKAGE_REF)];
    expect(validateExactLock({ planned: duplicate, locked: structuredClone(duplicate) }).ok).toBe(false);
    const invalidRows = [
      {
        name: PACKAGE_REF.name,
        version: PACKAGE_REF.version,
        manifestSha256: PACKAGE_REF.manifestSha256,
      },
      { ...PACKAGE_REF, manifestSha256: "not-a-hash" },
      { ...PACKAGE_REF, unexpected: true },
    ];
    for (const invalid of invalidRows) {
      expect(
        validateExactLock({
          planned: [invalid],
          locked: [structuredClone(invalid)],
        }).ok,
      ).toBe(false);
    }
  });
  it("rejects oversized exact locks before traversing their rows", () => {
    const valid = PACKAGE_REF;
    const oversized = Array.from({ length: 1_025 }, () => valid);
    let rowTouched = false;
    Object.defineProperty(oversized, 0, {
      configurable: true,
      enumerable: true,
      get() {
        rowTouched = true;
        throw new Error("oversized rows must not be traversed");
      },
    });

    expect(() => validateExactLock({ planned: oversized, locked: [valid] })).not.toThrow();
    expect(validateExactLock({ planned: oversized, locked: [valid] })).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_LOCK_MISMATCH" }],
    });
    expect(rowTouched).toBe(false);
  });

  it.each([
    ["null input", null],
    ["missing arrays", {}],
    ["null arrays", { planned: null, locked: null }],
  ])("fails closed instead of throwing for %s", (_name, malformed) => {
    expect(() => validateExactLock(malformed as never)).not.toThrow();
    expect(validateExactLock(malformed as never)).toMatchObject({
      ok: false,
      issues: [{ ruleId: "E_LOCK_MISMATCH", path: "/locked" }],
    });
  });

});
