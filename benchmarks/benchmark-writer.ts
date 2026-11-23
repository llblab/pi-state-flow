import { TemporalRuntime } from "../lib/runtime.ts";
import { DEFAULT_SCOPE_SELECTION } from "../lib/selection.ts";
import { emptySnapshot } from "../lib/snapshot.ts";
import { commitSelectedTransition, stageSelectedScopePatches } from "../lib/transition.ts";

// An IPC-owned synthetic publisher, not a Pi instance or a production service.
const [root, cwd, id] = process.argv.slice(2);
if (!root || !cwd || !id || !process.send) throw new Error("Benchmark writer requires an IPC parent, store, CWD, and identity");
const runtime = new TemporalRuntime(cwd, id, root);
// The parent allocates the synthetic owner and sends one command at a time; no Pi policy is attached.
const checkPolicy = () => {};
await runtime.withSelectedFirstPatchTransaction(DEFAULT_SCOPE_SELECTION, emptySnapshot("active"), tx => tx.publish(tx.snapshot), checkPolicy, undefined, true);
process.send({ ready: true });
process.on("message", async (message: { scope: "session" | "global"; round: number } | "stop") => {
	if (message === "stop") {
		process.disconnect!();
		return;
	}
	const started = performance.now();
	try {
		const step = await runtime.withSelectedPatchTransaction(tx => {
			const stage = stageSelectedScopePatches(tx, { [message.scope]: { tactics: { writer: id, round: message.round } } }, [], tx.causalBasis);
			commitSelectedTransition(tx.snapshot, tx, stage, (accepted, next) => tx.publish(next, accepted), tx.causalBasis);
			return tx.snapshot.meta.step;
		}, checkPolicy);
		process.send!({ accepted: true, ms: performance.now() - started, step });
	} catch (error) {
		process.send!({ accepted: false, ms: performance.now() - started, error: error instanceof Error ? error.message : String(error) });
	}
});
