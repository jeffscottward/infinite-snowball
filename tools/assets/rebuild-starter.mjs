import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	realpath,
	rename,
	rm,
	rmdir,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildAssetBudgetReport,
	rebuildStarterContent,
	verifyStarterHashes,
} from "./lib/asset-pipeline.mjs";
import { generateProvenanceLedger } from "./lib/provenance-ledger.mjs";

const REBUILD_TRANSACTION_VERSION = 1;
const REBUILD_TRANSACTION_MAX_JOURNAL_BYTES = 4 * 1024;
const REBUILD_TRANSACTION_MAX_LOCK_BYTES = 512;
const REBUILD_TRANSACTION_JOURNAL =
	".infinite-snowball-rebuild.transaction.json";
const REBUILD_TRANSACTION_LOCK = ".infinite-snowball-rebuild.lock";
const REBUILD_TRANSACTION_RECOVERY =
	".infinite-snowball-rebuild.recovery";
const TRANSACTION_ID =
	/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

function exactObjectKeys(value, keys) {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null) &&
		JSON.stringify(Object.keys(value).sort()) ===
			JSON.stringify([...keys].sort())
	);
}

async function directoryIdentity(path) {
	const [metadata, canonicalPath] = await Promise.all([
		lstat(path),
		realpath(path),
	]);
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
		throw new Error("E_REBUILD_OUTPUT_PATH");
	}
	return { canonicalPath, dev: metadata.dev, ino: metadata.ino };
}

async function assertDirectoryIdentity(path, expected) {
	const current = await directoryIdentity(path);
	if (
		current.canonicalPath !== expected.canonicalPath ||
		current.dev !== expected.dev ||
		current.ino !== expected.ino
	) {
		throw new Error("E_REBUILD_OUTPUT_PATH");
	}
}

async function syncDirectory(path) {
	let handle;
	try {
		handle = await open(path, fsConstants.O_RDONLY);
		await handle.sync();
	} catch (error) {
		if (!["EINVAL", "ENOTSUP", "EBADF"].includes(error?.code)) throw error;
	} finally {
		await handle?.close().catch(() => {});
	}
}

function canonicalJsonBytes(value, maximum, ruleId) {
	const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
	if (bytes.length === 0 || bytes.length > maximum) throw new Error(ruleId);
	return bytes;
}

async function finishCommittedTransaction(operation, message, code) {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await operation();
			return true;
		} catch {}
	}
	process.emitWarning(message, { code });
	return false;
}

async function writeExclusiveFile(path, bytes, root, rootIdentity, ruleId) {
	await assertDirectoryIdentity(root, rootIdentity);
	let handle;
	let identity;
	try {
		handle = await open(
			path,
			fsConstants.O_CREAT |
				fsConstants.O_EXCL |
				fsConstants.O_NOFOLLOW |
				fsConstants.O_WRONLY,
			0o600,
		);
		await handle.writeFile(bytes);
		await handle.sync();
		const metadata = await handle.stat();
		if (
			!metadata.isFile() ||
			metadata.nlink !== 1 ||
			metadata.size !== bytes.length
		) {
			throw new Error(ruleId);
		}
		identity = { dev: metadata.dev, ino: metadata.ino };
	} finally {
		await handle?.close().catch(() => {});
	}
	await assertDirectoryIdentity(root, rootIdentity);
	return identity;
}

