import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	readdir,
	rename,
	rm,
	symlink,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
	buildAssetBudgetReport,
	inspectGlb,
	inspectPng,
	inspectStarterPackages,
	inspectWav,
	rebuildStarterContent,
} from "../../tools/assets/lib/asset-pipeline.mjs";
import {
	LOCAL_AUDIO_FIXTURE_RELATIVE_PATH,
	validateLocalAudioFixture,
} from "../../tools/assets/lib/local-audio-fixture.mjs";
import {
	provenanceRecordFileName,
	resolveRetainedLicenseEvidence,
} from "../../tools/assets/lib/provenance-ledger.mjs";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const RENDER_SCRIPT = join(ROOT, "tools", "assets", "render-smoke.mjs");
const HANDOFF_SCRIPT = join(ROOT, "tools", "assets", "handoff-report.mjs");
const SOURCE_EVIDENCE_DIRECTORY =
	"tools/assets/sources/kenney-nature-kit";
const SOURCE_EVIDENCE_PATHS = [
	`${SOURCE_EVIDENCE_DIRECTORY}/License.txt`,
	`${SOURCE_EVIDENCE_DIRECTORY}/rock_smallA-preview.png`,
	`${SOURCE_EVIDENCE_DIRECTORY}/rock_smallA.glb`,
	`${SOURCE_EVIDENCE_DIRECTORY}/source-evidence.json`,
] as const;
const LEVEL_ARENA_PROVENANCE = join(
	"docs",
	"licenses",
	"provenance",
	"records",
	provenanceRecordFileName({
		packageName: "@infinite-snowball/starter-level",
		assetId: "arena",
	}),
);
const temporaryRoots: string[] = [];

type EvidenceEntry = {
	category: string;
	path: string;
	bytes: number;
	sha256: string;
};

type RenderBinding = {
	assetId: string;
	assetPath: string;
	assetSha256: string;
	manifestPath: string;
	manifestSha256: string;
	mime: string;
};

type ReferenceRender = {
	renderId: string;
	kind: string;
	representativeReuseOf: string | null;
	verifiedAssetUrl: string;
	path: string;
	pngSha256: string;
	changedPixels: number;
	caption: string;
	credit: string;
	bindings: RenderBinding[];
};

type AuthoredObjectHint = {
	objectId: string;
	radius: number;
	volume: number;
	points: number;
	category: string;
	colliderAssetId: string;
	renderAssetId: string;
	attachPolicy: string;
	material: { roughness: number; metalness: number };
	lodAssetIds: string[];
	budgets: { maxTriangles: number; maxBytes: number };
};

type ObjectRuntimeHint = AuthoredObjectHint & {
	sizeClass: string;
};

type MutablePackageRef = {
	name: string;
	version: string;
	kind: string;
	engine: string;
	integrity: string;
	manifestSha256: string;
	catalogEntryId: string;
};

function replacePackageReferences(
	value: unknown,
	replacement: MutablePackageRef,
): number {
	if (Array.isArray(value))
		return value.reduce(
			(count, entry) => count + replacePackageReferences(entry, replacement),
			0,
		);
	if (value === null || typeof value !== "object") return 0;
	const record = value as Record<string, unknown>;
	let count = 0;
	if (
		record.name === replacement.name &&
		Object.hasOwn(record, "integrity") &&
		Object.hasOwn(record, "manifestSha256")
	) {
		for (const [key, next] of Object.entries(replacement)) record[key] = next;
		count = 1;
	}
	for (const next of Object.values(record))
		count += replacePackageReferences(next, replacement);
	return count;
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes: Buffer): number {
	let crc = 0xffff_ffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1)
			crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1));
	}
	return (crc ^ 0xffff_ffff) >>> 0;
}

function repartitionPngIdat(png: Buffer): Buffer {
	const idatChunks: Array<{ offset: number; data: Buffer }> = [];
	for (let offset = 8; offset < png.length; ) {
		const length = png.readUInt32BE(offset);
		const type = png.toString("ascii", offset + 4, offset + 8);
		if (type === "IDAT")
			idatChunks.push({
				offset,
				data: png.subarray(offset + 8, offset + 8 + length),
			});
		offset += length + 12;
	}
	const index = idatChunks.findIndex(
		(chunk, position) =>
			chunk.data.length > 0 &&
			idatChunks[position + 1]?.offset ===
				chunk.offset + chunk.data.length + 12,
	);
	if (index < 0) throw new Error("PNG fixture needs adjacent IDAT chunks.");
	const first = idatChunks[index];
	const second = idatChunks[index + 1];
	if (first === undefined || second === undefined)
		throw new Error("PNG fixture IDAT pair is incomplete.");
	const encode = (data: Buffer): Buffer => {
		const type = Buffer.from("IDAT", "ascii");
		const chunk = Buffer.alloc(data.length + 12);
		chunk.writeUInt32BE(data.length, 0);
		type.copy(chunk, 4);
		data.copy(chunk, 8);
		chunk.writeUInt32BE(
			crc32(Buffer.concat([type, data])),
			chunk.length - 4,
		);
		return chunk;
	};
	const movedByte = first.data.subarray(-1);
	const firstChunk = encode(first.data.subarray(0, -1));
	const secondChunk = encode(Buffer.concat([movedByte, second.data]));
	return Buffer.concat([
		png.subarray(0, first.offset),
		firstChunk,
		secondChunk,
		png.subarray(second.offset + second.data.length + 12),
	]);
}

function glbWithEmbeddedPng(glb: Buffer, png: Buffer): Buffer {
	const align4 = (value: number) => (value + 3) & ~3;
	if (
		glb.length < 28 ||
		glb.toString("ascii", 0, 4) !== "glTF" ||
		glb.readUInt32LE(4) !== 2 ||
		glb.readUInt32LE(8) !== glb.length
	) {
		throw new Error("Synthetic GLB source header is invalid.");
	}
	const jsonLength = glb.readUInt32LE(12);
	if (glb.readUInt32LE(16) !== 0x4e4f_534a)
		throw new Error("Synthetic GLB source lacks a JSON chunk.");
	const binaryHeaderOffset = 20 + jsonLength;
	if (
		binaryHeaderOffset + 8 > glb.length ||
		glb.readUInt32LE(binaryHeaderOffset + 4) !== 0x004e_4942
	) {
		throw new Error("Synthetic GLB source lacks a BIN chunk.");
	}
	const binaryLength = glb.readUInt32LE(binaryHeaderOffset);
	const binaryOffset = binaryHeaderOffset + 8;
	if (binaryOffset + binaryLength !== glb.length)
		throw new Error("Synthetic GLB source has unexpected trailing chunks.");
	const document = JSON.parse(
		glb
			.subarray(20, binaryHeaderOffset)
			.toString("utf8")
			.replace(/[ \u0000]+$/u, ""),
	) as {
		buffers: Array<{ byteLength: number }>;
		bufferViews?: Array<Record<string, number>>;
		images?: Array<Record<string, unknown>>;
	};
	const buffer = document.buffers?.[0];
	if (
		buffer === undefined ||
		!Number.isSafeInteger(buffer.byteLength) ||
		buffer.byteLength < 0 ||
		buffer.byteLength > binaryLength
	) {
		throw new Error("Synthetic GLB source buffer length is invalid.");
	}
	const imageOffset = align4(buffer.byteLength);
	const logicalBinaryLength = imageOffset + png.length;
	const paddedBinaryLength = align4(logicalBinaryLength);
	const binary = Buffer.alloc(paddedBinaryLength);
	glb
		.subarray(binaryOffset, binaryOffset + buffer.byteLength)
		.copy(binary);
	png.copy(binary, imageOffset);
	const bufferViews = document.bufferViews ?? [];
	const imageBufferView = bufferViews.length;
	bufferViews.push({
		buffer: 0,
		byteOffset: imageOffset,
		byteLength: png.length,
	});
	document.bufferViews = bufferViews;
	document.images = [
		...(document.images ?? []),
		{ bufferView: imageBufferView, mimeType: "image/png" },
	];
	buffer.byteLength = logicalBinaryLength;
	const jsonBytes = Buffer.from(JSON.stringify(document), "utf8");
	const paddedJson = Buffer.alloc(align4(jsonBytes.length), 0x20);
	jsonBytes.copy(paddedJson);
	const output = Buffer.alloc(12 + 8 + paddedJson.length + 8 + binary.length);
	output.write("glTF", 0, "ascii");
	output.writeUInt32LE(2, 4);
	output.writeUInt32LE(output.length, 8);
	output.writeUInt32LE(paddedJson.length, 12);
	output.writeUInt32LE(0x4e4f_534a, 16);
	paddedJson.copy(output, 20);
	const outputBinaryHeader = 20 + paddedJson.length;
	output.writeUInt32LE(binary.length, outputBinaryHeader);
	output.writeUInt32LE(0x004e_4942, outputBinaryHeader + 4);
	binary.copy(output, outputBinaryHeader + 8);
	return output;
}

async function json<T>(root: string, path: string): Promise<T> {
	return JSON.parse(await readFile(join(root, path), "utf8")) as T;
}

async function replaceReferenceGlb(
	root: string,
	directory: string,
	assetId: string,
	bytes: Buffer,
): Promise<void> {
	const manifestPath = join(root, "content", directory, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
		assets: Array<{
			assetId: string;
			path: string;
			bytes: number;
			sha256: string;
			provenance?: { outputSha256?: string };
		}>;
		totals?: { uncompressedBytes?: number };
	};
	const asset = manifest.assets.find((candidate) => candidate.assetId === assetId);
	if (asset === undefined)
		throw new Error(`Missing synthetic reference asset: ${directory}:${assetId}`);
	const previousBytes = asset.bytes;
	await writeFile(join(root, "content", directory, asset.path), bytes);
	asset.bytes = bytes.length;
	asset.sha256 = sha256(bytes);
	if (asset.provenance !== undefined)
		asset.provenance.outputSha256 = asset.sha256;
	if (
		manifest.totals !== undefined &&
		Number.isSafeInteger(manifest.totals.uncompressedBytes)
	) {
		manifest.totals.uncompressedBytes =
			(manifest.totals.uncompressedBytes ?? 0) - previousBytes + bytes.length;
	}
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function runHandoffCheck(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	await execFileAsync(process.execPath, [HANDOFF_SCRIPT, "--check"], {
		cwd,
		env,
		timeout: 30_000,
	});
}

async function bypassHandoffRendererCheck(
	root: string,
): Promise<NodeJS.ProcessEnv> {
	const preloadPath = join(root, "bypass-handoff-render-check.mjs");
	await writeFile(
		preloadPath,
		`import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const originalExecFile = childProcess.execFile;
childProcess.execFile = function execFile(file, args, options, callback) {
  if (
    Array.isArray(args) &&
    args[0]?.endsWith("/tools/assets/render-smoke.mjs") &&
    args[1] === "--check"
  ) {
    queueMicrotask(() => callback(null, "", ""));
    return {};
  }
  return originalExecFile.call(this, file, args, options, callback);
};
syncBuiltinESMExports();
`,
	);
	return {
		...process.env,
		NODE_OPTIONS: [
			process.env.NODE_OPTIONS,
			`--import=${pathToFileURL(preloadPath).href}`,
		]
			.filter(Boolean)
			.join(" "),
	};
}

async function expectHandoffGenerationFailurePreserves(
	root: string,
	previous: Buffer,
): Promise<void> {
	await expect(
		execFileAsync(process.execPath, [HANDOFF_SCRIPT], {
			cwd: root,
			timeout: 60_000,
		}),
	).rejects.toThrow();
	expect(
		await readFile(join(root, "docs/assets/p03-content-handoff.json")),
	).toEqual(previous);
}


async function copiedRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "snowball-handoff-"));
	await mkdir(join(root, "tools", "assets"), { recursive: true });
	temporaryRoots.push(root);
	await Promise.all([
		cp(join(ROOT, "content"), join(root, "content"), { recursive: true }),
		cp(join(ROOT, "docs"), join(root, "docs"), { recursive: true }),
		cp(join(ROOT, "tests", "fixtures"), join(root, "tests", "fixtures"), {
			recursive: true,
		}),
		cp(
			join(ROOT, "tools", "assets", "lib"),
			join(root, "tools", "assets", "lib"),
			{ recursive: true },
		),
		cp(
			join(ROOT, "tools", "assets", "templates"),
			join(root, "tools", "assets", "templates"),
			{ recursive: true },
		),
		cp(
			join(ROOT, SOURCE_EVIDENCE_DIRECTORY),
			join(root, SOURCE_EVIDENCE_DIRECTORY),
			{ recursive: true },
		),
	]);
	await Promise.all([
		symlink(join(ROOT, "node_modules"), join(root, "node_modules"), "dir"),
		symlink(join(ROOT, "packages"), join(root, "packages"), "dir"),
	]);
	return root;
}

async function listenTcpMutex() {
	const server = createTcpServer();
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, () => {
			server.off("error", reject);
			resolvePromise();
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("TCP mutex test server did not bind.");
	return { server, port: address.port };
}
async function closeTcpMutex(server: TcpServer) {
	if (!server.listening) return;
	await new Promise<void>((resolvePromise, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolvePromise();
		});
	});
}


