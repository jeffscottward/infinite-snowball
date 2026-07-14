#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { basename, isAbsolute } from "node:path";

const EXPECTED_PNPM_VERSION = "11.13.0";
const requestedArgs = process.argv.slice(2);

function fail(message) {
  console.error(`Audited pnpm runner: ${message}`);
  process.exit(2);
}

if (requestedArgs.length === 0) {
  fail("at least one pnpm argument is required.");
}

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  fail("npm_execpath is required; ambient package-manager fallback is prohibited.");
}
if (!isAbsolute(npmExecPath)) {
  fail("npm_execpath must be an absolute audited pnpm path.");
}

const executableName = basename(npmExecPath).toLowerCase();
if (!/^pnpm(?:\.exe|\.(?:c|m)?js)?$/.test(executableName)) {
  fail("npm_execpath must identify a recognized pnpm entry.");
}

const isJavaScriptEntry = /\.(?:c|m)?js$/.test(executableName);
const command = isJavaScriptEntry ? process.execPath : npmExecPath;
const argsPrefix = isJavaScriptEntry ? [npmExecPath] : [];
const versionResult = spawnSync(command, [...argsPrefix, "--version"], {
  encoding: "utf8",
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

if (versionResult.error || versionResult.status !== 0) {
  fail("the audited pnpm entry could not report its version.");
}
if (versionResult.stdout.trim() !== EXPECTED_PNPM_VERSION) {
  fail(`expected exactly pnpm ${EXPECTED_PNPM_VERSION}.`);
}

const result = spawnSync(command, [...argsPrefix, ...requestedArgs], {
  env: process.env,
  stdio: "inherit",
});
if (result.error || result.status === null) {
  fail("the audited pnpm command could not complete.");
}
process.exit(result.status);