async function readCanonicalTransactionFile(path, maximum, ruleId) {
	let handle;
	try {
		try {
			handle = await open(
				path,
				fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
			);
		} catch (error) {
			if (error?.code === "ENOENT") return undefined;
			throw error;
		}
		const metadata = await handle.stat();
		if (
			!metadata.isFile() ||
			metadata.nlink !== 1 ||
			!Number.isSafeInteger(metadata.size) ||
			metadata.size <= 0 ||
			metadata.size > maximum
		) {
			throw new Error(ruleId);
		}
		const bytes = Buffer.alloc(metadata.size);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		const extra = Buffer.alloc(1);
		const { bytesRead: extraBytes } = await handle.read(
			extra,
			0,
			1,
			bytes.length,
		);
		const revalidated = await handle.stat();
		if (
			bytesRead !== bytes.length ||
			extraBytes !== 0 ||
			revalidated.dev !== metadata.dev ||
			revalidated.ino !== metadata.ino ||
			revalidated.size !== metadata.size
		) {
			throw new Error(ruleId);
		}
		let value;
		try {
			value = JSON.parse(bytes.toString("utf8"));
		} catch {
			throw new Error(ruleId);
		}
		if (!canonicalJsonBytes(value, maximum, ruleId).equals(bytes)) {
			throw new Error(ruleId);
		}
		return {
			value,
			identity: { dev: metadata.dev, ino: metadata.ino },
		};
	} catch (error) {
		if (error?.message === ruleId) throw error;
		throw new Error(ruleId, { cause: error });
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function removeOwnedFile(path, identity, root, rootIdentity, ruleId) {
	await assertDirectoryIdentity(root, rootIdentity);
	let metadata;
	try {
		metadata = await lstat(path);
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw new Error(ruleId, { cause: error });
	}
	if (
		metadata.isSymbolicLink() ||
		!metadata.isFile() ||
		metadata.nlink !== 1 ||
		metadata.dev !== identity.dev ||
		metadata.ino !== identity.ino
	) {
		throw new Error(ruleId);
	}
	await rm(path);
	await assertDirectoryIdentity(root, rootIdentity);
}

function rebuildTransactionNames(transactionId) {
	return {
		transactionRoot: `.tmp-infinite-snowball-${transactionId}`,
		contentStage: "content",
		contentBackup: "previous-content",
	};
}

function validRebuildJournal(value) {
	if (
		!exactObjectKeys(value, [
			"version",
			"transactionId",
			"transactionRoot",
			"contentStage",
			"contentBackup",
			"hadContent",
		]) ||
		value.version !== REBUILD_TRANSACTION_VERSION ||
		typeof value.transactionId !== "string" ||
		!TRANSACTION_ID.test(value.transactionId) ||
		typeof value.hadContent !== "boolean"
	) {
		return false;
	}
	const expected = rebuildTransactionNames(value.transactionId);
	return (
		value.transactionRoot === expected.transactionRoot &&
		value.contentStage === expected.contentStage &&
		value.contentBackup === expected.contentBackup
	);
}

function validRebuildLock(value) {
	return (
		exactObjectKeys(value, ["version", "pid", "transactionId"]) &&
		value.version === REBUILD_TRANSACTION_VERSION &&
		Number.isSafeInteger(value.pid) &&
		value.pid > 0 &&
		value.pid <= 2_147_483_647 &&
		typeof value.transactionId === "string" &&
		TRANSACTION_ID.test(value.transactionId)
	);
}

function processIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error?.code === "ESRCH") return false;
		if (error?.code === "EPERM") return true;
		throw new Error("E_REBUILD_TRANSACTION_LOCK", { cause: error });
	}
}

async function cleanupDirectory(path) {
	try {
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
			throw new Error("E_REBUILD_OUTPUT_PATH");
		}
		await rm(path, { recursive: true, force: true });
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
}

async function rebuildTransactionTestHook(options, root) {
	if (options.transactionTestHook === undefined) return undefined;
	if (typeof options.transactionTestHook !== "function") {
		throw new Error("E_REBUILD_TEST_HOOK");
	}
	if (!basename(await realpath(root)).startsWith(".tmp-infinite-snowball-")) {
		throw new Error("E_REBUILD_TEST_HOOK");
	}
	return options.transactionTestHook;
}