async function lockSwapPreload(
	root: string,
	lockPath: string,
	sentinel: string,
	occupant?: string,
): Promise<{
	markerPath: string;
	nodeOptions: string;
	environment: NodeJS.ProcessEnv;
}> {
	const hookPath = join(root, "swap-render-lock.cjs");
	const markerPath = join(root, "swap-render-lock.txt");
	await writeFile(
		hookPath,
		`const { renameSync, writeFileSync } = require("node:fs");
const promises = require("node:fs/promises");
const { syncBuiltinESMExports } = require("node:module");
const { resolve } = require("node:path");

const originalRename = promises.rename;
let swapped = false;
let occupied = false;
promises.rename = async function rename(source, destination) {
  if (!swapped && resolve(String(source)) === resolve(process.env.SWAP_RENDER_LOCK_PATH)) {
    swapped = true;
    const replacement = \`\${source}.\${process.pid}.replacement\`;
    writeFileSync(replacement, process.env.SWAP_RENDER_LOCK_SENTINEL, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(replacement, source);
    writeFileSync(process.env.SWAP_RENDER_LOCK_MARKER, "swapped");
  }
  const result = await originalRename.call(this, source, destination);
  if (
    swapped &&
    !occupied &&
    process.env.OCCUPY_RENDER_LOCK_SENTINEL !== undefined &&
    resolve(String(source)) === resolve(process.env.SWAP_RENDER_LOCK_PATH)
  ) {
    occupied = true;
    writeFileSync(source, process.env.OCCUPY_RENDER_LOCK_SENTINEL, {
      flag: "wx",
      mode: 0o600,
    });
  }
  return result;
};
syncBuiltinESMExports();
`,
	);
	const nodeOptions = [
		process.env.NODE_OPTIONS,
		`--require=${hookPath}`,
	]
		.filter(Boolean)
		.join(" ");
	return {
		markerPath,
		nodeOptions,
		environment: {
			SWAP_RENDER_LOCK_PATH: lockPath,
			SWAP_RENDER_LOCK_SENTINEL: sentinel,
			SWAP_RENDER_LOCK_MARKER: markerPath,
			...(occupant === undefined
				? {}
				: { OCCUPY_RENDER_LOCK_SENTINEL: occupant }),
		},
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots
			.splice(0)
			.map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function refreshSimulatedWithdrawalIdentity(
	root: string,
	objectPackage: {
		manifest: { name: string; version: string };
		artifact: { integrity: string };
		manifestSha256: string;
	},
): Promise<void> {
	const withdrawalPath = join(
		root,
		"docs/licenses/withdrawals/starter-rock-simulated.json",
	);
	const withdrawal = JSON.parse(await readFile(withdrawalPath, "utf8")) as {
		recordId: string;
		package: Record<string, unknown>;
	};
	withdrawal.package = {
		name: objectPackage.manifest.name,
		version: objectPackage.manifest.version,
		integrity: objectPackage.artifact.integrity,
		manifestSha256: objectPackage.manifestSha256,
	};
	withdrawal.recordId = `withdrawal:${sha256(
		Buffer.from(
			[
				withdrawal.package.name,
				withdrawal.package.version,
				withdrawal.package.integrity,
				withdrawal.package.manifestSha256,
			].join("\n"),
			"utf8",
		),
	)}`;
	await writeFile(withdrawalPath, `${JSON.stringify(withdrawal, null, "\t")}\n`);
}

async function generatedHandoffRoot(): Promise<string> {
	const root = await copiedRoot();
	await rebuildStarterContent({
		root: await realpath(root),
		outputRoot: join(await realpath(root), "content"),
	});
	const inspection = await inspectStarterPackages({ root });
	const objectPackage = inspection.packages.find(
		(pkg) => pkg.manifest.name === "@infinite-snowball/starter-objects",
	);
	if (objectPackage === undefined)
		throw new Error("Refreshed starter-objects fixture is missing.");
	await refreshSimulatedWithdrawalIdentity(root, objectPackage);
	await execFileAsync(process.execPath, [RENDER_SCRIPT, "--generate"], {
		cwd: root,
		timeout: 60_000,
	});
	await execFileAsync(process.execPath, [HANDOFF_SCRIPT], {
		cwd: root,
		timeout: 60_000,
	});
	return root;
}

async function growingReadEnvironment(
	root: string,
	targetPath: string,
): Promise<NodeJS.ProcessEnv> {
	const preloadPath = join(root, "grow-owned-read.mjs");
	await writeFile(
		preloadPath,
		`import { appendFile, open, readFile } from "node:fs/promises";
const target = process.env.GROW_READ_TARGET;
const marker = (await readFile(target)).subarray(0, 64);
const probe = await open(target, "r");
const fileHandlePrototype = Object.getPrototypeOf(probe);
await probe.close();
const originalRead = fileHandlePrototype.read;
let grown = false;
fileHandlePrototype.read = async function (...args) {
	const result = await originalRead.apply(this, args);
	const buffer = args[0];
	if (
		!grown &&
		result.bytesRead > 0 &&
		Buffer.isBuffer(buffer) &&
		buffer.subarray(0, marker.length).equals(marker)
	) {
		grown = true;
		await appendFile(target, Buffer.from([0x21]));
	}
	return result;
};
`,
	);
	return {
		...process.env,
		GROW_READ_TARGET: targetPath,
		NODE_OPTIONS: [
			process.env.NODE_OPTIONS,
			`--import=${pathToFileURL(preloadPath).href}`,
		]
			.filter(Boolean)
			.join(" "),
	};
}

async function sameLengthEvidenceSwapEnvironment(
	root: string,
	targetPath: string,
	replacement: Buffer,
	baseEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
	const original = await readFile(targetPath);
	if (replacement.length !== original.length)
		throw new Error("Evidence swap fixture must preserve byte length.");
	const replacementPath = join(root, "evidence-swap-replacement.bin");
	const preloadPath = join(root, "swap-evidence-after-read.mjs");
	await writeFile(replacementPath, replacement);
	await writeFile(
		preloadPath,
		`import { realpathSync, renameSync } from "node:fs";
import { relative, sep } from "node:path";
const target = process.env.SWAP_EVIDENCE_TARGET;
const replacement = process.env.SWAP_EVIDENCE_REPLACEMENT;
const targetRelative = relative(realpathSync(process.cwd()), realpathSync(target))
  .split(sep)
  .join("/");
const NativeMap = globalThis.Map;
let swapped = false;
globalThis.Map = new Proxy(NativeMap, {
  construct(targetConstructor, args, newTarget) {
    const iterable = args[0];
    if (
      !swapped &&
      Array.isArray(iterable) &&
      iterable.some(
        (entry) =>
          Array.isArray(entry) &&
          entry[0] === targetRelative &&
          typeof entry[1]?.sha256 === "string",
      )
    ) {
      swapped = true;
      renameSync(replacement, target);
    }
    return Reflect.construct(targetConstructor, args, newTarget);
  },
});
`,
	);
	return {
		...baseEnvironment,
		SWAP_EVIDENCE_TARGET: targetPath,
		SWAP_EVIDENCE_REPLACEMENT: replacementPath,
		NODE_OPTIONS: [
			baseEnvironment.NODE_OPTIONS,
			`--import=${pathToFileURL(preloadPath).href}`,
		]
			.filter(Boolean)
			.join(" "),
	};
}

async function malformedRendererRequestEnvironment(
	root: string,
): Promise<{ env: NodeJS.ProcessEnv; markerPath: string }> {
	const preloadPath = join(root, "malformed-render-request.mjs");
	const markerPath = join(root, "malformed-render-request.txt");
	const playwrightEntry = pathToFileURL(
		join(ROOT, "node_modules", "@playwright", "test", "index.mjs"),
	).href;
	await writeFile(
		preloadPath,
		`import http from "node:http";
import { writeFileSync } from "node:fs";
import { chromium } from ${JSON.stringify(playwrightEntry)};

const originalLaunch = chromium.launch.bind(chromium);
chromium.launch = async function launch(...args) {
  const browser = await originalLaunch(...args);
  const originalNewPage = browser.newPage.bind(browser);
  browser.newPage = async function newPage(...pageArgs) {
    const page = await originalNewPage(...pageArgs);
    const originalGoto = page.goto.bind(page);
    page.goto = async function goto(url, ...gotoArgs) {
      const origin = new URL(url);
      const status = await new Promise((resolve, reject) => {
        const request = http.request(
          {
            hostname: origin.hostname,
            port: origin.port,
            path: "/node_modules/three/%ZZ.js",
            method: "GET",
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode));
          },
        );
        request.once("error", reject);
        request.end();
      });
      writeFileSync(process.env.MALFORMED_RENDER_REQUEST_MARKER, String(status));
      return originalGoto(url, ...gotoArgs);
    };
    return page;
  };
  return browser;
};
`,
	);
	return {
		markerPath,
		env: {
			...process.env,
			MALFORMED_RENDER_REQUEST_MARKER: markerPath,
			NODE_OPTIONS: [
				process.env.NODE_OPTIONS,
				`--import=${pathToFileURL(preloadPath).href}`,
			]
				.filter(Boolean)
				.join(" "),
		},
	};
}

async function failSecondRenderPublicationEnvironment(
	root: string,
): Promise<NodeJS.ProcessEnv> {
	const preloadPath = join(root, "fail-render-publication.cjs");
	await writeFile(
		preloadPath,
		`const promises = require("node:fs/promises");
const { syncBuiltinESMExports } = require("node:module");
const { resolve } = require("node:path");

const originalRename = promises.rename;
const referenceRoot = resolve(process.env.FAIL_RENDER_PUBLICATION_ROOT);
let failed = false;
promises.rename = async function rename(source, destination) {
  const resolvedSource = resolve(String(source));
  const resolvedDestination = resolve(String(destination));
  if (
    !failed &&
    resolvedDestination === referenceRoot &&
    resolvedSource.includes(".reference-renders.staging-")
  ) {
    failed = true;
    throw new Error("INJECTED_RENDER_PUBLICATION_FAILURE");
  }
  return originalRename.call(this, source, destination);
};
syncBuiltinESMExports();
`,
	);
	return {
		...process.env,
		FAIL_RENDER_PUBLICATION_ROOT: await realpath(
			join(root, "docs", "assets", "reference-renders"),
		),
		NODE_OPTIONS: [
			process.env.NODE_OPTIONS,
			`--require=${preloadPath}`,
		]
			.filter(Boolean)
			.join(" "),
	};
}

async function failPostCommitRenderCleanupEnvironment(
	root: string,
): Promise<NodeJS.ProcessEnv> {
	const preloadPath = join(root, "fail-render-cleanup.cjs");
	await writeFile(
		preloadPath,
		`const promises = require("node:fs/promises");
const { syncBuiltinESMExports } = require("node:module");

const originalRm = promises.rm;
let failed = false;
promises.rm = async function rm(path, options) {
  if (!failed && String(path).includes(".reference-renders.backup-")) {
    failed = true;
    throw new Error("INJECTED_RENDER_CLEANUP_FAILURE");
  }
  return originalRm.call(this, path, options);
};
syncBuiltinESMExports();
`,
	);
	return {
		...process.env,
		NODE_OPTIONS: [
			process.env.NODE_OPTIONS,
			`--require=${preloadPath}`,
		]
			.filter(Boolean)
			.join(" "),
	};
}

describe("P03 renderer pre-read declaration budgets", () => {
	async function fixture() {
		const root = await copiedRoot();
		const manifestPath = join(
			root,
			"content",
			"starter-objects",
			"manifest.json",
		);
		const manifest = JSON.parse(
			await readFile(manifestPath, "utf8"),
		) as { assets: Array<Record<string, unknown>> };
		const glb = manifest.assets.find(
			(asset) => asset.mime === "model/gltf-binary",
		);
		if (glb === undefined) throw new Error("GLB fixture is missing.");
		await Promise.all(
			[
				"starter-level",
				"starter-character",
				"starter-campaign",
				"starter-music",
			].map(async (directory) => {
				const otherPath = join(root, "content", directory, "manifest.json");
				const otherManifest = JSON.parse(
					await readFile(otherPath, "utf8"),
				) as { assets: Array<Record<string, unknown>> };
				otherManifest.assets = otherManifest.assets.filter(
					(asset) => asset.mime !== "model/gltf-binary",
				);
				await writeFile(otherPath, `${JSON.stringify(otherManifest)}\n`);
			}),
		);
		return { root, manifestPath, manifest, glb };
	}

	async function expectPreReadBudgetFailure(root: string, message: string) {
		await expect(
			execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
				cwd: root,
				timeout: 30_000,
			}),
		).rejects.toMatchObject({
			stderr: expect.stringContaining(message),
		});
	}

	async function expectFirstRetainedRead(root: string) {
		await expect(
			execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
				cwd: root,
				timeout: 30_000,
			}),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("missing-budget-sentinel.glb"),
		});
	}

	it("allows exactly 256 declared GLBs to reach the first retained read", async () => {
		const { root, manifestPath, manifest, glb } = await fixture();
		glb.path = "assets/missing-budget-sentinel.glb";
		manifest.assets = Array.from({ length: 256 }, (_, index) => ({
			...glb,
			assetId: `render-budget-${index}`,
		}));
		await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
		await expectFirstRetainedRead(root);
	});

	it("allows a declared 16 MiB GLB to reach the first retained read", async () => {
		const { root, manifestPath, manifest, glb } = await fixture();
		glb.path = "assets/missing-budget-sentinel.glb";
		glb.bytes = 16 * 1024 * 1024;
		manifest.assets = [glb];
		await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
		await expectFirstRetainedRead(root);
	});

	it("allows exactly 32 MiB declared GLB bytes to reach the first retained read", async () => {
		const { root, manifestPath, manifest, glb } = await fixture();
		glb.path = "assets/missing-budget-sentinel.glb";
		manifest.assets = [
			{ ...glb, assetId: "render-budget-0", bytes: 16 * 1024 * 1024 },
			{ ...glb, assetId: "render-budget-1", bytes: 16 * 1024 * 1024 },
		];
		await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
		await expectFirstRetainedRead(root);
	});


	it("counts repeated GLB declarations before reading retained bytes", async () => {
		const { root, manifestPath, manifest, glb } = await fixture();
		glb.path = "assets/missing-budget-sentinel.glb";
		manifest.assets = Array.from({ length: 257 }, (_, index) => ({
			...glb,
			assetId: `render-budget-${index}`,
		}));
		await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
		await expectPreReadBudgetFailure(
			root,
			"E_RENDER_BUDGET: declared GLB count",
		);
	});

	it("rejects an oversized declared GLB before reading it", async () => {
		const { root, manifestPath, manifest, glb } = await fixture();
		glb.path = "assets/missing-budget-sentinel.glb";
		glb.bytes = 16 * 1024 * 1024 + 1;
		await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
		await expectPreReadBudgetFailure(
			root,
			"E_RENDER_BUDGET: declared GLB file bytes",
		);
	});

	it("caps cumulative declared GLB bytes before retained reads", async () => {
		const { root, manifestPath, manifest, glb } = await fixture();
		glb.path = "assets/missing-budget-sentinel.glb";
		manifest.assets = [
			{ ...glb, assetId: "render-budget-0", bytes: 16 * 1024 * 1024 },
			{ ...glb, assetId: "render-budget-1", bytes: 16 * 1024 * 1024 },
			{ ...glb, assetId: "render-budget-2", bytes: 1 },
		];
		await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
		await expectPreReadBudgetFailure(
			root,
			"E_RENDER_BUDGET: cumulative declared GLB bytes",
		);
	});
});

