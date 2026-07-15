import { z } from "zod/mini";

export function arrayPreflight(maximum: number) {
  return z.custom<unknown[]>(
    (value) => {
      try {
        return Array.isArray(value) && value.length <= maximum;
      } catch {
        return false;
      }
    },
    { error: `Expected an array with at most ${maximum} items` },
  );
}

export function boundedArray<const Item extends z.core.SomeType>(
  item: Item,
  maximum: number,
  minimum = 0,
) {
  const arraySchema =
    minimum > 0
      ? z.array(item).check(z.minLength(minimum)).check(z.maxLength(maximum))
      : z.array(item).check(z.maxLength(maximum));
  return z
    .pipe(arrayPreflight(maximum), arraySchema)
    .check(z.meta({ maxItems: maximum, ...(minimum > 0 ? { minItems: minimum } : {}) }));
}

export function recordPreflight(maximum: number) {
  return z.custom<Record<string, unknown>>(
    (value) => {
      try {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return false;
        const keys = Reflect.ownKeys(value);
        if (keys.length > maximum) return false;
        for (const key of keys) {
          if (typeof key !== "string" || key === "__proto__") return false;
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (
            descriptor === undefined ||
            !descriptor.enumerable ||
            !("value" in descriptor)
          ) {
            return false;
          }
        }
        return true;
      } catch {
        return false;
      }
    },
    { error: `Expected a plain object with at most ${maximum} own properties` },
  );
}

export interface PlainDataSnapshotLimits {
  maximumDepth: number;
  maximumNodes: number;
  maximumProperties: number;
  maximumArrayLength: number;
  maximumObjectProperties: number;
  rejectPrototypeKey?: boolean;
}

export type PlainDataSnapshot =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

interface SnapshotFrame {
  source: object;
  target: unknown[] | Record<string, unknown>;
  depth: number;
}

function isSnapshotScalar(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

export function snapshotPlainData(
  value: unknown,
  limits: PlainDataSnapshotLimits,
): PlainDataSnapshot {
  if (isSnapshotScalar(value)) return { ok: true, value };
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "non-data-value" };
  }

  try {
    const rootTarget: unknown[] | Record<string, unknown> = Array.isArray(value)
      ? []
      : Object.create(null) as Record<string, unknown>;
    const stack: SnapshotFrame[] = [{ source: value, target: rootTarget, depth: 0 }];
    const seen = new WeakSet<object>();
    let nodes = 0;
    let properties = 0;

    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame === undefined) continue;
      if (frame.depth > limits.maximumDepth) return { ok: false, reason: "depth" };
      if (seen.has(frame.source)) return { ok: false, reason: "cycle-or-alias" };
      seen.add(frame.source);
      nodes += 1;
      if (nodes > limits.maximumNodes) return { ok: false, reason: "nodes" };

      const sourceIsArray = Array.isArray(frame.source);
      const prototype = Object.getPrototypeOf(frame.source);
      if (
        sourceIsArray
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null
      ) {
        return { ok: false, reason: "prototype" };
      }

      if (sourceIsArray) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(frame.source, "length");
        if (
          lengthDescriptor === undefined ||
          !("value" in lengthDescriptor) ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0
        ) {
          return { ok: false, reason: "array-shape" };
        }
        if (lengthDescriptor.value > limits.maximumArrayLength) {
          return { ok: false, reason: "array-length" };
        }
        const length = lengthDescriptor.value as number;
        properties += length;
        if (properties > limits.maximumProperties) {
          return { ok: false, reason: "properties" };
        }
        const keys = Reflect.ownKeys(frame.source);
        if (keys.length !== length + 1) {
          return { ok: false, reason: "array-shape" };
        }
        (frame.target as unknown[]).length = length;
        for (let index = 0; index < length; index += 1) {
          const key = String(index);
          const descriptor = Object.getOwnPropertyDescriptor(frame.source, key);
          if (
            descriptor === undefined ||
            !descriptor.enumerable ||
            !("value" in descriptor)
          ) {
            return { ok: false, reason: "array-descriptor" };
          }
          const child = descriptor.value;
          if (isSnapshotScalar(child)) {
            (frame.target as unknown[])[index] = child;
          } else if (typeof child === "object" && child !== null) {
            const childTarget: unknown[] | Record<string, unknown> = Array.isArray(child)
              ? []
              : Object.create(null) as Record<string, unknown>;
            (frame.target as unknown[])[index] = childTarget;
            stack.push({ source: child, target: childTarget, depth: frame.depth + 1 });
          } else {
            return { ok: false, reason: "non-data-value" };
          }
        }
        continue;
      }

      const keys = Reflect.ownKeys(frame.source);
      if (keys.length > limits.maximumObjectProperties) {
        return { ok: false, reason: "object-properties" };
      }
      properties += keys.length;
      if (properties > limits.maximumProperties) {
        return { ok: false, reason: "properties" };
      }
      for (const key of keys) {
        if (
          typeof key !== "string" ||
          (key === "__proto__" && limits.rejectPrototypeKey !== false)
        ) {
          return { ok: false, reason: "key" };
        }
        const descriptor = Object.getOwnPropertyDescriptor(frame.source, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          return { ok: false, reason: "object-descriptor" };
        }
        const child = descriptor.value;
        if (isSnapshotScalar(child)) {
          (frame.target as Record<string, unknown>)[key] = child;
        } else if (typeof child === "object" && child !== null) {
          const childTarget: unknown[] | Record<string, unknown> = Array.isArray(child)
            ? []
            : Object.create(null) as Record<string, unknown>;
          (frame.target as Record<string, unknown>)[key] = childTarget;
          stack.push({ source: child, target: childTarget, depth: frame.depth + 1 });
        } else {
          return { ok: false, reason: "non-data-value" };
        }
      }
    }

    return { ok: true, value: rootTarget };
  } catch {
    return { ok: false, reason: "inspection" };
  }
}
