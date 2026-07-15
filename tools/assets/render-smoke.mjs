import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	opendir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { basename, extname, join, normalize, resolve, sep } from "node:path";

import { chromium } from "@playwright/test";

import { CONFIG_SHA256, contentDigest } from "./lib/asset-pipeline.mjs";

const root = process.cwd();
const referenceDirectory = "docs/assets/reference-renders";
const referenceRoot = join(root, referenceDirectory);
const referenceIndexPath = `${referenceDirectory}/index.json`;
const canonicalRoot = await realpath(root);
const requestedModes = process.argv.slice(2);
if (
	requestedModes.some(
		(argument) => !["--check", "--generate"].includes(argument),
	) ||
	(requestedModes.includes("--check") && requestedModes.includes("--generate"))
) {
	throw new Error(
		"Usage: node tools/assets/render-smoke.mjs [--check|--generate]",
	);
}
const generate = requestedModes.includes("--generate");
const packageDirectories = [
	"starter-level",
	"starter-objects",
	"starter-character",
	"starter-campaign",
	"starter-music",
];
const maxOwnedFileBytes = 16 * 1024 * 1024;
const maxRenderGlbs = 256;
const maxRetainedGlbBytes = 32 * 1024 * 1024;
const renderLockHost = "127.0.0.1";
const renderLockPort = testRenderLockPort();
const renderLockWaitMs = testPositiveInteger(
	"INFINITE_SNOWBALL_RENDER_LOCK_WAIT_MS",
	60_000,
);
const renderLockPollMs = testPositiveInteger(
	"INFINITE_SNOWBALL_RENDER_LOCK_POLL_MS",
	50,
);
const renderPublicationPauseMs = testPositiveInteger(
	"INFINITE_SNOWBALL_RENDER_PUBLICATION_PAUSE_MS",
	0,
);
const renderLockProbe = process.env.INFINITE_SNOWBALL_RENDER_LOCK_PROBE;
if (
	renderLockProbe !== undefined &&
	(process.env.NODE_ENV !== "test" || renderLockProbe !== "1")
) {
	throw new Error(
		"E_RENDER_LOCK_CONFIG: lock probes are available only in tests.",
	);
}
const REFERENCE_RENDER_SPECS = Object.freeze(
	[
		{
			renderId: "starter-level-scene",
			kind: "level-scene",
			directory: "starter-level",
			assetId: "arena",
			caption:
				"Starter Snowfield level arena rendered directly from the current packaged arena GLB.",
		},
		{
			renderId: "starter-object-rock",
			kind: "object",
			directory: "starter-objects",
			assetId: "render",
			caption:
				"Starter Rock object rendered directly from the current packaged render-model GLB.",
		},
		{
			renderId: "starter-character-pebble-friend",
			kind: "character",
			directory: "starter-character",
			assetId: "model",
			caption:
				"Pebble Friend character rendered directly from the current packaged character-model GLB at the deterministic Idle sample.",
		},
	].map((spec) => Object.freeze(spec)),
);

function assertRepresentativeReuseDeclarations(references) {
	const renderIds = new Set(references.map((reference) => reference.renderId));
	if (renderIds.size !== references.length)
		throw new Error(
			"E_RENDER_REFERENCE_IDENTITY: reference render IDs must be unique.",
		);
	for (const reference of references) {
		if (
			reference.representativeReuseOf !== undefined &&
			reference.representativeReuseOf !== null &&
			(typeof reference.representativeReuseOf !== "string" ||
				reference.representativeReuseOf === reference.renderId ||
				!renderIds.has(reference.representativeReuseOf))
		) {
			throw new Error(
				`E_RENDER_REFERENCE_IDENTITY: invalid representativeReuseOf for ${reference.renderId}.`,
			);
		}
	}
}

function representativeReuseDeclared(left, right) {
	return (
		left.representativeReuseOf === right.renderId ||
		right.representativeReuseOf === left.renderId
	);
}

function assertDistinctReferenceValues(references, selectValue, label) {
	const firstByValue = new Map();
	for (const reference of references) {
		const value = selectValue(reference);
		if (typeof value !== "string" || value.length === 0)
			throw new Error(
				`E_RENDER_REFERENCE_IDENTITY: ${reference.renderId} lacks ${label}.`,
			);
		const first = firstByValue.get(value);
		if (
			first !== undefined &&
			!representativeReuseDeclared(first, reference)
		) {
			throw new Error(
				`E_RENDER_REFERENCE_IDENTITY: ${first.renderId} and ${reference.renderId} share ${label} without explicit representative reuse.`,
			);
		}
		if (first === undefined) firstByValue.set(value, reference);
	}
}

function assertDeclaredRepresentativeReuseMatches(
	references,
	selectValue,
	label,
) {
	const referenceById = new Map(
		references.map((reference) => [reference.renderId, reference]),
	);
	for (const reference of references) {
		if (typeof reference.representativeReuseOf !== "string") continue;
		const representative = referenceById.get(reference.representativeReuseOf);
		if (
			representative === undefined ||
			selectValue(reference) !== selectValue(representative)
		) {
			throw new Error(
				`E_RENDER_REFERENCE_IDENTITY: ${reference.renderId} declares representative reuse but does not share ${label}.`,
			);
		}
	}
}
const renderConfig = {
	width: 512,
	height: 512,
	pixelRatio: 1,
	antialias: false,
	clearColor: "#101827",
	camera: {
		algorithm: "bounds-perspective-v1",
		fovDegrees: 45,
		direction: [1, 0.7, 1],
		padding: 1.55,
	},
	lighting: {
		hemisphere: { sky: "#ffffff", ground: "#334455", intensity: 2 },
		directional: {
			color: "#ffffff",
			intensity: 3,
			position: [4, 8, 6],
		},
	},
	animationSampleSeconds: 0.5,
};

