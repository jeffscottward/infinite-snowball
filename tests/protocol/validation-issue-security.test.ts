import { describe, expect, it } from "vitest";

import {
  formatValidationResult,
  validationFailure,
  type ValidationIssue,
} from "../../packages/protocol/src/errors.js";

const HUGE = "x".repeat(20_000);

function rawIssue(overrides: Partial<ValidationIssue> = {}): ValidationIssue {
  return {
    ruleId: "E_SCHEMA_STRICT",
    path: "/input",
    observed: null,
    allowed: "bounded protocol data",
    validatorVersion: "1.0.0",
    remediation: "Remove invalid input.",
    ...overrides,
  };
}

function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      output.push(key);
      collectStrings(child, output);
    }
  }
  return output;
}

describe("ValidationIssue serialization boundary", () => {
  it("re-sanitizes every user-derived field even when callers bypass validationIssue", () => {
    const fixtureValues = {
      path: ["path-", "secret"].join(""),
      asset: ["asset-", "secret"].join(""),
      package: ["package-", "secret"].join(""),
      query: ["query-", "secret"].join(""),
      remediation: ["remediation-", "secret"].join(""),
      key: ["key-", "secret"].join(""),
      value: ["value-", "secret"].join(""),
      observed: ["observed-", "secret"].join(""),
      url: ["url-", "secret"].join(""),
      fragment: ["fragment-", "secret"].join(""),
      allowed: ["allowed-", "secret"].join(""),
      string: ["string-", "secret"].join(""),
    };
    const tokenKey = ["to", "ken"].join("");
    const accessTokenKey = ["access_", "token"].join("");
    const passwordKey = ["pass", "word"].join("");
    const apiKey = ["api_", "key"].join("");
    const authorizationKey = ["authoriza", "tion"].join("");
    const result = validationFailure([
      rawIssue({
        path: `/${tokenKey}=${fixtureValues.path}/${HUGE}`,
        assetId: `${accessTokenKey}=${fixtureValues.asset}/${HUGE}`,
        package: `https://admin:${fixtureValues.package}@example.com/${HUGE}?${tokenKey}=${fixtureValues.query}`,
        remediation: `${passwordKey}=${fixtureValues.remediation} ${HUGE}`,
        observed: {
          [`${apiKey}=${fixtureValues.key}-${HUGE}`]: fixtureValues.value,
          ordinary: `${authorizationKey}=${fixtureValues.observed} ${HUGE}`,
          callback:
            `https://user:${fixtureValues.url}@example.com/callback?${tokenKey}=${fixtureValues.query}#${fixtureValues.fragment}`,
        },
        allowed: {
          nested: [{ bearerToken: fixtureValues.allowed }, `cookie=${fixtureValues.string} ${HUGE}`],
        },
      }),
    ]);

    const json = formatValidationResult(result);
    for (const secret of Object.values(fixtureValues)) {
      expect(json).not.toContain(secret);
    }
    expect(json).toContain("[REDACTED");

    const parsed = JSON.parse(json) as unknown;
    expect(Math.max(...collectStrings(parsed).map((value) => value.length))).toBeLessThanOrEqual(161);
  });

  it("redacts authorization credentials and standalone bearer values", () => {
    const credentials = [
      ["upper-", "secret"].join(""),
      ["lower-", "secret"].join(""),
      ["standalone-", "secret"].join(""),
      ["array-", "secret"].join(""),
      ["basic-", "secret"].join(""),
      ["tuple-basic-", "secret"].join(""),
      ["missing-tuple-", "secret"].join(""),
      ["accessor-tuple-", "secret"].join(""),
      ["proxy-tuple-", "secret"].join(""),
    ];
    const missingHeaderTuple = new Array<unknown>(2);
    missingHeaderTuple[1] = `Basic ${credentials[6]}`;
    let accessorRead = false;
    const accessorHeaderTuple: unknown[] = [];
    Object.defineProperty(accessorHeaderTuple, "0", {
      enumerable: true,
      get() {
        accessorRead = true;
        return "Authorization";
      },
    });
    accessorHeaderTuple[1] = `Basic ${credentials[7]}`;
    let tupleHeaderDescriptorReads = 0;
    const proxyHeaderTuple = new Proxy(
      ["Authorization", `Basic ${credentials[8]}`],
      {
        getOwnPropertyDescriptor(target, property) {
          if (property === "0") tupleHeaderDescriptorReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    const result = validationFailure([
      rawIssue({
        path: `/request/Authorization: Bearer ${credentials[0]}`,
        observed: {
          upper: `Authorization: Bearer ${credentials[0]}`,
          lower: `authorization = bearer ${credentials[1]}`,
          standalone: `Bearer ${credentials[2]}`,
          headerTuple: ["Authorization", `Bearer ${credentials[3]}`],
          basic: `Authorization: Basic ${credentials[4]}`,
          basicHeaderTuple: ["Authorization", `Basic ${credentials[5]}`],
          missingHeaderTuple,
          accessorHeaderTuple,
          proxyHeaderTuple,
        },
      }),
    ]);
    expect(accessorRead).toBe(false);
    expect(tupleHeaderDescriptorReads).toBe(1);

    const json = formatValidationResult(result);
    for (const credential of credentials) expect(json).not.toContain(credential);
    expect(json).toContain("Bearer [REDACTED]");
    expect(json).toContain("Basic [REDACTED]");
  });

  it("redacts credentials inside URLs embedded in surrounding text", () => {
    const username = ["embedded-user-", "secret"].join("");
    const password = ["embedded-password-", "secret"].join("");
    const message = `request failed for https://${username}:${password}@example.test/resource`;

    const json = formatValidationResult(
      validationFailure([rawIssue({ observed: { message } })]),
    );

    expect(json).not.toContain(username);
    expect(json).not.toContain(password);
    expect(json).toContain("https://example.test/resource");
  });

  it("redacts punctuation-adjacent URL credentials independently", () => {
    const username = ["adjacent-user-", "secret"].join("");
    const password = ["adjacent-password-", "secret"].join("");
    const message = `sources https://one.test/path,https://${username}:${password}@two.test/resource`;

    const json = formatValidationResult(
      validationFailure([rawIssue({ observed: { message } })]),
    );

    expect(json).not.toContain(username);
    expect(json).not.toContain(password);
    expect(json).toContain("https://one.test/path");
    expect(json).toContain("https://two.test/resource");
  });

  it("caps issues, properties, nodes, and cycles before canonical sorting", () => {
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 1_000; index += 1) wide[`property-${index}-${HUGE}`] = HUGE;
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    const issues = Array.from({ length: 100 }, (_, index) =>
      rawIssue({
        path: `/issue/${index}/${HUGE}`,
        observed: { cycle, wide },
        allowed: [cycle, HUGE],
      }),
    );

    const json = formatValidationResult(validationFailure(issues));
    const parsed = JSON.parse(json) as { issues: Array<{ observed: Record<string, unknown> }> };

    expect(parsed.issues.length).toBeLessThanOrEqual(32);
    expect(Object.keys(parsed.issues[0]?.observed ?? {}).length).toBeLessThanOrEqual(30);
    expect(json).toContain("[CIRCULAR]");
    expect(json.length).toBeLessThan(500_000);
  });
  it("fails closed on hostile arrays and safely preserves __proto__ metadata", () => {
    const credential = ["hostile-", "secret"].join("");
    const tokenKey = ["to", "ken"].join("");
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: () => {
        throw new Error("must not invoke hostile accessors");
      },
    });
    accessorArray.length = 1;
    const protoMetadata = JSON.parse(
      `{"__proto__":"${tokenKey}=${credential}"}`,
    ) as Record<string, unknown>;

    expect(() =>
      validationFailure([
        rawIssue({
          observed: { accessorArray, protoMetadata },
        }),
      ]),
    ).not.toThrow();

    const json = formatValidationResult(
      validationFailure([
        rawIssue({
          observed: { accessorArray, protoMetadata },
        }),
      ]),
    );
    const parsed = JSON.parse(json) as {
      issues: Array<{
        observed: {
          accessorArray: unknown[];
          protoMetadata: Record<string, unknown>;
        };
      }>;
    };

    expect(json).not.toContain(credential);
    expect(parsed.issues[0]?.observed.accessorArray).toEqual(["[REDACTED ACCESSOR]"]);
    expect(Object.hasOwn(parsed.issues[0]?.observed.protoMetadata ?? {}, "__proto__")).toBe(true);
  });

  it("contains revoked proxies without throwing", () => {
    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();

    const result = validationFailure([rawIssue({ observed: proxy })]);

    expect(result.issues[0]?.observed).toBe("[UNINSPECTABLE]");
  });
});
