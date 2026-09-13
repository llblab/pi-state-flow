import { startEpisode } from "../lib/episode.ts";
import { createAcceptedTransition } from "../lib/history.ts";
import { TemporalRuntime } from "../lib/runtime.ts";

// An IPC-owned synthetic publisher, not a Pi instance or a production service.
const [root, cwd, id] = process.argv.slice(2);
if (!root || !cwd || !id || !process.send) throw new Error("Benchmark writer requires an IPC parent, store, CWD, and identity");
const runtime = new TemporalRuntime(cwd, id, root);
let snapshot = startEpisode(false);
snapshot.meta.remotePublication = { version: 1, mode: "off" };
const initial = runtime.initialize(snapshot, true);
snapshot.meta.durableBase = initial?.revision ?? initial?.commit;
process.send({ ready: true });
process.on("message", (message: { scope: "session" | "global"; round: number } | "stop") => {
	if (message === "stop") {
		process.disconnect!();
		return;
	}
	const started = performance.now();
	try {
		const states = runtime.states();
		const next = structuredClone(states);
		next[message.scope].working = { writer: id, round: message.round };
		const accepted = createAcceptedTransition(states, next)!;
		const candidate = structuredClone(snapshot);
		candidate.meta.step += 1;
		const result = runtime.publish(candidate, true, accepted, { pushRemote: false });
		candidate.meta.durableBase = result?.revision ?? result?.commit ?? candidate.meta.durableBase;
		snapshot = candidate;
		process.send!({ accepted: true, ms: performance.now() - started, revision: snapshot.meta.durableBase, step: snapshot.meta.step });
	} catch (error) {
		process.send!({ accepted: false, ms: performance.now() - started, error: error instanceof Error ? error.message : String(error), revision: snapshot.meta.durableBase, step: snapshot.meta.step });
	}
});
