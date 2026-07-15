#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const nonEnvironmentPathspecs = [
  ":(glob)**/.omp-sessions/**",
  ":(glob)**/.omp-runs/**",
  ":(glob)**/.omp-workarounds/**",
  ":(glob).omp-status.md",
  ":(glob)**/.planning/ultra-root-output.jsonl",
  ":(glob)**/.planning/ultra-root-prompt.md",
  ":(glob)**/.planning/ultra-root-exit.json",
  ":(glob)**/node_modules/**",
  ":(glob)**/.pnpm-store/**",
  ":(glob)**/dist/**",
  ":(glob)**/coverage/**",
  ":(glob)**/playwright-report/**",
  ":(glob)**/test-results/**",
  ":(glob)**/*.tsbuildinfo",
  ":(glob)**/*.log",
  ":(glob)**/*.log.*",
  ":(glob)**/logs/**",
  ":(glob)**/.logs/**",
  ":(glob)**/tmp/**",
  ":(glob)**/.tmp/**",
  ":(glob)**/.npmrc.local",
  ":(glob)**/.netrc",
  ":(glob)**/.pypirc",
  ":(glob)**/.aws/**",
  ":(glob)**/.docker/**",
  ":(glob)**/.gnupg/**",
  ":(glob)**/.ssh/**",
  ":(glob)**/credentials/**",
  ":(glob)**/.credentials/**",
  ":(glob)**/credentials.*",
  ":(glob)**/*.credentials",
  ":(glob)**/*.pem",
  ":(glob)**/*.key",
  ":(glob)**/*.jks",
  ":(glob)**/*.kdbx",
  ":(glob)**/*.keystore",
  ":(glob)**/*.p12",
  ":(glob)**/*.pfx",
  ":(glob)**/id_dsa*",
  ":(glob)**/id_ecdsa*",
  ":(glob)**/id_rsa*",
  ":(glob)**/id_ed25519*",
  ":(glob)**/secrets.*",
  ":(glob)**/.DS_Store",
];

const environmentPathspecs = [
  ":(glob)**/.env",
  ":(glob)**/.env.*",
  ":(exclude,glob)**/.env.example",
  ":(exclude,glob)**/.env.schema",
];

function listTrackedPaths(pathspecs) {
  const result = spawnSync("git", ["ls-files", "-z", "--", ...pathspecs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error || result.status !== 0) {
    console.error("Forbidden tracked-path audit could not inspect the Git index.");
    process.exit(2);
  }
  return result.stdout.split("\0").filter(Boolean);
}

const forbiddenTrackedPaths = [
  ...new Set([...listTrackedPaths(nonEnvironmentPathspecs), ...listTrackedPaths(environmentPathspecs)]),
].sort();
if (forbiddenTrackedPaths.length > 0) {
  console.error(
    `Forbidden tracked-path audit blocked ${forbiddenTrackedPaths.length} tracked path${forbiddenTrackedPaths.length === 1 ? "" : "s"}:`,
  );
  for (const filePath of forbiddenTrackedPaths) {
    console.error(`- ${filePath}`);
  }
  process.exit(1);
}

console.log("Forbidden tracked-path audit passed.");
