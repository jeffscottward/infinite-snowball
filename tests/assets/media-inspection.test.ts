import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { inspectPng } from "../../tools/assets/lib/media-inspection.mjs";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS: Readonly<Record<number, number>> = {
	0: 1,
	2: 3,
	3: 1,
	4: 2,
	6: 4,
};

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

function samples(...values: number[]): Buffer {
	const output = Buffer.alloc(values.length * 2);
	for (const [index, value] of values.entries())
		output.writeUInt16BE(value, index * 2);
	return output;
}

function structuredPng({
	bitDepth,
	colorType,
	height = 1,
	preIdat = [],
	raw,
	width = 1,
}: {
	bitDepth: number;
	colorType: number;
	height?: number;
	preIdat?: ReadonlyArray<readonly [type: string, data: Buffer]>;
	raw?: Buffer;
	width?: number;
}): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = bitDepth;
	ihdr[9] = colorType;
	const channels = CHANNELS[colorType];
	if (channels === undefined) throw new Error("unsupported test color type");
	const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
	const scanlines = raw ?? Buffer.alloc(height * (rowBytes + 1));
	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", ihdr),
		...preIdat.map(([type, data]) => pngChunk(type, data)),
		pngChunk("IDAT", deflateSync(scanlines)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

describe("media PNG inspection hardening", () => {
	it("rejects an enormous indexed width at IHDR before decode work", () => {
		const png = structuredPng({
			bitDepth: 1,
			colorType: 3,
			width: 1_073_741_816,
			raw: Buffer.from([0]),
			preIdat: [["PLTE", Buffer.alloc(6)]],
		});

		expect(inspectPng(png)).toMatchObject({
			ok: false,
			metrics: { decodedBytes: 0, decodedScanlineBytes: 0 },
			issues: [{ ruleId: "E_PNG_STRUCTURE", path: "/IHDR" }],
		});
	});

	it.each([
		{
			name: "1-bit grayscale sample above 1",
			png: structuredPng({
				bitDepth: 1,
				colorType: 0,
				preIdat: [["tRNS", samples(2)]],
			}),
		},
		{
			name: "8-bit grayscale sample above 255",
			png: structuredPng({
				bitDepth: 8,
				colorType: 0,
				preIdat: [["tRNS", samples(256)]],
			}),
		},
		{
			name: "8-bit truecolor red sample above 255",
			png: structuredPng({
				bitDepth: 8,
				colorType: 2,
				preIdat: [["tRNS", samples(256, 0, 0)]],
			}),
		},
		{
			name: "8-bit truecolor green sample above 255",
			png: structuredPng({
				bitDepth: 8,
				colorType: 2,
				preIdat: [["tRNS", samples(0, 256, 0)]],
			}),
		},
		{
			name: "8-bit truecolor blue sample above 255",
			png: structuredPng({
				bitDepth: 8,
				colorType: 2,
				preIdat: [["tRNS", samples(0, 0, 256)]],
			}),
		},
	] as const)("rejects out-of-range tRNS: $name", ({ png }) => {
		expect(inspectPng(png)).toMatchObject({
			ok: false,
			issues: [{ ruleId: "E_PNG_STRUCTURE", path: "/chunks/1" }],
		});
	});

	it.each([
		{ bitDepth: 1, colorType: 0, transparency: samples(1) },
		{ bitDepth: 2, colorType: 0, transparency: samples(3) },
		{ bitDepth: 4, colorType: 0, transparency: samples(15) },
		{ bitDepth: 8, colorType: 0, transparency: samples(255) },
		{ bitDepth: 16, colorType: 0, transparency: samples(65_535) },
		{ bitDepth: 8, colorType: 2, transparency: samples(0, 255, 255) },
		{
			bitDepth: 16,
			colorType: 2,
			transparency: samples(65_535, 65_535, 65_535),
		},
	] as const)(
		"accepts the tRNS sample boundary for color type $colorType at $bitDepth-bit",
		({ bitDepth, colorType, transparency }) => {
			const png = structuredPng({
				bitDepth,
				colorType,
				preIdat: [["tRNS", transparency]],
			});
			expect(inspectPng(png)).toMatchObject({ ok: true, issues: [] });
		},
	);

	it("keeps indexed tRNS alpha-table semantics unchanged", () => {
		const png = structuredPng({
			bitDepth: 1,
			colorType: 3,
			preIdat: [
				["PLTE", Buffer.alloc(6)],
				["tRNS", Buffer.from([0, 255])],
			],
			raw: Buffer.from([0, 0x80]),
		});
		expect(inspectPng(png)).toMatchObject({ ok: true, issues: [] });
	});

	it.each([
		{
			name: "duplicate grayscale transparency",
			expectedPath: "/chunks/2",
			png: structuredPng({
				bitDepth: 8,
				colorType: 0,
				preIdat: [
					["tRNS", samples(0)],
					["tRNS", samples(0)],
				],
			}),
		},
		{
			name: "indexed transparency before its palette",
			expectedPath: "/chunks/1",
			png: structuredPng({
				bitDepth: 1,
				colorType: 3,
				preIdat: [
					["tRNS", Buffer.from([0])],
					["PLTE", Buffer.alloc(6)],
				],
			}),
		},
		{
			name: "truecolor palette after transparency",
			expectedPath: "/chunks/2",
			png: structuredPng({
				bitDepth: 8,
				colorType: 2,
				preIdat: [
					["tRNS", samples(0, 0, 0)],
					["PLTE", Buffer.alloc(3)],
				],
			}),
		},
	] as const)("preserves tRNS ordering rejection: $name", ({ expectedPath, png }) => {
		expect(inspectPng(png)).toMatchObject({
			ok: false,
			issues: [{ ruleId: "E_PNG_STRUCTURE", path: expectedPath }],
		});
	});
});
