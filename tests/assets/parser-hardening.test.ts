import { createHash } from "node:crypto";
import {
	appendFile,
	cp,
	mkdir,
	mkdtemp,
	rename,
	rm,
	readFile,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
	CONTENT_BUDGETS,
	PACKAGE_LIMITS,
} from "../../packages/protocol/src/version.js";
import {
	ASSET_LIMITS,
	buildDeterministicPackageArtifact,
	inspectGlb,
	inspectPng,
	inspectStarterPackages,
	rebuildStarterContent,
	scanStarterRuntimeFiles,
	validatePackageBudgets,
} from "../../tools/assets/lib/asset-pipeline.mjs";
import {
	inventoryTree,
	readInventoriedFile,
} from "../../tools/assets/lib/tree-inventory.mjs";

const ROOT = process.cwd();

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function artifactInput(paths: readonly string[]) {
	const bytes = Buffer.from([0x01]);
	return {
		manifest: {
			name: "@infinite-snowball/parser-test",
			version: "1.0.0",
			kind: "level",
			license: "CC0-1.0",
			assets: paths.map((path) => ({
				path,
				bytes: bytes.length,
				sha256: sha256(bytes),
			})),
			totals: {
				bytes: 0,
				fileCount: paths.length,
				uncompressedBytes: paths.length,
				maxDepth: 2,
				maxCompressionRatio: 100,
			},
		},
		assetBytes: new Map(paths.map((path) => [path, bytes])),
	};
}

function buildArtifact(paths: readonly string[]) {
	const input = artifactInput(paths);
	return buildDeterministicPackageArtifact(input.manifest as never, input.assetBytes);
}

function jsonOnlyGlb(document: Record<string, unknown> | string): Buffer {
	const json = Buffer.from(
		typeof document === "string" ? document : JSON.stringify(document),
		"utf8",
	);
	const paddedLength = Math.ceil(json.length / 4) * 4;
	const output = Buffer.alloc(20 + paddedLength, 0x20);
	output.writeUInt32LE(0x46546c67, 0);
	output.writeUInt32LE(2, 4);
	output.writeUInt32LE(output.length, 8);
	output.writeUInt32LE(paddedLength, 12);
	output.writeUInt32LE(0x4e4f534a, 16);
	json.copy(output, 20);
	return output;
}

