
import {
	applyOfflineEvent,
	createOfflineState,
} from "../../packages/protocol/dist/offline/model.js";
import { validateCatalogInstallEligibility } from "../../packages/protocol/dist/validation/dependency-catalog.js";
import { inspectStarterPackages } from "./lib/asset-pipeline.mjs";
import {
	createWithdrawalRegistryRecord,
	readCanonicalWithdrawalRecord,
	validateWithdrawalPackageBinding,
	validateWithdrawalRecord,
} from "./lib/policy.mjs";

const record = await readCanonicalWithdrawalRecord(process.cwd());
const failures = [];
const checked = validateWithdrawalRecord(record);
if (!checked.ok) failures.push(...checked.issues);
if (checked.ok) {
	const inspection = await inspectStarterPackages({ root: process.cwd() });
	const binding = validateWithdrawalPackageBinding(record, inspection.packages);
	if (!binding.ok) failures.push(...binding.issues);
}

let registry;
if (checked.ok && failures.length === 0) {
	registry = createWithdrawalRegistryRecord(record);
	if (
		registry.simulationOnly !== true ||
		registry.dispatch.simulationOnly !== true
	) {
		failures.push({
			ruleId: "E_WITHDRAWAL_SIMULATION",
			path: "/simulationOnly",
			remediation:
				"Preserve the simulation-only marker through registry and dispatch projections.",
		});
	}
	const catalog = validateCatalogInstallEligibility(
		registry.catalogEligibility,
	);
	if (
		catalog.ok ||
		!catalog.issues.some((entry) => entry.ruleId === "E_PACKAGE_WITHDRAWN")
	) {
		failures.push({
			ruleId: "E_WITHDRAWAL_INSTALL",
			path: "/catalogEligibility",
			remediation:
				"Route the exact withdrawal through P02 catalog eligibility.",
		});
	}

	const before = createOfflineState({
		activeLock: null,
		references: { save: 2, history: 1 },
		saves: { "save:withdrawal-fixture": { package: registry.packageKey } },
		knownGoodShell: "shell:p02",
	});
	before.transactionHistory["transaction:installed"] = {
		transactionId: "transaction:installed",
		state: "installed",
		baselineReferences: { save: 2, history: 1 },
	};
	const after = applyOfflineEvent(before, registry.dispatch);
	if (
		after.withdrawals[registry.packageKey] !==
			registry.replacement.packageKey ||
		JSON.stringify(after.references) !== JSON.stringify(before.references) ||
		JSON.stringify(after.saves) !== JSON.stringify(before.saves) ||
		JSON.stringify(after.transactionHistory) !==
			JSON.stringify(before.transactionHistory)
	) {
		failures.push({
			ruleId: "E_WITHDRAWAL_HISTORY",
			path: "/dispatch",
			remediation:
				"Dispatch P02 withdraw-package without mutating saves, references, or transaction history.",
		});
	}
}

if (failures.length > 0) {
	for (const entry of failures)
		console.error(`${entry.ruleId} ${entry.path}: ${entry.remediation}`);
	process.exitCode = 1;
} else {
	console.log(
		"Withdrawal simulation verified: exact immutable identity blocked new installs through P02 while save/history remained.",
	);
	console.log(JSON.stringify(registry));
}
