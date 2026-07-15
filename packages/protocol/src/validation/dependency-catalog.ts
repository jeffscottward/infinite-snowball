import {
  validationFailure,
  validationIssue,
  validationSuccess,
  type ValidationResult,
} from "../errors.js";
import {
  ExactSemverSchema,
  PackageNameSchema,
  PackageRefSchema,
  StableIdSchema,
  TimestampSchema,
} from "../schema/common.js";
import type { ContentKind } from "../version.js";


const MAX_GRAPH_PACKAGES = 1_024;
const MAX_PACKAGE_DEPENDENCIES = 256;

function plainDataRecord(
  value: unknown,
  maximumProperties: number,
): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length > maximumProperties) return undefined;
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return undefined;
      }
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

function plainDataArray(
  value: unknown,
  maximumLength: number,
): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maximumLength
    ) {
      return undefined;
    }
    const length = lengthDescriptor.value as number;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== length + 1 ||
      !ownKeys.every((key) =>
        key === "length" ||
        (typeof key === "string" &&
          /^(?:0|[1-9]\d*)$/.test(key) &&
          Number(key) < length)
      )
    ) {
      return undefined;
    }
    const output: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return undefined;
      }
      output.push(descriptor.value);
    }
    return output;
  } catch {
    return undefined;
  }
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isExactDependencyRef(value: unknown): value is DependencyRefInput {
  const candidate = plainDataRecord(value, 2);
  return (
    candidate !== undefined &&
    hasOnlyKeys(candidate, ["name", "version"]) &&
    PackageNameSchema.safeParse(candidate.name).success &&
    ExactSemverSchema.safeParse(candidate.version).success
  );
}

function strictDependencyRef(value: unknown): DependencyRefInput | undefined {
  const candidate = plainDataRecord(value, 2);
  if (
    candidate === undefined ||
    !hasOnlyKeys(candidate, ["name", "version"]) ||
    !PackageNameSchema.safeParse(candidate.name).success ||
    !ExactSemverSchema.safeParse(candidate.version).success
  ) {
    return undefined;
  }
  return { name: candidate.name as string, version: candidate.version as string };
}

function strictDependencyRefs(value: unknown): DependencyRefInput[] | undefined {
  const values = plainDataArray(value, MAX_PACKAGE_DEPENDENCIES);
  if (values === undefined) return undefined;
  const output: DependencyRefInput[] = [];
  for (const value of values) {
    const dependency = strictDependencyRef(value);
    if (dependency === undefined) return undefined;
    output.push(dependency);
  }
  return output;
}

export interface DependencyRefInput {
  name: string;
  version: string;
}

export interface DependencyPackageInput extends DependencyRefInput {
  dependencies: DependencyRefInput[];
  optionalPeers?: DependencyRefInput[];
}

export interface DependencyGraphInput {
  root: string;
  packages: DependencyPackageInput[];
}

export interface DependencyGraphValue {
  order: string[];
}

