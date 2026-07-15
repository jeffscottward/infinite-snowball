import { describe, expect, it } from "vitest";

import { inspectGlb } from "../../tools/assets/lib/asset-pipeline.mjs";

function glb(document: Record<string, unknown>): Buffer {
	const json = Buffer.from(JSON.stringify(document), "utf8");
	const paddedLength = Math.ceil(json.length / 4) * 4;
	const output = Buffer.alloc(20 + paddedLength, 0x20);
	output.writeUInt32LE(0x46546c67, 0);
	output.writeUInt32LE(2, 4);
	output.writeUInt32LE(output.length, 8);
	output.writeUInt32LE(paddedLength, 12);
	output.writeUInt32LE(0x4e4f534a, 16);
	json.copy(output, 20);
	return output;
}

const base = {
	asset: { version: "2.0" },
	scenes: [{ nodes: [] }],
	scene: 0,
};

describe("GLB animation identity", () => {
	it("retains only explicit unique animation clip names", () => {
		const valid = inspectGlb(
			glb({ ...base, animations: [{ name: "idle" }, { name: "roll" }] }),
		);
		expect(valid.ok).toBe(true);
		expect(valid.metrics.animationClips).toEqual(["idle", "roll"]);
	});

	it.each([
		["duplicate", [{ name: "idle" }, { name: "idle" }]],
		["blank", [{ name: "" }]],
		["missing", [{}]],
	])("rejects %s animation names", (_label, animations) => {
		const inspected = inspectGlb(glb({ ...base, animations }));
		expect(inspected.ok).toBe(false);
		expect(inspected.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ ruleId: "E_GLB_STRUCTURE" }),
			]),
		);
	});
});
