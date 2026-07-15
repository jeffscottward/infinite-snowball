import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
	buildDeterministicPackageArtifact,
	projectPackageArtifactWorkingBytes,
} from "../../tools/assets/lib/package-artifact.mjs";

const MIB = 1024 * 1024;
const FIXTURE_BYTES = Buffer.from("artifact-budget-fixture", "utf8");
const FIXTURE_SHA256 = createHash("sha256")
	.update(FIXTURE_BYTES)
	.digest("hex");
const EMPTY_BYTES = Buffer.alloc(0);
const EMPTY_SHA256 = createHash("sha256").update(EMPTY_BYTES).digest("hex");

function manifest(kind: string, bytes: number, assets: unknown[] = []) {
	return {
		name: "@test/level",
		version: "1.0.0",
		kind,
		license: "CC0-1.0",
		totals: {
			bytes,
			fileCount: assets.length,
			uncompressedBytes: 0,
			maxDepth: 0,
			maxCompressionRatio: 100,
		},
		assets,
	};
}

function iterationTrapAssets(): unknown[] {
	return new Proxy([], {
		get(target, property, receiver) {
			if (property === Symbol.iterator)
				throw new Error("E_TEST_ASSET_ITERATION");
			return Reflect.get(target, property, receiver) as unknown;
		},
	});
}

function fixtureInput() {
	const asset = {
		assetId: "fixture",
		path: "assets/fixture.bin",
		bytes: FIXTURE_BYTES.length,
		sha256: FIXTURE_SHA256,
	};
	return {
		manifest: {
			...manifest("level", 0, [asset]),
			totals: {
				bytes: 0,
				fileCount: 1,
				uncompressedBytes: FIXTURE_BYTES.length,
				maxDepth: 2,
				maxCompressionRatio: 100,
			},
		},
		assetBytes: new Map([[asset.path, FIXTURE_BYTES]]),
	};
}

