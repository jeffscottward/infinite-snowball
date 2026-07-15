import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import { deflateSync } from "node:zlib";

import {
	AUDITED_NODE_VERSION,
	assertAuditedNodeRuntime,
	CONTENT_BUDGETS,
	canonicalConfigSha256,
	ROLE_TEXTURE_SET_BUDGETS,
} from "./canonical-config.mjs";
import { inspectPng, inspectWav } from "./media-inspection.mjs";
import { buildDeterministicPackageArtifact } from "./package-artifact.mjs";
import { inventoryTree, readInventoriedFile } from "./tree-inventory.mjs";

export {
	assertAuditedNodeRuntime,
	ROLE_TEXTURE_SET_BUDGETS,
} from "./canonical-config.mjs";
export { inspectPng, inspectWav } from "./media-inspection.mjs";
export { buildDeterministicPackageArtifact } from "./package-artifact.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url);

const PACKAGE_INSPECTION_VALIDATOR_URL = new URL(
	"../../../packages/protocol/dist/validation/package-inspection.js",
	import.meta.url,
);
let packageInspectionValidatorPromise;

function loadPackageInspectionValidator() {
	if (packageInspectionValidatorPromise === undefined) {
		// Dynamic import is required because protocol:build owns this generated
		// module, while parser-only imports must work before generated dist exists.
		packageInspectionValidatorPromise = import(
			PACKAGE_INSPECTION_VALIDATOR_URL.href
		)
			.then((protocolModule) => {
				if (typeof protocolModule.validatePackageInspection !== "function")
					throw new Error("generated validator export is missing");
				return protocolModule.validatePackageInspection;
			})
			.catch((error) => {
				throw new Error(
					"E_PROTOCOL_BUILD: build the module-relative protocol validator before asset inspection",
					{ cause: error },
				);
			});
	}
	return packageInspectionValidatorPromise;
}

const PACKAGE_CONTRACTS = Object.freeze({
	"starter-objects": Object.freeze({
		name: "@infinite-snowball/starter-objects",
		kind: "object-pack",
	}),
	"starter-music": Object.freeze({
		name: "@infinite-snowball/starter-music",
		kind: "music",
	}),
	"starter-character": Object.freeze({
		name: "@infinite-snowball/starter-character",
		kind: "character",
	}),
	"starter-level": Object.freeze({
		name: "@infinite-snowball/starter-level",
		kind: "level",
	}),
	"starter-campaign": Object.freeze({
		name: "@infinite-snowball/starter-campaign",
		kind: "campaign",
	}),
});
const PACKAGE_NAMES = Object.freeze(Object.keys(PACKAGE_CONTRACTS));
const ALLOWED_RUNTIME_EXTENSIONS = Object.freeze({
	".glb": true,
	".json": true,
	".png": true,
	".wav": true,
});
const ALLOWED_REQUIRED_EXTENSIONS = Object.freeze({
	KHR_materials_unlit: true,
	KHR_mesh_quantization: true,
	KHR_texture_transform: true,
});
const EXECUTABLE_EXTENSION =
	/\.(?:cjs|css|dll|dylib|exe|html?|jar|js|jsx|mjs|node|sh|ts|tsx|wasm)$/iu;
const ABSOLUTE_URL_TEXT =
	/(?:^|[^a-z0-9+.-])([a-z][a-z0-9+.-]*:[^\s"'<>]+)/giu;
const GLB_JSON_DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_GLB_JSON_DEPTH = 64;
const MAX_GLB_CONTAINER_ENTRIES = 4_096;
const MAX_GLB_JSON_NODES = 20_000;

const P02_PACKAGE_LIMITS = Object.freeze({
	maxFiles: 2_048,
	maxFileBytes: 64 * 1024 * 1024,
	maxDeclaredBytes: 256 * 1024 * 1024,
	maxUncompressedBytes: 512 * 1024 * 1024,
	maxDepth: 12,
});
const P02_KIND_STRUCTURAL_CEILING = Object.freeze({
	maxFileBytes: P02_PACKAGE_LIMITS.maxFileBytes,
	maxFiles: P02_PACKAGE_LIMITS.maxFiles,
	rawBytes: P02_PACKAGE_LIMITS.maxUncompressedBytes,
	artifactBytes: P02_PACKAGE_LIMITS.maxDeclaredBytes,
});
const STARTER_KIND_STRUCTURAL_CEILINGS = Object.freeze({
	"object-pack": P02_KIND_STRUCTURAL_CEILING,
	character: P02_KIND_STRUCTURAL_CEILING,
	campaign: P02_KIND_STRUCTURAL_CEILING,
	level: Object.freeze({
		maxFileBytes: CONTENT_BUDGETS.level.maxFileBytes,
		maxFiles: CONTENT_BUDGETS.level.maxFiles,
		rawBytes: CONTENT_BUDGETS.level.maxUncompressedBytes,
		artifactBytes: CONTENT_BUDGETS.level.maxDownloadBytes,
	}),
	music: Object.freeze({
		maxFileBytes: CONTENT_BUDGETS.music.maxTrackBytes,
		maxFiles: CONTENT_BUDGETS.music.maxTracks + 16,
		rawBytes: CONTENT_BUDGETS.music.maxPackBytes,
		artifactBytes: CONTENT_BUDGETS.music.maxPackBytes,
	}),
});
const STARTER_ASSET_FILE_LIMIT = Object.values(
	STARTER_KIND_STRUCTURAL_CEILINGS,
).reduce((total, limits) => total + limits.maxFiles, 0);
const STARTER_FILE_LIMIT = STARTER_ASSET_FILE_LIMIT + PACKAGE_NAMES.length;
const STARTER_BYTE_LIMIT =
	Object.values(STARTER_KIND_STRUCTURAL_CEILINGS).reduce(
		(total, limits) => total + limits.rawBytes + limits.artifactBytes,
		0,
	) +
	PACKAGE_NAMES.length * P02_PACKAGE_LIMITS.maxFileBytes;

export const ASSET_LIMITS = Object.freeze({
	maxFileBytes: Math.max(
		CONTENT_BUDGETS.collectible.maxBytes,
		CONTENT_BUDGETS.hero.maxBytes,
		CONTENT_BUDGETS.level.maxFileBytes,
		CONTENT_BUDGETS.music.maxTrackBytes,
	),
	maxTriangles: Math.max(
		CONTENT_BUDGETS.collectible.maxTriangles,
		CONTENT_BUDGETS.hero.maxTriangles,
	),
	maxMaterials: 8,
	maxTextureDimension: 4_096,
	maxStarterFileBytes: P02_PACKAGE_LIMITS.maxFileBytes,
	maxStarterEntries:
		STARTER_FILE_LIMIT * (P02_PACKAGE_LIMITS.maxDepth + 1),
	maxStarterDepth: P02_PACKAGE_LIMITS.maxDepth + 1,
	maxTextureBytes: 8 * 1024 * 1024,
	maxDecodedTextureBytes: 80 * 1024 * 1024,
	maxEmbeddedImages: 64,
	maxStarterFiles: STARTER_FILE_LIMIT,
	maxStarterBytes: STARTER_BYTE_LIMIT,
	maxStarterTriangles:
		STARTER_FILE_LIMIT *
		Math.max(
			CONTENT_BUDGETS.collectible.maxTriangles,
			CONTENT_BUDGETS.hero.maxTriangles,
		),
});
const STARTER_TREE_LIMITS = Object.freeze({
	maxEntries: ASSET_LIMITS.maxStarterEntries,
	maxFiles: ASSET_LIMITS.maxStarterFiles,
	maxDepth: ASSET_LIMITS.maxStarterDepth,
	maxFileBytes: ASSET_LIMITS.maxStarterFileBytes,
	maxTotalBytes: ASSET_LIMITS.maxStarterBytes,
});

export const PIPELINE_CONFIG = Object.freeze({
	schemaVersion: 1,
	pipeline: "retained-self-contained-npm-tgz-v2",
	tool: "@infinite-snowball/asset-pipeline",
	toolVersion: "1.0.0",
	nodeVersion: AUDITED_NODE_VERSION,
	gltfTransformVersion: "4.4.1",
	sourcePolicy: "exact-artifact-copy-after-structural-validation",
	texturePolicy: "embedded-only",
	audioPolicy: "deterministic-stereo-pcm16-wav",
	artifactPolicy:
		"deterministic-ustar-concatenated-gzip-members-with-fixed-point-manifest",
	contentBudgets: CONTENT_BUDGETS,
	roleTextureSetBudgets: ROLE_TEXTURE_SET_BUDGETS,
	limits: ASSET_LIMITS,
});

export const CONFIG_SHA256 = sha256(
	Buffer.from(JSON.stringify(PIPELINE_CONFIG), "utf8"),
);

function sha256(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}
function compareCodeUnits(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}
function parseCanonicalTabJson(bytes, ruleId, path) {
	try {
		if (!Buffer.isBuffer(bytes)) throw new Error("missing bounded JSON bytes");
		const value = JSON.parse(bytes.toString("utf8"));
		const canonical = Buffer.from(
			`${JSON.stringify(value, null, "\t")}\n`,
			"utf8",
		);
		if (!bytes.equals(canonical))
			throw new Error("JSON bytes are not canonical");
		return value;
	} catch (cause) {
		throw new Error(
			`${ruleId}: ${path} must be canonical tab-indented JSON with one trailing newline and no duplicate keys`,
			{ cause },
		);
	}
}



function issue(ruleId, path, remediation, extra = {}) {
	return { ruleId, path, remediation, ...extra };
}

function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function containsAbsoluteUrl(value) {
	for (const match of value.matchAll(ABSOLUTE_URL_TEXT)) {
		const candidate = match[1];
		if (candidate !== undefined && URL.canParse(candidate)) return true;
	}
	return false;
}

function glbChunks(buffer) {
	const chunks = [];
	let offset = 12;
	while (offset < buffer.length) {
		if (chunks.length >= 2) throw new Error("too many GLB chunks");
		if (offset + 8 > buffer.length) throw new Error("truncated chunk header");
		const length = buffer.readUInt32LE(offset);
		if (length % 4 !== 0) throw new Error("unaligned chunk body");
		const type = buffer.readUInt32LE(offset + 4);
		const expectedType = chunks.length === 0 ? 0x4e4f534a : 0x004e4942;
		if (type !== expectedType) throw new Error("unknown or misplaced GLB chunk");
		const start = offset + 8;
		const end = start + length;
		if (end > buffer.length) throw new Error("truncated chunk body");
		chunks.push({ type, data: buffer.subarray(start, end) });
		offset = end;
	}
	if (offset !== buffer.length) throw new Error("invalid chunk alignment");
	return chunks;
}

function decodeGlbJson(data) {
	let contentEnd = data.length;
	while (contentEnd > 0 && data[contentEnd - 1] === 0x20) contentEnd -= 1;
	if (contentEnd === 0 || data[contentEnd - 1] !== 0x7d)
		throw new Error("invalid JSON chunk padding");
	return GLB_JSON_DECODER.decode(data.subarray(0, contentEnd));
}

function inspectRawGlbJson(jsonText) {
	let offset = 0;
	let nodes = 0;

	const skipWhitespace = () => {
		while (
			offset < jsonText.length &&
			(jsonText[offset] === " " ||
				jsonText[offset] === "\t" ||
				jsonText[offset] === "\n" ||
				jsonText[offset] === "\r")
		)
			offset += 1;
	};
	const scanString = () => {
		const start = offset;
		if (jsonText[offset] !== '"') throw new Error("expected JSON string");
		offset += 1;
		while (offset < jsonText.length) {
			const character = jsonText[offset];
			if (character === '"') {
				offset += 1;
				return JSON.parse(jsonText.slice(start, offset));
			}
			if (character === "\\") {
				offset += 2;
				continue;
			}
			offset += 1;
		}
		throw new Error("unterminated JSON string");
	};
	const scanScalar = () => {
		const start = offset;
		while (
			offset < jsonText.length &&
			![",", "]", "}", " ", "\t", "\n", "\r"].includes(jsonText[offset])
		)
			offset += 1;
		if (offset === start) throw new Error("missing JSON scalar");
		JSON.parse(jsonText.slice(start, offset));
	};
	const scanValue = (depth) => {
		skipWhitespace();
		nodes += 1;
		if (nodes > MAX_GLB_JSON_NODES) return "nodes";
		if (jsonText[offset] === "{") return scanObject(depth + 1);
		if (jsonText[offset] === "[") return scanArray(depth + 1);
		if (jsonText[offset] === '"') {
			scanString();
			return "ok";
		}
		scanScalar();
		return "ok";
	};
	const scanObject = (depth) => {
		if (depth > MAX_GLB_JSON_DEPTH) return "depth";
		offset += 1;
		skipWhitespace();
		if (jsonText[offset] === "}") {
			offset += 1;
			return "ok";
		}
		const keys = new Set();
		let entries = 0;
		while (offset < jsonText.length) {
			skipWhitespace();
			const key = scanString();
			entries += 1;
			if (entries > MAX_GLB_CONTAINER_ENTRIES) return "object";
			if (keys.has(key)) return "duplicate";
			keys.add(key);
			skipWhitespace();
			if (jsonText[offset] !== ":") throw new Error("missing JSON colon");
			offset += 1;
			const status = scanValue(depth);
			if (status !== "ok") return status;
			skipWhitespace();
			if (jsonText[offset] === "}") {
				offset += 1;
				return "ok";
			}
			if (jsonText[offset] !== ",") throw new Error("missing JSON comma");
			offset += 1;
		}
		throw new Error("unterminated JSON object");
	};
	const scanArray = (depth) => {
		if (depth > MAX_GLB_JSON_DEPTH) return "depth";
		offset += 1;
		skipWhitespace();
		if (jsonText[offset] === "]") {
			offset += 1;
			return "ok";
		}
		let entries = 0;
		while (offset < jsonText.length) {
			entries += 1;
			if (entries > MAX_GLB_CONTAINER_ENTRIES) return "array";
			const status = scanValue(depth);
			if (status !== "ok") return status;
			skipWhitespace();
			if (jsonText[offset] === "]") {
				offset += 1;
				return "ok";
			}
			if (jsonText[offset] !== ",") throw new Error("missing JSON comma");
			offset += 1;
		}
		throw new Error("unterminated JSON array");
	};

	const status = scanValue(0);
	if (status !== "ok") return status;
	skipWhitespace();
	if (offset !== jsonText.length) throw new Error("trailing JSON bytes");
	return "ok";
}


function validateGlbWorkBudget(document, issues, textValues) {
	const stack = [document];
	let visited = 0;
	while (stack.length > 0) {
		const value = stack.pop();
		visited += 1;
		if (visited > MAX_GLB_JSON_NODES) {
			issues.push(
				issue(
					"E_GLB_STRUCTURE",
					"/",
					`Keep GLB JSON at or below ${MAX_GLB_JSON_NODES} aggregate values.`,
				),
			);
			return false;
		}
		if (typeof value === "string") {
			textValues.push(value);
			continue;
		}
		if (Array.isArray(value)) {
			if (value.length > MAX_GLB_CONTAINER_ENTRIES) {
				issues.push(
					issue(
						"E_GLB_STRUCTURE",
						"/",
						`Keep every GLB JSON array at or below ${MAX_GLB_CONTAINER_ENTRIES} entries.`,
					),
				);
				return false;
			}
			for (const entry of value) stack.push(entry);
			continue;
		}
		if (!plainObject(value)) continue;
		let entries = 0;
		for (const [key, entry] of Object.entries(value)) {
			textValues.push(key);
			entries += 1;
			if (entries > MAX_GLB_CONTAINER_ENTRIES) {
				issues.push(
					issue(
						"E_GLB_STRUCTURE",
						"/",
						`Keep every GLB JSON object at or below ${MAX_GLB_CONTAINER_ENTRIES} fields.`,
					),
				);
				return false;
			}
			stack.push(entry);
		}
	}
	return true;
}
function rejectExcessiveGlbDepth(path, issues, depth) {
	if (depth <= MAX_GLB_JSON_DEPTH) return false;
	issues.push(
		issue(
			"E_GLB_STRUCTURE",
			path,
			`Keep GLB JSON nesting at or below ${MAX_GLB_JSON_DEPTH} levels.`,
		),
	);
	return true;
}

function plainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finitePair(value) {
	return (
		Array.isArray(value) &&
		value.length === 2 &&
		value.every((entry) => finiteNumber(entry))
	);
}

function validExtensionPayload(extension, payload, path) {
	if (extension === "KHR_materials_unlit") {
		return (
			/^\/materials\/\d+\/extensions\/KHR_materials_unlit$/u.test(path) &&
			plainObject(payload) &&
			Object.keys(payload).length === 0
		);
	}
	if (extension === "KHR_mesh_quantization") return false;
	if (extension === "KHR_texture_transform") {
		const validPath =
			/^\/materials\/\d+\/(?:pbrMetallicRoughness\/(?:baseColorTexture|metallicRoughnessTexture)|normalTexture|occlusionTexture|emissiveTexture)\/extensions\/KHR_texture_transform$/u.test(
				path,
			);
		const allowedKeys = new Set(["offset", "rotation", "scale", "texCoord"]);
		return (
			validPath &&
			plainObject(payload) &&
			Object.keys(payload).every((key) => allowedKeys.has(key)) &&
			(payload.offset === undefined || finitePair(payload.offset)) &&
			(payload.rotation === undefined || finiteNumber(payload.rotation)) &&
			(payload.scale === undefined || finitePair(payload.scale)) &&
			(payload.texCoord === undefined ||
				(Number.isSafeInteger(payload.texCoord) && payload.texCoord >= 0))
		);
	}
	return false;
}

function inspectExtensionMap(value, path, issues, declaredExtensions, depth) {
	if (!plainObject(value)) {
		issues.push(
			issue(
				"E_GLB_EXTENSION_UNSUPPORTED",
				path,
				"Use a plain map of reviewed extension payloads.",
			),
		);
		return;
	}
	for (const [extension, payload] of Object.entries(value)) {
		const extensionPath = `${path}/${extension}`;
		if (
			!Object.hasOwn(ALLOWED_REQUIRED_EXTENSIONS, extension) ||
			!declaredExtensions.has(extension) ||
			!validExtensionPayload(extension, payload, extensionPath)
		) {
			issues.push(
				issue(
					"E_GLB_EXTENSION_UNSUPPORTED",
					extensionPath,
					"Declare the reviewed extension in extensionsUsed and match its closed payload schema and placement.",
				),
			);
		}
		inspectExtensionPayload(
			payload,
			extensionPath,
			issues,
			declaredExtensions,
			depth + 1,
		);
	}
}

function inspectExtensionPayload(
	value,
	path,
	issues,
	declaredExtensions,
	depth = 0,
) {
	if (rejectExcessiveGlbDepth(path, issues, depth)) return;
	if (typeof value === "string") {
		issues.push(
			issue(
				"E_GLB_EXTERNAL_REFERENCE",
				path,
				"Remove string fragments and external-reference values from reviewed extension payloads.",
			),
		);
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries())
			inspectExtensionPayload(
				entry,
				`${path}/${index}`,
				issues,
				declaredExtensions,
				depth + 1,
			);
		return;
	}
	if (!plainObject(value)) return;
	for (const [key, entry] of Object.entries(value)) {
		const entryPath = `${path}/${key}`;
		if (key === "extensions") {
			inspectExtensionMap(
				entry,
				entryPath,
				issues,
				declaredExtensions,
				depth + 1,
			);
			continue;
		}
		if (/(?:uri|url|href|src|reference|references)$/iu.test(key)) {
			issues.push(
				issue(
					"E_GLB_EXTERNAL_REFERENCE",
					entryPath,
					"Remove URI and external-reference fields from reviewed extension payloads.",
				),
			);
		}
		inspectExtensionPayload(
			entry,
			entryPath,
			issues,
			declaredExtensions,
			depth + 1,
		);
	}
}

function inspectExtensionContainers(
	value,
	path,
	issues,
	declaredExtensions,
	depth = 0,
) {
	if (rejectExcessiveGlbDepth(path, issues, depth)) return;
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries())
			inspectExtensionContainers(
				entry,
				`${path}/${index}`,
				issues,
				declaredExtensions,
				depth + 1,
			);
		return;
	}
	if (!plainObject(value)) return;
	for (const [key, entry] of Object.entries(value)) {
		const entryPath = `${path}/${key}`;
		if (key === "extensions") {
			inspectExtensionMap(
				entry,
				entryPath,
				issues,
				declaredExtensions,
				depth + 1,
			);
		} else {
			inspectExtensionContainers(
				entry,
				entryPath,
				issues,
				declaredExtensions,
				depth + 1,
			);
		}
	}
}

