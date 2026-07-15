export const AUDITED_NODE_VERSION: "22.13.1";

export function assertAuditedNodeRuntime(runtimeVersion?: string): void;

export const CONTENT_BUDGETS: Readonly<{
	collectible: Readonly<{
		maxBytes: 153600;
		maxTriangles: 10000;
		maxMaterialSlots: 2;
		maxTextureDimension: 1024;
	}>;
	hero: Readonly<{
		maxBytes: 1572864;
		maxTriangles: 40000;
		maxMaterialSlots: 4;
		maxTextureDimension: 2048;
	}>;
	level: Readonly<{
		maxDownloadBytes: 12582912;
		maxUncompressedBytes: 26214400;
		maxFileBytes: 8388608;
		maxFiles: 256;
		maxCompressedTextureBytes: 8388608;
		maxTextureDimension: 2048;
	}>;
	music: Readonly<{
		maxTrackBytes: 8388608;
		maxTrackSeconds: 600;
		maxSampleRate: 48000;
		maxChannels: 2;
		maxPackBytes: 33554432;
		maxTracks: 8;
	}>;
}>;

export const ROLE_TEXTURE_SET_BUDGETS: Readonly<{
	collectible: 1;
	hero: 2;
}>;

export type CanonicalConfigValue = string | number | boolean | null;

export function canonicalConfigSha256(
	config: Readonly<Record<string, CanonicalConfigValue>>,
): string;
