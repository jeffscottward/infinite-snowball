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
function runGitBuffer(args, maxBuffer = 20 * 1024 * 1024) {
  const result = spawnSync("git", args, {
    encoding: null,
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : "";
    const detail = (stderr || "git command failed").trim().split(/\r?\n/u, 1)[0];
    console.error(`Secret scan could not inspect the staged index: ${detail}`);
    process.exit(2);
  }

  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
}

function decodeUtf16BigEndian(buffer) {
  const evenLength = buffer.length - (buffer.length % 2);
  const swapped = Buffer.allocUnsafe(evenLength);
  for (let index = 0; index < evenLength; index += 2) {
    swapped[index] = buffer[index + 1] ?? 0;
    swapped[index + 1] = buffer[index] ?? 0;
  }
  return swapped.toString("utf16le");
}

function decodeStagedContent(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return decodeUtf16BigEndian(buffer.subarray(2));

  const sampleLength = Math.min(buffer.length - (buffer.length % 2), 4_096);
  let evenNulls = 0;
  let oddNulls = 0;
  for (let index = 0; index < sampleLength; index += 2) {
    if (buffer[index] === 0) evenNulls += 1;
    if (buffer[index + 1] === 0) oddNulls += 1;
  }
  const minimumNulls = Math.max(4, Math.floor(sampleLength / 10));
  if (oddNulls >= minimumNulls && oddNulls > evenNulls * 2) return buffer.toString("utf16le");
  if (evenNulls >= minimumNulls && evenNulls > oddNulls * 2) return decodeUtf16BigEndian(buffer);
  return buffer.toString("utf8");
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
  /(?=((?<![A-Za-z0-9_$-])(["'`]?)([A-Za-z_$][A-Za-z0-9_$-]*)\2\s*(?::|\?\?=|\|\|=|&&=|=(?!=|>))\s*(?:"((?:\\.|[^"\\\r\n]){12,})"|'((?:\\.|[^'\\\r\n]){12,})'|`((?:\\.|[^`\\\r\n]){12,})`|([^"'`\s,;}&#]{12,}))))/gu;
const credentialKeyPhrase =
  /(?:^|_)(?:api_key|access_key|access_token|auth_token|password|passwd|secret|token)(?:$|_)/u;
const credentialMetadataSuffix =
  /_(?:url|uri|endpoint|path|filename|file|name|count|limit|ttl(?:_(?:milliseconds?|ms|seconds?|minutes?|hours?|days?))?|type|scan|scanner)$/u;
const npmrcAuthKeyPattern = /(?:^|:)(?:_authToken|_auth|_password)$/iu;

function normalizedPath(filePath) {
  return filePath.replaceAll("\\", "/");
}

function baseNameForPath(filePath) {
  return path.basename(normalizedPath(filePath));
}
function normalizedCredentialKey(rawKey) {
  return rawKey
    .replace(/^["'`]|["'`]$/gu, "")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

function isCredentialAssignmentKey(rawKey) {
  const normalized = normalizedCredentialKey(rawKey);
  return credentialKeyPhrase.test(normalized) && !credentialMetadataSuffix.test(normalized);
}


function isPublicEnvExamplePath(filePath) {
  const baseName = baseNameForPath(filePath);
  return baseName === ".env.example" || baseName === ".env.schema";
}

function isNpmrcPath(filePath) {
  return baseNameForPath(filePath).toLowerCase() === ".npmrc";
}

function parseLineAssignment(line) {
  const trimmed = line.trim().replace(/^(?:#|;)\s*/u, "");
  if (trimmed === "") return undefined;

  const withoutExport = trimmed.replace(/^export\s+/iu, "");
  const separatorIndex = withoutExport.indexOf("=");
  if (separatorIndex < 0) return undefined;

  const key = withoutExport.slice(0, separatorIndex).trim();
  const value = withoutExport.slice(separatorIndex + 1).trim();
  if (key === "") return undefined;
  return { key, value };
}

function stripMatchingQuotes(value) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === `"` && last === `"`) || (first === `'` && last === `'`) || (first === "`" && last === "`")) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function normalizeCandidateValue(rawValue) {
  let value = rawValue.trim();
  const unquotedValue = stripMatchingQuotes(value);
  if (unquotedValue !== value) return unquotedValue;
  value = value.replace(/\s+[;#].*$/u, "").trim();
  return stripMatchingQuotes(value);
}

function normalizedPlaceholderWord(value) {
  return value.toLowerCase().replace(/[\s_.-]+/gu, "-");
}

function isExplicitPlaceholder(rawValue) {
  const value = normalizeCandidateValue(rawValue);
  if (value === "") return true;
  if (/^(?:\$[A-Z_][A-Z0-9_]*|\$\{[A-Z_][A-Z0-9_]*\})$/iu.test(value)) return true;
  if (/^<[^<>\r\n]+>$/.test(value)) return true;
  if (/^\{\{[^{}\r\n]+\}\}$/.test(value)) return true;
  if (/^(?:x{3,}|\*{3,}|-{3,}|\.{3,})$/iu.test(value)) return true;
  if (/^(?:example|placeholder|redacted|changeme|dummy|fixture|sample|fake)(?:[-_\s][A-Z0-9._-]+)*$/iu.test(value)) {
    return true;
  }
  if (/^(?:your|replace)(?:[-_\s]?(?:own|me|with))?[-_\s]?[A-Z0-9._-]+$/iu.test(value)) {
    return true;
  }

  const placeholderWord = normalizedPlaceholderWord(value);
  return [
    "api-key",
    "auth-token",
    "database-url",
    "db-password",
    "db-user",
    "password",
    "passwd",
    "secret",
    "token",
    "user",
    "username",
  ].includes(placeholderWord);
}

function decodeUrlUserinfoPart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function isPlaceholderUrlUserinfoPart(part) {
  const decoded = decodeUrlUserinfoPart(part.trim());
  if (isExplicitPlaceholder(decoded)) return true;
  return /^(?:db[-_]?user|database[-_]?user|user(?:name)?|db[-_]?pass(?:word)?|database[-_]?pass(?:word)?|pass(?:word)?|passwd|token|secret|api[-_]?key)$/iu.test(
    decoded,
  );
}

function hasCredentialBearingUrlUserinfo(rawValue) {
  const value = stripMatchingQuotes(rawValue.trim());
  for (const match of value.matchAll(/[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/\s?#@]+)@/gu)) {
    const userinfo = match[1] ?? "";
    if (userinfo === "") continue;
    if (userinfo.split(":").some((part) => part !== "" && !isPlaceholderUrlUserinfoPart(part))) {
      return true;
    }
  }
  return false;
}

function pathAwareLineFindings(filePath, line) {
  const assignment = parseLineAssignment(line);
  if (!assignment) return [];

  const findingsForLine = [];
  if ((isPublicEnvExamplePath(filePath) || isNpmrcPath(filePath)) && hasCredentialBearingUrlUserinfo(assignment.value)) {
    findingsForLine.push("credential-bearing URL userinfo");
  }

  if (isPublicEnvExamplePath(filePath) && isCredentialAssignmentKey(assignment.key) && !isExplicitPlaceholder(assignment.value)) {
    findingsForLine.push("credential-like assignment");
  }

  if (isNpmrcPath(filePath) && npmrcAuthKeyPattern.test(assignment.key) && !isExplicitPlaceholder(assignment.value)) {
    findingsForLine.push("npmrc credential assignment");
  }

  return findingsForLine;
}

const LEX_CODE = 0;
const LEX_SINGLE_QUOTE = 1;
const LEX_DOUBLE_QUOTE = 2;
const LEX_TEMPLATE = 3;
const LEX_TEMPLATE_CODE = 4;
const LEX_LINE_COMMENT = 5;
const LEX_BLOCK_COMMENT = 6;
const LEX_REGEX = 7;

function isSourceCodePath(filePath) {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/iu.test(normalizedPath(filePath));
}

function isCodeLexicalMode(mode) {
  return mode === LEX_CODE || mode === LEX_TEMPLATE_CODE;
}

function isRegexLiteralStart(content, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/u.test(content[cursor] ?? "")) cursor -= 1;
  if (cursor < 0) return true;
  return "=(:,![{;?&|}".includes(content[cursor] ?? "");
}

function classifyLexicalContexts(content) {
  const contexts = new Uint8Array(content.length);
  const resumeModes = [];
  const templateDepths = [];
  let mode = LEX_CODE;
  let regexCharacterClass = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] ?? "";
    const next = content[index + 1] ?? "";
    contexts[index] = mode;

    if (mode === LEX_SINGLE_QUOTE || mode === LEX_DOUBLE_QUOTE) {
      if (character === "\\") {
        if (index + 1 < content.length) {
          contexts[index + 1] = mode;
          index += 1;
        }
      } else if (
        (mode === LEX_SINGLE_QUOTE && character === "'") ||
        (mode === LEX_DOUBLE_QUOTE && character === '"')
      ) {
        mode = resumeModes.pop() ?? LEX_CODE;
      }
      continue;
    }

    if (mode === LEX_TEMPLATE) {
      if (character === "\\") {
        if (index + 1 < content.length) {
          contexts[index + 1] = mode;
          index += 1;
        }
      } else if (character === "`") {
        mode = resumeModes.pop() ?? LEX_CODE;
      } else if (character === "$" && next === "{") {
        contexts[index + 1] = mode;
        index += 1;
        templateDepths.push(1);
        mode = LEX_TEMPLATE_CODE;
      }
      continue;
    }

    if (mode === LEX_LINE_COMMENT) {
      if (character === "\n") mode = resumeModes.pop() ?? LEX_CODE;
      continue;
    }

    if (mode === LEX_BLOCK_COMMENT) {
      if (character === "*" && next === "/") {
        contexts[index + 1] = mode;
        index += 1;
        mode = resumeModes.pop() ?? LEX_CODE;
      }
      continue;
    }

    if (mode === LEX_REGEX) {
      if (character === "\\") {
        if (index + 1 < content.length) {
          contexts[index + 1] = mode;
          index += 1;
        }
      } else if (character === "[") {
        regexCharacterClass = true;
      } else if (character === "]") {
        regexCharacterClass = false;
      } else if (character === "/" && !regexCharacterClass) {
        mode = resumeModes.pop() ?? LEX_CODE;
      }
      continue;
    }

    if (character === "/" && next === "/") {
      contexts[index + 1] = mode;
      index += 1;
      resumeModes.push(mode);
      mode = LEX_LINE_COMMENT;
      continue;
    }
    if (character === "/" && next === "*") {
      contexts[index + 1] = mode;
      index += 1;
      resumeModes.push(mode);
      mode = LEX_BLOCK_COMMENT;
      continue;
    }
    if (character === "/" && isRegexLiteralStart(content, index)) {
      resumeModes.push(mode);
      mode = LEX_REGEX;
      regexCharacterClass = false;
      continue;
    }
    if (character === "'" || character === '"') {
      resumeModes.push(mode);
      mode = character === "'" ? LEX_SINGLE_QUOTE : LEX_DOUBLE_QUOTE;
      continue;
    }
    if (character === "`") {
      resumeModes.push(mode);
      mode = LEX_TEMPLATE;
      continue;
    }
    if (mode === LEX_TEMPLATE_CODE && character === "{") {
      const depthIndex = templateDepths.length - 1;
      templateDepths[depthIndex] = (templateDepths[depthIndex] ?? 0) + 1;
      continue;
    }
    if (mode === LEX_TEMPLATE_CODE && character === "}") {
      const depthIndex = templateDepths.length - 1;
      const nextDepth = (templateDepths[depthIndex] ?? 1) - 1;
      if (nextDepth === 0) {
        templateDepths.pop();
        mode = LEX_TEMPLATE;
      } else {
        templateDepths[depthIndex] = nextDepth;
      }
    }
  }

  return contexts;
}

function isPureCodeMemberReference(rawValue) {
  const value = normalizeCandidateValue(rawValue);
  return /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*$/u.test(value);
}

function isPureCodeMemberInterpolation(rawValue) {
  const value = normalizeCandidateValue(rawValue);
  return /^\$\{[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*\}?$/u.test(value);
}

function isSafeCodeRhsBoundary(content, startIndex) {
  let index = startIndex;
  let crossedLine = false;

  while (index < content.length) {
    const character = content[index] ?? "";
    const next = content[index + 1] ?? "";
    if (character === " " || character === "\t" || character === "\f") {
      index += 1;
      continue;
    }
    if (character === "\r" || character === "\n") {
      crossedLine = true;
      index += character === "\r" && next === "\n" ? 2 : 1;
      continue;
    }
    if (character === "/" && next === "/") {
      const newlineIndex = content.indexOf("\n", index + 2);
      if (newlineIndex < 0) return true;
      crossedLine = true;
      index = newlineIndex + 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const commentEnd = content.indexOf("*/", index + 2);
      if (commentEnd < 0) return false;
      if (/[\r\n]/u.test(content.slice(index, commentEnd + 2))) crossedLine = true;
      index = commentEnd + 2;
      continue;
    }
    break;
  }

  if (index >= content.length) return true;
  const nextCharacter = content[index] ?? "";
  if (",;})]".includes(nextCharacter)) return true;
  if (!crossedLine) return false;
  if (".?![(`+-*/%<>=&|^,:".includes(nextCharacter)) return false;
  if (/^(?:as|in|instanceof|satisfies)\b/u.test(content.slice(index))) return false;
  return true;
}

function isSafeRuntimeReference(content, contexts, value, valueStart, valueEnd, matchedText) {
  if (
    isPureCodeMemberReference(value) &&
    isCodeLexicalMode(contexts[valueStart]) &&
    isSafeCodeRhsBoundary(content, valueEnd)
  ) {
    return true;
  }

  const capturedClosingBrace = value.endsWith("}");
  const closingBraceIndex = capturedClosingBrace ? valueEnd - 1 : valueEnd;
  if (
    isPureCodeMemberInterpolation(value) &&
    contexts[valueStart] === LEX_TEMPLATE &&
    contexts[valueStart + 2] === LEX_TEMPLATE_CODE &&
    content[closingBraceIndex] === "}"
  ) {
    if (/[:=]\s*`\$\{/u.test(matchedText) && content[closingBraceIndex + 1] === "`") {
      return isSafeCodeRhsBoundary(content, closingBraceIndex + 2);
    }
    const templateValueEnd = content[closingBraceIndex + 1] ?? "";
    return templateValueEnd === "`" || templateValueEnd === "&" || templateValueEnd === "#";
  }

  return false;
}

function isSafeExplicitPlaceholder(content, contexts, sourceCode, value, valueStart, valueEnd) {
  let candidate = value;
  let candidateEnd = valueEnd;
  if (value.startsWith("${") && !value.endsWith("}") && content[candidateEnd] === "}") {
    candidate += "}";
    candidateEnd += 1;
  }
  if (!isExplicitPlaceholder(candidate)) return false;

  if (!sourceCode) {
    const tail = content.slice(candidateEnd).split(/\r?\n/u, 1)[0] ?? "";
    return /^\s*(?:["'`]\s*)?(?:[,;})\]&#]|$)/u.test(tail);
  }

  const mode = contexts[valueStart];
  if (isCodeLexicalMode(mode)) return isSafeCodeRhsBoundary(content, candidateEnd);
  if (mode === LEX_SINGLE_QUOTE || mode === LEX_DOUBLE_QUOTE) {
    const closingQuote = mode === LEX_SINGLE_QUOTE ? "'" : '"';
    return content[candidateEnd] === closingQuote && isSafeCodeRhsBoundary(content, candidateEnd + 1);
  }
  if (mode === LEX_TEMPLATE) {
    const nextCharacter = content[candidateEnd] ?? "";
    return nextCharacter === "`" || nextCharacter === "&" || nextCharacter === "#";
  }
  return false;
}

function genericCredentialAssignment(filePath, line, content, lineStart, contexts) {
  const sourceCode = isSourceCodePath(filePath);
  for (const match of line.matchAll(credentialAssignmentPattern)) {
    const matchedText = match[1] ?? "";
    const key = match[3];
    const value = match[4] ?? match[5] ?? match[6] ?? match[7];
    if (!key || !value || !isCredentialAssignmentKey(key)) continue;
    const relativeValueStart = matchedText.lastIndexOf(value);
    const valueStart = lineStart + (match.index ?? 0) + relativeValueStart;
    const valueEnd = valueStart + value.length;
    const isRuntimeReference =
      sourceCode && contexts !== undefined && isSafeRuntimeReference(content, contexts, value, valueStart, valueEnd, matchedText);
    const isPlaceholder =
      contexts !== undefined &&
      isSafeExplicitPlaceholder(content, contexts, sourceCode, value, valueStart, valueEnd);
    if (!isRuntimeReference && !isPlaceholder) return true;
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

  const content = decodeStagedContent(runGitBuffer(["show", `:0:${filePath}`], 10 * 1024 * 1024));
  const lines = content.split(/\r?\n/);
  const contexts = isSourceCodePath(filePath) ? classifyLexicalContexts(content) : new Uint8Array(content.length);
  const lineStarts = [0];
  for (const newline of content.matchAll(/\r?\n/gu)) {
    lineStarts.push((newline.index ?? 0) + newline[0].length);
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const [kind, pattern] of fixedSecretPatterns) {
      if (pattern.test(line)) findings.push({ filePath, line: index + 1, kind });
    }
    for (const kind of pathAwareLineFindings(filePath, line)) {
      findings.push({ filePath, line: index + 1, kind });
    }
    if (genericCredentialAssignment(filePath, line, content, lineStarts[index] ?? 0, contexts)) {
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
