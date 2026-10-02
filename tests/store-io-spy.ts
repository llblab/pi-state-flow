import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";

/** Spy after fixture setup, including negative reads and publication/directory operations. */
export async function withoutStoreIO(t: TestContext, root: string, action: () => Promise<void>, cleanupPaths: readonly string[] = []): Promise<void> {
	const calls: string[] = [];
	for (const name of ["existsSync", "lstatSync", "statSync", "readFileSync", "openSync", "mkdirSync", "writeFileSync", "renameSync", "unlinkSync", "rmSync", "readdirSync"] as const) {
		const original = fs[name] as (...args: any[]) => any;
		t.mock.method(fs, name, (...args: any[]) => {
			// Only release of an already-owned protocol mutex is exempt, never namespace probes.
			if (cleanupPaths.includes(args[0]) && ["lstatSync", "readFileSync", "rmSync", "unlinkSync"].includes(name)) return original(...args);
			if (typeof args[0] === "string" && (args[0] === root || args[0].startsWith(`${root}/`))) calls.push(`${name}: ${args[0]}`);
			return original(...args);
		});
	}
	syncBuiltinESMExports();
	try {
		await action();
		assert.deepEqual(calls, [], "Off lifecycle must not even probe the semantic store");
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
}
