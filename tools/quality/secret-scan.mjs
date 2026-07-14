#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { posix as path } from "node:path";

const argumentsList = process.argv.slice(2);
if (argumentsList.length !== 1 || argumentsList[0] !== "--staged") {
  console.error("Usage: node tools/quality/secret-scan.mjs --staged");
  process.exit(2);
}

function runGit(args, maxBuffer = 20 * 1024 * 1024) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const detail = (result.stderr || "git command failed").trim().split(/\r?\n/, 1)[0];
    console.error(`Secret scan could not inspect the staged index: ${detail}`);
    process.exit(2);
  }

  return result.stdout;
}

const auditedSecretScannerPaths = new Set([
  "tests/meta/secret-scan.test.ts",
  "tools/quality/secret-scan.mjs",
]);

function riskyPathReason(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  if (auditedSecretScannerPaths.has(normalized)) return undefined;
  const baseName = path.basename(normalized);
  if (/^\.env(?:\.|$)/i.test(baseName) && baseName !== ".env.example" && baseName !== ".env.schema") {
    return "local environment file";
  }
  if (/^(?:\.npmrc\.local|\.netrc|\.pypirc)$/i.test(baseName)) return "local credential file";
  if (/(?:^|\/)\.(?:aws|docker|gnupg|ssh)(?:\/|$)/i.test(normalized)) return "local credential directory";
  if (/^(?:credentials?|secrets?)(?:[._-]|$)/i.test(baseName)) return "credential-named file";
  if (/^id_(?:dsa|ecdsa|ed25519|rsa)(?:\.pub)?$/i.test(baseName)) return "SSH key file";
  if (/\.(?:jks|kdbx|key|keystore|p12|pfx|pem)$/i.test(baseName)) return "private key or credential bundle";
  return undefined;
}

const fixedSecretPatterns = [
  ["private key material", /-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ["GitLab personal access token", /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ["npm token", /\bnpm_[A-Za-z0-9]{20,}\b/],
  ["OpenAI API key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/],
  ["SendGrid API key", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["Stripe live secret key", /\b(?:rk|sk)_live_[A-Za-z0-9]{20,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
];

const credentialAssignmentPattern =
  /(?<![A-Za-z0-9_-])["'`]?(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?(?:key|token)|auth[_-]?token|password|passwd|secret|token)(?:[_-][A-Za-z0-9]+)*["'`]?\s*[:=]\s*["'`]?([^"'`\s,;}]{12,})/giu;

function genericCredentialAssignment(line) {
  for (const match of line.matchAll(credentialAssignmentPattern)) {
    const value = match[1];
    if (value && !/^(?:\$|<|\{\{|example|placeholder|redacted|changeme|dummy|fixture|process\.env|import\.meta\.env)/i.test(value)) {
      return true;
    }
  }
  return false;
}

const stagedNames = runGit(["diff", "--cached", "--name-only", "-z", "--diff-filter=d", "--", "."])
  .split("\0")
  .filter(Boolean);
const findings = [];

for (const filePath of stagedNames) {
  const pathReason = riskyPathReason(filePath);
  if (pathReason) findings.push({ filePath, line: 0, kind: pathReason });

  const content = runGit(["show", `:${filePath}`], 10 * 1024 * 1024);
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const [kind, pattern] of fixedSecretPatterns) {
      if (pattern.test(line)) findings.push({ filePath, line: index + 1, kind });
    }
    if (genericCredentialAssignment(line)) {
      findings.push({ filePath, line: index + 1, kind: "credential-like assignment" });
    }
  }
}

if (findings.length > 0) {
  console.error(`Secret scan blocked ${findings.length} staged finding${findings.length === 1 ? "" : "s"}:`);
  for (const finding of findings) {
    const location = finding.line > 0 ? `${finding.filePath}:${finding.line}` : finding.filePath;
    console.error(`- ${location} [${finding.kind}]`);
  }
  process.exit(1);
}

console.log(`Secret scan passed for ${stagedNames.length} staged file${stagedNames.length === 1 ? "" : "s"}.`);
