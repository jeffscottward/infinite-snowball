import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_DECODED_PNG_BYTES = 128 * 1024 * 1024;
const MAX_PNG_DIMENSION = 4_096;
const MAX_PNG_PIXELS = MAX_PNG_DIMENSION * MAX_PNG_DIMENSION;
const MAX_PNG_DECODE_OPERATIONS = MAX_DECODED_PNG_BYTES;
const MAX_MEDIA_CHUNKS = 1_024;
const PNG_BIT_DEPTHS = Object.freeze({
	0: new Set([1, 2, 4, 8, 16]),
	2: new Set([8, 16]),
	3: new Set([1, 2, 4, 8]),
	4: new Set([8, 16]),
	6: new Set([8, 16]),
});
const PNG_CHANNELS = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });

function mediaIssue(ruleId, path, remediation, extra = {}) {
	return { ruleId, path, remediation, ...extra };
}

function crc32(buffer) {
	let value = 0xffffffff;
	for (const byte of buffer) {
		value ^= byte;
		for (let bit = 0; bit < 8; bit += 1)
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	}
	return (value ^ 0xffffffff) >>> 0;
}

function paeth(left, above, upperLeft) {
	const estimate = left + above - upperLeft;
	const leftDistance = Math.abs(estimate - left);
	const aboveDistance = Math.abs(estimate - above);
	const upperLeftDistance = Math.abs(estimate - upperLeft);
	if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance)
		return left;
	return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

const DEFLATE_CODE_LENGTH_ORDER = [
	16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];