describe("P03 persisted reference renders", () => {
	it("uses locale-independent code-unit ordering for generated evidence", async () => {
		const values = ["a/z", "A_z", "a-Z", "A.Z"];
		expect(
			values.sort((left, right) =>
				left < right ? -1 : left > right ? 1 : 0,
			),
		).toEqual(["A.Z", "A_z", "a-Z", "a/z"]);
		const [renderSource, handoffSource] = await Promise.all([
			readFile(RENDER_SCRIPT, "utf8"),
			readFile(HANDOFF_SCRIPT, "utf8"),
		]);
		expect(renderSource).not.toContain("localeCompare");
		expect(handoffSource).not.toContain("localeCompare");
	});

	it("reconstructs nonblank PNGs from current GLBs with deterministic bindings", async () => {
		await execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
			cwd: ROOT,
			timeout: 60_000,
		});

		const metadata = await json<{
			contentSha256: string;
			renderer: {
				engine: string;
				loader: string;
				requestFailures: string[];
			};
			renders: ReferenceRender[];
		}>(ROOT, "docs/assets/reference-renders/index.json");
		const handoff = await json<{
			contentSha256: string;
			packages: Array<{
				manifestPath: string;
				manifestSha256: string;
				assets: Array<{
					assetId: string;
					path: string;
					mime: string;
					sha256: string;
				}>;
			}>;
			runtimeHints: {
				referenceRenders: Array<{
					renderId: string;
					representativeReuseOf: string | null;
					verifiedAssetUrl: string;
					pngSha256: string;
				}>;
			};
		}>(ROOT, "docs/assets/p03-content-handoff.json");

		expect(metadata.contentSha256).toBe(handoff.contentSha256);
		expect(metadata.renderer).toMatchObject({
			engine: "Three.js",
			loader: "GLTFLoader",
		});
		expect(metadata.renderer.requestFailures).toEqual([]);
		expect(metadata.renders.map((render) => render.kind).sort()).toEqual([
			"character",
			"level-scene",
			"object",
		]);
		expect(
			new Set(metadata.renders.map((render) => render.verifiedAssetUrl)).size,
		).toBe(metadata.renders.length);
		expect(
			new Set(metadata.renders.map((render) => render.pngSha256)).size,
		).toBe(metadata.renders.length);
		expect(
			new Set(
				metadata.renders.map((render) => render.bindings[0]?.assetSha256),
			).size,
		).toBe(metadata.renders.length);
		expect(
			metadata.renders.every(
				(render) => render.representativeReuseOf === null,
			),
		).toBe(true);

		for (const render of metadata.renders) {
			expect(render.changedPixels).toBeGreaterThan(64);
			expect(render.caption.length).toBeGreaterThan(20);
			expect(render.credit.length).toBeGreaterThan(10);
			expect(render.bindings.length).toBeGreaterThan(0);
			expect(render.bindings).toHaveLength(1);
			expect(
				handoff.runtimeHints.referenceRenders.find(
					(candidate) => candidate.renderId === render.renderId,
				),
			).toMatchObject({
				representativeReuseOf: render.representativeReuseOf,
				verifiedAssetUrl: render.verifiedAssetUrl,
				pngSha256: render.pngSha256,
			});
			const bytes = await readFile(join(ROOT, render.path));
			expect(bytes.subarray(0, 8)).toEqual(
				Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
			);
			expect(sha256(bytes)).toBe(render.pngSha256);

			for (const binding of render.bindings) {
				expect(binding.mime).toBe("model/gltf-binary");
				expect(binding.assetPath.endsWith(".glb")).toBe(true);
				const asset = handoff.packages
					.find(
						(pkg) =>
							pkg.manifestPath === binding.manifestPath &&
							pkg.manifestSha256 === binding.manifestSha256,
					)
					?.assets.find(
						(candidate) =>
							candidate.assetId === binding.assetId &&
							candidate.path === binding.assetPath,
					);
				expect(asset).toMatchObject({
					mime: "model/gltf-binary",
					sha256: binding.assetSha256,
				});
			}
		}
	}, 60_000);

	it.each(["before", "after"])(
		"rejects duplicate package/asset IDs inserted %s the referenced declaration",
		async (position) => {
			const root = await copiedRoot();
			const manifestPath = join(
				root,
				"content",
				"starter-objects",
				"manifest.json",
			);
			const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
				assets: Array<{
					assetId: string;
					mime: string;
					[key: string]: unknown;
				}>;
			};
			const referencedIndex = manifest.assets.findIndex(
				(asset) => asset.assetId === "render",
			);
			const other = manifest.assets.find(
				(asset) =>
					asset.mime === "model/gltf-binary" && asset.assetId !== "render",
			);
			expect(referencedIndex).toBeGreaterThanOrEqual(0);
			expect(other).toBeDefined();
			const duplicate = {
				...other!,
				assetId: manifest.assets[referencedIndex]!.assetId,
			};
			manifest.assets.splice(
				position === "before" ? referencedIndex : referencedIndex + 1,
				0,
				duplicate,
			);
			await writeFile(
				manifestPath,
				`${JSON.stringify(manifest, null, 2)}\n`,
			);

			await expect(
				execFileAsync(process.execPath, [RENDER_SCRIPT, "--generate"], {
					cwd: root,
					timeout: 60_000,
				}),
			).rejects.toMatchObject({
				stderr: expect.stringContaining("E_RENDER_ASSET_IDENTITY"),
			});
		},
		60_000,
	);

	it("restores the complete reference-render set after a publication failure", async () => {
		const root = await copiedRoot();
		const outputPaths = [
			"docs/assets/reference-renders/index.json",
			"docs/assets/reference-renders/starter-level-scene.png",
			"docs/assets/reference-renders/starter-object-rock.png",
			"docs/assets/reference-renders/starter-character-pebble-friend.png",
		];
		await writeFile(
			join(root, outputPaths[1]!),
			Buffer.from("previous reference render bytes", "utf8"),
		);
		const previous = await Promise.all(
			outputPaths.map((path) => readFile(join(root, path))),
		);

		await expect(
			execFileAsync(process.execPath, [RENDER_SCRIPT, "--generate"], {
				cwd: root,
				env: await failSecondRenderPublicationEnvironment(root),
				timeout: 60_000,
			}),
		).rejects.toThrow();
		await Promise.all(
			outputPaths.map(async (path, index) => {
				expect(await readFile(join(root, path))).toEqual(previous[index]);
			}),
		);
	}, 60_000);

	it("keeps a committed reference set after transient cleanup failure", async () => {
		const root = await copiedRoot();
		const junkPath = join(
			root,
			"docs/assets/reference-renders/unexpected-before-commit.txt",
		);
		await writeFile(junkPath, "old reference-set member", "utf8");
		await execFileAsync(process.execPath, [RENDER_SCRIPT, "--generate"], {
			cwd: root,
			env: await failPostCommitRenderCleanupEnvironment(root),
			timeout: 60_000,
		});
		await expect(readFile(junkPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(
			(
				await readdir(join(root, "docs", "assets"))
			).some((name) => name.startsWith(".reference-renders.backup-")),
		).toBe(false);
		await execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
			cwd: root,
			timeout: 60_000,
		});
	}, 60_000);

	it.each(["--generate", "--check"])(
		"rejects aliased reference GLB identity in %s mode before publication",
		async (mode) => {
			const root = await copiedRoot();
			const level = await json<{
				assets: Array<{ assetId: string; path: string }>;
			}>(root, "content/starter-level/manifest.json");
			const arena = level.assets.find((asset) => asset.assetId === "arena");
			expect(arena).toBeDefined();
			await replaceReferenceGlb(
				root,
				"starter-objects",
				"render",
				await readFile(join(root, "content/starter-level", arena!.path)),
			);
			const outputPaths = [
				"docs/assets/reference-renders/index.json",
				"docs/assets/reference-renders/starter-level-scene.png",
				"docs/assets/reference-renders/starter-object-rock.png",
				"docs/assets/reference-renders/starter-character-pebble-friend.png",
			];
			const previous = await Promise.all(
				outputPaths.map((path) => readFile(join(root, path))),
			);
			await expect(
				execFileAsync(process.execPath, [RENDER_SCRIPT, mode], {
					cwd: root,
					timeout: 60_000,
				}),
			).rejects.toMatchObject({
				stderr: expect.stringContaining("E_RENDER_REFERENCE_IDENTITY"),
			});
			await Promise.all(
				outputPaths.map(async (path, index) => {
					expect(await readFile(join(root, path))).toEqual(previous[index]);
				}),
			);
		},
		60_000,
	);

	it.each(["--generate", "--check"])(
		"rejects duplicate captured reference PNG identity in %s mode",
		async (mode) => {
			const root = await copiedRoot();
			const objects = await json<{
				assets: Array<{
					assetId: string;
					path: string;
					mime: string;
				}>;
			}>(root, "content/starter-objects/manifest.json");
			const render = objects.assets.find((asset) => asset.assetId === "render");
			const png = objects.assets.find((asset) => asset.mime === "image/png");
			expect(render).toBeDefined();
			expect(png).toBeDefined();
			const syntheticGlb = glbWithEmbeddedPng(
				await readFile(join(root, "content/starter-objects", render!.path)),
				await readFile(join(root, "content/starter-objects", png!.path)),
			);
			await replaceReferenceGlb(
				root,
				"starter-objects",
				"render",
				syntheticGlb,
			);

			const temporaryRoot = await mkdtemp(
				join(tmpdir(), "snowball-render-duplicate-png-"),
			);
			temporaryRoots.push(temporaryRoot);
			const preloadPath = join(temporaryRoot, "duplicate-render-png.mjs");
			const markerPath = join(temporaryRoot, "injected.txt");
			const playwrightEntry = pathToFileURL(
				join(ROOT, "node_modules", "@playwright", "test", "index.mjs"),
			).href;
			await writeFile(
				preloadPath,
				`import { writeFileSync } from "node:fs";
import { chromium } from ${JSON.stringify(playwrightEntry)};

const originalLaunch = chromium.launch.bind(chromium);
chromium.launch = async function launch(...args) {
  const browser = await originalLaunch(...args);
  const originalNewPage = browser.newPage.bind(browser);
  browser.newPage = async function newPage(...pageArgs) {
    const page = await originalNewPage(...pageArgs);
    const originalEvaluate = page.evaluate.bind(page);
    page.evaluate = async function evaluate(...evaluateArgs) {
      const result = await originalEvaluate(...evaluateArgs);
      if (Array.isArray(result?.results) && result.results.length > 1) {
        const captured = result.results.filter(
          (entry) => typeof entry?.pngBase64 === "string",
        );
        const pngBase64 = captured[0]?.pngBase64;
        if (typeof pngBase64 === "string" && captured.length > 1) {
          for (const entry of captured) entry.pngBase64 = pngBase64;
          writeFileSync(process.env.DUPLICATE_RENDER_MARKER, "injected");
        }
      }
      return result;
    };
    return page;
  };
  return browser;
};
`,
			);
			const outputPaths = [
				"docs/assets/reference-renders/index.json",
				"docs/assets/reference-renders/starter-level-scene.png",
				"docs/assets/reference-renders/starter-object-rock.png",
				"docs/assets/reference-renders/starter-character-pebble-friend.png",
			];
			const previous = await Promise.all(
				outputPaths.map((path) => readFile(join(root, path))),
			);
			await expect(
				execFileAsync(process.execPath, [RENDER_SCRIPT, mode], {
					cwd: root,
					env: {
						...process.env,
						DUPLICATE_RENDER_MARKER: markerPath,
						NODE_OPTIONS: [
							process.env.NODE_OPTIONS,
							`--import=${pathToFileURL(preloadPath).href}`,
						]
							.filter(Boolean)
							.join(" "),
					},
					timeout: 60_000,
				}),
			).rejects.toMatchObject({
				stderr: expect.stringContaining("E_RENDER_REFERENCE_IDENTITY"),
			});
			expect(await readFile(markerPath, "utf8")).toBe("injected");
			await Promise.all(
				outputPaths.map(async (path, index) => {
					expect(await readFile(join(root, path))).toEqual(previous[index]);
				}),
			);
		},
		60_000,
	);

	it("bounds a reference-output read when the same inode grows", async () => {
		const root = await copiedRoot();
		await execFileAsync(process.execPath, [RENDER_SCRIPT, "--generate"], {
			cwd: root,
			timeout: 60_000,
		});
		const targetPath = join(
			root,
			"docs/assets/reference-renders/index.json",
		);
		await expect(
			execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
				cwd: root,
				env: await growingReadEnvironment(root, targetPath),
				timeout: 60_000,
			}),
		).rejects.toMatchObject({
			stderr: expect.stringMatching(
				/missing or stale|changed while reading|grew beyond/u,
			),
		});
		expect((await readFile(targetPath)).at(-1)).toBe(0x21);
	}, 60_000);

	it("serializes concurrent cross-process render checks without lock overlap", async () => {
		const root = await copiedRoot();
		await execFileAsync(process.execPath, [RENDER_SCRIPT, "--generate"], {
			cwd: root,
			timeout: 60_000,
		});
		const reservation = await listenTcpMutex();
		const { port } = reservation;
		await closeTcpMutex(reservation.server);
		const env = {
			...process.env,
			NODE_ENV: "test",
			INFINITE_SNOWBALL_RENDER_LOCK_PORT: String(port),
			INFINITE_SNOWBALL_RENDER_LOCK_POLL_MS: "5",
			INFINITE_SNOWBALL_RENDER_LOCK_WAIT_MS: "60000",
			INFINITE_SNOWBALL_RENDER_LOCK_PROBE: "1",
		};
		try {
			const results = await Promise.all(
				Array.from({ length: 3 }, () =>
					execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
						cwd: root,
						env,
						timeout: 60_000,
					}),
				),
			);
			const intervals = results.map((result) => {
				expect(result.stderr).toBe("");
				expect(result.stdout).toContain(
					"Playwright/Three reference renders verified",
				);
				const probes = result.stdout
					.split("\n")
					.filter((line) => line.startsWith("RENDER_LOCK_PROBE "))
					.map(
						(line) =>
							JSON.parse(line.slice("RENDER_LOCK_PROBE ".length)) as {
								event: string;
								at: string;
							},
					);
				expect(probes.map((probe) => probe.event)).toEqual([
					"acquired",
					"released",
				]);
				return {
					acquired: BigInt(probes[0]?.at ?? "-1"),
					released: BigInt(probes[1]?.at ?? "-1"),
				};
			});
			intervals.sort((left, right) =>
				left.acquired < right.acquired ? -1 : left.acquired > right.acquired ? 1 : 0,
			);
			for (let index = 1; index < intervals.length; index += 1) {
				expect(
					(intervals[index - 1]?.released ?? 0n) <=
						(intervals[index]?.acquired ?? -1n),
				).toBe(true);
			}
		} finally {
			await closeTcpMutex(reservation.server);
		}
	}, 60_000);
	it("holds the global renderer mutex through reference-set publication", async () => {
		const root = await copiedRoot();
		const reservation = await listenTcpMutex();
		const { port } = reservation;
		await closeTcpMutex(reservation.server);
		const env = {
			...process.env,
			NODE_ENV: "test",
			INFINITE_SNOWBALL_RENDER_LOCK_PORT: String(port),
			INFINITE_SNOWBALL_RENDER_LOCK_POLL_MS: "5",
			INFINITE_SNOWBALL_RENDER_LOCK_WAIT_MS: "60000",
			INFINITE_SNOWBALL_RENDER_LOCK_PROBE: "1",
			INFINITE_SNOWBALL_RENDER_PUBLICATION_PAUSE_MS: "100",
		};
		try {
			const results = await Promise.all(
				Array.from({ length: 2 }, () =>
					execFileAsync(process.execPath, [RENDER_SCRIPT, "--generate"], {
						cwd: root,
						env,
						timeout: 60_000,
					}),
				),
			);
			const intervals = results.map((result) => {
				const probes = result.stdout
					.split("\n")
					.filter((line) => line.startsWith("RENDER_LOCK_PROBE "))
					.map(
						(line) =>
							JSON.parse(line.slice("RENDER_LOCK_PROBE ".length)) as {
								event: string;
								at: string;
							},
					);
				expect(probes.map((probe) => probe.event)).toEqual([
					"acquired",
					"publication-start",
					"publication-end",
					"released",
				]);
				return Object.fromEntries(
					probes.map((probe) => [probe.event, BigInt(probe.at)]),
				) as Record<string, bigint>;
			});
			intervals.sort((left, right) =>
				left.acquired! < right.acquired!
					? -1
					: left.acquired! > right.acquired!
						? 1
						: 0,
			);
			expect(intervals[0]!["publication-end"]!).toBeLessThanOrEqual(
				intervals[0]!.released!,
			);
			expect(intervals[0]!.released!).toBeLessThanOrEqual(
				intervals[1]!.acquired!,
			);
		} finally {
			await closeTcpMutex(reservation.server);
		}
	}, 60_000);

});