function assetRecord(index: number, bytes: Buffer, declaredBytes = bytes.length) {
	return {
		assetId: `fixture-${index}`,
		path: `assets/fixture-${index}.bin`,
		bytes: declaredBytes,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

function deterministicPseudoRandomBytes(
	length: number,
	mask = 0xff,
): Buffer {
	const bytes = Buffer.allocUnsafe(length);
	let state = 0x6d2b_79f5;
	for (let index = 0; index < bytes.length; index += 1) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		bytes[index] = state & mask;
	}
	return bytes;
}

function postPreflightTrapMap(
	entries: Iterable<readonly [string, Buffer]>,
): Map<string, Buffer> {
	const map = new Map(entries);
	Object.defineProperty(map, "keys", {
		configurable: true,
		value() {
			throw new Error("E_TEST_NORMALIZATION_REACHED");
		},
	});
	return map;
}

class AdversarialAssetMap extends Map<string, Buffer> {
	override keys(): MapIterator<string> {
		throw new Error("E_TEST_OVERRIDDEN_KEYS_REACHED");
	}

	override get(_key: string): Buffer | undefined {
		throw new Error("E_TEST_OVERRIDDEN_GET_REACHED");
	}

	override get size(): number {
		throw new Error("E_TEST_OVERRIDDEN_SIZE_REACHED");
	}
}

describe("deterministic package artifact budget preflight", () => {
	it("rejects a 512 MiB direct target before any asset iteration or archive work", () => {
		const input = manifest("level", 512 * MIB, iterationTrapAssets());
		expect(() =>
			buildDeterministicPackageArtifact(input as never, new Map(), {
				reconcileTotals: false,
			}),
		).toThrow(/^E_PACKAGE_ARTIFACT_BUDGET:/u);
	});

	it("rejects Map subclasses before any overridable method is reached", () => {
		const input = fixtureInput();
		const bytes = new AdversarialAssetMap(input.assetBytes);
		expect(() =>
			buildDeterministicPackageArtifact(input.manifest as never, bytes),
		).toThrow(/^E_PACKAGE_ARTIFACT_INPUT:/u);
	});

	it("uses captured Map intrinsics despite ambient monkeypatches", () => {
		const input = fixtureInput();
		const iteratorPrototype = Object.getPrototypeOf(
			input.assetBytes.entries(),
		) as {
			next(): IteratorResult<[string, Buffer]>;
		};
		const spies = [
			vi
				.spyOn(Map.prototype, "has")
				.mockImplementation(() => {
					throw new Error("E_TEST_MUTABLE_MAP_HAS_REACHED");
				}),
			vi
				.spyOn(Map.prototype, "get")
				.mockImplementation(() => {
					throw new Error("E_TEST_MUTABLE_MAP_GET_REACHED");
				}),
			vi
				.spyOn(Map.prototype, "set")
				.mockImplementation(() => {
					throw new Error("E_TEST_MUTABLE_MAP_SET_REACHED");
				}),
			vi
				.spyOn(Map.prototype, "entries")
				.mockImplementation(() => {
					throw new Error("E_TEST_MUTABLE_MAP_ENTRIES_REACHED");
				}),
			vi
				.spyOn(Map.prototype, "keys")
				.mockImplementation(() => {
					throw new Error("E_TEST_MUTABLE_MAP_KEYS_REACHED");
				}),
			vi
				.spyOn(iteratorPrototype, "next")
				.mockImplementation(() => {
					throw new Error("E_TEST_MUTABLE_MAP_ITERATOR_REACHED");
				}),
			vi
				.spyOn(Object, "getPrototypeOf")
				.mockImplementation(() => {
					throw new Error("E_TEST_MUTABLE_GET_PROTOTYPE_REACHED");
				}),
		];
		let artifact;
		try {
			artifact = buildDeterministicPackageArtifact(
				input.manifest as never,
				input.assetBytes,
			);
		} finally {
			for (let index = spies.length - 1; index >= 0; index -= 1) {
				spies[index]?.mockRestore();
			}
		}
		expect(artifact.bytes.length).toBe(4750);
	});
	it("rejects Map proxies through the exact intrinsic boundary", () => {
		const input = fixtureInput();
		expect(() =>
			buildDeterministicPackageArtifact(
				input.manifest as never,
				new Proxy(input.assetBytes, {}),
			),
		).toThrow(/^E_PACKAGE_ARTIFACT_INPUT:/u);
	});
	it("rejects backslash manifest asset paths as canonical path errors", () => {
		const asset = {
			...assetRecord(0, FIXTURE_BYTES),
			path: "assets\\icon.png",
		};
		expect(() =>
			buildDeterministicPackageArtifact(
				manifest("level", 0, [asset]) as never,
				new Map([[asset.path, FIXTURE_BYTES]]),
			),
		).toThrow(/^E_PACKAGE_ARTIFACT_PATH:/u);
	});

	it("rejects manifest asset paths deeper than the P02 archive limit", () => {
		const asset = {
			...assetRecord(0, FIXTURE_BYTES),
			path: [
				"assets",
				...Array.from({ length: 12 }, () => "nested"),
				"icon.png",
			].join("/"),
		};
		expect(() =>
			buildDeterministicPackageArtifact(
				manifest("level", 0, [asset]) as never,
				new Map([[asset.path, FIXTURE_BYTES]]),
			),
		).toThrow(/^E_PACKAGE_ARTIFACT_PATH:/u);
	});

	it("rejects duplicate manifest paths before Map count mismatch", () => {
		const asset = assetRecord(0, FIXTURE_BYTES);
		expect(() =>
			buildDeterministicPackageArtifact(
				manifest("level", 0, [asset, { ...asset }]) as never,
				new Map([[asset.path, FIXTURE_BYTES]]),
			),
		).toThrow(/^E_PACKAGE_ARTIFACT_PATH:/u);
	});

	it("accepts acyclic aliases with byte-exact JSON expansion", () => {
		const input = fixtureInput();
		const shared = { labels: ["shared", "value"] };
		(input.manifest as Record<string, unknown>).metadata = {
			a: shared,
			b: shared,
		};
		const reconciled = buildDeterministicPackageArtifact(
			input.manifest as never,
			input.assetBytes,
		);
		const direct = buildDeterministicPackageArtifact(
			reconciled.manifest,
			input.assetBytes,
			{ reconcileTotals: false },
		);
		expect(direct.bytes).toEqual(reconciled.bytes);
		expect(reconciled.manifestBytes).toEqual(
			Buffer.from(
				`${JSON.stringify(reconciled.manifest, null, 2)}\n`,
				"utf8",
			),
		);
	});

	it("rejects alias amplification at node and UTF-8 caps before cloning", () => {
		const leaf = { value: 0 };
		const sharedBranch = Array.from({ length: 512 }, () => leaf);
		const nodeFanout = Array.from(
			{ length: 512 },
			() => sharedBranch,
		);
		const sharedString = "x".repeat(MIB);
		const utf8Fanout = Array.from(
			{ length: 33 },
			() => sharedString,
		);
		const cloneSpy = vi
			.spyOn(globalThis, "structuredClone")
			.mockImplementation(() => {
				throw new Error("E_TEST_ALIAS_CLONE_REACHED");
			});
		try {
			for (const metadata of [nodeFanout, utf8Fanout]) {
				const input = fixtureInput();
				(input.manifest as Record<string, unknown>).metadata =
					metadata;
				expect(() =>
					buildDeterministicPackageArtifact(
						input.manifest as never,
						input.assetBytes,
					),
				).toThrow(/^E_PACKAGE_ARTIFACT_BUDGET:/u);
			}
			expect(cloneSpy).not.toHaveBeenCalled();
		} finally {
			cloneSpy.mockRestore();
		}
	});
	it("bounds the maximum projected internal working set at 640 MiB", () => {
		const projected = projectPackageArtifactWorkingBytes(
			256 * MIB,
			64 * MIB + 512,
			32 * MIB,
		);
		expect(projected).toEqual({
			compressionPhaseBytes: 512 * MIB + 1024,
			finalMaterializationBytes: 640 * MIB,
			peakBytes: 640 * MIB,
		});
		expect(() =>
			projectPackageArtifactWorkingBytes(
				256 * MIB,
				64 * MIB + 512,
				32 * MIB + 1,
			),
		).toThrow(/^E_PACKAGE_ARTIFACT_BUDGET:/u);
	});

	it(
		"accepts a near-32 MiB manifest projection before archive work",
		() => {
			const sharedChunk = "x".repeat(MIB - 4096);
			const input = manifest("campaign", 256 * MIB);
			(input as Record<string, unknown>).metadata = Array.from(
				{ length: 32 },
				() => sharedChunk,
			);
			input.totals.uncompressedBytes = 1;
			const cloneSpy = vi
				.spyOn(globalThis, "structuredClone")
				.mockImplementation(() => {
					throw new Error("E_TEST_CLONE_REACHED");
				});
			const concatSpy = vi.spyOn(Buffer, "concat");
			try {
				expect(() =>
					buildDeterministicPackageArtifact(
						input as never,
						new Map(),
						{ reconcileTotals: false },
					),
				).toThrow(/direct artifact totals/u);
				expect(cloneSpy).not.toHaveBeenCalled();
				expect(concatSpy).not.toHaveBeenCalled();
			} finally {
				concatSpy.mockRestore();
				cloneSpy.mockRestore();
			}
		},
		120_000,
	);


	for (const graphCase of [
		"huge string",
		"deep graph",
		"cycle",
		"indirect cycle",
		"accessor",
	] as const) {
		it(`rejects ${graphCase} before property reads and cloning`, () => {
			const input = fixtureInput();
			const candidate = structuredClone(
				input.manifest,
			) as unknown as Record<string, unknown>;
			if (graphCase === "huge string") {
				candidate.metadata = "x".repeat(MIB + 1);
			} else if (graphCase === "deep graph") {
				const metadata: Record<string, unknown> = {};
				let cursor = metadata;
				for (let depth = 0; depth < 70; depth += 1) {
					const child: Record<string, unknown> = {};
					cursor.child = child;
					cursor = child;
				}
				candidate.metadata = metadata;
			} else if (graphCase === "cycle") {
				const cycle: Record<string, unknown> = {};
				cycle.self = cycle;
				candidate.metadata = cycle;
			} else if (graphCase === "indirect cycle") {
				const first: Record<string, unknown> = {};
				const second: Record<string, unknown> = { first };
				first.second = second;
				candidate.metadata = first;
			} else {
				Object.defineProperty(candidate, "kind", {
					configurable: true,
					enumerable: true,
					get() {
						throw new Error("E_TEST_MANIFEST_GETTER_REACHED");
					},
				});
			}

			const cloneSpy = vi
				.spyOn(globalThis, "structuredClone")
				.mockImplementation(() => {
					throw new Error("E_TEST_STRUCTURED_CLONE_REACHED");
				});
			try {
				expect(() =>
					buildDeterministicPackageArtifact(
						candidate as never,
						input.assetBytes,
					),
				).toThrow(/^E_PACKAGE_ARTIFACT_BUDGET:/u);
			} finally {
				cloneSpy.mockRestore();
			}
		});
	}

	it("rejects unknown kinds and unsafe declared byte counts before assets", () => {
		for (const [name, kind, declaredBytes] of [
			["kind", "unknown", 0],
			["negative", "level", -1],
			["fractional", "level", 1.5],
			["unsafe", "level", Number.MAX_SAFE_INTEGER + 1],
		] as const) {
			const input = manifest(kind, declaredBytes, iterationTrapAssets());
			expect(
				() =>
					buildDeterministicPackageArtifact(input as never, new Map(), {
						reconcileTotals: false,
					}),
				name,
			).toThrow(/^E_PACKAGE_ARTIFACT_BUDGET:/u);
		}
	});

	it("enforces the effective level, music, and hard artifact ceilings", () => {
		for (const [kind, declaredBytes] of [
			["level", 12 * MIB + 1],
			["music", 32 * MIB + 1],
			["campaign", 256 * MIB + 1],
		] as const) {
			const input = manifest(kind, declaredBytes, iterationTrapAssets());
			expect(() =>
				buildDeterministicPackageArtifact(input as never, new Map(), {
					reconcileTotals: false,
				}),
			).toThrow(/^E_PACKAGE_ARTIFACT_BUDGET:/u);
		}
	});

	it("reports non-numeric budget values without caller coercion", () => {
		const input = fixtureInput();
		const candidate = structuredClone(
			input.manifest,
		) as unknown as Record<string, unknown>;
		(candidate.totals as Record<string, unknown>).bytes = {
			toString: "not callable",
		};
		expect(() =>
			buildDeterministicPackageArtifact(
				candidate as never,
				input.assetBytes,
			),
		).toThrow(/^E_PACKAGE_ARTIFACT_BUDGET:/u);
	});

	it("rejects too many valid manifest assets before iterating the inventory", () => {
		const assets = Array.from({ length: 257 }, (_, index) => ({
			assetId: `empty-${index}`,
			path: `assets/empty-${index}.bin`,
			bytes: 0,
			sha256: EMPTY_SHA256,
		}));
		const bytes = postPreflightTrapMap(assets.map((asset) => [asset.path, EMPTY_BYTES]));
		const input = manifest("level", 0, assets);
		expect(() =>
			buildDeterministicPackageArtifact(input as never, bytes),
		).toThrow(/^E_PACKAGE_ARTIFACT_BUDGET:/u);
	});

	it("rejects actual per-file and aggregate raw bytes before normalization", () => {
		const oversizedFileBytes = Buffer.alloc(9 * MIB, 0x41);
		const oversizedFile = assetRecord(0, oversizedFileBytes);
		expect(() =>
			buildDeterministicPackageArtifact(
				manifest("level", 0, [oversizedFile]) as never,
				postPreflightTrapMap([
					[oversizedFile.path, oversizedFileBytes],
				]),
			),
		).toThrow(/^E_PACKAGE_ARTIFACT_BUDGET:/u);

		const repeatedBytes = Buffer.alloc(6 * MIB, 0x42);
		const aggregateAssets = Array.from({ length: 5 }, (_, index) =>
			assetRecord(index, repeatedBytes),
		);
		expect(() =>
			buildDeterministicPackageArtifact(
				manifest("level", 0, aggregateAssets) as never,
				postPreflightTrapMap(aggregateAssets.map((asset) => [asset.path, repeatedBytes])),
			),
		).toThrow(/^E_PACKAGE_ARTIFACT_BUDGET:/u);
	});

	it("enforces the P02 file and aggregate raw ceilings independently", () => {
		const oversizedFileBytes = Buffer.alloc(64 * MIB + 1);
		const oversizedFile = {
			assetId: "oversized-p02-file",
			path: "assets/oversized-p02-file.bin",
			bytes: oversizedFileBytes.length,
			sha256: "0".repeat(64),
		};
		expect(() =>
			buildDeterministicPackageArtifact(
				manifest("campaign", 0, [oversizedFile]) as never,
				postPreflightTrapMap([
					[oversizedFile.path, oversizedFileBytes],
				]),
			),
		).toThrow(/^E_PACKAGE_ARTIFACT_BUDGET:/u);

		const repeatedBytes = Buffer.alloc(58 * MIB);
		const assets = Array.from({ length: 9 }, (_, index) => ({
			assetId: `raw-p02-${index}`,
			path: `assets/raw-p02-${index}.bin`,
			bytes: repeatedBytes.length,
			sha256: "0".repeat(64),
		}));
		expect(() =>
			buildDeterministicPackageArtifact(
				manifest("campaign", 0, assets) as never,
				postPreflightTrapMap(
					assets.map((asset) => [asset.path, repeatedBytes]),
				),
			),
		).toThrow(/^E_PACKAGE_ARTIFACT_BUDGET:/u);
	});

	it("rejects actual bytes that exceed their declaration before hashing", () => {
		const asset = assetRecord(0, FIXTURE_BYTES, FIXTURE_BYTES.length - 1);
		expect(() =>
			buildDeterministicPackageArtifact(
				manifest("level", 0, [asset]) as never,
				postPreflightTrapMap([[asset.path, FIXTURE_BYTES]]),
			),
		).toThrow(/^E_PACKAGE_ARTIFACT_BUDGET:/u);
	});

	it("rejects oversized manifest paths before path-derived allocation", () => {
		const asset = {
			...assetRecord(0, FIXTURE_BYTES),
			path: `assets/${"x".repeat(200)}.bin`,
		};
		expect(() =>
			buildDeterministicPackageArtifact(
				manifest("level", 0, [asset]) as never,
				postPreflightTrapMap([[asset.path, FIXTURE_BYTES]]),
			),
		).toThrow(/^E_PACKAGE_ARTIFACT_PATH:/u);
	});

	it("accepts a contract-valid highly compressible P02 campaign", () => {
		const repeatedBytes = Buffer.alloc(2 * MIB, 0x43);
		const repeatedSha256 = createHash("sha256")
			.update(repeatedBytes)
			.digest("hex");
		const assets = Array.from({ length: 65 }, (_, index) => ({
			assetId: `compressed-${index}`,
			path: `assets/compressed-${index}.bin`,
			bytes: repeatedBytes.length,
			sha256: repeatedSha256,
		}));
		const assetBytes = new Map(
			assets.map((asset) => [asset.path, repeatedBytes]),
		);
		const input = manifest("campaign", 0, assets);
		const first = buildDeterministicPackageArtifact(
			input as never,
			assetBytes,
		);
		const second = buildDeterministicPackageArtifact(
			input as never,
			assetBytes,
		);
		expect(first.bytes.length).toBeLessThanOrEqual(256 * MIB);
		expect(second.bytes).toEqual(first.bytes);
	});

	it("stops retaining incompressible members at the artifact ceiling", () => {
		const repeatedBytes = deterministicPseudoRandomBytes(64 * MIB);
		const repeatedSha256 = createHash("sha256")
			.update(repeatedBytes)
			.digest("hex");
		const assets = Array.from({ length: 8 }, (_, index) => ({
			assetId: `retained-${index}`,
			path: `assets/retained-${index}.bin`,
			bytes: repeatedBytes.length,
			sha256: repeatedSha256,
		}));
		const originalConcat = Buffer.concat;
		let largeTarMembers = 0;
		const concatSpy = vi
			.spyOn(Buffer, "concat")
			.mockImplementation((list, totalLength) => {
				const projectedLength =
					totalLength ??
					list.reduce(
						(total, bytes) => total + bytes.length,
						0,
					);
				if (list.length === 3 && projectedLength > 64 * MIB) {
					largeTarMembers += 1;
					if (largeTarMembers >= 5) {
						throw new Error(
							"E_TEST_LATE_MEMBER_COMPRESSION_REACHED",
						);
					}
				}
				return originalConcat(list, totalLength);
			});
		try {
			expect(() =>
				buildDeterministicPackageArtifact(
					manifest("campaign", 0, assets) as never,
					new Map(
						assets.map((asset) => [
							asset.path,
							repeatedBytes,
						]),
					),
				),
			).toThrow(/^E_PACKAGE_ARTIFACT_BUDGET:/u);
		} finally {
			concatSpy.mockRestore();
		}
	});

	it("accepts the exact 512 MiB P02 raw boundary", () => {
		const randomPrefix = deterministicPseudoRandomBytes(MIB);
		const repeatedBytes = Buffer.alloc(64 * MIB);
		randomPrefix.copy(repeatedBytes);
		const repeatedSha256 = createHash("sha256")
			.update(repeatedBytes)
			.digest("hex");
		const assets = Array.from({ length: 8 }, (_, index) => ({
			assetId: `raw-boundary-${index}`,
			path: `assets/raw-boundary-${index}.bin`,
			bytes: repeatedBytes.length,
			sha256: repeatedSha256,
		}));
		const artifact = buildDeterministicPackageArtifact(
			manifest("campaign", 0, assets) as never,
			new Map(
				assets.map((asset) => [
					asset.path,
					repeatedBytes,
				]),
			),
		);
		expect(artifact.archive.uncompressedBytes).toBe(512 * MIB);
		expect(artifact.bytes.length).toBeLessThanOrEqual(256 * MIB);
		const compressedAssetBytes = artifact.entries
			.filter((entry) => entry.kind === "asset")
			.reduce(
				(total, entry) => total + entry.compressedBytes,
				0,
			);
		expect(
			artifact.archive.uncompressedBytes / compressedAssetBytes,
		).toBeLessThanOrEqual(100);
	}, 120_000);

	it("rejects an oversized compressed output before final concatenation", () => {
		const repeatedBytes = Buffer.allocUnsafe(6 * MIB);
		let state = 0x1234_5678;
		for (let index = 0; index < repeatedBytes.length; index += 1) {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			repeatedBytes[index] = state & 0xff;
		}
		const repeatedSha256 = createHash("sha256")
			.update(repeatedBytes)
			.digest("hex");
		const assets = Array.from({ length: 4 }, (_, index) => ({
			assetId: `incompressible-${index}`,
			path: `assets/incompressible-${index}.bin`,
			bytes: repeatedBytes.length,
			sha256: repeatedSha256,
		}));
		const originalConcat = Buffer.concat;
		const concatSpy = vi
			.spyOn(Buffer, "concat")
			.mockImplementation((list, totalLength) => {
				const projectedLength =
					totalLength ??
					list.reduce(
						(total, bytes) => total + bytes.length,
						0,
					);
				if (projectedLength > 12 * MIB) {
					throw new Error("E_TEST_OVERSIZED_CONCAT_REACHED");
				}
				return originalConcat(list, totalLength);
			});
		try {
			expect(() =>
				buildDeterministicPackageArtifact(
					manifest("level", 0, assets) as never,
					new Map(
						assets.map((asset) => [
							asset.path,
							repeatedBytes,
						]),
					),
				),
			).toThrow(/^E_PACKAGE_ARTIFACT_BUDGET:/u);
		} finally {
			concatSpy.mockRestore();
		}
	});

	it("rejects understated direct totals before normalization or compression", () => {
		const input = fixtureInput();
		for (const [name, mutate] of [
			[
				"target bytes",
				(value: typeof input.manifest) => {
					value.totals.bytes = 0;
				},
			],
			[
				"file count",
				(value: typeof input.manifest) => {
					value.totals.bytes = 4750;
					value.totals.fileCount = 0;
				},
			],
			[
				"uncompressed bytes",
				(value: typeof input.manifest) => {
					value.totals.bytes = 4750;
					value.totals.uncompressedBytes = 0;
				},
			],
			[
				"compression ratio",
				(value: typeof input.manifest) => {
					value.totals.bytes = 100;
					value.totals.maxCompressionRatio = 1;
				},
			],
		] as const) {
			const direct = structuredClone(input.manifest);
			mutate(direct);
			expect(
				() =>
					buildDeterministicPackageArtifact(
						direct as never,
						postPreflightTrapMap(input.assetBytes),
						{ reconcileTotals: false },
					),
				name,
			).toThrow(/^E_PACKAGE_ARTIFACT_BUDGET:/u);
		}
	});

	it("rejects direct targets that cannot exactly bind padding or output", () => {
		const input = fixtureInput();
		const reconciled = buildDeterministicPackageArtifact(
			input.manifest as never,
			input.assetBytes,
		);
		const baseOutputBytes =
			reconciled.bytes.length -
			reconciled.overhead.sizeBindingCompressedBytes;
		for (const targetBytes of [baseOutputBytes - 1, baseOutputBytes + 1]) {
			const direct = structuredClone(reconciled.manifest);
			direct.totals.bytes = targetBytes;
			expect(() =>
				buildDeterministicPackageArtifact(direct, input.assetBytes, {
					reconcileTotals: false,
				}),
			).toThrow(/^E_PACKAGE_ARTIFACT_BUDGET:/u);
		}
	});

	it("materializes a reconciled artifact exactly once", () => {
		const input = fixtureInput();
		const originalConcat = Buffer.concat;
		let artifactConcats = 0;
		const concatSpy = vi
			.spyOn(Buffer, "concat")
			.mockImplementation((list, totalLength) => {
				if (list.length >= 4) artifactConcats += 1;
				return originalConcat(list, totalLength);
			});
		try {
			buildDeterministicPackageArtifact(
				input.manifest as never,
				input.assetBytes,
			);
		} finally {
			concatSpy.mockRestore();
		}
		expect(artifactConcats).toBe(1);
	});

	it("keeps valid reconciled and direct artifacts byte-identical", () => {
		const input = fixtureInput();
		const reconciled = buildDeterministicPackageArtifact(
			input.manifest as never,
			input.assetBytes,
		);
		const direct = buildDeterministicPackageArtifact(
			reconciled.manifest,
			input.assetBytes,
			{ reconcileTotals: false },
		);
		expect(direct.bytes).toEqual(reconciled.bytes);
		expect(reconciled.bytes.length).toBe(4750);
		expect(createHash("sha256").update(reconciled.bytes).digest("hex")).toBe(
			"c7411a5d87bdee7e621c5c44aba25591cf8bdf10b9c7f3fffaca1b0340499c4d",
		);
	});
});