function materialTextureSetCount(document, issues) {
	const materials = Array.isArray(document.materials) ? document.materials : [];
	const textures = Array.isArray(document.textures) ? document.textures : [];
	const images = Array.isArray(document.images) ? document.images : [];
	const sets = new Set();
	for (const [materialIndex, material] of materials.entries()) {
		const bindings = [
			["baseColor", material?.pbrMetallicRoughness?.baseColorTexture],
			[
				"metallicRoughness",
				material?.pbrMetallicRoughness?.metallicRoughnessTexture,
			],
			["normal", material?.normalTexture],
			["occlusion", material?.occlusionTexture],
			["emissive", material?.emissiveTexture],
		];
		const signature = [];
		for (const [slot, binding] of bindings) {
			if (binding === undefined) continue;
			const textureIndex = binding?.index;
			const texture = textures[textureIndex];
			const sourceIndex = texture?.source;
			if (
				!plainObject(binding) ||
				!Number.isSafeInteger(textureIndex) ||
				textureIndex < 0 ||
				!plainObject(texture) ||
				!Number.isSafeInteger(sourceIndex) ||
				sourceIndex < 0 ||
				sourceIndex >= images.length
			) {
				issues.push(
					issue(
						"E_GLB_STRUCTURE",
						`/materials/${materialIndex}/${slot}Texture`,
						"Bind every material texture slot to a declared embedded image.",
					),
				);
				continue;
			}
			signature.push(`${slot}:${textureIndex}`);
		}
		if (signature.length > 0) sets.add(signature.join("|"));
	}
	return sets.size;
}

function triangleCount(document, issues) {
	const accessors = Array.isArray(document.accessors) ? document.accessors : [];
	const meshes = Array.isArray(document.meshes) ? document.meshes : [];
	let triangles = 0;
	for (const [meshIndex, mesh] of meshes.entries()) {
		for (const [primitiveIndex, primitive] of (
			Array.isArray(mesh?.primitives) ? mesh.primitives : []
		).entries()) {
			const mode = primitive?.mode ?? 4;
			const accessorIndex = Number.isSafeInteger(primitive?.indices)
				? primitive.indices
				: primitive?.attributes?.POSITION;
			const accessor = accessors[accessorIndex];
			const count = accessor?.count;
			if (
				!Number.isSafeInteger(accessorIndex) ||
				accessorIndex < 0 ||
				!plainObject(accessor) ||
				!Number.isSafeInteger(count) ||
				count < 0 ||
				!Number.isSafeInteger(mode) ||
				mode < 0 ||
				mode > 6
			) {
				issues.push(
					issue(
						"E_GLB_STRUCTURE",
						`/meshes/${meshIndex}/primitives/${primitiveIndex}`,
						"Use valid primitive modes and non-negative integer accessor counts.",
					),
				);
				continue;
			}
			if (mode === 4) triangles += Math.floor(count / 3);
			else if (mode === 5 || mode === 6) triangles += Math.max(0, count - 2);
		}
	}
	return triangles;
}

export function inspectGlb(input) {
	const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
	const issues = [];
	const metrics = {
		bytes: buffer.length,
		triangles: 0,
		materials: 0,
		textures: 0,
		textureBytes: 0,
		decodedTextureBytes: 0,
		maxTextureDimension: 0,
		textureSets: 0,
		extensionsRequired: [],
		extensionsUsed: [],
		animationClips: [],
		textValues: [],
	};

	if (buffer.length > ASSET_LIMITS.maxFileBytes) {
		issues.push(
			issue(
				"E_ASSET_BYTES",
				"/bytes",
				"Reduce the GLB below the reviewed per-file byte ceiling.",
				{
					allowed: ASSET_LIMITS.maxFileBytes,
				},
			),
		);
		return { ok: false, issues, metrics };
	}
	if (
		buffer.length < 20 ||
		buffer.readUInt32LE(0) !== 0x46546c67 ||
		buffer.readUInt32LE(4) !== 2
	) {
		issues.push(
			issue(
				"E_GLB_HEADER",
				"/",
				"Provide a complete glTF 2.0 binary container.",
			),
		);
		return { ok: false, issues, metrics };
	}
	if (buffer.readUInt32LE(8) !== buffer.length) {
		issues.push(
			issue(
				"E_GLB_LENGTH",
				"/",
				"Make the GLB header length match the exact file bytes.",
			),
		);
		return { ok: false, issues, metrics };
	}

	let chunks;
	try {
		chunks = glbChunks(buffer);
	} catch {
		issues.push(
			issue("E_GLB_CHUNK", "/", "Repair truncated or misaligned GLB chunks."),
		);
		return { ok: false, issues, metrics };
	}
	const jsonChunks = chunks.filter((chunk) => chunk.type === 0x4e4f534a);
	const binaryChunks = chunks.filter((chunk) => chunk.type === 0x004e4942);
	if (
		chunks.length < 1 ||
		chunks.length > 2 ||
		chunks[0]?.type !== 0x4e4f534a ||
		(chunks.length === 2 && chunks[1]?.type !== 0x004e4942)
	) {
		issues.push(
			issue(
				"E_GLB_CHUNK",
				"/",
				"Use exactly one leading JSON chunk followed only by one optional BIN chunk.",
			),
		);
		return { ok: false, issues, metrics };
	}

	let document;
	try {
		const jsonText = decodeGlbJson(jsonChunks[0].data);
		const rawJsonStatus = inspectRawGlbJson(jsonText);
		if (rawJsonStatus === "duplicate")
			throw new Error("duplicate decoded JSON object key");
		if (rawJsonStatus !== "ok") {
			const remediation =
				rawJsonStatus === "depth"
					? `Keep complete GLB JSON nesting at or below ${MAX_GLB_JSON_DEPTH} levels.`
					: rawJsonStatus === "nodes"
						? `Keep GLB JSON at or below ${MAX_GLB_JSON_NODES} aggregate values.`
						: rawJsonStatus === "array"
							? `Keep every GLB JSON array at or below ${MAX_GLB_CONTAINER_ENTRIES} entries.`
							: `Keep every GLB JSON object at or below ${MAX_GLB_CONTAINER_ENTRIES} fields.`;
			issues.push(issue("E_GLB_STRUCTURE", "/", remediation));
			return { ok: false, issues, metrics };
		}
		document = JSON.parse(jsonText);
		if (!plainObject(document)) throw new Error("GLB JSON root must be an object");
	} catch {
		issues.push(
			issue(
				"E_GLB_JSON",
				"/",
				"Provide valid bounded UTF-8 JSON in the GLB JSON chunk.",
			),
		);
		return { ok: false, issues, metrics };
	}
	const textValues = [];
	if (!validateGlbWorkBudget(document, issues, textValues))
		return { ok: false, issues, metrics };
	metrics.textValues = textValues;
	if (document?.asset?.version !== "2.0") {
		issues.push(
			issue(
				"E_GLB_VERSION",
				"/asset/version",
				"Declare glTF asset version 2.0.",
			),
		);
	}
	const animationNames = new Set();
	for (const [index, animation] of (
		Array.isArray(document.animations) ? document.animations : []
	).entries()) {
		if (
			typeof animation?.name !== "string" ||
			animation.name.length === 0 ||
			animationNames.has(animation.name)
		) {
			issues.push(
				issue(
					"E_GLB_STRUCTURE",
					`/animations/${index}/name`,
					"Give every animation clip one nonempty unique runtime name.",
				),
			);
			continue;
		}
		animationNames.add(animation.name);
		metrics.animationClips.push(animation.name);
	}

	const referenceContainers = [
		["buffers", document.buffers],
		["images", document.images],
	];
	for (const [containerName, entries] of referenceContainers) {
		for (const [index, entry] of (Array.isArray(entries)
			? entries
			: []
		).entries()) {
			if (typeof entry?.uri === "string") {
				issues.push(
					issue(
						"E_GLB_EXTERNAL_REFERENCE",
						`/${containerName}/${index}/uri`,
						"Embed every buffer and image in the GLB; URL, data, and relative URI references are forbidden.",
					),
				);
			}
		}
	}

	for (const field of ["extensionsUsed", "extensionsRequired"]) {
		const value = document[field];
		if (value !== undefined && !Array.isArray(value)) {
			issues.push(
				issue(
					"E_GLB_EXTENSION_UNSUPPORTED",
					`/${field}`,
					"Declare reviewed extensions as a bounded string array.",
				),
			);
			continue;
		}
		const extensions = Array.isArray(value) ? value : [];
		const seen = new Set();
		for (const [index, extension] of extensions.entries()) {
			if (
				typeof extension !== "string" ||
				seen.has(extension) ||
				!Object.hasOwn(ALLOWED_REQUIRED_EXTENSIONS, extension)
			) {
				issues.push(
					issue(
						"E_GLB_EXTENSION_UNSUPPORTED",
						`/${field}/${index}`,
						"Remove duplicate, malformed, or unreviewed extensions.",
					),
				);
				continue;
			}
			seen.add(extension);
		}
		metrics[field] = extensions.filter(
			(extension) => typeof extension === "string",
		);
	}
	for (const [index, extension] of metrics.extensionsRequired.entries()) {
		if (!metrics.extensionsUsed.includes(extension)) {
			issues.push(
				issue(
					"E_GLB_EXTENSION_UNSUPPORTED",
					`/extensionsRequired/${index}`,
					"List every required reviewed extension in extensionsUsed as required by glTF 2.0.",
				),
			);
		}
	}
	inspectExtensionContainers(
		document,
		"",
		issues,
		new Set(metrics.extensionsUsed),
	);
	if (
		textValues.some(containsAbsoluteUrl) &&
		!issues.some((entry) => entry.ruleId === "E_GLB_EXTERNAL_REFERENCE")
	) {
		issues.push(
			issue(
				"E_GLB_EXTERNAL_REFERENCE",
				"/",
				"Remove absolute URL syntax from every GLB key and string value; runtime assets must remain self-contained.",
			),
		);
	}

	metrics.materials = Array.isArray(document.materials)
		? document.materials.length
		: 0;
	metrics.textureSets = materialTextureSetCount(document, issues);
	if (metrics.materials > ASSET_LIMITS.maxMaterials) {
		issues.push(
			issue(
				"E_ASSET_MATERIALS",
				"/materials",
				"Reduce material slots or record a measured reviewed exception.",
				{
					allowed: ASSET_LIMITS.maxMaterials,
				},
			),
		);
	}

	metrics.triangles = triangleCount(document, issues);
	if (metrics.triangles > ASSET_LIMITS.maxTriangles) {
		issues.push(
			issue(
				"E_ASSET_TRIANGLES",
				"/meshes",
				"Reduce decoded triangle count below the reviewed ceiling.",
				{
					allowed: ASSET_LIMITS.maxTriangles,
				},
			),
		);
	}

	const accessors = Array.isArray(document.accessors) ? document.accessors : [];
	const meshes = Array.isArray(document.meshes) ? document.meshes : [];
	const positionAccessors = new Set();
	for (const mesh of meshes) {
		for (const primitive of Array.isArray(mesh?.primitives)
			? mesh.primitives
			: []) {
			if (Number.isInteger(primitive?.attributes?.POSITION))
				positionAccessors.add(primitive.attributes.POSITION);
		}
	}
	for (const accessorIndex of positionAccessors) {
		const accessor = accessors[accessorIndex];
		const valid =
			Array.isArray(accessor?.min) &&
			Array.isArray(accessor?.max) &&
			accessor.min.length === 3 &&
			accessor.max.length === 3 &&
			accessor.min.every(finiteNumber) &&
			accessor.max.every(finiteNumber) &&
			accessor.min.every((value, index) => value <= accessor.max[index]) &&
			[...accessor.min, ...accessor.max].every(
				(value) => Math.abs(value) <= 10_000,
			);
		if (!valid) {
			issues.push(
				issue(
					"E_GLB_BOUNDS_INVALID",
					`/accessors/${accessorIndex}`,
					"Declare finite ordered POSITION bounds within the reviewed world-coordinate range.",
				),
			);
		}
	}

	const binary = binaryChunks[0]?.data;
	const declaredBuffers = Array.isArray(document.buffers)
		? document.buffers
		: [];
	let declaredBinaryLength;
	const hasBinaryBinding =
		binary !== undefined || document.buffers !== undefined;
	if (hasBinaryBinding) {
		const declared = declaredBuffers[0];
		const paddingLength =
			binary !== undefined && Number.isSafeInteger(declared?.byteLength)
				? binary.length - declared.byteLength
				: -1;
		const validBinding =
			binary !== undefined &&
			declaredBuffers.length === 1 &&
			plainObject(declared) &&
			declared.uri === undefined &&
			Number.isSafeInteger(declared.byteLength) &&
			declared.byteLength >= 0 &&
			paddingLength >= 0 &&
			paddingLength <= 3 &&
			binary.length === align4(declared.byteLength) &&
			binary.subarray(declared.byteLength).every((byte) => byte === 0);
		if (!validBinding) {
			issues.push(
				issue(
					"E_GLB_BINARY_INVALID",
					"/buffers",
					"Bind one URI-less buffer to the exact BIN payload with at most three zero padding bytes.",
				),
			);
		} else {
			declaredBinaryLength = declared.byteLength;
		}
	}

	const bufferViews = Array.isArray(document.bufferViews)
		? document.bufferViews
		: [];
	for (const [index, view] of bufferViews.entries()) {
		const start =
			view?.byteOffset === undefined ? 0 : view.byteOffset;
		const validView =
			declaredBinaryLength !== undefined &&
			view?.buffer === 0 &&
			Number.isSafeInteger(view?.byteLength) &&
			view.byteLength >= 0 &&
			Number.isSafeInteger(start) &&
			start >= 0 &&
			start + view.byteLength <= declaredBinaryLength;
		if (!validView) {
			issues.push(
				issue(
					"E_GLB_BINARY_INVALID",
					`/bufferViews/${index}`,
					"Keep every buffer view inside the exact declared BIN payload.",
				),
			);
		}
	}
	const images = Array.isArray(document.images) ? document.images : [];
	if (images.length > ASSET_LIMITS.maxEmbeddedImages) {
		issues.push(
			issue(
				"E_ASSET_TEXTURE_UNINSPECTED",
				"/images",
				"Keep embedded image definitions inside the reviewed decode-work ceiling.",
				{ allowed: ASSET_LIMITS.maxEmbeddedImages },
			),
		);
	}
	const textures = Array.isArray(document.textures) ? document.textures : [];
	metrics.textures = Math.max(images.length, textures.length);
	const pngInspections = new Map();
	for (const [index, image] of images
		.slice(0, ASSET_LIMITS.maxEmbeddedImages)
		.entries()) {
		if (!Number.isInteger(image?.bufferView) || !binary) {
			issues.push(
				issue(
					"E_ASSET_TEXTURE_UNINSPECTED",
					`/images/${index}`,
					"Require every image to use one complete embedded buffer view.",
				),
			);
			continue;
		}
		const view = bufferViews[image.bufferView];
		if (view?.buffer !== 0 || !Number.isSafeInteger(view.byteLength)) {
			issues.push(
				issue(
					"E_ASSET_TEXTURE_UNINSPECTED",
					`/images/${index}`,
					"Use one inspectable embedded image buffer view.",
				),
			);
			continue;
		}
		const start = view.byteOffset === undefined ? 0 : view.byteOffset;
		const validStart = Number.isSafeInteger(start) && start >= 0;
		const end = validStart ? start + view.byteLength : -1;
		if (!validStart || end > (declaredBinaryLength ?? -1)) {
			issues.push(
				issue(
					"E_ASSET_TEXTURE_UNINSPECTED",
					`/images/${index}`,
					"Keep embedded image bytes inside the BIN chunk.",
				),
			);
			continue;
		}
		if (image.mimeType !== "image/png") {
			issues.push(
				issue(
					"E_ASSET_TEXTURE_UNINSPECTED",
					`/images/${index}`,
					"Declare every embedded texture as a fully decoded PNG.",
				),
			);
			continue;
		}
		metrics.textureBytes += view.byteLength;
		const imageBytes = binary.subarray(start, end);
		const inspectionKey = `${image.bufferView}:${start}:${end}`;
		let pngInspection = pngInspections.get(inspectionKey);
		if (pngInspection === undefined) {
			pngInspection = inspectPng(imageBytes);
			pngInspections.set(inspectionKey, pngInspection);
		}
		const dimensions = pngInspection?.metrics;
		const oversizedDimensions =
			Number.isSafeInteger(dimensions?.width) &&
			Number.isSafeInteger(dimensions?.height) &&
			(dimensions.width > ASSET_LIMITS.maxTextureDimension ||
				dimensions.height > ASSET_LIMITS.maxTextureDimension);
		if (oversizedDimensions) {
			issues.push(
				issue(
					"E_ASSET_TEXTURE_DIMENSIONS",
					`/images/${index}`,
					"Resize embedded textures below the reviewed dimension ceiling.",
					{ allowed: ASSET_LIMITS.maxTextureDimension },
				),
			);
		}
		if (pngInspection === undefined || !pngInspection.ok) {
			if (!oversizedDimensions) {
				issues.push(
					issue(
						"E_ASSET_TEXTURE_UNINSPECTED",
						`/images/${index}`,
						"Fully decode one bounded embedded PNG before accepting the texture.",
					),
				);
			}
			continue;
		}
		const decodedScanlineBytes = dimensions.decodedScanlineBytes;
		const decodedAdditionIsSafe =
			Number.isSafeInteger(decodedScanlineBytes) &&
			decodedScanlineBytes >= 0 &&
			metrics.decodedTextureBytes <=
				Number.MAX_SAFE_INTEGER - decodedScanlineBytes;
		if (decodedAdditionIsSafe)
			metrics.decodedTextureBytes += decodedScanlineBytes;
		if (
			!decodedAdditionIsSafe ||
			metrics.decodedTextureBytes > ASSET_LIMITS.maxDecodedTextureBytes
		) {
			issues.push(
				issue(
					"E_ASSET_TEXTURE_DECODE_BUDGET",
					`/images/${index}`,
					"Keep cumulative embedded PNG scanline decoding inside the structural work budget.",
					{ allowed: ASSET_LIMITS.maxDecodedTextureBytes },
				),
			);
			break;
		}
		metrics.maxTextureDimension = Math.max(
			metrics.maxTextureDimension,
			dimensions.width,
			dimensions.height,
		);
	}
	if (metrics.textureBytes > ASSET_LIMITS.maxTextureBytes) {
		issues.push(
			issue(
				"E_ASSET_TEXTURE_BYTES",
				"/images",
				"Reduce total embedded texture bytes.",
				{
					allowed: ASSET_LIMITS.maxTextureBytes,
				},
			),
		);
	}

	return { ok: issues.length === 0, issues, metrics };
}