async function existingDirectory(path) {
	try {
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
			throw new Error("E_REBUILD_OUTPUT_PATH");
		}
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

async function recoverRebuildJournal({
	root,
	rootIdentity,
	contentRoot,
}) {
	const journalPath = join(root, REBUILD_TRANSACTION_JOURNAL);
	const journal = await readCanonicalTransactionFile(
		journalPath,
		REBUILD_TRANSACTION_MAX_JOURNAL_BYTES,
		"E_REBUILD_TRANSACTION_JOURNAL",
	);
	if (journal === undefined) return undefined;
	if (!validRebuildJournal(journal.value)) {
		throw new Error("E_REBUILD_TRANSACTION_JOURNAL");
	}
	const names = rebuildTransactionNames(journal.value.transactionId);
	const transactionRoot = join(root, names.transactionRoot);
	const stagedContentRoot = join(transactionRoot, names.contentStage);
	const previousContentRoot = join(transactionRoot, names.contentBackup);
	try {
		const [backupExists, stageExists, contentExists] = await Promise.all([
			existingDirectory(previousContentRoot),
			existingDirectory(stagedContentRoot),
			existingDirectory(contentRoot),
		]);
		if (backupExists) {
			if (!journal.value.hadContent) {
				throw new Error("E_REBUILD_TRANSACTION_JOURNAL");
			}
			if (contentExists) await cleanupDirectory(contentRoot);
			await assertDirectoryIdentity(root, rootIdentity);
			await rename(previousContentRoot, contentRoot);
		} else if (journal.value.hadContent) {
			if (!contentExists) {
				throw new Error("E_REBUILD_TRANSACTION_JOURNAL");
			}
		} else if (contentExists) {
			if (stageExists) {
				throw new Error("E_REBUILD_TRANSACTION_JOURNAL");
			}
			await cleanupDirectory(contentRoot);
		}
		if (stageExists) await cleanupDirectory(stagedContentRoot);
		await syncDirectory(root);
		await generateProvenanceLedger({ root, contentRoot });
		await cleanupDirectory(transactionRoot);
		await removeOwnedFile(
			journalPath,
			journal.identity,
			root,
			rootIdentity,
			"E_REBUILD_TRANSACTION_JOURNAL",
		);
		await syncDirectory(root);
		return journal.value.transactionId;
	} catch (error) {
		if (error?.message === "E_REBUILD_TRANSACTION_JOURNAL") throw error;
		throw new Error("E_REBUILD_TRANSACTION_JOURNAL", { cause: error });
	}
}

async function acquireRebuildLock({
	root,
	rootIdentity,
	contentRoot,
	hook,
}) {
	const lockPath = join(root, REBUILD_TRANSACTION_LOCK);
	const recoveryPath = join(root, REBUILD_TRANSACTION_RECOVERY);
	const recoveryClaimError = (cause) =>
		new Error(
			"E_REBUILD_TRANSACTION_LOCK: recovery claim present; inspect the fixed journal and lock before manual removal",
			cause === undefined ? undefined : { cause },
		);

	async function recoveryClaimExists() {
		try {
			await lstat(recoveryPath);
			return true;
		} catch (error) {
			if (error?.code === "ENOENT") return false;
			throw recoveryClaimError(error);
		}
	}

	async function createLock() {
		const transactionId = randomUUID();
		const identity = await writeExclusiveFile(
			lockPath,
			canonicalJsonBytes(
				{
					version: REBUILD_TRANSACTION_VERSION,
					pid: process.pid,
					transactionId,
				},
				REBUILD_TRANSACTION_MAX_LOCK_BYTES,
				"E_REBUILD_TRANSACTION_LOCK",
			),
			root,
			rootIdentity,
			"E_REBUILD_TRANSACTION_LOCK",
		);
		await syncDirectory(root);
		return { path: lockPath, transactionId, identity };
	}

	if (await recoveryClaimExists()) throw recoveryClaimError();
	try {
		return await createLock();
	} catch (error) {
		if (error?.code !== "EEXIST") {
			if (error?.message === "E_REBUILD_TRANSACTION_LOCK") throw error;
			throw new Error("E_REBUILD_TRANSACTION_LOCK", { cause: error });
		}
	}
	const stale = await readCanonicalTransactionFile(
		lockPath,
		REBUILD_TRANSACTION_MAX_LOCK_BYTES,
		"E_REBUILD_TRANSACTION_LOCK",
	);
	if (stale === undefined || !validRebuildLock(stale.value)) {
		throw new Error("E_REBUILD_TRANSACTION_LOCK");
	}
	if (processIsAlive(stale.value.pid)) {
		throw new Error("E_REBUILD_TRANSACTION_LOCK");
	}

	let recoveryIdentity;
	try {
		await assertDirectoryIdentity(root, rootIdentity);
		await mkdir(recoveryPath, { mode: 0o700 });
		recoveryIdentity = await directoryIdentity(recoveryPath);
		await assertDirectoryIdentity(root, rootIdentity);
	} catch (error) {
		throw recoveryClaimError(error);
	}

	await hook?.("after-recovery-claim");
	await assertDirectoryIdentity(recoveryPath, recoveryIdentity);
	await recoverRebuildJournal({ root, rootIdentity, contentRoot });
	await assertDirectoryIdentity(recoveryPath, recoveryIdentity);
	await cleanupDirectory(
		join(
			root,
			rebuildTransactionNames(stale.value.transactionId).transactionRoot,
		),
	);
	await assertDirectoryIdentity(recoveryPath, recoveryIdentity);
	await removeOwnedFile(
		lockPath,
		stale.identity,
		root,
		rootIdentity,
		"E_REBUILD_TRANSACTION_LOCK",
	);
	await syncDirectory(root);

	let fresh;
	try {
		fresh = await createLock();
		await assertDirectoryIdentity(recoveryPath, recoveryIdentity);
		await assertDirectoryIdentity(root, rootIdentity);
		await rmdir(recoveryPath);
		await assertDirectoryIdentity(root, rootIdentity);
		await syncDirectory(root);
	} catch (error) {
		throw recoveryClaimError(error);
	}
	return fresh;
}

async function releaseRebuildLock(lock, root, rootIdentity) {
	await removeOwnedFile(
		lock.path,
		lock.identity,
		root,
		rootIdentity,
		"E_REBUILD_TRANSACTION_LOCK",
	);
	await syncDirectory(root);
}

function validationError(hashes, budget) {
	const issues = [...hashes.issues, ...budget.issues]
		.map((entry) => `${entry.ruleId} ${entry.path}`)
		.join("\n");
	return new Error(`Starter rebuild failed closed:\n${issues}`);
}

export async function runRebuildStarter(options = {}) {
	const root = await realpath(resolve(options.root ?? process.cwd()));
	const rootIdentity = await directoryIdentity(root);
	const contentRoot = join(root, "content");
	const hook = await rebuildTransactionTestHook(options, root);
	const lock = await acquireRebuildLock({
		root,
		rootIdentity,
		contentRoot,
		hook,
	});
	const names = rebuildTransactionNames(lock.transactionId);
	const transactionRoot = join(root, names.transactionRoot);
	const stagedContentRoot = join(transactionRoot, names.contentStage);
	const previousContentRoot = join(transactionRoot, names.contentBackup);
	const journalPath = join(root, REBUILD_TRANSACTION_JOURNAL);
	let hadContent = false;
	let contentBackedUp = false;
	let contentInstalled = false;
	let provenanceCommitted = false;
	let journalIdentity;
	let journalCleared = false;
	let committed = false;

	try {
		await recoverRebuildJournal({ root, rootIdentity, contentRoot });
		await hook?.("after-recovery");
		await assertDirectoryIdentity(root, rootIdentity);
		await mkdir(transactionRoot, { mode: 0o700 });
		const transactionRootIdentity = await directoryIdentity(transactionRoot);
		const build = await rebuildStarterContent({
			root,
			outputRoot: stagedContentRoot,
		});
		const hashes = await verifyStarterHashes({
			root,
			contentRoot: stagedContentRoot,
		});
		const budget = await buildAssetBudgetReport({
			root,
			contentRoot: stagedContentRoot,
		});
		if (!hashes.ok || !budget.ok) throw validationError(hashes, budget);

		hadContent = await existingDirectory(contentRoot);
		journalIdentity = await writeExclusiveFile(
			journalPath,
			canonicalJsonBytes(
				{
					version: REBUILD_TRANSACTION_VERSION,
					transactionId: lock.transactionId,
					...names,
					hadContent,
				},
				REBUILD_TRANSACTION_MAX_JOURNAL_BYTES,
				"E_REBUILD_TRANSACTION_JOURNAL",
			),
			root,
			rootIdentity,
			"E_REBUILD_TRANSACTION_JOURNAL",
		);
		await syncDirectory(root);

		await assertDirectoryIdentity(root, rootIdentity);
		await assertDirectoryIdentity(transactionRoot, transactionRootIdentity);
		if (hadContent) {
			await rename(contentRoot, previousContentRoot);
			contentBackedUp = true;
			await hook?.("after-content-backup");
		}
		await rename(stagedContentRoot, contentRoot);
		contentInstalled = true;
		await hook?.("after-content-install");

		const ledger = await generateProvenanceLedger({ root, contentRoot });
		provenanceCommitted = true;
		await hook?.("after-provenance");
		await removeOwnedFile(
			journalPath,
			journalIdentity,
			root,
			rootIdentity,
			"E_REBUILD_TRANSACTION_JOURNAL",
		);
		journalCleared = true;
		committed = true;
		return { build, ledger, hashes, budget };
	} catch (error) {
		if (contentInstalled) {
			await cleanupDirectory(contentRoot);
			contentInstalled = false;
		}
		if (contentBackedUp) {
			await assertDirectoryIdentity(root, rootIdentity);
			await rename(previousContentRoot, contentRoot);
			contentBackedUp = false;
		}
		await syncDirectory(root);
		if (provenanceCommitted) {
			await generateProvenanceLedger({ root, contentRoot });
		}
		if (journalIdentity !== undefined) {
			await removeOwnedFile(
				journalPath,
				journalIdentity,
				root,
				rootIdentity,
				"E_REBUILD_TRANSACTION_JOURNAL",
			);
			await syncDirectory(root);
			journalCleared = true;
		}
		throw error;
	} finally {
		if (committed) {
			const cleanupComplete = await finishCommittedTransaction(
				async () => {
					await syncDirectory(root);
					await hook?.("before-postcommit-cleanup");
					await cleanupDirectory(transactionRoot);
					await syncDirectory(root);
				},
				"Committed rebuild cleanup was deferred.",
				"E_REBUILD_POSTCOMMIT_CLEANUP",
			);
			if (cleanupComplete) {
				await finishCommittedTransaction(
					async () => {
						await hook?.("before-lock-release");
						await releaseRebuildLock(lock, root, rootIdentity);
					},
					"Committed rebuild cleanup was deferred.",
					"E_REBUILD_POSTCOMMIT_CLEANUP",
				);
			}
		} else {
			if (journalCleared || journalIdentity === undefined) {
				await cleanupDirectory(transactionRoot);
			}
			await releaseRebuildLock(lock, root, rootIdentity);
		}
	}
}

const directEntry =
	process.argv[1] === undefined
		? undefined
		: await realpath(resolve(process.argv[1])).catch(() => undefined);
const moduleEntry = await realpath(fileURLToPath(import.meta.url));
if (directEntry === moduleEntry) {
	const { build, ledger, budget } = await runRebuildStarter();
	console.log(
		`Starter content rebuilt: ${Object.keys(build.files).length} files, ${ledger.records} provenance records, ${budget.totals.bytes} bytes, ${budget.totals.triangles} triangles, config ${build.configSha256}.`,
	);
}