function appendGlbChunk(glb: Buffer, type: number, data = Buffer.alloc(0)): Buffer {
	if (data.length % 4 !== 0) throw new Error("Test GLB chunks must be aligned");
	const chunk = Buffer.alloc(8 + data.length);
	chunk.writeUInt32LE(data.length, 0);
	chunk.writeUInt32LE(type, 4);
	data.copy(chunk, 8);
	const output = Buffer.concat([glb, chunk]);
	output.writeUInt32LE(output.length, 8);
	return output;
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

function deflateBombPng(): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(1, 0);
	ihdr.writeUInt32BE(1, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const oversizedScanlines = deflateSync(Buffer.alloc(4 * 1024 * 1024));
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", oversizedScanlines),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function misorderedTruecolorPalettePng(): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(1, 0);
	ihdr.writeUInt32BE(1, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk("IHDR", ihdr),
		pngChunk("tRNS", Buffer.alloc(6)),
		pngChunk("PLTE", Buffer.alloc(3)),
		pngChunk("IDAT", deflateSync(Buffer.alloc(4))),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function rgbaPng(width: number, height: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const scanlineBytes = height * (width * 4 + 1);
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(Buffer.alloc(scanlineBytes))),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function glbWithEmbeddedPngs(png: Buffer, count: number): Buffer {
	const payload = Buffer.concat(Array.from({ length: count }, () => png));
	const binary = Buffer.concat([
		payload,
		Buffer.alloc((4 - (payload.length % 4)) % 4),
	]);
	const bufferViews = Array.from({ length: count }, (_, index) => ({
		buffer: 0,
		byteOffset: index * png.length,
		byteLength: png.length,
	}));
	return appendGlbChunk(
		jsonOnlyGlb({
			asset: { version: "2.0" },
			buffers: [{ byteLength: payload.length }],
			bufferViews,
			images: bufferViews.map((_, bufferView) => ({
				bufferView,
				mimeType: "image/png",
			})),
		}),
		0x004e4942,
		binary,
	);
}

function glbWithEmbeddedPngOffset(
	png: Buffer,
	byteOffset?: unknown,
): Buffer {
	const binary = Buffer.concat([
		png,
		Buffer.alloc((4 - (png.length % 4)) % 4),
	]);
	const view: Record<string, unknown> = {
		buffer: 0,
		byteLength: png.length,
	};
	if (arguments.length > 1) view.byteOffset = byteOffset;
	return appendGlbChunk(
		jsonOnlyGlb({
			asset: { version: "2.0" },
			buffers: [{ byteLength: png.length }],
			bufferViews: [view],
			images: [{ bufferView: 0, mimeType: "image/png" }],
		}),
		0x004e4942,
		binary,
	);
}

describe("deterministic code-unit ordering", () => {
	const unsortedNames = ["a-sort.bin", "_sort.bin", "B-sort.bin", "-sort.bin"];
	const expectedNames = ["-sort.bin", "B-sort.bin", "_sort.bin", "a-sort.bin"];

	it("orders package artifact members by UTF-16 code units", () => {
		const paths = unsortedNames.map((name) => `assets/${name}`);
		expect(
			buildArtifact(paths)
				.entries.filter((entry) => entry.kind === "asset")
				.map((entry) => entry.path),
		).toEqual(expectedNames.map((name) => `assets/${name}`));
	});

	it("orders bounded inventory entries by UTF-16 code units", async () => {
		const root = await mkdtemp(join(tmpdir(), "infinite-snowball-ordering-"));
		try {
			for (const name of unsortedNames) await writeFile(join(root, name), name);
			const inventory = await inventoryTree(root);
			expect(inventory.entries.map((entry) => entry.relativePath)).toEqual(
				expectedNames,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("orders runtime scan facts by UTF-16 code units", async () => {
		const contentRoot = await mkdtemp(
			join(tmpdir(), "infinite-snowball-runtime-ordering-"),
		);
		const assetsRoot = join(contentRoot, "starter-objects", "assets");
		try {
			await mkdir(assetsRoot, { recursive: true });
			for (const name of unsortedNames) {
				await writeFile(join(assetsRoot, name.replace(".bin", ".json")), "{}\n");
			}
			const scan = await scanStarterRuntimeFiles({ root: ROOT, contentRoot });
			expect(
				scan.files
					.map((file) => file.path)
					.filter((path) => path.endsWith("sort.json")),
			).toEqual(
				expectedNames.map(
					(name) => `starter-objects/assets/${name.replace(".bin", ".json")}`,
				),
			);
		} finally {
			await rm(contentRoot, { recursive: true, force: true });
		}
	});

	it("contains no locale-dependent comparison in asset generators", async () => {
		const sources = await Promise.all(
			[
				"asset-pipeline.mjs",
				"package-artifact.mjs",
				"tree-inventory.mjs",
			].map((name) =>
				readFile(join(ROOT, "tools", "assets", "lib", name), "utf8"),
			),
		);
		for (const source of sources) expect(source).not.toContain(".localeCompare(");
	});
});

describe("package artifact path hardening", () => {
	it.each([
		"assets//icon.png",
		"assets/./icon.png",
		"assets/../icon.png",
		"assets/icon.png/",
		"assets\\icon.png",
		"assets/\0icon.png",
		`assets/${"nested/".repeat(14)}icon.png`,
	] as const)("rejects non-canonical tar member path %j", (path) => {
		expect(() => buildArtifact([path])).toThrow(/^E_PACKAGE_ARTIFACT_PATH:/u);
	});

	it("rejects duplicate canonical tar member paths before rendering", () => {
		expect(() =>
			buildArtifact(["assets/icon.png", "assets/icon.png"]),
		).toThrow(/^E_PACKAGE_ARTIFACT_PATH:/u);
	});
});

describe("bounded binary media parsers", () => {
	it("requires the exact GLB JSON then optional BIN chunk layout", () => {
		const jsonOnly = jsonOnlyGlb({ asset: { version: "2.0" } });
		const unknownAfterJson = appendGlbChunk(jsonOnly, 0x12345678);
		const withBin = appendGlbChunk(
			jsonOnlyGlb({
				asset: { version: "2.0" },
				buffers: [{ byteLength: 1 }],
			}),
			0x004e4942,
			Buffer.from([0x01, 0x00, 0x00, 0x00]),
		);
		const unknownAfterBin = appendGlbChunk(withBin, 0x12345678);

		expect(inspectGlb(jsonOnly)).toMatchObject({ ok: true, issues: [] });
		expect(inspectGlb(withBin)).toMatchObject({ ok: true, issues: [] });
		for (const malformed of [unknownAfterJson, unknownAfterBin]) {
			expect(inspectGlb(malformed).issues.map((issue) => issue.ruleId)).toContain(
				"E_GLB_CHUNK",
			);
		}
	});

	it("collects decoded GLB object keys and string values in the bounded parse", () => {
		const result = inspectGlb(
			jsonOnlyGlb(
				'{"asset":{"version":"2.0"},"extras":{"br\\u0061nd":"SNO\\u0057BALL"}}',
			),
		);
		expect(result).toMatchObject({
			ok: true,
			metrics: {
				textValues: expect.arrayContaining([
					"asset",
					"version",
					"2.0",
					"extras",
					"brand",
					"SNOWBALL",
				]),
			},
		});
	});

	it("accepts arbitrary valid GLB formatting and rejects decoded duplicate keys", () => {
		expect(
			inspectGlb(
				jsonOnlyGlb(`{
	"extras": {
		"claim": "reviewed"
	},
	"asset": {
		"version": "2.0"
	}
}`),
			),
		).toMatchObject({ ok: true, issues: [] });

		for (const json of [
			'{"asset":{"version":"2.0"},"extras":{"claim":"bad"},"extr\\u0061s":{"claim":"clean"}}',
			'{"asset":{"version":"2.0"},"extras":{"nested":{"ke\\u0079":"bad","key":"clean"}}}',
		]) {
			expect(inspectGlb(jsonOnlyGlb(json))).toMatchObject({
				ok: false,
				issues: expect.arrayContaining([
					expect.objectContaining({ ruleId: "E_GLB_JSON", path: "/" }),
				]),
			});
		}
	});

	it.each([
		"https://example.com/model.glb",
		"http://example.com/model.glb",
		"data:application/octet-stream;base64,AA==",
		"blob:https://example.com/00000000-0000-0000-0000-000000000000",
		"file:///tmp/model.glb",
		"https://user:secret@example.com/model.glb",
		"https://127.0.0.1/model.glb",
		"https://10.0.0.1/model.glb",
	])("rejects absolute URL syntax in arbitrary bounded GLB text: %s", (value) => {
		const result = inspectGlb(
			jsonOnlyGlb({
				asset: { version: "2.0" },
				extras: { nested: ["local", { value }] },
			}),
		);
		expect(result.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					ruleId: "E_GLB_EXTERNAL_REFERENCE",
					path: "/",
				}),
			]),
		);
	});

	it("rejects absolute URL syntax in GLB keys without rejecting prose", () => {
		expect(
			inspectGlb(
				jsonOnlyGlb({
					asset: { version: "2.0" },
					extras: { "https://example.com/model.glb": "remote" },
				}),
			).issues,
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					ruleId: "E_GLB_EXTERNAL_REFERENCE",
					path: "/",
				}),
			]),
		);
		expect(
			inspectGlb(
				jsonOnlyGlb({
					asset: { version: "2.0" },
					extras: { note: "Review status: generated locally" },
				}),
			),
		).toMatchObject({ ok: true, issues: [] });
	});

	it.each([null, "0", -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects a present invalid bufferView byteOffset %j at validation and extraction",
		(byteOffset) => {
			const result = inspectGlb(
				glbWithEmbeddedPngOffset(rgbaPng(1, 1), byteOffset),
			);
			expect(result.issues).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						ruleId: "E_GLB_BINARY_INVALID",
						path: "/bufferViews/0",
					}),
					expect.objectContaining({
						ruleId: "E_ASSET_TEXTURE_UNINSPECTED",
						path: "/images/0",
					}),
				]),
			);
		},
	);

	it("defaults only an omitted bufferView byteOffset to zero", () => {
		const png = rgbaPng(1, 1);
		expect(inspectGlb(glbWithEmbeddedPngOffset(png))).toMatchObject({
			ok: true,
			issues: [],
			metrics: { textureBytes: png.length },
		});
	});

	it("propagates GLB text only through internal local asset metrics", async () => {
		const result = await inspectStarterPackages({ root: ROOT });
		expect(result.ok).toBe(true);
		const pkg = result.packages.find((entry) =>
			entry.manifest.assets.some(
				(asset: { mime: string }) => asset.mime === "model/gltf-binary",
			),
		);
		const asset = pkg?.manifest.assets.find(
			(entry: { mime: string }) => entry.mime === "model/gltf-binary",
		);
		expect(pkg).toBeDefined();
		expect(asset).toBeDefined();
		expect(
			pkg!.budgetInspection.localAssetMetrics[asset!.path]?.textValues,
		).toEqual(expect.arrayContaining(["asset", "version", "2.0"]));
		expect(
			pkg!.inspection.files.find((file) => file.path === asset!.path),
		).not.toHaveProperty("textValues");
	});

	it("rejects DEFLATE output far beyond exact IHDR scanline bytes", () => {
		expect(inspectPng(deflateBombPng())).toMatchObject({
			ok: false,
			metrics: { width: 1, height: 1, decodedBytes: 0 },
			issues: [
				{
					ruleId: "E_PNG_STRUCTURE",
					path: "/IDAT",
				},
			],
		});
	});

	it("rejects a truecolor palette placed after transparency", () => {
		expect(inspectPng(misorderedTruecolorPalettePng())).toMatchObject({
			ok: false,
			issues: [
				{
					ruleId: "E_PNG_STRUCTURE",
					path: "/chunks/2",

				},
			],
		});
	});

	it("bounds cumulative decoded work across compact embedded PNGs", () => {
		const png = rgbaPng(4_096, 4_096);
		const decodedScanlineBytes = 4_096 * (4_096 * 4 + 1);
		const one = inspectGlb(glbWithEmbeddedPngs(png, 1));
		expect(ASSET_LIMITS.maxDecodedTextureBytes).toBe(80 * 1024 * 1024);
		expect(one).toMatchObject({
			ok: true,
			metrics: {
				decodedTextureBytes: decodedScanlineBytes,
			},
		});
		const two = inspectGlb(glbWithEmbeddedPngs(png, 2));
		expect(two.metrics.decodedTextureBytes).toBe(decodedScanlineBytes * 2);
		expect(two.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					ruleId: "E_ASSET_TEXTURE_DECODE_BUDGET",
					path: "/images/1",
				}),
			]),
		);
	});
});

