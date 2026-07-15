import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFile,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	truncate,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { deflateSync, gunzipSync } from "node:zlib";

import { describe, expect, expectTypeOf, it } from "vitest";

import { parseManifest } from "../../packages/protocol/src/browser.js";
import { validatePackageInspection } from "../../packages/protocol/src/validation/package-inspection.js";
import { CONTENT_BUDGETS } from "../../packages/protocol/src/version.js";
import { canonicalConfigSha256 as productionCanonicalConfigSha256 } from "../../tools/assets/lib/canonical-config.mjs";
import type { StarterPackageInspectionFacts } from "../../tools/assets/lib/asset-pipeline.mjs";
import {
	ASSET_LIMITS,
	assertAuditedNodeRuntime,
	buildAssetBudgetReport,
	buildDeterministicPackageArtifact,
	contentDigest,
	inspectGlb,
	inspectPng,
	inspectStarterPackages,
	inspectWav,
	PIPELINE_CONFIG,
	readProjectLicenseBytes,
	readStarterTemplates,
	rebuildStarterContent,
	scanStarterRuntimeFiles,
	validatePackageBudgets,
	verifyStarterHashes,
} from "../../tools/assets/lib/asset-pipeline.mjs";

const execFile = promisify(execFileCallback);

const ROOT = process.cwd();
const SOURCE_ROOT = join(
	ROOT,
	"tools",
	"assets",
	"sources",
	"kenney-nature-kit",
);
const CONTENT_ROOT = join(ROOT, "content");

function canonicalConfigSha256(
	config: Record<string, string | number | boolean | null>,
): string {
	const canonical = JSON.stringify(
		Object.fromEntries(
			Object.keys(config)
				.sort()
				.map((key) => [key, config[key]]),
		),
	);
	return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function makeGlb(
	document: Record<string, unknown>,
	binary: Buffer = Buffer.alloc(0),
): Buffer {
	const json = Buffer.from(JSON.stringify(document), "utf8");
	const paddedJsonLength = Math.ceil(json.length / 4) * 4;
	const paddedBinaryLength = Math.ceil(binary.length / 4) * 4;
	const hasBinary = paddedBinaryLength > 0;
	const total =
		12 + 8 + paddedJsonLength + (hasBinary ? 8 + paddedBinaryLength : 0);
	const output = Buffer.alloc(total, 0);
	output.writeUInt32LE(0x46546c67, 0);
	output.writeUInt32LE(2, 4);
	output.writeUInt32LE(total, 8);
	output.writeUInt32LE(paddedJsonLength, 12);
	output.writeUInt32LE(0x4e4f534a, 16);
	json.copy(output, 20);
	output.fill(0x20, 20 + json.length, 20 + paddedJsonLength);
	if (hasBinary) {
		const offset = 20 + paddedJsonLength;
		output.writeUInt32LE(paddedBinaryLength, offset);
		output.writeUInt32LE(0x004e4942, offset + 4);
		binary.copy(output, offset + 8);
	}
	return output;
}
function glbDocument(buffer: Buffer): {
	nodes?: Array<{
		name?: string;
		mesh?: number;
		translation?: number[];
		rotation?: number[];
		scale?: number[];
	}>;
	meshes?: unknown[];
	scenes?: Array<{ name?: string; nodes?: number[] }>;
} {
	if (
		buffer.length < 20 ||
		buffer.readUInt32LE(0) !== 0x46546c67 ||
		buffer.readUInt32LE(16) !== 0x4e4f534a
	) {
		throw new Error("Missing generated GLB JSON chunk");
	}
	const jsonLength = buffer.readUInt32LE(12);
	if (20 + jsonLength > buffer.length) {
		throw new Error("Truncated generated GLB JSON chunk");
	}
	return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString("utf8"));
}
function makeGlbWithJsonChunk(jsonChunk: Buffer): Buffer {
	const output = Buffer.alloc(20 + jsonChunk.length);
	output.writeUInt32LE(0x46546c67, 0);
	output.writeUInt32LE(2, 4);
	output.writeUInt32LE(output.length, 8);
	output.writeUInt32LE(jsonChunk.length, 12);
	output.writeUInt32LE(0x4e4f534a, 16);
	jsonChunk.copy(output, 20);
	return output;
}

function baseDocument(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		asset: { version: "2.0", generator: "Infinite Snowball test" },
		scenes: [{ nodes: [0] }],
		scene: 0,
		nodes: [{ mesh: 0 }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
		accessors: [
			{
				componentType: 5126,
				count: 3,
				type: "VEC3",
				min: [-1, -1, -1],
				max: [1, 1, 1],
			},
		],
		...overrides,
	};
}

