import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { z } from "zod/mini";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const PROTOCOL_PACKAGE = join(ROOT, "packages", "protocol");
const PACKAGE_JSON = join(PROTOCOL_PACKAGE, "package.json");
const BUILD_CONFIG = join(PROTOCOL_PACKAGE, "tsconfig.build.json");
const TSC_CLI = join(ROOT, "node_modules", "typescript", "bin", "tsc");
let builtProtocolPackage: string | undefined;
const CONSUMER_SOURCE = `import { validatePackageInspection } from "@infinite-snowball/protocol/package-inspection";
import * as browserProtocol from "@infinite-snowball/protocol/browser";

const result = validatePackageInspection(null);
if (result.ok !== false) throw new Error("package inspection validator must reject malformed input");
if (result.issues[0]?.ruleId !== "E_SCHEMA_STRICT") throw new Error("unexpected validation rule id");
if (Object.hasOwn(browserProtocol, "validatePackageInspection")) {
  throw new Error("browser protocol entry must not expose package inspection tooling");
}
console.log(JSON.stringify({ ruleId: result.issues[0]?.ruleId, browserHasPackageInspection: false }));
`;

const PackageJsonSchema = z.object({
  exports: z.record(z.string(), z.unknown()),
});

async function readPackageExports(): Promise<Record<string, unknown>> {
  const parsed = PackageJsonSchema.safeParse(JSON.parse(await readFile(PACKAGE_JSON, "utf8")));
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error("protocol package.json must expose an exports map");
  return parsed.data.exports;
}

async function buildProtocolPackageFixture(): Promise<string> {
  const packageRoot = await mkdtemp(join(tmpdir(), "protocol-package-build-"));
  try {
    await writeFile(join(packageRoot, "package.json"), await readFile(PACKAGE_JSON));
    await symlink(join(PROTOCOL_PACKAGE, "node_modules"), join(packageRoot, "node_modules"), "junction");
    await execFileAsync(
      process.execPath,
      [TSC_CLI, "-p", BUILD_CONFIG, "--outDir", join(packageRoot, "dist")],
      { cwd: ROOT },
    );
    return packageRoot;
  } catch (error) {
    await rm(packageRoot, { recursive: true, force: true });
    throw error;
  }
}

async function createConsumerFixture(): Promise<string> {
  const consumerRoot = await mkdtemp(join(tmpdir(), "protocol-package-consumer-"));
  const scopeRoot = join(consumerRoot, "node_modules", "@infinite-snowball");
  await mkdir(scopeRoot, { recursive: true });
  if (!builtProtocolPackage) throw new Error("protocol package fixture must be built before use");
  await symlink(builtProtocolPackage, join(scopeRoot, "protocol"), "dir");
  return consumerRoot;
}

async function writeConsumerModule(consumerRoot: string, name: string, source: string): Promise<string> {
  const modulePath = join(consumerRoot, name);
  await writeFile(modulePath, source);
  return modulePath;
}

describe("protocol package export map", () => {
  beforeAll(async () => {
    builtProtocolPackage = await buildProtocolPackageFixture();
  });

  afterAll(async () => {
    if (builtProtocolPackage) await rm(builtProtocolPackage, { recursive: true, force: true });
    builtProtocolPackage = undefined;
  });

  it("exposes package inspection only through the dedicated non-browser package subpath", async () => {
    const exports = await readPackageExports();

    expect(exports["./package-inspection"]).toEqual({
      types: "./dist/validation/package-inspection.d.ts",
      import: "./dist/validation/package-inspection.js",
    });
    expect(exports["./browser"]).toEqual({
      types: "./dist/browser.d.ts",
      import: "./dist/browser.js",
    });
    expect(exports["./validation/package-inspection"]).toBeUndefined();
    expect(exports["./src/validation/package-inspection"]).toBeUndefined();
  });

  it("lets a package consumer import validatePackageInspection without leaking internals to browser exports", async () => {
    const consumerRoot = await createConsumerFixture();
    try {
      const modulePath = await writeConsumerModule(consumerRoot, "consumer.mjs", CONSUMER_SOURCE);

      const { stdout } = await execFileAsync(process.execPath, [modulePath], { cwd: consumerRoot });

      expect(JSON.parse(stdout)).toEqual({
        ruleId: "E_SCHEMA_STRICT",
        browserHasPackageInspection: false,
      });
    } finally {
      await rm(consumerRoot, { recursive: true, force: true });
    }
  });

  it.each([
    "@infinite-snowball/protocol/validation/package-inspection",
    "@infinite-snowball/protocol/src/validation/package-inspection.js",
  ])("keeps internal subpath %s encapsulated", async (specifier) => {
    const consumerRoot = await createConsumerFixture();
    try {
      const modulePath = await writeConsumerModule(consumerRoot, "blocked.mjs", `import "${specifier}";\n`);

      await expect(execFileAsync(process.execPath, [modulePath], { cwd: consumerRoot })).rejects.toHaveProperty(
        "stderr",
        expect.stringContaining("ERR_PACKAGE_PATH_NOT_EXPORTED"),
      );
    } finally {
      await rm(consumerRoot, { recursive: true, force: true });
    }
  });
});
