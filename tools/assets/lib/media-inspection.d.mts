export interface MediaInspectionIssue {
	readonly ruleId: string;
	readonly path: string;
	readonly remediation: string;
}

export interface MediaInspectionResult<TMetrics> {
	readonly ok: boolean;
	readonly issues: readonly MediaInspectionIssue[];
	readonly metrics: TMetrics;
}

export interface PngInspectionMetrics {
	readonly width: number;
	readonly height: number;
	readonly decodedBytes: number;
	readonly decodedScanlineBytes: number;
}

export interface WavInspectionMetrics {
	readonly durationSeconds: number;
	readonly channels: number;
	readonly sampleRate: number;
	readonly bitsPerSample: number;
	readonly dataBytes: number;
}

export function inspectPng(
	input: Buffer | Uint8Array,
): MediaInspectionResult<PngInspectionMetrics>;

export function inspectWav(
	input: Buffer | Uint8Array,
): MediaInspectionResult<WavInspectionMetrics>;
