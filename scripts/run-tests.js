import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../build-test/test");
const testFiles = readdirSync(testDirectory)
	.filter((file) => file.endsWith(".test.js"))
	.sort()
	.map((file) => resolve(testDirectory, file));

if (testFiles.length === 0) {
	throw new Error(`No compiled test files found in ${testDirectory}.`);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], { stdio: "inherit" });
if (result.error) {
	throw result.error;
}

process.exitCode = result.status ?? 1;
