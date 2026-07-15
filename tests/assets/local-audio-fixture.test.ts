import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	LOCAL_AUDIO_FIXTURE_RELATIVE_PATH,
	validateLocalAudioFixture,
} from "../../tools/assets/lib/local-audio-fixture.mjs";

const ROOT = process.cwd();
const FIXTURE_PATH = join(ROOT, "tests", "fixtures", "assets", "local-audio-cases.json");

type Fixture = Record<string, unknown> & {
	imported: Record<string, unknown>;
	safe: Array<Record<string, unknown>>;
	forbidden: Array<Record<string, unknown>>;
	nonArrays: unknown[];
	collidingOpaqueIds: unknown[];
	derivedOpaqueIds: unknown[];
	malformedPrivateValues: unknown[];
};

async function fixture(): Promise<{ raw: string; value: Fixture }> {
	const raw = await readFile(FIXTURE_PATH, "utf8");
	return { raw, value: JSON.parse(raw) as Fixture };
}

describe("P03 local-audio fixture contract", () => {
	it("returns only a frozen deterministic summary of the fully validated canonical value", async () => {
		const { value } = await fixture();
		const summary = validateLocalAudioFixture(value);
		expect(LOCAL_AUDIO_FIXTURE_RELATIVE_PATH).toBe(
			"tests/fixtures/assets/local-audio-cases.json",
		);
		expect(summary).toEqual({
			fixtureSha256: "3f5a5f337214cfc271f0a44993f0eebc19b28c0feb9b997ac5e265bd2983adb0",
			safeFlows: 2,
			blockedFlows: 11,
			malformedSets: 3,
		});
		expect(Object.isFrozen(summary)).toBe(true);
		expect(JSON.stringify(summary)).not.toMatch(
			/private-winter|local-track:|UklGRl|pvt7q/u,
		);
	});

	it("hashes a canonical validated clone independent of caller key order and later mutation", async () => {
		const { value } = await fixture();
		const reordered = Object.fromEntries(
			Object.entries(structuredClone(value)).reverse(),
		);
		const first = validateLocalAudioFixture(reordered);
		value.imported.fileName = "mutated-after-validation.wav";
		value.safe.length = 0;
		const second = validateLocalAudioFixture(
			JSON.parse(await readFile(FIXTURE_PATH, "utf8")),
		);
		expect(first.fixtureSha256).toBe(second.fixtureSha256);
	});

	it.each([
		["missing top-level field", (value: Fixture) => delete (value as Record<string, unknown>).forbidden],
		["extra top-level field", (value: Fixture) => Object.assign(value, { extra: true })],
		["extra imported field", (value: Fixture) => Object.assign(value.imported, { extra: true })],
		["empty safe cases", (value: Fixture) => { value.safe = []; }],
		["empty forbidden cases", (value: Fixture) => { value.forbidden = []; }],
		["empty non-array cases", (value: Fixture) => { value.nonArrays = []; }],
		["missing safe player class", (value: Fixture) => {
			value.safe = value.safe.filter((entry) => entry.channel !== "player");
		}],
		["missing forbidden network class", (value: Fixture) => {
			value.forbidden = value.forbidden.filter((entry) => entry.channel !== "network");
		}],
		["missing null non-array class", (value: Fixture) => {
			value.nonArrays = value.nonArrays.filter((entry) => entry !== null);
		}],
		["empty collision cases", (value: Fixture) => { value.collidingOpaqueIds = []; }],
		["empty derived-ID cases", (value: Fixture) => { value.derivedOpaqueIds = []; }],
		["empty malformed-private cases", (value: Fixture) => { value.malformedPrivateValues = []; }],
	] as const)("rejects %s", async (_label, mutate) => {
		const { value } = await fixture();
		mutate(value);
		expect(() => validateLocalAudioFixture(value)).toThrow(
			/^E_LOCAL_AUDIO_FIXTURE$/u,
		);
	});
});