function align4(value) {
	return (value + 3) & ~3;
}

function encodeGlb(document, binary) {
	const jsonBytes = Buffer.from(JSON.stringify(document), "utf8");
	const paddedJson = Buffer.alloc(align4(jsonBytes.length), 0x20);
	jsonBytes.copy(paddedJson);
	const paddedBinary = Buffer.alloc(align4(binary.length));
	binary.copy(paddedBinary);
	const totalLength = 12 + 8 + paddedJson.length + 8 + paddedBinary.length;
	const output = Buffer.alloc(totalLength);
	output.writeUInt32LE(0x46546c67, 0);
	output.writeUInt32LE(2, 4);
	output.writeUInt32LE(totalLength, 8);
	output.writeUInt32LE(paddedJson.length, 12);
	output.writeUInt32LE(0x4e4f534a, 16);
	paddedJson.copy(output, 20);
	const binaryHeader = 20 + paddedJson.length;
	output.writeUInt32LE(paddedBinary.length, binaryHeader);
	output.writeUInt32LE(0x004e4942, binaryHeader + 4);
	paddedBinary.copy(output, binaryHeader + 8);
	return output;
}

function createAnimatedRockGlb(source) {
	const chunks = glbChunks(source);
	const jsonChunk = chunks.find((chunk) => chunk.type === 0x4e4f534a);
	const binaryChunk = chunks.find((chunk) => chunk.type === 0x004e4942);
	if (!jsonChunk || !binaryChunk)
		throw new Error("E_ANIMATION_SOURCE_GLB: JSON or BIN chunk missing");
	const document = JSON.parse(decodeGlbJson(jsonChunk.data));
	const nodeIndex = (
		Array.isArray(document.nodes) ? document.nodes : []
	).findIndex((node) => Number.isInteger(node?.mesh));
	if (
		nodeIndex < 0 ||
		!Array.isArray(document.buffers) ||
		!Number.isSafeInteger(document.buffers[0]?.byteLength)
	) {
		throw new Error(
			"E_ANIMATION_SOURCE_GLB: animatable mesh node or embedded buffer missing",
		);
	}
	if (
		(Array.isArray(document.animations) ? document.animations : []).some(
			(animation) => animation?.name === "Idle",
		)
	) {
		throw new Error(
			"E_ANIMATION_SOURCE_GLB: source unexpectedly already declares Idle",
		);
	}

	let binary = Buffer.from(
		binaryChunk.data.subarray(0, document.buffers[0].byteLength),
	);
	function append(data) {
		const offset = align4(binary.length);
		binary = Buffer.concat([
			binary,
			Buffer.alloc(offset - binary.length),
			data,
		]);
		return offset;
	}

	const times = Buffer.alloc(3 * 4);
	for (const [index, value] of [0, 2, 4].entries())
		times.writeFloatLE(value, index * 4);
	const rotations = Buffer.alloc(3 * 4 * 4);
	const values = [
		0, 0, 0, 1, 0, 0.04361938685178757, 0, 0.9990482330322266, 0, 0, 0, 1,
	];
	for (const [index, value] of values.entries())
		rotations.writeFloatLE(value, index * 4);
	const timeOffset = append(times);
	const rotationOffset = append(rotations);

	document.bufferViews = Array.isArray(document.bufferViews)
		? document.bufferViews
		: [];
	const timeView =
		document.bufferViews.push({
			buffer: 0,
			byteOffset: timeOffset,
			byteLength: times.length,
		}) - 1;
	const rotationView =
		document.bufferViews.push({
			buffer: 0,
			byteOffset: rotationOffset,
			byteLength: rotations.length,
		}) - 1;
	document.accessors = Array.isArray(document.accessors)
		? document.accessors
		: [];
	const timeAccessor =
		document.accessors.push({
			bufferView: timeView,
			componentType: 5126,
			count: 3,
			type: "SCALAR",
			min: [0],
			max: [4],
		}) - 1;
	const rotationAccessor =
		document.accessors.push({
			bufferView: rotationView,
			componentType: 5126,
			count: 3,
			type: "VEC4",
		}) - 1;
	document.animations = Array.isArray(document.animations)
		? document.animations
		: [];
	document.animations.push({
		name: "Idle",
		samplers: [
			{
				input: timeAccessor,
				output: rotationAccessor,
				interpolation: "LINEAR",
			},
		],
		channels: [{ sampler: 0, target: { node: nodeIndex, path: "rotation" } }],
	});
	document.buffers[0].byteLength = binary.length;
	return encodeGlb(document, binary);
}

const LEVEL_MODEL_VARIANTS = Object.freeze({
	"snowfield-arena": Object.freeze({
		variant: "snowfield-arena",
		recipe: "compose-snowfield-arena-v1",
		sceneName: "Starter Snowfield Arena",
		composition: "flattened platform plus eight perimeter instances",
		modifications: Object.freeze([
			"flattened the retained rock mesh into one broad snowfield platform instance",
			"composed eight transformed perimeter instances from the retained mesh",
			"normalized deterministic filename",
		]),
		placements: Object.freeze([
			{
				name: "platform",
				translation: [0, -0.35, 0],
				rotation: [0, 0, 0, 1],
				scale: [9, 0.2, 9],
			},
			{
				name: "perimeter-north",
				translation: [0, 0, -6],
				rotation: [0, 0, 0, 1],
				scale: [1.4, 1.4, 0.7],
			},
			{
				name: "perimeter-south",
				translation: [0, 0, 6],
				rotation: [0, 1, 0, 0],
				scale: [1.4, 1.4, 0.7],
			},
			{
				name: "perimeter-east",
				translation: [6, 0, 0],
				rotation: [0, 0.7071067811865476, 0, 0.7071067811865476],
				scale: [1.4, 1.4, 0.7],
			},
			{
				name: "perimeter-west",
				translation: [-6, 0, 0],
				rotation: [0, -0.7071067811865476, 0, 0.7071067811865476],
				scale: [1.4, 1.4, 0.7],
			},
			{
				name: "perimeter-northeast",
				translation: [5, 0, -5],
				rotation: [0, 0.3826834323650898, 0, 0.9238795325112867],
				scale: [0.9, 1.2, 0.9],
			},
			{
				name: "perimeter-northwest",
				translation: [-5, 0, -5],
				rotation: [0, -0.3826834323650898, 0, 0.9238795325112867],
				scale: [0.9, 1.2, 0.9],
			},
			{
				name: "perimeter-southeast",
				translation: [5, 0, 5],
				rotation: [0, 0.9238795325112867, 0, 0.3826834323650898],
				scale: [0.9, 1.2, 0.9],
			},
			{
				name: "perimeter-southwest",
				translation: [-5, 0, 5],
				rotation: [0, -0.9238795325112867, 0, 0.3826834323650898],
				scale: [0.9, 1.2, 0.9],
			},
		]),
	}),
	"snowfield-layout": Object.freeze({
		variant: "snowfield-layout",
		recipe: "compose-snowfield-layout-v1",
		sceneName: "Starter Snowfield Layout",
		composition: "compact spawn, collectible, turn, and goal markers",
		modifications: Object.freeze([
			"composed five compact transformed placement markers from the retained rock mesh",
			"encoded spawn, collectible, and goal marker spacing in node transforms",
			"normalized deterministic filename",
		]),
		placements: Object.freeze([
			{
				name: "spawn",
				translation: [0, 0, 0],
				rotation: [0, 0, 0, 1],
				scale: [0.35, 0.12, 0.35],
			},
			{
				name: "collectible-left",
				translation: [-1.5, 0, 1],
				rotation: [0, -0.3826834323650898, 0, 0.9238795325112867],
				scale: [0.22, 0.45, 0.22],
			},
			{
				name: "collectible-right",
				translation: [1.5, 0, 1],
				rotation: [0, 0.3826834323650898, 0, 0.9238795325112867],
				scale: [0.22, 0.45, 0.22],
			},
			{
				name: "turn",
				translation: [0, 0, 2],
				rotation: [0, 0.7071067811865476, 0, 0.7071067811865476],
				scale: [0.25, 0.25, 0.55],
			},
			{
				name: "goal",
				translation: [0, 0, 3],
				rotation: [0, 0, 0, 1],
				scale: [0.45, 0.9, 0.45],
			},
		]),
	}),
});

function levelModelVariant(variant) {
	const reviewed = Object.hasOwn(LEVEL_MODEL_VARIANTS, variant)
		? LEVEL_MODEL_VARIANTS[variant]
		: undefined;
	if (reviewed === undefined) {
		throw new Error(`E_LEVEL_MODEL_VARIANT: unreviewed variant ${variant}`);
	}
	return reviewed;
}

function placementConfig(placements) {
	return Object.fromEntries(
		placements.map((placement, index) => [
			`placement${String(index).padStart(2, "0")}`,
			`${placement.name}|translation=${placement.translation.join(",")}|rotation=${placement.rotation.join(",")}|scale=${placement.scale.join(",")}`,
		]),
	);
}

function validLevelPlacement(placement) {
	const boundedVector = (value, length) =>
		Array.isArray(value) &&
		value.length === length &&
		value.every((coordinate) => Number.isFinite(coordinate)) &&
		value.every((coordinate) => Math.abs(coordinate) <= 16);
	return (
		typeof placement?.name === "string" &&
		placement.name.length > 0 &&
		placement.name.length <= 80 &&
		boundedVector(placement.translation, 3) &&
		boundedVector(placement.rotation, 4) &&
		boundedVector(placement.scale, 3) &&
		placement.scale.every((coordinate) => coordinate > 0)
	);
}