describe("generated provenance media identity", () => {
	it("rebuilds from exact retained keys and records each output media format", async () => {
		const outputRoot = await mkdtemp(
			join(ROOT, ".tmp-infinite-snowball-provenance-format-"),
		);
		const formatByMime: Record<string, string> = {
			"audio/wav": "pcm16-stereo-wav",
			"image/png": "rgba-png",
			"model/gltf-binary": "glb",
		};
		const formatByExtension: Record<string, string> = {
			".glb": "glb",
			".png": "rgba-png",
			".wav": "pcm16-stereo-wav",
		};
		try {
			const rebuilt = await rebuildStarterContent({
				root: ROOT,
				outputRoot,
			});
			for (const pkg of rebuilt.packages) {
				for (const asset of pkg.manifest.assets) {
					const extension = asset.path.slice(asset.path.lastIndexOf("."));
					const format = asset.provenance.transformation.config.format;
					expect(format, `${pkg.packageName}:${asset.path}:MIME`).toBe(
						formatByMime[asset.mime],
					);
					expect(format, `${pkg.packageName}:${asset.path}:extension`).toBe(
						formatByExtension[extension],
					);
				}
			}
		} finally {
			await rm(outputRoot, { recursive: true, force: true });
		}
	});
});

describe("rebuild output ownership", () => {
	it("rejects a symlinked output root without touching its external target", async () => {
		const fixtureRoot = await mkdtemp(
			join(ROOT, ".tmp-infinite-snowball-output-safety-"),
		);
		const externalRoot = await mkdtemp(
			join(tmpdir(), "infinite-snowball-output-external-"),
		);
		const sentinel = join(externalRoot, "starter-objects", "sentinel.txt");
		try {
			await mkdir(join(externalRoot, "starter-objects"));
			await writeFile(sentinel, "untouched");
			const outputRoot = join(fixtureRoot, "output");
			await symlink(externalRoot, outputRoot, "dir");
			await expect(
				rebuildStarterContent({ root: ROOT, outputRoot }),
			).rejects.toThrow(/^E_OUTPUT_ROOT:/u);
			await expect(readFile(sentinel, "utf8")).resolves.toBe("untouched");
		} finally {
			await rm(fixtureRoot, { recursive: true, force: true });
			await rm(externalRoot, { recursive: true, force: true });
		}
	});
});

