import { join } from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  assertBrowserBoundary,
  inspectBrowserGraph,
} from "../../packages/protocol/scripts/check-browser-boundary.mjs";

const ROOT = process.cwd();
const BROWSER_ENTRY = join(ROOT, "packages", "protocol", "src", "browser.ts");
const MUTATION_DIR = join(ROOT, "tests", "fixtures", "protocol", "browser-boundary");

const MUTATIONS = [
  ["node-built-in.ts", "B_NODE_BUILTIN"],
  ["npm-resolution.ts", "B_PACKAGE_TOOLING"],
  ["archive-import.ts", "B_PACKAGE_TOOLING"],
  ["lifecycle-execution.ts", "B_NODE_BUILTIN"],
  ["resolved-package-relative.ts", "B_DEPENDENCY_FORBIDDEN"],
  ["eval.ts", "B_EVAL"],
  ["function-constructor.ts", "B_FUNCTION_CONSTRUCTOR"],
  ["member-eval.ts", "B_EVAL"],
  ["member-function-constructor.ts", "B_FUNCTION_CONSTRUCTOR"],
  ["dynamic-community-import.ts", "B_DYNAMIC_IMPORT"],
  ["static-community-code.ts", "B_COMMUNITY_CODE"],
  ["static-community-typescript.ts", "B_COMMUNITY_CODE"],
  ["remote-static-export.ts", "B_NETWORK_FOLLOWING"],
  ["url-asset-following.js", "B_COMMUNITY_CODE"],
  ["import-meta-resolve.ts", "B_COMMUNITY_CODE"],
  ["ambient-url-asset-following.ts", "B_COMMUNITY_CODE"],
  ["ts-wrapped-url-asset-following.ts", "B_COMMUNITY_CODE"],
  ["computed-import-meta-resolve.ts", "B_COMMUNITY_CODE"],
  ["computed-import-meta-url.ts", "B_COMMUNITY_CODE"],
  ["bare-import-meta-alias.ts", "B_COMMUNITY_CODE"],
  ["extensionless-import-meta", "B_COMMUNITY_CODE"],
  ["asset-query-url.ts", "B_COMMUNITY_CODE"],
  ["asset-query-raw.ts", "B_COMMUNITY_CODE"],
  ["network-fetch.ts", "B_NETWORK_FOLLOWING"],
  ["member-fetch.ts", "B_NETWORK_FOLLOWING"],
  ["webassembly-instantiate.ts", "B_CODE_EXECUTION"],
  ["worker-constructor.ts", "B_CODE_EXECUTION"],
  ["decompression-stream.ts", "B_ARCHIVE_PRIMITIVE"],
  ["alias-eval.ts", "B_EVAL"],
  ["alias-function-constructor.ts", "B_FUNCTION_CONSTRUCTOR"],
  ["alias-network.ts", "B_NETWORK_FOLLOWING"],
  ["alias-archive.ts", "B_ARCHIVE_PRIMITIVE"],
] as const;

const REFLECTIVE_BYPASSES = [
  ["reflect-get-function.ts", "B_FUNCTION_CONSTRUCTOR", "Reflect.get(globalThis, \"Function\")"],
  ["computed-global-eval.ts", "B_EVAL", "globalThis[\"eval\"]"],
  ["computed-global-fetch.ts", "B_NETWORK_FOLLOWING", "globalThis[\"fetch\"]"],
  ["dom-script-create.ts", "B_CODE_EXECUTION", "document.createElement(\"script\")"],
  ["string-eval-timeout.ts", "B_EVAL", "window.setTimeout(string)"],
  ["chained-reflect-eval-call.ts", "B_EVAL", "Reflect.get(globalThis, \"eval\")"],
  ["chained-reflect-eval-bind.ts", "B_EVAL", "Reflect.get(globalThis, \"eval\")"],
  ["nested-global-window-eval.ts", "B_EVAL", "globalThis.window.eval"],
  ["reflected-document-script-create.ts", "B_CODE_EXECUTION", "document.createElement(\"script\")"],
  ["alias-reflect-eval.ts", "B_EVAL", "Reflect.get(globalThis, \"eval\")"],
  ["assigned-global-eval.ts", "B_EVAL", "globalThis.eval"],
  ["default-global-eval.ts", "B_EVAL", "globalThis.eval"],
  ["alias-reflected-document-create.ts", "B_CODE_EXECUTION", "document.createElement(\"script\")"],
  ["destructured-document-create.ts", "B_CODE_EXECUTION", "document.createElement(\"script\")"],
  ["alias-reflect-get-eval.ts", "B_EVAL", "Reflect.get(globalThis, \"eval\")"],
  ["destructured-reflect-get-eval.ts", "B_EVAL", "Reflect.get(globalThis, \"eval\")"],
  ["nested-global-destructure-eval.ts", "B_EVAL", "globalThis.eval"],
] as const;