function createComposedRockGlb(source, variant) {
	const reviewed = levelModelVariant(variant);
	if (
		reviewed.placements.length === 0 ||
		reviewed.placements.length > 32 ||
		!reviewed.placements.every(validLevelPlacement)
	) {
		throw new Error(
			`E_LEVEL_MODEL_VARIANT: ${variant} has invalid or excessive placement work`,
		);
	}
	const chunks = glbChunks(source);
	const jsonChunk = chunks[0];
	const binaryChunk = chunks[1];
	if (
		chunks.length !== 2 ||
		jsonChunk?.type !== 0x4e4f534a ||
		binaryChunk?.type !== 0x004e4942
	) {
		throw new Error(
			"E_LEVEL_MODEL_SOURCE: reviewed source must contain exact JSON and BIN chunks",
		);
	}
	const document = JSON.parse(decodeGlbJson(jsonChunk.data));
	const baseMesh = Array.isArray(document.meshes) ? document.meshes[0] : undefined;
	const declaredBinaryBytes = Array.isArray(document.buffers)
		? document.buffers[0]?.byteLength
		: undefined;
	if (
		!plainObject(baseMesh) ||
		!Array.isArray(baseMesh.primitives) ||
		baseMesh.primitives.length === 0 ||
		!Number.isSafeInteger(declaredBinaryBytes) ||
		declaredBinaryBytes < 0 ||
		declaredBinaryBytes > binaryChunk.data.length
	) {
		throw new Error(
			"E_LEVEL_MODEL_SOURCE: reviewed source mesh or embedded buffer is invalid",
		);
	}

	document.asset = {
		...document.asset,
		generator: `@infinite-snowball/asset-pipeline ${reviewed.recipe}`,
	};
	document.meshes = reviewed.placements.map((placement, index) => ({
		...structuredClone(baseMesh),
		name: `${placement.name}-mesh-${String(index).padStart(2, "0")}`,
	}));
	document.nodes = reviewed.placements.map((placement, index) => ({
		name: placement.name,
		mesh: index,
		translation: [...placement.translation],
		rotation: [...placement.rotation],
		scale: [...placement.scale],
	}));
	document.scenes = [
		{
			name: reviewed.sceneName,
			nodes: reviewed.placements.map((_, index) => index),
		},
	];
	document.scene = 0;
	return encodeGlb(
		document,
		binaryChunk.data.subarray(0, declaredBinaryBytes),
	);
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1)
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(buffer) {
	let value = 0xffffffff;
	for (const byte of buffer)
		value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const typeBytes = Buffer.from(type, "ascii");
	const output = Buffer.alloc(12 + data.length);
	output.writeUInt32BE(data.length, 0);
	typeBytes.copy(output, 4);
	data.copy(output, 8);
	output.writeUInt32BE(
		crc32(Buffer.concat([typeBytes, data])),
		8 + data.length,
	);
	return output;
}

function createOriginalIcon() {
	const width = 64;
	const height = 64;
	const pixels = Buffer.alloc(height * (1 + width * 4));
	for (let y = 0; y < height; y += 1) {
		const row = y * (1 + width * 4);
		pixels[row] = 0;
		for (let x = 0; x < width; x += 1) {
			const offset = row + 1 + x * 4;
			const dx = x - 32;
			const dy = y - 34;
			const snow = dx * dx + dy * dy < 23 * 23;
			const rock = dx * dx * 2 + (dy + 2) * (dy + 2) * 3 < 17 * 17 * 2;
			const highlight = (x - 25) ** 2 + (y - 27) ** 2 < 6 * 6;
			const color = highlight
				? [255, 255, 255]
				: rock
					? [74, 93, 111]
					: snow
						? [239, 249, 255]
						: [37, 173, 196];
			pixels[offset] = color[0];
			pixels[offset + 1] = color[1];
			pixels[offset + 2] = color[2];
			pixels[offset + 3] = 255;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(pixels, { level: 9 })),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function createOriginalWav() {
	const sampleRate = 44_100;
	const channels = 2;
	const seconds = 4;
	const samples = sampleRate * seconds;
	const dataBytes = samples * channels * 2;
	const output = Buffer.alloc(44 + dataBytes);
	output.write("RIFF", 0, "ascii");
	output.writeUInt32LE(36 + dataBytes, 4);
	output.write("WAVE", 8, "ascii");
	output.write("fmt ", 12, "ascii");
	output.writeUInt32LE(16, 16);
	output.writeUInt16LE(1, 20);
	output.writeUInt16LE(channels, 22);
	output.writeUInt32LE(sampleRate, 24);
	output.writeUInt32LE(sampleRate * channels * 2, 28);
	output.writeUInt16LE(channels * 2, 32);
	output.writeUInt16LE(16, 34);
	output.write("data", 36, "ascii");
	output.writeUInt32LE(dataBytes, 40);
	const notes = [220, 277, 330, 440, 330, 277, 247, 220];
	for (let index = 0; index < samples; index += 1) {
		const segment = Math.min(
			notes.length - 1,
			Math.floor((index * notes.length) / samples),
		);
		const frequency = notes[segment];
		const phase = (index * frequency) % sampleRate;
		const triangle = Math.abs(phase * 2 - sampleRate) * 2 - sampleRate;
		const fade = Math.min(index, samples - 1 - index, 2_205);
		const envelope = Math.max(0, fade) / 2_205;
		const left = Math.trunc((triangle * 3_200 * envelope) / sampleRate);
		const rightPhase = ((index + 47) * frequency) % sampleRate;
		const rightTriangle =
			Math.abs(rightPhase * 2 - sampleRate) * 2 - sampleRate;
		const right = Math.trunc((rightTriangle * 3_000 * envelope) / sampleRate);
		const offset = 44 + index * 4;
		output.writeInt16LE(left, offset);
		output.writeInt16LE(right, offset + 2);
	}
	return output;
}

const RETAINED_EVIDENCE_KEYS = [
	"schemaVersion",
	"provider",
	"pack",
	"sourceUrl",
	"archiveFile",
	"archiveBytes",
	"archiveSha256",
	"sourceMember",
	"sourceArtifactSha256",
	"creator",
	"acquiredAt",
	"license",
	"preview",
	"reviewer",
	"reviewedAt",
	"evidenceStatus",
	"notes",
	"replacement",
];
const RETAINED_LICENSE_KEYS = [
	"spdx",
	"url",
	"member",
	"textPath",
	"textSha256",
];
const RETAINED_PREVIEW_KEYS = ["member", "path", "sha256"];
const RETAINED_SOURCE_FILES = Object.freeze({
	"License.txt": true,
	"rock_smallA-preview.png": true,
	"rock_smallA.glb": true,
	"source-evidence.json": true,
});
const RETAINED_SOURCE_LIMITS = Object.freeze({
	maxEntries: Object.keys(RETAINED_SOURCE_FILES).length,
	maxFiles: Object.keys(RETAINED_SOURCE_FILES).length,
	maxDepth: 1,
	maxFileBytes: ASSET_LIMITS.maxFileBytes,
	maxTotalBytes: ASSET_LIMITS.maxStarterBytes,
});
const PROJECT_LICENSE_RELATIVE_PATH =
	"docs/licenses/provenance/infinite-snowball-original-content/CC0-1.0.txt";
const PROJECT_LICENSE_SHA256 =
	"2f96dd1453e0a4047713aa6cdb4fcdbec8666e12286012f4993ad628bc70d75c";
const PROJECT_LICENSE_LIMITS = Object.freeze({
	maxEntries: 1,
	maxFiles: 1,
	maxDepth: 1,
	maxFileBytes: 64 * 1024,
	maxTotalBytes: 64 * 1024,
});


function hasExactKeys(value, expected) {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === expected.length &&
		expected.every((key) => Object.hasOwn(value, key))
	);
}

async function assertRetainedSourceTree(sourceRoot) {
	const inventory = await inventoryTree(sourceRoot, RETAINED_SOURCE_LIMITS);
	const files = inventory.entries.filter((entry) => entry.kind === "file");
	const unexpected = inventory.entries.find(
		(entry) =>
			entry.kind !== "file" ||
			!Object.hasOwn(RETAINED_SOURCE_FILES, entry.relativePath),
	);
	const missing = Object.keys(RETAINED_SOURCE_FILES).find(
		(path) => !files.some((entry) => entry.relativePath === path),
	);
	if (
		!inventory.ok ||
		unexpected !== undefined ||
		missing !== undefined ||
		files.length !== Object.keys(RETAINED_SOURCE_FILES).length
	) {
		throw new Error(
			"E_RETAINED_SOURCE_EVIDENCE: retained source tree must exactly contain reviewed regular files",
		);
	}
	return new Map(files.map((entry) => [entry.relativePath, entry]));
}
export async function readProjectLicenseBytes(root, options = {}) {
	const licensePath = join(root, PROJECT_LICENSE_RELATIVE_PATH);
	const licenseRoot = dirname(licensePath);
	const inventory = await inventoryTree(licenseRoot, PROJECT_LICENSE_LIMITS);
	const file = inventory.entries.find(
		(entry) => entry.kind === "file" && entry.relativePath === "CC0-1.0.txt",
	);
	if (
		!inventory.ok ||
		inventory.rootRealpath !== licenseRoot ||
		inventory.entries.length !== 1 ||
		file === undefined
	) {
		throw new Error(
			"E_PROJECT_LICENSE: project CC0 must be the exact reviewed regular file in its canonical directory",
		);
	}
	let bytes;
	try {
		bytes = await readInventoriedFile(file, options);
	} catch (cause) {
		throw new Error(
			"E_PROJECT_LICENSE: project CC0 changed after bounded inventory",
			{ cause },
		);
	}
	if (sha256(bytes) !== PROJECT_LICENSE_SHA256) {
		throw new Error(
			"E_PROJECT_LICENSE: project CC0 bytes do not match the reviewed license",
		);
	}
	return bytes;
}


function assertRetainedEvidence(evidence) {
	const license = evidence?.license;
	const preview = evidence?.preview;
	const valid =
		hasExactKeys(evidence, RETAINED_EVIDENCE_KEYS) &&
		hasExactKeys(license, RETAINED_LICENSE_KEYS) &&
		hasExactKeys(preview, RETAINED_PREVIEW_KEYS) &&
		evidence.schemaVersion === 1 &&
		evidence.provider === "Kenney" &&
		evidence.pack === "Nature Kit" &&
		evidence.creator === evidence.provider &&
		evidence.sourceUrl === "https://kenney.nl/assets/nature-kit" &&
		evidence.archiveFile === "kenney-nature-kit.zip" &&
		evidence.archiveBytes === 10_537_521 &&
		evidence.archiveSha256 ===
			"fa7974a0d342bfe63c38664ba9f8ec1a4aab8ea25f099bdc56870e33588c4d9d" &&
		evidence.sourceMember === "Models/GLTF format/rock_smallA.glb" &&
		evidence.sourceArtifactSha256 ===
			"df9fff9d711e61370e8df0caa2514c89b8f8a8dc6c6fafaf4eb2ec79c5ae07c1" &&
		evidence.acquiredAt === "2026-07-15T00:00:00.000Z" &&
		license.spdx === "CC0-1.0" &&
		license.url === "https://creativecommons.org/publicdomain/zero/1.0/" &&
		license.member === "License.txt" &&
		license.textPath === "License.txt" &&
		license.textSha256 ===
			"cb96b75e3560ac78d7a53ce6f083f4cdb5c53faea6141b62d63458dcfe1e4b9d" &&
		preview.member === "Isometric/rock_smallA_NE.png" &&
		preview.path === "rock_smallA-preview.png" &&
		preview.sha256 ===
			"9ac0749d7657e4b46020e260ef0b8b09c2a829fb2950fdcc1f64b9ffcdd77875" &&
		evidence.reviewer === "Infinite Snowball P03 provenance review" &&
		evidence.reviewedAt === "2026-07-15T00:00:00.000Z" &&
		evidence.evidenceStatus === "verified" &&
		evidence.replacement === null &&
		typeof evidence.notes === "string" &&
		evidence.notes.length > 0;
	if (!valid) {
		throw new Error(
			"E_RETAINED_SOURCE_EVIDENCE: state, license, creator, source, reviewer, or hashes are not the complete reviewed record",
		);
	}
}

function manifestMetadata(
	title,
	description,
	screenshots = ["assets/icon.png"],
) {
	return {
		title: { default: title, translations: {} },
		description: { default: description, translations: {} },
		author: {
			name: "Infinite Snowball contributors",
			url: "https://github.com/jeffscottward/infinite-snowball",
		},
		homepage: "https://github.com/jeffscottward/infinite-snowball",
		repository: "https://github.com/jeffscottward/infinite-snowball",
		screenshots,
		icon: "assets/icon.png",
		tags: ["infinite-snowball", "starter", "original-web-game"],
	};
}

function transformation(recipe, config) {
	return {
		recipe,
		tool: {
			name: "@infinite-snowball/asset-pipeline",
			version: PIPELINE_CONFIG.toolVersion,
		},
		config,
		configSha256: canonicalConfigSha256(config),
	};
}

const TRANSFORMATION_FORMAT_BY_EXTENSION = Object.freeze({
	".glb": Object.freeze({ mime: "model/gltf-binary", format: "glb" }),
	".png": Object.freeze({ mime: "image/png", format: "rgba-png" }),
	".wav": Object.freeze({ mime: "audio/wav", format: "pcm16-stereo-wav" }),
});

function transformationFormat(path, mime) {
	const reviewed = TRANSFORMATION_FORMAT_BY_EXTENSION[extname(path).toLowerCase()];
	if (reviewed?.mime !== mime) {
		throw new Error(
			`E_TRANSFORMATION_FORMAT: output path and MIME are not a reviewed media pair: ${path} (${mime})`,
		);
	}
	return reviewed.format;
}

function originalProvenance(
	bytes,
	path,
	mime,
	role,
	sourceSha256,
	licenseSha256,
) {
	const outputSha256 = sha256(bytes);
	return {
		creator: "Infinite Snowball contributors",
		source:
			"https://github.com/jeffscottward/infinite-snowball/tree/main/tools/assets/lib/asset-pipeline.mjs",
		acquisition:
			"generated deterministically from reviewed repository source on 2026-07-15",
		sourceArtifactSha256: sourceSha256,
		modifications: [
			`generated original ${role}`,
			"normalized deterministic filename",
		],
		outputSha256,
		reviewer: "Infinite Snowball P03 provenance review",
		reviewedAt: "2026-07-15T00:00:00.000Z",
		evidenceStatus: "verified",
		notes: "Original generated starter-content asset dedicated under CC0 1.0.",
		attribution:
			"Infinite Snowball contributors, CC0 1.0; attribution not required.",
		transformation: transformation(`generate-${role}-v1`, {
			deterministic: true,
			format: transformationFormat(path, mime),
			pipelineConfigSha256: CONFIG_SHA256,
		}),
		replacement: null,
		licenseSha256,
	};
}

function kenneyProvenance(
	bytes,
	path,
	mime,
	role,
	evidence,
	sourceHash,
	variant = "exact-copy",
) {
	const animated = variant === "decorative-idle";
	const composition = Object.hasOwn(LEVEL_MODEL_VARIANTS, variant)
		? levelModelVariant(variant)
		: undefined;
	if (variant !== "exact-copy" && !animated && composition === undefined) {
		throw new Error(`E_KENNEY_VARIANT: unreviewed variant ${variant}`);
	}
	const sourceMember =
		role === "screenshot" ? evidence.preview.member : evidence.sourceMember;
	const modifications =
		composition?.modifications ??
		(animated
			? [
					"added embedded Idle rotation animation with three deterministic keyframes",
					"normalized deterministic filename",
				]
			: ["retained exact source bytes", "normalized deterministic filename"]);
	const recipe =
		composition?.recipe ??
		(animated
			? "add-decorative-idle-animation-v1"
			: "copy-self-contained-glb-or-preview-v1");
	const config =
		composition === undefined
			? {
					deterministic: true,
					format: transformationFormat(path, mime),
					sourceMember,
					animationClip: animated ? "Idle" : "none",
					animationKeyframes: animated ? 3 : 0,
					pipelineConfigSha256: CONFIG_SHA256,
				}
			: {
					deterministic: true,
					format: transformationFormat(path, mime),
					sourceMember,
					variant: composition.variant,
					sceneName: composition.sceneName,
					composition: composition.composition,
					instanceCount: composition.placements.length,
					...placementConfig(composition.placements),
					pipelineConfigSha256: CONFIG_SHA256,
				};
	return {
		creator: evidence.creator,
		source: evidence.sourceUrl,
		acquisition:
			composition === undefined
				? `exact retained member ${sourceMember}; archive SHA-256 ${evidence.archiveSha256}`
				: `derived deterministically from retained member ${sourceMember}; archive SHA-256 ${evidence.archiveSha256}`,
		sourceArtifactSha256: sourceHash,
		modifications,
		outputSha256: sha256(bytes),
		reviewer: evidence.reviewer,
		reviewedAt: evidence.reviewedAt,
		evidenceStatus: evidence.evidenceStatus,
		notes: evidence.notes,
		attribution: `${evidence.creator} ${evidence.pack}, ${evidence.license.spdx}; attribution not required.`,
		transformation: transformation(recipe, config),
		replacement: null,
	};
}

function assetRecord({
	id,
	path,
	mime,
	role,
	bytes,
	provenance,
	licenseSha256,
	license = "CC0-1.0",
	licenseUrl = "https://creativecommons.org/publicdomain/zero/1.0/",
}) {
	const digest = sha256(bytes);
	const cleanProvenance = { ...provenance };
	delete cleanProvenance.licenseSha256;
	return {
		assetId: id,
		path,
		mime,
		bytes: bytes.length,
		sha256: digest,
		role,
		license,
		licenseUrl,
		capturedLicenseSha256: licenseSha256,
		provenance: cleanProvenance,
	};
}

function totals(assets) {
	const bytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
	return {
		bytes,
		fileCount: assets.length,
		uncompressedBytes: bytes,
		maxDepth: 2,
		maxCompressionRatio: 1,
	};
}

function commonManifest(template, { name, kind, title, description, assets }) {
	return {
		...template,
		schemaVersion: "1.0.0",
		name,
		version: "1.0.0",
		kind,
		engine: ">=1.0.0 <2.0.0",
		metadata: manifestMetadata(title, description),
		license: "CC0-1.0",
		dependencies: [],
		optionalPeers: [],
		assets,
		totals: totals(assets),
		capabilities: {},
	};
}

function refFor(manifest, artifact) {
	return {
		name: manifest.name,
		version: manifest.version,
		kind: manifest.kind,
		engine: manifest.engine,
		integrity: artifact.integrity,
		manifestSha256: artifact.manifestSha256,
		catalogEntryId: `catalog:${manifest.name.replace("@infinite-snowball/", "")}:${manifest.version}`,
	};
}

function containedOutputPath(root, target, allowRoot = false) {
	const path = relative(root, target);
	return (
		(path !== "" || allowRoot) &&
		!isAbsolute(path) &&
		path !== ".." &&
		!path.startsWith(`..${sep}`)
	);
}

async function canonicalOwnedDirectory(path, expectedUid) {
	let stats;
	let canonical;
	try {
		stats = await lstat(path);
		canonical = await realpath(path);
	} catch (cause) {
		throw new Error(`E_OUTPUT_ROOT: ${path} must be a canonical directory`, {
			cause,
		});
	}
	const processUid =
		typeof process.getuid === "function" ? process.getuid() : stats.uid;
	if (
		stats.isSymbolicLink() ||
		!stats.isDirectory() ||
		canonical !== path ||
		stats.uid !== processUid ||
		(expectedUid !== undefined && stats.uid !== expectedUid)
	) {
		throw new Error(
			`E_OUTPUT_ROOT: ${path} must be a real owned canonical directory`,
		);
	}
	return {
		path,
		realpath: canonical,
		dev: stats.dev,
		ino: stats.ino,
		uid: stats.uid,
	};
}

async function prepareRebuildOutput(root, outputRoot) {
	const rootIdentity = await canonicalOwnedDirectory(root);
	if (!containedOutputPath(rootIdentity.realpath, outputRoot)) {
		throw new Error(
			"E_OUTPUT_ROOT: rebuild output must be a strict descendant of the canonical root",
		);
	}
	const firstRelativeSegment = relative(
		rootIdentity.realpath,
		outputRoot,
	).split(sep)[0];
	if (
		outputRoot !== join(rootIdentity.realpath, "content") &&
		!basename(rootIdentity.realpath).startsWith(".tmp-infinite-snowball-") &&
		!firstRelativeSegment.startsWith(".tmp-infinite-snowball-")
	) {
		throw new Error(
			"E_OUTPUT_ROOT: explicit rebuild output is restricted to a contained temporary test root",
		);
	}
	let missing = false;
	try {
		await lstat(outputRoot);
	} catch (cause) {
		if (cause?.code !== "ENOENT") {
			throw new Error(
				"E_OUTPUT_ROOT: rebuild output cannot be inspected safely",
				{ cause },
			);
		}
		missing = true;
	}
	if (missing) {
		const parent = dirname(outputRoot);
		const parentIdentity = await canonicalOwnedDirectory(parent, rootIdentity.uid);
		if (
			!containedOutputPath(rootIdentity.realpath, parentIdentity.realpath, true)
		) {
			throw new Error(
				"E_OUTPUT_ROOT: a missing rebuild output requires one contained owned parent",
			);
		}
		await mkdir(outputRoot);
	}
	const outputIdentity = await canonicalOwnedDirectory(
		outputRoot,
		rootIdentity.uid,
	);
	if (!containedOutputPath(rootIdentity.realpath, outputIdentity.realpath)) {
		throw new Error(
			"E_OUTPUT_ROOT: canonical rebuild output escaped the canonical root",
		);
	}
	return { root: rootIdentity, output: outputIdentity };
}

async function assertRebuildOutputIdentity(guard) {
	const root = await canonicalOwnedDirectory(guard.root.path, guard.root.uid);
	const output = await canonicalOwnedDirectory(
		guard.output.path,
		guard.root.uid,
	);
	if (
		root.dev !== guard.root.dev ||
		root.ino !== guard.root.ino ||
		output.dev !== guard.output.dev ||
		output.ino !== guard.output.ino ||
		!containedOutputPath(root.realpath, output.realpath)
	) {
		throw new Error(
			"E_OUTPUT_ROOT: rebuild root or output identity changed before mutation",
		);
	}
}

async function writePackage(outputGuard, packageName, manifest, assetBytes) {
	const artifact = buildDeterministicPackageArtifact(manifest, assetBytes);
	await assertRebuildOutputIdentity(outputGuard);
	const directory = join(outputGuard.output.path, packageName);
	await rm(directory, { recursive: true, force: true });
	await mkdir(directory, { recursive: true });
	for (const [assetPath, bytes] of [...assetBytes.entries()].sort(
		([left], [right]) => compareCodeUnits(left, right),
	)) {
		const target = join(directory, assetPath);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, bytes);
	}
	await writeFile(join(directory, "manifest.json"), artifact.manifestBytes);
	return artifact;
}

