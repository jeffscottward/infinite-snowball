import { createHash } from "node:crypto";

export const AUDITED_NODE_VERSION = "22.13.1";

export function assertAuditedNodeRuntime(
	runtimeVersion = process.versions.node,
) {
	if (runtimeVersion !== AUDITED_NODE_VERSION) {
		throw new Error(
			`E_ASSET_RUNTIME: deterministic asset generation requires Node ${AUDITED_NODE_VERSION}; received ${runtimeVersion}`,
		);
	}
}
export const CONTENT_BUDGETS = Object.freeze({
	collectible: Object.freeze({
		maxBytes: 150 * 1024,
		maxTriangles: 10_000,
		maxMaterialSlots: 2,
		maxTextureDimension: 1_024,
	}),
	hero: Object.freeze({
		maxBytes: Math.floor(1.5 * 1024 * 1024),
		maxTriangles: 40_000,
		maxMaterialSlots: 4,
		maxTextureDimension: 2_048,
	}),
	level: Object.freeze({
		maxDownloadBytes: 12 * 1024 * 1024,
		maxUncompressedBytes: 25 * 1024 * 1024,
		maxFileBytes: 8 * 1024 * 1024,
		maxFiles: 256,
		maxCompressedTextureBytes: 8 * 1024 * 1024,
		maxTextureDimension: 2_048,
	}),
	music: Object.freeze({
		maxTrackBytes: 8 * 1024 * 1024,
		maxTrackSeconds: 10 * 60,
		maxSampleRate: 48_000,
		maxChannels: 2,
		maxPackBytes: 32 * 1024 * 1024,
		maxTracks: 8,
	}),
});
export const ROLE_TEXTURE_SET_BUDGETS = Object.freeze({
	collectible: 1,
	hero: 2,
});

export function canonicalConfigSha256(config) {
	try {
		if (
			config === null ||
			typeof config !== "object" ||
			Array.isArray(config)
		)
			throw new Error("config is not a record");
		const prototype = Object.getPrototypeOf(config);
		if (prototype !== Object.prototype && prototype !== null)
			throw new Error("config is not a plain record");
		const keys = Reflect.ownKeys(config);
		if (keys.length > 256) throw new Error("config has too many properties");
		const values = new Map();
		for (const key of keys) {
			if (
				typeof key !== "string" ||
				key.length === 0 ||
				key.length > 80 ||
				key === "__proto__"
			)
				throw new Error("config key is outside the protocol schema");
			const descriptor = Object.getOwnPropertyDescriptor(config, key);
			if (
				descriptor === undefined ||
				!descriptor.enumerable ||
				!("value" in descriptor)
			)
				throw new Error("config property is not enumerable plain data");
			const value = descriptor.value;
			if (
				!(
					value === null ||
					typeof value === "boolean" ||
					(typeof value === "number" && Number.isFinite(value)) ||
					(typeof value === "string" && value.length <= 500)
				)
			)
				throw new Error("config value is outside the protocol schema");
			values.set(key, value);
		}
		const canonical = `{${keys
			.sort()
			.map((key) => `${JSON.stringify(key)}:${JSON.stringify(values.get(key))}`)
			.join(",")}}`;
		return createHash("sha256").update(canonical, "utf8").digest("hex");
	} catch (cause) {
		throw new Error(
			"E_TRANSFORMATION_CONFIG: config must match the closed protocol transformation schema",
			{ cause },
		);
	}
}
