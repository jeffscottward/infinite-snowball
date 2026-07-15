export function decompress(): DecompressionStream {
  return new DecompressionStream("gzip");
}