const STARTER_TEMPLATE_FILES = Object.freeze({
	object: "object-pack.json",
	character: "character.json",
	music: "music.json",
	level: "level.json",
	campaign: "campaign.json",
});
const STARTER_TEMPLATE_LIMITS = Object.freeze({
	maxEntries: Object.keys(STARTER_TEMPLATE_FILES).length,
	maxFiles: Object.keys(STARTER_TEMPLATE_FILES).length,
	maxDepth: 1,
	maxFileBytes: 8 * 1024,
	maxTotalBytes: 32 * 1024,
});

export async function readStarterTemplates(root, options = {}) {
	const templateRoot = join(root, "tools", "assets", "templates");
	const inventory = await inventoryTree(templateRoot, STARTER_TEMPLATE_LIMITS);
	const files = inventory.entries.filter((entry) => entry.kind === "file");
	const reviewedPaths = new Set(Object.values(STARTER_TEMPLATE_FILES));
	const unexpected = inventory.entries.find(
		(entry) =>
			entry.kind !== "file" || !reviewedPaths.has(entry.relativePath),
	);
	const byPath = new Map(files.map((entry) => [entry.relativePath, entry]));
	const missing = [...reviewedPaths].find((path) => !byPath.has(path));
	if (
		!inventory.ok ||
		inventory.rootRealpath !== templateRoot ||
		unexpected !== undefined ||
		missing !== undefined ||
		files.length !== reviewedPaths.size
	) {
		throw new Error(
			"E_TEMPLATE_TREE: starter template tree must exactly contain the five reviewed regular JSON files",
		);
	}

	const bytesByPath = new Map();
	for (const path of reviewedPaths) {
		try {
			bytesByPath.set(
				path,
				await readInventoriedFile(byPath.get(path), {
					afterIdentityCheck:
						options.afterIdentityCheck === undefined
							? undefined
							: () => options.afterIdentityCheck(path),
				}),
			);
		} catch (cause) {
			throw new Error(
				`E_TEMPLATE_TREE: ${path} changed after bounded inventory`,
				{ cause },
			);
		}
	}

	const templates = {};
	for (const [key, path] of Object.entries(STARTER_TEMPLATE_FILES)) {
		templates[key] = parseCanonicalTabJson(
			bytesByPath.get(path),
			"E_TEMPLATE_TREE",
			path,
		);
	}
	return templates;
}

function assetForOriginal({
	id,
	path,
	mime,
	role,
	bytes,
	sourceSha256,
	licenseSha256,
}) {
	return assetRecord({
		id,
		path,
		mime,
		role,
		bytes,
		provenance: originalProvenance(
			bytes,
			path,
			mime,
			role,
			sourceSha256,
			licenseSha256,
		),
		licenseSha256,
	});
}

function assetForKenney({
	id,
	path,
	mime,
	role,
	bytes,
	evidence,
	sourceHash,
	variant = "exact-copy",
}) {
	return assetRecord({
		id,
		path,
		mime,
		role,
		bytes,
		provenance: kenneyProvenance(
			bytes,
			path,
			mime,
			role,
			evidence,
			sourceHash,
			variant,
		),
		license: evidence.license.spdx,
		licenseUrl: evidence.license.url,
		licenseSha256: evidence.license.textSha256,
	});
}

export async function rebuildStarterContent(options = {}) {
	assertAuditedNodeRuntime();
	const root = resolve(options.root ?? process.cwd());
	const outputRoot = resolve(options.outputRoot ?? join(root, "content"));
	const templates = await readStarterTemplates(root);
	const sourceRoot = join(
		root,
		"tools",
		"assets",
		"sources",
		"kenney-nature-kit",
	);
	const retainedFiles = await assertRetainedSourceTree(sourceRoot);
	const evidence = parseCanonicalTabJson(
		await readInventoriedFile(retainedFiles.get("source-evidence.json")),
		"E_RETAINED_SOURCE_EVIDENCE",
		"source-evidence.json",
	);
	assertRetainedEvidence(evidence);
	const model = await readInventoriedFile(retainedFiles.get("rock_smallA.glb"));
	const preview = await readInventoriedFile(
		retainedFiles.get("rock_smallA-preview.png"),
	);
	const capturedLicense = await readInventoriedFile(
		retainedFiles.get("License.txt"),
	);
	const originalLicense = await readProjectLicenseBytes(root);
	const moduleBytes = await readFile(MODULE_PATH);
	const moduleSha256 = sha256(moduleBytes);
	const originalLicenseSha256 = sha256(originalLicense);

	if (
		sha256(model) !== evidence.sourceArtifactSha256 ||
		sha256(preview) !== evidence.preview.sha256 ||
		sha256(capturedLicense) !== evidence.license.textSha256
	) {
		throw new Error(
			"E_RETAINED_SOURCE_EVIDENCE: retained hashes do not match exact reviewed bytes",
		);
	}
	const modelInspection = inspectGlb(model);
	if (!modelInspection.ok) {
		throw new Error(
			`E_RETAINED_SOURCE_GLB: ${modelInspection.issues.map((entry) => entry.ruleId).join(",")}`,
		);
	}
	const previewInspection = inspectPng(preview);
	if (!previewInspection.ok) {
		throw new Error(
			`E_RETAINED_SOURCE_EVIDENCE: retained preview is not a complete PNG (${previewInspection.issues.map((entry) => entry.ruleId).join(",")})`,
		);
	}
	const animatedModel = createAnimatedRockGlb(model);
	const animatedModelInspection = inspectGlb(animatedModel);
	if (
		!animatedModelInspection.ok ||
		!animatedModelInspection.metrics.animationClips.includes("Idle")
	) {
		throw new Error(
			`E_ANIMATED_CHARACTER_GLB: ${animatedModelInspection.issues.map((entry) => entry.ruleId).join(",") || "Idle missing"}`,
		);
	}
	const arenaModel = createComposedRockGlb(model, "snowfield-arena");
	const layoutModel = createComposedRockGlb(model, "snowfield-layout");
	const arenaModelInspection = inspectGlb(arenaModel);
	const layoutModelInspection = inspectGlb(layoutModel);
	const levelModelHashes = [
		sha256(model),
		sha256(arenaModel),
		sha256(layoutModel),
	];
	if (
		!arenaModelInspection.ok ||
		!layoutModelInspection.ok ||
		new Set(levelModelHashes).size !== levelModelHashes.length
	) {
		throw new Error(
			`E_LEVEL_MODEL_VARIANTS: source, arena, and layout GLBs must be valid and byte-distinct (${[
				...arenaModelInspection.issues,
				...layoutModelInspection.issues,
			]
				.map((entry) => entry.ruleId)
				.join(",") || "duplicate hash"})`,
		);
	}

	const icon = createOriginalIcon();
	const track = createOriginalWav();
	const iconInspection = inspectPng(icon);
	const trackInspection = inspectWav(track);
	if (!iconInspection.ok || !trackInspection.ok) {
		throw new Error(
			"E_GENERATED_MEDIA: deterministic PNG and WAV outputs must fully decode",
		);
	}
	const outputGuard = await prepareRebuildOutput(root, outputRoot);

	const iconAsset = (role = "icon") =>
		assetForOriginal({
			id: role === "icon" ? "icon" : role,
			path: role === "icon" ? "assets/icon.png" : `assets/${role}.png`,
			mime: "image/png",
			role,
			bytes: icon,
			sourceSha256: moduleSha256,
			licenseSha256: originalLicenseSha256,
		});

	const objectAssets = [
		iconAsset(),
		assetForKenney({
			id: "render",
			path: "assets/rock-small-a.glb",
			mime: "model/gltf-binary",
			role: "render-model",
			bytes: model,
			evidence,
			sourceHash: evidence.sourceArtifactSha256,
		}),
		assetForKenney({
			id: "collider",
			path: "assets/rock-small-a-collider.glb",
			mime: "model/gltf-binary",
			role: "collider",
			bytes: model,
			evidence,
			sourceHash: evidence.sourceArtifactSha256,
		}),
		assetForKenney({
			id: "goal-render",
			path: "assets/goal-stone.glb",
			mime: "model/gltf-binary",
			role: "render-model",
			bytes: model,
			evidence,
			sourceHash: evidence.sourceArtifactSha256,
		}),
		assetForKenney({
			id: "goal-collider",
			path: "assets/goal-stone-collider.glb",
			mime: "model/gltf-binary",
			role: "collider",
			bytes: model,
			evidence,
			sourceHash: evidence.sourceArtifactSha256,
		}),
	];
	const objectManifest = commonManifest(templates.object, {
		name: "@infinite-snowball/starter-objects",
		kind: "object-pack",
		title: "Starter Snowfield Objects",
		description:
			"A cleared low-poly pebble used by the first original snowfield prototype.",
		assets: objectAssets,
	});
	objectManifest.entries = [
		{
			...templates.object.entries[0],
			objectPackId: "starter-objects",
			display: {
				title: { default: "Starter Pebbles", translations: {} },
				description: {
					default: "Small collectible rocks for a snowy beginner arena.",
					translations: {},
				},
			},
			objects: [
				{
					...templates.object.entries[0].objects[0],
					objectId: "starter-rock",
					radius: 0.35,
					volume: 0.18,
					points: 25,
					category: "stone",
					colliderAssetId: "collider",
					renderAssetId: "render",
					lodAssetIds: [],
					budgets: {
						maxTriangles: Math.max(1, modelInspection.metrics.triangles),
						maxBytes: model.length,
					},
				},
				{
					...templates.object.entries[0].objects[0],
					objectId: "goal-stone",
					radius: 0.75,
					volume: 1.75,
					points: 0,
					category: "goal",
					colliderAssetId: "goal-collider",
					renderAssetId: "goal-render",
					attachPolicy: "never",
					lodAssetIds: [],
					budgets: {
						maxTriangles: Math.max(1, modelInspection.metrics.triangles),
						maxBytes: model.length,
					},
				},
			],
		},
	];
	const objectAssetBytes = new Map([
		["assets/icon.png", icon],
		["assets/rock-small-a.glb", model],
		["assets/rock-small-a-collider.glb", model],
		["assets/goal-stone.glb", model],
		["assets/goal-stone-collider.glb", model],
	]);
	const objectArtifact = await writePackage(
		outputGuard,
		"starter-objects",
		objectManifest,
		objectAssetBytes,
	);
	const objectRef = refFor(objectArtifact.manifest, objectArtifact);

	const musicAssets = [
		iconAsset(),
		assetForOriginal({
			id: "track",
			path: "assets/snowdrift-signal.wav",
			mime: "audio/wav",
			role: "music-track",
			bytes: track,
			sourceSha256: moduleSha256,
			licenseSha256: originalLicenseSha256,
		}),
	];
	const musicTrackAsset = musicAssets.find(
		(asset) => asset.assetId === "track",
	);
	const musicManifest = commonManifest(templates.music, {
		name: "@infinite-snowball/starter-music",
		kind: "music",
		title: "Starter Snowfield Music",
		description:
			"An original deterministic four-second loop for local prototype playback.",
		assets: musicAssets,
	});
	musicManifest.entries = [
		{
			...templates.music.entries[0],
			musicPackId: "starter-music",
			display: {
				title: { default: "Snowdrift Signal", translations: {} },
				description: {
					default: "A short original CC0 triangle-wave loop.",
					translations: {},
				},
			},
			tracks: [
				{
					trackId: "snowdrift-signal",
					assetId: "track",
					title: "Snowdrift Signal",
					creator: musicTrackAsset.provenance.creator,
					source: musicTrackAsset.provenance.source,
					attribution: musicTrackAsset.provenance.attribution,
					license: musicTrackAsset.license,
					durationSeconds: trackInspection.metrics.durationSeconds,
					loop: {
						startSeconds: 0,
						endSeconds: trackInspection.metrics.durationSeconds,
					},
					cues: [{ id: "turn", atSeconds: 2 }],
					bus: "music",
					channels: trackInspection.metrics.channels,
					sampleRate: trackInspection.metrics.sampleRate,
				},
			],
			maxBytes: 8 * 1024 * 1024,
			maxTracks: 1,
		},
	];
	const musicArtifact = await writePackage(
		outputGuard,
		"starter-music",
		musicManifest,
		new Map([
			["assets/icon.png", icon],
			["assets/snowdrift-signal.wav", track],
		]),
	);
	const musicRef = refFor(musicArtifact.manifest, musicArtifact);

	const characterAssets = [
		iconAsset(),
		assetForKenney({
			id: "model",
			path: "assets/pebble-friend.glb",
			mime: "model/gltf-binary",
			role: "character-model",
			bytes: animatedModel,
			evidence,
			sourceHash: evidence.sourceArtifactSha256,
			variant: "decorative-idle",
		}),
		assetForKenney({
			id: "shot",
			path: "assets/pebble-friend-preview.png",
			mime: "image/png",
			role: "screenshot",
			bytes: preview,
			evidence,
			sourceHash: evidence.preview.sha256,
		}),
	];
	const characterManifest = commonManifest(templates.character, {
		name: "@infinite-snowball/starter-character",
		kind: "character",
		title: "Pebble Friend",
		description: "A decorative CC0 rock companion for the first prototype.",
		assets: characterAssets,
	});
	characterManifest.metadata.screenshots = ["assets/pebble-friend-preview.png"];
	characterManifest.entries = [
		{
			...templates.character.entries[0],
			characterId: "pebble-friend",
			display: {
				title: { default: "Pebble Friend", translations: {} },
				description: {
					default: "A quiet decorative snowfield companion.",
					translations: {},
				},
			},
			modelAssetId: "model",
			animationClips: [{ id: "idle", clip: "Idle" }],
			scale: 1,
			bounds: { radius: 0.5, height: 0.5 },
			controllerPreset: "decorative-only",
			iconAssetId: "icon",
			screenshotAssetIds: ["shot"],
			license: evidence.license.spdx,
			provenanceAssetIds: ["model", "shot"],
		},
	];
	const characterArtifact = await writePackage(
		outputGuard,
		"starter-character",
		characterManifest,
		new Map([
			["assets/icon.png", icon],
			["assets/pebble-friend.glb", animatedModel],
			["assets/pebble-friend-preview.png", preview],
		]),
	);
	const characterRef = refFor(characterArtifact.manifest, characterArtifact);

	const levelAssets = [
		iconAsset(),
		assetForKenney({
			id: "arena",
			path: "assets/snowfield-arena.glb",
			mime: "model/gltf-binary",
			role: "arena",
			bytes: arenaModel,
			evidence,
			sourceHash: evidence.sourceArtifactSha256,
			variant: "snowfield-arena",
		}),
		assetForKenney({
			id: "layout",
			path: "assets/snowfield-layout.glb",
			mime: "model/gltf-binary",
			role: "layout",
			bytes: layoutModel,
			evidence,
			sourceHash: evidence.sourceArtifactSha256,
			variant: "snowfield-layout",
		}),
	];
	const levelManifest = commonManifest(templates.level, {
		name: "@infinite-snowball/starter-level",
		kind: "level",
		title: "Starter Snowfield",
		description:
			"A minimal data-only level contract for the first playable prototype.",
		assets: levelAssets,
	});
	levelManifest.dependencies = [objectRef, musicRef];
	levelManifest.entries = [
		{
			...templates.level.entries[0],
			levelId: "starter-snowfield",
			display: {
				title: { default: "Starter Snowfield", translations: {} },
				description: {
					default: "A compact ninety-second original winter arena.",
					translations: {},
				},
			},
			arenaAssetId: "arena",
			layoutAssetId: "layout",
			collectibleGroups: [
				{
					id: "starter-stones",
					objectPack: objectRef,
					objectIds: ["starter-rock"],
				},
			],
			finalGoal: { objectId: "goal-stone", position: [0, 0, 12] },
			musicRefs: [musicRef],
			budgets: {
				maxTriangles: Math.max(
					1,
					arenaModelInspection.metrics.triangles +
						layoutModelInspection.metrics.triangles,
				),
				maxDrawCalls: 16,
				maxPhysicsBodies: 128,
				maxBytes: arenaModel.length + layoutModel.length + icon.length,
			},
		},
	];
	const levelArtifact = await writePackage(
		outputGuard,
		"starter-level",
		levelManifest,
		new Map([
			["assets/icon.png", icon],
			["assets/snowfield-arena.glb", arenaModel],
			["assets/snowfield-layout.glb", layoutModel],
		]),
	);
	const levelRef = refFor(levelArtifact.manifest, levelArtifact);

	const campaignAssets = [iconAsset()];
	const campaignManifest = commonManifest(templates.campaign, {
		name: "@infinite-snowball/starter-campaign",
		kind: "campaign",
		title: "A Small Beginning",
		description: "The first original Infinite Snowball campaign contract.",
		assets: campaignAssets,
	});
	campaignManifest.dependencies = [levelRef, objectRef, characterRef, musicRef];
	campaignManifest.entries = [
		{
			...templates.campaign.entries[0],
			campaignId: "a-small-beginning",
			display: {
				title: { default: "A Small Beginning", translations: {} },
				description: {
					default:
						"Roll through the starter snowfield and meet a pebble friend.",
					translations: {},
				},
			},
			levels: [{ package: levelRef, levelId: "starter-snowfield" }],
			unlockRules: [{ levelId: "starter-snowfield", requires: [] }],
			starterPackages: [objectRef, characterRef, musicRef],
			copy: {
				default: "A tiny snowball begins a very large winter journey.",
				translations: {},
			},
			missingOptionalContent: "skip",
		},
	];
	await writePackage(
		outputGuard,
		"starter-campaign",
		campaignManifest,
		new Map([["assets/icon.png", icon]]),
	);

	const inspected = await inspectStarterPackages({
		root,
		contentRoot: outputRoot,
	});
	if (!inspected.ok) {
		throw new Error(
			`E_GENERATED_PACKAGE_INSPECTION: ${inspected.issues
				.map((entry) => `${entry.ruleId}:${entry.path}`)
				.join(",")}`,
		);
	}
	const outputInventory = await inventoryTree(outputRoot, STARTER_TREE_LIMITS);
	if (!outputInventory.ok) {
		throw new Error(
			`E_GENERATED_PACKAGE_INSPECTION: bounded output inventory changed after validation (${outputInventory.issues
				.map((entry) => entry.ruleId)
				.join(",")})`,
		);
	}
	const files = {};
	for (const entry of outputInventory.entries.filter(
		(candidate) => candidate.kind === "file",
	)) {
		files[entry.relativePath] = sha256(await readInventoriedFile(entry));
	}
	return {
		configSha256: CONFIG_SHA256,
		files,
		packages: inspected.packages,
	};
}