const CONSTRUCTOR_BYPASSES = [
  ["object-constructor-chain.ts", ".constructor"],
  ["array-filter-constructor.ts", ".constructor"],
  ["new-constructor-chain.ts", ".constructor"],
  ["reflect-get-constructor.ts", "Reflect.get(target, \"constructor\")"],
  ["computed-constructor-chain.ts", ".constructor"],
  ["destructured-constructor.ts", ".constructor"],
  ["object-container-constructor.ts", ".constructor"],
  ["descriptor-constructor.ts", "Object.getOwnPropertyDescriptor(target, \"constructor\")"],
  ["dynamic-descriptor-constructor.ts", "Object.getOwnPropertyDescriptor(target, computed)"],
] as const;

const FAIL_CLOSED_SOURCES = [
  ["array-destructure-global-eval.ts", "globalThis"],
  ["object-container-global-eval.ts", "globalThis"],
  ["dynamic-computed-constructor-chain.ts", "[computed](...)"],
  ["dynamic-extracted-constructor.ts", "[computed](...)"],
  ["dynamic-reflect-get-constructor.ts", "[computed](...)"],
  ["reassigned-computed-constructor.ts", "[computed](...)"],
  ["computed-destructured-constructor.ts", "[computed](...)"],
  ["object-container-reflect-constructor.ts", "Reflect"],
  ["default-parameter-global-shadow.ts", "globalThis"],
  ["unapproved-global.ts", "navigator"],
] as const;

const NETWORK_GLOBAL_SINKS = [
  ["location-assign.ts", "location"],
  ["global-open.ts", "open"],
  ["image-src.ts", "Image"],
  ["static-block-global-shadow.ts", "fetch"],
] as const;

