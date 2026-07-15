import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { types as nodeUtilTypes } from "node:util";

import {
	assertAuditedNodeRuntime,
	CONTENT_BUDGETS,
} from "./canonical-config.mjs";

const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;
const ARTIFACT_SIZE_BINDING_SLACK = 4_096;
const MIN_EMPTY_GZIP_MEMBER_BYTES = 21;
const PACKAGE_PREFIX = "package/";
const PACKAGE_ARTIFACT_HARD_CEILING_BYTES = 256 * 1024 * 1024;
const P02_PACKAGE_RESOURCE_LIMITS = Object.freeze({
	artifactBytes: PACKAGE_ARTIFACT_HARD_CEILING_BYTES,
	maxFileBytes: 64 * 1024 * 1024,
	maxFiles: 2_048,
	maxDepth: 12,
	rawBytes: 512 * 1024 * 1024,
});
const P02_MAX_PADDED_TAR_MEMBER_BYTES =
	TAR_BLOCK_BYTES +
	Math.ceil(
		P02_PACKAGE_RESOURCE_LIMITS.maxFileBytes / TAR_BLOCK_BYTES,
	) *
		TAR_BLOCK_BYTES;
const PACKAGE_ARTIFACT_PROJECTED_WORKING_LIMITS = Object.freeze({
	maxInternalBytes: 640 * 1024 * 1024,
	manifestRetentionCopies: 4,
});
const P03_ARTIFACT_LIMITS_BY_KIND = Object.freeze({
	level: Object.freeze({
		artifactBytes: CONTENT_BUDGETS.level.maxDownloadBytes,
		maxFileBytes: CONTENT_BUDGETS.level.maxFileBytes,
		maxFiles: CONTENT_BUDGETS.level.maxFiles,
		rawBytes: CONTENT_BUDGETS.level.maxUncompressedBytes,
	}),
	music: Object.freeze({
		artifactBytes: CONTENT_BUDGETS.music.maxPackBytes,
		maxFileBytes: CONTENT_BUDGETS.music.maxTrackBytes,
		maxFiles: CONTENT_BUDGETS.music.maxTracks + 16,
		rawBytes: CONTENT_BUDGETS.music.maxPackBytes,
	}),
	character: P02_PACKAGE_RESOURCE_LIMITS,
	"object-pack": P02_PACKAGE_RESOURCE_LIMITS,
	campaign: P02_PACKAGE_RESOURCE_LIMITS,
	bundle: P02_PACKAGE_RESOURCE_LIMITS,
});
const ARRAY_IS_ARRAY = Array.isArray;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const NODE_IS_PROXY = nodeUtilTypes.isProxy;
const NUMBER_TO_STRING = Number.prototype.toString;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR =
	Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const INTRINSIC_MAP = Map;
const INTRINSIC_MAP_PROTOTYPE = INTRINSIC_MAP.prototype;
const MAP_SIZE_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
	INTRINSIC_MAP_PROTOTYPE,
	"size",
).get;
const MAP_HAS = INTRINSIC_MAP_PROTOTYPE.has;
const MAP_GET = INTRINSIC_MAP_PROTOTYPE.get;
const MAP_SET = INTRINSIC_MAP_PROTOTYPE.set;
const MAP_ENTRIES = INTRINSIC_MAP_PROTOTYPE.entries;
const MAP_KEYS = INTRINSIC_MAP_PROTOTYPE.keys;
const MAP_ITERATOR_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(
	REFLECT_APPLY(MAP_ENTRIES, new INTRINSIC_MAP(), []),
);
const MAP_ITERATOR_NEXT = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
	MAP_ITERATOR_PROTOTYPE,
	"next",
).value;
const INTRINSIC_WEAK_SET = WeakSet;
const WEAK_SET_PROTOTYPE = INTRINSIC_WEAK_SET.prototype;
const WEAK_SET_HAS = WEAK_SET_PROTOTYPE.has;
const WEAK_SET_ADD = WEAK_SET_PROTOTYPE.add;
const WEAK_SET_DELETE = WEAK_SET_PROTOTYPE.delete;
const MIN_GZIP_MEMBER_BYTES = 20;
const MANIFEST_JSON_LIMITS = Object.freeze({
	maxDepth: 64,
	maxNodes: 262_144,
	maxContainerEntries: 4_096,
	maxStringUtf8Bytes: 1 * 1024 * 1024,
	maxProjectedUtf8Bytes: 32 * 1024 * 1024,
});

function callIntrinsic(method, receiver, argumentsList) {
	return REFLECT_APPLY(method, receiver, argumentsList);
}

function mapHas(map, key) {
	return callIntrinsic(MAP_HAS, map, [key]);
}

function mapGet(map, key) {
	return callIntrinsic(MAP_GET, map, [key]);
}