function safeAssetPath(path) {
	if (
		typeof path !== "string" ||
		path.length === 0 ||
		path.length > 100 ||
		path !== path.normalize("NFC") ||
		!path.startsWith("assets/") ||
		path.includes("\\") ||
		path.includes("\0") ||
		Buffer.from(path, "utf8").toString("utf8") !== path ||
		Buffer.byteLength(`package/${path}`, "utf8") > 100
	)
		return false;
	return path
		.split("/")
		.every(
			(segment) =>
				segment.length > 0 && segment !== ".." && segment !== ".",
		);
}

function expectedAssetDirectories(paths) {
	const directories = new Set();
	for (const path of paths) {
		const segments = path.split("/");
		for (let depth = 1; depth < segments.length; depth += 1)
			directories.add(segments.slice(0, depth).join("/"));
	}
	return directories;
}

async function inventoryStarterContent(contentRoot, options = {}) {
	const inventory = await inventoryTree(contentRoot, STARTER_TREE_LIMITS);
	const issues = [...inventory.issues];
	const packages = [];
	if (issues.some((entry) => entry.ruleId === "E_FILE_BUDGET"))
		return { ok: false, issues, packages, inventory };
	const fileEntries = inventory.entries.filter(
		(entry) => entry.kind === "file",
	);
	const totalBytes = fileEntries.reduce((total, entry) => total + entry.bytes, 0);
	const maximumDepth = inventory.entries.reduce(
		(maximum, entry) =>
			Math.max(maximum, entry.relativePath.split("/").length),
		0,
	);
	if (
		fileEntries.length > ASSET_LIMITS.maxStarterFiles ||
		totalBytes > ASSET_LIMITS.maxStarterBytes ||
		maximumDepth > ASSET_LIMITS.maxStarterDepth ||
		fileEntries.some((entry) => entry.bytes > ASSET_LIMITS.maxFileBytes)
	) {
		issues.push(
			issue(
				"E_FILE_BUDGET",
				"/",
				"Keep the complete starter inventory inside reviewed count, depth, and byte limits before reading files.",
			),
		);
		return { ok: false, issues, packages, inventory };
	}
	const entriesByPath = new Map(
		inventory.entries.map((entry) => [entry.relativePath, entry]),
	);
	for (const entry of inventory.entries.filter(
		(candidate) => !candidate.relativePath.includes("/"),
	)) {
		if (
			!PACKAGE_NAMES.includes(entry.relativePath) ||
			entry.kind !== "directory"
		) {
			issues.push(
				issue(
					"E_CONTENT_TREE",
					`/${entry.relativePath}`,
					"Keep exactly the five reviewed starter package directories at the content root.",
				),
			);
		}
	}
	for (const packageName of PACKAGE_NAMES) {
		if (entriesByPath.get(packageName)?.kind !== "directory")
			issues.push(
				issue(
					"E_CONTENT_TREE",
					`/${packageName}`,
					"Restore every expected real starter package directory.",
				),
			);
	}

	for (const packageName of PACKAGE_NAMES) {
		const packageEntry = entriesByPath.get(packageName);
		if (packageEntry?.kind !== "directory") {
			issues.push(
				issue(
					"E_CONTENT_TREE",
					`/${packageName}`,
					"Restore the expected real starter package directory.",
				),
			);
			continue;
		}
		const manifestEntry = entriesByPath.get(`${packageName}/manifest.json`);
		if (manifestEntry?.kind !== "file") {
			issues.push(
				issue(
					"E_MANIFEST_MISSING",
					`/${packageName}/manifest.json`,
					"Restore one regular package manifest.",
				),
			);
			continue;
		}
		let manifestBytes;
		let manifest;
		try {
			manifestBytes = await readInventoriedFile(manifestEntry);
			manifest = JSON.parse(manifestBytes.toString("utf8"));
		} catch {
			issues.push(
				issue(
					"E_MANIFEST_MISSING",
					`/${packageName}/manifest.json`,
					"Restore one complete JSON package manifest.",
				),
			);
			continue;
		}
		const expectedPackage = PACKAGE_CONTRACTS[packageName];
		if (
			manifest?.name !== expectedPackage.name ||
			manifest?.kind !== expectedPackage.kind
		) {
			issues.push(
				issue(
					"E_PACKAGE_REF",
					`/${packageName}/manifest.json`,
					"Bind each fixed starter directory to its exact package name and kind.",
				),
			);
			continue;
		}
		const packageEntries = inventory.entries.filter((entry) =>
			entry.relativePath.startsWith(`${packageName}/`),
		);
		const bodyFiles = packageEntries.filter(
			(entry) =>
				entry.kind === "file" &&
				entry.relativePath !== `${packageName}/manifest.json`,
		);
		const bodyBytes = bodyFiles.reduce(
			(total, entry) => total + entry.bytes,
			0,
		);
		const kindLimits = STARTER_KIND_STRUCTURAL_CEILINGS[manifest.kind];
		if (
			bodyFiles.length > kindLimits.maxFiles ||
			bodyBytes > kindLimits.rawBytes ||
			bodyFiles.some((entry) => entry.bytes > kindLimits.maxFileBytes)
		) {
			issues.push(
				issue(
					"E_FILE_BUDGET",
					`/${packageName}`,
					"Keep the complete package body inside its kind-specific file-count, per-file, and byte ceilings before reading asset bytes.",
					{
						observed: {
							files: bodyFiles.length,
							bytes: bodyBytes,
							maxFileBytes: bodyFiles.reduce(
								(maximum, entry) => Math.max(maximum, entry.bytes),
								0,
							),
						},
						allowed: kindLimits,
					},
				),
			);
			continue;
		}
		const declaredAssets = Array.isArray(manifest.assets)
			? manifest.assets
			: [];
		const declaredPaths = declaredAssets.map((asset) => asset?.path);
		const safeDeclaredPaths = declaredPaths.filter(safeAssetPath);
		const declaredPathSet = new Set(safeDeclaredPaths);
		if (
			safeDeclaredPaths.length !== declaredPaths.length ||
			declaredPathSet.size !== declaredPaths.length
		) {
			issues.push(
				issue(
					"E_PATH_POLICY",
					`/${packageName}/manifest.json`,
					"Declare a duplicate-free flat inventory of safe NFC asset paths.",
				),
			);
		}
		const expectedDirectories = expectedAssetDirectories(safeDeclaredPaths);
		for (const entry of packageEntries) {
			const localPath = entry.relativePath.slice(packageName.length + 1);
			if (entry.kind === "directory" && !expectedDirectories.has(localPath)) {
				issues.push(
					issue(
						"E_CONTENT_TREE",
						`/${entry.relativePath}`,
						"Remove undeclared package directories from the exact package tree.",
					),
				);
			}
			if (entry.kind !== "file") continue;
			const extension = extname(localPath).toLowerCase();
			if (EXECUTABLE_EXTENSION.test(localPath) || (entry.mode & 0o111) !== 0) {
				issues.push(
					issue(
						"E_CODE_FORBIDDEN",
						`/${entry.relativePath}`,
						"Remove executable modes and code-bearing files from data-only packages.",
					),
				);
			}
			if (localPath !== "manifest.json" && !declaredPathSet.has(localPath)) {
				issues.push(
					issue(
						"E_ASSET_ORPHAN",
						`/${entry.relativePath}`,
						"Remove undeclared files or bind the exact data-only asset in the manifest.",
					),
				);
			}
			if (
				declaredPathSet.has(localPath) &&
				(!Object.hasOwn(ALLOWED_RUNTIME_EXTENSIONS, extension) ||
					EXECUTABLE_EXTENSION.test(localPath))
			) {
				issues.push(
					issue(
						"E_RUNTIME_FILE_TYPE",
						`/${entry.relativePath}`,
						"Use only allowlisted declarative runtime asset formats.",
					),
				);
			}
		}

		const assetBytes = new Map();
		const assetEntries = new Map();
		for (const assetPath of safeDeclaredPaths) {
			const entry = entriesByPath.get(`${packageName}/${assetPath}`);
			if (entry?.kind !== "file") {
				issues.push(
					issue(
						"E_ASSET_MISSING",
						`/${packageName}/${assetPath}`,
						"Restore the exact declared regular asset file.",
					),
				);
				continue;
			}
			assetBytes.set(
				assetPath,
				await readInventoriedFile(
					entry,
					options.afterAssetIdentityCheck === undefined
						? undefined
						: {
								afterIdentityCheck: () =>
									options.afterAssetIdentityCheck(
										`${packageName}/${assetPath}`,
									),
							},
				),
			);
			assetEntries.set(assetPath, entry);
		}
		if (assetBytes.size !== declaredPathSet.size) continue;
		packages.push({
			packageName,
			packageRoot: packageEntry.absolutePath,
			manifest,
			manifestBytes,
			assetBytes,
			assetEntries,
		});
	}
	return { ok: issues.length === 0, issues, packages, inventory };
}