describe("P03 renderer TCP mutex", () => {
	const mutexEnvironment = (
		port: number | string,
		waitMilliseconds = "100",
	): NodeJS.ProcessEnv => ({
		...process.env,
		NODE_ENV: "test",
		INFINITE_SNOWBALL_RENDER_LOCK_PORT: String(port),
		INFINITE_SNOWBALL_RENDER_LOCK_POLL_MS: "5",
		INFINITE_SNOWBALL_RENDER_LOCK_WAIT_MS: waitMilliseconds,
	});

	it("times out while a live process holds the renderer TCP mutex", async () => {
		const holder = await listenTcpMutex();
		try {
			await expect(
				execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
					cwd: ROOT,
					env: mutexEnvironment(holder.port),
					timeout: 5_000,
				}),
			).rejects.toMatchObject({
				stderr: expect.stringContaining("E_RENDER_LOCK_TIMEOUT"),
			});
		} finally {
			await closeTcpMutex(holder.server);
		}
	});

	it("acquires the renderer TCP mutex after a crashed holder is released", async () => {
		const reservation = await listenTcpMutex();
		const { port } = reservation;
		await closeTcpMutex(reservation.server);
		const temporaryRoot = await mkdtemp(
			join(tmpdir(), "snowball-render-crashed-mutex-"),
		);
		temporaryRoots.push(temporaryRoot);
		const holderScript = join(temporaryRoot, "tcp-mutex-holder.mjs");
		await writeFile(
			holderScript,
			`import { createServer } from "node:net";
const server = createServer();
server.listen(
  { host: "127.0.0.1", port: Number(process.env.RENDER_MUTEX_PORT) },
  () => process.stdout.write("READY\\n"),
);
`,
		);
		const holder = spawn(process.execPath, [holderScript], {
			env: { ...process.env, RENDER_MUTEX_PORT: String(port) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const exitPromise = once(holder, "exit");
		try {
			await Promise.race([
				once(holder.stdout, "data"),
				exitPromise.then(() => {
					throw new Error("TCP mutex holder exited before readiness.");
				}),
			]);
			await expect(
				execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
					cwd: ROOT,
					env: mutexEnvironment(port),
					timeout: 5_000,
				}),
			).rejects.toMatchObject({
				stderr: expect.stringContaining("E_RENDER_LOCK_TIMEOUT"),
			});
			holder.kill("SIGKILL");
			await exitPromise;
			const result = await execFileAsync(
				process.execPath,
				[RENDER_SCRIPT, "--check"],
				{
					cwd: ROOT,
					env: mutexEnvironment(port, "60000"),
					timeout: 60_000,
				},
			);
			expect(result.stdout).toContain(
				"Playwright/Three reference renders verified",
			);
		} finally {
			if (holder.exitCode === null && holder.signalCode === null) {
				holder.kill("SIGKILL");
				await exitPromise;
			}
		}
	}, 60_000);

	it.each(["0", "1023", "65536", "not-a-port"])(
		"rejects invalid renderer TCP mutex port override %s",
		async (port) => {
			await expect(
				execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
					cwd: ROOT,
					env: mutexEnvironment(port),
					timeout: 5_000,
				}),
			).rejects.toMatchObject({
				stderr: expect.stringContaining("E_RENDER_LOCK_CONFIG"),
			});
		},
	);
});

