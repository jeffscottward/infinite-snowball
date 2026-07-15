const { DecompressionStream: Inflate } = globalThis;

export function decompress(): DecompressionStream {
  return new Inflate("gzip");
}