function inspectRuntimeFile(asset, bytes, artifactEntry, inventoryEntry) {
	const issues = [];
	const extension = extname(asset.path).toLowerCase();
	let sniffedMime = "application/octet-stream";
	let codec;
	let glbReferences;
	let decodedGeometry;
	let decodedTexture;
	let decodedAudio;
	let localAssetMetrics;
	let mediaMetrics;
	if (extension === ".glb") {
		const inspection = inspectGlb(bytes);
		mediaMetrics = inspection.metrics;
		issues.push(...inspection.issues);
		if (inspection.ok) {
			sniffedMime = "model/gltf-binary";
			glbReferences = [];
			decodedGeometry = {
				triangles: inspection.metrics.triangles,
				maxTextureDimension: inspection.metrics.maxTextureDimension,
			};
			localAssetMetrics = {
				materials: inspection.metrics.materials,
				textures: inspection.metrics.textures,
				textureSets: inspection.metrics.textureSets,
				textureBytes: inspection.metrics.textureBytes,
				maxTextureDimension: inspection.metrics.maxTextureDimension,
				textValues: inspection.metrics.textValues,
			};
		}
	} else if (extension === ".png") {
		const inspection = inspectPng(bytes);
		mediaMetrics = inspection.metrics;
		issues.push(...inspection.issues);
		if (inspection.ok) {
			sniffedMime = "image/png";
			decodedTexture = {
				width: inspection.metrics.width,
				height: inspection.metrics.height,
			};
			localAssetMetrics = {
				materials: 0,
				textures: 1,
				textureSets: 1,
				textureBytes: bytes.length,
				maxTextureDimension: Math.max(
					inspection.metrics.width,
					inspection.metrics.height,
				),
			};
		}
	} else if (extension === ".wav") {
		const inspection = inspectWav(bytes);
		mediaMetrics = inspection.metrics;
		issues.push(...inspection.issues);
		if (inspection.ok) {
			sniffedMime = "audio/wav";
			codec = "audio/wav";
			decodedAudio = {
				durationSeconds: inspection.metrics.durationSeconds,
				channels: inspection.metrics.channels,
				sampleRate: inspection.metrics.sampleRate,
			};
		}
	} else if (extension === ".json") {
		try {
			JSON.parse(bytes.toString("utf8"));
			sniffedMime = "application/json";
		} catch {
			issues.push(
				issue(
					"E_RUNTIME_FILE_TYPE",
					`/${asset.path}`,
					"Provide one complete JSON data asset.",
				),
			);
		}
	}
	return {
		issues,
		localAssetMetrics,
		mediaMetrics,
		file: {
			path: asset.path,
			kind: "file",
			declaredMime: asset.mime,
			sniffedMime,
			bytes: bytes.length,
			actualSha256: sha256(bytes),
			compressedBytes: artifactEntry.compressedBytes,
			depth: asset.path.split("/").length,
			codec,
			glbReferences,
			decodedGeometry,
			decodedTexture,
			decodedAudio,
			executable: (inventoryEntry.mode & 0o111) !== 0,
		},
	};
}

const ROLE_PRIORITY = Object.freeze({
	collider: 10,
	"render-model": 20,
	"lod-model": 21,
	"character-model": 30,
	"music-track": 40,
	arena: 50,
	layout: 51,
	icon: 80,
	screenshot: 81,
});

function derivedAssetRoles(manifest) {
	const roles = new Map();
	const add = (assetId, role) => {
		if (typeof assetId !== "string") return;
		const current = roles.get(assetId);
		if (current === undefined || ROLE_PRIORITY[role] < ROLE_PRIORITY[current])
			roles.set(assetId, role);
	};
	const assetByPath = new Map(
		(Array.isArray(manifest.assets) ? manifest.assets : []).map((asset) => [
			asset.path,
			asset.assetId,
		]),
	);
	add(assetByPath.get(manifest?.metadata?.icon), "icon");
	for (const path of manifest?.metadata?.screenshots ?? [])
		add(assetByPath.get(path), "screenshot");
	for (const entry of manifest.entries ?? []) {
		if (manifest.kind === "object-pack") {
			for (const object of entry.objects ?? []) {
				add(object.renderAssetId, "render-model");
				add(object.colliderAssetId, "collider");
				for (const assetId of object.lodAssetIds ?? [])
					add(assetId, "lod-model");
			}
		} else if (manifest.kind === "character") {
			add(entry.modelAssetId, "character-model");
			add(entry.iconAssetId, "icon");
			for (const assetId of entry.screenshotAssetIds ?? [])
				add(assetId, "screenshot");
		} else if (manifest.kind === "level") {
			add(entry.arenaAssetId, "arena");
			add(entry.layoutAssetId, "layout");
		} else if (manifest.kind === "music") {
			for (const track of entry.tracks ?? []) add(track.assetId, "music-track");
		}
	}
	return roles;
}

const COLLECTIBLE_BUDGET = Object.freeze({
	...CONTENT_BUDGETS.collectible,
	maxTextureSets: ROLE_TEXTURE_SET_BUDGETS.collectible,
});
const HERO_BUDGET = Object.freeze({
	...CONTENT_BUDGETS.hero,
	maxTextureSets: ROLE_TEXTURE_SET_BUDGETS.hero,
});
const ROLE_BUDGETS = Object.freeze({
	"render-model": COLLECTIBLE_BUDGET,
	"lod-model": COLLECTIBLE_BUDGET,
	collider: COLLECTIBLE_BUDGET,
	"character-model": HERO_BUDGET,
});

function completeLocalAssetMetrics(value) {
	return (
		plainObject(value) &&
		["materials", "textures", "textureSets", "textureBytes", "maxTextureDimension"].every(
			(field) => Number.isSafeInteger(value[field]) && value[field] >= 0,
		)
	);
}

function completeRuntimeFile(file, asset) {
	if (
		!plainObject(file) ||
		file.path !== asset?.path ||
		!Number.isSafeInteger(file.bytes) ||
		file.bytes < 0
	)
		return false;
	if (asset?.mime === "model/gltf-binary")
		return (
			plainObject(file.decodedGeometry) &&
			Number.isSafeInteger(file.decodedGeometry.triangles) &&
			file.decodedGeometry.triangles >= 0 &&
			Number.isSafeInteger(file.decodedGeometry.maxTextureDimension) &&
			file.decodedGeometry.maxTextureDimension >= 0
		);
	if (asset?.mime === "image/png")
		return (
			plainObject(file.decodedTexture) &&
			Number.isSafeInteger(file.decodedTexture.width) &&
			file.decodedTexture.width > 0 &&
			Number.isSafeInteger(file.decodedTexture.height) &&
			file.decodedTexture.height > 0
		);
	if (asset?.mime === "audio/wav")
		return (
			plainObject(file.decodedAudio) &&
			finiteNumber(file.decodedAudio.durationSeconds) &&
			file.decodedAudio.durationSeconds > 0 &&
			Number.isSafeInteger(file.decodedAudio.channels) &&
			file.decodedAudio.channels > 0 &&
			Number.isSafeInteger(file.decodedAudio.sampleRate) &&
			file.decodedAudio.sampleRate > 0
		);
	return true;
}

export function validatePackageBudgets(inspection) {
	const issues = [];
	const manifest = inspection?.manifest;
	if (
		manifest === null ||
		typeof manifest !== "object" ||
		!Array.isArray(manifest.assets) ||
		!Array.isArray(inspection?.files) ||
		!plainObject(inspection?.localAssetMetrics)
	) {
		return {
			ok: false,
			issues: [
				issue(
					"E_FILE_BUDGET",
					"/",
					"Provide complete manifest and decoded file facts before budget validation.",
				),
			],
		};
	}
	const fileCounts = new Map();
	for (const file of inspection.files)
		fileCounts.set(file?.path, (fileCounts.get(file?.path) ?? 0) + 1);
	if (
		inspection.files.length !== manifest.assets.length ||
		[...fileCounts.values()].some((count) => count !== 1) ||
		inspection.files.some(
			(file) => !manifest.assets.some((asset) => asset?.path === file?.path),
		)
	) {
		issues.push(
			issue(
				"E_FILE_BUDGET",
				"/files",
				"Provide exactly one decoded runtime file fact for every manifest asset.",
			),
		);
	}
	const filesByPath = new Map(
		inspection.files.map((file) => [file.path, file]),
	);
	const localAssetMetrics = inspection.localAssetMetrics;
	const roles = derivedAssetRoles(manifest);
	for (const [index, asset] of manifest.assets.entries()) {
		const role = roles.get(asset.assetId);
		const file = filesByPath.get(asset.path);
		const localMetrics = localAssetMetrics[asset.path];
		const budget = ROLE_BUDGETS[role];
		if (role === undefined) {
			issues.push(
				issue(
					"E_ASSET_ROLE",
					`/manifest/assets/${index}`,
					"Reference every manifest asset from one exact semantic entry or metadata field.",
				),
			);
		}
		if (!completeRuntimeFile(file, asset)) {
			issues.push(
				issue(
					"E_FILE_BUDGET",
					`/files/${index}`,
					"Provide a complete matching file fact with role-appropriate decoded measurements.",
				),
			);
		}
		if (
			(asset?.mime === "model/gltf-binary" || asset?.mime === "image/png") &&
			!completeLocalAssetMetrics(localMetrics)
		) {
			issues.push(
				issue(
					"E_FILE_BUDGET",
					`/files/${index}`,
					"Provide complete decoded local metrics for every GLB and PNG asset.",
				),
			);
		}
		if (
			budget !== undefined &&
			(file?.bytes > budget.maxBytes ||
				file?.decodedGeometry?.triangles > budget.maxTriangles ||
				file?.decodedGeometry?.maxTextureDimension >
					budget.maxTextureDimension ||
				localMetrics?.materials > budget.maxMaterialSlots ||
				localMetrics?.textureSets > budget.maxTextureSets)
		) {
			issues.push(
				issue(
					"E_FILE_BUDGET",
					`/files/${index}`,
					"Keep decoded collectible or hero assets inside frozen semantic role budgets.",
				),
			);
		}
		if (
			role === "music-track" &&
			(file?.bytes > CONTENT_BUDGETS.music.maxTrackBytes ||
				file?.decodedAudio?.durationSeconds >
					CONTENT_BUDGETS.music.maxTrackSeconds ||
				file?.decodedAudio?.channels > CONTENT_BUDGETS.music.maxChannels ||
				file?.decodedAudio?.sampleRate > CONTENT_BUDGETS.music.maxSampleRate)
		) {
			issues.push(
				issue(
					"E_FILE_BUDGET",
					`/files/${index}`,
					"Keep decoded tracks inside frozen music limits.",
				),
			);
		}
	}
	const levelTextureBytes = manifest.assets.reduce(
		(total, asset) =>
			total + (localAssetMetrics[asset.path]?.textureBytes ?? 0),
		0,
	);
	const levelTextureDimension = manifest.assets.reduce((maximum, asset) => {
		const file = filesByPath.get(asset.path);
		return Math.max(
			maximum,
			localAssetMetrics[asset.path]?.maxTextureDimension ?? 0,
			file?.decodedGeometry?.maxTextureDimension ?? 0,
			file?.decodedTexture?.width ?? 0,
			file?.decodedTexture?.height ?? 0,
		);
	}, 0);
	if (
		manifest.kind === "level" &&
		(manifest.totals.bytes > CONTENT_BUDGETS.level.maxDownloadBytes ||
			manifest.totals.uncompressedBytes >
				CONTENT_BUDGETS.level.maxUncompressedBytes ||
			manifest.totals.fileCount > CONTENT_BUDGETS.level.maxFiles ||
			inspection.files.some(
				(file) => file.bytes > CONTENT_BUDGETS.level.maxFileBytes,
			) ||
			levelTextureBytes > CONTENT_BUDGETS.level.maxCompressedTextureBytes ||
			levelTextureDimension > CONTENT_BUDGETS.level.maxTextureDimension)
	) {
		issues.push(
			issue(
				"E_FILE_BUDGET",
				"/archive",
				"Keep the complete level artifact inside frozen aggregate level limits.",
			),
		);
	}
	if (manifest.kind === "music") {
		const trackCount = manifest.entries.reduce(
			(total, entry) => total + (entry.tracks?.length ?? 0),
			0,
		);
		if (
			manifest.totals.bytes > CONTENT_BUDGETS.music.maxPackBytes ||
			trackCount > CONTENT_BUDGETS.music.maxTracks
		) {
			issues.push(
				issue(
					"E_FILE_BUDGET",
					"/archive",
					"Keep the complete music artifact and logical tracks inside frozen pack limits.",
				),
			);
		}
	}
	return { ok: issues.length === 0, issues };
}

function entryPackageRefs(manifest) {
	const refs = [];
	for (const entry of manifest.entries ?? []) {
		if (manifest.kind === "level") {
			for (const group of entry.collectibleGroups ?? [])
				refs.push(group.objectPack);
			refs.push(...(entry.musicRefs ?? []));
		} else if (manifest.kind === "campaign") {
			for (const level of entry.levels ?? []) refs.push(level.package);
			refs.push(...(entry.starterPackages ?? []));
		} else if (manifest.kind === "bundle") {
			for (const field of [
				"levels",
				"objectPacks",
				"characters",
				"campaigns",
				"music",
				"installOrder",
				"defaultActivation",
			])
				refs.push(...(entry[field] ?? []));
		}
	}
	return refs;
}

function referenceKey(reference) {
	return `${reference?.name}@${reference?.version}`;
}

function packageObjectIds(pkg) {
	return new Set(
		pkg?.manifest?.entries?.flatMap((entry) =>
			(entry.objects ?? []).map((object) => object.objectId),
		) ?? [],
	);
}

function normalizeInspectionOptions(options) {
	const rootOption = options.root;
	const contentRootOption = options.contentRoot;
	const afterAssetIdentityCheck = options.afterAssetIdentityCheck;
	const root = resolve(rootOption ?? process.cwd());
	return {
		root,
		contentRoot: resolve(contentRootOption ?? join(root, "content")),
		afterAssetIdentityCheck,
	};
}

