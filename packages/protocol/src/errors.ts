import { z } from "zod/mini";

import { VALIDATOR_VERSION } from "./version.js";

export const ERROR_CODES = [
  "E_CACHE_WRITE",
  "E_CATALOG_STALE",
  "E_CODEC_UNSUPPORTED",
  "E_CODE_FORBIDDEN",
  "E_DAG_CYCLE",
  "E_DEPENDENCY_EXACT",
  "E_ENGINE_RANGE",
  "E_FILE_BUDGET",
  "E_GLB_REFERENCE",
  "E_HASH_MISMATCH",
  "E_LICENSE_POLICY",
  "E_LOCK_MISMATCH",
  "E_MIGRATION",
  "E_MIME_MISMATCH",
  "E_NPM_PROVENANCE",
  "E_OFFLINE_MISSING_ASSET",
  "E_OPTIONAL_PEER_CONFLICT",
  "E_PACKAGE_WITHDRAWN",
  "E_PATH_POLICY",
  "E_PRIVACY_EGRESS",
  "E_QUOTA",
  "E_SAVE_EXPORT_INTEGRITY",
  "E_SAVE_EXPORT_SIZE",
  "E_SAVE_EXPORT_VERSION",
  "E_SCHEMA_STRICT",
  "E_TRANSACTION_STATE",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const MAX_VALIDATION_ISSUES = 32;
export const MAX_VALIDATION_TEXT_LENGTH = 160;

const MAX_SANITIZED_DEPTH = 4;
const MAX_SANITIZED_NODES = 256;
const MAX_SANITIZED_ARRAY_ITEMS = 20;
const MAX_SANITIZED_OBJECT_PROPERTIES = 30;
const SENSITIVE_KEY = /(?:token|password|passwd|secret|credential|authorization|bearer|cookie|session|api[_-]?key|access[_-]?key|private[_-]?key|signature)/i;
const SENSITIVE_INLINE_VALUE =
  /((?:token|password|passwd|secret|credential|authorization|bearer|cookie|session|api[_-]?key|access[_-]?key|private[_-]?key|signature)[^/=:]{0,32}[/=:])[^/\s,;"']+/gi;
const AUTHORIZATION_HEADER_VALUE =
  /(authorization\s*[:=]\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s+)[^\r\n]+/gi;
const STANDALONE_BEARER_VALUE = /(\bbearer\s+)[^\s,;"']+/gi;
const URL_CANDIDATE =
  /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:(?!\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s"'<>])+/gi;

export interface ValidationIssue {
  ruleId: ErrorCode;
  path: string;
  assetId?: string;
  package?: string;
  observed: unknown;
  allowed: unknown;
  validatorVersion: typeof VALIDATOR_VERSION;
  remediation: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T; issues: [] }
  | { ok: false; issues: ValidationIssue[] };

const BoundedIssueTextSchema = z
  .string()
  .check(z.minLength(1))
  .check(z.maxLength(MAX_VALIDATION_TEXT_LENGTH + 1));

export const ValidationIssueSchema = z.strictObject({
  ruleId: ErrorCodeSchema,
  path: BoundedIssueTextSchema,
  assetId: z.optional(BoundedIssueTextSchema),
  package: z.optional(BoundedIssueTextSchema),
  observed: z.unknown(),
  allowed: z.unknown(),
  validatorVersion: z.literal(VALIDATOR_VERSION),
  remediation: BoundedIssueTextSchema,
});

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedText(value: string): string {
  return value.length > MAX_VALIDATION_TEXT_LENGTH
    ? `${value.slice(0, MAX_VALIDATION_TEXT_LENGTH)}…`
    : value;
}

function safeString(value: unknown): string {
  try {
    return typeof value === "string" ? value : String(value);
  } catch {
    return "[UNINSPECTABLE]";
  }
}

function redactUrlCandidate(value: string): string {
  try {
    const url = new URL(value);
    let redacted = url.search !== "" || url.hash !== "";
    if (url.username !== "" || url.password !== "") {
      url.username = "";
      url.password = "";
      redacted = true;
    }
    url.search = "";
    url.hash = "";
    return `${url.toString()}${redacted ? "#[REDACTED]" : ""}`;
  } catch {
    return "[REDACTED INVALID URL]";
  }
}

function sanitizeString(value: string, key: string): string {
  const boundedKey = boundedText(key);
  if (SENSITIVE_KEY.test(boundedKey)) return "[REDACTED]";

  const sanitized = boundedText(value)
    .replace(URL_CANDIDATE, redactUrlCandidate)
    .replace(AUTHORIZATION_HEADER_VALUE, "$1[REDACTED]")
    .replace(STANDALONE_BEARER_VALUE, "$1[REDACTED]")
    .replace(SENSITIVE_INLINE_VALUE, "$1[REDACTED]");
  return boundedText(sanitized);
}

function sanitizePropertyKey(value: string): string {
  const bounded = boundedText(value);
  if (SENSITIVE_KEY.test(bounded)) return "[REDACTED KEY]";
  return sanitizeString(bounded, "propertyKey");
}

interface SanitizationState {
  nodes: number;
  seen: WeakSet<object>;
}

function sanitizeObservedValue(
  value: unknown,
  key: string,
  depth: number,
  state: SanitizationState,
): unknown {
  const boundedKey = boundedText(key);
  if (SENSITIVE_KEY.test(boundedKey)) return "[REDACTED]";
  state.nodes += 1;
  if (state.nodes > MAX_SANITIZED_NODES || depth >= MAX_SANITIZED_DEPTH) {
    return "[TRUNCATED]";
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : safeString(value);
  if (typeof value === "string") return sanitizeString(value, boundedKey);
  if (typeof value !== "object") return sanitizeString(safeString(value), boundedKey);
  if (state.seen.has(value)) return "[CIRCULAR]";
  state.seen.add(value);

  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return "[UNINSPECTABLE]";
  }
  if (isArray) {
    try {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number"
      ) {
        return "[UNINSPECTABLE]";
      }
      const limit = Math.min(lengthDescriptor.value, MAX_SANITIZED_ARRAY_ITEMS);
      const descriptors = Array.from({ length: limit }, (_, index) =>
        Object.getOwnPropertyDescriptor(value, String(index)),
      );
      const output: unknown[] = [];
      let tupleValueKey = boundedKey;
      if (lengthDescriptor.value === 2) {
        const headerDescriptor = descriptors[0];
        if (headerDescriptor === undefined || !("value" in headerDescriptor)) {
          tupleValueKey = "authorization";
        } else if (
          typeof headerDescriptor.value === "string" &&
          SENSITIVE_KEY.test(boundedText(headerDescriptor.value))
        ) {
          tupleValueKey = headerDescriptor.value;
        }
      }
      for (let index = 0; index < limit; index += 1) {
        const descriptor = descriptors[index];
        output.push(
          descriptor === undefined
            ? undefined
            : "value" in descriptor
              ? sanitizeObservedValue(
                  descriptor.value,
                  index === 1 ? tupleValueKey : boundedKey,
                  depth + 1,
                  state,
                )
              : "[REDACTED ACCESSOR]",
        );
      }
      if (lengthDescriptor.value > MAX_SANITIZED_ARRAY_ITEMS && output.length > 0) {
        output[output.length - 1] = "[TRUNCATED]";
      }
      return output;
    } catch {
      return "[UNINSPECTABLE]";
    }
  }

  const sampled: Array<[string, unknown]> = [];
  try {
    for (const entryKey in value) {
      if (!Object.hasOwn(value, entryKey)) continue;
      if (sampled.length >= MAX_SANITIZED_OBJECT_PROPERTIES) break;
      const descriptor = Object.getOwnPropertyDescriptor(value, entryKey);
      const child =
        descriptor === undefined || !("value" in descriptor)
          ? "[REDACTED ACCESSOR]"
          : sanitizeObservedValue(descriptor.value, entryKey, depth + 1, state);
      sampled.push([sanitizePropertyKey(entryKey), child]);
    }
  } catch {
    return "[UNINSPECTABLE]";
  }

  sampled.sort(([left], [right]) => compareOrdinal(left, right));
  const output = Object.create(null) as Record<string, unknown>;
  for (const [entryKey, child] of sampled) {
    if (!Object.hasOwn(output, entryKey)) output[entryKey] = child;
  }
  return output;
}

export function sanitizeObserved(value: unknown, key = "", depth = 0): unknown {
  return sanitizeObservedValue(value, key, depth, {
    nodes: 0,
    seen: new WeakSet<object>(),
  });
}

function sanitizeMetadata(value: unknown, key: string): string {
  return sanitizeString(safeString(value), key);
}

export function validationIssue(input: {
  ruleId: ErrorCode;
  path: string;
  observed: unknown;
  allowed: unknown;
  remediation: string;
  assetId?: string | undefined;
  package?: string | undefined;
}): ValidationIssue {
  const issue: ValidationIssue = {
    ruleId: ErrorCodeSchema.safeParse(input.ruleId).success ? input.ruleId : "E_SCHEMA_STRICT",
    path: sanitizeMetadata(input.path, "path"),
    observed: sanitizeObserved(input.observed),
    allowed: sanitizeObserved(input.allowed),
    validatorVersion: VALIDATOR_VERSION,
    remediation: sanitizeMetadata(input.remediation, "remediation"),
  };
  if (input.assetId !== undefined) issue.assetId = sanitizeMetadata(input.assetId, "assetId");
  if (input.package !== undefined) issue.package = sanitizeMetadata(input.package, "package");
  return issue;
}

export function canonicalizeValidationIssues(
  issues: readonly ValidationIssue[],
): ValidationIssue[] {
  const bounded: ValidationIssue[] = [];
  for (let index = 0; index < Math.min(issues.length, MAX_VALIDATION_ISSUES); index += 1) {
    const issue = issues[index];
    if (issue === undefined) continue;
    bounded.push(
      validationIssue({
        ruleId: issue.ruleId,
        path: issue.path,
        observed: issue.observed,
        allowed: issue.allowed,
        remediation: issue.remediation,
        assetId: issue.assetId,
        package: issue.package,
      }),
    );
  }
  return bounded.sort((left, right) =>
    compareOrdinal(
      [left.ruleId, left.path, left.assetId ?? "", left.package ?? ""].join("\u0000"),
      [right.ruleId, right.path, right.assetId ?? "", right.package ?? ""].join("\u0000"),
    ),
  );
}

export function validationFailure<T = never>(issues: ValidationIssue[]): ValidationResult<T> {
  return {
    ok: false,
    issues: canonicalizeValidationIssues(issues),
  };
}

export function validationSuccess<T>(value: T): ValidationResult<T> {
  return { ok: true, value, issues: [] };
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value === null || typeof value !== "object") return value;

  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value).sort(([left], [right]) =>
    compareOrdinal(left, right),
  )) {
    output[key] = canonicalize(child);
  }
  return output;
}

export function formatValidationResult(result: ValidationResult<unknown>): string {
  const output = result.ok
    ? { issues: [], ok: true }
    : { issues: canonicalizeValidationIssues(result.issues), ok: false };
  return `${JSON.stringify(canonicalize(output), null, 2)}\n`;
}
