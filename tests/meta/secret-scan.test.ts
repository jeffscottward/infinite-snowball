import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SCANNER = join(ROOT, "tools", "quality", "secret-scan.mjs");
const PACKAGE_JSON = join(ROOT, "package.json");
const FOUNDATION_PLAYBOOK = join(
  ROOT,
  ".maestro",
  "playbooks",
  "Infinite-Snowball-Phase-01-Foundation.md",
);

async function runCommand(command: string, args: string[], cwd: string) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? "",
    };
  }
}

describe("IS-01-010 staged secret scan", () => {
  it("runs the repository secret-scan script against staged content", async () => {
    const packageJson = JSON.parse(await readFile(PACKAGE_JSON, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["secret-scan"]).toBe(
      "node tools/quality/secret-scan.mjs --staged",
    );
    const foundationPlaybook = await readFile(FOUNDATION_PLAYBOOK, "utf8");
    expect(foundationPlaybook).toContain("corepack pnpm run secret-scan");
    expect(foundationPlaybook).not.toContain("secret-scan --staged");
  });

  it("passes safe staged content and reports risky paths or values without echoing secrets", async () => {
    expect(existsSync(SCANNER), "tools/quality/secret-scan.mjs must exist").toBe(true);

    const tempRoot = await mkdtemp(join(tmpdir(), "infinite-snowball-secret-scan-"));
    try {
      expect((await runCommand("git", ["init", "--quiet"], tempRoot)).code).toBe(0);

      await writeFile(join(tempRoot, "safe.txt"), "Pinned action revision: 34e114876b0b11c390a56381ad16ebd13914f8d5\n");
      expect((await runCommand("git", ["add", "--", "safe.txt"], tempRoot)).code).toBe(0);
      expect((await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot)).code).toBe(0);

      await writeFile(join(tempRoot, ".env"), "fixture only\n");
      expect((await runCommand("git", ["add", "--", ".env"], tempRoot)).code).toBe(0);
      const riskyPath = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
      expect(riskyPath.code).not.toBe(0);
      expect(`${riskyPath.stdout}\n${riskyPath.stderr}`).toContain(".env");

      expect((await runCommand("git", ["rm", "--cached", "--force", "--", ".env"], tempRoot)).code).toBe(0);
      await rm(join(tempRoot, ".env"), { force: true });

      const assignmentKey = ["to", "ken"].join("");
      const fakeCredentialValue = `npm_${"a".repeat(32)}`;
      await writeFile(join(tempRoot, "notes.txt"), `${assignmentKey}=${fakeCredentialValue}\n`);
      expect((await runCommand("git", ["add", "--", "notes.txt"], tempRoot)).code).toBe(0);
      const riskyValue = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
      expect(riskyValue.code).not.toBe(0);
      expect(`${riskyValue.stdout}\n${riskyValue.stderr}`).not.toContain(fakeCredentialValue);

      expect((await runCommand("git", ["rm", "--cached", "--force", "--", "notes.txt"], tempRoot)).code).toBe(0);
      await rm(join(tempRoot, "notes.txt"), { force: true });

      const fakeFineGrainedPat = `github_pat_${"c".repeat(64)}`;
      await writeFile(join(tempRoot, "fine-grained.txt"), `${fakeFineGrainedPat}\n`);
      expect((await runCommand("git", ["add", "--", "fine-grained.txt"], tempRoot)).code).toBe(0);
      const riskyFineGrainedPat = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
      expect(riskyFineGrainedPat.code).not.toBe(0);
      expect(`${riskyFineGrainedPat.stdout}\n${riskyFineGrainedPat.stderr}`).not.toContain(fakeFineGrainedPat);

      expect((await runCommand("git", ["rm", "--cached", "--force", "--", "fine-grained.txt"], tempRoot)).code).toBe(0);
      await rm(join(tempRoot, "fine-grained.txt"), { force: true });

      const fakeQuotedCredential = `opaque-credential-${"d".repeat(24)}`;
      const quotedPasswordKey = ["pass", "word"].join("");
      await writeFile(join(tempRoot, "quoted.json"), `${JSON.stringify({ [quotedPasswordKey]: fakeQuotedCredential })}\n`);
      expect((await runCommand("git", ["add", "--", "quoted.json"], tempRoot)).code).toBe(0);
      const riskyQuotedCredential = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
      expect(riskyQuotedCredential.code).not.toBe(0);
      expect(`${riskyQuotedCredential.stdout}\n${riskyQuotedCredential.stderr}`).not.toContain(fakeQuotedCredential);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("allows pure runtime references but rejects lexical, fallback, and assignment bypasses", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "infinite-snowball-source-reference-"));
    try {
      expect((await runCommand("git", ["init", "--quiet"], tempRoot)).code).toBe(0);
      const credentialKey = ["auth", "Token"].join("");
      const templateKey = ["pass", "word"].join("");
      const queryKey = ["access_", "token"].join("");
      const camelCredentialKeys = [
        ["client", "Secret"].join(""),
        ["service", "Password"].join(""),
        ["npm", "Auth", "Token"].join(""),
      ];
      const safeSource = [
        "const fixtureValues = { value: getRuntimeValue() };",
        "const runtimeValue = getRuntimeValue();",
        `export const config = { ${credentialKey}: fixtureValues.value, ${templateKey}: \`\${fixtureValues.value}\`, callback: \`https://example.test/?${queryKey}=\${fixtureValues.value}\` };`,
        `export const runtimeConfig = { ${credentialKey}: runtimeValue, ${templateKey}: \`\${runtimeValue}\`, };`,
        `export const ${credentialKey} = fixtureValues.value`,
        `export const ${templateKey} = \`\${fixtureValues.value}\` // runtime-only fixture`,
      ].join("\n");
      await writeFile(join(tempRoot, "safe.ts"), `${safeSource}\n`);
      expect((await runCommand("git", ["add", "--", "safe.ts"], tempRoot)).code).toBe(0);
      expect((await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot)).code).toBe(0);

      const fakeCredential = `opaque-literal-${"q".repeat(24)}`;
      const riskySources = [
        `export const config = { ${credentialKey}: fixtureValues.value ?? ${JSON.stringify(fakeCredential)}, };\n`,
        `export const config = { ${templateKey}: \`\${fixtureValues.value ?? ${JSON.stringify(fakeCredential)}}\`, };\n`,
        `export const config = { ${credentialKey}: process.env.AUTH_TOKEN ?? ${JSON.stringify(fakeCredential)}, };\n`,
        `export const config = { ${credentialKey}: import.meta.env.AUTH_TOKEN ?? ${JSON.stringify(fakeCredential)}, };\n`,
        `config.${credentialKey} ??= ${JSON.stringify(fakeCredential)};\n`,
        `export const serialized = ${JSON.stringify(`${credentialKey}=prod.${fakeCredential};`)};\n`,
        `export const config = { ${templateKey}: ${JSON.stringify(`abc&${fakeCredential}`)}, };\n`,
        `export const config = { ${templateKey}: ${JSON.stringify(`abc#${fakeCredential}`)}, };\n`,
        `export const config = { ${templateKey}: ${JSON.stringify(`abc"${fakeCredential}`)}, };\n`,
        `export const ${credentialKey} = fixtureValues.value\n  ?? ${JSON.stringify(fakeCredential)};\n`,
        ...camelCredentialKeys.map(
          (key) => `export const config = { ${key}: ${JSON.stringify(fakeCredential)}, };\n`,
        ),
      ];
      for (const [index, source] of riskySources.entries()) {
        const filename = `risky-${index}.ts`;
        await writeFile(join(tempRoot, filename), source);
        expect((await runCommand("git", ["add", "--", filename], tempRoot)).code).toBe(0);
        const result = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
        expect(result.code, `source bypass fixture ${String(index)} must be rejected`).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(fakeCredential);
        expect((await runCommand("git", ["rm", "--cached", "--force", "--", filename], tempRoot)).code).toBe(0);
        await rm(join(tempRoot, filename), { force: true });
      }
      const colonFilename = "0:credential.txt";
      await writeFile(join(tempRoot, colonFilename), `${credentialKey}=${fakeCredential}\n`);
      expect((await runCommand("git", ["add", "--", colonFilename], tempRoot)).code).toBe(0);
      const colonResult = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
      expect(colonResult.code, "stage-0 path syntax must not hide a secret").toBe(1);
      expect(`${colonResult.stdout}\n${colonResult.stderr}`).toContain(colonFilename);
      expect(`${colonResult.stdout}\n${colonResult.stderr}`).not.toContain(fakeCredential);
      expect((await runCommand("git", ["rm", "--cached", "--force", "--", colonFilename], tempRoot)).code).toBe(0);
      await rm(join(tempRoot, colonFilename), { force: true });

      const utf16Filename = "utf16-credential.txt";
      const utf16Content = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(`${credentialKey}=${fakeCredential}\n`, "utf16le"),
      ]);
      await writeFile(join(tempRoot, utf16Filename), utf16Content);
      expect((await runCommand("git", ["add", "--", utf16Filename], tempRoot)).code).toBe(0);
      const utf16Result = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
      expect(utf16Result.code, "UTF-16 credentials must be rejected").toBe(1);
      expect(`${utf16Result.stdout}\n${utf16Result.stderr}`).toContain(utf16Filename);
      expect(`${utf16Result.stdout}\n${utf16Result.stderr}`).not.toContain(fakeCredential);
      expect((await runCommand("git", ["rm", "--cached", "--force", "--", utf16Filename], tempRoot)).code).toBe(0);
      await rm(join(tempRoot, utf16Filename), { force: true });

      await writeFile(
        join(tempRoot, "literal.ts"),
        `export const config = { ${credentialKey}: ${JSON.stringify(fakeCredential)} };\n`,
      );
      expect((await runCommand("git", ["add", "--", "literal.ts"], tempRoot)).code).toBe(0);
      const literalResult = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
      expect(literalResult.code).not.toBe(0);
      expect(`${literalResult.stdout}\n${literalResult.stderr}`).not.toContain(fakeCredential);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects encrypted private key blocks in neutral filenames", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "infinite-snowball-encrypted-key-"));
    try {
      expect((await runCommand("git", ["init", "--quiet"], tempRoot)).code).toBe(0);
      const privateKeyHeader = ["-----BEGIN ENCRYPTED ", "PRIVATE KEY-----"].join("");
      const privateKeyBody = `opaque-private-material-${"k".repeat(48)}`;
      await writeFile(join(tempRoot, "notes.txt"), `${privateKeyHeader}\n${privateKeyBody}\n`);
      expect((await runCommand("git", ["add", "--", "notes.txt"], tempRoot)).code).toBe(0);

      const result = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
      expect(result.code).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(privateKeyBody);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects AWS STS access key IDs without echoing them", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "infinite-snowball-sts-key-"));
    try {
      expect((await runCommand("git", ["init", "--quiet"], tempRoot)).code).toBe(0);
      const fakeStsAccessKey = ["AS", "IA", "Q".repeat(16)].join("");
      await writeFile(join(tempRoot, "ci-output.txt"), `${fakeStsAccessKey}\n`);
      expect((await runCommand("git", ["add", "--", "ci-output.txt"], tempRoot)).code).toBe(0);

      const result = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
      expect(result.code).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(fakeStsAccessKey);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects prefixed credential identifiers without echoing their values", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "infinite-snowball-prefixed-secret-"));
    try {
      expect((await runCommand("git", ["init", "--quiet"], tempRoot)).code).toBe(0);
      const credentialKeys = ["AWS_SECRET_ACCESS_KEY", "OPENAI_API_KEY", "SERVICE_PASSWORD"];

      for (const [index, credentialKey] of credentialKeys.entries()) {
        const filename = `prefixed-${index}.txt`;
        const fakeCredential = `opaque-${String(index)}-${"q".repeat(40)}`;
        await writeFile(join(tempRoot, filename), `${credentialKey}=${fakeCredential}\n`);
        expect((await runCommand("git", ["add", "--", filename], tempRoot)).code).toBe(0);

        const result = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
        expect(result.code, `${credentialKey} must be rejected`).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(fakeCredential);

        expect((await runCommand("git", ["rm", "--cached", "--force", "--", filename], tempRoot)).code).toBe(0);
        await rm(join(tempRoot, filename), { force: true });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("checks every credential assignment on a staged line", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "infinite-snowball-multi-secret-"));
    try {
      expect((await runCommand("git", ["init", "--quiet"], tempRoot)).code).toBe(0);
      const tokenKey = ["to", "ken"].join("");
      const passwordKey = ["pass", "word"].join("");
      const fakeCredential = `opaque-real-credential-${"r".repeat(24)}`;

      for (const [index, placeholder] of ["placeholder", "placeholder-value"].entries()) {
        const filename = `multiple-${index}.json`;
        const stagedLine = JSON.stringify({
          [tokenKey]: placeholder,
          [passwordKey]: fakeCredential,
        });
        await writeFile(join(tempRoot, filename), `${stagedLine}\n`);
        expect((await runCommand("git", ["add", "--", filename], tempRoot)).code).toBe(0);

        const result = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
        expect(result.code, `assignment after ${placeholder} must be checked`).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(fakeCredential);

        expect((await runCommand("git", ["rm", "--cached", "--force", "--", filename], tempRoot)).code).toBe(0);
        await rm(join(tempRoot, filename), { force: true });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects credential-bearing public env examples without echoing values", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "infinite-snowball-public-env-secret-"));
    try {
      expect((await runCommand("git", ["init", "--quiet"], tempRoot)).code).toBe(0);
      const envReference = ["$", "{AUTH_TOKEN}"].join("");
      const authTokenKey = ["AUTH_", "TOKEN"].join("");
      const servicePasswordKey = ["SERVICE_", "PASSWORD"].join("");
      const tokenEndpointKey = ["OAUTH_", "TOKEN_", "ENDPOINT"].join("");
      const passwordResetUrlKey = ["PASSWORD_", "RESET_", "URL"].join("");
      const tokenTtlSecondsKey = ["ACCESS_", "TOKEN_", "TTL_", "SECONDS"].join("");

      await writeFile(
        join(tempRoot, ".env.example"),
        [
          "DATABASE_URL=postgresql://<user>:<password>@localhost:5432/infinite_snowball",
          "OPENAI_API_KEY=",
          "SERVICE_PASSWORD=<redacted>",
          `${authTokenKey}=${envReference}`,
          `${tokenEndpointKey}=https://identity.example.invalid/token`,
          `${passwordResetUrlKey}=https://identity.example.invalid/reset`,
          `${tokenTtlSecondsKey}=3600`,
          "",
        ].join("\n"),
      );
      await writeFile(
        join(tempRoot, ".env.schema"),
        ["DATABASE_URL=<postgresql-url>", "AUTH_TOKEN=placeholder", ""].join("\n"),
      );
      expect((await runCommand("git", ["add", "--", ".env.example", ".env.schema"], tempRoot)).code).toBe(0);
      expect((await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot)).code).toBe(0);

      const publicEnvCases = [
        {
          filename: ".env.example",
          fixtureValue: `opaque-db-password-${"e".repeat(24)}`,
          content: (value: string) => `DATABASE_URL=postgresql://snowball:${value}@db.example.invalid/infinite\n`,
        },
        {
          filename: ".env.schema",
          fixtureValue: `opaque-schema-password-${"f".repeat(24)}`,
          content: (value: string) => `DATABASE_URL=postgresql://schema:${value}@db.example.invalid/infinite\n`,
        },
        {
          filename: ".env.example",
          fixtureValue: `opaque-commented-password-${"m".repeat(24)}`,
          content: (value: string) => `# DATABASE_URL=postgresql://comment:${value}@db.example.invalid/infinite\n`,
        },
        {
          filename: ".env.example",
          fixtureValue: `opaque-default-password-${"n".repeat(24)}`,
          content: (value: string) =>
            `${servicePasswordKey}=\${${servicePasswordKey}:-${value}}\n`,
        },
        {
          filename: ".env.example",
          fixtureValue: `opaque-inline-comment-password-${"s".repeat(24)}`,
          content: (value: string) =>
            `${authTokenKey}=<placeholder> # old postgresql://archived:${value}@db.example.invalid/infinite\n`,
        },
      ];

      for (const { filename, fixtureValue, content } of publicEnvCases) {
        await writeFile(join(tempRoot, filename), content(fixtureValue));
        expect((await runCommand("git", ["add", "--", filename], tempRoot)).code).toBe(0);

        const result = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
        expect(result.code, `${filename} credential fixture must be rejected`).not.toBe(0);
        const output = `${result.stdout}\n${result.stderr}`;
        expect(output).toContain(filename);
        expect(output).not.toContain(fixtureValue);

        expect((await runCommand("git", ["rm", "--cached", "--force", "--", filename], tempRoot)).code).toBe(0);
        await rm(join(tempRoot, filename), { force: true });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects tracked npmrc credential fields without echoing values", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "infinite-snowball-npmrc-secret-"));
    try {
      expect((await runCommand("git", ["init", "--quiet"], tempRoot)).code).toBe(0);
      const envTokenReference = ["$", "{NPM_TOKEN}"].join("");

      await writeFile(
        join(tempRoot, ".npmrc"),
        [
          "registry=https://registry.npmjs.org/",
          `//registry.npmjs.org/:_authToken=${envTokenReference}`,
          "//registry.npmjs.org/:_password=",
          "",
        ].join("\n"),
      );
      expect((await runCommand("git", ["add", "--", ".npmrc"], tempRoot)).code).toBe(0);
      expect((await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot)).code).toBe(0);

      const npmrcCases = [
        {
          label: "unscoped token",
          fixtureValue: `opaque-npm-token-${"g".repeat(24)}`,
          content: (value: string) => `_authToken=${value}\n`,
        },
        {
          label: "unscoped password",
          fixtureValue: `opaque-npm-password-${"h".repeat(24)}`,
          content: (value: string) => `_password=${value}\n`,
        },
        {
          label: "legacy auth",
          fixtureValue: `opaque-npm-auth-${"l".repeat(24)}`,
          content: (value: string) => `_auth=${value}\n`,
        },
        {
          label: "scoped token",
          fixtureValue: `opaque-scoped-token-${"i".repeat(24)}`,
          content: (value: string) => `//registry.npmjs.org/:_authToken=${value}\n`,
        },
        {
          label: "scoped password",
          fixtureValue: `opaque-scoped-password-${"j".repeat(24)}`,
          content: (value: string) => `//registry.example.invalid/:_password=${value}\n`,
        },
        {
          label: "scoped registry URL userinfo",
          fixtureValue: `opaque-registry-password-${"k".repeat(24)}`,
          content: (value: string) => `@snowball:registry=https://snowball:${value}@registry.example.invalid/\n`,
        },
        {
          label: "commented registry URL userinfo",
          fixtureValue: `opaque-commented-registry-${"o".repeat(24)}`,
          content: (value: string) =>
            `; @snowball:registry=https://snowball:${value}@registry.example.invalid/\n`,
        },
      ];

      for (const { label, fixtureValue, content } of npmrcCases) {
        await writeFile(join(tempRoot, ".npmrc"), content(fixtureValue));
        expect((await runCommand("git", ["add", "--", ".npmrc"], tempRoot)).code).toBe(0);

        const result = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
        expect(result.code, `${label} must be rejected`).not.toBe(0);
        const output = `${result.stdout}\n${result.stderr}`;
        expect(output).toContain(".npmrc");
        expect(output).not.toContain(fixtureValue);

        expect((await runCommand("git", ["rm", "--cached", "--force", "--", ".npmrc"], tempRoot)).code).toBe(0);
      }
      await rm(join(tempRoot, ".npmrc"), { force: true });
      const uppercaseFixture = `opaque-uppercase-npm-auth-${"p".repeat(24)}`;
      await writeFile(join(tempRoot, ".NPMRC"), `_auth=${uppercaseFixture}\n`);
      expect((await runCommand("git", ["add", "--", ".NPMRC"], tempRoot)).code).toBe(0);
      const uppercaseResult = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
      expect(uppercaseResult.code, "case-folded npmrc path must be rejected").not.toBe(0);
      expect(`${uppercaseResult.stdout}\n${uppercaseResult.stderr}`).not.toContain(uppercaseFixture);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("passes when the scanner and its test source are the entire staged set", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "infinite-snowball-scanner-self-check-"));
    try {
      expect((await runCommand("git", ["init", "--quiet"], tempRoot)).code).toBe(0);
      await mkdir(join(tempRoot, "tools", "quality"), { recursive: true });
      await mkdir(join(tempRoot, "tests", "meta"), { recursive: true });
      await copyFile(SCANNER, join(tempRoot, "tools", "quality", "secret-scan.mjs"));
      await copyFile(fileURLToPath(import.meta.url), join(tempRoot, "tests", "meta", "secret-scan.test.ts"));
      expect((await runCommand("git", ["add", "--", "tools/quality/secret-scan.mjs", "tests/meta/secret-scan.test.ts"], tempRoot)).code).toBe(0);

      const result = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
      expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/secret-bearing/i);
      expect(result.code).toBe(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects nested credential directories without printing file contents", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "infinite-snowball-secret-path-"));
    try {
      expect((await runCommand("git", ["init", "--quiet"], tempRoot)).code).toBe(0);
      const credentialDirectory = join(tempRoot, ".ssh");
      const privateKeyPath = join(credentialDirectory, "id_ecdsa");
      const privateKeyFixture = "fixture-private-material-that-must-not-be-printed";
      await mkdir(credentialDirectory);
      await writeFile(privateKeyPath, `${privateKeyFixture}\n`);
      expect((await runCommand("git", ["add", "--", ".ssh/id_ecdsa"], tempRoot)).code).toBe(0);

      const result = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
      expect(result.code).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(".ssh/id_ecdsa");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(privateKeyFixture);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("scans a secret-bearing regular file staged over a symlink type change", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "infinite-snowball-secret-type-change-"));
    try {
      expect((await runCommand("git", ["init", "--quiet"], tempRoot)).code).toBe(0);
      expect((await runCommand("git", ["config", "user.email", "fixture@example.invalid"], tempRoot)).code).toBe(0);
      expect((await runCommand("git", ["config", "user.name", "Infinite Snowball Fixture"], tempRoot)).code).toBe(0);

      await writeFile(join(tempRoot, "safe.txt"), "safe fixture\n");
      await symlink("safe.txt", join(tempRoot, "type-change.txt"));
      expect((await runCommand("git", ["add", "--", "safe.txt", "type-change.txt"], tempRoot)).code).toBe(0);
      expect((await runCommand("git", ["commit", "--quiet", "--no-gpg-sign", "-m", "fixture baseline"], tempRoot)).code).toBe(0);

      await rm(join(tempRoot, "type-change.txt"));
      const fakeOpenAiCredential = `sk-proj-${"b".repeat(32)}`;
      await writeFile(join(tempRoot, "type-change.txt"), `${fakeOpenAiCredential}\n`);
      expect((await runCommand("git", ["add", "--", "type-change.txt"], tempRoot)).code).toBe(0);

      const result = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
      expect(result.code).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("type-change.txt");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(fakeOpenAiCredential);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