function mapSet(map, key, value) {
	callIntrinsic(MAP_SET, map, [key, value]);
}

function consumeMapIterator(
	map,
	method,
	expectedCount,
	label,
	visitor,
) {
	const iterator = callIntrinsic(method, map, []);
	for (let index = 0; index < expectedCount; index += 1) {
		const step = callIntrinsic(MAP_ITERATOR_NEXT, iterator, []);
		if (step.done) {
			throw new Error(
				`E_PACKAGE_ARTIFACT_INPUT: ${label} iterator ended before its declared size`,
			);
		}
		visitor(step.value, index);
	}
	const extra = callIntrinsic(MAP_ITERATOR_NEXT, iterator, []);
	if (!extra.done) {
		throw new Error(
			`E_PACKAGE_ARTIFACT_INPUT: ${label} iterator exceeded its declared size`,
		);
	}
}

function consumeMapEntries(map, expectedCount, label, visitor) {
	consumeMapIterator(
		map,
		MAP_ENTRIES,
		expectedCount,
		label,
		(pair, index) => {
			if (!ARRAY_IS_ARRAY(pair) || pair.length !== 2) {
				throw new Error(
					`E_PACKAGE_ARTIFACT_INPUT: ${label} iterator returned a malformed entry`,
				);
			}
			visitor(pair[0], pair[1], index);
		},
	);
}

function consumeMapKeys(map, expectedCount, label, visitor) {
	consumeMapIterator(map, MAP_KEYS, expectedCount, label, visitor);
}

function weakSetHas(set, value) {
	return callIntrinsic(WEAK_SET_HAS, set, [value]);
}

function weakSetAdd(set, value) {
	callIntrinsic(WEAK_SET_ADD, set, [value]);
}

function weakSetDelete(set, value) {
	callIntrinsic(WEAK_SET_DELETE, set, [value]);
}

function manifestGraphError(reason) {
	throw new Error(`E_PACKAGE_ARTIFACT_BUDGET: manifest ${reason}`);
}

function addManifestProjection(current, additional) {
	const projected = current + additional;
	if (
		!Number.isSafeInteger(additional) ||
		additional < 0 ||
		!Number.isSafeInteger(projected) ||
		projected > MANIFEST_JSON_LIMITS.maxProjectedUtf8Bytes
	) {
		manifestGraphError(
			`projected UTF-8 exceeds ${MANIFEST_JSON_LIMITS.maxProjectedUtf8Bytes} bytes`,
		);
	}
	return projected;
}

function projectedJsonStringBytes(value) {
	if (
		value.length > MANIFEST_JSON_LIMITS.maxStringUtf8Bytes ||
		BUFFER_BYTE_LENGTH(value, "utf8") >
			MANIFEST_JSON_LIMITS.maxStringUtf8Bytes
	) {
		manifestGraphError(
			`string exceeds ${MANIFEST_JSON_LIMITS.maxStringUtf8Bytes} UTF-8 bytes`,
		);
	}
	let projected = 2;
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = STRING_CHAR_CODE_AT.call(value, index);
		if (
			codeUnit === 0x22 ||
			codeUnit === 0x5c ||
			codeUnit === 0x08 ||
			codeUnit === 0x09 ||
			codeUnit === 0x0a ||
			codeUnit === 0x0c ||
			codeUnit === 0x0d
		) {
			projected += 2;
		} else if (codeUnit <= 0x1f) {
			projected += 6;
		} else if (codeUnit <= 0x7f) {
			projected += 1;
		} else if (codeUnit <= 0x7ff) {
			projected += 2;
		} else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const nextCodeUnit =
				index + 1 < value.length
					? STRING_CHAR_CODE_AT.call(value, index + 1)
					: -1;
			if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
				projected += 4;
				index += 1;
			} else {
				projected += 6;
			}
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			projected += 6;
		} else {
			projected += 3;
		}
	}
	return projected;
}

function projectedContainerSyntaxBytes(depth, entries, object) {
	if (entries === 0) return 2;
	return (
		2 +
		(entries + 1) +
		entries * 2 * (depth + 1) +
		2 * depth +
		(entries - 1) +
		(object ? entries * 2 : 0)
	);
}

function requireEnumerableDataProperty(value, key) {
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
	if (
		descriptor === undefined ||
		descriptor.enumerable !== true ||
		!("value" in descriptor)
	) {
		manifestGraphError(
			"must contain only own enumerable data properties",
		);
	}
	return descriptor.value;
}