describe("clean-checkout parser boundary", () => {
	it("imports asset parsers without generated protocol dist", async () => {
		const isolatedRoot = await mkdtemp(
			join(tmpdir(), "infinite-snowball-parser-import-"),
		);
		try {
			const isolatedLib = join(isolatedRoot, "tools", "assets", "lib");
			await cp(join(ROOT, "tools", "assets", "lib"), isolatedLib, {
				recursive: true,
			});
			// Dynamic import is intentional: this test loads a runtime-selected
			// clean-checkout copy whose protocol dist directory does not exist.
			const isolatedPipeline = await import(
				pathToFileURL(join(isolatedLib, "asset-pipeline.mjs")).href
			);
			expect(isolatedPipeline.inspectGlb).toBeTypeOf("function");
			expect(isolatedPipeline.inspectPng).toBeTypeOf("function");
			const inspectWithoutValidator = () =>
				isolatedPipeline.inspectStarterPackages({
					root: isolatedRoot,
					contentRoot: join(isolatedRoot, "content"),
				});
			await expect(inspectWithoutValidator()).rejects.toThrow(
				/^E_PROTOCOL_BUILD:/u,
			);
			const protocolRoot = join(isolatedRoot, "packages", "protocol");
			const validationRoot = join(protocolRoot, "dist", "validation");
			await mkdir(validationRoot, { recursive: true });
			await writeFile(
				join(protocolRoot, "package.json"),
				`${JSON.stringify({ type: "module" })}\n`,
			);
			await writeFile(
				join(validationRoot, "package-inspection.js"),
				[
					"export function validatePackageInspection() {",
					"\treturn { ok: true, issues: [] };",
					"}",
					"",
				].join("\n"),
			);
			await expect(inspectWithoutValidator()).rejects.toThrow(
				/^E_PROTOCOL_BUILD:/u,
			);
		} finally {
			await rm(isolatedRoot, { recursive: true, force: true });
		}
	});

	it("runs module-relative protocol validation before P03 budgets in both consumers", async () => {
		const isolatedRoot = await mkdtemp(
			join(tmpdir(), "infinite-snowball-validator-order-"),
		);
		try {
			const isolatedLib = join(isolatedRoot, "tools", "assets", "lib");
			const protocolRoot = join(isolatedRoot, "packages", "protocol");
			const validationRoot = join(protocolRoot, "dist", "validation");
			const callerRoot = join(isolatedRoot, "untrusted-caller-root");
			const callerProtocolRoot = join(callerRoot, "packages", "protocol");
			const callerValidationRoot = join(
				callerProtocolRoot,
				"dist",
				"validation",
			);
			await cp(join(ROOT, "tools", "assets", "lib"), isolatedLib, {
				recursive: true,
			});
			await cp(join(ROOT, "content"), join(callerRoot, "content"), {
				recursive: true,
			});
			await mkdir(validationRoot, { recursive: true });
			await writeFile(
				join(protocolRoot, "package.json"),
				`${JSON.stringify({ type: "module" })}\n`,
			);
			await writeFile(
				join(validationRoot, "package-inspection.js"),
				[
					"export function validatePackageInspection(inspection) {",
					"\tinspection.manifest.assets.pop();",
					"\treturn {",
					"\t\tok: false,",
					'\t\tissues: [{ ruleId: "E_PROTOCOL_SENTINEL", path: "/protocol", remediation: "test protocol first" }],',
					"\t};",
					"}",
					"",
				].join("\n"),
			);
			await mkdir(callerValidationRoot, { recursive: true });
			await writeFile(
				join(callerProtocolRoot, "package.json"),
				`${JSON.stringify({ type: "module" })}\n`,
			);
			await writeFile(
				join(callerValidationRoot, "package-inspection.js"),
				[
					"export function validatePackageInspection() {",
					'\treturn { ok: false, issues: [{ ruleId: "E_ATTACKER_SENTINEL", path: "/attacker", remediation: "must never execute" }] };',
					"}",
					"",
				].join("\n"),
			);
			// Dynamic import is intentional: the fixture selects a copied module
			// whose module-relative validator makes execution order observable.
			const isolatedPipeline = await import(
				pathToFileURL(join(isolatedLib, "asset-pipeline.mjs")).href
			);
			const inspection = await isolatedPipeline.inspectStarterPackages({
				root: callerRoot,
				contentRoot: join(callerRoot, "content"),
			});
			const scan = await isolatedPipeline.scanStarterRuntimeFiles({
				root: callerRoot,
				contentRoot: join(callerRoot, "content"),
			});
			for (const [label, result] of [
				["inspectStarterPackages", inspection],
				["scanStarterRuntimeFiles", scan],
			] as const) {
				const protocolIndex = result.issues.findIndex(
					(issue: { ruleId: string }) =>
						issue.ruleId === "E_PROTOCOL_SENTINEL",
				);
				expect(
					result.issues.some(
						(issue: { ruleId: string }) =>
							issue.ruleId === "E_ATTACKER_SENTINEL",
					),
					`${label}:untrusted-root`,
				).toBe(false);
				const budgetIndex = result.issues.findIndex(
					(issue: { path: string; ruleId: string }, index: number) =>
						index > protocolIndex &&
						issue.ruleId === "E_FILE_BUDGET" &&
						issue.path.endsWith("/files"),
				);
				expect(protocolIndex, `${label}:protocol`).toBeGreaterThanOrEqual(0);
				expect(budgetIndex, `${label}:budget`).toBeGreaterThan(protocolIndex);
			}
		} finally {
			await rm(isolatedRoot, { recursive: true, force: true });
		}
	});
});

