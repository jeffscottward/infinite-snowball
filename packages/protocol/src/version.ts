export const PROTOCOL_SCHEMA_VERSION = "1.0.0" as const;
export const VALIDATOR_VERSION = "1.0.0" as const;

export const CONTENT_KINDS = ["level", "character", "object-pack", "campaign", "music", "bundle"] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export const PACKAGE_LIMITS = Object.freeze({
  maxFiles: 2_048,
  maxFileBytes: 64 * 1024 * 1024,
  maxDeclaredBytes: 256 * 1024 * 1024,
  maxUncompressedBytes: 512 * 1024 * 1024,
  maxDepth: 12,
  maxCompressionRatio: 100,
});

export const CONTENT_BUDGETS = Object.freeze({
  collectible: {
    maxBytes: 150 * 1024,
    maxTriangles: 10_000,
    maxMaterialSlots: 2,
    maxTextureDimension: 1_024,
  },
  hero: {
    maxBytes: Math.floor(1.5 * 1024 * 1024),
    maxTriangles: 40_000,
    maxMaterialSlots: 4,
    maxTextureDimension: 2_048,
  },
  level: {
    maxDownloadBytes: 12 * 1024 * 1024,
    maxUncompressedBytes: 25 * 1024 * 1024,
    maxFileBytes: 8 * 1024 * 1024,
    maxFiles: 256,
    maxCompressedTextureBytes: 8 * 1024 * 1024,
    maxTextureDimension: 2_048,
  },
  music: {
    maxTrackBytes: 8 * 1024 * 1024,
    maxTrackSeconds: 10 * 60,
    maxSampleRate: 48_000,
    maxChannels: 2,
    maxPackBytes: 32 * 1024 * 1024,
    maxTracks: 8,
  },
});