function preflightPlainJsonManifest(manifest) {
	if (
		manifest === null ||
		typeof manifest !== "object" ||
		NODE_IS_PROXY(manifest) ||
		ARRAY_IS_ARRAY(manifest)
	) {
		manifestGraphError("root must be an exact plain object");
	}
	let projectedBytes = 1;
	let nodeCount = 0;
	const active = new INTRINSIC_WEAK_SET();
	const stack = [{ value: manifest, depth: 0, exit: false }];

	while (stack.length > 0) {
		const current = stack.pop();
		const value = current.value;
		if (current.exit) {
			weakSetDelete(active, value);
			continue;
		}
		nodeCount += 1;
		if (nodeCount > MANIFEST_JSON_LIMITS.maxNodes) {
			manifestGraphError(
				`graph exceeds ${MANIFEST_JSON_LIMITS.maxNodes} nodes`,
			);
		}
		if (current.depth > MANIFEST_JSON_LIMITS.maxDepth) {
			manifestGraphError(
				`graph exceeds depth ${MANIFEST_JSON_LIMITS.maxDepth}`,
			);
		}

		if (value === null) {
			projectedBytes = addManifestProjection(projectedBytes, 4);
			continue;
		}
		if (typeof value === "string") {
			projectedBytes = addManifestProjection(
				projectedBytes,
				projectedJsonStringBytes(value),
			);
			continue;
		}
		if (typeof value === "number") {
			if (!Number.isFinite(value)) {
				manifestGraphError("numbers must be finite JSON scalars");
			}
			projectedBytes = addManifestProjection(
				projectedBytes,
				value === 0 ? 1 : NUMBER_TO_STRING.call(value).length,
			);
			continue;
		}
		if (typeof value === "boolean") {
			projectedBytes = addManifestProjection(
				projectedBytes,
				value ? 4 : 5,
			);
			continue;
		}
		if (typeof value !== "object" || NODE_IS_PROXY(value)) {
			manifestGraphError("values must be finite JSON data");
		}
		if (weakSetHas(active, value)) {
			manifestGraphError("graph must not contain cycles");
		}
		weakSetAdd(active, value);
		stack.push({ value, depth: current.depth, exit: true });

		const array = ARRAY_IS_ARRAY(value);
		const expectedPrototype = array
			? Array.prototype
			: Object.prototype;
		if (OBJECT_GET_PROTOTYPE_OF(value) !== expectedPrototype) {
			manifestGraphError(
				"containers must use exact Object or Array prototypes",
			);
		}
		const ownKeys = REFLECT_OWN_KEYS(value);

		if (array) {
			const lengthDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
				value,
				"length",
			);
			const length =
				lengthDescriptor !== undefined &&
				"value" in lengthDescriptor
					? lengthDescriptor.value
					: -1;
			if (
				!Number.isSafeInteger(length) ||
				length < 0 ||
				length > MANIFEST_JSON_LIMITS.maxContainerEntries ||
				ownKeys.length !== length + 1
			) {
				manifestGraphError(
					`array exceeds ${MANIFEST_JSON_LIMITS.maxContainerEntries} dense entries`,
				);
			}
			projectedBytes = addManifestProjection(
				projectedBytes,
				projectedContainerSyntaxBytes(
					current.depth,
					length,
					false,
				),
			);
			for (let index = 0; index < length; index += 1) {
				stack.push({
					value: requireEnumerableDataProperty(
						value,
						NUMBER_TO_STRING.call(index),
					),
					depth: current.depth + 1,
				});
			}
			continue;
		}

		if (
			ownKeys.length > MANIFEST_JSON_LIMITS.maxContainerEntries
		) {
			manifestGraphError(
				`object exceeds ${MANIFEST_JSON_LIMITS.maxContainerEntries} entries`,
			);
		}
		projectedBytes = addManifestProjection(
			projectedBytes,
			projectedContainerSyntaxBytes(
				current.depth,
				ownKeys.length,
				true,
			),
		);
		for (const key of ownKeys) {
			if (typeof key !== "string") {
				manifestGraphError("symbol keys are not JSON data");
			}
			projectedBytes = addManifestProjection(
				projectedBytes,
				projectedJsonStringBytes(key),
			);
			stack.push({
				value: requireEnumerableDataProperty(value, key),
				depth: current.depth + 1,
			});
		}
	}
	return projectedBytes;
}

