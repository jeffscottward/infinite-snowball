import { checkProvenanceLedger } from "./lib/policy.mjs";

const checked = await checkProvenanceLedger({ root: process.cwd() });
if (!checked.ok) {
	for (const issue of checked.issues)
		console.error(`${issue.ruleId} ${issue.path}: ${issue.remediation}`);
	process.exitCode = 1;
} else {
	console.log(
		`Provenance ledger verified: ${checked.runtimeFiles} runtime assets, ${checked.machineRecords} machine records, ${checked.humanRows} human rows.`,
	);
}