async function inspectStarterPackageSnapshot(options) {
	const validatePackageInspection = await loadPackageInspectionValidator();
	const inventory = await inventoryStarterContent(options.contentRoot, options);
	const issues = [...inventory.issues];
	const packages = [];
	for (const source of inventory.packages) {
		let artifact;
		try {
			artifact = buildDeterministicPackageArtifact(
				source.manifest,
				source.assetBytes,
				{ reconcileTotals: false },
			);
		} catch {
			issues.push(
				issue(
					"E_PACKAGE_ARTIFACT",
					`/${source.packageName}`,
					"Rebuild the deterministic npm artifact from the exact manifest inventory.",
				),
			);
			continue;
		}
		if (!source.manifestBytes.equals(artifact.manifestBytes)) {
			issues.push(
				issue(
					"E_PACKAGE_ARTIFACT",
					`/${source.packageName}/manifest.json`,
					"Serialize the exact canonical manifest bytes embedded by the deterministic artifact builder.",
				),
			);
		}
		const artifactEntries = new Map(
			artifact.entries
				.filter((entry) => entry.kind === "asset")
				.map((entry) => [entry.path, entry]),
		);
		const files = [];
		const localAssetMetrics = Object.create(null);
		for (const asset of source.manifest.assets) {
			const inspected = inspectRuntimeFile(
				asset,
				source.assetBytes.get(asset.path),
				artifactEntries.get(asset.path),
				source.assetEntries.get(asset.path),
			);
			for (const entry of inspected.issues) {
				issues.push({
					...entry,
					path: `/${source.packageName}/${asset.path}${entry.path}`,
				});
			}
			if (inspected.localAssetMetrics !== undefined)
				localAssetMetrics[asset.path] = inspected.localAssetMetrics;
			files.push(inspected.file);
		}
		const inspection = {
			manifest: source.manifest,
			archive: artifact.archive,
			files,
		};
		const budgetInspection = { ...inspection, localAssetMetrics };
		const protocolValidation = validatePackageInspection(inspection);
		for (const entry of protocolValidation.issues)
			issues.push({
				...entry,
				path: `/${source.packageName}${entry.path}`,
			});
		const budget = validatePackageBudgets(budgetInspection);
		for (const entry of budget.issues)
			issues.push({ ...entry, path: `/${source.packageName}${entry.path}` });
		if (
			source.manifest.totals.bytes !== artifact.archive.compressedBytes ||
			source.manifest.totals.uncompressedBytes !==
				artifact.archive.uncompressedBytes ||
			source.manifest.totals.fileCount !== artifact.archive.fileCount ||
			source.manifest.totals.maxDepth !== artifact.archive.maxDepth
		) {
			issues.push(
				issue(
					"E_FILE_BUDGET",
					`/${source.packageName}/totals`,
					"Record exact deterministic artifact and inspected runtime-file totals.",
				),
			);
		}
		packages.push({
			packageName: source.packageName,
			manifest: source.manifest,
			manifestBytes: source.manifestBytes,
			manifestSha256: sha256(source.manifestBytes),
			artifact,
			inspection,
			budgetInspection,
			ref: refFor(source.manifest, artifact),
		});
	}
	const packagesByIdentity = new Map(
		packages.map((entry) => [referenceKey(entry.ref), entry]),
	);
	const addReferenceIssue = (packageName, remediation) =>
		issues.push(issue("E_PACKAGE_REF", `/${packageName}`, remediation));
	for (const entry of packages) {
		const dependencies = Array.isArray(entry.manifest.dependencies)
			? entry.manifest.dependencies
			: [];
		const optionalPeers = Array.isArray(entry.manifest.optionalPeers)
			? entry.manifest.optionalPeers
			: [];
		const declaredRefs = [...dependencies, ...optionalPeers];
		for (const reference of dependencies) {
			const expected = packagesByIdentity.get(referenceKey(reference))?.ref;
			if (expected === undefined || !isDeepStrictEqual(reference, expected))
				addReferenceIssue(
					entry.packageName,
					"Bind every required dependency to an exact present starter artifact reference.",
				);
		}
		for (const reference of optionalPeers) {
			const expected = packagesByIdentity.get(referenceKey(reference))?.ref;
			if (expected !== undefined && !isDeepStrictEqual(reference, expected))
				addReferenceIssue(
					entry.packageName,
					"Bind each present optional peer to its exact starter artifact while permitting absence.",
				);
		}
		for (const reference of entryPackageRefs(entry.manifest)) {
			if (
				!declaredRefs.some((declared) =>
					isDeepStrictEqual(declared, reference),
				)
			)
				addReferenceIssue(
					entry.packageName,
					"Declare every entry-used package reference as an exact dependency or optional peer.",
				);
		}

		if (entry.manifest.kind === "level") {
			const presentDependencies = declaredRefs
				.map((reference) => packagesByIdentity.get(referenceKey(reference)))
				.filter((candidate) => candidate !== undefined);
			for (const level of entry.manifest.entries ?? []) {
				for (const group of level.collectibleGroups ?? []) {
					const objectPack = packagesByIdentity.get(
						referenceKey(group.objectPack),
					);
					const exported = packageObjectIds(objectPack);
					if (
						objectPack?.manifest?.kind !== "object-pack" ||
						!isDeepStrictEqual(group.objectPack, objectPack.ref) ||
						(group.objectIds ?? []).some(
							(objectId) => !exported.has(objectId),
						)
					)
						addReferenceIssue(
							entry.packageName,
							"Resolve every collectible object ID inside its exact declared object pack.",
						);
				}
				for (const musicReference of level.musicRefs ?? []) {
					const matchingPackages = packages.filter(
						(candidate) =>
							referenceKey(candidate.ref) ===
								referenceKey(musicReference) &&
							isDeepStrictEqual(candidate.ref, musicReference),
					);
					if (
						matchingPackages.length !== 1 ||
						matchingPackages[0].manifest.kind !== "music"
					)
						addReferenceIssue(
							entry.packageName,
							"Resolve every level music package reference to exactly one present music package.",
						);
				}
				const providers = presentDependencies.filter(
					(candidate) =>
						candidate.manifest.kind === "object-pack" &&
						packageObjectIds(candidate).has(level.finalGoal?.objectId),
				);
				if (providers.length !== 1)
					addReferenceIssue(
						entry.packageName,
						"Resolve the final-goal object ID to exactly one declared object-pack provider.",
					);
			}
		}

		if (entry.manifest.kind === "campaign") {
			for (const campaign of entry.manifest.entries ?? []) {
				const campaignLevelIds = new Set();
				for (const level of campaign.levels ?? []) {
					const levelPackage = packagesByIdentity.get(
						referenceKey(level.package),
					);
					const matchingIds =
						levelPackage?.manifest?.entries?.filter(
							(candidate) => candidate.levelId === level.levelId,
						).length ?? 0;
					if (
						levelPackage?.manifest?.kind !== "level" ||
						!isDeepStrictEqual(level.package, levelPackage.ref) ||
						matchingIds !== 1 ||
						campaignLevelIds.has(level.levelId)
					)
						addReferenceIssue(
							entry.packageName,
							"Resolve each campaign level ID exactly once in its exact level package.",
						);
					campaignLevelIds.add(level.levelId);
				}
				for (const rule of campaign.unlockRules ?? []) {
					if (
						!campaignLevelIds.has(rule.levelId) ||
						(rule.requires ?? []).some(
							(required) => !campaignLevelIds.has(required),
						)
					)
						addReferenceIssue(
							entry.packageName,
							"Bind every campaign unlock rule to declared campaign level IDs.",
						);
				}
			}
		}
	}
	const hashSnapshot = {
		packages: inventory.packages.map((source) => ({
			packageName: source.packageName,
			assets: Array.isArray(source.manifest.assets)
				? source.manifest.assets
				: [],
			files: [...source.assetBytes.entries()]
				.map(([path, bytes]) => ({
					path,
					bytes: bytes.length,
					actualSha256: sha256(bytes),
				}))
				.sort((left, right) => compareCodeUnits(left.path, right.path)),
		})),
	};
	return { ok: issues.length === 0, issues, packages, hashSnapshot };
}

export async function inspectStarterPackages(options = {}) {
	return inspectStarterPackageSnapshot(normalizeInspectionOptions(options));
}

export async function verifyStarterHashes(options = {}) {
	const normalizedOptions = normalizeInspectionOptions(options);
	const inspected = await inspectStarterPackageSnapshot(normalizedOptions);
	const issues = [...inspected.issues];
	const inspectedByName = new Map(
		inspected.packages.map((entry) => [entry.packageName, entry]),
	);
	for (const source of inspected.hashSnapshot.packages) {
		const assets = source.assets;
		const inspectedPackage = inspectedByName.get(source.packageName);
		const inspectedFiles = inspectedPackage?.inspection?.files ?? [];
		const inspectedFilesByPath = new Map(
			inspectedFiles.map((entry) => [entry.path, entry]),
		);
		const snapshotFilesByPath = new Map(
			source.files.map((entry) => [entry.path, entry]),
		);
		if (
			assets.length === 0 ||
			inspectedPackage === undefined ||
			inspectedFiles.length !== assets.length ||
			inspectedFilesByPath.size !== assets.length ||
			source.files.length !== assets.length ||
			snapshotFilesByPath.size !== assets.length ||
			assets.some(
				(asset) =>
					!inspectedFilesByPath.has(asset?.path) ||
					!snapshotFilesByPath.has(asset?.path),
			)
		) {
			issues.push(
				issue(
					"E_ASSET_HASH_CLOSURE",
					`/${source.packageName}/assets`,
					"Require one protocol-valid nonempty inspected file for every declared starter asset before accepting hashes.",
				),
			);
		}
		for (const [index, asset] of assets.entries()) {
			const actual = snapshotFilesByPath.get(asset?.path);
			if (actual === undefined) continue;
			if (
				actual.actualSha256 !== asset.sha256 ||
				actual.actualSha256 !== asset?.provenance?.outputSha256
			) {
				issues.push(
					issue(
						"E_ASSET_HASH_MISMATCH",
						`/${source.packageName}/assets/${index}`,
						"Rebuild from retained source and update immutable hash evidence together.",
					),
				);
			}
			if (actual.bytes !== asset.bytes) {
				issues.push(
					issue(
						"E_ASSET_BYTES_MISMATCH",
						`/${source.packageName}/assets/${index}`,
						"Match declared bytes to exact output.",
					),
				);
			}
		}
	}
	return { ok: issues.length === 0, issues };
}

function contentDigestFromSnapshot(filesByPath) {
	const hash = createHash("sha256");
	const entries = [...filesByPath.entries()].sort(([left], [right]) =>
		compareCodeUnits(left, right),
	);
	for (const [path, bytes] of entries) {
		hash.update(path);
		hash.update("\0");
		hash.update(bytes);
		hash.update("\0");
	}
	return hash.digest("hex");
}

export async function scanStarterRuntimeFiles(options = {}) {
	const normalizedOptions = normalizeInspectionOptions(options);
	const validatePackageInspection = await loadPackageInspectionValidator();
	const inventory = await inventoryStarterContent(
		normalizedOptions.contentRoot,
		normalizedOptions,
	);
	const issues = [...inventory.issues];
	const files = [];
	const snapshotBytesByPath = new Map();
	if (issues.some((entry) => entry.ruleId === "E_FILE_BUDGET"))
		return { ok: false, issues, files, contentDigest: undefined };
	for (const source of inventory.packages) {
		files.push({
			path: `${source.packageName}/manifest.json`,
			bytes: source.manifestBytes.length,
			sha256: sha256(source.manifestBytes),
			kind: "json",
		});
		snapshotBytesByPath.set(
			`${source.packageName}/manifest.json`,
			source.manifestBytes,
		);
		let artifact;
		try {
			artifact = buildDeterministicPackageArtifact(
				source.manifest,
				source.assetBytes,
				{ reconcileTotals: false },
			);
			if (!source.manifestBytes.equals(artifact.manifestBytes)) {
				issues.push(
					issue(
						"E_PACKAGE_ARTIFACT",
						`/${source.packageName}/manifest.json`,
						"Serialize the exact canonical manifest bytes embedded by the deterministic artifact builder.",
					),
				);
			}
		} catch {
			issues.push(
				issue(
					"E_PACKAGE_ARTIFACT",
					`/${source.packageName}`,
					"Rebuild the deterministic npm artifact from the exact manifest inventory.",
				),
			);
		}
		const artifactEntries = new Map(
			(artifact?.entries ?? [])
				.filter((entry) => entry.kind === "asset")
				.map((entry) => [entry.path, entry]),
		);
		const inspectionFiles = [];
		const localAssetMetrics = Object.create(null);
		const roles = derivedAssetRoles(source.manifest);
		for (const asset of source.manifest.assets) {
			const bytes = source.assetBytes.get(asset.path);
			const inventoryEntry = source.assetEntries.get(asset.path);
			if (bytes === undefined || inventoryEntry === undefined) continue;
			snapshotBytesByPath.set(
				`${source.packageName}/${asset.path}`,
				bytes,
			);
			const inspected = inspectRuntimeFile(
				asset,
				bytes,
				artifactEntries.get(asset.path) ?? { compressedBytes: 0 },
				inventoryEntry,
			);
			for (const entry of inspected.issues) {
				issues.push({
					...entry,
					path: `/${source.packageName}/${asset.path}${entry.path}`,
				});
			}
			if (inspected.localAssetMetrics !== undefined)
				localAssetMetrics[asset.path] = inspected.localAssetMetrics;
			inspectionFiles.push(inspected.file);
			const extension = extname(asset.path).toLowerCase();
			const record = {
				path: `${source.packageName}/${asset.path}`,
				bytes: bytes.length,
				sha256: sha256(bytes),
				kind: extension.slice(1),
				role: roles.get(asset.assetId),
				compressedBytes: artifactEntries.get(asset.path)?.compressedBytes ?? 0,
			};
			if (extension === ".glb") record.glb = inspected.mediaMetrics;
			if (extension === ".png") record.texture = inspected.mediaMetrics;
			if (extension === ".wav") record.audio = inspected.mediaMetrics;
			files.push(record);
		}
		const inspection = {
			manifest: source.manifest,
			archive: artifact?.archive ?? source.manifest.totals,
			files: inspectionFiles,
		};
		const protocolValidation = validatePackageInspection(inspection);
		for (const entry of protocolValidation.issues)
			issues.push({
				...entry,
				path: `/${source.packageName}${entry.path}`,
			});
		const budget = validatePackageBudgets({
			...inspection,
			localAssetMetrics,
		});
		for (const entry of budget.issues)
			issues.push({ ...entry, path: `/${source.packageName}${entry.path}` });
	}
	const inventoryFiles = inventory.inventory.entries.filter(
		(candidate) => candidate.kind === "file",
	);
	for (const entry of inventoryFiles) {
		let bytes = snapshotBytesByPath.get(entry.relativePath);
		if (bytes === undefined) {
			bytes = await readInventoriedFile(entry);
			snapshotBytesByPath.set(entry.relativePath, bytes);
		}
		const [packageName, ...segments] = entry.relativePath.split("/");
		const localPath = segments.join("/");
		if (
			PACKAGE_NAMES.includes(packageName) &&
			localPath !== "manifest.json" &&
			!files.some((file) => file.path === entry.relativePath)
		) {
			const extension = extname(entry.relativePath).toLowerCase();
			if (
				!Object.hasOwn(ALLOWED_RUNTIME_EXTENSIONS, extension) ||
				EXECUTABLE_EXTENSION.test(entry.relativePath)
			) {
				issues.push(
					issue(
						"E_RUNTIME_FILE_TYPE",
						`/${entry.relativePath}`,
						"Starter packages may contain only allowlisted declarative data files.",
					),
				);
			}
			files.push({
				path: entry.relativePath,
				bytes: bytes.length,
				sha256: sha256(bytes),
				kind: extension.slice(1),
			});
		}
	}
	files.sort((left, right) => compareCodeUnits(left.path, right.path));
	return {
		ok: issues.length === 0,
		issues,
		files,
		contentDigest: contentDigestFromSnapshot(snapshotBytesByPath),
	};
}

function projectAssetBudgetFile(file) {
	if (file.glb === undefined) return file;
	const { glb, ...record } = file;
	return {
		...record,
		glb: {
			bytes: glb.bytes,
			triangles: glb.triangles,
			materials: glb.materials,
			textures: glb.textures,
			textureSets: glb.textureSets,
			textureBytes: glb.textureBytes,
			decodedTextureBytes: glb.decodedTextureBytes,
			maxTextureDimension: glb.maxTextureDimension,
		},
	};
}

export async function buildAssetBudgetReport(options = {}) {
	const scan = await scanStarterRuntimeFiles(options);
	const totals = scan.files.reduce(
		(current, file) => {
			current.files += 1;
			current.bytes += file.bytes;
			if (file.glb) {
				current.glbFiles += 1;
				current.triangles += file.glb.triangles;
				current.materials += file.glb.materials;
				current.textureBytes += file.glb.textureBytes;
			}
			if (file.texture) current.textureBytes += file.bytes;
			return current;
		},
		{
			files: 0,
			bytes: 0,
			glbFiles: 0,
			triangles: 0,
			materials: 0,
			textureBytes: 0,
		},
	);
	const issues = [...scan.issues];
	for (const file of scan.files) {
		const semanticBudget = ROLE_BUDGETS[file.role];
		if (
			file.glb !== undefined &&
			semanticBudget !== undefined &&
			file.glb.materials > semanticBudget.maxMaterialSlots
		) {
			issues.push(
				issue(
					"E_FILE_BUDGET",
					`/${file.path}/materials`,
					"Reduce decoded material slots to the frozen semantically derived role budget.",
					{ allowed: semanticBudget.maxMaterialSlots },
				),
			);
		}
	}
	if (totals.files > ASSET_LIMITS.maxStarterFiles) {
		issues.push(
			issue(
				"E_STARTER_FILE_COUNT",
				"/totals/files",
				"Reduce starter runtime file count.",
			),
		);
	}
	if (totals.bytes > ASSET_LIMITS.maxStarterBytes) {
		issues.push(
			issue("E_STARTER_BYTES", "/totals/bytes", "Reduce total starter bytes."),
		);
	}
	if (totals.triangles > ASSET_LIMITS.maxStarterTriangles) {
		issues.push(
			issue(
				"E_STARTER_TRIANGLES",
				"/totals/triangles",
				"Reduce aggregate starter triangle count.",
			),
		);
	}
	const files = scan.files.map(projectAssetBudgetFile);
	return {
		ok: issues.length === 0,
		issues,
		totals,
		files,
		contentDigest: scan.contentDigest,
	};
}

export async function contentDigest(options = {}) {
	const root = resolve(options.root ?? process.cwd());
	const contentRoot = resolve(options.contentRoot ?? join(root, "content"));
	const inventory = await inventoryStarterContent(contentRoot);
	if (!inventory.ok) {
		throw new Error(
			`E_CONTENT_TREE: ${inventory.issues
				.map((entry) => `${entry.ruleId}:${entry.path}`)
				.join(",")}`,
		);
	}
	const files = inventory.inventory.entries
		.filter((entry) => entry.kind === "file")
		.sort((left, right) =>
			compareCodeUnits(left.relativePath, right.relativePath),
		);
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(file.relativePath);
		hash.update("\0");
		hash.update(await readInventoriedFile(file));
		hash.update("\0");
	}
	return hash.digest("hex");
}