describe("P03 render request integrity", () => {
	it("serves verified GLBs with explicit byte framing", async () => {
		const temporaryRoot = await mkdtemp(
			join(tmpdir(), "snowball-render-content-length-"),
		);
		temporaryRoots.push(temporaryRoot);
		const preloadPath = join(temporaryRoot, "require-glb-content-length.mjs");
		await writeFile(
			preloadPath,
			`import http from "node:http";
import { syncBuiltinESMExports } from "node:module";

const originalCreateServer = http.createServer;
http.createServer = function createServer(listener) {
  return originalCreateServer.call(this, (request, response) => {
    const originalWriteHead = response.writeHead;
    response.writeHead = function writeHead(statusCode, ...args) {
      const headers = args.find(
        (value) => value !== null && typeof value === "object" && !Array.isArray(value),
      );
      const contentLength =
        response.getHeader("Content-Length") ??
        headers?.["Content-Length"] ??
        headers?.["content-length"];
      if (
        statusCode === 200 &&
        request.url?.endsWith(".glb") &&
        contentLength === undefined
      ) {
        return originalWriteHead.call(this, 503, {
          "Content-Type": "text/plain; charset=utf-8",
        });
      }
      return originalWriteHead.call(this, statusCode, ...args);
    };
    return listener(request, response);
  });
};
syncBuiltinESMExports();
`,
		);
		const result = await execFileAsync(
			process.execPath,
			[RENDER_SCRIPT, "--check"],
			{
				cwd: ROOT,
				env: {
					...process.env,
					NODE_OPTIONS: [
						process.env.NODE_OPTIONS,
						`--import=${pathToFileURL(preloadPath).href}`,
					]
						.filter(Boolean)
						.join(" "),
				},
				timeout: 60_000,
			},
		);
		expect(result.stdout).toContain(
			"Playwright/Three reference renders verified",
		);
	}, 60_000);

	it("correlates a CDP post-success cancellation with its completed GLB transfer", async () => {
		const temporaryRoot = await mkdtemp(
			join(tmpdir(), "snowball-render-complete-abort-"),
		);
		temporaryRoots.push(temporaryRoot);
		const preloadPath = join(temporaryRoot, "complete-glb-abort.mjs");
		const markerPath = join(temporaryRoot, "injected.txt");
		const playwrightEntry = pathToFileURL(
			join(ROOT, "node_modules", "@playwright", "test", "index.mjs"),
		).href;
		await writeFile(
			preloadPath,
			`import { writeFileSync } from "node:fs";
import { chromium } from ${JSON.stringify(playwrightEntry)};

const originalLaunch = chromium.launch.bind(chromium);
chromium.launch = async function launch(...args) {
  const browser = await originalLaunch(...args);
  const originalNewPage = browser.newPage.bind(browser);
  browser.newPage = async function newPage(...pageArgs) {
    const page = await originalNewPage(...pageArgs);
    const originalOn = page.on.bind(page);
    let injected = false;
    let requestFailedListener;
    page.on = function on(event, listener) {
      const result = originalOn(event, listener);
      if (event === "requestfailed") {
        requestFailedListener = listener;
        originalOn("requestfinished", (request) => {
          if (!injected && request.url().endsWith(".glb")) {
            injected = true;
            queueMicrotask(() => {
              writeFileSync(process.env.COMPLETE_ABORT_MARKER, "injected");
              Object.defineProperty(request, "failure", {
                configurable: true,
                value: () => ({ errorText: "net::ERR_ABORTED" }),
              });
              requestFailedListener(request);
            });
          }
        });
      }
      return result;
    };
    return page;
  };
  return browser;
};
`,
		);
		const result = await execFileAsync(
			process.execPath,
			[RENDER_SCRIPT, "--check"],
			{
				cwd: ROOT,
				env: {
					...process.env,
					COMPLETE_ABORT_MARKER: markerPath,
					NODE_OPTIONS: [
						process.env.NODE_OPTIONS,
						`--import=${pathToFileURL(preloadPath).href}`,
					]
						.filter(Boolean)
						.join(" "),
				},
				timeout: 60_000,
			},
		);
		expect(result.stdout).toContain(
			"Playwright/Three reference renders verified",
		);
		expect(await readFile(markerPath, "utf8")).toBe("injected");
	}, 60_000);

	it("does not suppress an exact-URL abort observed before response finish", async () => {
		const temporaryRoot = await mkdtemp(
			join(tmpdir(), "snowball-render-pre-success-abort-"),
		);
		temporaryRoots.push(temporaryRoot);
		const preloadPath = join(temporaryRoot, "pre-success-glb-abort.mjs");
		const markerPath = join(temporaryRoot, "injected.txt");
		const playwrightEntry = pathToFileURL(
			join(ROOT, "node_modules", "@playwright", "test", "index.mjs"),
		).href;
		await writeFile(
			preloadPath,
			`import { writeFileSync } from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { chromium } from ${JSON.stringify(playwrightEntry)};

let injected = false;
let requestFailedListener;
const originalCreateServer = http.createServer;
http.createServer = function createServer(listener) {
  return originalCreateServer.call(this, (request, response) => {
    if (
      !injected &&
      requestFailedListener !== undefined &&
      request.url?.endsWith(".glb")
    ) {
      injected = true;
      const url = \`http://\${request.headers.host}\${request.url}\`;
      writeFileSync(process.env.PRE_SUCCESS_ABORT_MARKER, "injected");
      requestFailedListener({
        url: () => url,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      });
    }
    return listener(request, response);
  });
};
syncBuiltinESMExports();

const originalLaunch = chromium.launch.bind(chromium);
chromium.launch = async function launch(...args) {
  const browser = await originalLaunch(...args);
  const originalNewPage = browser.newPage.bind(browser);
  browser.newPage = async function newPage(...pageArgs) {
    const page = await originalNewPage(...pageArgs);
    const originalOn = page.on.bind(page);
    page.on = function on(event, listener) {
      const result = originalOn(event, listener);
      if (event === "requestfailed") requestFailedListener = listener;
      return result;
    };
    return page;
  };
  return browser;
};
`,
		);
		await expect(
			execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
				cwd: ROOT,
				env: {
					...process.env,
					PRE_SUCCESS_ABORT_MARKER: markerPath,
					NODE_OPTIONS: [
						process.env.NODE_OPTIONS,
						`--import=${pathToFileURL(preloadPath).href}`,
					]
						.filter(Boolean)
						.join(" "),
				},
				timeout: 60_000,
			}),
		).rejects.toMatchObject({
			stderr: expect.stringMatching(
				/requestfailed: .*\.glb net::ERR_ABORTED/u,
			),
		});
		expect(await readFile(markerPath, "utf8")).toBe("injected");
	}, 60_000);

	it("fails a distinct same-URL aborted request after a completed transfer", async () => {
		const temporaryRoot = await mkdtemp(
			join(tmpdir(), "snowball-render-distinct-abort-"),
		);
		temporaryRoots.push(temporaryRoot);
		const preloadPath = join(temporaryRoot, "distinct-glb-abort.mjs");
		const markerPath = join(temporaryRoot, "injected.txt");
		const playwrightEntry = pathToFileURL(
			join(ROOT, "node_modules", "@playwright", "test", "index.mjs"),
		).href;
		await writeFile(
			preloadPath,
			`import { writeFileSync } from "node:fs";
import { chromium } from ${JSON.stringify(playwrightEntry)};

const originalLaunch = chromium.launch.bind(chromium);
chromium.launch = async function launch(...args) {
  const browser = await originalLaunch(...args);
  const originalNewPage = browser.newPage.bind(browser);
  browser.newPage = async function newPage(...pageArgs) {
    const page = await originalNewPage(...pageArgs);
    const originalOn = page.on.bind(page);
    let injected = false;
    let requestFailedListener;
    page.on = function on(event, listener) {
      const result = originalOn(event, listener);
      if (event === "requestfailed") {
        requestFailedListener = listener;
        originalOn("requestfinished", (request) => {
          if (!injected && request.url().endsWith(".glb")) {
            injected = true;
            queueMicrotask(() => {
              writeFileSync(process.env.DISTINCT_ABORT_MARKER, "injected");
              requestFailedListener({
                url: () => request.url(),
                failure: () => ({ errorText: "net::ERR_ABORTED" }),
              });
            });
          }
        });
      }
      return result;
    };
    return page;
  };
  return browser;
};
`,
		);
		await expect(
			execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
				cwd: ROOT,
				env: {
					...process.env,
					DISTINCT_ABORT_MARKER: markerPath,
					NODE_OPTIONS: [
						process.env.NODE_OPTIONS,
						`--import=${pathToFileURL(preloadPath).href}`,
					]
						.filter(Boolean)
						.join(" "),
				},
				timeout: 60_000,
			}),
		).rejects.toMatchObject({
			stderr: expect.stringMatching(
				/requestfailed: .*\.glb net::ERR_ABORTED/u,
			),
		});
		expect(await readFile(markerPath, "utf8")).toBe("injected");
	}, 60_000);

	it("does not correlate a query-alias abort with a completed GLB transfer", async () => {
		const temporaryRoot = await mkdtemp(
			join(tmpdir(), "snowball-render-query-abort-"),
		);
		temporaryRoots.push(temporaryRoot);
		const preloadPath = join(temporaryRoot, "query-glb-abort.mjs");
		const markerPath = join(temporaryRoot, "injected.txt");
		const playwrightEntry = pathToFileURL(
			join(ROOT, "node_modules", "@playwright", "test", "index.mjs"),
		).href;
		await writeFile(
			preloadPath,
			`import { writeFileSync } from "node:fs";
import { chromium } from ${JSON.stringify(playwrightEntry)};

const originalLaunch = chromium.launch.bind(chromium);
chromium.launch = async function launch(...args) {
  const browser = await originalLaunch(...args);
  const originalNewPage = browser.newPage.bind(browser);
  browser.newPage = async function newPage(...pageArgs) {
    const page = await originalNewPage(...pageArgs);
    const originalOn = page.on.bind(page);
    let injected = false;
    let requestFailedListener;
    page.on = function on(event, listener) {
      const result = originalOn(event, listener);
      if (event === "requestfailed") {
        requestFailedListener = listener;
        originalOn("requestfinished", (request) => {
          if (!injected && request.url().endsWith(".glb")) {
            injected = true;
            queueMicrotask(() => {
              writeFileSync(process.env.QUERY_ABORT_MARKER, "injected");
              requestFailedListener({
                url: () => \`\${request.url()}?alias=1\`,
                failure: () => ({ errorText: "net::ERR_ABORTED" }),
              });
            });
          }
        });
      }
      return result;
    };
    return page;
  };
  return browser;
};
`,
		);
		await expect(
			execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
				cwd: ROOT,
				env: {
					...process.env,
					QUERY_ABORT_MARKER: markerPath,
					NODE_OPTIONS: [
						process.env.NODE_OPTIONS,
						`--import=${pathToFileURL(preloadPath).href}`,
					]
						.filter(Boolean)
						.join(" "),
				},
				timeout: 60_000,
			}),
		).rejects.toMatchObject({
			stderr: expect.stringMatching(
				/requestfailed: .*\?alias=1 net::ERR_ABORTED/u,
			),
		});
		expect(await readFile(markerPath, "utf8")).toBe("injected");
	}, 60_000);

	it("rejects query aliases for verified GLB routes", async () => {
		const temporaryRoot = await mkdtemp(
			join(tmpdir(), "snowball-render-query-route-"),
		);
		temporaryRoots.push(temporaryRoot);
		const preloadPath = join(temporaryRoot, "query-glb-route.mjs");
		const markerPath = join(temporaryRoot, "query-status.txt");
		const playwrightEntry = pathToFileURL(
			join(ROOT, "node_modules", "@playwright", "test", "index.mjs"),
		).href;
		await writeFile(
			preloadPath,
			`import { writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { chromium } from ${JSON.stringify(playwrightEntry)};

const originalLaunch = chromium.launch.bind(chromium);
chromium.launch = async function launch(...args) {
  const browser = await originalLaunch(...args);
  const originalNewPage = browser.newPage.bind(browser);
  browser.newPage = async function newPage(...pageArgs) {
    const page = await originalNewPage(...pageArgs);
    const originalEvaluate = page.evaluate.bind(page);
    let checked = false;
    page.evaluate = async function evaluate(pageFunction, ...evaluateArgs) {
      const value = await originalEvaluate(pageFunction, ...evaluateArgs);
      const verifiedUrl = value?.results?.[0]?.url;
      if (!checked && typeof verifiedUrl === "string") {
        checked = true;
        const status = await originalEvaluate(async (url) => {
          const response = await fetch(\`\${url}?alias=1\`);
          return response.status;
        }, verifiedUrl);
        const canonicalUrl = new URL(verifiedUrl, page.url());
        const bareStatus = await new Promise((resolveStatus, rejectStatus) => {
          const request = httpRequest(
            {
              hostname: canonicalUrl.hostname,
              port: canonicalUrl.port,
              path: \`\${canonicalUrl.pathname}?\`,
            },
            (response) => {
              response.resume();
              response.once("end", () => resolveStatus(response.statusCode));
            },
          );
          request.once("error", rejectStatus);
          request.end();
        });
        writeFileSync(
          process.env.QUERY_ROUTE_MARKER,
          JSON.stringify([status, bareStatus]),
        );
      }
      return value;
    };
    return page;
  };
  return browser;
};
`,
		);
		await expect(
			execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
				cwd: ROOT,
				env: {
					...process.env,
					QUERY_ROUTE_MARKER: markerPath,
					NODE_OPTIONS: [
						process.env.NODE_OPTIONS,
						`--import=${pathToFileURL(preloadPath).href}`,
					]
						.filter(Boolean)
						.join(" "),
				},
				timeout: 60_000,
			}),
		).rejects.toMatchObject({
			stderr: expect.stringContaining(
				"server responded with a status of 400",
			),
		});
		expect(await readFile(markerPath, "utf8")).toBe("[400,400]");
	}, 60_000);

	it("returns HTTP 400 for malformed percent-encoded local module paths", async () => {
		const root = await copiedRoot();
		const { env, markerPath } = await malformedRendererRequestEnvironment(root);
		await execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
			cwd: root,
			env,
			timeout: 60_000,
		});
		expect(await readFile(markerPath, "utf8")).toBe("400");
	}, 60_000);

	it("fails when an asset request fails before a successful retry", async () => {
		const temporaryRoot = await mkdtemp(
			join(tmpdir(), "snowball-render-request-failure-"),
		);
		temporaryRoots.push(temporaryRoot);
		const preloadPath = join(temporaryRoot, "fail-first-glb-request.mjs");
		await writeFile(
			preloadPath,
			`import http from "node:http";
import { syncBuiltinESMExports } from "node:module";

const originalCreateServer = http.createServer;
let failed = false;
http.createServer = function createServer(listener) {
  return originalCreateServer.call(this, (request, response) => {
    if (!failed && request.url?.endsWith(".glb")) {
      failed = true;
      response.writeHead(503).end("transient request failure");
      return;
    }
    return listener(request, response);
  });
};
syncBuiltinESMExports();
`,
		);
		const nodeOptions = [
			process.env.NODE_OPTIONS,
			`--import=${pathToFileURL(preloadPath).href}`,
		]
			.filter(Boolean)
			.join(" ");
		await expect(
			execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
				cwd: ROOT,
				timeout: 60_000,
				env: { ...process.env, NODE_OPTIONS: nodeOptions },
			}),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("requestfailed:"),
		});
	}, 60_000);
});

