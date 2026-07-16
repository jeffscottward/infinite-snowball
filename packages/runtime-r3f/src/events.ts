import type { PhysicsEvent } from "./runtime-loop.js";

export type PhysicsEventValue =
	| null
	| boolean
	| number
	| string
	| readonly PhysicsEventValue[]
	| { readonly [key: string]: PhysicsEventValue };

export interface PhysicsEventBuffer {
	push(event: PhysicsEvent<PhysicsEventValue>): void;
	drain(): readonly PhysicsEvent<PhysicsEventValue>[];
	clear(): void;
	readonly size: number;
	destroy(): void;
	readonly destroyed: boolean;
}

const MAX_EVENT_ID_LENGTH = 256;
const MAX_EVENT_KIND_LENGTH = 128;
const MAX_EVENT_STRING_LENGTH = 4_096;
const MAX_EVENT_KEY_LENGTH = 128;
const MAX_EVENT_PAYLOAD_NODES = 4_096;

interface CopyBudget {
	remainingNodes: number;
}

function requireBoundedText(
	value: unknown,
	label: string,
	maximum: number,
): asserts value is string {
	if (typeof value !== "string") {
		throw new Error(`${label} must be a primitive string`);
	}
	if (value.length === 0) throw new Error(`${label} must not be empty`);
	if (value.length > maximum) {
		throw new Error(`${label} exceeds maximum length`);
	}
}

function ordinal(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function copyValue(
	value: unknown,
	depth = 0,
	ancestors: ReadonlySet<object> = new Set(),
	budget: CopyBudget = { remainingNodes: MAX_EVENT_PAYLOAD_NODES },
): PhysicsEventValue {
	if (depth > 16)
		throw new Error("physics event payload exceeds maximum depth");
	if (budget.remainingNodes <= 0) {
		throw new Error("physics event payload exceeds maximum node count");
	}
	budget.remainingNodes -= 1;
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (value.length > MAX_EVENT_STRING_LENGTH) {
			throw new Error("physics event string exceeds maximum length");
		}
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error("physics event numbers must be finite");
		return value;
	}
	if (typeof value !== "object") {
		throw new Error("physics event payload contains an unsupported value");
	}
	if (ancestors.has(value))
		throw new Error("physics event payload must be acyclic");
	const nextAncestors = new Set(ancestors);
	nextAncestors.add(value);
	if (Array.isArray(value)) {
		if (value.length > 256) {
			throw new Error("physics event array exceeds maximum length");
		}
		const copied: PhysicsEventValue[] = [];
		for (let index = 0; index < value.length; index += 1) {
			copied.push(copyValue(value[index], depth + 1, nextAncestors, budget));
		}
		return Object.freeze(copied);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error("physics event payload must contain plain objects only");
	}
	const entries = Object.entries(value);
	if (entries.length > 64)
		throw new Error("physics event object has too many fields");
	const copy: Record<string, PhysicsEventValue> = Object.create(null);
	for (const [key, entry] of entries) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") {
			throw new Error("physics event payload contains a forbidden key");
		}
		if (key.length > MAX_EVENT_KEY_LENGTH) {
			throw new Error("physics event payload key exceeds maximum length");
		}
		copy[key] = copyValue(entry, depth + 1, nextAncestors, budget);
	}
	return Object.freeze(copy);
}

function copyEvent(
	event: PhysicsEvent<PhysicsEventValue>,
): PhysicsEvent<PhysicsEventValue> {
	const candidate = event as unknown as Readonly<Record<string, unknown>>;
	const entityId = candidate.entityId;
	const otherEntityId = candidate.otherEntityId;
	const kind = candidate.kind;
	const sequence = candidate.sequence;
	const payload = candidate.payload;
	requireBoundedText(entityId, "physics event entity ID", MAX_EVENT_ID_LENGTH);
	requireBoundedText(kind, "physics event kind", MAX_EVENT_KIND_LENGTH);
	if (otherEntityId !== undefined) {
		requireBoundedText(
			otherEntityId,
			"physics event other entity ID",
			MAX_EVENT_ID_LENGTH,
		);
	}
	if (
		typeof sequence !== "number" ||
		!Number.isSafeInteger(sequence) ||
		sequence < 0
	) {
		throw new Error(
			"physics event sequence must be a non-negative safe integer",
		);
	}
	const copiedPayload = payload === undefined ? undefined : copyValue(payload);
	return Object.freeze({
		entityId,
		...(otherEntityId === undefined ? {} : { otherEntityId }),
		kind,
		sequence,
		...(copiedPayload === undefined ? {} : { payload: copiedPayload }),
	});
}

export function createPhysicsEventBuffer(
	maxEvents = 1_024,
): PhysicsEventBuffer {
	if (!Number.isSafeInteger(maxEvents) || maxEvents <= 0) {
		throw new Error("physics event capacity must be a positive safe integer");
	}
	const events: PhysicsEvent<PhysicsEventValue>[] = [];
	let destroyed = false;
	function assertAlive(): void {
		if (destroyed) throw new Error("physics event buffer is destroyed");
	}
	return {
		push(event) {
			assertAlive();
			if (events.length >= maxEvents) {
				throw new Error("physics event capacity exceeded");
			}
			const copied = copyEvent(event);
			events.push(copied);
		},
		drain() {
			assertAlive();
			const drained: PhysicsEvent<PhysicsEventValue>[] = [];
			for (let index = 0; index < events.length; index += 1) {
				const event = events[index];
				if (event === undefined) {
					throw new Error("physics event entry must be defined");
				}
				drained.push(copyEvent(event));
			}
			drained.sort((left, right) => {
				const entity = ordinal(left.entityId, right.entityId);
				if (entity !== 0) return entity;
				const kind = ordinal(left.kind, right.kind);
				if (kind !== 0) return kind;
				const other = ordinal(
					left.otherEntityId ?? "",
					right.otherEntityId ?? "",
				);
				return other === 0 ? left.sequence - right.sequence : other;
			});
			events.length = 0;
			return Object.freeze(drained);
		},
		clear() {
			assertAlive();
			events.length = 0;
		},
		destroy() {
			if (destroyed) return;
			events.length = 0;
			destroyed = true;
		},
		get size() {
			assertAlive();
			return events.length;
		},
		get destroyed() {
			return destroyed;
		},
	};
}