function dependencyKey(value: DependencyRefInput): string {
  return `${value.name}@${value.version}`;
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function validateDependencyGraph(input: unknown): ValidationResult<DependencyGraphValue> {
  const graph = plainDataRecord(input, 2);
  const packagesInput = plainDataArray(graph?.packages, MAX_GRAPH_PACKAGES);
  if (
    graph === undefined ||
    !hasOnlyKeys(graph, ["root", "packages"]) ||
    packagesInput === undefined ||
    packagesInput.length === 0
  ) {
    return validationFailure([
      validationIssue({
        ruleId: "E_DEPENDENCY_EXACT",
        path: "/packages",
        observed:
          packagesInput === undefined
            ? "malformed package array"
            : { packageCount: packagesInput.length },
        allowed: `1 through ${MAX_GRAPH_PACKAGES} exact package rows in one strict graph`,
        remediation: "Provide one bounded exact resolved package graph without unknown fields.",
      }),
    ]);
  }

  const packages: DependencyPackageInput[] = [];
  const packageByKey = new Map<string, DependencyPackageInput>();
  for (const [index, rawItem] of packagesInput.entries()) {
    const record = plainDataRecord(rawItem, 4);
    const dependenciesInput = record?.dependencies;
    const optionalPeersInput = record?.optionalPeers;
    const rowShapeIsStrict =
      record !== undefined &&
      hasOnlyKeys(record, ["name", "version", "dependencies"], ["optionalPeers"]) &&
      PackageNameSchema.safeParse(record.name).success &&
      ExactSemverSchema.safeParse(record.version).success;
    const dependencies = strictDependencyRefs(dependenciesInput);
    const optionalPeers =
      optionalPeersInput === undefined
        ? undefined
        : strictDependencyRefs(optionalPeersInput);

    if (
      !rowShapeIsStrict ||
      dependencies === undefined ||
      (optionalPeersInput !== undefined && optionalPeers === undefined)
    ) {
      const packageId =
        record !== undefined &&
        PackageNameSchema.safeParse(record.name).success &&
        ExactSemverSchema.safeParse(record.version).success
          ? `${String(record.name)}@${String(record.version)}`
          : "unknown";
      return validationFailure([
        validationIssue({
          ruleId: "E_DEPENDENCY_EXACT",
          path: `/packages/${index}`,
          package: packageId,
          observed: record ?? "malformed package row",
          allowed: "one strict bounded package row with exact strict dependency references",
          remediation: "Replace malformed, ranged, tagged, oversized, or unknown dependency data with exact reviewed rows.",
        }),
      ]);
    }

    const item: DependencyPackageInput = {
      name: record.name as string,
      version: record.version as string,
      dependencies,
      ...(optionalPeers === undefined ? {} : { optionalPeers }),
    };
    const key = dependencyKey(item);
    if (packageByKey.has(key)) {
      return validationFailure([
        validationIssue({
          ruleId: "E_DEPENDENCY_EXACT",
          path: `/packages/${index}`,
          package: key,
          observed: key,
          allowed: "one unique row per exact package name and version",
          remediation: "Remove duplicate package rows before generating the install plan.",
        }),
      ]);
    }
    packages.push(item);
    packageByKey.set(key, item);
  }

  const packageVersionsByName = new Map<string, Set<string>>();
  for (const item of packages) {
    const versions = packageVersionsByName.get(item.name) ?? new Set<string>();
    versions.add(item.version);
    packageVersionsByName.set(item.name, versions);
  }

  const peerVersions = new Map<string, Set<string>>();
  for (const item of packages) {
    const seenDependencies = new Set<string>();
    for (const dependency of item.dependencies) {
      const key = dependencyKey(dependency);
      if (!packageByKey.has(key) || seenDependencies.has(key)) {
        return validationFailure([
          validationIssue({
            ruleId: "E_DEPENDENCY_EXACT",
            path: `/packages/${dependencyKey(item)}/dependencies`,
            package: dependencyKey(item),
            observed: dependency,
            allowed: "one unique exact dependency version present in the resolved package graph",
            remediation: "Resolve and include one immutable exact dependency version before install planning.",
          }),
        ]);
      }
      seenDependencies.add(key);
    }

    const seenPeers = new Set<string>();
    for (const peer of item.optionalPeers ?? []) {
      const key = dependencyKey(peer);
      if (seenPeers.has(key)) {
        return validationFailure([
          validationIssue({
            ruleId: "E_OPTIONAL_PEER_CONFLICT",
            path: `/packages/${dependencyKey(item)}/optionalPeers`,
            package: dependencyKey(item),
            observed: peer,
            allowed: "unique exact optional peer declarations",
            remediation: "Use at most one declaration for each exact optional peer.",
          }),
        ]);
      }
      seenPeers.add(key);
      const versions = peerVersions.get(peer.name) ?? new Set<string>();
      versions.add(peer.version);
      peerVersions.set(peer.name, versions);
      const installedVersions = packageVersionsByName.get(peer.name);
      if (
        installedVersions !== undefined &&
        (installedVersions.size !== 1 || !installedVersions.has(peer.version))
      ) {
        return validationFailure([
          validationIssue({
            ruleId: "E_OPTIONAL_PEER_CONFLICT",
            path: `/packages/${dependencyKey(item)}/optionalPeers`,
            package: dependencyKey(item),
            observed: [...installedVersions].sort(),
            allowed: `absent or installed only at exact version ${peer.version}`,
            remediation: "Remove the incompatible installed peer or resolve every present package to the declared exact version.",
          }),
        ]);
      }
    }
  }

  for (const [name, versions] of [...peerVersions.entries()].sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    if (versions.size > 1) {
      return validationFailure([
        validationIssue({
          ruleId: "E_OPTIONAL_PEER_CONFLICT",
          path: "/packages/optionalPeers",
          package: name,
          observed: [...versions].sort(),
          allowed: "zero or one exact optional peer version",
          remediation: "Align optional peer declarations or remove the conflicting optional integration.",
        }),
      ]);
    }
  }

  const root = typeof graph.root === "string" ? graph.root : "";
  if (root === "" || !packageByKey.has(root)) {
    return validationFailure([
      validationIssue({
        ruleId: "E_DEPENDENCY_EXACT",
        path: "/root",
        package: root === "" ? "unknown" : root,
        observed: graph.root,
        allowed: [...packageByKey.keys()].sort(),
        remediation: "Choose a root package present in the exact resolved graph.",
      }),
    ]);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return false;
    if (visited.has(key)) return true;
    visiting.add(key);
    const item = packageByKey.get(key);
    if (item === undefined) return false;
    for (const dependency of [...item.dependencies].sort((left, right) =>
      compareCodeUnits(dependencyKey(left), dependencyKey(right)),
    )) {
      if (!visit(dependencyKey(dependency))) return false;
    }
    visiting.delete(key);
    visited.add(key);
    order.push(key);
    return true;
  };

  if (!visit(root)) {
    return validationFailure([
      validationIssue({
        ruleId: "E_DAG_CYCLE",
        path: "/packages",
        package: root,
        observed: [...visiting].sort(),
        allowed: "acyclic exact dependency graph",
        remediation: "Remove the dependency cycle and regenerate the exact install plan.",
      }),
    ]);
  }
  if (visited.size !== packageByKey.size) {
    return validationFailure([
      validationIssue({
        ruleId: "E_DEPENDENCY_EXACT",
        path: "/packages",
        package: root,
        observed: [...packageByKey.keys()].filter((key) => !visited.has(key)).sort(),
        allowed: "only packages reachable from the selected root",
        remediation: "Remove unrelated rows or declare the missing exact dependency edge.",
      }),
    ]);
  }

  return validationSuccess({ order });
}

export interface CatalogFreshnessInput {
  snapshotId: string;
  generatedAt: string;
  now: string;
  maxAgeSeconds: number;
  previousValidSnapshotId: string;
}

export function validateCatalogFreshness(input: unknown): ValidationResult<CatalogFreshnessInput> {
  const record = plainDataRecord(input, 5);
  const shapeIsStrict =
    record !== undefined &&
    hasOnlyKeys(record, [
      "snapshotId",
      "generatedAt",
      "now",
      "maxAgeSeconds",
      "previousValidSnapshotId",
    ]);
  const timestampsAreStrict =
    shapeIsStrict &&
    TimestampSchema.safeParse(record.generatedAt).success &&
    TimestampSchema.safeParse(record.now).success;
  const identifiersAreStrict =
    shapeIsStrict &&
    StableIdSchema.safeParse(record.snapshotId).success &&
    StableIdSchema.safeParse(record.previousValidSnapshotId).success;
  const maxAgeIsValid =
    shapeIsStrict &&
    Number.isSafeInteger(record.maxAgeSeconds) &&
    (record.maxAgeSeconds as number) >= 0;
  const ageSeconds =
    timestampsAreStrict
      ? (Date.parse(record.now as string) - Date.parse(record.generatedAt as string)) / 1_000
      : Number.NaN;
  if (
    !timestampsAreStrict ||
    !identifiersAreStrict ||
    !maxAgeIsValid ||
    !Number.isFinite(ageSeconds) ||
    ageSeconds < 0 ||
    ageSeconds > (record?.maxAgeSeconds as number)
  ) {
    return validationFailure([
      validationIssue({
        ruleId: "E_CATALOG_STALE",
        path: "/generatedAt",
        observed: record?.snapshotId,
        allowed: record?.previousValidSnapshotId,
        remediation: "Keep the previous valid snapshot active and retry a reviewed catalog refresh.",
      }),
    ]);
  }

  return validationSuccess({
    snapshotId: record.snapshotId as string,
    generatedAt: record.generatedAt as string,
    now: record.now as string,
    maxAgeSeconds: record.maxAgeSeconds as number,
    previousValidSnapshotId: record.previousValidSnapshotId as string,
  });
}

export interface CatalogInstallEligibilityInput {
  package: DependencyRefInput;
  status: "active" | "withdrawn" | "replaced";
  existingInstall: boolean;
  replacement?: DependencyRefInput;
}

export function validateCatalogInstallEligibility(
  input: unknown,
): ValidationResult<CatalogInstallEligibilityInput> {
  const record = plainDataRecord(input, 4);
  const packageRef = strictDependencyRef(record?.package);
  const replacement =
    record?.replacement === undefined ? undefined : strictDependencyRef(record.replacement);
  const statusIsValid =
    record?.status === "active" || record?.status === "withdrawn" || record?.status === "replaced";
  const shapeIsStrict =
    record !== undefined &&
    hasOnlyKeys(record, ["package", "status", "existingInstall"], ["replacement"]);
  const replacementIsValid =
    record?.replacement === undefined ? record?.status !== "replaced" : replacement !== undefined;

  if (
    !shapeIsStrict ||
    !statusIsValid ||
    typeof record.existingInstall !== "boolean" ||
    packageRef === undefined ||
    !replacementIsValid
  ) {
    const dependencyFailure = packageRef === undefined || !replacementIsValid;
    return validationFailure([
      validationIssue({
        ruleId: dependencyFailure ? "E_DEPENDENCY_EXACT" : "E_SCHEMA_STRICT",
        path:
          packageRef === undefined
            ? "/package"
            : !replacementIsValid
              ? "/replacement"
              : "/",
        observed: input,
        allowed: "strict catalog eligibility data with exact package references and a boolean existingInstall",
        remediation: "Reject malformed catalog policy input before selecting an install action.",
      }),
    ]);
  }

  const validated: CatalogInstallEligibilityInput = {
    package: packageRef,
    status: record.status as CatalogInstallEligibilityInput["status"],
    existingInstall: record.existingInstall,
    ...(replacement === undefined ? {} : { replacement }),
  };
  if (validated.status !== "active") {
    return validationFailure([
      validationIssue({
        ruleId: "E_PACKAGE_WITHDRAWN",
        path: "/status",
        package: dependencyKey(validated.package),
        observed: validated.status,
        allowed:
          validated.replacement === undefined
            ? "active reviewed version"
            : dependencyKey(validated.replacement),
        remediation: "Block new installs, preserve existing saves/history, and offer only the reviewed replacement.",
      }),
    ]);
  }
  return validationSuccess(validated);
}

export interface ExactLockPackageRefInput extends DependencyRefInput {
  kind: ContentKind;
  engine: string;
  integrity: string;
  manifestSha256: string;
  catalogEntryId: string;
}

export interface ExactLockInput {
  planned: ExactLockPackageRefInput[];
  locked: ExactLockPackageRefInput[];
}

export function validateExactLock(input: unknown): ValidationResult<ExactLockInput> {
  const record = plainDataRecord(input, 2);
  const shapeIsStrict =
    record !== undefined && hasOnlyKeys(record, ["planned", "locked"]);

  const normalizeRows = (
    value: unknown,
  ): ExactLockInput["planned"] | undefined => {
    const rows = plainDataArray(value, MAX_GRAPH_PACKAGES);
    if (rows === undefined || rows.length === 0) {
      return undefined;
    }
    const output: ExactLockInput["planned"] = [];
    const seen = new Set<string>();
    for (const rowValue of rows) {
      const row = plainDataRecord(rowValue, 7);
      if (
        row === undefined ||
        !hasOnlyKeys(row, [
          "name",
          "version",
          "kind",
          "engine",
          "integrity",
          "manifestSha256",
          "catalogEntryId",
        ])
      ) {
        return undefined;
      }
      const parsed = PackageRefSchema.safeParse(row);
      if (!parsed.success) return undefined;
      const normalized: ExactLockPackageRefInput = parsed.data;
      const key = dependencyKey(normalized);
      if (seen.has(key)) return undefined;
      seen.add(key);
      output.push(normalized);
    }
    return output;
  };

  const planned = normalizeRows(record?.planned);
  const locked = normalizeRows(record?.locked);
  const arraysAreBounded =
    planned !== undefined &&
    planned.length > 0 &&
    planned.length <= MAX_GRAPH_PACKAGES &&
    locked !== undefined &&
    locked.length > 0 &&
    locked.length <= MAX_GRAPH_PACKAGES;
  const rowsMatchExactly =
    planned !== undefined &&
    locked !== undefined &&
    planned.length === locked.length &&
    planned.every((plannedRow, index) => {
      const lockedRow = locked[index];
      return (
        lockedRow !== undefined &&
        plannedRow.name === lockedRow.name &&
        plannedRow.version === lockedRow.version &&
        plannedRow.kind === lockedRow.kind &&
        plannedRow.engine === lockedRow.engine &&
        plannedRow.integrity === lockedRow.integrity &&
        plannedRow.manifestSha256 === lockedRow.manifestSha256 &&
        plannedRow.catalogEntryId === lockedRow.catalogEntryId
      );
    });
  if (
    !shapeIsStrict ||
    !arraysAreBounded ||
    planned === undefined ||
    locked === undefined ||
    !rowsMatchExactly
  ) {
    return validationFailure([
      validationIssue({
        ruleId: "E_LOCK_MISMATCH",
        path: "/locked",
        observed: "malformed or mismatched exact lock",
        allowed: "byte-for-byte exact planned dependency lock",
        remediation: "Regenerate the exact lock and refuse installation until planned and locked rows match.",
      }),
    ]);
  }

  return validationSuccess({ planned, locked });
}
