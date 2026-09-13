import fs, { readSync, writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { acquirePublicationWorkerLease } from "../lib/publication.ts";

// A bounded test child: seed a lease and exit, or pause one real observation/removal.
const [queue, mode, owner, pauseAt = "dead"] = process.argv.slice(2);
if (!queue || (mode !== "seed" && mode !== "claim")) throw new Error("Lease fixture requires a queue path and seed/claim mode");
const report = (event: string, detail: Record<string, unknown> = {}) => {
	writeSync(1, `${JSON.stringify({ event, pid: process.pid, ...detail })}\n`);
};
function proceed(): void {
	if (readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw new Error("Lease fixture parent closed its control pipe");
}
if (mode === "claim" && pauseAt === "dead") {
	const deadOwner = Number(owner);
	const kill = process.kill.bind(process);
	let paused = false;
	process.kill = (pid, signal) => {
		try { return kill(pid, signal); }
		catch (error) {
			if (!paused && pid === deadOwner && signal === 0 && (error as NodeJS.ErrnoException).code === "ESRCH") {
				paused = true;
				report("observed-dead", { owner: pid });
				proceed();
			}
			throw error;
		}
	};
}
if (mode === "claim" && pauseAt === "removed") {
	const remove = fs.rmSync;
	let paused = false;
	fs.rmSync = (path, options) => {
		remove(path, options);
		if (!paused && path === `${queue}.worker.lock`) {
			paused = true;
			report("removed");
			proceed();
		}
	};
	syncBuiltinESMExports();
}
const lease = acquirePublicationWorkerLease(queue);
report("result", { granted: lease !== undefined, token: lease?.token });
if (mode === "claim" && lease) {
	proceed();
	lease.release();
	report("released");
}