const DEFLATE_LENGTH_BASE = [
	3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
	67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const DEFLATE_LENGTH_EXTRA = [
	0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4,
	5, 5, 5, 5, 0,
];
const DEFLATE_DISTANCE_EXTRA = [
	0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10,
	10, 11, 11, 12, 12, 13, 13,
];

class DeflateBitReader {
	constructor(buffer) {
		this.buffer = buffer;
		this.bitOffset = 0;
	}

	readBits(count) {
		if (
			!Number.isSafeInteger(count) ||
			count < 0 ||
			this.bitOffset + count > this.buffer.length * 8
		) {
			throw new Error("truncated DEFLATE bitstream");
		}
		let value = 0;
		for (let index = 0; index < count; index += 1) {
			const offset = this.bitOffset + index;
			value |=
				((this.buffer[Math.floor(offset / 8)] >>> (offset % 8)) & 1) << index;
		}
		this.bitOffset += count;
		return value;
	}

	alignByte() {
		this.bitOffset = Math.ceil(this.bitOffset / 8) * 8;
	}

	skipAlignedBytes(count) {
		if (
			this.bitOffset % 8 !== 0 ||
			!Number.isSafeInteger(count) ||
			count < 0 ||
			this.bitOffset + count * 8 > this.buffer.length * 8
		) {
			throw new Error("truncated DEFLATE stored block");
		}
		this.bitOffset += count * 8;
	}

	get byteOffset() {
		return Math.ceil(this.bitOffset / 8);
	}
}

class DeflateBudget {
	constructor(expectedBytes) {
		if (
			!Number.isSafeInteger(expectedBytes) ||
			expectedBytes <= 0 ||
			expectedBytes > MAX_DECODED_PNG_BYTES
		) {
			throw new Error("invalid DEFLATE output budget");
		}
		this.expectedBytes = expectedBytes;
		this.outputBytes = 0;
		this.blocks = 0;
		this.operations = 0;
		this.maxBlocks = Math.min(1_024, expectedBytes + 1);
		this.maxOperations = expectedBytes + this.maxBlocks * 320;
	}

	beginBlock() {
		this.blocks += 1;
		if (this.blocks > this.maxBlocks)
			throw new Error("DEFLATE block budget exceeded");
	}

	consumeOperation() {
		this.operations += 1;
		if (this.operations > this.maxOperations)
			throw new Error("DEFLATE operation budget exceeded");
	}

	produce(count) {
		const nextOutputBytes = this.outputBytes + count;
		if (
			!Number.isSafeInteger(count) ||
			count < 0 ||
			!Number.isSafeInteger(nextOutputBytes) ||
			nextOutputBytes > this.expectedBytes
		) {
			throw new Error("DEFLATE output exceeds exact IHDR scanline bytes");
		}
		this.outputBytes = nextOutputBytes;
	}
}

function reverseBits(value, length) {
	let reversed = 0;
	for (let index = 0; index < length; index += 1) {
		reversed = (reversed << 1) | ((value >>> index) & 1);
	}
	return reversed;
}

function huffmanTable(lengths) {
	const maximum = Math.max(0, ...lengths);
	if (maximum > 15) throw new Error("invalid DEFLATE Huffman code length");
	const counts = Array(maximum + 1).fill(0);
	for (const length of lengths) {
		if (!Number.isSafeInteger(length) || length < 0 || length > 15)
			throw new Error("invalid DEFLATE Huffman code length");
		if (length > 0) counts[length] += 1;
	}
	const next = Array(maximum + 1).fill(0);
	let code = 0;
	for (let bits = 1; bits <= maximum; bits += 1) {
		code = (code + (counts[bits - 1] ?? 0)) << 1;
		next[bits] = code;
		if (code + counts[bits] > 1 << bits)
			throw new Error("oversubscribed DEFLATE Huffman table");
	}
	const symbols = new Map();
	for (const [symbol, length] of lengths.entries()) {
		if (length === 0) continue;
		const canonical = next[length];
		next[length] += 1;
		symbols.set(`${length}:${reverseBits(canonical, length)}`, symbol);
	}
	return { maximum, symbols };
}

function decodeHuffman(reader, table) {
	let code = 0;
	for (let length = 1; length <= table.maximum; length += 1) {
		code |= reader.readBits(1) << (length - 1);
		const symbol = table.symbols.get(`${length}:${code}`);
		if (symbol !== undefined) return symbol;
	}
	throw new Error("invalid DEFLATE Huffman code");
}

function fixedDeflateTables() {
	const literals = Array(288).fill(0);
	for (let symbol = 0; symbol <= 143; symbol += 1) literals[symbol] = 8;
	for (let symbol = 144; symbol <= 255; symbol += 1) literals[symbol] = 9;
	for (let symbol = 256; symbol <= 279; symbol += 1) literals[symbol] = 7;
	for (let symbol = 280; symbol <= 287; symbol += 1) literals[symbol] = 8;
	return {
		literals: huffmanTable(literals),
		distances: huffmanTable(Array(32).fill(5)),
	};
}

const FIXED_DEFLATE_TABLES = fixedDeflateTables();

function dynamicDeflateTables(reader, budget) {
	const literalCount = reader.readBits(5) + 257;
	const distanceCount = reader.readBits(5) + 1;
	const codeLengthCount = reader.readBits(4) + 4;
	if (literalCount > 286 || distanceCount > 32)
		throw new Error("invalid DEFLATE dynamic table size");
	const codeLengths = Array(19).fill(0);
	for (let index = 0; index < codeLengthCount; index += 1)
		codeLengths[DEFLATE_CODE_LENGTH_ORDER[index]] = reader.readBits(3);
	const codeLengthTable = huffmanTable(codeLengths);
	const lengths = [];
	const total = literalCount + distanceCount;
	while (lengths.length < total) {
		budget.consumeOperation();
		const symbol = decodeHuffman(reader, codeLengthTable);
		if (symbol <= 15) {
			lengths.push(symbol);
			continue;
		}
		let repeated;
		let count;
		if (symbol === 16) {
			if (lengths.length === 0)
				throw new Error("invalid DEFLATE repeated code length");
			repeated = lengths.at(-1);
			count = reader.readBits(2) + 3;
		} else if (symbol === 17) {
			repeated = 0;
			count = reader.readBits(3) + 3;
		} else if (symbol === 18) {
			repeated = 0;
			count = reader.readBits(7) + 11;
		} else {
			throw new Error("invalid DEFLATE code-length symbol");
		}
		if (lengths.length + count > total)
			throw new Error("DEFLATE code lengths exceed declared table");
		for (let index = 0; index < count; index += 1) lengths.push(repeated);
	}
	const literalLengths = lengths.slice(0, literalCount);
	if (literalLengths[256] === 0)
		throw new Error("DEFLATE literal table lacks end marker");
	return {
		literals: huffmanTable(literalLengths),
		distances: huffmanTable(lengths.slice(literalCount)),
	};
}

function consumeCompressedDeflateBlock(reader, tables, budget) {
	while (true) {
		budget.consumeOperation();
		const symbol = decodeHuffman(reader, tables.literals);
		if (symbol < 256) {
			budget.produce(1);
			continue;
		}
		if (symbol === 256) return;
		if (symbol < 257 || symbol > 285)
			throw new Error("invalid DEFLATE length symbol");
		const lengthIndex = symbol - 257;
		const length =
			DEFLATE_LENGTH_BASE[lengthIndex] +
			reader.readBits(DEFLATE_LENGTH_EXTRA[lengthIndex]);
		const distance = decodeHuffman(reader, tables.distances);
		if (distance > 29) throw new Error("invalid DEFLATE distance symbol");
		reader.readBits(DEFLATE_DISTANCE_EXTRA[distance]);
		budget.produce(length);
	}
}

function exactZlibPayload(compressed, expectedBytes) {
	if (compressed.length < 6) throw new Error("truncated zlib stream");
	const cmf = compressed[0];
	const flags = compressed[1];
	if (
		(cmf & 0x0f) !== 8 ||
		cmf >>> 4 > 7 ||
		((cmf << 8) | flags) % 31 !== 0 ||
		(flags & 0x20) !== 0
	) {
		throw new Error("unsupported zlib header");
	}
	const payload = compressed.subarray(2, compressed.length - 4);
	const reader = new DeflateBitReader(payload);
	const budget = new DeflateBudget(expectedBytes);
	let final = false;
	while (!final) {
		budget.beginBlock();
		final = reader.readBits(1) === 1;
		const type = reader.readBits(2);
		if (type === 0) {
			reader.alignByte();
			const length = reader.readBits(16);
			const complement = reader.readBits(16);
			if ((length ^ 0xffff) !== complement)
				throw new Error("invalid DEFLATE stored block length");
			budget.produce(length);
			reader.skipAlignedBytes(length);
		} else if (type === 1) {
			consumeCompressedDeflateBlock(reader, FIXED_DEFLATE_TABLES, budget);
		} else if (type === 2) {
			consumeCompressedDeflateBlock(
				reader,
				dynamicDeflateTables(reader, budget),
				budget,
			);
		} else {
			throw new Error("reserved DEFLATE block type");
		}
	}
	reader.alignByte();
	if (reader.byteOffset !== payload.length)
		throw new Error("zlib stream contains trailing compressed payload bytes");
	if (budget.outputBytes !== expectedBytes)
		throw new Error("DEFLATE output does not match exact IHDR scanline bytes");
	return compressed.readUInt32BE(compressed.length - 4);
}

function adler32(buffer) {
	let first = 1;
	let second = 0;
	for (const byte of buffer) {
		first = (first + byte) % 65_521;
		second = (second + first) % 65_521;
	}
	return ((second << 16) | first) >>> 0;
}

function decodeScanlines(compressed, width, height, bitDepth, colorType) {
	const channels = PNG_CHANNELS[colorType];
	const bitsPerPixel = channels * bitDepth;
	const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
	const expectedBytes = height * (rowBytes + 1);
	if (
		!Number.isSafeInteger(rowBytes) ||
		!Number.isSafeInteger(expectedBytes) ||
		expectedBytes <= 0 ||
		expectedBytes > MAX_DECODED_PNG_BYTES
	) {
		throw new Error("decoded PNG exceeds the bounded scanline budget");
	}
	const expectedAdler32 = exactZlibPayload(compressed, expectedBytes);
	const inflated = inflateSync(compressed, {
		maxOutputLength: expectedBytes,
	});
	if (adler32(inflated) !== expectedAdler32)
		throw new Error("PNG zlib checksum does not match decoded scanlines");
	if (inflated.length !== expectedBytes)
		throw new Error("decoded PNG scanlines do not exactly match IHDR bounds");
	const bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
	let previous = Buffer.alloc(rowBytes);
	const decoded = Buffer.alloc(height * rowBytes);
	for (let row = 0; row < height; row += 1) {
		const sourceOffset = row * (rowBytes + 1);
		const filter = inflated[sourceOffset];
		if (filter > 4) throw new Error("PNG uses an unknown scanline filter");
		const current = decoded.subarray(row * rowBytes, (row + 1) * rowBytes);
		for (let column = 0; column < rowBytes; column += 1) {
			const encoded = inflated[sourceOffset + 1 + column];
			const left =
				column >= bytesPerPixel ? current[column - bytesPerPixel] : 0;
			const above = previous[column] ?? 0;
			const upperLeft =
				column >= bytesPerPixel ? (previous[column - bytesPerPixel] ?? 0) : 0;
			switch (filter) {
				case 0:
					current[column] = encoded;
					break;
				case 1:
					current[column] = (encoded + left) & 0xff;
					break;
				case 2:
					current[column] = (encoded + above) & 0xff;
					break;
				case 3:
					current[column] = (encoded + Math.floor((left + above) / 2)) & 0xff;
					break;
				case 4:
					current[column] = (encoded + paeth(left, above, upperLeft)) & 0xff;
					break;
			}
		}
		previous = current;
	}
	return {
		decoded,
		rowBytes,
		bitsPerPixel,
		decodedScanlineBytes: expectedBytes,
	};
}

function validatePaletteIndexes(
	decoded,
	rowBytes,
	width,
	height,
	bitDepth,
	entries,
) {
	const mask = (1 << bitDepth) - 1;
	for (let row = 0; row < height; row += 1) {
		const bytes = decoded.subarray(row * rowBytes, (row + 1) * rowBytes);
		for (let column = 0; column < width; column += 1) {
			const bitOffset = column * bitDepth;
			const byte = bytes[Math.floor(bitOffset / 8)];
			const shift = 8 - bitDepth - (bitOffset % 8);
			const index = (byte >>> shift) & mask;
			if (index >= entries)
				throw new Error("PNG palette index is out of bounds");
		}
	}
}

export function inspectPng(input) {
	const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
	const issues = [];
	const metrics = {
		width: 0,
		height: 0,
		decodedBytes: 0,
		decodedScanlineBytes: 0,
	};
	const fail = (path, remediation) => {
		issues.push(mediaIssue("E_PNG_STRUCTURE", path, remediation));
		return { ok: false, issues, metrics };
	};
	if (
		buffer.length < PNG_SIGNATURE.length ||
		!buffer.subarray(0, 8).equals(PNG_SIGNATURE)
	) {
		return fail(
			"/",
			"Provide a complete PNG with the exact eight-byte signature.",
		);
	}

	const chunks = [];
	let offset = PNG_SIGNATURE.length;
	while (offset < buffer.length) {
		if (chunks.length >= MAX_MEDIA_CHUNKS)
			return fail(
				"/chunks",
				`Keep PNG chunk count at or below ${MAX_MEDIA_CHUNKS}.`,
			);
		if (offset + 12 > buffer.length)
			return fail(
				"/chunks",
				"Reject a truncated PNG chunk header or checksum.",
			);
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;
		const chunkEnd = dataEnd + 4;
		if (
			!/^[A-Za-z]{2}[A-Z][A-Za-z]$/u.test(type) ||
			dataEnd < dataStart ||
			chunkEnd > buffer.length
		) {
			return fail("/chunks", "Keep every PNG chunk within exact file bounds.");
		}
		const suppliedCrc = buffer.readUInt32BE(dataEnd);
		const actualCrc = crc32(buffer.subarray(offset + 4, dataEnd));
		if (suppliedCrc !== actualCrc)
			return fail(
				`/chunks/${chunks.length}`,
				"Reject PNG chunks whose CRC does not match exact bytes.",
			);
		chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) });
		offset = chunkEnd;
		if (type === "IEND" && offset !== buffer.length)
			return fail(
				"/chunks",
				"Reject bytes or chunks after the terminal IEND chunk.",
			);
	}
	if (offset !== buffer.length || chunks.length < 3)
		return fail(
			"/chunks",
			"Traverse the complete PNG chunk stream through IEND.",
		);
	if (chunks[0]?.type !== "IHDR" || chunks[0].data.length !== 13)
		return fail(
			"/chunks/0",
			"Require one 13-byte IHDR as the first PNG chunk.",
		);
	if (chunks.at(-1)?.type !== "IEND" || chunks.at(-1).data.length !== 0)
		return fail("/chunks", "Require one empty IEND as the final PNG chunk.");
	if (
		chunks.filter((chunk) => chunk.type === "IHDR").length !== 1 ||
		chunks.filter((chunk) => chunk.type === "IEND").length !== 1
	)
		return fail("/chunks", "Require exactly one IHDR and one IEND chunk.");

	const ihdr = chunks[0].data;
	const width = ihdr.readUInt32BE(0);
	const height = ihdr.readUInt32BE(4);
	const bitDepth = ihdr[8];
	const colorType = ihdr[9];
	metrics.width = width;
	metrics.height = height;
	if (
		width === 0 ||
		height === 0 ||
		!Object.hasOwn(PNG_BIT_DEPTHS, colorType) ||
		!PNG_BIT_DEPTHS[colorType].has(bitDepth) ||
		ihdr[10] !== 0 ||
		ihdr[11] !== 0 ||
		ihdr[12] !== 0
	) {
		return fail(
			"/IHDR",
			"Use bounded non-interlaced PNG dimensions and a supported standard color layout.",
		);
	}
	if (width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION)
		return fail(
			"/IHDR",
			`Keep PNG width and height at or below ${MAX_PNG_DIMENSION}.`,
		);
	const pixelCount = width * height;
	const decodeOperations =
		height +
		pixelCount * PNG_CHANNELS[colorType] * Math.ceil(bitDepth / 8);
	if (
		!Number.isSafeInteger(pixelCount) ||
		pixelCount > MAX_PNG_PIXELS ||
		!Number.isSafeInteger(decodeOperations) ||
		decodeOperations > MAX_PNG_DECODE_OPERATIONS
	)
		return fail(
			"/IHDR",
			"Keep PNG pixel count and decoded work inside reviewed bounds.",
		);


	let palette;
	let transparency;
	let sawIdat = false;
	let endedIdat = false;
	const idat = [];
	for (const [index, chunk] of chunks.entries()) {
		if (!["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(chunk.type))
			return fail(
				`/chunks/${index}`,
				"Use only the closed reviewed PNG chunk set with canonical reserved-bit casing.",
			);
		if (chunk.type === "PLTE") {
			const paletteEntries = chunk.data.length / 3;
			if (
				sawIdat ||
				palette !== undefined ||
				transparency !== undefined ||
				chunk.data.length === 0 ||
				chunk.data.length % 3 !== 0 ||
				chunk.data.length > 768 ||
				colorType === 0 ||
				colorType === 4 ||
				(colorType === 3 && paletteEntries > 2 ** bitDepth)
			)
				return fail(
					`/chunks/${index}`,
					"Require one legal bounded palette before image data for indexed or truecolor PNGs.",
				);
			palette = chunk.data;
		}
		if (chunk.type === "tRNS") {
			const paletteEntries =
				palette === undefined ? 0 : palette.length / 3;
			const maxSample = 2 ** bitDepth - 1;
			let samplesWithinRange = true;
			if (colorType === 0 && chunk.data.length === 2)
				samplesWithinRange = chunk.data.readUInt16BE(0) <= maxSample;
			if (colorType === 2 && chunk.data.length === 6)
				samplesWithinRange = [0, 2, 4].every(
					(offset) => chunk.data.readUInt16BE(offset) <= maxSample,
				);
			const validTransparency =
				!sawIdat &&
				transparency === undefined &&
				((colorType === 0 && chunk.data.length === 2) ||
					(colorType === 2 && chunk.data.length === 6) ||
					(colorType === 3 &&
						palette !== undefined &&
						chunk.data.length > 0 &&
						chunk.data.length <= paletteEntries)) &&
				samplesWithinRange;
			if (!validTransparency)
				return fail(
					`/chunks/${index}`,
					"Require one legal transparency table after its palette and before image data.",
				);
			transparency = chunk.data;
		}
		if (chunk.type === "IDAT") {
			if (endedIdat)
				return fail(
					`/chunks/${index}`,
					"Require all IDAT chunks to be consecutive.",
				);
			sawIdat = true;
			idat.push(chunk.data);
		} else if (sawIdat && chunk.type !== "IEND") {
			endedIdat = true;
		}
	}
	if (!sawIdat || (colorType === 3 && palette === undefined))
		return fail(
			"/IDAT",
			"Require decodable image data and a palette for indexed PNGs.",
		);

	try {
		const decoded = decodeScanlines(
			Buffer.concat(idat),
			width,
			height,
			bitDepth,
			colorType,
		);
		metrics.decodedBytes = decoded.decoded.length;
		metrics.decodedScanlineBytes = decoded.decodedScanlineBytes;
		if (colorType === 3)
			validatePaletteIndexes(
				decoded.decoded,
				decoded.rowBytes,
				width,
				height,
				bitDepth,
				palette.length / 3,
			);
	} catch {
		return fail(
			"/IDAT",
			"Inflate and decode every scanline within exact IHDR and palette bounds.",
		);
	}
	return { ok: true, issues, metrics };
}

export function inspectWav(input) {
	const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
	const issues = [];
	const metrics = {
		durationSeconds: 0,
		channels: 0,
		sampleRate: 0,
		bitsPerSample: 0,
		dataBytes: 0,
	};
	const fail = (path, remediation) => {
		issues.push(mediaIssue("E_WAV_STRUCTURE", path, remediation));
		return { ok: false, issues, metrics };
	};
	if (
		buffer.length < 12 ||
		buffer.toString("ascii", 0, 4) !== "RIFF" ||
		buffer.toString("ascii", 8, 12) !== "WAVE" ||
		buffer.readUInt32LE(4) + 8 !== buffer.length
	) {
		return fail(
			"/",
			"Require a complete RIFF/WAVE container whose declared size exactly matches file bytes.",
		);
	}

	let format;
	let dataBytes;
	let offset = 12;
	let chunkCount = 0;
	while (offset < buffer.length) {
		chunkCount += 1;
		if (chunkCount > MAX_MEDIA_CHUNKS)
			return fail(
				"/chunks",
				`Keep RIFF chunk count at or below ${MAX_MEDIA_CHUNKS}.`,
			);
		if (offset + 8 > buffer.length)
			return fail("/chunks", "Reject a truncated RIFF chunk header.");
		const type = buffer.toString("ascii", offset, offset + 4);
		const length = buffer.readUInt32LE(offset + 4);
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;
		const paddedEnd = dataEnd + (length & 1);
		if (dataEnd < dataStart || paddedEnd > buffer.length)
			return fail(
				"/chunks",
				"Keep every RIFF chunk and pad byte within exact file bounds.",
			);
		if (type === "fmt ") {
			const supportedFormat =
				length === 16 ||
				(length === 18 && buffer.readUInt16LE(dataStart + 16) === 0);
			if (format !== undefined || !supportedFormat)
				return fail(
					"/fmt",
					"Require one 16-byte PCM format chunk or 18-byte PCM WAVEFORMATEX with cbSize zero.",
				);
			format = {
				audioFormat: buffer.readUInt16LE(dataStart),
				channels: buffer.readUInt16LE(dataStart + 2),
				sampleRate: buffer.readUInt32LE(dataStart + 4),
				byteRate: buffer.readUInt32LE(dataStart + 8),
				blockAlign: buffer.readUInt16LE(dataStart + 12),
				bitsPerSample: buffer.readUInt16LE(dataStart + 14),
			};
		}
		if (type === "data") {
			if (dataBytes !== undefined || format === undefined)
				return fail(
					"/data",
					"Require exactly one data chunk after the PCM format chunk.",
				);
			dataBytes = length;
		}
		offset = paddedEnd;
	}
	if (
		offset !== buffer.length ||
		format === undefined ||
		dataBytes === undefined ||
		dataBytes === 0
	)
		return fail(
			"/chunks",
			"Traverse the complete playable RIFF stream with format and audio data.",
		);
	const bytesPerSample = format.bitsPerSample / 8;
	const expectedBlockAlign = format.channels * bytesPerSample;
	if (
		format.audioFormat !== 1 ||
		!Number.isInteger(bytesPerSample) ||
		![8, 16, 24, 32].includes(format.bitsPerSample) ||
		format.channels < 1 ||
		format.channels > 2 ||
		format.sampleRate === 0 ||
		format.blockAlign !== expectedBlockAlign ||
		format.byteRate !== format.sampleRate * expectedBlockAlign ||
		dataBytes % expectedBlockAlign !== 0
	) {
		return fail(
			"/fmt",
			"Require internally consistent mono or stereo integer PCM playback fields.",
		);
	}
	metrics.durationSeconds = dataBytes / format.byteRate;
	metrics.channels = format.channels;
	metrics.sampleRate = format.sampleRate;
	metrics.bitsPerSample = format.bitsPerSample;
	metrics.dataBytes = dataBytes;
	return { ok: true, issues, metrics };
}