function crc32(buffer: Buffer): number {
	let value = 0xffffffff;
	for (const byte of buffer) {
		value ^= byte;
		for (let bit = 0; bit < 8; bit += 1)
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	}
	return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const typeBytes = Buffer.from(type, "ascii");
	const chunk = Buffer.alloc(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	typeBytes.copy(chunk, 4);
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
	return chunk;
}

function fakePng(
	width: number,
	height: number,
	idatSuffix: Buffer = Buffer.alloc(0),
): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const rows = Buffer.alloc(height * (1 + width * 4));
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", Buffer.concat([deflateSync(rows), idatSuffix])),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function makeStructuredPng({
	bitDepth,
	colorType,
	palette,
	extraChunkType,
}: {
	readonly bitDepth: number;
	readonly colorType: number;
	readonly palette?: Buffer;
	readonly extraChunkType?: string;
}): Buffer {
	const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
	if (channels === undefined) throw new Error("Unsupported test color type");
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(1, 0);
	ihdr.writeUInt32BE(1, 4);
	ihdr[8] = bitDepth;
	ihdr[9] = colorType;
	const rows = Buffer.alloc(1 + Math.ceil((channels * bitDepth) / 8));
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk("IHDR", ihdr),
		...(palette === undefined ? [] : [pngChunk("PLTE", palette)]),
		...(extraChunkType === undefined
			? []
			: [pngChunk(extraChunkType, Buffer.alloc(0))]),
		pngChunk("IDAT", deflateSync(rows)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function makeWav(): Buffer {
	const output = Buffer.alloc(48);
	output.write("RIFF", 0, "ascii");
	output.writeUInt32LE(40, 4);
	output.write("WAVE", 8, "ascii");
	output.write("fmt ", 12, "ascii");
	output.writeUInt32LE(16, 16);
	output.writeUInt16LE(1, 20);
	output.writeUInt16LE(2, 22);
	output.writeUInt32LE(44_100, 24);
	output.writeUInt32LE(176_400, 28);
	output.writeUInt16LE(4, 32);
	output.writeUInt16LE(16, 34);
	output.write("data", 36, "ascii");
	output.writeUInt32LE(4, 40);
	return output;
}

function withLeadingWavChunk(wav: Buffer): Buffer {
	const payload = Buffer.from([0x01, 0x02, 0x03]);
	const chunk = Buffer.alloc(8 + payload.length + (payload.length & 1));
	chunk.write("JUNK", 0, "ascii");
	chunk.writeUInt32LE(payload.length, 4);
	payload.copy(chunk, 8);
	const output = Buffer.concat([wav.subarray(0, 12), chunk, wav.subarray(12)]);
	output.writeUInt32LE(output.length - 8, 4);
	return output;
}

function withExtendedWavFormat(wav: Buffer, extraBytes: number): Buffer {
	const extension = Buffer.alloc(extraBytes);
	const padding = Buffer.alloc(extraBytes & 1);
	const output = Buffer.concat([
		wav.subarray(0, 36),
		extension,
		padding,
		wav.subarray(36),
	]);
	output.writeUInt32LE(16 + extraBytes, 16);
	output.writeUInt32LE(output.length - 8, 4);
	return output;
}

type PackageReference = {
	name: string;
	version: string;
	kind: string;
	manifestSha256: string;
	integrity: string;
};

function updatePackageReferences(
	value: unknown,
	references: ReadonlyMap<string, PackageReference>,
): void {
	if (Array.isArray(value)) {
		for (const entry of value) updatePackageReferences(entry, references);
		return;
	}
	if (value === null || typeof value !== "object") return;
	const object = value as Record<string, unknown>;
	if (
		typeof object.name === "string" &&
		typeof object.manifestSha256 === "string" &&
		typeof object.integrity === "string"
	) {
		const replacement = references.get(object.name);
		if (replacement !== undefined) Object.assign(object, replacement);
	}
	for (const entry of Object.values(object))
		updatePackageReferences(entry, references);
}

async function rewritePackageArtifact(
	contentRoot: string,
	directory: string,
	references: ReadonlyMap<string, PackageReference>,
): Promise<PackageReference> {
	const packageRoot = join(contentRoot, directory);
	const manifestPath = join(packageRoot, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	updatePackageReferences(manifest, references);
	const declaredAssets = manifest.assets as Array<{ path: string }>;
	const assetBytes = new Map<string, Buffer>(
		await Promise.all(
			declaredAssets.map(
				async (asset) =>
					[asset.path, await readFile(join(packageRoot, asset.path))] as const,
			),
		),
	);
	const artifact = buildDeterministicPackageArtifact(manifest, assetBytes);
	await writeFile(
		manifestPath,
		`${JSON.stringify(artifact.manifest, null, 2)}\n`,
	);
	return {
		name: artifact.manifest.name,
		version: artifact.manifest.version,
		kind: artifact.manifest.kind,
		manifestSha256: artifact.manifestSha256,
		integrity: artifact.integrity,
	};
}

async function copiedRootWithEvidence(
	mutate: (evidence: Record<string, unknown>) => void,
): Promise<string> {
	const root = await mkdtemp(join(ROOT, ".tmp-infinite-snowball-p03-evidence-"));
	await cp(
		join(ROOT, "tools", "assets", "templates"),
		join(root, "tools", "assets", "templates"),
		{
			recursive: true,
		},
	);
	await cp(
		SOURCE_ROOT,
		join(root, "tools", "assets", "sources", "kenney-nature-kit"),
		{
			recursive: true,
		},
	);
	const licenseTarget = join(
		root,
		"docs",
		"licenses",
		"provenance",
		"infinite-snowball-original-content",
		"CC0-1.0.txt",
	);
	await mkdir(dirname(licenseTarget), { recursive: true });
	await cp(
		join(
			ROOT,
			"docs",
			"licenses",
			"provenance",
			"infinite-snowball-original-content",
			"CC0-1.0.txt",
		),
		licenseTarget,
	);
	const evidencePath = join(
		root,
		"tools",
		"assets",
		"sources",
		"kenney-nature-kit",
		"source-evidence.json",
	);
	const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as Record<
		string,
		unknown
	>;
	mutate(evidence);
	await writeFile(
		evidencePath,
		`${JSON.stringify(evidence, null, "\t")}\n`,
		"utf8",
	);
	return root;
}

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`Missing test fixture: ${label}`);
	return value;
}

describe("P03 deterministic asset pipeline", () => {
	it("pins the pipeline semantic budgets to the authoritative P02 snapshot", () => {
		expect(PIPELINE_CONFIG.contentBudgets).toEqual(CONTENT_BUDGETS);
	});

	it("binds deterministic artifacts to the exact audited Node runtime", () => {
		expect(PIPELINE_CONFIG.nodeVersion).toBe("22.13.1");
		expect(() => assertAuditedNodeRuntime("22.13.1")).not.toThrow();
		expect(() => assertAuditedNodeRuntime("22.13.2")).toThrow(
			/E_ASSET_RUNTIME.*22\.13\.1/u,
		);
	});
	it("canonicalizes transformation configs and protocol-validates reordered keys", async () => {
		const inspected = await inspectStarterPackages({ root: ROOT });
		const objectPackage = required(
			inspected.packages.find(
				(entry) => entry.packageName === "starter-objects",
			),
			"starter objects package",
		);
		const validationInput = structuredClone(objectPackage.inspection);
		const asset = required(
			validationInput.manifest.assets.find(
				(candidate) =>
					Object.keys(candidate.provenance.transformation.config).length > 1,
			),
			"asset with multi-key transformation config",
		);
		const transformation = asset.provenance.transformation as {
			config: Record<string, string | number | boolean | null>;
			configSha256: string;
		};
		const reordered = Object.fromEntries(
			Object.entries(transformation.config).reverse(),
		);
		expect(productionCanonicalConfigSha256(reordered)).toBe(
			productionCanonicalConfigSha256(transformation.config),
		);
		transformation.config = reordered;
		transformation.configSha256 =
			productionCanonicalConfigSha256(reordered);
		expect(validatePackageInspection(validationInput)).toMatchObject({
			ok: true,
			issues: [],
		});
	});

	it("rejects non-protocol transformation config values before hashing", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const invalid = [
			["undefined", { value: undefined }],
			["function", { value: () => undefined }],
			["bigint", { value: 1n }],
			["non-finite number", { value: Number.NaN }],
			["cyclic object", { value: cyclic }],
		] as const;
		for (const [label, config] of invalid) {
			expect(
				() => productionCanonicalConfigSha256(config as never),
				label,
			).toThrow(
				/^E_TRANSFORMATION_CONFIG:/u,
			);
		}
	});


	it("requires decoded local metrics in the public budget-validation contract", () => {
		expectTypeOf<StarterPackageInspectionFacts>().toHaveProperty(
			"localAssetMetrics",
		);
		const incomplete = {
			manifest: {
				kind: "object-pack",
				assets: [],
				entries: [],
				totals: {},
			},
			files: [],
		};
		expect(validatePackageBudgets(incomplete as never).issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ ruleId: "E_FILE_BUDGET" }),
			]),
		);
		const missingEntry = {
			manifest: {
				kind: "object-pack",
				assets: [
					{
						assetId: "render",
						path: "assets/render.glb",
						mime: "model/gltf-binary",
					},
				],
				entries: [{ objects: [{ renderAssetId: "render" }] }],
				totals: {},
			},
			files: [{ path: "assets/render.glb", bytes: 1 }],
			localAssetMetrics: {},
		};
		expect(validatePackageBudgets(missingEntry as never).issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ ruleId: "E_FILE_BUDGET" }),
			]),
		);
	});

	it("retains exactly one cleared prototype GLB with captured CC0 and preview evidence", async () => {
		const evidence = JSON.parse(
			await readFile(join(SOURCE_ROOT, "source-evidence.json"), "utf8"),
		);
		const retained = (await readdir(SOURCE_ROOT)).filter((name) =>
			name.endsWith(".glb"),
		);

		expect(retained).toEqual(["rock_smallA.glb"]);
		expect(evidence).toMatchObject({
			provider: "Kenney",
			sourceUrl: "https://kenney.nl/assets/nature-kit",
			sourceMember: "Models/GLTF format/rock_smallA.glb",
			creator: "Kenney",
			acquiredAt: "2026-07-15T00:00:00.000Z",
			license: { spdx: "CC0-1.0" },
			reviewer: "Infinite Snowball P03 provenance review",
			evidenceStatus: "verified",
		});
		expect(evidence.archiveSha256).toMatch(/^[a-f0-9]{64}$/u);
		expect(evidence.sourceArtifactSha256).toMatch(/^[a-f0-9]{64}$/u);
		expect(evidence.license.textSha256).toMatch(/^[a-f0-9]{64}$/u);
		expect(evidence.preview.sha256).toMatch(/^[a-f0-9]{64}$/u);
	});

	it.each([
		[
			"external URL",
			makeGlb({
				asset: { version: "2.0" },
				buffers: [{ byteLength: 0, uri: "https://example.com/model.bin" }],
			}),
			"E_GLB_EXTERNAL_REFERENCE",
		],
		[
			"data URI",
			makeGlb({
				asset: { version: "2.0" },
				images: [{ uri: "data:image/png;base64,AAAA" }],
			}),
			"E_GLB_EXTERNAL_REFERENCE",
		],
		[
			"unknown extension",
			makeGlb({
				asset: { version: "2.0" },
				extensionsRequired: ["EXT_unknown_runtime"],
			}),
			"E_GLB_EXTENSION_UNSUPPORTED",
		],
		[
			"invalid bounds",
			makeGlb(
				baseDocument({
					accessors: [
						{
							componentType: 5126,
							count: 3,
							type: "VEC3",
							min: [1, 0, 0],
							max: [0, 1, 1],
						},
					],
				}),
			),
			"E_GLB_BOUNDS_INVALID",
		],
		[
			"triangle budget",
			makeGlb(
				baseDocument({
					accessors: [
						{
							componentType: 5126,
							count: (ASSET_LIMITS.maxTriangles + 1) * 3,
							type: "VEC3",
							min: [-1, -1, -1],
							max: [1, 1, 1],
						},
					],
				}),
			),
			"E_ASSET_TRIANGLES",
		],
		[
			"material budget",
			makeGlb(
				baseDocument({
					materials: Array.from(
						{ length: ASSET_LIMITS.maxMaterials + 1 },
						() => ({}),
					),
				}),
			),
			"E_ASSET_MATERIALS",
		],
	] as const)("rejects %s with a stable fail-closed rule", (_label, buffer, ruleId) => {
		expect(inspectGlb(buffer).issues.map((issue) => issue.ruleId)).toContain(
			ruleId,
		);
	});

	it("rejects non-aligned chunks, NUL JSON padding, and malformed UTF-8", () => {
		const json = Buffer.from('{"asset":{"version":"2.0"}}', "utf8");
		const malformedUtf8 = Buffer.from(
			'{"asset":{"version":"2.0"},"note":"a"}  ',
			"utf8",
		);
		malformedUtf8[malformedUtf8.lastIndexOf(0x61)] = 0xff;
		for (const [label, glb, ruleId] of [
			["non-aligned JSON chunk", makeGlbWithJsonChunk(json), "E_GLB_CHUNK"],
			[
				"NUL-padded JSON chunk",
				makeGlbWithJsonChunk(Buffer.concat([json, Buffer.alloc(1)])),
				"E_GLB_JSON",
			],
			[
				"malformed UTF-8 JSON chunk",
				makeGlbWithJsonChunk(malformedUtf8),
				"E_GLB_JSON",
			],
		] as const) {
			expect(
				inspectGlb(glb).issues.map((entry) => entry.ruleId),
				label,
			).toContain(ruleId);
		}
	});

	it("accepts the largest semantic role envelope before role validation", () => {
		const binary = Buffer.alloc(3 * 1024 * 1024);
		const glb = makeGlb(
			baseDocument({
				accessors: [
					{
						componentType: 5126,
						count: 20_000 * 3,
						type: "VEC3",
						min: [-1, -1, -1],
						max: [1, 1, 1],
					},
				],
				buffers: [{ byteLength: binary.length }],
			}),
			binary,
		);
		const ruleIds = inspectGlb(glb).issues.map((entry) => entry.ruleId);
		expect(ruleIds).not.toContain("E_ASSET_BYTES");
		expect(ruleIds).not.toContain("E_ASSET_TRIANGLES");
	});

	it("rejects orphan BIN data, undeclared bytes, nonzero padding, and out-of-range views", () => {
		const valid = makeGlb(
			{
				asset: { version: "2.0" },
				buffers: [{ byteLength: 1 }],
			},
			Buffer.from([0x7f]),
		);
		expect(inspectGlb(valid).issues.map((entry) => entry.ruleId)).not.toContain(
			"E_GLB_BINARY_INVALID",
		);

		const nonzeroPadding = Buffer.from(valid);
		nonzeroPadding[nonzeroPadding.length - 1] = 0xff;
		const cases = [
			nonzeroPadding,
			makeGlb({ asset: { version: "2.0" } }, Buffer.alloc(4)),
			makeGlb(
				{
					asset: { version: "2.0" },
					buffers: [{ byteLength: 0 }],
				},
				Buffer.alloc(4),
			),
			makeGlb(
				{
					asset: { version: "2.0" },
					buffers: [{ byteLength: 1 }, { byteLength: 1 }],
				},
				Buffer.from([0x7f]),
			),
			makeGlb(
				{
					asset: { version: "2.0" },
					buffers: [{ byteLength: 1 }],
					bufferViews: [{ buffer: 0, byteOffset: 1, byteLength: 1 }],
				},
				Buffer.from([0x7f]),
			),
		];
		for (const glb of cases) {
			expect(inspectGlb(glb).issues.map((entry) => entry.ruleId)).toContain(
				"E_GLB_BINARY_INVALID",
			);
		}
	});

	it.each([
		[
			"unknown extensionsUsed",
			makeGlb({
				asset: { version: "2.0" },
				extensionsUsed: ["EXT_unknown_runtime"],
			}),
			"E_GLB_EXTENSION_UNSUPPORTED",
		],
		[
			"nested URI inside an allowed extension payload",
			makeGlb({
				asset: { version: "2.0" },
				extensionsUsed: ["KHR_materials_unlit"],
				materials: [
					{
						extensions: {
							KHR_materials_unlit: {
								nested: { uri: "https://example.com/hidden.bin" },
							},
						},
					},
				],
			}),
			"E_GLB_EXTERNAL_REFERENCE",
		],
		[
			"nested non-string URI field inside an allowed extension payload",
			makeGlb({
				asset: { version: "2.0" },
				extensionsUsed: ["KHR_materials_unlit"],
				materials: [
					{
						extensions: {
							KHR_materials_unlit: {
								nested: { imageUri: { encoded: "hidden.bin" } },
							},
						},
					},
				],
			}),
			"E_GLB_EXTERNAL_REFERENCE",
		],
		[
			"URL value under an arbitrary extension key",
			makeGlb({
				asset: { version: "2.0" },
				extensionsUsed: ["KHR_materials_unlit"],
				materials: [
					{
						extensions: {
							KHR_materials_unlit: {
								location: "preview at https://example.com/hidden.bin",
							},
						},
					},
				],
			}),
			"E_GLB_EXTERNAL_REFERENCE",
		],
		[
			"nested unreviewed extension container",
			makeGlb({
				asset: { version: "2.0" },
				extensionsUsed: ["KHR_materials_unlit"],
				materials: [
					{
						extensions: {
							KHR_materials_unlit: {
								nested: {
									extensions: { EXT_unknown_runtime: {} },
								},
							},
						},
					},
				],
			}),
			"E_GLB_EXTENSION_UNSUPPORTED",
		],
	] as const)("rejects %s", (_label, glb, ruleId) => {
		expect(inspectGlb(glb).issues.map((entry) => entry.ruleId)).toContain(
			ruleId,
		);
	});

	it.each([
		[
			"undeclared payload",
			{
				asset: { version: "2.0" },
				materials: [{ extensions: { KHR_materials_unlit: {} } }],
			},
		],
		[
			"malformed unlit payload",
			{
				asset: { version: "2.0" },
				extensionsUsed: ["KHR_materials_unlit"],
				materials: [{ extensions: { KHR_materials_unlit: { bogus: true } } }],
			},
		],
		[
			"malformed texture transform",
			{
				asset: { version: "2.0" },
				extensionsUsed: ["KHR_texture_transform"],
				materials: [
					{
						pbrMetallicRoughness: {
							baseColorTexture: {
								index: 0,
								extensions: {
									KHR_texture_transform: { offset: [0, "bad"] },
								},
							},
						},
					},
				],
			},
		],
		[
			"quantization payload",
			{
				asset: { version: "2.0" },
				extensionsUsed: ["KHR_mesh_quantization"],
				extensions: { KHR_mesh_quantization: {} },
			},
		],
	] as const)("rejects %s against reviewed extension schemas", (_label, doc) => {
		expect(
			inspectGlb(makeGlb(doc)).issues.map((entry) => entry.ruleId),
		).toContain("E_GLB_EXTENSION_UNSUPPORTED");
	});

	it("rejects split external references anywhere in reviewed extension payloads", () => {
		const glb = makeGlb({
			asset: { version: "2.0" },
			extensionsUsed: ["KHR_materials_unlit"],
			materials: [
				{
					extensions: {
						KHR_materials_unlit: {
							nested: ["https", "://example.com/asset.bin"],
						},
					},
				},
			],
		});
		expect(inspectGlb(glb).issues.map((entry) => entry.ruleId)).toContain(
			"E_GLB_EXTERNAL_REFERENCE",
		);
	});

	it("accepts declared extension payloads matching reviewed schemas", () => {
		const glb = makeGlb({
			asset: { version: "2.0" },
			extensionsUsed: ["KHR_materials_unlit", "KHR_texture_transform"],
			materials: [
				{
					extensions: { KHR_materials_unlit: {} },
					pbrMetallicRoughness: {
						baseColorTexture: {
							index: 0,
							extensions: {
								KHR_texture_transform: {
									offset: [0, 0],
									rotation: 0,
									scale: [1, 1],
									texCoord: 0,
								},
							},
						},
					},
				},
			],
		});
		expect(inspectGlb(glb).issues.map((entry) => entry.ruleId)).not.toContain(
			"E_GLB_EXTENSION_UNSUPPORTED",
		);
	});

	it("fails closed instead of overflowing on deeply nested GLB JSON", () => {
		let payload: Record<string, unknown> = {};
		for (let depth = 0; depth < 80; depth += 1) {
			payload = { nested: payload };
		}
		const glb = makeGlb({
			asset: { version: "2.0" },
			extensionsUsed: ["KHR_materials_unlit"],
			materials: [
				{
					extensions: {
						KHR_materials_unlit: payload,
					},
				},
			],
		});
		const inspection = inspectGlb(glb);
		expect(inspection.issues.map((entry) => entry.ruleId)).toContain(
			"E_GLB_STRUCTURE",
		);
	});

	it("rejects malformed accessor counts instead of undercounting triangles", () => {
		const glb = makeGlb(
			baseDocument({
				accessors: [
					{
						componentType: 5126,
						count: "3",
						type: "VEC3",
						min: [-1, -1, -1],
						max: [1, 1, 1],
					},
				],
			}),
		);
		expect(inspectGlb(glb).issues.map((entry) => entry.ruleId)).toContain(
			"E_GLB_STRUCTURE",
		);
	});

	it("fully traverses PNG chunks and rejects truncated image bytes", async () => {
		const retained = await readFile(
			join(SOURCE_ROOT, "rock_smallA-preview.png"),
		);
		expect(inspectPng(retained)).toMatchObject({ ok: true, issues: [] });
		expect(inspectPng(retained.subarray(0, retained.length - 1))).toMatchObject(
			{
				ok: false,
				issues: expect.arrayContaining([
					expect.objectContaining({ ruleId: "E_PNG_STRUCTURE" }),
				]),
			},
		);
	});
	it("rejects trailing compressed payload bytes inside IDAT", () => {
		expect(inspectPng(fakePng(1, 1, Buffer.from([0xde, 0xad])))).toMatchObject({
			ok: false,
			issues: expect.arrayContaining([
				expect.objectContaining({ ruleId: "E_PNG_STRUCTURE" }),
			]),
		});
	});

	it("rejects forbidden or oversized palettes and lowercase PNG reserved bits", () => {
		const cases = [
			makeStructuredPng({
				bitDepth: 8,
				colorType: 0,
				palette: Buffer.alloc(3),
			}),
			makeStructuredPng({
				bitDepth: 1,
				colorType: 3,
				palette: Buffer.alloc(9),
			}),
			makeStructuredPng({
				bitDepth: 8,
				colorType: 6,
				extraChunkType: "abca",
			}),
			makeStructuredPng({
				bitDepth: 8,
				colorType: 6,
				extraChunkType: "teSt",
			}),
			makeStructuredPng({
				bitDepth: 8,
				colorType: 6,
				extraChunkType: "tRNS",
			}),
		];
		for (const png of cases) {
			expect(inspectPng(png)).toMatchObject({
				ok: false,
				issues: expect.arrayContaining([
					expect.objectContaining({ ruleId: "E_PNG_STRUCTURE" }),
				]),
			});
		}
	});

	it("fully traverses RIFF chunks and rejects forged or truncated WAV bounds", () => {
		const wav = makeWav();
		expect(inspectWav(wav)).toMatchObject({ ok: true, issues: [] });
		const forged = Buffer.from(wav);
		forged.writeUInt32LE(wav.length + 100, 4);
		for (const invalid of [forged, wav.subarray(0, wav.length - 1)]) {
			expect(inspectWav(invalid)).toMatchObject({
				ok: false,
				issues: expect.arrayContaining([
					expect.objectContaining({ ruleId: "E_WAV_STRUCTURE" }),
				]),
			});
		}
	});

	it("decodes PCM facts after legal leading RIFF chunks", () => {
		const inspection = inspectWav(withLeadingWavChunk(makeWav()));
		expect(inspection).toMatchObject({
			ok: true,
			issues: [],
			metrics: {
				durationSeconds: 4 / 176_400,
				channels: 2,
				sampleRate: 44_100,
				bitsPerSample: 16,
				dataBytes: 4,
			},
		});
	});

	it("accepts 18-byte PCM WAVEFORMATEX only when cbSize is zero", () => {
		expect(inspectWav(withExtendedWavFormat(makeWav(), 2))).toMatchObject({
			ok: true,
			issues: [],
			metrics: {
				channels: 2,
				sampleRate: 44_100,
				bitsPerSample: 16,
			},
		});

		const nonzeroExtension = withExtendedWavFormat(makeWav(), 2);
		nonzeroExtension.writeUInt16LE(1, 36);
		expect(inspectWav(nonzeroExtension)).toMatchObject({
			ok: false,
			issues: expect.arrayContaining([
				expect.objectContaining({
					ruleId: "E_WAV_STRUCTURE",
					path: "/fmt",
				}),
			]),
		});
	});

	it.each([1, 3, 4])(
		"rejects a PCM fmt chunk extended by unsupported %i byte(s)",
		(extraBytes) => {
			expect(inspectWav(withExtendedWavFormat(makeWav(), extraBytes))).toEqual(
				expect.objectContaining({
					ok: false,
					issues: expect.arrayContaining([
						expect.objectContaining({
							ruleId: "E_WAV_STRUCTURE",
							path: "/fmt",
						}),
					]),
				}),
			);
		},
	);

	it("rejects oversized embedded textures from decoded PNG dimensions", () => {
		const png = fakePng(ASSET_LIMITS.maxTextureDimension + 1, 1);
		const glb = makeGlb(
			{
				asset: { version: "2.0" },
				buffers: [{ byteLength: png.length }],
				bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: png.length }],
				images: [{ bufferView: 0, mimeType: "image/png" }],
			},
			png,
		);
		expect(inspectGlb(glb).issues.map((issue) => issue.ruleId)).toContain(
			"E_ASSET_TEXTURE_DIMENSIONS",
		);
	});

	it("charges decoded PNG scanline bytes for every repeated image declaration", () => {
		const png = fakePng(1024, 1024);
		const imageCount =
			Math.floor(
				ASSET_LIMITS.maxDecodedTextureBytes /
					(1024 * (1 + 1024 * 4)),
			) + 1;
		const glb = makeGlb(
			{
				asset: { version: "2.0" },
				buffers: [{ byteLength: png.length }],
				bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: png.length }],
				images: Array.from({ length: imageCount }, () => ({
					bufferView: 0,
					mimeType: "image/png",
				})),
			},
			png,
		);
		const inspection = inspectGlb(glb);
		expect(inspection.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					ruleId: "E_ASSET_TEXTURE_DECODE_BUDGET",
					path: `/images/${imageCount - 1}`,
				}),
			]),
		);
		expect(inspection.metrics.decodedTextureBytes).toBeGreaterThan(
			ASSET_LIMITS.maxDecodedTextureBytes,
		);
	});

	it("counts distinct material-bound texture sets for semantic budgets", () => {
		const png = fakePng(1, 1);
		const glb = makeGlb(
			{
				asset: { version: "2.0" },
				buffers: [{ byteLength: png.length }],
				bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: png.length }],
				images: [{ bufferView: 0, mimeType: "image/png" }],
				textures: [{ source: 0 }, { source: 0 }, { source: 0 }],
				materials: [
					{
						pbrMetallicRoughness: {
							baseColorTexture: { index: 0 },
						},
						normalTexture: { index: 1 },
					},
					{
						pbrMetallicRoughness: {
							baseColorTexture: { index: 2 },
						},
					},
				],
			},
			png,
		);
		expect(inspectGlb(glb).metrics).toMatchObject({
			textures: 3,
			textureSets: 2,
			textureBytes: png.length,
		});
	});
	it("never reuses a cached PNG decode for a non-PNG image declaration", () => {
		const png = fakePng(1, 1);
		const glb = makeGlb(
			{
				asset: { version: "2.0" },
				buffers: [{ byteLength: png.length }],
				bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: png.length }],
				images: [
					{ bufferView: 0, mimeType: "image/png" },
					{ bufferView: 0, mimeType: "image/jpeg" },
				],
			},
			png,
		);
		expect(inspectGlb(glb).issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					ruleId: "E_ASSET_TEXTURE_UNINSPECTED",
					path: "/images/1",
				}),
			]),
		);
	});


	it("caps repeated image definitions before embedded PNG inflation", () => {
		const png = fakePng(1, 1);
		const glb = makeGlb(
			{
				asset: { version: "2.0" },
				buffers: [{ byteLength: png.length }],
				bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: png.length }],
				images: Array.from({ length: 65 }, () => ({
					bufferView: 0,
					mimeType: "image/png",
				})),
			},
			png,
		);
		expect(inspectGlb(glb).issues.map((entry) => entry.ruleId)).toContain(
			"E_ASSET_TEXTURE_UNINSPECTED",
		);
	});

	it("rejects files above the frozen byte ceiling before parsing", () => {
		const oversized = Buffer.alloc(ASSET_LIMITS.maxFileBytes + 1);
		expect(inspectGlb(oversized).issues[0]?.ruleId).toBe("E_ASSET_BYTES");
	});
	it("enforces frozen role texture sets and level texture ceilings", () => {
		const baseFile = {
			path: "assets/model.glb",
			bytes: 1,
			decodedGeometry: { triangles: 1, maxTextureDimension: 1 },
		};
		const inspections = [
			{
				manifest: {
					kind: "object-pack",
					assets: [{ assetId: "render", path: baseFile.path }],
					entries: [{ objects: [{ renderAssetId: "render" }] }],
					totals: {},
				},
				files: [baseFile],
				localAssetMetrics: {
					[baseFile.path]: { textureSets: 2, textureBytes: 0, materials: 1 },
				},
			},
			{
				manifest: {
					kind: "character",
					assets: [{ assetId: "model", path: baseFile.path }],
					entries: [{ modelAssetId: "model" }],
					totals: {},
				},
				files: [baseFile],
				localAssetMetrics: {
					[baseFile.path]: { textureSets: 3, textureBytes: 0, materials: 1 },
				},
			},
			{
				manifest: {
					kind: "level",
					assets: [{ assetId: "arena", path: baseFile.path }],
					entries: [{ arenaAssetId: "arena" }],
					totals: {
						bytes: 1,
						uncompressedBytes: 1,
						fileCount: 1,
					},
				},
				files: [baseFile],
				localAssetMetrics: {
					[baseFile.path]: {
						textureSets: 1,
						textureBytes: CONTENT_BUDGETS.level.maxCompressedTextureBytes + 1,
						materials: 1,
					},
				},
			},
			{
				manifest: {
					kind: "level",
					assets: [{ assetId: "arena", path: baseFile.path }],
					entries: [{ arenaAssetId: "arena" }],
					totals: {
						bytes: 1,
						uncompressedBytes: 1,
						fileCount: 1,
					},
				},
				files: [
					{
						...baseFile,
						decodedGeometry: {
							triangles: 1,
							maxTextureDimension:
								CONTENT_BUDGETS.level.maxTextureDimension + 1,
						},
					},
				],
				localAssetMetrics: {
					[baseFile.path]: { textureSets: 1, textureBytes: 1, materials: 1 },
				},
			},
		];
		for (const inspection of inspections) {
			expect(validatePackageBudgets(inspection as never).issues).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ ruleId: "E_FILE_BUDGET" }),
				]),
			);
		}
	});

	it("rebuilds byte-identical starter packages and validates every manifest", async () => {
		const first = await mkdtemp(join(ROOT, ".tmp-infinite-snowball-p03-a-"));
		const second = await mkdtemp(join(ROOT, ".tmp-infinite-snowball-p03-b-"));
		try {
			const firstResult = await rebuildStarterContent({
				root: ROOT,
				outputRoot: first,
			});
			const secondResult = await rebuildStarterContent({
				root: ROOT,
				outputRoot: second,
			});
			expect(firstResult.files).toEqual(secondResult.files);
			expect(firstResult.configSha256).toMatch(/^[a-f0-9]{64}$/u);
			expect(firstResult.packages.map((entry) => entry.packageName)).toEqual([
				"starter-objects",
				"starter-music",
				"starter-character",
				"starter-level",
				"starter-campaign",
			]);
			expect(
				firstResult.packages.map((entry) => entry.artifact.integrity),
			).toEqual(secondResult.packages.map((entry) => entry.artifact.integrity));

			const reconstructed = await inspectStarterPackages({
				root: ROOT,
				contentRoot: first,
			});
			expect(reconstructed).toMatchObject({ ok: true, issues: [] });
			expect(reconstructed.packages).toHaveLength(5);
			const runtimeScan = await scanStarterRuntimeFiles({
				root: ROOT,
				contentRoot: first,
			});
			expect(runtimeScan).toMatchObject({ ok: true, issues: [] });
			for (const built of reconstructed.packages) {
				const validated = validatePackageInspection(built.inspection);
				expect(validated, built.packageName).toMatchObject({
					ok: true,
					issues: [],
				});
				expect(built.manifest.totals.bytes).toBe(built.artifact.bytes.length);
				expect(built.inspection.archive.compressedBytes).toBe(
					built.artifact.bytes.length,
				);
				expect(
					built.artifact.entries.reduce(
						(sum, entry) => sum + entry.compressedBytes,
						0,
					) +
						built.artifact.overhead.terminatorCompressedBytes +
						built.artifact.overhead.sizeBindingCompressedBytes,
				).toBe(built.artifact.bytes.length);
				expect(built.manifest.totals.bytes).not.toBe(
					built.manifest.assets.reduce(
						(sum: number, asset: { bytes: number }) => sum + asset.bytes,
						0,
					),
				);
				expect(built.artifact.integrity).not.toBe(
					`sha512-${createHash("sha512")
						.update(built.manifestBytes)
						.digest("base64")}`,
				);
				expect(built.manifestSha256).toBe(
					createHash("sha256").update(built.manifestBytes).digest("hex"),
				);
				expect(gunzipSync(built.artifact.bytes).length).toBeGreaterThan(
					built.manifestBytes.length,
				);
				for (const entry of built.artifact.entries.filter(
					(candidate) => candidate.kind === "asset",
				)) {
					expect(
						runtimeScan.files.find(
							(file) => file.path === `${built.packageName}/${entry.path}`,
						)?.compressedBytes,
					).toBe(entry.compressedBytes);
				}
			}

			const refsByName = new Map(
				reconstructed.packages.map((entry) => [entry.manifest.name, entry.ref]),
			);
			for (const built of reconstructed.packages) {
				for (const dependency of built.manifest.dependencies) {
					expect(dependency).toEqual(refsByName.get(dependency.name));
				}
			}

			const objectPackage = reconstructed.packages.find(
				(entry) => entry.packageName === "starter-objects",
			);
			expect(objectPackage).toBeDefined();
			const goalRoles = Object.fromEntries(
				objectPackage!.manifest.assets
					.filter((asset: { assetId: string }) =>
						asset.assetId.startsWith("goal-"),
					)
					.map((asset: { assetId: string; role: string }) => [
						asset.assetId,
						asset.role,
					]),
			);
			expect(goalRoles).toEqual({
				"goal-render": "render-model",
				"goal-collider": "collider",
			});
			const wrongGoalRole = structuredClone(objectPackage!.inspection);
			const wrongGoalAsset = required(
				wrongGoalRole.manifest.assets.find(
					(asset: { assetId: string }) => asset.assetId === "goal-render",
				),
				"goal render asset",
			);
			wrongGoalAsset.role = "goal-render-model";
			expect(validatePackageInspection(wrongGoalRole)).toMatchObject({
				ok: false,
				issues: expect.arrayContaining([
					expect.objectContaining({ ruleId: "E_FILE_BUDGET" }),
				]),
			});

			const artifactPath = join(first, "starter-objects.tgz");
			await writeFile(artifactPath, objectPackage!.artifact.bytes);
			const listing = (
				await execFile("tar", ["-tzf", artifactPath], { encoding: "utf8" })
			).stdout
				.trim()
				.split("\n");
			expect(listing).toEqual(
				expect.arrayContaining([
					"package/package.json",
					"package/manifest.json",
					...objectPackage!.manifest.assets.map(
						(asset: { path: string }) => `package/${asset.path}`,
					),
				]),
			);
			const packageJson = JSON.parse(
				(
					await execFile(
						"tar",
						["-xOzf", artifactPath, "package/package.json"],
						{ encoding: "utf8" },
					)
				).stdout,
			);
			expect(packageJson).toEqual({
				name: objectPackage!.manifest.name,
				version: objectPackage!.manifest.version,
				license: objectPackage!.manifest.license,
				files: ["manifest.json", "assets"],
			});

			for (const packageName of [
				"starter-level",
				"starter-objects",
				"starter-character",
				"starter-campaign",
				"starter-music",
			]) {
				const manifest = JSON.parse(
					await readFile(join(first, packageName, "manifest.json"), "utf8"),
				);
				expect(parseManifest(manifest), packageName).toMatchObject({
					ok: true,
					issues: [],
				});
				for (const asset of manifest.assets) {
					const transformation = asset.provenance.transformation;
					expect(
						transformation.configSha256,
						`${packageName}/${asset.path}`,
					).toBe(canonicalConfigSha256(transformation.config));
				}
			}

			const characterManifest = JSON.parse(
				await readFile(
					join(first, "starter-character", "manifest.json"),
					"utf8",
				),
			);
			const characterModel = characterManifest.assets.find(
				(asset: { assetId: string; path: string }) =>
					asset.assetId === characterManifest.entries[0].modelAssetId,
			);
			const modelInspection = inspectGlb(
				await readFile(join(first, "starter-character", characterModel.path)),
			);
			expect(modelInspection.ok).toBe(true);
			for (const declared of characterManifest.entries[0].animationClips) {
				expect(modelInspection.metrics.animationClips).toContain(declared.clip);
			}

			const levelManifest = JSON.parse(
				await readFile(join(first, "starter-level", "manifest.json"), "utf8"),
			);
			const objectManifest = JSON.parse(
				await readFile(join(first, "starter-objects", "manifest.json"), "utf8"),
			);
			const exportedObjectIds = new Set(
				objectManifest.entries.flatMap(
					(entry: { objects: Array<{ objectId: string }> }) =>
						entry.objects.map((object) => object.objectId),
				),
			);
			for (const level of levelManifest.entries) {
				for (const group of level.collectibleGroups) {
					expect(group.objectPack.name).toBe(objectManifest.name);
					for (const objectId of group.objectIds)
						expect(exportedObjectIds.has(objectId), objectId).toBe(true);
				}
				expect(
					exportedObjectIds.has(level.finalGoal.objectId),
					level.finalGoal.objectId,
				).toBe(true);
			}
		} finally {
			await rm(first, { recursive: true, force: true });
			await rm(second, { recursive: true, force: true });
		}
	});

	it("generates valid deterministic and distinct object, arena, and layout GLBs", async () => {
		const first = await mkdtemp(join(ROOT, ".tmp-infinite-snowball-p03-model-a-"));
		const second = await mkdtemp(join(ROOT, ".tmp-infinite-snowball-p03-model-b-"));
		const modelPaths = [
			join("starter-objects", "assets", "rock-small-a.glb"),
			join("starter-level", "assets", "snowfield-arena.glb"),
			join("starter-level", "assets", "snowfield-layout.glb"),
		];
		try {
			await rebuildStarterContent({ root: ROOT, outputRoot: first });
			await rebuildStarterContent({ root: ROOT, outputRoot: second });
			const firstModels = await Promise.all(
				modelPaths.map((path) => readFile(join(first, path))),
			);
			const secondModels = await Promise.all(
				modelPaths.map((path) => readFile(join(second, path))),
			);
			expect(secondModels).toEqual(firstModels);
			const objectModel = required(firstModels[0], "object render GLB");
			const arenaModel = required(firstModels[1], "arena GLB");
			const layoutModel = required(firstModels[2], "layout GLB");

			const models = [objectModel, arenaModel, layoutModel];
			const hashes = models.map((bytes) =>
				createHash("sha256").update(bytes).digest("hex"),
			);
			const objectModelHash = required(hashes[0], "object render GLB hash");
			expect(new Set(hashes).size).toBe(3);
			const inspections = models.map((bytes) => inspectGlb(bytes));
			for (const inspection of inspections)
				expect(inspection).toMatchObject({ ok: true, issues: [] });
			const arenaDocument = glbDocument(arenaModel);
			const layoutDocument = glbDocument(layoutModel);
			const arenaNodes = required(arenaDocument.nodes, "arena nodes");
			const layoutNodes = required(layoutDocument.nodes, "layout nodes");
			expect(arenaNodes).toHaveLength(9);
			expect(arenaDocument.meshes).toHaveLength(9);
			expect(arenaNodes.map((node) => node.mesh)).toEqual([
				0, 1, 2, 3, 4, 5, 6, 7, 8,
			]);
			expect(required(arenaNodes[0], "arena platform node")).toMatchObject({
				name: "platform",
				translation: [0, -0.35, 0],
				scale: [9, 0.2, 9],
			});
			expect(required(arenaNodes[8], "arena perimeter node")).toMatchObject({
				name: "perimeter-southwest",
				translation: [-5, 0, 5],
			});
			expect(arenaDocument.scenes).toEqual([
				{
					name: "Starter Snowfield Arena",
					nodes: [0, 1, 2, 3, 4, 5, 6, 7, 8],
				},
			]);
			expect(layoutNodes).toHaveLength(5);
			expect(layoutDocument.meshes).toHaveLength(5);
			expect(layoutNodes.map((node) => node.mesh)).toEqual([0, 1, 2, 3, 4]);
			expect(required(layoutNodes[0], "layout spawn node")).toMatchObject({
				name: "spawn",
				translation: [0, 0, 0],
				scale: [0.35, 0.12, 0.35],
			});
			expect(required(layoutNodes[4], "layout goal node")).toMatchObject({
				name: "goal",
				translation: [0, 0, 3],
				scale: [0.45, 0.9, 0.45],
			});

			const levelManifest = JSON.parse(
				await readFile(join(first, "starter-level", "manifest.json"), "utf8"),
			);
			const levelEntry = required(
				levelManifest.entries?.[0],
				"generated starter level entry",
			);
			const arenaAsset = required(
				levelManifest.assets?.find(
					(asset: { assetId?: string }) => asset.assetId === "arena",
				),
				"generated arena asset",
			);
			const layoutAsset = required(
				levelManifest.assets?.find(
					(asset: { assetId?: string }) => asset.assetId === "layout",
				),
				"generated layout asset",
			);
			const iconBytes = await readFile(
				join(first, "starter-level", "assets", "icon.png"),
			);
			expect(levelEntry.budgets).toMatchObject({
				maxTriangles:
					required(inspections[1], "arena inspection").metrics.triangles +
					required(inspections[2], "layout inspection").metrics.triangles,
				maxBytes: arenaModel.length + layoutModel.length + iconBytes.length,
			});
			expect(arenaAsset.provenance).toMatchObject({
				sourceArtifactSha256: objectModelHash,
				modifications: [
					"flattened the retained rock mesh into one broad snowfield platform instance",
					"composed eight transformed perimeter instances from the retained mesh",
					"normalized deterministic filename",
				],
				transformation: {
					recipe: "compose-snowfield-arena-v1",
					config: {
						variant: "snowfield-arena",
						sceneName: "Starter Snowfield Arena",
						sourceMember: "Models/GLTF format/rock_smallA.glb",
						instanceCount: 9,
						placement00:
							"platform|translation=0,-0.35,0|rotation=0,0,0,1|scale=9,0.2,9",
					},
				},
			});
			expect(layoutAsset.provenance).toMatchObject({
				sourceArtifactSha256: objectModelHash,
				modifications: [
					"composed five compact transformed placement markers from the retained rock mesh",
					"encoded spawn, collectible, and goal marker spacing in node transforms",
					"normalized deterministic filename",
				],
				transformation: {
					recipe: "compose-snowfield-layout-v1",
					config: {
						variant: "snowfield-layout",
						sceneName: "Starter Snowfield Layout",
						sourceMember: "Models/GLTF format/rock_smallA.glb",
						instanceCount: 5,
						placement00:
							"spawn|translation=0,0,0|rotation=0,0,0,1|scale=0.35,0.12,0.35",
					},
				},
			});
			expect(arenaAsset.provenance.acquisition).not.toContain(
				"exact retained member",
			);
			expect(layoutAsset.provenance.acquisition).not.toContain(
				"exact retained member",
			);
			expect(arenaAsset.license).toBe("CC0-1.0");
			expect(layoutAsset.license).toBe("CC0-1.0");
			expect(arenaAsset.capturedLicenseSha256).toBe(
				layoutAsset.capturedLicenseSha256,
			);
			expect(arenaAsset.capturedLicenseSha256).toMatch(/^[a-f0-9]{64}$/u);
		} finally {
			await rm(first, { recursive: true, force: true });
			await rm(second, { recursive: true, force: true });
		}
	});

	it("rejects raw-byte archive substitution and every frozen semantic budget bypass", async () => {
		const output = await mkdtemp(
			join(ROOT, ".tmp-infinite-snowball-p03-budgets-"),
		);
		try {
			await rebuildStarterContent({ root: ROOT, outputRoot: output });
			const reconstructed = await inspectStarterPackages({
				root: ROOT,
				contentRoot: output,
			});
			const byName = Object.fromEntries(
				reconstructed.packages.map((entry) => [entry.packageName, entry]),
			);

			const objectInspection = required(
				byName["starter-objects"],
				"starter objects package",
			).budgetInspection;
			const rawSubstitution = structuredClone(
				required(byName["starter-objects"], "starter objects package")
					.inspection,
			);
			const rawBytes = rawSubstitution.manifest.assets.reduce(
				(sum: number, asset: { bytes: number }) => sum + asset.bytes,
				0,
			);
			rawSubstitution.archive.compressedBytes = rawBytes;
			expect(validatePackageInspection(rawSubstitution)).toMatchObject({
				ok: false,
				issues: expect.arrayContaining([
					expect.objectContaining({ ruleId: "E_FILE_BUDGET" }),
				]),
			});

			const collectible = structuredClone(objectInspection);
			const collectibleAsset = required(
				collectible.manifest.assets.find(
					(asset: { assetId: string }) => asset.assetId === "render",
				),
				"collectible asset",
			);
			const collectibleFile = required(
				collectible.files.find(
					(file: { path: string }) => file.path === collectibleAsset.path,
				),
				"collectible file",
			);
			collectibleAsset.bytes = CONTENT_BUDGETS.collectible.maxBytes + 1;
			collectibleFile.bytes = collectibleAsset.bytes;

			const hero = structuredClone(
				required(byName["starter-character"], "starter character package")
					.budgetInspection,
			);
			const heroAsset = required(
				hero.manifest.assets.find(
					(asset: { assetId: string }) => asset.assetId === "model",
				),
				"hero asset",
			);
			const heroFile = required(
				hero.files.find(
					(file: { path: string }) => file.path === heroAsset.path,
				),
				"hero file",
			);
			heroAsset.bytes = CONTENT_BUDGETS.hero.maxBytes + 1;
			heroFile.bytes = heroAsset.bytes;

			const level = structuredClone(
				required(byName["starter-level"], "starter level package")
					.budgetInspection,
			);
			level.manifest.totals.bytes = CONTENT_BUDGETS.level.maxDownloadBytes + 1;
			level.archive.compressedBytes = level.manifest.totals.bytes;

			const music = structuredClone(
				required(byName["starter-music"], "starter music package")
					.budgetInspection,
			);
			const trackAsset = required(
				music.manifest.assets.find(
					(asset: { assetId: string }) => asset.assetId === "track",
				),
				"music track asset",
			);
			const trackFile = required(
				music.files.find(
					(file: { path: string }) => file.path === trackAsset.path,
				),
				"music track file",
			);
			trackAsset.bytes = CONTENT_BUDGETS.music.maxTrackBytes + 1;
			trackFile.bytes = trackAsset.bytes;

			for (const [label, inspection] of [
				["collectible", collectible],
				["hero", hero],
				["level", level],
				["music", music],
			] as const) {
				expect(validatePackageBudgets(inspection).issues, label).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ ruleId: "E_FILE_BUDGET" }),
					]),
				);
			}
		} finally {
			await rm(output, { recursive: true, force: true });
		}
	});

	it("applies the level body budget before reading declared asset bytes", async () => {
		const output = await mkdtemp(
			join(ROOT, ".tmp-infinite-snowball-p03-level-pre-read-"),
		);
		try {
			await rebuildStarterContent({ root: ROOT, outputRoot: output });
			const packageRoot = join(output, "starter-level");
			const manifestPath = join(packageRoot, "manifest.json");
			const assetsRoot = join(packageRoot, "assets");
			const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
			const template = required(
				manifest.assets.find(
					(asset: { mime: string }) => asset.mime === "model/gltf-binary",
				),
				"level model asset",
			);
			await rm(assetsRoot, { recursive: true, force: true });
			await mkdir(assetsRoot, { recursive: true });
			const physicalPaths = Array.from(
				{ length: 100 },
				(_, index) => `assets/oversized-${String(index).padStart(3, "0")}.glb`,
			);
			await Promise.all(
				physicalPaths.map(async (path) => {
					const absolutePath = join(packageRoot, path);
					await writeFile(absolutePath, "");
					await truncate(absolutePath, CONTENT_BUDGETS.level.maxFileBytes);
				}),
			);
			manifest.assets = physicalPaths.slice(0, 4).map((path, index) => ({
				...structuredClone(template),
				assetId: `oversized-${index}`,
				path,
			}));
			await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

			let levelBodyReads = 0;
			const options = {
				root: ROOT,
				contentRoot: output,
				afterAssetIdentityCheck(relativePath: string) {
					if (relativePath.startsWith("starter-level/assets/"))
						levelBodyReads += 1;
				},
			};
			const inspected = await inspectStarterPackages(options);
			expect(levelBodyReads).toBe(0);
			expect(inspected.issues).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						ruleId: "E_FILE_BUDGET",
						path: "/starter-level",
					}),
				]),
			);
		} finally {
			await rm(output, { recursive: true, force: true });
		}
	});

	it("counts logical music tracks when multiple records alias one audio asset", async () => {
		const inspected = await inspectStarterPackages({ root: ROOT });
		const musicPackage = required(
			inspected.packages.find(
				(entry) => entry.packageName === "starter-music",
			),
			"starter music package",
		);
		const eightTracks = structuredClone(musicPackage.budgetInspection);
		if (eightTracks.manifest.kind !== "music")
			throw new Error("Expected starter music manifest");
		const entry = required(
			eightTracks.manifest.entries[0],
			"starter music entry",
		);
		const track = required(entry.tracks[0], "starter music track");
		entry.tracks = Array.from({ length: 8 }, (_, index) => ({
			...structuredClone(track),
			trackId: `aliased-track-${index + 1}`,
		}));
		const { localAssetMetrics: _eightMetrics, ...eightProtocol } = eightTracks;
		expect(validatePackageInspection(eightProtocol)).toMatchObject({
			ok: true,
			issues: [],
		});
		expect(validatePackageBudgets(eightTracks)).toMatchObject({
			ok: true,
			issues: [],
		});

		const nineTracks = structuredClone(eightTracks);
		if (nineTracks.manifest.kind !== "music")
			throw new Error("Expected cloned starter music manifest");
		nineTracks.manifest.entries.push({
			...structuredClone(entry),
			musicPackId: "starter-music-alias",
			tracks: [
				{
					...structuredClone(track),
					trackId: "aliased-track-9",
				},
			],
		});
		const { localAssetMetrics: _nineMetrics, ...nineProtocol } = nineTracks;
		expect(validatePackageInspection(nineProtocol)).toMatchObject({
			ok: true,
			issues: [],
		});
		expect(validatePackageBudgets(nineTracks)).toMatchObject({
			ok: false,
			issues: expect.arrayContaining([
				expect.objectContaining({
					ruleId: "E_FILE_BUDGET",
					path: "/archive",
				}),
			]),
		});
	});

	it("enforces collectible material slots by derived role, below global maxima", async () => {
		const output = await mkdtemp(
			join(ROOT, ".tmp-infinite-snowball-p03-material-budget-"),
		);
		try {
			await rebuildStarterContent({ root: ROOT, outputRoot: output });
			const packageRoot = join(output, "starter-objects");
			const manifestPath = join(packageRoot, "manifest.json");
			const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
			const asset = required(
				manifest.assets.find(
					(candidate: { assetId: string }) => candidate.assetId === "render",
				),
				"material-budget render asset",
			);
			const bytes = makeGlb(baseDocument({ materials: [{}, {}, {}] }));
			const digest = createHash("sha256").update(bytes).digest("hex");
			asset.bytes = bytes.length;
			asset.sha256 = digest;
			asset.provenance.outputSha256 = digest;
			await writeFile(join(packageRoot, asset.path), bytes);
			await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

			expect(
				(
					await buildAssetBudgetReport({
						root: ROOT,
						contentRoot: output,
					})
				).issues,
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						ruleId: "E_FILE_BUDGET",
						path: expect.stringContaining("materials"),
					}),
				]),
			);
		} finally {
			await rm(output, { recursive: true, force: true });
		}
	});

	it("projects GLB budget evidence to frozen scalar metrics", async () => {
		const output = await mkdtemp(
			join(ROOT, ".tmp-infinite-snowball-p03-budget-projection-"),
		);
		try {
			await rebuildStarterContent({ root: ROOT, outputRoot: output });
			const packageRoot = join(output, "starter-level");
			const manifestPath = join(packageRoot, "manifest.json");
			const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
			const template = required(
				manifest.assets.find(
					(asset: { mime: string }) => asset.mime === "model/gltf-binary",
				),
				"level GLB asset",
			);
			const payload = `AMPLIFICATION_SENTINEL_${"x".repeat(140 * 1024)}`;
			const bytes = makeGlb({
				extras: { payload },
				asset: { version: "2.0" },
			});
			const digest = createHash("sha256").update(bytes).digest("hex");
			const amplifiedAssets = Array.from({ length: 120 }, (_, index) => {
				const path = `assets/amplified-${String(index).padStart(3, "0")}.glb`;
				return {
					...structuredClone(template),
					assetId: `amplified-${index}`,
					path,
					bytes: bytes.length,
					sha256: digest,
					provenance: {
						...structuredClone(template.provenance),
						outputSha256: digest,
					},
				};
			});
			manifest.assets.push(...amplifiedAssets);
			await Promise.all(
				amplifiedAssets.map((asset) =>
					writeFile(join(packageRoot, asset.path), bytes),
				),
			);
			const assetBytes = new Map<string, Buffer>(
				await Promise.all(
					manifest.assets.map(
						async (asset: { path: string }) =>
							[
								asset.path,
								await readFile(join(packageRoot, asset.path)),
							] as const,
					),
				),
			);
			const artifact = buildDeterministicPackageArtifact(manifest, assetBytes);
			await writeFile(
				manifestPath,
				`${JSON.stringify(artifact.manifest, null, 2)}\n`,
			);

			expect(inspectGlb(bytes).metrics.textValues).toContain(payload);
			const report = await buildAssetBudgetReport({
				root: ROOT,
				contentRoot: output,
			});
			const file = required(
				report.files.find((entry) =>
					entry.path.endsWith("assets/amplified-000.glb"),
				),
				"amplified budget file",
			);
			expect(file.glb).toEqual({
				bytes: bytes.length,
				triangles: 0,
				materials: 0,
				textures: 0,
				textureSets: 0,
				textureBytes: 0,
				decodedTextureBytes: 0,
				maxTextureDimension: 0,
			});
		} finally {
			await rm(output, { recursive: true, force: true });
		}
	});

	it("rejects symlinks, unknown roots, undeclared files, code, and exact-set gaps", async () => {
		const output = await mkdtemp(join(ROOT, ".tmp-infinite-snowball-p03-tree-"));
		try {
			await rebuildStarterContent({ root: ROOT, outputRoot: output });
			await writeFile(join(output, "rogue-root.txt"), "rogue", "utf8");
			await writeFile(
				join(output, "starter-objects", "assets", "undeclared.bin"),
				"rogue",
				"utf8",
			);
			await writeFile(
				join(output, "starter-objects", "assets", "payload.js"),
				"export default 1",
				"utf8",
			);
			await symlink(
				"rock-small-a.glb",
				join(output, "starter-objects", "assets", "linked.glb"),
			);
			await rm(join(output, "starter-level", "assets", "snowfield-layout.glb"));

			const verification = await verifyStarterHashes({
				root: ROOT,
				contentRoot: output,
			});
			const scan = await scanStarterRuntimeFiles({
				root: ROOT,
				contentRoot: output,
			});
			const ruleIds = new Set(
				[...verification.issues, ...scan.issues].map((entry) => entry.ruleId),
			);
			expect(ruleIds.has("E_CONTENT_TREE")).toBe(true);
			expect(ruleIds.has("E_PATH_POLICY")).toBe(true);
			expect(ruleIds.has("E_ASSET_ORPHAN")).toBe(true);
			expect(ruleIds.has("E_CODE_FORBIDDEN")).toBe(true);
			expect(ruleIds.has("E_ASSET_MISSING")).toBe(true);
		} finally {
			await rm(output, { recursive: true, force: true });
		}
	});

	it.each([
		[
			"disputed evidence",
			(evidence: Record<string, unknown>) => {
				evidence.evidenceStatus = "disputed";
			},
		],
		[
			"withdrawn evidence",
			(evidence: Record<string, unknown>) => {
				evidence.evidenceStatus = "withdrawn";
			},
		],
		[
			"mutated license",
			(evidence: Record<string, unknown>) => {
				(evidence.license as Record<string, unknown>).spdx = "CC-BY-4.0";
			},
		],
		[
			"missing creator",
			(evidence: Record<string, unknown>) => {
				evidence.creator = "";
			},
		],
		[
			"unreviewed source",
			(evidence: Record<string, unknown>) => {
				evidence.sourceUrl = "http://example.com/unreviewed";
			},
		],
		[
			"missing reviewer",
			(evidence: Record<string, unknown>) => {
				evidence.reviewer = "";
			},
		],
		[
			"substituted reviewer identity",
			(evidence: Record<string, unknown>) => {
				evidence.reviewer = "Unreviewed replacement";
			},
		],
		[
			"substituted review timestamp",
			(evidence: Record<string, unknown>) => {
				evidence.reviewedAt = "2026-07-16T00:00:00.000Z";
			},
		],
		[
			"mutated reviewed archive hash",
			(evidence: Record<string, unknown>) => {
				evidence.archiveSha256 = "1".repeat(64);
			},
		],
		[
			"malformed retained hash",
			(evidence: Record<string, unknown>) => {
				evidence.sourceArtifactSha256 = "0".repeat(63);
			},
		],
		[
			"missing replacement disposition",
			(evidence: Record<string, unknown>) => {
				delete evidence.replacement;
			},
		],
		[
			"unreviewed replacement disposition",
			(evidence: Record<string, unknown>) => {
				evidence.replacement = {
					source: "https://example.com/unreviewed-replacement",
				};
			},
		],
	] as const)("blocks rebuild for %s", async (_label, mutate) => {
		const root = await copiedRootWithEvidence(mutate);
		try {
			let failure = "";
			try {
				await rebuildStarterContent({
					root,
					outputRoot: join(root, "output"),
				});
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
			expect(failure).toMatch(/E_RETAINED_SOURCE_EVIDENCE/u);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps authoritative generator JSON in canonical tab-indented bytes", async () => {
		const paths = [
			join(
				ROOT,
				"tools",
				"assets",
				"sources",
				"kenney-nature-kit",
				"source-evidence.json",
			),
			...[
				"campaign.json",
				"character.json",
				"level.json",
				"music.json",
				"object-pack.json",
			].map((name) => join(ROOT, "tools", "assets", "templates", name)),
		];
		for (const path of paths) {
			const raw = await readFile(path, "utf8");
			expect(raw).toBe(`${JSON.stringify(JSON.parse(raw), null, "\t")}\n`);
		}
	});

	it("rejects an earlier withdrawn duplicate in retained source evidence", async () => {
		const root = await copiedRootWithEvidence(() => {});
		const evidencePath = join(
			root,
			"tools",
			"assets",
			"sources",
			"kenney-nature-kit",
			"source-evidence.json",
		);
		try {
			const raw = await readFile(evidencePath, "utf8");
			const verified = '\t"evidenceStatus": "verified",';
			expect(raw).toContain(verified);
			await writeFile(
				evidencePath,
				raw.replace(
					verified,
					`\t"evidenceStatus": "withdrawn",\n${verified}`,
				),
			);
			await expect(
				rebuildStarterContent({
					root,
					outputRoot: join(root, "output"),
				}),
			).rejects.toThrow(/^E_RETAINED_SOURCE_EVIDENCE:/u);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects an earlier invalid duplicate in an authoritative template", async () => {
		const root = await copiedRootWithEvidence(() => {});
		const templatePath = join(
			root,
			"tools",
			"assets",
			"templates",
			"campaign.json",
		);
		try {
			const raw = await readFile(templatePath, "utf8");
			const valid = '\t"schemaVersion": "1.0.0",';
			expect(raw).toContain(valid);
			await writeFile(
				templatePath,
				raw.replace(valid, `\t"schemaVersion": "0.0.0",\n${valid}`),
			);
			await expect(readStarterTemplates(root)).rejects.toThrow(
				/^E_TEMPLATE_TREE:/u,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a symlinked project CC0 without touching its external target", async () => {
		const root = await copiedRootWithEvidence(() => {});
		const externalRoot = await mkdtemp(
			join(ROOT, ".tmp-infinite-snowball-project-license-external-"),
		);
		const licensePath = join(
			root,
			"docs",
			"licenses",
			"provenance",
			"infinite-snowball-original-content",
			"CC0-1.0.txt",
		);
		const sentinel = join(externalRoot, "sentinel.txt");
		try {
			await writeFile(sentinel, "external sentinel");
			await rm(licensePath);
			await symlink(sentinel, licensePath);
			await expect(
				rebuildStarterContent({
					root,
					outputRoot: join(root, "output"),
				}),
			).rejects.toThrow(/^E_PROJECT_LICENSE:/u);
			await expect(readFile(sentinel, "utf8")).resolves.toBe(
				"external sentinel",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(externalRoot, { recursive: true, force: true });
		}
	});

	it("rejects same-inode growth of the inventoried project CC0", async () => {
		const root = await copiedRootWithEvidence(() => {});
		const licensePath = join(
			root,
			"docs",
			"licenses",
			"provenance",
			"infinite-snowball-original-content",
			"CC0-1.0.txt",
		);
		try {
			await expect(
				readProjectLicenseBytes(root, {
					afterIdentityCheck: () => appendFile(licensePath, "\ngrowth"),
				}),
			).rejects.toThrow(/^E_PROJECT_LICENSE:/u);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a symlinked starter template before touching rebuild output", async () => {
		const root = await copiedRootWithEvidence(() => {});
		const externalRoot = await mkdtemp(
			join(ROOT, ".tmp-infinite-snowball-template-external-"),
		);
		const templatePath = join(
			root,
			"tools",
			"assets",
			"templates",
			"campaign.json",
		);
		const externalTemplate = join(externalRoot, "campaign.json");
		const outputSentinel = join(
			root,
			"output",
			"starter-objects",
			"untouched.txt",
		);
		try {
			await cp(templatePath, externalTemplate);
			await rm(templatePath);
			await symlink(externalTemplate, templatePath);
			await mkdir(dirname(outputSentinel), { recursive: true });
			await writeFile(outputSentinel, "untouched");

			await expect(
				rebuildStarterContent({
					root,
					outputRoot: join(root, "output"),
				}),
			).rejects.toThrow(/^E_TEMPLATE_TREE:/u);
			await expect(readFile(externalTemplate, "utf8")).resolves.toBe(
				await readFile(join(ROOT, "tools", "assets", "templates", "campaign.json"), "utf8"),
			);
			await expect(readFile(outputSentinel, "utf8")).resolves.toBe("untouched");
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(externalRoot, { recursive: true, force: true });
		}
	});

	it("rejects an extra starter template before touching rebuild output", async () => {
		const root = await copiedRootWithEvidence(() => {});
		const outputSentinel = join(
			root,
			"output",
			"starter-objects",
			"untouched.txt",
		);
		try {
			await writeFile(
				join(root, "tools", "assets", "templates", "extra.json"),
				"{}\n",
			);
			await mkdir(dirname(outputSentinel), { recursive: true });
			await writeFile(outputSentinel, "untouched");

			await expect(
				rebuildStarterContent({
					root,
					outputRoot: join(root, "output"),
				}),
			).rejects.toThrow(/^E_TEMPLATE_TREE:/u);
			await expect(readFile(outputSentinel, "utf8")).resolves.toBe("untouched");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects same-inode growth of an inventoried starter template", async () => {
		const root = await copiedRootWithEvidence(() => {});
		const templatePath = join(
			root,
			"tools",
			"assets",
			"templates",
			"campaign.json",
		);
		try {
			await expect(
				readStarterTemplates(root, {
					afterIdentityCheck: (relativePath) =>
						relativePath === "campaign.json"
							? appendFile(templatePath, "\ngrowth")
							: undefined,
				}),
			).rejects.toThrow(/^E_TEMPLATE_TREE:/u);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("validates checked-in package references against artifact SRI", async () => {
		const result = await execFile(
			process.execPath,
			[join(ROOT, "tools", "assets", "headless-smoke.mjs")],
			{
				cwd: ROOT,
				encoding: "utf8",
			},
		);

		expect(`${result.stdout}${result.stderr}`).toContain(
			"Structural starter smoke passed",
		);
	});

	it("derives headless WAV facts after legal leading RIFF chunks", async () => {
		const root = await mkdtemp(join(ROOT, ".tmp-infinite-snowball-p03-wav-"));
		const contentRoot = join(root, "content");
		try {
			await rebuildStarterContent({ root: ROOT, outputRoot: contentRoot });
			await symlink(join(ROOT, "packages"), join(root, "packages"), "dir");

			const musicRoot = join(contentRoot, "starter-music");
			const manifestPath = join(musicRoot, "manifest.json");
			const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
			const track = manifest.assets.find(
				(asset: { assetId: string }) => asset.assetId === "track",
			);
			const trackPath = join(musicRoot, track.path);
			const wav = withLeadingWavChunk(await readFile(trackPath));
			const digest = createHash("sha256").update(wav).digest("hex");
			track.bytes = wav.length;
			track.sha256 = digest;
			track.provenance.outputSha256 = digest;
			await writeFile(trackPath, wav);
			await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

			const references = new Map<string, PackageReference>();
			const musicReference = await rewritePackageArtifact(
				contentRoot,
				"starter-music",
				references,
			);
			references.set(musicReference.name, musicReference);
			const levelReference = await rewritePackageArtifact(
				contentRoot,
				"starter-level",
				references,
			);
			references.set(levelReference.name, levelReference);
			await rewritePackageArtifact(
				contentRoot,
				"starter-campaign",
				references,
			);

			const result = await execFile(
				process.execPath,
				[join(ROOT, "tools", "assets", "headless-smoke.mjs")],
				{ cwd: root, encoding: "utf8" },
			);
			expect(`${result.stdout}${result.stderr}`).toContain(
				"Structural starter smoke passed",
			);

			manifest.entries[0].tracks[0].durationSeconds += 0.0005;
			await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
			const driftedReferences = new Map<string, PackageReference>();
			const driftedMusicReference = await rewritePackageArtifact(
				contentRoot,
				"starter-music",
				driftedReferences,
			);
			driftedReferences.set(
				driftedMusicReference.name,
				driftedMusicReference,
			);
			const driftedLevelReference = await rewritePackageArtifact(
				contentRoot,
				"starter-level",
				driftedReferences,
			);
			driftedReferences.set(
				driftedLevelReference.name,
				driftedLevelReference,
			);
			await rewritePackageArtifact(
				contentRoot,
				"starter-campaign",
				driftedReferences,
			);
			await expect(
				execFile(
					process.execPath,
					[join(ROOT, "tools", "assets", "headless-smoke.mjs")],
					{ cwd: root, encoding: "utf8" },
				),
			).rejects.toThrow(/decoded-metadata-mismatch/u);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects an empty starter hash closure instead of passing vacuously", async () => {
		const output = await mkdtemp(
			join(ROOT, ".tmp-infinite-snowball-p03-empty-hashes-"),
		);
		try {
			await rebuildStarterContent({ root: ROOT, outputRoot: output });
			const packageRoot = join(output, "starter-campaign");
			const manifestPath = join(packageRoot, "manifest.json");
			const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
			manifest.assets = [];
			const artifact = buildDeterministicPackageArtifact(
				manifest,
				new Map<string, Buffer>(),
			);
			await writeFile(
				manifestPath,
				`${JSON.stringify(artifact.manifest, null, 2)}\n`,
			);
			await rm(join(packageRoot, "assets"), { recursive: true, force: true });

			expect(
				(await verifyStarterHashes({ root: ROOT, contentRoot: output })).issues,
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						ruleId: "E_ASSET_HASH_CLOSURE",
						path: "/starter-campaign/assets",
					}),
				]),
			);
		} finally {
			await rm(output, { recursive: true, force: true });
		}
	});

	it("normalizes hash verification to one content snapshot", async () => {
		const workspace = await mkdtemp(
			join(ROOT, ".tmp-infinite-snowball-p03-hash-snapshot-"),
		);
		const tampered = join(workspace, "tampered");
		const clean = join(workspace, "clean");
		try {
			await Promise.all([
				cp(CONTENT_ROOT, tampered, { recursive: true }),
				cp(CONTENT_ROOT, clean, { recursive: true }),
			]);
			await writeFile(
				join(tampered, "starter-objects", "assets", "rock-small-a.glb"),
				"tampered",
				"utf8",
			);
			let contentRootReads = 0;
			const verification = await verifyStarterHashes({
				root: ROOT,
				get contentRoot() {
					contentRootReads += 1;
					return contentRootReads === 1 ? tampered : clean;
				},
			});
			expect(contentRootReads).toBe(1);
			expect(verification.issues).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						ruleId: "E_ASSET_HASH_MISMATCH",
						path: "/starter-objects/assets/1",
					}),
				]),
			);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("detects post-build mutation and verifies the checked-in starter hashes", async () => {
		const output = await mkdtemp(
			join(ROOT, ".tmp-infinite-snowball-p03-mutated-"),
		);
		try {
			await rebuildStarterContent({ root: ROOT, outputRoot: output });
			await writeFile(
				join(output, "starter-objects", "assets", "rock-small-a.glb"),
				"tampered",
				"utf8",
			);
			expect(
				(await verifyStarterHashes({ root: ROOT, contentRoot: output })).issues,
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ ruleId: "E_ASSET_HASH_MISMATCH" }),
				]),
			);
		} finally {
			await rm(output, { recursive: true, force: true });
		}

		expect(
			(await verifyStarterHashes({ root: ROOT, contentRoot: CONTENT_ROOT }))
				.issues,
		).toEqual([]);
	});

	it("returns the digest of the exact budget scan snapshot", async () => {
		const workspace = await mkdtemp(
			join(ROOT, ".tmp-infinite-snowball-p03-budget-snapshot-"),
		);
		const output = join(workspace, "content");
		try {
			await cp(CONTENT_ROOT, output, { recursive: true });
			const target = join(
				output,
				"starter-objects",
				"assets",
				"rock-small-a.glb",
			);
			const original = await readFile(target);
			const baselineDigest = await contentDigest({
				root: ROOT,
				contentRoot: output,
			});
			let swapped = false;
			const budget = await buildAssetBudgetReport({
				root: ROOT,
				contentRoot: output,
				afterAssetIdentityCheck: async (relativePath) => {
					if (
						!swapped &&
						relativePath === "starter-level/assets/snowfield-layout.glb"
					) {
						swapped = true;
						await writeFile(target, Buffer.alloc(original.length, 0x5a));
					}
				},
			});
			expect(swapped).toBe(true);
			expect(budget).toMatchObject({
				ok: true,
				issues: [],
				contentDigest: baselineDigest,
			});
			expect(
				budget.files.find(
					(file) =>
						file.path === "starter-objects/assets/rock-small-a.glb",
				)?.sha256,
			).toBe(createHash("sha256").update(original).digest("hex"));
			expect(
				await contentDigest({ root: ROOT, contentRoot: output }),
			).not.toBe(baselineDigest);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("keeps all runtime files data-only, self-contained, and within declared budgets", async () => {
		const scan = await scanStarterRuntimeFiles({
			root: ROOT,
			contentRoot: CONTENT_ROOT,
		});
		const budget = await buildAssetBudgetReport({
			root: ROOT,
			contentRoot: CONTENT_ROOT,
		});

		expect(scan.issues).toEqual([]);
		expect(scan.files.length).toBeGreaterThan(0);
		expect(
			scan.files.every(
				(file) =>
					!/\.(?:js|mjs|cjs|ts|tsx|jsx|wasm|html|css)$/u.test(file.path),
			),
		).toBe(true);
		expect(budget.issues).toEqual([]);
		expect(budget.totals.glbFiles).toBeGreaterThan(0);
		const standalonePngBytes = budget.files.reduce(
			(total, file) => total + (file.texture === undefined ? 0 : file.bytes),
			0,
		);
		const embeddedGlbTextureBytes = budget.files.reduce(
			(total, file) => total + (file.glb?.textureBytes ?? 0),
			0,
		);
		expect(standalonePngBytes).toBeGreaterThan(0);
		expect(budget.totals.textureBytes).toBe(
			standalonePngBytes + embeddedGlbTextureBytes,
		);
		expect(budget.totals.triangles).toBeLessThanOrEqual(
			ASSET_LIMITS.maxStarterTriangles,
		);
	});
});
