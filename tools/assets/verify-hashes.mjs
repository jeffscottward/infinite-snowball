import { verifyStarterHashes } from "./lib/asset-pipeline.mjs";

const verification = await verifyStarterHashes({ root: process.cwd() });
if (!verification.ok) {
	for (const issue of verification.issues)
		console.error(`${issue.ruleId} ${issue.path}: ${issue.remediation}`);
	process.exitCode = 1;
} else {
	console.log("Starter content hashes verified.");
}