describe("semantic asset role closure", () => {
	it("rejects an otherwise valid oversized asset with no semantic reference", async () => {
		const inspected = await inspectStarterPackages({ root: ROOT });
		const source = inspected.packages.find(
			(entry) => entry.packageName === "starter-objects",
		);
		expect(source).toBeDefined();
		const mutation = structuredClone(source!.budgetInspection);
		const templateAsset = mutation.manifest.assets.find(
			(asset: { mime: string }) => asset.mime === "model/gltf-binary",
		)!;
		const templateFile = mutation.files.find(
			(file) => file.path === templateAsset.path,
		)!;
		const path = "assets/unreferenced.glb";
		mutation.manifest.assets.push({
			...templateAsset,
			assetId: "unreferenced",
			path,
			bytes: 7 * 1024 * 1024,
		});
		mutation.files.push({
			...templateFile,
			path,
			bytes: 7 * 1024 * 1024,
		});
		const templateMetrics =
			mutation.localAssetMetrics[templateAsset.path];
		if (templateMetrics === undefined) {
			throw new Error("template local asset metrics missing");
		}
		const validationInput = {
			...mutation,
			localAssetMetrics: {
				...mutation.localAssetMetrics,
				[path]: { ...templateMetrics },
			},
		};
		expect(validatePackageBudgets(validationInput)).toMatchObject({
			ok: false,
			issues: [
				expect.objectContaining({
					ruleId: "E_ASSET_ROLE",
					path: `/manifest/assets/${mutation.manifest.assets.length - 1}`,
				}),
			],
		});
	});
});

