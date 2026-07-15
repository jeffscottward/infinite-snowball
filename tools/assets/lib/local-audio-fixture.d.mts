export const LOCAL_AUDIO_FIXTURE_RELATIVE_PATH:
	"tests/fixtures/assets/local-audio-cases.json";
export const LOCAL_AUDIO_FIXTURE_MAX_BYTES: 262144;

export interface LocalAudioFixtureSummary {
	/** SHA-256 of compact UTF-8 JSON over the fully validated clone with recursively code-unit-sorted object keys and preserved array order. */
	readonly fixtureSha256: string;
	readonly safeFlows: number;
	readonly blockedFlows: number;
	readonly malformedSets: number;
}

export function validateLocalAudioFixture(
	value: unknown,
): Readonly<LocalAudioFixtureSummary>;
