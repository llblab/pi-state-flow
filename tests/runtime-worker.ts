import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createAcceptedTransition } from "../lib/history.ts";
import { TemporalRuntime } from "../lib/runtime.ts";
import { emptySnapshot } from "../lib/snapshot.ts";

// A synchronous publication fixture: the parent kills only this owned process at a proved Git seam.
const [root, cwd, point] = process.argv.slice(2);
assert.ok(root && cwd && (point === "before-ref" || point === "after-ref"));
const parent = dirname(root);
assert.equal(dirname(parent), resolve(tmpdir()));
assert.ok(basename(parent).startsWith("state-flow-shared-drift-"));
assert.equal(root, join(parent, "store"));
assert.ok(cwd === join(parent, "project") || cwd === join(parent, "other-project"));
function report(value: Record<string, unknown>): void {
	writeSync(1, `${JSON.stringify({ pid: process.pid, ...value })}\n`);
}
let armed = false;
let privateIndex: string | undefined;
const spawn = childProcess.spawnSync;
childProcess.spawnSync = ((...args: Parameters<typeof spawn>) => {
	const [command, argv, options] = args;
	const owned = armed && command === "git" && Array.isArray(argv) && argv[0] === "-C" && argv[1] === root;
	if (owned && options?.env?.GIT_INDEX_FILE && privateIndex !== options.env.GIT_INDEX_FILE) {
		privateIndex = options.env.GIT_INDEX_FILE;
		report({ event: "index", privateIndex });
	}
	const boundary = owned && argv[2] === "update-ref";
	const pause = () => {
		assert.ok(privateIndex);
		report({ event: "paused", point, privateIndex, ref: argv![3], commit: argv![4], previous: argv![5] });
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
		throw new Error("Fatal-interruption fixture exceeded its parent-owned kill window");
	};
	if (boundary && point === "before-ref") pause();
	const result = spawn(...args);
	if (boundary && point === "after-ref" && result.status === 0) pause();
	return result;
}) as typeof spawn;
syncBuiltinESMExports();
const runtime = new TemporalRuntime(cwd, "session-b-crash", root);
let snapshot = emptySnapshot(true);
snapshot.meta.remotePublication = { version: 1, mode: "off" };
const initial = runtime.initialize(snapshot, true)!;
snapshot.meta.durableBase = initial.commit;
function publish(label: string): string {
	const before = runtime.states();
	const after = structuredClone(before);
	for (const scope of ["global", "cwd", "session"] as const) after[scope].working.peer = label;
	const candidate = structuredClone(snapshot);
	candidate.meta.step++;
	const result = runtime.publish(candidate, true, createAcceptedTransition(before, after, `peer-${label}`), { pushRemote: false })!;
	assert.ok(result.commit);
	candidate.meta.durableBase = result.commit;
	snapshot = candidate;
	return result.commit;
}
report({ event: "ready", revision: publish("accepted") });
const command = await process.stdin[Symbol.asyncIterator]().next();
assert.equal(command.done, false, "Runtime fixture parent closed its control pipe");
assert.equal(command.value.toString(), "G");
process.stdin.destroy();
armed = true;
publish("unacknowledged");
throw new Error("Runtime fixture did not reach its requested publication boundary");