describe("browser-safe protocol export graph", () => {
  it("bundles the real browser entry and proves every reachable module is data/validator-only", async () => {
    const result = await inspectBrowserGraph(BROWSER_ENTRY);

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.modules.some((moduleId) => moduleId.endsWith("/packages/protocol/src/browser.ts"))).toBe(true);
    expect(result.modules.some((moduleId) => moduleId.includes("/packages/protocol/scripts/"))).toBe(false);
    expect(result.modules.some((moduleId) => moduleId.includes("/packages/protocol/src/offline/"))).toBe(false);
    expect(result.modules.some((moduleId) => moduleId.includes("/packages/protocol/src/validation/package-inspection.ts"))).toBe(false);
    expect(result.outputBytes).toBeGreaterThan(0);
    await expect(assertBrowserBoundary(BROWSER_ENTRY)).resolves.toMatchObject({ ok: true });
  });

  it.each(MUTATIONS)("rejects %s through the resolved bundle graph", async (fixture, expectedRuleId) => {
    const result = await inspectBrowserGraph(join(MUTATION_DIR, fixture));

    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.ruleId)).toContain(expectedRuleId);
    await expect(assertBrowserBoundary(join(MUTATION_DIR, fixture))).rejects.toThrow(expectedRuleId);
  });

  it.each(REFLECTIVE_BYPASSES)(
    "rejects reflective browser capability bypass %s with deterministic evidence",
    async (fixture, expectedRuleId, expectedEvidence) => {
      const entry = join(MUTATION_DIR, fixture);
      const result = await inspectBrowserGraph(entry);

      expect(result.ok).toBe(false);
      expect(result.violations).toContainEqual(
        expect.objectContaining({
          ruleId: expectedRuleId,
          moduleId: expect.stringContaining(fixture),
          evidence: expectedEvidence,
        }),
      );
      await expect(assertBrowserBoundary(entry)).rejects.toThrow(expectedRuleId);
    },
  );

  it.each(CONSTRUCTOR_BYPASSES)(
    "rejects constructor-derived Function bypass %s with deterministic evidence",
    async (fixture, expectedEvidence) => {
      const entry = join(MUTATION_DIR, fixture);
      const result = await inspectBrowserGraph(entry);

      expect(result.ok).toBe(false);
      expect(result.violations).toContainEqual(
        expect.objectContaining({
          ruleId: "B_FUNCTION_CONSTRUCTOR",
          moduleId: expect.stringContaining(fixture),
          evidence: expectedEvidence,
        }),
      );
      await expect(assertBrowserBoundary(entry)).rejects.toThrow("B_FUNCTION_CONSTRUCTOR");
    },
  );

  it.each(FAIL_CLOSED_SOURCES)(
    "rejects unresolved executable source %s with deterministic evidence",
    async (fixture, expectedEvidence) => {
      const entry = join(MUTATION_DIR, fixture);
      const result = await inspectBrowserGraph(entry);

      expect(result.ok).toBe(false);
      expect(result.violations).toContainEqual(
        expect.objectContaining({
          ruleId: "B_CODE_EXECUTION",
          moduleId: expect.stringContaining(fixture),
          evidence: expectedEvidence,
        }),
      );
      await expect(assertBrowserBoundary(entry)).rejects.toThrow("B_CODE_EXECUTION");
    },
  );

  it.each(NETWORK_GLOBAL_SINKS)(
    "rejects unapproved browser network global %s with deterministic evidence",
    async (fixture, expectedEvidence) => {
      const entry = join(MUTATION_DIR, fixture);
      const result = await inspectBrowserGraph(entry);

      expect(result.ok).toBe(false);
      expect(result.violations).toContainEqual(
        expect.objectContaining({
          ruleId: "B_NETWORK_FOLLOWING",
          moduleId: expect.stringContaining(fixture),
          evidence: expectedEvidence,
        }),
      );
      await expect(assertBrowserBoundary(entry)).rejects.toThrow("B_NETWORK_FOLLOWING");
    },
  );

  it("rejects reflected string-evaluating timer call and bind chains", async () => {
    const entry = join(MUTATION_DIR, "reflected-string-eval-timers.ts");
    const result = await inspectBrowserGraph(entry);

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "B_EVAL",
          evidence: "Reflect.get(globalThis, \"setInterval\")(string)",
        }),
        expect.objectContaining({
          ruleId: "B_EVAL",
          evidence: "Reflect.get(globalThis, \"setTimeout\")(string)",
        }),
      ]),
    );
    await expect(assertBrowserBoundary(entry)).rejects.toThrow("B_EVAL");
  });

  it("rejects every reachable Node global with deterministic evidence", async () => {
    const entry = join(MUTATION_DIR, "node-globals.ts");
    const result = await inspectBrowserGraph(entry);

    expect(result.ok).toBe(false);
    expect(
      result.violations
        .filter((violation) => violation.ruleId === "B_NODE_BUILTIN")
        .map((violation) => violation.evidence),
    ).toEqual(["__dirname", "__filename", "Buffer", "module", "process", "require"]);
    await expect(assertBrowserBoundary(entry)).rejects.toThrow("B_NODE_BUILTIN");
  });

  it("allows harmless text and ordinary object property declarations with capability names", async () => {
    const entry = join(MUTATION_DIR, "harmless-capability-names.ts");
    const result = await inspectBrowserGraph(entry);

    expect(result).toMatchObject({ ok: true, violations: [] });
    await expect(assertBrowserBoundary(entry)).resolves.toMatchObject({ ok: true });
  });

  it("reports deterministic actionable graph evidence without source contents", async () => {
    const entry = join(MUTATION_DIR, "eval.ts");
    const first = await inspectBrowserGraph(entry);
    const second = await inspectBrowserGraph(entry);

    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("source: string");
    expect(first.violations[0]).toMatchObject({
      ruleId: "B_EVAL",
      remediation: expect.any(String),
      moduleId: expect.stringContaining("eval.ts"),
    });
    expectTypeOf(first.violations[0]?.evidence).toEqualTypeOf<string | undefined>();
  });
});
