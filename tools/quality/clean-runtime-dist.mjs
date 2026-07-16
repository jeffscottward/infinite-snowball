import { lstat, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGES = ["engine", "input", "gameplay", "runtime-r3f"];

for (const packageName of PACKAGES) {
	const packageRoot = join(ROOT, "packages", packageName);
	const manifest = JSON.parse(
		await readFile(join(packageRoot, "package.json"), "utf8"),
	);
	if (manifest.name !== `@infinite-snowball/${packageName}`) {
		throw new Error(`Refusing to clean unexpected package: ${packageName}`);
	}
	const dist = join(packageRoot, "dist");
	try {
		const entry = await lstat(dist);
		if (entry.isSymbolicLink()) {
			throw new Error(`Refusing to remove symlinked dist: ${packageName}`);
		}
	} catch (error) {
		if (error?.code === "ENOENT") continue;
		throw error;
	}
	await rm(dist, { recursive: true, force: false });
}