describe("P03 reference-render filesystem boundaries", () => {
	it("rejects a GLB reached through a symlinked package subdirectory", async () => {
		const root = await copiedRoot();
		await execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
			cwd: root,
			timeout: 60_000,
		});
		await rename(
			join(root, "content/starter-level/assets"),
			join(root, "level-assets-outside"),
		);
		await symlink(
			"../../level-assets-outside",
			join(root, "content/starter-level/assets"),
			"dir",
		);
		await expect(
			execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
				cwd: root,
				timeout: 60_000,
			}),
		).rejects.toMatchObject({
			stderr: expect.stringMatching(/canonical package|symlink/u),
		});
	});

	it("refuses to follow an expected render-output symlink", async () => {
		const root = await copiedRoot();
		await execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
			cwd: root,
			timeout: 60_000,
		});
		const renderPath = join(
			root,
			"docs/assets/reference-renders/starter-level-scene.png",
		);
		await rename(renderPath, join(root, "render-outside.png"));
		await symlink("../../../render-outside.png", renderPath);
		await expect(
			execFileAsync(process.execPath, [RENDER_SCRIPT, "--generate"], {
				cwd: root,
				timeout: 60_000,
			}),
		).rejects.toMatchObject({
			stderr: expect.stringMatching(/regular file|symlink/u),
		});
	});

	it("refuses a symlinked reference-render output directory", async () => {
		const root = await copiedRoot();
		await execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
			cwd: root,
			timeout: 60_000,
		});
		const renderDirectory = join(root, "docs/assets/reference-renders");
		await rename(renderDirectory, join(root, "renders-outside"));
		await symlink("../../renders-outside", renderDirectory, "dir");
		await expect(
			execFileAsync(process.execPath, [RENDER_SCRIPT, "--generate"], {
				cwd: root,
				timeout: 60_000,
			}),
		).rejects.toMatchObject({
			stderr: expect.stringMatching(/canonical project root|symlink/u),
		});
	});

	it("rejects parent traversal in a manifest GLB path before reading it", async () => {
		const root = await copiedRoot();
		const manifestPath = "content/starter-level/manifest.json";
		const manifest = await json<{
			assets: Array<{ assetId: string; path: string }>;
		}>(root, manifestPath);
		const arena = manifest.assets.find((asset) => asset.assetId === "arena");
		expect(arena).toBeDefined();
		await cp(
			join(root, "content/starter-level", arena!.path),
			join(root, "outside.glb"),
		);
		arena!.path = "../../outside.glb";
		await writeFile(
			join(root, manifestPath),
			`${JSON.stringify(manifest, null, 2)}\n`,
		);
		await expect(
			execFileAsync(process.execPath, [RENDER_SCRIPT, "--check"], {
				cwd: root,
				timeout: 60_000,
			}),
		).rejects.toMatchObject({
			stderr: expect.stringMatching(
				/non-canonical|package-relative|escapes its package/u,
			),
		});
	});
	it("caps reference-directory entries before deleting unexpected outputs", async () => {
		const root = await copiedRoot();
		const renderDirectory = join(root, "docs/assets/reference-renders");
		const junkNames = Array.from(
			{ length: 40 },
			(_, index) => `unexpected-${String(index).padStart(2, "0")}.txt`,
		);
		await Promise.all(
			junkNames.map((name) => writeFile(join(renderDirectory, name), "junk")),
		);
		await expect(
			execFileAsync(process.execPath, [RENDER_SCRIPT, "--generate"], {
				cwd: root,
				timeout: 60_000,
			}),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("E_RENDER_REFERENCE_SET"),
		});
		const remaining = new Set(await readdir(renderDirectory));
		expect(junkNames.every((name) => remaining.has(name))).toBe(true);
	}, 60_000);

});

describe("P03 bounded evidence inventory", () => {
	it("rejects too many evidence entries before hashing them", async () => {
		const root = await copiedRoot();
		const directory = join(root, "docs/brand");
		await Promise.all(
			Array.from({ length: 257 }, (_, index) =>
				writeFile(join(directory, `overflow-${index}.txt`), "x"),
			),
		);
		await expect(runHandoffCheck(root)).rejects.toMatchObject({
			stderr: expect.stringContaining("E_FILE_BUDGET"),
		});
	});

	it("rejects evidence deeper than the inventory bound", async () => {
		const root = await copiedRoot();
		const directory = join(
			root,
			"docs/brand",
			...Array.from({ length: 9 }, (_, index) => `depth-${index}`),
		);
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "deep.txt"), "deep");
		await expect(runHandoffCheck(root)).rejects.toMatchObject({
			stderr: expect.stringContaining("E_FILE_BUDGET"),
		});
	});

	it("rejects oversized evidence before reading it", async () => {
		const root = await copiedRoot();
		await writeFile(
			join(root, "docs/brand/oversized.bin"),
			Buffer.alloc(16 * 1024 * 1024 + 1),
		);
		await expect(runHandoffCheck(root)).rejects.toMatchObject({
			stderr: expect.stringContaining("E_FILE_BUDGET"),
		});
	});

	it("rejects symlinked evidence during bounded inventory", async () => {
		const root = await copiedRoot();
		const outside = join(root, "outside-evidence.txt");
		await writeFile(outside, "outside");
		await symlink(outside, join(root, "docs/brand/symlinked.txt"));
		await expect(runHandoffCheck(root)).rejects.toMatchObject({
			stderr: expect.stringContaining("E_PATH_POLICY"),
		});
	});
});