function sha256(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}
function compareCodeUnits(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function describeUntrustedValue(value) {
	if (value === null) return "null";
	if (typeof value === "string") {
		return `string(length=${value.length})`;
	}
	if (typeof value === "number") {
		if (Number.isNaN(value)) return "number(NaN)";
		if (value === Number.POSITIVE_INFINITY) {
			return "number(Infinity)";
		}
		if (value === Number.NEGATIVE_INFINITY) {
			return "number(-Infinity)";
		}
		return `number(${NUMBER_TO_STRING.call(value)})`;
	}
	if (typeof value === "boolean") {
		return value ? "boolean(true)" : "boolean(false)";
	}
	return typeof value;
}

function artifactBudgetError(field, observed, maximum) {
	throw new Error(
		`E_PACKAGE_ARTIFACT_BUDGET: ${field} must be a non-negative safe integer no greater than ${maximum}; received ${describeUntrustedValue(observed)}`,
	);
}

function checkedResourceBytes(field, value, maximum) {
	if (
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value > maximum
	) {
		artifactBudgetError(field, value, maximum);
	}
	return value;
}

function checkedArtifactBytes(field, value, maximum) {
	return checkedResourceBytes(
		field,
		value,
		Math.min(maximum, PACKAGE_ARTIFACT_HARD_CEILING_BYTES),
	);
}

function artifactBudgetPreflight(manifest, options) {
	const kind = manifest?.kind;
	if (
		typeof kind !== "string" ||
		!Object.hasOwn(P03_ARTIFACT_LIMITS_BY_KIND, kind)
	) {
		throw new Error(
			`E_PACKAGE_ARTIFACT_BUDGET: kind must be a frozen P03 content kind; received ${describeUntrustedValue(kind)}`,
		);
	}
	const limits = P03_ARTIFACT_LIMITS_BY_KIND[kind];
	const maximum = Math.min(
		limits.artifactBytes,
		PACKAGE_ARTIFACT_HARD_CEILING_BYTES,
	);
	const declaredBytes = checkedArtifactBytes(
		"declared bytes",
		manifest?.totals?.bytes,
		maximum,
	);
	return {
		limits,
		maximum,
		declaredBytes,
		targetBytes:
			options.reconcileTotals === false
				? checkedArtifactBytes("target bytes", declaredBytes, maximum)
				: null,
	};
}

function checkedArtifactSum(field, left, right, maximum) {
	checkedArtifactBytes(`${field} left operand`, left, maximum);
	checkedArtifactBytes(`${field} right operand`, right, maximum);
	return checkedArtifactBytes(field, left + right, maximum);
}

function checkedResourceSum(field, left, right, maximum) {
	checkedResourceBytes(`${field} left operand`, left, maximum);
	checkedResourceBytes(`${field} right operand`, right, maximum);
	return checkedResourceBytes(field, left + right, maximum);
}
/*
 * Conservative retained-byte projection, not an exact V8 heap measurement.
 * Four manifest-sized allowances cover the input graph, structured clone,
 * serialized manifest bytes, and package metadata/encoding.
 */
export function projectPackageArtifactWorkingBytes(
	effectiveArtifactBytes,
	maximumTarMemberBytes,
	manifestProjectedBytes,
) {
	const artifactBytes = checkedResourceBytes(
		"effective artifact bytes",
		effectiveArtifactBytes,
		PACKAGE_ARTIFACT_HARD_CEILING_BYTES,
	);
	const tarMemberBytes = checkedResourceBytes(
		"maximum projected tar member bytes",
		maximumTarMemberBytes,
		P02_MAX_PADDED_TAR_MEMBER_BYTES,
	);
	const manifestBytes = checkedResourceBytes(
		"manifest projected UTF-8 bytes",
		manifestProjectedBytes,
		MANIFEST_JSON_LIMITS.maxProjectedUtf8Bytes,
	);
	const manifestAllowanceBytes = checkedResourceBytes(
		"projected manifest retention bytes",
		manifestBytes *
			PACKAGE_ARTIFACT_PROJECTED_WORKING_LIMITS.manifestRetentionCopies,
		PACKAGE_ARTIFACT_PROJECTED_WORKING_LIMITS.maxInternalBytes,
	);
	const compressionBaseBytes = checkedResourceSum(
		"projected compression base bytes",
		artifactBytes,
		tarMemberBytes * 2,
		PACKAGE_ARTIFACT_PROJECTED_WORKING_LIMITS.maxInternalBytes,
	);
	const compressionPhaseBytes = checkedResourceSum(
		"projected compression-phase internal working bytes",
		compressionBaseBytes,
		manifestAllowanceBytes,
		PACKAGE_ARTIFACT_PROJECTED_WORKING_LIMITS.maxInternalBytes,
	);
	const finalBaseBytes = checkedResourceBytes(
		"projected final-materialization base bytes",
		artifactBytes * 2,
		PACKAGE_ARTIFACT_PROJECTED_WORKING_LIMITS.maxInternalBytes,
	);
	const finalMaterializationBytes = checkedResourceSum(
		"projected final-materialization internal working bytes",
		finalBaseBytes,
		manifestAllowanceBytes,
		PACKAGE_ARTIFACT_PROJECTED_WORKING_LIMITS.maxInternalBytes,
	);
	const peakBytes = checkedResourceBytes(
		"projected peak internal working bytes",
		Math.max(compressionPhaseBytes, finalMaterializationBytes),
		PACKAGE_ARTIFACT_PROJECTED_WORKING_LIMITS.maxInternalBytes,
	);
	return {
		compressionPhaseBytes,
		finalMaterializationBytes,
		peakBytes,
	};
}


function checkedArtifactCount(field, value, maximum) {
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
		throw new Error(
			`E_PACKAGE_ARTIFACT_BUDGET: ${field} must be a non-negative safe integer no greater than ${maximum}; received ${describeUntrustedValue(value)}`,
		);
	}
	return value;
}

