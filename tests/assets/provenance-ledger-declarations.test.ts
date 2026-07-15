import { describe, expect, it } from "vitest";

import {
	AUDITED_NODE_VERSION,
	CONTENT_BUDGETS,
	ROLE_TEXTURE_SET_BUDGETS,
	assertAuditedNodeRuntime,
	canonicalConfigSha256,
} from "../../tools/assets/lib/canonical-config.mjs";

import {
	PROVENANCE_LEDGER_HEADER,
	PROVENANCE_PACKAGE_DIRECTORIES,
	PROVENANCE_OUTPUT_LIMITS,
	formatProvenanceLedger,
	formatProvenanceLedgerRow,
	generateProvenanceLedger,
	inspectProvenanceContent,
	readProvenanceLedger,
	readRetainedLicenseText,
	reconstructProvenanceRecord,
	resolveRetainedLicenseEvidence,
	validatePackageLicensePolicy,
	validateProvenanceOutputMetrics,
} from "../../tools/assets/lib/provenance-ledger.mjs";

describe("P03 provenance ledger module declarations", () => {
	it("publishes every runtime entry point through the typed module boundary", () => {
		expect(PROVENANCE_LEDGER_HEADER).toHaveLength(2);
		expect(PROVENANCE_PACKAGE_DIRECTORIES).toEqual([
			"starter-campaign",
			"starter-character",
			"starter-level",
			"starter-music",
			"starter-objects",
		]);
		expect(PROVENANCE_OUTPUT_LIMITS).toMatchObject({
			maxRecords: 512,
			maxHumanLedgerBytes: 32 * 1024 * 1024,
		});
		expect(Object.isFrozen(PROVENANCE_OUTPUT_LIMITS)).toBe(true);
		expect(formatProvenanceLedger).toBeTypeOf("function");
		expect(formatProvenanceLedgerRow).toBeTypeOf("function");
		expect(generateProvenanceLedger).toBeTypeOf("function");
		expect(inspectProvenanceContent).toBeTypeOf("function");
		expect(readProvenanceLedger).toBeTypeOf("function");
		expect(readRetainedLicenseText).toBeTypeOf("function");
		expect(reconstructProvenanceRecord).toBeTypeOf("function");
		expect(resolveRetainedLicenseEvidence).toBeTypeOf("function");
		expect(validatePackageLicensePolicy).toBeTypeOf("function");
		expect(validateProvenanceOutputMetrics).toBeTypeOf("function");
	});

	it("orders case and punctuation record IDs by direct UTF-16 code units", () => {
		const expected = [
			"asset:@scope/pkg:1.0.0:A-dash",
			"asset:@scope/pkg:1.0.0:A.dot",
			"asset:@scope/pkg:1.0.0:A_under",
			"asset:@scope/pkg:1.0.0:Aa",
			"asset:@scope/pkg:1.0.0:a",
		];
		const records = [...expected].reverse().map((recordId) => ({
			recordId,
			packageName: "@scope/pkg",
			packageVersion: "1.0.0",
			packageLicense: "CC0-1.0",
			assetId: recordId.slice(recordId.lastIndexOf(":") + 1),
			assetPath: "assets/example.bin",
			mime: "application/octet-stream",
			bytes: 1,
			sha256: "a".repeat(64),
			role: "fixture",
			creator: "Fixture creator",
			sourceUrl: "https://example.com/source",
			acquisition: "fixture",
			sourceArtifact: "fixture.bin",
			sourceArtifactSha256: "b".repeat(64),
			license: {
				spdx: "CC0-1.0",
				url: "https://creativecommons.org/publicdomain/zero/1.0/",
				textPath: "License.txt",
				textSha256: "c".repeat(64),
				grant: "fixture grant",
			},
			attribution: "fixture attribution",
			modifications: [],
			transformation: {
				recipe: "fixture-v1",
				tool: { name: "fixture", version: "1.0.0" },
				configSha256: "d".repeat(64),
				config: {},
			},
			output: {
				path: "content/pkg/assets/example.bin",
				sha256: "a".repeat(64),
			},
			reviewer: "Fixture reviewer",
			acquiredAt: "2026-07-15T00:00:00.000Z",
			reviewedAt: "2026-07-15T00:00:00.000Z",
			evidenceStatus: "verified",
			replacement: null,
			notes: "fixture",
		}));
		const actual = formatProvenanceLedger(records)
			.split("\n")
			.map((line) => line.match(/^\| `([^`]+)` \|/u)?.[1])
			.filter((recordId): recordId is string => recordId !== undefined);
		expect(actual).toEqual(expected);
	});

	it("keeps canonical runtime and budget exports exact at the typed boundary", () => {
		expect(AUDITED_NODE_VERSION).toBe("22.13.1");
		expect(CONTENT_BUDGETS).toEqual({
			collectible: {
				maxBytes: 153_600,
				maxTriangles: 10_000,
				maxMaterialSlots: 2,
				maxTextureDimension: 1_024,
			},
			hero: {
				maxBytes: 1_572_864,
				maxTriangles: 40_000,
				maxMaterialSlots: 4,
				maxTextureDimension: 2_048,
			},
			level: {
				maxDownloadBytes: 12_582_912,
				maxUncompressedBytes: 26_214_400,
				maxFileBytes: 8_388_608,
				maxFiles: 256,
				maxCompressedTextureBytes: 8_388_608,
				maxTextureDimension: 2_048,
			},
			music: {
				maxTrackBytes: 8_388_608,
				maxTrackSeconds: 600,
				maxSampleRate: 48_000,
				maxChannels: 2,
				maxPackBytes: 33_554_432,
				maxTracks: 8,
			},
		});
		expect(ROLE_TEXTURE_SET_BUDGETS).toEqual({
			collectible: 1,
			hero: 2,
		});
		expect(() => assertAuditedNodeRuntime("22.13.1")).not.toThrow();
		expect(() => assertAuditedNodeRuntime("22.13.0")).toThrow(
			/E_ASSET_RUNTIME/u,
		);
		expect(canonicalConfigSha256({ b: 2, a: 1 })).toBe(
			canonicalConfigSha256({ a: 1, b: 2 }),
		);
		const pipelineConfigSha256 =
			"b3a856908518f8d12f46d3f8a7fe53d9856b6c5384f864bf0a2a88b0b2200303";
		expect(
			canonicalConfigSha256({
				deterministic: true,
				format: "rgba-png",
				pipelineConfigSha256,
			}),
		).toBe(
			"2607740b4afac861bf7c2ab32e72a88798a7ed5ff955376d622e65f571f8f9f6",
		);
		expect(
			canonicalConfigSha256({
				deterministic: true,
				format: "pcm16-stereo-wav",
				pipelineConfigSha256,
			}),
		).toBe(
			"24536452f1a2f890280f5c083110c9c6f0539080a10f03c2834e97486f04c9fd",
		);
	});
});