describe("P03 evidence-complete handoff", () => {
	it("includes P10 and a sorted, byte-accurate evidence inventory", async () => {
		const handoff = await json<{
			consumers: string[];
			evidence: { inventory: EvidenceEntry[] };
		}>(ROOT, "docs/assets/p03-content-handoff.json");
		expect(handoff.consumers).toContain("P10");

		const inventory = handoff.evidence.inventory;
		expect(inventory.map((entry) => entry.path)).toEqual(
			inventory.map((entry) => entry.path).sort(),
		);
		expect(new Set(inventory.map((entry) => entry.path)).size).toBe(
			inventory.length,

		);
		for (const entry of inventory) {
			expect(entry.sha256).toBe(sha256(await readFile(join(ROOT, entry.path))));
			const bytes = await readFile(join(ROOT, entry.path));
			expect(entry.bytes).toBe(bytes.length);
		}

		const categories = new Set(inventory.map((entry) => entry.category));
		for (const category of [
			"asset-budget",
			"brand-review",
			"captured-license",
			"human-ledger",
			"local-audio-policy",
			"machine-provenance",
			"provenance-policy",
			"music-policy",
			"reference-render",
			"render-metadata",
			"withdrawal-registry",
			"source-evidence",
			"withdrawal-policy",
		]) {
			expect(categories.has(category), category).toBe(true);
		}
	});

	it("projects the validated nonempty local-audio boundary summary", async () => {
		const root = await generatedHandoffRoot();
		const fixture = await json<unknown>(
			root,
			LOCAL_AUDIO_FIXTURE_RELATIVE_PATH,
		);
		const expected = validateLocalAudioFixture(fixture);
		const handoff = await json<{
			evidence: { localAudioBoundary: Record<string, unknown> };
		}>(root, "docs/assets/p03-content-handoff.json");
		expect(handoff.evidence.localAudioBoundary).toEqual({
			path: LOCAL_AUDIO_FIXTURE_RELATIVE_PATH,
			...expected,
		});
		expect(expected.safeFlows).toBeGreaterThan(0);
		expect(expected.blockedFlows).toBeGreaterThan(0);
		expect(expected.malformedSets).toBeGreaterThan(0);
	});

	it("refuses to regenerate over empty local-audio fixture case arrays", async () => {
		const root = await generatedHandoffRoot();
		const handoffPath = join(root, "docs/assets/p03-content-handoff.json");
		const previous = await readFile(handoffPath);
		const fixturePath = join(root, LOCAL_AUDIO_FIXTURE_RELATIVE_PATH);
		const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<
			string,
			unknown
		>;
		for (const key of [
			"safe",
			"forbidden",
			"nonArrays",
			"collidingOpaqueIds",
			"derivedOpaqueIds",
			"malformedPrivateValues",
		])
			fixture[key] = [];
		await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
		await expectHandoffGenerationFailurePreserves(root, previous);
	});

	it("projects deterministic validated license-evidence identities for every asset", async () => {
		const root = await generatedHandoffRoot();
		const handoff = await json<{
			packages: Array<{ name: string; manifestPath: string }>;
			evidence: { licenseEvidence: Array<Record<string, unknown>> };
		}>(root, "docs/assets/p03-content-handoff.json");
		const expected: Array<Record<string, unknown>> = [];
		for (const pkg of handoff.packages) {
			const manifest = await json<{
				assets: Array<{ assetId: string }>;
			}>(root, pkg.manifestPath);
			for (const asset of manifest.assets) {
				const resolution = await resolveRetainedLicenseEvidence(root, asset);
				expected.push({
					packageName: pkg.name,
					assetId: asset.assetId,
					kind: resolution.kind,
					provider: resolution.provider,
					sourceUrl: resolution.sourceUrl,
					sourceArtifact: resolution.sourceArtifact,
					spdx: resolution.spdx,
					url: resolution.url,
					textPath: resolution.textPath,
					textSha256: resolution.textSha256,
				});
			}
		}
		expected.sort((left, right) => {
			const leftKey = `${String(left.packageName)}\0${String(left.assetId)}`;
			const rightKey = `${String(right.packageName)}\0${String(right.assetId)}`;
			return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
		});
		expect(handoff.evidence.licenseEvidence).toEqual(expected);
		expect(new Set(expected.map((entry) => entry.kind))).toEqual(
			new Set(["project-original", "retained"]),
		);
	});

	it("projects the canonical simulation-only withdrawal boundary", async () => {
		const root = await generatedHandoffRoot();
		const withdrawal = await json<{
			recordId: string;
			simulationOnly: true;
			allowNewInstalls: false;
			package: Record<string, string>;
			replacement: { package: Record<string, string> };
		}>(
			root,
			"docs/licenses/withdrawals/starter-rock-simulated.json",
		);
		const handoff = await json<{
			evidence: { withdrawalBoundary: Record<string, unknown> };
		}>(root, "docs/assets/p03-content-handoff.json");
		expect(handoff.evidence.withdrawalBoundary).toEqual({
			simulationOnly: true,
			allowNewInstalls: false,
			package: withdrawal.package,
			replacement: withdrawal.replacement.package,
			recordId: withdrawal.recordId,
		});
	});

	it("inventories the exact reviewed retained-source evidence bundle", async () => {
		const root = await generatedHandoffRoot();
		const handoff = await json<{
			evidence: { inventory: EvidenceEntry[] };
		}>(root, "docs/assets/p03-content-handoff.json");
		const retained = handoff.evidence.inventory.filter(
			(entry) => entry.category === "source-evidence",
		);
		expect(retained.map((entry) => entry.path)).toEqual(
			[...SOURCE_EVIDENCE_PATHS].sort(),
		);
		for (const entry of retained) {
			const bytes = await readFile(join(root, entry.path));
			expect(entry.bytes).toBe(bytes.length);
			expect(entry.sha256).toBe(sha256(bytes));
		}
	});

	it("refuses to regenerate over junk retained-source bundle members", async () => {
		const root = await generatedHandoffRoot();
		const handoffPath = join(root, "docs/assets/p03-content-handoff.json");
		for (const evidencePath of SOURCE_EVIDENCE_PATHS) {
			const absolutePath = join(root, evidencePath);
			const original = await readFile(absolutePath);
			const previous = await readFile(handoffPath);
			await writeFile(
				absolutePath,
				Buffer.concat([original, Buffer.from("\nsemantic junk")]),
			);
			await expectHandoffGenerationFailurePreserves(root, previous);
			await writeFile(absolutePath, original);
		}
	}, 60_000);

	it("refuses to regenerate over a non-simulation withdrawal marker", async () => {
		const root = await generatedHandoffRoot();
		const handoffPath = join(root, "docs/assets/p03-content-handoff.json");
		const previous = await readFile(handoffPath);
		const withdrawalPath = join(
			root,
			"docs/licenses/withdrawals/starter-rock-simulated.json",
		);
		const withdrawal = JSON.parse(await readFile(withdrawalPath, "utf8")) as {
			simulationOnly: boolean;
		};
		withdrawal.simulationOnly = false;
		await writeFile(withdrawalPath, `${JSON.stringify(withdrawal, null, 2)}\n`);
		await expectHandoffGenerationFailurePreserves(root, previous);
	});

	it("fails closed when retained-source evidence mutates or disappears", async () => {
		const root = await generatedHandoffRoot();
		for (const evidencePath of SOURCE_EVIDENCE_PATHS) {
			const absolutePath = join(root, evidencePath);
			const original = await readFile(absolutePath);
			await writeFile(
				absolutePath,
				Buffer.concat([original, Buffer.from("\nmutation")]),
			);
			await expect(runHandoffCheck(root), `${evidencePath}:mutation`).rejects.toThrow();
			await writeFile(absolutePath, original);
			await runHandoffCheck(root);

			await unlink(absolutePath);
			await expect(runHandoffCheck(root), `${evidencePath}:removal`).rejects.toThrow();
			await writeFile(absolutePath, original);
			await runHandoffCheck(root);
		}
	}, 60_000);

	it("rejects extra or symlinked retained-source evidence", async () => {
		const root = await generatedHandoffRoot();
		const extraPath = join(root, SOURCE_EVIDENCE_DIRECTORY, "unexpected.glb");
		await writeFile(extraPath, "unexpected retained source");
		await expect(runHandoffCheck(root)).rejects.toThrow();
		await unlink(extraPath);
		await runHandoffCheck(root);

		const licensePath = join(root, SOURCE_EVIDENCE_PATHS[0]);
		const outsidePath = join(root, "retained-license-outside.txt");
		await rename(licensePath, outsidePath);
		await symlink(outsidePath, licensePath);
		await expect(runHandoffCheck(root)).rejects.toThrow();
	});

	it("bounds a retained-source read when the same inode grows", async () => {
		const root = await generatedHandoffRoot();
		const targetPath = join(root, SOURCE_EVIDENCE_PATHS[0]);
		await expect(
			runHandoffCheck(
				root,
				await growingReadEnvironment(root, targetPath),
			),
		).rejects.toMatchObject({
			stderr: expect.stringMatching(/changed while reading|grew beyond/u),
		});
		expect((await readFile(targetPath)).at(-1)).toBe(0x21);
	});

	it("preserves every authored object gameplay and LOD hint exactly", async () => {
		const root = await generatedHandoffRoot();
		const manifest = await json<{
			entries: Array<{ objects: AuthoredObjectHint[] }>;
		}>(root, "content/starter-objects/manifest.json");
		const handoff = await json<{
			runtimeHints: { objects: ObjectRuntimeHint[] };
		}>(root, "docs/assets/p03-content-handoff.json");
		const authored = manifest.entries.flatMap((entry) => entry.objects);
		expect(handoff.runtimeHints.objects).toEqual(
			authored.map((object) => ({
				...object,
				sizeClass: object.objectId === "goal-stone" ? "goal" : "small",
			})),
		);
		expect(
			handoff.runtimeHints.objects.find(
				(object) => object.objectId === "starter-rock",
			),
		).toEqual({
			objectId: "starter-rock",
			radius: 0.35,
			volume: 0.18,
			points: 25,
			category: "stone",
			colliderAssetId: "collider",
			renderAssetId: "render",
			attachPolicy: "surface",
			material: { roughness: 0.7, metalness: 0 },
			lodAssetIds: [],
			budgets: { maxTriangles: 16, maxBytes: 3044 },
			sizeClass: "small",
		});
	});

	it("derives nested object hints from a valid copied manifest mutation", async () => {
		const root = await copiedRoot();
		const manifestPath = "content/starter-objects/manifest.json";
		const manifest = await json<{
			entries: Array<{ objects: AuthoredObjectHint[] }>;
		}>(root, manifestPath);
		const authored = manifest.entries
			.flatMap((entry) => entry.objects)
			.find((object) => object.objectId === "starter-rock");
		expect(authored).toBeDefined();
		Object.assign(authored!, {
			points: 137,
			category: "bonus-stone",
			attachPolicy: "center",
			material: { roughness: 0.25, metalness: 0.5 },
			lodAssetIds: ["render"],
			budgets: { maxTriangles: 32, maxBytes: 4096 },
		});
		await writeFile(
			join(root, manifestPath),
			`${JSON.stringify(manifest, null, 2)}\n`,
		);
		const contentRoot = join(root, "content");
		const objectInspection = await inspectStarterPackages({
			root,
			contentRoot,
		});
		const objectPackage = objectInspection.packages.find(
			(pkg) => pkg.packageName === "starter-objects",
		);
		expect(objectPackage).toBeDefined();
		await refreshSimulatedWithdrawalIdentity(root, objectPackage!);
		const objectRef = { ...objectPackage!.ref } as MutablePackageRef;

		const levelPath = "content/starter-level/manifest.json";
		const levelManifest = await json<unknown>(root, levelPath);
		expect(replacePackageReferences(levelManifest, objectRef)).toBeGreaterThan(0);
		await writeFile(
			join(root, levelPath),
			`${JSON.stringify(levelManifest, null, 2)}\n`,
		);
		const levelInspection = await inspectStarterPackages({
			root,
			contentRoot,
		});
		const levelPackage = levelInspection.packages.find(
			(pkg) => pkg.packageName === "starter-level",
		);
		expect(levelPackage).toBeDefined();
		const levelRef = { ...levelPackage!.ref } as MutablePackageRef;

		const campaignPath = "content/starter-campaign/manifest.json";
		const campaignManifest = await json<unknown>(root, campaignPath);
		expect(
			replacePackageReferences(campaignManifest, objectRef),
		).toBeGreaterThan(0);
		expect(
			replacePackageReferences(campaignManifest, levelRef),
		).toBeGreaterThan(0);
		await writeFile(
			join(root, campaignPath),
			`${JSON.stringify(campaignManifest, null, 2)}\n`,
		);
		await execFileAsync(process.execPath, [RENDER_SCRIPT, "--generate"], {
			cwd: root,
			timeout: 60_000,
		});
		await execFileAsync(process.execPath, [HANDOFF_SCRIPT], {
			cwd: root,
			timeout: 60_000,
		});
		const handoff = await json<{
			runtimeHints: { objects: ObjectRuntimeHint[] };
		}>(root, "docs/assets/p03-content-handoff.json");
		expect(
			handoff.runtimeHints.objects.find(
				(object) => object.objectId === "starter-rock",
			),
		).toEqual({
			...authored,
			sizeClass: "small",
		});
	});

	it.each([
		"asset SHA-256",
		"verified URL",
		"PNG SHA-256",
		"undeclared representative reuse",
		"frozen source mapping",
	])(
		"rejects invalid cross-kind reference %s evidence before handoff publication",
		async (duplicateKind) => {
			const root = await generatedHandoffRoot();
			const handoffPath = join(root, "docs/assets/p03-content-handoff.json");
			const previous = await readFile(handoffPath);
			const indexPath = join(
				root,
				"docs/assets/reference-renders/index.json",
			);
			const metadata = JSON.parse(await readFile(indexPath, "utf8")) as {
				contentSha256: string;
				pipelineConfigSha256: string;
				captureConfigSha256: string;
				renders: Array<{
					renderId: string;
					representativeReuseOf: string | null;
					path: string;
					pngSha256: string;
					bytes: number;
					verifiedAssetUrl: string;
					renderBindingSha256: string;
					bindings: Array<Record<string, unknown> & { assetSha256: string }>;
				}>;
			};
			const source = metadata.renders[0];
			const target = metadata.renders[1];
			expect(source).toBeDefined();
			expect(target).toBeDefined();
			if (duplicateKind === "asset SHA-256") {
				target!.bindings[0]!.assetSha256 =
					source!.bindings[0]!.assetSha256;
			} else if (duplicateKind === "verified URL") {
				target!.verifiedAssetUrl = source!.verifiedAssetUrl;
			} else if (duplicateKind === "PNG SHA-256") {
				const png = await readFile(join(root, source!.path));
				await writeFile(join(root, target!.path), png);
				target!.pngSha256 = sha256(png);
				target!.bytes = png.length;
			} else if (duplicateKind === "undeclared representative reuse") {
				target!.representativeReuseOf = source!.renderId;
			} else {
				const sourceBindings = source!.bindings;
				source!.bindings = target!.bindings;
				target!.bindings = sourceBindings;
				const sourceUrl = source!.verifiedAssetUrl;
				source!.verifiedAssetUrl = target!.verifiedAssetUrl;
				target!.verifiedAssetUrl = sourceUrl;
				for (const render of [source!, target!]) {
					render.renderBindingSha256 = sha256(
						Buffer.from(
							JSON.stringify({
								renderId: render.renderId,
								representativeReuseOf: render.representativeReuseOf,
								verifiedAssetUrl: render.verifiedAssetUrl,
								contentSha256: metadata.contentSha256,
								pipelineConfigSha256: metadata.pipelineConfigSha256,
								captureConfigSha256: metadata.captureConfigSha256,
								bindings: render.bindings,
							}),
							"utf8",
						),
					);
				}
			}
			await writeFile(indexPath, `${JSON.stringify(metadata, null, 2)}\n`);
			await expect(
				execFileAsync(process.execPath, [HANDOFF_SCRIPT], {
					cwd: root,
					env: await bypassHandoffRendererCheck(root),
					timeout: 60_000,
				}),
			).rejects.toMatchObject({
				stderr: expect.stringContaining("E_RENDER_REFERENCE_IDENTITY"),
			});
			expect(await readFile(handoffPath)).toEqual(previous);
		},
		60_000,
	);

	it("carries authored character scale and rejects handoff scale drift", async () => {
		const root = await generatedHandoffRoot();
		const manifest = await json<{
			entries: Array<{ characterId: string; scale: number }>;
		}>(root, "content/starter-character/manifest.json");
		const handoffPath = "docs/assets/p03-content-handoff.json";
		const handoff = await json<{
			runtimeHints: {
				characters: Array<{ characterId: string; scale: number }>;
			};
		}>(root, handoffPath);
		const authored = manifest.entries.find(
			(entry) => entry.characterId === "pebble-friend",
		);
		const runtimeHint = handoff.runtimeHints.characters.find(
			(entry) => entry.characterId === "pebble-friend",
		);
		expect(authored).toBeDefined();
		expect(runtimeHint).toBeDefined();
		expect(typeof runtimeHint!.scale).toBe("number");
		expect(runtimeHint!.scale).toBe(1);
		expect(runtimeHint!.scale).toBe(authored!.scale);

		runtimeHint!.scale += 0.25;
		await writeFile(
			join(root, handoffPath),
			`${JSON.stringify(handoff, null, 2)}\n`,
		);
		await expect(runHandoffCheck(root)).rejects.toThrow();
	});

	it("projects a nonzero embedded GLB texture contribution into handoff totals", async () => {
		const root = await copiedRoot();
		const baseline = await buildAssetBudgetReport({ root });
		expect(baseline.ok).toBe(true);
		const manifestPath = "content/starter-character/manifest.json";
		const manifest = await json<{
			assets: Array<{
				assetId: string;
				path: string;
				mime: string;
				bytes: number;
				sha256: string;
				provenance: { outputSha256: string };
			}>;
			totals: { uncompressedBytes: number };
		}>(root, manifestPath);
		const model = manifest.assets.find((asset) => asset.assetId === "model");
		const icon = manifest.assets.find(
			(asset) => asset.mime === "image/png",
		);
		expect(model).toBeDefined();
		expect(icon).toBeDefined();
		const modelPath = join(root, "content/starter-character", model!.path);
		const png = await readFile(
			join(root, "content/starter-character", icon!.path),
		);
		const syntheticGlb = glbWithEmbeddedPng(
			await readFile(modelPath),
			png,
		);
		const syntheticInspection = inspectGlb(syntheticGlb);
		expect(syntheticInspection.ok).toBe(true);
		expect(syntheticInspection.metrics.textureBytes).toBe(png.length);
		await writeFile(modelPath, syntheticGlb);
		model!.bytes = syntheticGlb.length;
		model!.sha256 = sha256(syntheticGlb);
		model!.provenance.outputSha256 = model!.sha256;
		manifest.totals.uncompressedBytes = manifest.assets.reduce(
			(total, asset) => total + asset.bytes,
			0,
		);
		await writeFile(
			join(root, manifestPath),
			`${JSON.stringify(manifest, null, 2)}\n`,
		);

		const contentRoot = join(root, "content");
		const characterInspection = await inspectStarterPackages({
			root,
			contentRoot,
		});
		const characterPackage = characterInspection.packages.find(
			(pkg) => pkg.packageName === "starter-character",
		);
		expect(characterPackage).toBeDefined();
		const campaignPath = "content/starter-campaign/manifest.json";
		const campaign = await json<unknown>(root, campaignPath);
		expect(
			replacePackageReferences(campaign, {
				...characterPackage!.ref,
			}),
		).toBeGreaterThan(0);
		await writeFile(
			join(root, campaignPath),
			`${JSON.stringify(campaign, null, 2)}\n`,
		);
		const syntheticBudget = await buildAssetBudgetReport({ root });
		expect(syntheticBudget.ok).toBe(true);
		expect(syntheticBudget.totals.textureBytes).toBe(
			baseline.totals.textureBytes + png.length,
		);
		await execFileAsync(process.execPath, [RENDER_SCRIPT, "--generate"], {
			cwd: root,
			timeout: 60_000,
		});
		await execFileAsync(process.execPath, [HANDOFF_SCRIPT], {
			cwd: root,
			timeout: 60_000,
		});
		const handoffPath = "docs/assets/p03-content-handoff.json";
		const handoff = await json<{
			evidence: { budget: { totals: { textureBytes: number } } };
		}>(root, handoffPath);
		expect(handoff.evidence.budget.totals.textureBytes).toBe(
			baseline.totals.textureBytes + png.length,
		);
		expect(handoff.evidence.budget.totals.textureBytes).toBeGreaterThan(
			baseline.totals.textureBytes,
		);
		handoff.evidence.budget.totals.textureBytes -= 1;

		await writeFile(
			join(root, handoffPath),
			`${JSON.stringify(handoff, null, 2)}\n`,
		);
		await expect(runHandoffCheck(root)).rejects.toThrow();
	}, 60_000);

	it("rejects a same-length reference index swap after evidence inventory", async () => {
		const root = await generatedHandoffRoot();
		const handoffPath = join(root, "docs/assets/p03-content-handoff.json");
		const previous = await readFile(handoffPath);
		const indexPath = join(root, "docs/assets/reference-renders/index.json");
		const originalIndex = await readFile(indexPath);
		const originalText = originalIndex.toString("utf8");
		const replacementText = originalText.replace(
			'"reviewedOn": "2026-07-15"',
			'"reviewedOn": "2026-07-14"',
		);
		expect(replacementText).not.toBe(originalText);
		const replacement = Buffer.from(replacementText, "utf8");
		expect(replacement.length).toBe(originalIndex.length);

		const rendererBypass = await bypassHandoffRendererCheck(root);
		await expect(
			execFileAsync(process.execPath, [HANDOFF_SCRIPT], {
				cwd: root,
				env: await sameLengthEvidenceSwapEnvironment(
					root,
					indexPath,
					replacement,
					rendererBypass,
				),
				timeout: 60_000,
			}),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("E_HANDOFF_EVIDENCE_STATE"),
		});
		expect(await readFile(handoffPath)).toEqual(previous);
	}, 60_000);

	it("rejects a same-length reference PNG swap after evidence inventory", async () => {
		const root = await generatedHandoffRoot();
		const handoffPath = join(root, "docs/assets/p03-content-handoff.json");
		const previous = await readFile(handoffPath);
		const targetPath = join(
			root,
			"docs/assets/reference-renders/starter-object-rock.png",
		);
		const target = await readFile(targetPath);
		const replacement = repartitionPngIdat(target);
		expect(replacement.length).toBe(target.length);
		expect(sha256(replacement)).not.toBe(sha256(target));
		expect(inspectPng(replacement).ok).toBe(true);

		const rendererBypass = await bypassHandoffRendererCheck(root);
		await expect(
			execFileAsync(process.execPath, [HANDOFF_SCRIPT], {
				cwd: root,
				env: await sameLengthEvidenceSwapEnvironment(
					root,
					targetPath,
					replacement,
					rendererBypass,
				),
				timeout: 60_000,
			}),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("Reference render evidence"),
		});
		expect(await readFile(handoffPath)).toEqual(previous);
	}, 60_000);

	it.each([
		[
			"captured license",
			"docs/licenses/provenance/infinite-snowball-original-content/CC0-1.0.txt",
			(bytes: Buffer) => {
				const mutated = Buffer.from(bytes);
				const index = mutated.indexOf(Buffer.from("Creative Commons", "utf8"));
				if (index < 0) throw new Error("Captured license fixture marker missing.");
				mutated[index] = "X".charCodeAt(0);
				return mutated;
			},
		] as const,
		[
			"withdrawal registry",
			"docs/licenses/withdrawals/starter-rock-simulated.json",
			(bytes: Buffer) =>
				Buffer.from(
					bytes
						.toString("utf8")
						.replace("Simulated provenance dispute", "Ximulated provenance dispute"),
					"utf8",
				),
		] as const,
	])(
		"rejects a same-length %s swap between semantic validation and inventory",
		async (_label, relativePath, mutate) => {
			const root = await copiedRoot();
			await runHandoffCheck(root);
			const handoffPath = join(root, "docs/assets/p03-content-handoff.json");
			const previous = await readFile(handoffPath);
			const targetPath = join(root, relativePath);
			const original = await readFile(targetPath);
			const replacement = mutate(original);
			expect(replacement).not.toEqual(original);
			expect(replacement.length).toBe(original.length);
			const rendererBypass = await bypassHandoffRendererCheck(root);

			await expect(
				execFileAsync(process.execPath, [HANDOFF_SCRIPT], {
					cwd: root,
					env: await sameLengthEvidenceSwapEnvironment(
						root,
						targetPath,
						replacement,
						rendererBypass,
					),
					timeout: 60_000,
				}),
			).rejects.toMatchObject({
				stderr: expect.stringContaining("E_HANDOFF_EVIDENCE_STATE"),
			});
			expect(await readFile(handoffPath)).toEqual(previous);
		},
		60_000,
	);

	it("persists complete texture totals and decoded WAV facts", async () => {
		const budget = await json<{
			totals: { textureBytes: number };
			files: Array<{
				path: string;
				bytes: number;
				kind: string;
				glb?: { textureBytes: number };
				texture?: { width: number; height: number };
				audio?: {
					durationSeconds: number;
					channels: number;
					sampleRate: number;
					bitsPerSample: number;
					dataBytes: number;
				};
			}>;
		}>(ROOT, "docs/assets/starter-content-budget.json");
		const expectedTextureBytes = budget.files.reduce(
			(total, file) =>
				total +
				(file.glb?.textureBytes ?? 0) +
				(file.texture === undefined ? 0 : file.bytes),
			0,
		);
		expect(budget.totals.textureBytes).toBe(expectedTextureBytes);

		const wav = budget.files.find((file) => file.kind === "wav");
		expect(wav).toBeDefined();
		const inspection = inspectWav(
			await readFile(join(ROOT, "content", wav!.path)),
		);
		expect(inspection.ok).toBe(true);
		expect(wav!.audio).toEqual(inspection.metrics);
	});

	it("uses inspected deterministic artifact SRI and measured archive totals", async () => {
		const handoff = await json<{
			packages: Array<{
				directory: string;
				manifestSha256: string;
				integrity: string;
				license: string;
				artifactBytes: number;
				artifactSha256: string;
				archive: {
					compressedBytes: number;
					uncompressedBytes: number;
					fileCount: number;
					maxDepth: number;
				};
				totals: { maxCompressionRatio: number };
			}>;
		}>(ROOT, "docs/assets/p03-content-handoff.json");
		const inspected = await inspectStarterPackages({ root: ROOT });
		expect(inspected.ok).toBe(true);
		for (const pkg of handoff.packages) {
			const current = inspected.packages.find(
				(candidate) => `content/${candidate.packageName}` === pkg.directory,
			);
			expect(current).toBeDefined();
			expect(pkg).toMatchObject({
				manifestSha256: current!.manifestSha256,
				integrity: current!.artifact.integrity,
				artifactBytes: current!.artifact.bytes.length,
				artifactSha256: sha256(current!.artifact.bytes),
				archive: current!.inspection.archive,
			});
			expect(pkg.license).toBe(current!.manifest.license);
			const maxCompressionRatio = Number(
				Math.max(
					...current!.artifact.entries.map(
						(entry) => entry.bytes / entry.compressedBytes,
					),
				).toFixed(6),
			);
			expect(pkg.totals.maxCompressionRatio).toBe(maxCompressionRatio);
			const manifestOnlyIntegrity = `sha512-${createHash("sha512")
				.update(current!.manifestBytes)
				.digest("base64")}`;
			expect(pkg.integrity).not.toBe(manifestOnlyIntegrity);
		}
	});

	it("fails closed when any inventoried evidence artifact mutates", async () => {
		const root = await copiedRoot();
		await runHandoffCheck(root);
		const handoff = await json<{
			evidence: { inventory: EvidenceEntry[] };
		}>(root, "docs/assets/p03-content-handoff.json");

		for (const entry of handoff.evidence.inventory) {
			const path = join(root, entry.path);
			const original = await readFile(path);
			await writeFile(
				path,
				Buffer.concat([original, Buffer.from("\nmutation")]),
			);
			await expect(runHandoffCheck(root), entry.path).rejects.toThrow();
			await writeFile(path, original);
			await runHandoffCheck(root);
		}
	}, 90_000);

	it.each([
		["asset budget", "docs/assets/starter-content-budget.json"],
		["brand review", "docs/brand/original-content-review.json"],
		[
			"captured license",
			"docs/licenses/provenance/infinite-snowball-original-content/CC0-1.0.txt",
		],
		["human ledger", "docs/licenses/third-party-ledger.md"],
		["local-audio policy", "docs/music/local-import-boundary.md"],
		["machine provenance", LEVEL_ARENA_PROVENANCE],
		["music policy", "docs/music/original-music-policy.md"],
		["provenance policy", "docs/licenses/asset-policy.md"],
		[
			"reference render",
			"docs/assets/reference-renders/starter-level-scene.png",
		],
		["render metadata", "docs/assets/reference-renders/index.json"],
		["withdrawal policy", "docs/licenses/withdrawal-policy.md"],
		[
			"withdrawal registry",
			"docs/licenses/withdrawals/starter-rock-simulated.json",
		],
	])("fails closed when %s evidence is removed", async (_label, evidencePath) => {
		const root = await copiedRoot();
		await runHandoffCheck(root);
		await unlink(join(root, evidencePath));
		await expect(runHandoffCheck(root)).rejects.toThrow();
	});

	it.each([
		[
			"captured license",
			"docs/licenses/provenance/infinite-snowball-original-content/CC0-1.0.txt",
		],
		["provenance policy", "docs/licenses/asset-policy.md"],
		["withdrawal policy", "docs/licenses/withdrawal-policy.md"],
	])("refuses to regenerate verified handoff without %s evidence", async (_label, evidencePath) => {
		const root = await copiedRoot();
		await runHandoffCheck(root);
		await unlink(join(root, evidencePath));
		await expect(
			execFileAsync(process.execPath, [HANDOFF_SCRIPT], {
				cwd: root,
				timeout: 60_000,
			}),
		).rejects.toThrow();
	});

	it.each([
		["machine record", "docs/licenses/provenance/records/unexpected.json"],
		["brand review", "docs/brand/unexpected.json"],
		["music policy", "docs/music/unexpected.md"],
		["withdrawal record", "docs/licenses/withdrawals/unexpected.json"],
		["reference render", "docs/assets/reference-renders/unexpected.png"],
	])("fails closed on an extra %s", async (_label, evidencePath) => {
		const root = await copiedRoot();
		await runHandoffCheck(root);
		await writeFile(join(root, evidencePath), "unexpected evidence\n");
		await expect(runHandoffCheck(root)).rejects.toThrow();
	});

	it("rejects unknown modes instead of rewriting the handoff", async () => {
		const root = await copiedRoot();
		await runHandoffCheck(root);
		await expect(
			execFileAsync(process.execPath, [HANDOFF_SCRIPT, "--chek"], {
				cwd: root,
				timeout: 30_000,
			}),
		).rejects.toThrow();
	});

	it.each([
		["evidence directory", "directory"],
		["budget file", "budget"],
		["handoff target", "handoff"],
	])("rejects a symlinked %s", async (_label, scenario) => {
		const root = await copiedRoot();
		await runHandoffCheck(root);
		if (scenario === "directory") {
			await rename(join(root, "docs/brand"), join(root, "brand-outside"));
			await symlink("../brand-outside", join(root, "docs/brand"), "dir");
		} else if (scenario === "budget") {
			const budget = join(root, "docs/assets/starter-content-budget.json");
			await rename(budget, join(root, "budget-outside.json"));
			await symlink("../../budget-outside.json", budget);
		} else {
			const handoff = join(root, "docs/assets/p03-content-handoff.json");
			await rename(handoff, join(root, "handoff-outside.json"));
			await symlink("../../handoff-outside.json", handoff);
		}
		await expect(runHandoffCheck(root)).rejects.toThrow();
	});

	it("refuses to overwrite a symlinked handoff target", async () => {
		const root = await copiedRoot();
		await runHandoffCheck(root);
		const handoff = join(root, "docs/assets/p03-content-handoff.json");
		await rename(handoff, join(root, "handoff-outside.json"));
		await symlink("../../handoff-outside.json", handoff);
		await expect(
			execFileAsync(process.execPath, [HANDOFF_SCRIPT], {
				cwd: root,
				timeout: 60_000,
			}),
		).rejects.toThrow();
	});

	it("cannot bless reference-render metadata with request failures", async () => {
		const root = await copiedRoot();
		await runHandoffCheck(root);
		const indexPath = "docs/assets/reference-renders/index.json";
		const metadata = await json<{
			renderer: { requestFailures: string[] };
		}>(root, indexPath);
		metadata.renderer.requestFailures = [
			"requestfailed: http://127.0.0.1/verified-assets/example.glb",
		];
		const metadataBytes = Buffer.from(
			`${JSON.stringify(metadata, null, 2)}\n`,
			"utf8",
		);
		await writeFile(join(root, indexPath), metadataBytes);
		const handoffPath = "docs/assets/p03-content-handoff.json";
		const handoff = await json<{
			evidence: { inventory: EvidenceEntry[] };
		}>(root, handoffPath);
		const metadataEvidence = handoff.evidence.inventory.find(
			(entry) => entry.path === indexPath,
		);
		expect(metadataEvidence).toBeDefined();
		if (metadataEvidence === undefined) throw new Error("metadata evidence missing");
		metadataEvidence.sha256 = sha256(metadataBytes);
		await writeFile(
			join(root, handoffPath),
			`${JSON.stringify(handoff, null, 2)}\n`,
		);
		await expect(runHandoffCheck(root)).rejects.toThrow(/request failures/u);
	});

	it("cannot bless a source preview as a verified reference render", async () => {
		const root = await copiedRoot();
		await runHandoffCheck(root);
		await execFileAsync(process.execPath, [HANDOFF_SCRIPT], {
			cwd: root,
			timeout: 60_000,
		});
		const indexPath = "docs/assets/reference-renders/index.json";
		const metadata = await json<{
			renders: Array<{
				renderId: string;
				path: string;
				bytes: number;
				pngSha256: string;
			}>;
		}>(root, indexPath);
		const character = metadata.renders.find(
			(render) => render.renderId === "starter-character-pebble-friend",
		);
		expect(character).toBeDefined();
		const preview = await readFile(
			join(root, "content/starter-character/assets/pebble-friend-preview.png"),
		);
		character!.bytes = preview.length;
		character!.pngSha256 = sha256(preview);
		await writeFile(join(root, character!.path), preview);
		await writeFile(
			join(root, indexPath),
			`${JSON.stringify(metadata, null, 2)}\n`,
		);
		await expect(
			execFileAsync(process.execPath, [HANDOFF_SCRIPT], {
				cwd: root,
				timeout: 60_000,
			}),
		).rejects.toThrow();
	}, 60_000);
});