function testRenderLockPort() {
	const raw = process.env.INFINITE_SNOWBALL_RENDER_LOCK_PORT;
	if (raw === undefined) return 45_673;
	if (
		process.env.NODE_ENV !== "test" ||
		!/^[1-9]\d{0,4}$/u.test(raw) ||
		!Number.isSafeInteger(Number(raw)) ||
		Number(raw) < 1_024 ||
		Number(raw) > 65_535
	) {
		throw new Error(
			"E_RENDER_LOCK_CONFIG: INFINITE_SNOWBALL_RENDER_LOCK_PORT must be an integer from 1024 through 65535 and is test-only.",
		);
	}
	return Number(raw);
}

function testPositiveInteger(name, fallback) {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	if (
		process.env.NODE_ENV !== "test" ||
		!/^[1-9]\d{0,6}$/u.test(raw) ||
		!Number.isSafeInteger(Number(raw))
	) {
		throw new Error(
			`E_RENDER_LOCK_CONFIG: ${name} must be a positive test integer.`,
		);
	}
	return Number(raw);
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function sameFileState(expected, actual) {
	return (
		actual.isFile() &&
		actual.dev === expected.dev &&
		actual.ino === expected.ino &&
		actual.size === expected.size &&
		actual.mtimeMs === expected.mtimeMs &&
		actual.ctimeMs === expected.ctimeMs
	);
}



function delay(milliseconds) {
	const { promise, resolve: resolvePromise } = Promise.withResolvers();
	setTimeout(resolvePromise, milliseconds);
	return promise;
}


function emitRenderLockProbe(event) {
	if (renderLockProbe !== "1") return;
	process.stdout.write(
		`RENDER_LOCK_PROBE ${JSON.stringify({
			event,
			at: process.hrtime.bigint().toString(),
		})}\n`,
	);
}







async function listenRenderMutex() {
	const server = createTcpServer((socket) => socket.destroy());
	const {
		promise,
		resolve: resolvePromise,
		reject,
	} = Promise.withResolvers();
	const onError = (error) => {
		server.off("listening", onListening);
		reject(error);
	};
	const onListening = () => {
		server.off("error", onError);
		resolvePromise();
	};
	server.once("error", onError);
	server.once("listening", onListening);
	server.listen({
		host: renderLockHost,
		port: renderLockPort,
		exclusive: true,
	});
	try {
		await promise;
		return server;
	} catch (error) {
		if (error?.code === "EADDRINUSE") return null;
		throw new Error(
			`E_RENDER_LOCK_PATH: could not listen on ${renderLockHost}:${renderLockPort}: ${error?.message ?? error}`,
			{ cause: error },
		);
	}
}

async function closeRenderMutex(server) {
	if (!server.listening) return;
	const {
		promise,
		resolve: resolvePromise,
		reject,
	} = Promise.withResolvers();
	server.close((error) => {
		if (error) reject(error);
		else resolvePromise();
	});
	await promise;
}

async function acquireRenderLock() {
	const deadline = Date.now() + renderLockWaitMs;
	for (;;) {
		const server = await listenRenderMutex();
		if (server !== null) {
			let released = false;
			emitRenderLockProbe("acquired");
			return async () => {
				if (released) return;
				released = true;
				try {
					await closeRenderMutex(server);
				} finally {
					emitRenderLockProbe("released");
				}
			};
		}
		if (Date.now() >= deadline)
			throw new Error(
				`E_RENDER_LOCK_TIMEOUT: waited ${renderLockWaitMs}ms for the global renderer.`,
			);
		await delay(renderLockPollMs);
	}
}

async function listenOnLoopback(server) {
	const {
		promise,
		resolve: resolvePromise,
		reject,
	} = Promise.withResolvers();
	const onError = (error) => {
		server.off("listening", onListening);
		reject(error);
	};
	const onListening = () => {
		server.off("error", onError);
		resolvePromise();
	};
	server.once("error", onError);
	server.once("listening", onListening);
	server.listen(0, "127.0.0.1");
	await promise;
}

async function closeServer(server) {
	if (!server.listening) return;
	const {
		promise,
		resolve: resolvePromise,
		reject,
	} = Promise.withResolvers();
	server.close((error) => {
		if (error) reject(error);
		else resolvePromise();
	});
	await promise;
}

async function requireOwnedDirectory(relativePath) {
	const absolutePath = resolve(root, relativePath);
	const expectedPath = resolve(canonicalRoot, relativePath);
	if (
		expectedPath !== canonicalRoot &&
		!expectedPath.startsWith(`${canonicalRoot}${sep}`)
	) {
		throw new Error(
			`Owned directory leaves the canonical project root: ${relativePath}`,
		);
	}
	const metadata = await lstat(absolutePath);
	if (
		!metadata.isDirectory() ||
		(await realpath(absolutePath)) !== expectedPath
	)
		throw new Error(
			`Owned directory crosses a symlink or leaves the canonical project root: ${relativePath}`,
		);
	return absolutePath;
}

async function readOwnedRegularFile(relativePath) {
	const absolutePath = resolve(root, relativePath);
	const expectedPath = resolve(canonicalRoot, relativePath);
	if (
		expectedPath !== canonicalRoot &&
		!expectedPath.startsWith(`${canonicalRoot}${sep}`)
	) {
		throw new Error(
			`Owned file leaves the canonical project root: ${relativePath}`,
		);
	}
	const metadata = await lstat(absolutePath);
	if (!metadata.isFile() || (await realpath(absolutePath)) !== expectedPath)
		throw new Error(
			`Owned file crosses a symlink or leaves the canonical project root: ${relativePath}`,
		);
	const handle = await open(
		absolutePath,
		fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
	);
	try {
		const openedMetadata = await handle.stat();
		if (
			!sameFileState(metadata, openedMetadata) ||
			!Number.isSafeInteger(openedMetadata.size) ||
			openedMetadata.size < 0 ||
			openedMetadata.size > maxOwnedFileBytes
		) {
			throw new Error(
				`Owned file changed before reading or exceeds ${maxOwnedFileBytes} bytes: ${relativePath}`,
			);
		}
		const bytes = Buffer.alloc(openedMetadata.size);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(
				bytes,
				offset,
				bytes.length - offset,
				offset,
			);
			if (bytesRead === 0)
				throw new Error(
					`Owned file changed while reading: ${relativePath}`,
				);
			offset += bytesRead;
		}
		const extra = Buffer.alloc(1);
		const { bytesRead: extraBytes } = await handle.read(
			extra,
			0,
			1,
			bytes.length,
		);
		const finalMetadata = await handle.stat();
		if (
			extraBytes !== 0 ||
			!sameFileState(metadata, finalMetadata) ||
			!sameFileState(openedMetadata, finalMetadata)
		) {
			throw new Error(
				`Owned file changed while reading or grew beyond its inventoried size: ${relativePath}`,
			);
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

async function writeStagedRenderFile(directory, name, bytes) {
	const path = join(directory, name);
	const handle = await open(
		path,
		fsConstants.O_WRONLY |
			fsConstants.O_CREAT |
			fsConstants.O_EXCL |
			fsConstants.O_NOFOLLOW,
		0o644,
	);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectory(path) {
	const handle = await open(
		path,
		fsConstants.O_RDONLY |
			fsConstants.O_DIRECTORY |
			fsConstants.O_NOFOLLOW,
	);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function readReferenceDirectoryEntries(maxEntries) {
	const directory = await opendir(referenceRoot);
	const entries = [];
	try {
		for (;;) {
			const entry = await directory.read();
			if (entry === null) break;
			entries.push(entry);
			if (entries.length > maxEntries)
				throw new Error(
					`E_RENDER_REFERENCE_SET: reference-render directory exceeds ${maxEntries} entries.`,
				);
		}
	} finally {
		await directory.close();
	}
	return entries;
}

async function publishReferenceRenderSet(outputs) {
	const names = new Set();
	for (const output of outputs) {
		const name = basename(output.path);
		if (
			output.path !== `${referenceDirectory}/${name}` ||
			names.has(name)
		) {
			throw new Error(
				`E_RENDER_PUBLICATION: invalid or duplicate reference-render output ${output.path}.`,
			);
		}
		names.add(name);
	}
	const transactionId = `${process.pid}-${randomUUID()}`;
	const publicationParent = join(root, "docs", "assets");
	const stagingRoot = join(
		publicationParent,
		`.reference-renders.staging-${transactionId}`,
	);
	const backupRoot = join(
		publicationParent,
		`.reference-renders.backup-${transactionId}`,
	);
	let backupActive = false;
	try {
		await mkdir(stagingRoot, { mode: 0o755 });
		for (const output of outputs)
			await writeStagedRenderFile(stagingRoot, basename(output.path), output.bytes);
		await syncDirectory(stagingRoot);
		emitRenderLockProbe("publication-start");
		if (renderPublicationPauseMs > 0)
			await delay(renderPublicationPauseMs);
		await rename(referenceRoot, backupRoot);
		backupActive = true;
		await rename(stagingRoot, referenceRoot);
	} catch (cause) {
		let rollbackFailure;
		if (backupActive) {
			try {
				await rename(backupRoot, referenceRoot);
				backupActive = false;
			} catch (error) {
				rollbackFailure =
					error instanceof Error ? error.message : String(error);
			}
		}
		await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
		if (!backupActive)
			await rm(backupRoot, { recursive: true, force: true }).catch(() => {});
		const rollbackDetail =
			rollbackFailure === undefined
				? ""
				: `; rollback failed: ${rollbackFailure}`;
		throw new Error(
			`E_RENDER_PUBLICATION: reference-render set was not committed${rollbackDetail}`,
			{ cause },
		);
	}

	const cleanupFailures = [];
	try {
		await syncDirectory(publicationParent);
	} catch (error) {
		cleanupFailures.push(error instanceof Error ? error.message : String(error));
	}
	try {
		emitRenderLockProbe("publication-end");
	} catch (error) {
		cleanupFailures.push(error instanceof Error ? error.message : String(error));
	}
	try {
		await rm(backupRoot, { recursive: true });
		backupActive = false;
	} catch {
		try {
			await rm(backupRoot, { recursive: true, force: true });
			backupActive = false;
		} catch (error) {
			cleanupFailures.push(
				error instanceof Error ? error.message : String(error),
			);
		}
	}
	await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
	if (cleanupFailures.length > 0) {
		try {
			console.warn(
				`E_RENDER_PUBLICATION_CLEANUP: committed reference-render set requires deferred cleanup: ${cleanupFailures.join("; ")}`,
			);
		} catch {}
	}
}

await requireOwnedDirectory("docs/assets");
if (generate) {
	try {
		await requireOwnedDirectory(referenceDirectory);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		await mkdir(referenceRoot);
		await requireOwnedDirectory(referenceDirectory);
	}
} else {
	await requireOwnedDirectory(referenceDirectory);
}

const glbAssets = [];
const assetsByKey = new Map();
const verifiedGlbBytes = new Map();
const declaredGlbs = [];
const declaredAssetKeys = new Set();
let declaredGlbBytes = 0;
for (const directory of packageDirectories) {
	const manifestPath = `content/${directory}/manifest.json`;
	await requireOwnedDirectory(`content/${directory}`);
	const manifestBytes = await readOwnedRegularFile(manifestPath);
	const manifest = JSON.parse(manifestBytes.toString("utf8"));
	const manifestSha256 = sha256(manifestBytes);
	for (const asset of manifest.assets) {
		if (asset.mime !== "model/gltf-binary") continue;
		const assetKey = `${directory}:${String(asset.assetId)}`;
		if (
			typeof asset.assetId !== "string" ||
			asset.assetId.length === 0 ||
			declaredAssetKeys.has(assetKey)
		) {
			throw new Error(
				`E_RENDER_ASSET_IDENTITY: duplicate or invalid GLB identity ${assetKey}.`,
			);
		}
		declaredAssetKeys.add(assetKey);
		if (
			typeof asset.path !== "string" ||
			asset.path !== normalize(asset.path) ||
			asset.path.startsWith("/") ||
			asset.path.includes("\\") ||
			!asset.path.startsWith("assets/") ||
			asset.path
				.split("/")
				.some(
					(segment) => segment === "" || segment === "." || segment === "..",
				)
		) {
			throw new Error(
				`Reference render source has a non-canonical path: ${String(asset.path)}`,
			);
		}
		if (
			!Number.isSafeInteger(asset.bytes) ||
			asset.bytes <= 0 ||
			asset.bytes > maxOwnedFileBytes
		) {
			throw new Error(
				`E_RENDER_BUDGET: declared GLB file bytes must be a positive safe integer no greater than ${maxOwnedFileBytes}: ${manifestPath}#${String(asset.assetId)}`,
			);
		}
		declaredGlbs.push({
			asset,
			directory,
			manifest,
			manifestPath,
			manifestSha256,
		});
		if (declaredGlbs.length > maxRenderGlbs)
			throw new Error(
				`E_RENDER_BUDGET: declared GLB count exceeds ${maxRenderGlbs}.`,
			);
		declaredGlbBytes += asset.bytes;
		if (
			!Number.isSafeInteger(declaredGlbBytes) ||
			declaredGlbBytes > maxRetainedGlbBytes
		)
			throw new Error(
				`E_RENDER_BUDGET: cumulative declared GLB bytes exceed ${maxRetainedGlbBytes}.`,
			);
	}
}
for (const declaration of declaredGlbs) {
	const {
		asset,
		directory,
		manifest,
		manifestPath,
		manifestSha256,
	} = declaration;
	const assetPath = `content/${directory}/${asset.path}`;
	const canonicalPackageRoot = resolve(canonicalRoot, "content", directory);
	const expectedAssetPath = resolve(canonicalRoot, assetPath);
	if (!expectedAssetPath.startsWith(`${canonicalPackageRoot}${sep}`))
		throw new Error(
			`Reference render source must be package-relative and not escape its package: ${assetPath}`,
		);
	const assetBytes = await readOwnedRegularFile(assetPath);
	if (
		assetBytes.length !== asset.bytes ||
		sha256(assetBytes) !== asset.sha256
	)
		throw new Error(
			`Reference render source does not match its manifest binding: ${assetPath}`,
		);
	const url = `/verified-assets/${sha256(
		Buffer.from(`${directory}\0${asset.assetId}\0${asset.sha256}`, "utf8"),
	)}.glb`;
	const existingBytes = verifiedGlbBytes.get(url);
	if (existingBytes !== undefined && !existingBytes.equals(assetBytes))
		throw new Error(`Verified GLB URL collision: ${url}`);
	verifiedGlbBytes.set(url, assetBytes);
	const record = {
		url,
		directory,
		packageName: manifest.name,
		packageVersion: manifest.version,
		manifestPath,
		manifestSha256,
		assetId: asset.assetId,
		assetPath,
		assetRole: asset.role,
		assetBytes: asset.bytes,
		assetSha256: asset.sha256,
		mime: asset.mime,
		credit: asset.provenance?.attribution,
	};
	glbAssets.push(record);
	assetsByKey.set(`${directory}:${asset.assetId}`, record);
}
glbAssets.sort((left, right) =>
	left.url < right.url ? -1 : left.url > right.url ? 1 : 0,
);

const referenceAssets = REFERENCE_RENDER_SPECS.map((spec) => {
	const asset = assetsByKey.get(`${spec.directory}:${spec.assetId}`);
	if (!asset)
		throw new Error(
			`Reference render source is missing: ${spec.directory}:${spec.assetId}`,
		);
	if (typeof asset.credit !== "string" || asset.credit.length === 0)
		throw new Error(
			`Reference render source lacks attribution: ${spec.directory}:${spec.assetId}`,
		);
	return { ...spec, asset };
});
assertRepresentativeReuseDeclarations(referenceAssets);
assertDistinctReferenceValues(
	referenceAssets,
	(reference) => reference.asset.assetSha256,
	"verified GLB SHA-256",
);
assertDistinctReferenceValues(
	referenceAssets,
	(reference) => reference.asset.url,
	"verified GLB URL",
);
assertDeclaredRepresentativeReuseMatches(
	referenceAssets,
	(reference) => reference.asset.assetSha256,
	"verified GLB SHA-256",
);
assertDeclaredRepresentativeReuseMatches(
	referenceAssets,
	(reference) => reference.asset.url,
	"verified GLB URL",
);
const referenceByUrl = new Map(
	referenceAssets.map((reference) => [reference.asset.url, reference]),
);
const harnessTargets = glbAssets.map((asset) => ({
	url: asset.url,
	renderId: referenceByUrl.get(asset.url)?.renderId ?? null,
}));

const harness = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Infinite Snowball GLB render smoke</title>
  <script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js"}}</script>
</head>
<body>
  <canvas id="render" width="${renderConfig.width}" height="${renderConfig.height}"></canvas>
  <script type="module">
    import * as THREE from "three";
    import { GLTFLoader } from "/node_modules/three/examples/jsm/loaders/GLTFLoader.js";

    const targets = ${JSON.stringify(harnessTargets)};
    const config = ${JSON.stringify(renderConfig)};
    const canvas = document.querySelector("#render");
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: config.antialias,
      preserveDrawingBuffer: true,
      powerPreference: "low-power",
    });
    renderer.setSize(config.width, config.height, false);
    renderer.setPixelRatio(config.pixelRatio);
    renderer.setClearColor(config.clearColor, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = false;
    const loader = new GLTFLoader();
    const results = [];
    const retryFailures = [];

    function dispose(root) {
      root.traverse((object) => {
        object.geometry?.dispose?.();
        const materials = Array.isArray(object.material)
          ? object.material
          : object.material
            ? [object.material]
            : [];
        for (const material of materials) {
          for (const value of Object.values(material)) {
            if (value?.isTexture) value.dispose();
          }
          material.dispose?.();
        }
      });
    }

    async function loadWithRetry(url) {
      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await loader.loadAsync(url);
        } catch (error) {
          lastError = error;
          retryFailures.push(
            "requestfailed: " +
              url +
              " " +
              (error instanceof Error ? error.message : String(error)),
          );
          if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      }
      throw lastError;
    }

    try {
      for (const target of targets) {
        const scene = new THREE.Scene();
        const hemisphere = new THREE.HemisphereLight(
          config.lighting.hemisphere.sky,
          config.lighting.hemisphere.ground,
          config.lighting.hemisphere.intensity,
        );
        scene.add(hemisphere);
        const directional = new THREE.DirectionalLight(
          config.lighting.directional.color,
          config.lighting.directional.intensity,
        );
        directional.position.fromArray(config.lighting.directional.position);
        scene.add(directional);

        const gltf = await loadWithRetry(target.url);
        scene.add(gltf.scene);
        gltf.scene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(gltf.scene);
        if (box.isEmpty()) throw new Error("empty scene bounds: " + target.url);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDimension = Math.max(size.x, size.y, size.z);
        if (!Number.isFinite(maxDimension) || maxDimension <= 0) {
          throw new Error("invalid scene bounds: " + target.url);
        }

        const camera = new THREE.PerspectiveCamera(
          config.camera.fovDegrees,
          config.width / config.height,
          0.01,
          10000,
        );
        const halfFov = THREE.MathUtils.degToRad(config.camera.fovDegrees / 2);
        const distance =
          (maxDimension / (2 * Math.tan(halfFov))) * config.camera.padding;
        const direction = new THREE.Vector3(...config.camera.direction).normalize();
        camera.position.copy(center).addScaledVector(direction, distance);
        camera.near = Math.max(0.001, distance / 1000);
        camera.far = distance * 20;
        camera.lookAt(center);
        camera.updateProjectionMatrix();

        let mixer;
        if (gltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(gltf.scene);
          for (const clip of gltf.animations) mixer.clipAction(clip).play();
          mixer.update(config.animationSampleSeconds);
          gltf.scene.updateMatrixWorld(true);
        }

        renderer.info.reset();
        renderer.render(scene, camera);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        renderer.render(scene, camera);
        const context = renderer.getContext();
        const pixels = new Uint8Array(config.width * config.height * 4);
        context.readPixels(
          0,
          0,
          config.width,
          config.height,
          context.RGBA,
          context.UNSIGNED_BYTE,
          pixels,
        );
        let changedPixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (
            pixels[index] !== 16 ||
            pixels[index + 1] !== 24 ||
            pixels[index + 2] !== 39 ||
            pixels[index + 3] !== 255
          ) {
            changedPixels += 1;
          }
        }
        const meshes = [];
        gltf.scene.traverse((object) => {
          if (object.isMesh) meshes.push(object);
        });
        const error = context.getError();
        if (meshes.length === 0 || changedPixels < 64 || error !== context.NO_ERROR) {
          throw new Error(
            "render validation failed: " +
              target.url +
              " meshes=" +
              meshes.length +
              " pixels=" +
              changedPixels +
              " glError=" +
              error,
          );
        }
        results.push({
          url: target.url,
          renderId: target.renderId,
          meshes: meshes.length,
          animationClips: gltf.animations.map((clip) => clip.name).sort(),
          changedPixels,
          pngBase64: target.renderId
            ? canvas.toDataURL("image/png").split(",", 2)[1]
            : null,
          renderer: { ...renderer.info.render },
        });
        mixer?.stopAllAction();
        dispose(gltf.scene);
        renderer.renderLists.dispose();
      }
      const context = renderer.getContext();
      window.__renderSmoke = {
        ok: true,
        results,
        threeRevision: THREE.REVISION,
        webglVersion: renderer.capabilities.isWebGL2 ? 2 : 1,
        webglRenderer: context.getParameter(context.RENDERER),
        webglVendor: context.getParameter(context.VENDOR),
        requestFailures: retryFailures,
      };
    } catch (error) {
      window.__renderSmoke = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        results,
        requestFailures: retryFailures,
      };
    }
  </script>
</body>
</html>`;

const contentTypes = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".glb": "model/gltf-binary",
	".json": "application/json; charset=utf-8",
};

function localFile(urlPath) {
	const decoded = decodeURIComponent(urlPath);
	const clean = normalize(decoded).replace(/^[/\\]+/u, "");
	const target = resolve(root, clean);
	if (target !== root && !target.startsWith(`${root}${sep}`)) return null;
	if (!clean.startsWith("node_modules/three/")) return null;
	return target;
}

const verifiedGlbTransfers = new Map(
	[...verifiedGlbBytes.keys()].map((pathname) => [pathname, []]),
);
let transferEventSequence = 0;
const renderRequestCorrelationHeader = "x-infinite-snowball-render-request";
const renderRequestCorrelationPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const server = createServer(async (request, response) => {
	response.setHeader("Cache-Control", "no-store");
	response.setHeader(
		"Content-Security-Policy",
		"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
	);
	const rawRequestTarget = request.url ?? "/";
	let requestUrl;
	try {
		requestUrl = new URL(rawRequestTarget, "http://127.0.0.1");
	} catch {
		response.writeHead(400).end("bad request");
		return;
	}
	const { pathname } = requestUrl;
	if (
		pathname.startsWith("/verified-assets/") &&
		rawRequestTarget !== pathname
	) {
		response.writeHead(400).end("verified asset query aliases are forbidden");
		return;
	}
	if (pathname === "/") {
		response.writeHead(200, { "Content-Type": contentTypes[".html"] });
		response.end(harness);
		return;
	}
	const verifiedGlb = verifiedGlbBytes.get(pathname);
	if (verifiedGlb) {
		const requestCorrelationId =
			request.headers[renderRequestCorrelationHeader];
		if (
			typeof requestCorrelationId !== "string" ||
			!renderRequestCorrelationPattern.test(requestCorrelationId)
		) {
			response
				.writeHead(400)
				.end("missing or invalid render request correlation");
			return;
		}
		const transfer = {
			requestCorrelationId,
			expectedBytes: verifiedGlb.length,
			statusCode: 200,
			contentLength: null,
			finished: false,
			closedBeforeFinish: false,
			error: null,
			finishedSequence: null,
		};
		verifiedGlbTransfers.get(pathname).push(transfer);
		response.strictContentLength = true;
		response.once("finish", () => {
			transfer.statusCode = response.statusCode;
			transfer.contentLength = Number(response.getHeader("Content-Length"));
			transfer.finished = response.writableFinished;
			transfer.finishedSequence = ++transferEventSequence;
		});
		response.once("close", () => {
			if (!response.writableFinished) transfer.closedBeforeFinish = true;
		});
		response.once("error", (error) => {
			transfer.error = error instanceof Error ? error.message : String(error);
		});
		response.writeHead(200, {
			"Content-Type": contentTypes[".glb"],
			"Content-Length": verifiedGlb.length,
		});
		response.end(verifiedGlb);
		return;
	}
	let target;
	try {
		target = localFile(pathname);
	} catch (error) {
		if (error instanceof URIError) {
			response.writeHead(400).end("malformed request path");
			return;
		}
		throw error;
	}
	if (!target) {
		response.writeHead(404).end("not found");
		return;
	}
	try {
		const metadata = await stat(target);
		if (!metadata.isFile()) throw new Error("not a file");
		response.writeHead(200, {
			"Content-Type":
				contentTypes[extname(target)] ?? "application/octet-stream",
		});
		response.end(await readFile(target));
	} catch {
		response.writeHead(404).end("not found");
	}
});

await listenOnLoopback(server);
const address = server.address();
if (!address || typeof address === "string")
	throw new Error("Render smoke HTTP server did not bind a local port.");
const origin = `http://127.0.0.1:${address.port}`;
let releaseRenderer;
try {
	releaseRenderer = await acquireRenderLock();
} catch (error) {
	await closeServer(server);
	throw error;
}
try {
let browser;
let browserVersion;
let rendered;
const browserErrors = [];
const requestFailures = [];
const retryFailures = [];
let actionableRequestFailures = [];
let verifiedTransferFailures = [];
const requestCorrelationIds = new WeakMap();
try {
	browser = await chromium.launch({
		headless: true,
		args: [
			"--enable-webgl",
			"--use-gl=angle",
			"--use-angle=swiftshader",
			"--disable-gpu-sandbox",
		],
	});
	browserVersion = await browser.version();
	const page = await browser.newPage({
		viewport: { width: renderConfig.width, height: renderConfig.height },
		deviceScaleFactor: 1,
	});
	const correlationIdForRequest = (request) => {
		let correlationId = requestCorrelationIds.get(request);
		if (correlationId === undefined) {
			correlationId = randomUUID();
			requestCorrelationIds.set(request, correlationId);
		}
		return correlationId;
	};
	await page.route("**/*", async (route) => {
		const request = route.request();
		await route.continue({
			headers: {
				...request.headers(),
				[renderRequestCorrelationHeader]: correlationIdForRequest(request),
			},
		});
	});
	page.on("console", (message) => {
		if (message.type() === "error")
			browserErrors.push(`console: ${message.text()}`);
	});
	page.on("pageerror", (error) =>
		browserErrors.push(`pageerror: ${error.message}`),
	);
	page.on("requestfailed", (request) => {
		const url = request.url();
		const errorText = request.failure()?.errorText ?? "";
		const observedSequence = ++transferEventSequence;
		const asset = glbAssets.find(
			(candidate) => `${origin}${candidate.url}` === url,
		);
		const transfers =
			asset === undefined ? [] : (verifiedGlbTransfers.get(asset.url) ?? []);
		const requestCorrelationId = requestCorrelationIds.get(request);
		const transfer = transfers.find(
			(candidate) =>
				requestCorrelationId !== undefined &&
				candidate.requestCorrelationId === requestCorrelationId,
		);
		requestFailures.push({
			url,
			errorText,
			requestCorrelationId,
			finishedBeforeFailure:
				transfer !== undefined &&
				transfer.finishedSequence !== null &&
				transfer.finishedSequence < observedSequence,
			message: `requestfailed: ${url} ${errorText}`,
		});
	});
	await page.goto(origin, { waitUntil: "load", timeout: 30_000 });
	await page.waitForFunction(
		() => window.__renderSmoke !== undefined,
		undefined,
		{ timeout: 30_000 },
	);
	await page.waitForLoadState("networkidle", { timeout: 30_000 });
	rendered = await page.evaluate(() => window.__renderSmoke);
	if (!Array.isArray(rendered?.requestFailures)) {
		retryFailures.push("requestfailed: render harness omitted retry diagnostics");
	} else {
		retryFailures.push(...rendered.requestFailures);
	}
	const renderedUrls = new Set(
		Array.isArray(rendered?.results)
			? rendered.results.map((result) => result.url)
			: [],
	);
	const completedVerifiedRequestCorrelationIds = new Set();
	for (const asset of glbAssets) {
		const transfers = verifiedGlbTransfers.get(asset.url) ?? [];
		const transfer = transfers[0];
		if (
			transfers.length === 1 &&
			transfer.statusCode === 200 &&
			transfer.expectedBytes === asset.assetBytes &&
			transfer.contentLength === asset.assetBytes &&
			transfer.finished &&
			!transfer.closedBeforeFinish &&
			transfer.error === null &&
			renderedUrls.has(asset.url)
		) {
			completedVerifiedRequestCorrelationIds.add(
				transfer.requestCorrelationId,
			);
		} else {
			verifiedTransferFailures.push(
				`transfer: ${asset.url} count=${transfers.length} status=${transfer?.statusCode ?? "missing"} length=${transfer?.contentLength ?? "missing"} finished=${transfer?.finished ?? false} closedEarly=${transfer?.closedBeforeFinish ?? false} error=${transfer?.error ?? "none"} rendered=${renderedUrls.has(asset.url)}`,
			);
		}
	}
	actionableRequestFailures = requestFailures
		.filter((entry) => {
			if (
				entry.errorText !== "net::ERR_ABORTED" ||
				!entry.finishedBeforeFailure ||
				retryFailures.length > 0
			) {
				return true;
			}
			return (
				entry.requestCorrelationId === undefined ||
				!completedVerifiedRequestCorrelationIds.has(
					entry.requestCorrelationId,
				)
			);
		})
		.map((entry) => entry.message);
	if (
		!rendered?.ok ||
		rendered.results.length !== glbAssets.length ||
		browserErrors.length > 0 ||
		actionableRequestFailures.length > 0 ||
		verifiedTransferFailures.length > 0 ||
		retryFailures.length > 0
	) {
		const diagnostics = [
			...browserErrors,
			...actionableRequestFailures,
			...verifiedTransferFailures,
			...retryFailures,
		];
		throw new Error(
			`GLB render smoke failed: ${rendered?.error ?? "incomplete results"}${diagnostics.length ? `; ${diagnostics.join("; ")}` : ""}`,
		);
	}
} finally {
	try {
		await browser?.close();
	} finally {
		await closeServer(server);
	}
}

const [threePackage, playwrightPackage] = await Promise.all([
	readFile(join(root, "node_modules", "three", "package.json"), "utf8").then(
		(bytes) => JSON.parse(bytes),
	),
	readFile(
		join(root, "node_modules", "@playwright", "test", "package.json"),
		"utf8",
	).then((bytes) => JSON.parse(bytes)),
]);
const currentContentSha256 = await contentDigest({ root });
const captureConfigSha256 = sha256(
	Buffer.from(JSON.stringify(renderConfig), "utf8"),
);
const resultByUrl = new Map(
	rendered.results.map((result) => [result.url, result]),
);
const pngBytesByPath = new Map();
const referenceRenders = referenceAssets.map((reference) => {
	const result = resultByUrl.get(reference.asset.url);
	if (!result?.pngBase64)
		throw new Error(`Reference render was not captured: ${reference.renderId}`);
	const pngBytes = Buffer.from(result.pngBase64, "base64");
	const relativePath = `${referenceDirectory}/${reference.renderId}.png`;
	pngBytesByPath.set(relativePath, pngBytes);
	const bindings = [
		{
			packageDirectory: `content/${reference.asset.directory}`,
			packageName: reference.asset.packageName,
			packageVersion: reference.asset.packageVersion,
			manifestPath: reference.asset.manifestPath,
			manifestSha256: reference.asset.manifestSha256,
			assetId: reference.asset.assetId,
			assetPath: reference.asset.assetPath,
			assetRole: reference.asset.assetRole,
			assetBytes: reference.asset.assetBytes,
			assetSha256: reference.asset.assetSha256,
			mime: reference.asset.mime,
		},
	];
	const representativeReuseOf = reference.representativeReuseOf ?? null;
	const verifiedAssetUrl = reference.asset.url;
	const renderBindingSha256 = sha256(
		Buffer.from(
			JSON.stringify({
				renderId: reference.renderId,
				representativeReuseOf,
				verifiedAssetUrl,
				contentSha256: currentContentSha256,
				pipelineConfigSha256: CONFIG_SHA256,
				captureConfigSha256,
				bindings,
			}),
			"utf8",
		),
	);
	return {
		renderId: reference.renderId,
		kind: reference.kind,
		representativeReuseOf,
		verifiedAssetUrl,
		path: relativePath,
		pngSha256: sha256(pngBytes),
		bytes: pngBytes.length,
		width: renderConfig.width,
		height: renderConfig.height,
		changedPixels: result.changedPixels,
		changedPixelRatio: Number(
			(
				result.changedPixels /
				(renderConfig.width * renderConfig.height)
			).toFixed(6),
		),
		meshes: result.meshes,
		animationClips: result.animationClips,
		caption: reference.caption,
		credit: reference.asset.credit,
		renderBindingSha256,
		bindings,
	};
});
assertRepresentativeReuseDeclarations(referenceRenders);
assertDistinctReferenceValues(
	referenceRenders,
	(reference) => reference.pngSha256,
	"generated PNG SHA-256",
);
assertDeclaredRepresentativeReuseMatches(
	referenceRenders,
	(reference) => reference.pngSha256,
	"generated PNG SHA-256",
);
const metadata = {
	schemaVersion: 1,
	kind: "p03-reference-renders",
	reviewedOn: "2026-07-15",
	contentSha256: currentContentSha256,
	pipelineConfigSha256: CONFIG_SHA256,
	captureConfigSha256,
	renderer: {
		engine: "Three.js",
		engineVersion: threePackage.version,
		engineRevision: rendered.threeRevision,
		loader: "GLTFLoader",
		browserEngine: "Chromium",
		browserVersion,
		playwrightVersion: playwrightPackage.version,
		webglVersion: rendered.webglVersion,
		webglRenderer: rendered.webglRenderer,
		webglVendor: rendered.webglVendor,
		softwareRasterizer: "ANGLE SwiftShader requested",
		requestFailures: [...actionableRequestFailures, ...retryFailures],
		config: renderConfig,
	},
	renders: referenceRenders,
};
const expectedIndex = `${JSON.stringify(metadata, null, 2)}\n`;
const expectedNames = [
	"index.json",
	...referenceRenders.map((reference) => basename(reference.path)),
].sort();

if (generate) {
	const currentEntries = await readReferenceDirectoryEntries(
		expectedNames.length + 32,
	);
	for (const entry of currentEntries) {
		if (expectedNames.includes(entry.name) && !entry.isFile())
			throw new Error(
				`Expected reference-render output must be a regular file, not a symlink or directory: ${entry.name}`,
			);
	}
	await publishReferenceRenderSet([
		...referenceRenders.map((reference) => ({
			path: reference.path,
			bytes: pngBytesByPath.get(reference.path),
		})),
		{ path: referenceIndexPath, bytes: expectedIndex },
	]);
	console.log(
		`Playwright/Three reference renders generated: ${referenceRenders.length} nonblank PNGs from ${glbAssets.length} GLBs.`,
	);
} else {
	const currentEntries = await readReferenceDirectoryEntries(
		expectedNames.length + 32,
	);
	const currentNames = currentEntries.map((entry) => entry.name).sort();
	if (JSON.stringify(currentNames) !== JSON.stringify(expectedNames))
		throw new Error(
			`Reference render files are missing or unexpected: expected ${expectedNames.join(", ")}; received ${currentNames.join(", ") || "(none)"}.`,
		);
	for (const entry of currentEntries) {
		if (!entry.isFile())
			throw new Error(
				`Expected reference-render output must be a regular file, not a symlink or directory: ${entry.name}`,
			);
	}
	const currentIndex = await readOwnedRegularFile(referenceIndexPath)
		.then((bytes) => bytes.toString("utf8"))
		.catch(() => "");
	if (currentIndex !== expectedIndex)
		throw new Error(
			"Reference render metadata is missing or stale; regenerate with node tools/assets/render-smoke.mjs --generate.",
		);
	for (const reference of referenceRenders) {
		const currentPng = await readOwnedRegularFile(reference.path).catch(
			() => null,
		);
		const expectedPng = pngBytesByPath.get(reference.path);
		if (!currentPng?.equals(expectedPng))
			throw new Error(
				`Reference render is missing, stale, or nondeterministic: ${reference.path}.`,
			);
	}
	console.log(
		`Playwright/Three reference renders verified: ${referenceRenders.length} deterministic nonblank PNGs from ${glbAssets.length} GLBs in WebGL${rendered.webglVersion}.`,
	);
}
} finally {
	await releaseRenderer();
}