function intrinsicMapSize(value) {
	try {
		if (
			value === null ||
			typeof value !== "object" ||
			OBJECT_GET_PROTOTYPE_OF(value) !== INTRINSIC_MAP_PROTOTYPE
		) {
			throw new Error("asset bytes Map has a non-canonical prototype");
		}
		return callIntrinsic(MAP_SIZE_GETTER, value, []);
	} catch (cause) {
		throw new Error(
			"E_PACKAGE_ARTIFACT_INPUT: asset bytes must be an exact concrete Map",
			{ cause },
		);
	}
}

function projectedTarMemberBytes(rawBytes) {
	const contentBytes = Math.ceil(rawBytes / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
	return checkedArtifactSum(
		"projected tar member bytes",
		TAR_BLOCK_BYTES,
		contentBytes,
		PACKAGE_ARTIFACT_HARD_CEILING_BYTES,
	);
}

function preflightAssetResources(
	manifest,
	manifestProjectedBytes,
	assetBytes,
	budget,
	options,
) {
	const manifestAssets = manifest?.assets;
	if (!ARRAY_IS_ARRAY(manifestAssets)) {
		throw new Error(
			"E_PACKAGE_ARTIFACT_BUDGET: manifest assets must be a bounded array",
		);
	}
	const assetCount = checkedArtifactCount(
		"manifest asset count",
		manifestAssets.length,
		budget.limits.maxFiles,
	);
	const declaredByPath = new INTRINSIC_MAP();
	let maxDepth = 0;
	for (let index = 0; index < assetCount; index += 1) {
		const asset = manifestAssets[index];
		const path = asset?.path;
		const depth = canonicalAssetPath(path);
		if (mapHas(declaredByPath, path)) {
			throw new Error(
				`E_PACKAGE_ARTIFACT_PATH: duplicate canonical tar member path: ${path}`,
			);
		}
		checkedArtifactBytes(
			`manifest asset ${index} bytes`,
			asset?.bytes,
			budget.limits.maxFileBytes,
		);
		mapSet(declaredByPath, path, asset);
		maxDepth = Math.max(maxDepth, depth);
	}
	const byteEntryCount = checkedArtifactCount(
		"asset byte entry count",
		intrinsicMapSize(assetBytes),
		budget.limits.maxFiles,
	);
	if (assetCount !== byteEntryCount) {
		throw new Error(
			"E_PACKAGE_ARTIFACT_BUDGET: asset byte count must equal the manifest asset count",
		);
	}

	const directTotals =
		options.reconcileTotals === false ? manifest?.totals : null;
	let maximumCompressionRatio = 100;
	if (directTotals !== null) {
		if (
			!Number.isSafeInteger(directTotals?.maxCompressionRatio) ||
			directTotals.maxCompressionRatio < 1 ||
			directTotals.maxCompressionRatio > 100
		) {
			throw new Error(
				"E_PACKAGE_ARTIFACT_BUDGET: direct maximum compression ratio must be an integer from 1 through 100",
			);
		}
		maximumCompressionRatio = directTotals.maxCompressionRatio;
	}

	let rawBytes = 0;
	let maximumTarMemberBytes = Math.max(
		TAR_END_BYTES,
		projectedTarMemberBytes(manifestProjectedBytes),
	);
	let minimumArchiveBytes = MIN_GZIP_MEMBER_BYTES * 3;
	consumeMapEntries(
		assetBytes,
		byteEntryCount,
		"asset byte Map",
		(path, bytes, index) => {
			canonicalAssetPath(path);
			const asset = mapGet(declaredByPath, path);
			if (asset === undefined || !Buffer.isBuffer(bytes)) {
				throw new Error(
					`E_PACKAGE_ARTIFACT_BUDGET: asset byte entry ${index} must exactly match a manifest path and Buffer`,
				);
			}
			const actualBytes = checkedArtifactBytes(
				`actual asset ${index} bytes`,
				bytes.length,
				budget.limits.maxFileBytes,
			);
			if (actualBytes !== asset.bytes) {
				throw new Error(
					`E_PACKAGE_ARTIFACT_BUDGET: actual asset ${index} bytes must equal its manifest declaration`,
				);
			}
			rawBytes = checkedResourceSum(
				"aggregate raw asset bytes",
				rawBytes,
				actualBytes,
				budget.limits.rawBytes,
			);
			const memberBytes = projectedTarMemberBytes(actualBytes);
			maximumTarMemberBytes = Math.max(
				maximumTarMemberBytes,
				memberBytes,
			);
			minimumArchiveBytes = checkedArtifactSum(
				"minimum archive bytes",
				minimumArchiveBytes,
				Math.max(
					MIN_GZIP_MEMBER_BYTES,
					Math.ceil(memberBytes / maximumCompressionRatio),
				),
				budget.maximum,
			);
		},
	);
	projectPackageArtifactWorkingBytes(
		budget.maximum,
		maximumTarMemberBytes,
		manifestProjectedBytes,
	);

	if (options.reconcileTotals === false) {
		const totals = directTotals;
		if (
			totals?.fileCount !== assetCount ||
			totals?.uncompressedBytes !== rawBytes ||
			totals?.maxDepth !== maxDepth
		) {
			throw new Error(
				"E_PACKAGE_ARTIFACT_BUDGET: direct artifact totals must exactly match bounded asset facts",
			);
		}
		if (budget.targetBytes < minimumArchiveBytes) {
			throw new Error(
				`E_PACKAGE_ARTIFACT_BUDGET: target bytes cannot be below the minimum archive envelope ${minimumArchiveBytes}`,
			);
		}
	}
}

function checkedPaddingBytes(targetBytes, outputBytes, maximum) {
	checkedArtifactBytes("target bytes", targetBytes, maximum);
	checkedArtifactBytes("output bytes", outputBytes, maximum);
	const paddingBytes = checkedArtifactBytes(
		"padding bytes",
		targetBytes - outputBytes,
		maximum,
	);
	if (
		paddingBytes !== 0 &&
		paddingBytes < MIN_EMPTY_GZIP_MEMBER_BYTES
	) {
		throw new Error(
			`E_PACKAGE_ARTIFACT_BUDGET: padding bytes must be zero or at least ${MIN_EMPTY_GZIP_MEMBER_BYTES}; received ${paddingBytes}`,
		);
	}
	return paddingBytes;
}


function sha512Integrity(buffer) {
	return `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
}

function jsonBytes(value) {
	return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeTarOctal(header, offset, length, value) {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(
			"E_PACKAGE_ARTIFACT_NUMBER: tar values must be non-negative safe integers",
		);
	}
	const encoded = value.toString(8).padStart(length - 1, "0");
	if (encoded.length >= length) {
		throw new Error(
			"E_PACKAGE_ARTIFACT_NUMBER: tar value exceeds its fixed field",
		);
	}
	header.write(`${encoded}\0`, offset, length, "ascii");
}

function canonicalTarPathBytes(path) {
	let canonical =
		typeof path === "string" &&
		path.length > 0 &&
		path.length <= 100 &&
		!path.includes("\\") &&
		!path.includes("\0");
	let pathBytes;
	if (canonical) {
		const segments = path.split("/");
		pathBytes = Buffer.from(path, "utf8");
		canonical =
			path === path.normalize("NFC") &&
			segments.every(
				(segment) =>
					segment.length > 0 && segment !== "." && segment !== "..",
			) &&
			pathBytes.toString("utf8") === path &&
			pathBytes.length <= 100;
	}
	if (!canonical) {
		throw new Error(
			`E_PACKAGE_ARTIFACT_PATH: tar path is not a canonical reviewed USTAR name: ${describeUntrustedValue(path)}`,
		);
	}
	return pathBytes;
}
function canonicalAssetPath(path) {
	if (typeof path !== "string" || !path.startsWith("assets/")) {
		throw new Error(
			`E_PACKAGE_ARTIFACT_PATH: manifest asset path must start with assets/: ${describeUntrustedValue(path)}`,
		);
	}
	canonicalTarPathBytes(`${PACKAGE_PREFIX}${path}`);
	const depth = path.split("/").length;
	if (depth > P02_PACKAGE_RESOURCE_LIMITS.maxDepth) {
		throw new Error(
			`E_PACKAGE_ARTIFACT_PATH: manifest asset path exceeds depth ${P02_PACKAGE_RESOURCE_LIMITS.maxDepth}: ${path}`,
		);
	}
	return depth;
}


function tarHeader(path, size) {
	const pathBytes = canonicalTarPathBytes(path);
	const header = Buffer.alloc(TAR_BLOCK_BYTES);
	pathBytes.copy(header, 0);
	writeTarOctal(header, 100, 8, 0o644);
	writeTarOctal(header, 108, 8, 0);
	writeTarOctal(header, 116, 8, 0);
	writeTarOctal(header, 124, 12, size);
	writeTarOctal(header, 136, 12, 0);
	header.fill(0x20, 148, 156);
	header[156] = 0x30;
	header.write("ustar\0", 257, 6, "ascii");
	header.write("00", 263, 2, "ascii");
	let checksum = 0;
	for (const byte of header) checksum += byte;
	const checksumText = checksum.toString(8).padStart(6, "0");
	header.write(checksumText, 148, 6, "ascii");
	header[154] = 0;
	header[155] = 0x20;
	return header;
}

function tarSegment(path, bytes) {
	const padding =
		(TAR_BLOCK_BYTES - (bytes.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
	return Buffer.concat([
		tarHeader(path, bytes.length),
		bytes,
		Buffer.alloc(padding),
	]);
}

function stableGzip(bytes) {
	const compressed = gzipSync(bytes, { level: 9 });
	compressed.fill(0, 4, 8);
	compressed[9] = 0xff;
	return compressed;
}
function emptyGzipMember(totalBytes) {
	if (
		!Number.isSafeInteger(totalBytes) ||
		totalBytes < MIN_EMPTY_GZIP_MEMBER_BYTES
	) {
		throw new Error(
			"E_PACKAGE_ARTIFACT_PADDING: empty gzip member cannot bind requested bytes",
		);
	}
	const base = stableGzip(Buffer.alloc(0));
	const commentBytes = totalBytes - base.length;
	const header = Buffer.from(base.subarray(0, 10));
	header[3] |= 0x10;
	const comment = Buffer.alloc(commentBytes, 0x50);
	comment[comment.length - 1] = 0;
	return Buffer.concat([header, comment, base.subarray(10)]);
}

function normalizedAssets(manifest, assetBytes) {
	const assetByteCount = intrinsicMapSize(assetBytes);
	const declared = new INTRINSIC_MAP();
	const declaredEntries = [];
	const manifestAssets = ARRAY_IS_ARRAY(manifest?.assets)
		? manifest.assets
		: [];
	for (const asset of manifestAssets) {
		const path = asset?.path;
		canonicalAssetPath(path);
		if (mapHas(declared, path)) {
			throw new Error(
				`E_PACKAGE_ARTIFACT_PATH: duplicate canonical tar member path: ${path}`,
			);
		}
		mapSet(declared, path, asset);
		declaredEntries.push([path, asset]);
	}
	consumeMapKeys(
		assetBytes,
		assetByteCount,
		"asset byte Map",
		(path) => {
			canonicalAssetPath(path);
			if (!mapHas(declared, path)) {
				throw new Error(
					`E_PACKAGE_ARTIFACT_SET: undeclared artifact member ${path}`,
				);
			}
		},
	);
	if (intrinsicMapSize(declared) !== assetByteCount) {
		throw new Error(
			"E_PACKAGE_ARTIFACT_SET: asset byte keys must exactly match the manifest inventory",
		);
	}
	declaredEntries.sort((left, right) =>
		compareCodeUnits(left[0], right[0]),
	);
	const assets = [];
	for (let index = 0; index < declaredEntries.length; index += 1) {
		const pair = declaredEntries[index];
		const path = pair[0];
		const asset = pair[1];
		const bytes = mapGet(assetBytes, path);
		if (
			!Buffer.isBuffer(bytes) ||
			bytes.length !== asset.bytes ||
			sha256(bytes) !== asset.sha256
		) {
			throw new Error(
				`E_PACKAGE_ARTIFACT_FILE: bytes do not match manifest asset ${path}`,
			);
		}
		assets.push({ path, asset, bytes });
	}
	return assets;
}

function packageJsonFor(manifest) {
	return {
		name: manifest.name,
		version: manifest.version,
		license: manifest.license,
		files: ["manifest.json", "assets"],
	};
}

function archiveFacts(assets, compressedBytes) {
	const uncompressedBytes = assets.reduce(
		(sum, entry) => sum + entry.bytes.length,
		0,
	);
	const maxDepth = assets.reduce(
		(maximum, entry) => Math.max(maximum, entry.path.split("/").length),
		0,
	);
	return {
		compressedBytes,
		uncompressedBytes,
		fileCount: assets.length,
		maxDepth,
	};
}

function measureArtifact(manifest, fixedMembers, maximumBytes) {
	const manifestBytes = jsonBytes(manifest);
	const manifestMember = {
		path: `${PACKAGE_PREFIX}manifest.json`,
		bytes: manifestBytes,
		compressed: stableGzip(
			tarSegment(`${PACKAGE_PREFIX}manifest.json`, manifestBytes),
		),
	};
	const members = [
		fixedMembers.packageJson,
		manifestMember,
		...fixedMembers.assets,
	];
	const outputBytes = checkedArtifactSum(
		"measured compressed member bytes",
		fixedMembers.compressedBytes,
		manifestMember.compressed.length,
		maximumBytes,
	);
	return {
		outputBytes,
		manifestBytes,
		manifestMember,
		members,
		parts: [
			...members.map((member) => member.compressed),
			fixedMembers.terminator,
		],
	};
}

export function buildDeterministicPackageArtifact(
	inputManifest,
	assetBytes,
	options = {},
) {
	assertAuditedNodeRuntime();
	const manifestProjectedBytes =
		preflightPlainJsonManifest(inputManifest);
	const budget = artifactBudgetPreflight(inputManifest, options);
	preflightAssetResources(
		inputManifest,
		manifestProjectedBytes,
		assetBytes,
		budget,
		options,
	);
	const assets = normalizedAssets(inputManifest, assetBytes);
	const manifest = structuredClone(inputManifest);
	const packageJsonBytes = jsonBytes(packageJsonFor(manifest));
	const packageJsonMember = {
		path: `${PACKAGE_PREFIX}package.json`,
		bytes: packageJsonBytes,
		compressed: stableGzip(
			tarSegment(`${PACKAGE_PREFIX}package.json`, packageJsonBytes),
		),
	};
	const terminator = stableGzip(Buffer.alloc(TAR_END_BYTES));
	let retainedCompressedBytes = checkedArtifactSum(
		"retained compressed member bytes",
		packageJsonMember.compressed.length,
		terminator.length,
		budget.maximum,
	);
	const assetMembers = [];
	for (const entry of assets) {
		const compressed = stableGzip(
			tarSegment(`${PACKAGE_PREFIX}${entry.path}`, entry.bytes),
		);
		retainedCompressedBytes = checkedArtifactSum(
			"retained compressed member bytes",
			retainedCompressedBytes,
			compressed.length,
			budget.maximum,
		);
		assetMembers.push({
			path: `${PACKAGE_PREFIX}${entry.path}`,
			runtimePath: entry.path,
			bytes: entry.bytes,
			compressed,
		});
	}
	const fixedMembers = {
		packageJson: packageJsonMember,
		assets: assetMembers,
		terminator,
		compressedBytes: retainedCompressedBytes,
	};
	const baseArchive = archiveFacts(assets, 0);
	if (options.reconcileTotals !== false) {
		manifest.totals = {
			bytes:
				Number.isSafeInteger(manifest?.totals?.bytes) &&
				manifest.totals.bytes >= 0
					? manifest.totals.bytes
					: 0,
			fileCount: baseArchive.fileCount,
			uncompressedBytes: baseArchive.uncompressedBytes,
			maxDepth: baseArchive.maxDepth,
			maxCompressionRatio: 100,
		};
	}

	let measured = measureArtifact(
		manifest,
		fixedMembers,
		budget.maximum,
	);
	let targetBytes = budget.targetBytes;
	if (options.reconcileTotals !== false) {
		targetBytes = checkedArtifactSum(
			"target bytes",
			measured.outputBytes,
			ARTIFACT_SIZE_BINDING_SLACK,
			budget.maximum,
		);
		manifest.totals.bytes = targetBytes;
		measured = measureArtifact(
			manifest,
			fixedMembers,
			budget.maximum,
		);
	}
	const paddingBytes = checkedPaddingBytes(
		targetBytes,
		measured.outputBytes,
		budget.maximum,
	);
	const sizeBinding =
		paddingBytes === 0 ? undefined : emptyGzipMember(paddingBytes);
	const finalOutputBytes = checkedArtifactSum(
		"output bytes",
		measured.outputBytes,
		sizeBinding?.length ?? 0,
		budget.maximum,
	);
	if (finalOutputBytes !== targetBytes) {
		throw new Error(
			`E_PACKAGE_ARTIFACT_BUDGET: output bytes must exactly equal target bytes; received ${finalOutputBytes} for target ${targetBytes}`,
		);
	}
	const finalParts =
		sizeBinding === undefined
			? measured.parts
			: [...measured.parts, sizeBinding];
	const finalBytes = Buffer.concat(finalParts, finalOutputBytes);

	const archive = archiveFacts(assets, finalBytes.length);
	const entries = [
		{
			path: "package.json",
			archivePath: fixedMembers.packageJson.path,
			bytes: packageJsonBytes.length,
			compressedBytes: fixedMembers.packageJson.compressed.length,
			kind: "metadata",
		},
		{
			path: "manifest.json",
			archivePath: measured.manifestMember.path,
			bytes: measured.manifestBytes.length,
			compressedBytes: measured.manifestMember.compressed.length,
			kind: "metadata",
		},
		...fixedMembers.assets.map((member) => ({
			path: member.runtimePath,
			archivePath: member.path,
			bytes: member.bytes.length,
			compressedBytes: member.compressed.length,
			kind: "asset",
		})),
	];
	return {
		manifest,
		manifestBytes: measured.manifestBytes,
		manifestSha256: sha256(measured.manifestBytes),
		packageJsonBytes,
		bytes: finalBytes,
		integrity: sha512Integrity(finalBytes),
		archive,
		overhead: {
			terminatorCompressedBytes: fixedMembers.terminator.length,
			sizeBindingCompressedBytes: sizeBinding?.length ?? 0,
		},
		entries,
	};
}
