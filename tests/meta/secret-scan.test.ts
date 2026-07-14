import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SCANNER = join(ROOT, "tools", "quality", "secret-scan.mjs");

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

      const fakeToken = `npm_${"a".repeat(32)}`;
      await writeFile(join(tempRoot, "notes.txt"), `token=${fakeToken}\n`);
      expect((await runCommand("git", ["add", "--", "notes.txt"], tempRoot)).code).toBe(0);
      const riskyValue = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
      expect(riskyValue.code).not.toBe(0);
      expect(`${riskyValue.stdout}\n${riskyValue.stderr}`).not.toContain(fakeToken);

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

      const fakeQuotedPassword = `opaque-credential-${"d".repeat(24)}`;
      const quotedPasswordKey = ["pass", "word"].join("");
      await writeFile(join(tempRoot, "quoted.json"), `${JSON.stringify({ [quotedPasswordKey]: fakeQuotedPassword })}\n`);
      expect((await runCommand("git", ["add", "--", "quoted.json"], tempRoot)).code).toBe(0);
      const riskyQuotedCredential = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
      expect(riskyQuotedCredential.code).not.toBe(0);
      expect(`${riskyQuotedCredential.stdout}\n${riskyQuotedCredential.stderr}`).not.toContain(fakeQuotedPassword);
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
      const fakeOpenAiToken = `sk-proj-${"b".repeat(32)}`;
      await writeFile(join(tempRoot, "type-change.txt"), `${fakeOpenAiToken}\n`);
      expect((await runCommand("git", ["add", "--", "type-change.txt"], tempRoot)).code).toBe(0);

      const result = await runCommand(process.execPath, [SCANNER, "--staged"], tempRoot);
      expect(result.code).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("type-change.txt");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(fakeOpenAiToken);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