describe("bounded tree inventory", () => {
	async function expectBudgetFailure(
		populate: (root: string) => Promise<void>,
		limits: Record<string, number>,
	): Promise<void> {
		const root = await mkdtemp(join(tmpdir(), "infinite-snowball-inventory-"));
		try {
			await populate(root);
			const result = await inventoryTree(root, limits);
			expect(result.ok).toBe(false);
			expect(result.issues[0]).toMatchObject({
				ruleId: "E_FILE_BUDGET",
				path: "/",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	it("stops at the hard aggregate entry-count bound", async () => {
		await expectBudgetFailure(
			async (root) => {
				await mkdir(join(root, "a"));
				await mkdir(join(root, "b"));
			},
			{ maxEntries: 1 },
		);
	});


	it("stops at the hard file-count bound", async () => {
		await expectBudgetFailure(
			async (root) => {
				await writeFile(join(root, "a.bin"), "a");
				await writeFile(join(root, "b.bin"), "b");
			},
			{ maxFiles: 1 },
		);
	});

	it("stops at the hard depth bound", async () => {
		await expectBudgetFailure(
			async (root) => {
				await mkdir(join(root, "a", "b"), { recursive: true });
			},
			{ maxDepth: 1 },
		);
	});

	it("stops at the hard per-file byte bound", async () => {
		await expectBudgetFailure(
			async (root) => {
				await writeFile(join(root, "large.bin"), "ab");
			},
			{ maxFileBytes: 1 },
		);
	});

	it("stops at the hard aggregate byte bound", async () => {
		await expectBudgetFailure(
			async (root) => {
				await writeFile(join(root, "a.bin"), "a");
				await writeFile(join(root, "b.bin"), "b");
			},
			{ maxTotalBytes: 1 },
		);
	});
	it("accepts 65 files below the derived starter root ceiling", async () => {
		const root = await mkdtemp(join(tmpdir(), "infinite-snowball-inventory-65-"));
		try {
			await Promise.all(
				Array.from({ length: 65 }, (_, index) =>
					writeFile(join(root, `asset-${index}.bin`), Buffer.alloc(0)),
				),
			);
			await expect(
				inventoryTree(root, {
					maxEntries: ASSET_LIMITS.maxStarterEntries,
					maxFiles: ASSET_LIMITS.maxStarterFiles,
					maxDepth: ASSET_LIMITS.maxStarterDepth,
					maxFileBytes: ASSET_LIMITS.maxStarterFileBytes,
					maxTotalBytes: ASSET_LIMITS.maxStarterBytes,
				}),
			).resolves.toMatchObject({ ok: true, issues: [] });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("derives the starter upper bounds from the five P02 package ceilings", () => {
		const maxStarterFiles =
			PACKAGE_LIMITS.maxFiles * 3 +
			CONTENT_BUDGETS.level.maxFiles +
			CONTENT_BUDGETS.music.maxTracks +
			16 +
			5;
		const maxStarterBytes =
			3 *
				(PACKAGE_LIMITS.maxUncompressedBytes +
					PACKAGE_LIMITS.maxDeclaredBytes) +
			CONTENT_BUDGETS.level.maxUncompressedBytes +
			CONTENT_BUDGETS.level.maxDownloadBytes +
			CONTENT_BUDGETS.music.maxPackBytes * 2 +
			PACKAGE_LIMITS.maxFileBytes * 5;
		expect(ASSET_LIMITS).toMatchObject({
			maxFileBytes: CONTENT_BUDGETS.level.maxFileBytes,
			maxTriangles: CONTENT_BUDGETS.hero.maxTriangles,
			maxStarterFileBytes: PACKAGE_LIMITS.maxFileBytes,
			maxStarterFiles,
			maxStarterBytes,
			maxStarterDepth: PACKAGE_LIMITS.maxDepth + 1,
			maxStarterEntries: maxStarterFiles * (PACKAGE_LIMITS.maxDepth + 1),
			maxStarterTriangles:
				maxStarterFiles * CONTENT_BUDGETS.hero.maxTriangles,
		});
	});

	it.each(["regular replacement", "symlink replacement"] as const)(
		"rejects a %s after inventory before reading",
		async (replacementKind) => {
			const root = await mkdtemp(
				join(tmpdir(), "infinite-snowball-inventory-swap-"),
			);
			const outside = await mkdtemp(
				join(tmpdir(), "infinite-snowball-inventory-outside-"),
			);
			try {
				const target = join(root, "asset.bin");
				const replacement = join(outside, "replacement.bin");
				await writeFile(target, "reviewed");
				await writeFile(replacement, "attacker");
				const inventory = await inventoryTree(root);
				const entry = inventory.entries.find(
					(candidate) => candidate.relativePath === "asset.bin",
				);
				expect(entry).toBeDefined();
				if (replacementKind === "regular replacement") {
					await rename(replacement, target);
				} else {
					await rm(target);
					await symlink(replacement, target);
				}
				await expect(readInventoriedFile(entry!)).rejects.toThrow(
					/^E_PATH_POLICY:/u,
				);
			} finally {
				await rm(root, { recursive: true, force: true });
				await rm(outside, { recursive: true, force: true });
			}
		},
	);

	it("rejects same-inode growth after identity verification", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "infinite-snowball-inventory-growth-"),
		);
		try {
			const target = join(root, "asset.bin");
			await writeFile(target, "reviewed");
			const inventory = await inventoryTree(root);
			const entry = inventory.entries.find(
				(candidate) => candidate.relativePath === "asset.bin",
			);
			expect(entry).toBeDefined();
			await expect(
				readInventoriedFile(entry!, {
					afterIdentityCheck: () => appendFile(target, "-attacker-growth"),
				}),
			).rejects.toThrow(/^E_PATH_POLICY:/u);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
