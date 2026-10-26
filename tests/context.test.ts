import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as observationFixture from "./observation-fixture.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { acceptedStateUpdates, ContextProjection, contextView, createPassiveContinuation, currentRunTrajectory, lazyNavigationHint, passiveContinuationMessages, passiveContextHead, projectSystemProtocol, runtimeContextHead, runtimeContextMessage, semanticModuleMessages, syntheticUser, moduleConversationSource, projectModuleContext, type ContextView } from "../lib/context.ts";
import { loadSessionState } from "./temporal-fixture.ts";
import { completeRun, startEpisode } from "../lib/episode.ts";
import { emptyState, overlayStates, projectStateForModel, type MaterializedState, type ScopedSemanticStates, type SemanticState, type StateScope } from "../lib/state.ts";
import type { ScopeSelection } from "../lib/selection.ts";
import type { RecentTransitionWindow } from "../lib/history.ts";
import { stageAtomicScopePatches } from "../lib/transition.ts";
import { applyPatch, isJsonValue, type JsonValue } from "../lib/json.ts";
import type { SemanticModule } from "../lib/semantic-module.ts";
import { commitScopedTerminal, commitTerminal, harness, start, toolAssistant, user } from "./harness.ts";

const message = (role: string, text: string, timestamp: number, customType?: string) => ({
	role,
	content: [{ type: "text", text }],
	timestamp,
	...(customType ? { customType } : {}),
}) as any;

test("public module context replaces only admitted completed whole tool units and preserves current foreign identities", () => {
	const oldUser = user("old", 1), call = fauxAssistantMessage(fauxToolCall("read", { path: "/old" }, { id: "old-unit" }));
	const result: AgentMessage = { role: "toolResult", toolCallId: "old-unit", toolName: "read", content: [{ type: "text", text: "old result" }], isError: false, timestamp: 1 };
	const current = user("current", 2), foreign = { role: "custom", customType: "foreign", content: "keep" } as unknown as AgentMessage;
	const original = [foreign, oldUser, call, result, current], snapshot = structuredClone(original);
	const source = moduleConversationSource(original, 2); assert.deepEqual(source.conversation, [oldUser, call, result]); assert.equal(source.prompt, "current");
	const module = { id: "x_window", scope: "session" as const, contributions: [{ kind: "data" as const, value: { summary: "fallible" } }, { kind: "conversation" as const, messages: [call, result] }] };
	const projected = projectModuleContext(original, original, source.conversation, [module]);
	assert.equal(projected[0], foreign); assert.equal(projected.at(-1), current);
	assert.equal(projected.filter(value => value === call).length, 1); assert.equal(projected.filter(value => value === result).length, 1); assert.equal(projected.includes(oldUser), false);
	assert.equal(projected[1]!.role, "user"); assert.deepEqual(original, snapshot);
	for (const messages of [[call], [result], [current]]) assert.throws(() => projectModuleContext(original, original, source.conversation, [{ ...module, contributions: [{ kind: "conversation", messages }] }]), /tool result|admitted source/);
	assert.throws(() => projectModuleContext(original, original, source.conversation, [module, { ...module, id: "x_other" }]), /exclusive/);
	assert.throws(() => projectModuleContext(original, original, source.conversation, [{ ...module, scope: "cwd" }]), /exclusive/);
	assert.ok(projectModuleContext(original, original, source.conversation, [{ ...module, contributions: [{ kind: "data", value: {} }] }]).includes(oldUser), "data alone never drops completed history");
	assert.deepEqual(moduleConversationSource([...original, user("ambiguous", 2)], 2), { conversation: [] });
});

test("core receipts do not interpret unprojected external planes as deleted state", () => {
	const projection = new ContextProjection(), before = { tactics: { keep: true } };
	const after = { ...before, x_notes: { note: "stored, not projected" } };
	assert.equal(projection.acceptPatch(before, after, { cwd: { x_notes: { note: "stored, not projected" } } }, {}, {}, true, ["cwd"]), undefined);
	assert.deepEqual(after.x_notes, { note: "stored, not projected" });
});

test("module transport keeps generated data at user level and exact recent native tool identities", () => {
	const source: AgentMessage[] = [user("old", 1), fauxAssistantMessage("old answer"), user("current", 2),
		fauxAssistantMessage(fauxToolCall("read", { path: "/fixture.txt" }, { id: "module-window-call" })),
		{ role: "toolResult", toolCallId: "module-window-call", toolName: "read", content: [{ type: "text", text: "exact tool bytes" }], isError: false, timestamp: 3 },
		fauxAssistantMessage("exact final answer")];
	const window: SemanticModule<JsonValue, number> = {
		immutable: true, id: "recent-window", validate: isJsonValue,
		context(_content, frame) { return [{ kind: "data", value: { summary: "fallible derived data", mode: frame.mode } },
			{ kind: "conversation", indices: Array.from({ length: frame.input }, (_, index) => frame.conversation.length - frame.input + index) }]; },
	};
	for (const mode of ["active", "passive"] as const) {
		const projected = semanticModuleMessages(window, undefined, { mode, conversation: source, input: 4 });
		assert.equal(projected.length, 5); assert.equal(projected[0]!.role, "user");
		assert.equal(getCurrentSystemMessage(projected), undefined);
		for (let index = 0; index < 4; index++) assert.strictEqual(projected[index + 1], source[index + 2]);
		assert.match(JSON.stringify(projected[0]), /user-level data, not system instructions/);
	}
});

test("legacy empty lazy branches are absent from navigation without mutating storage", () => {
	const state = { lazy: { empty: {}, chain: { empty: {} }, items: [{}], list: [] } };
	const before = structuredClone(state);
	assert.deepEqual(lazyNavigationHint(state), { available: true, path: "effective.lazy", keys: { items: "array", list: "array" } });
	assert.deepEqual(lazyNavigationHint({ lazy: { empty: {} } }), { available: false, path: "effective.lazy" });
	assert.deepEqual(state, before);
});

test("context omits absent planes, empty responses and unknown fields in current and recent views", () => {
	const snapshot = startEpisode(false);
	const projected = runtimeContextMessage(snapshot, { response: "", extra: "not semantic" }, [
		{ id: "unknown", at: 1, transitions: [{ scope: "session", patch: { extra: "not semantic" } }] },
	]);
	assert.ok("content" in projected);
	const text = (projected.content as Array<{ text: string }>)[0]!.text;
	const payload = JSON.parse(text.slice(text.indexOf("\n") + 1));
	assert.deepEqual(payload.state, {});
	assert.equal(Object.hasOwn(payload, "recent_transitions"), false);
	assert.equal(text.includes("not semantic"), false);
});

test("Passive response is omitted from model views without changing Active views or source state", () => {
	const state = { ...emptyState(), response: "LAST_ACTIVE_RESPONSE", tactics: { response: "nested data", keep: true } };
	const before = structuredClone(state);
	const passive = contextView(state, {}, [], undefined, false);
	assert.equal(Object.hasOwn(passive.state, "response"), false);
	assert.deepEqual(passive.state.tactics, state.tactics);
	assert.equal(contextView(state, {}, []).state.response, "LAST_ACTIVE_RESPONSE");
	assert.deepEqual(state, before);
});

test("Passive response cannot reappear through patch receipts or frozen reconciliation tails", () => {
	const projection = new ContextProjection();
	const before = { ...emptyState(), response: "OLD_RESPONSE", tactics: { own: 0, peer: 0 } };
	const native = [user("passive run", 1)];
	const first = projection.project(native, contextView(before, {}, [], undefined, false), () => user("PASSIVE HEAD", 0));
	const after = { ...before, response: "NEW_RESPONSE", tactics: { own: 1, peer: 2 } };
	const patch = { session: { tactics: { own: 1 } } };
	const receipt = projection.acceptPatch(before, after, patch, {}, {}, false);
	assert.deepEqual(receipt?.effective, [{ path: ["tactics", "peer"], value: 2 }]);
	const next = projection.project([...native, message("toolResult", "accepted", 2)],
		contextView(after, {}, [], undefined, false), () => { throw Error("head rewritten"); });
	assert.equal(next[0], first[0]);
	assert.equal(JSON.stringify(next).includes("NEW_RESPONSE"), false);
	const drifted = { ...after, response: "LATER_RESPONSE", tactics: { own: 1, peer: 3 } };
	const later = projection.project([...native, message("toolResult", "accepted", 2)],
		contextView(drifted, {}, [], undefined, false), () => { throw Error("head rewritten"); });
	assert.ok(JSON.stringify(later).startsWith(JSON.stringify(next).slice(0, -1)));
	assert.equal(JSON.stringify(later).includes("LATER_RESPONSE"), false);
	const notice = JSON.parse((later.at(-1) as any).content[0].text.split("\n")[1]);
	assert.deepEqual(notice.state_updates.effective, [{ path: ["tactics", "peer"], value: 3 }]);
});

test("Passive response is absent from Stop handoffs while native answer text stays exact", () => {
	const state = { ...emptyState(), response: "LAST_ACTIVE_RESPONSE", tactics: { keep: true } };
	const before = structuredClone(state);
	for (const preserveContext of [false, true]) {
		const continuation = createPassiveContinuation(state, 20, 10, preserveContext);
		assert.equal(Object.hasOwn(continuation.state, "response"), false);
		assert.equal(JSON.stringify(continuation.handoff).includes("LAST_ACTIVE_RESPONSE"), false);
		const native = [user("run", 10), message("assistant", "LAST_ACTIVE_RESPONSE", 11)];
		const projected = passiveContinuationMessages(native, continuation);
		assert.equal(projected.at(-1), native.at(-1), "this is not transcript redaction");
	}
	assert.deepEqual(state, before);
});

test("frozen projection appends changing state and notices without moving earlier tail positions", () => {
	const projection = new ContextProjection();
	const initial = emptyState();
	const native = [user("run", 1)];
	let heads = 0;
	const head = () => { heads++; return user(`HEAD-${heads}`, 0); };
	const first = projection.project(native, contextView(initial, {}, [], "new-bootstrap"), head);
	const changed = { ...initial, tactics: { external: true }, artifacts: { "/source": { description: "card" } } };
	const result = message("toolResult", "evidence", 2);
	const invalidations = [{ path: "/source", reason: "source-changed" as const }];
	const second = projection.project([...native, result], contextView(changed, { "/source": "read again" }, invalidations, "resume-bootstrap"), head);
	assert.equal(second[0], first[0]);
	assert.ok(JSON.stringify(second).startsWith(JSON.stringify(first).slice(0, -1)));
	const notice = second.at(-1)!;
	const noticeData = JSON.parse((notice as any).content[0].text.split("\n")[1]);
	assert.deepEqual(noticeData.artifact_invalidations, invalidations);
	assert.deepEqual(noticeData.knowledge_rehydration, { phase: "resume-bootstrap" });
	assert.match(JSON.stringify(noticeData.state_updates), /external/);
	assert.match(JSON.stringify(noticeData.state_updates), /read again/);
	const later = message("assistant", "continue", 3);
	const third = projection.project([...native, result, later], contextView(changed, {}, [], undefined), head);
	assert.ok(JSON.stringify(third).startsWith(JSON.stringify(second).slice(0, -1)), "prior notice stays before new native messages");
	assert.equal(third[3], notice);
	const cleared = JSON.parse((third.at(-1) as any).content[0].text.split("\n")[1]);
	assert.deepEqual(cleared.state_updates.effective, [{ path: ["artifacts", "/source", "hint"], deleted: true }]);
	assert.deepEqual(cleared.artifact_invalidations, []);
	assert.equal(cleared.knowledge_rehydration, null);
	const stable = projection.project([...native, result, later], contextView(changed, {}, []), head);
	assert.deepEqual(stable, third, "unchanged inference emits no notice or timestamp churn");
	assert.equal(heads, 1);
	projection.reset();
	const reset = projection.project([user("new boundary", 4)], contextView(changed, {}, []), head);
	assert.equal(heads, 2);
	assert.equal(reset.length, 2, "reset drops obsolete notices");
	projection.project([user("native replacement", 5)], contextView(changed, {}, []), head);
	assert.equal(heads, 3, "a replaced native prefix is a cache boundary");
});

test("patch receipts include all unseen drift and prevent duplicate synthetic state notices", () => {
	const projection = new ContextProjection();
	const start = { ...emptyState(), tactics: { shared: "head" } };
	const messages = [user("run", 1)];
	const first = projection.project(messages, contextView(start, {}, []), () => user("HEAD", 0));
	const cache = { ...emptyState(), tactics: { shared: "adopted before patch" } };
	const after = { ...cache, tactics: { ...cache.tactics, own: true } };
	const updates = projection.acceptPatch(cache, after, { session: { tactics: { own: true } } }, {});
	assert.deepEqual(updates?.effective, [{ path: ["tactics", "shared"], value: "adopted before patch" }]);
	const result = message("toolResult", JSON.stringify(updates), 2);
	const next = projection.project([...messages, result], contextView(after, {}, []), () => { throw new Error("head rewritten"); });
	assert.deepEqual(next, [...first, result]);
	assert.ok(JSON.stringify(first[0]).includes(updates!.projection), "receipt is bound to its frozen head");
	projection.reset();
	const rebased = projection.project([...messages, result, user("resume", 3)], contextView(after, {}, []), () => user("FRESH HEAD", 0));
	assert.equal(JSON.stringify(rebased[0]).includes(updates!.projection), false, "retained receipts cannot override a new head");
	assert.equal(rebased[2], result, "old native evidence remains inspectable");
});

test("predictable direct leaves need no receipt while masked values remain conservative", () => {
	for (const scope of ["global", "cwd", "session"] as const) {
		const projection = new ContextProjection();
		const before = { ...emptyState(), tactics: { known: "old", sibling: 1 } };
		projection.project([user("run", 1)], contextView(before, {}, []), () => user("HEAD", 0));
		const after = { ...before, tactics: { known: "new", sibling: 1 } };
		assert.equal(projection.acceptPatch(before, after, { [scope]: { tactics: { known: "new" } } }, {}), undefined);
		assert.equal(projection.acceptPatch(after, after, { [scope]: { tactics: { known: "new" } } }, {}), undefined);
		assert.deepEqual(projection.project([user("run", 1), message("toolResult", "accepted", 2)], contextView(after, {}, []), () => { throw Error("head changed"); }).length, 3);
	}
	const projection = new ContextProjection();
	const before = { ...emptyState(), tactics: { known: "old" } };
	projection.project([user("run", 1)], contextView(before, {}, []), () => user("HEAD", 0));
	const masked = { ...before, tactics: { known: "masked" } };
	assert.deepEqual(projection.acceptPatch(before, masked, { global: { tactics: { known: "requested" } } }, {})?.effective,
		[{ path: ["tactics", "known"], value: "masked" }]);
});

test("coalesced object additions and replacements omit exact authored values but retain drift", () => {
	const patch = { session: { tactics: { fresh: { nested: { a: 1 }, label: "new" } } } };
	for (const tactics of [{}, { fresh: "old" }, { fresh: { nested: "old", label: "old" } }]) {
		const before = { ...emptyState(), tactics } as MaterializedState;
		const after = applyPatch(before, patch.session) as MaterializedState;
		const projection = new ContextProjection();
		const native = [user("object", 1)];
		const first = projection.project(native, contextView(before, {}, []), () => user("HEAD", 0));
		assert.equal(projection.acceptPatch(before, after, patch, {}), undefined);
		assert.deepEqual(projection.project(native, contextView(after, {}, []), () => { throw Error("head rewritten"); }), first,
			"accepted object advances the projection without a synthetic echo");
	}
	const before = emptyState();
	const projection = new ContextProjection();
	projection.project([user("object", 1)], contextView(before, {}, []), () => user("HEAD", 0));
	const drifted = { ...before, tactics: { fresh: { ...patch.session.tactics.fresh, external: true } } };
	assert.deepEqual(projection.acceptPatch(before, drifted, patch, {})?.effective,
		[{ path: ["tactics", "fresh"], value: drifted.tactics.fresh }], "coalescing cannot hide a foreign sibling");
	const overlapping = new ContextProjection();
	overlapping.project([user("object", 1)], contextView(before, {}, []), () => user("HEAD", 0));
	assert.ok(overlapping.acceptPatch(before, applyPatch(before, patch.session) as MaterializedState,
		{ ...patch, global: { tactics: { fresh: { label: "other" } } } }, {})?.effective.length,
		"overlapping object writes remain conservative until scope precedence is proven");
});

test("indexed array writes use numeric paths only for a communicated array basis", () => {
	const before = { ...emptyState(), tactics: { rows: [{ name: "old", keep: true }], literal: { "[0]": "old" } } };
	const patch = { session: { tactics: { rows: { "[0]": { name: "new" } }, literal: { "[0]": "new" } } } };
	const after = { ...before, tactics: { rows: [{ name: "new", keep: true }], literal: { "[0]": "new" } } };
	const projection = new ContextProjection();
	projection.project([user("index", 1)], contextView(before, {}, []), () => user("HEAD", 0));
	assert.equal(projection.acceptPatch(before, after, patch, {}), undefined,
		"array selector and literal object key both resolve to their known paths");
	const stale = new ContextProjection();
	stale.project([user("index", 1)], contextView(before, {}, []), () => user("HEAD", 0));
	const masked = { ...before, tactics: { ...after.tactics, rows: [{ name: "masked", keep: true }] } };
	assert.deepEqual(stale.acceptPatch(before, masked, patch, {})?.effective,
		[{ path: ["tactics", "rows", 0, "name"], value: "masked" }]);
	const overlap = new ContextProjection();
	overlap.project([user("index", 1)], contextView(before, {}, []), () => user("HEAD", 0));
	assert.equal(overlap.acceptPatch(before, after, {
		global: { tactics: { rows: { "[0]": { name: "other" } } } }, session: patch.session,
	}, {}), undefined, "the explicit Session scalar wins over a lower-scope write at the known array path");
	const noHead = new ContextProjection();
	assert.deepEqual(noHead.acceptPatch(before, after, patch, {})?.effective,
		[{ path: ["tactics", "rows", 0, "name"], value: "new" }], "unknown communicated array basis stays conservative");
});

test("lazy navigation omits only predictable key/kind additions, never hidden bodies", () => {
	const before = { ...emptyState(), lazy: { known: { secret: "OLD" } } };
	const after = { ...before, lazy: { known: { secret: "OLD" }, fresh: { secret: "HIDDEN" } } };
	const patch = { session: { lazy: { fresh: { secret: "HIDDEN" } } } };
	const exact = new ContextProjection();
	exact.project([user("lazy", 1)], contextView(before, {}, []), () => user("HEAD", 0));
	assert.equal(exact.acceptPatch(before, after, patch, {}), undefined);
	const drift = new ContextProjection();
	drift.project([user("lazy", 1)], contextView(before, {}, []), () => user("HEAD", 0));
	const drifted = { ...after, lazy: { ...after.lazy, foreign: "surprise" } };
	const notice = drift.acceptPatch(before, drifted, patch, {});
	assert.deepEqual(notice?.lazy_navigation?.keys, { known: "object", fresh: "object", foreign: "string" });
	assert.doesNotMatch(JSON.stringify(notice), /HIDDEN|OLD|surprise/);
	const fallback = new ContextProjection();
	fallback.project([user("lazy", 1)], contextView(before, {}, []), () => user("HEAD", 0));
	const removed = emptyState();
	assert.deepEqual(fallback.acceptPatch(before, removed, { session: { lazy: { known: null } } }, {})?.lazy_navigation,
		{ available: false, path: "effective.lazy" });
	const overlap = new ContextProjection();
	overlap.project([user("lazy", 1)], contextView(before, {}, []), () => user("HEAD", 0));
	assert.deepEqual(overlap.acceptPatch(before, after, { global: { lazy: { fresh: "wrong" } }, session: patch.session }, {})?.lazy_navigation?.keys,
		{ known: "object", fresh: "object" });
});

test("artifact prediction failure cannot reject an accepted scoped array update", () => {
	const global = { ...emptyState(), artifacts: { "/card": { description: "global", rows: [1, 2] } } };
	const session = { ...emptyState(), artifacts: { "/card": { description: "session", rows: [9] } } };
	const before = overlayStates(global, session);
	const patch = { global: { artifacts: { "/card": { description: "global", rows: { "[1]": 3 } } } } };
	const after = overlayStates(applyPatch(global, patch.global) as MaterializedState, session);
	const projection = new ContextProjection();
	projection.project([user("masked array", 1)], contextView(before, {}, []), () => user("HEAD", 0));
	assert.deepEqual(projection.acceptPatch(before, after, patch, {})?.effective,
		[{ path: ["artifacts", "/card"], value: after.artifacts["/card"] }]);
	assert.equal(projection.project([user("masked array", 1)], contextView(after, {}, []), () => { throw Error("head rewritten"); }).length, 2,
		"accepted view advances without a duplicate notice");
});

test("artifact semantic merges omit only the result derivable from the communicated card", () => {
	const before = { ...emptyState(), artifacts: { "/card": { description: "old", kind: "report", compilation: { format: "text", version: 1 } } } };
	const patch = { session: { artifacts: { "/card": { description: "new", compilation: { version: 2 } } } } };
	const after = { ...before, artifacts: { "/card": { description: "new", kind: "report", compilation: { format: "text", version: 2 } } } };
	const exact = new ContextProjection();
	exact.project([user("merge", 1)], contextView(before, {}, []), () => user("HEAD", 0));
	assert.equal(exact.acceptPatch(before, after, patch, {}), undefined);
	const drift = new ContextProjection();
	drift.project([user("merge", 1)], contextView(before, {}, []), () => user("HEAD", 0));
	const changed = { ...after, artifacts: { "/card": { ...after.artifacts["/card"], kind: "surprise" } } };
	assert.deepEqual(drift.acceptPatch(before, changed, patch, {})?.effective,
		[{ path: ["artifacts", "/card"], value: changed.artifacts["/card"] }]);
});

test("artifact card receipts distinguish exact semantic replacements from hint and concurrent drift", () => {
	const card = { description: "new", hash: "retired-provenance", compiled_at: "retired-time" };
	const before = emptyState();
	const after = { ...before, artifacts: { "/card": { ...card } } };
	const patch = { session: { artifacts: { "/card": card } } };
	const exact = new ContextProjection();
	exact.project([user("card", 1)], contextView(before, {}, []), () => user("HEAD", 0));
	assert.equal(exact.acceptPatch(before, after, patch, {}), undefined);
	const hinted = new ContextProjection();
	hinted.project([user("card", 1)], contextView(before, {}, []), () => user("HEAD", 0));
	assert.deepEqual(hinted.acceptPatch(before, after, patch, { "/card": "source changed" })?.effective,
		[{ path: ["artifacts", "/card"], value: { description: "new", hint: "source changed" } }]);
	const retainedHint = new ContextProjection();
	const existing = { ...before, artifacts: { "/card": { description: "new" } } };
	retainedHint.project([user("card", 1)], contextView(existing, { "/card": "requires refresh" }, []), () => user("HEAD", 0));
	assert.equal(retainedHint.acceptPatch(existing, existing, patch, { "/card": "requires refresh" }), undefined,
		"a no-op artifact patch cannot echo an already communicated runtime hint");
	const stableHint = new ContextProjection();
	const oldCard = { ...before, artifacts: { "/card": { description: "old", kind: "report" } } };
	const semanticPatch = { session: { artifacts: { "/card": { description: "new" } } } };
	const newCard = { ...before, artifacts: { "/card": { description: "new", kind: "report" } } };
	stableHint.project([user("card", 1)], contextView(oldCard, { "/card": "requires refresh" }, []), () => user("HEAD", 0));
	assert.equal(stableHint.acceptPatch(oldCard, newCard, semanticPatch, { "/card": "requires refresh" }), undefined,
		"a known unchanged hint is retained through the predictable semantic merge");
	const changedHint = new ContextProjection();
	changedHint.project([user("card", 1)], contextView(oldCard, { "/card": "requires refresh" }, []), () => user("HEAD", 0));
	assert.deepEqual(changedHint.acceptPatch(oldCard, newCard, semanticPatch, { "/card": "read again" })?.effective,
		[{ path: ["artifacts", "/card"], value: { description: "new", kind: "report", hint: "read again" } }]);
	const lostHint = new ContextProjection();
	lostHint.project([user("card", 1)], contextView({ ...before, artifacts: { "/card": { description: "old" } } },
		{ "/card": "requires refresh" }, []), () => user("HEAD", 0));
	assert.deepEqual(lostHint.acceptPatch(before, after, patch, {})?.effective,
		[{ path: ["artifacts", "/card"], value: { description: "new" } }], "removing a runtime hint is model-visible surprise");
	const drift = new ContextProjection();
	drift.project([user("card", 1)], contextView(before, {}, []), () => user("HEAD", 0));
	const changed = { ...before, artifacts: { "/card": { description: "concurrent" } } };
	assert.deepEqual(drift.acceptPatch(before, changed, patch, {})?.effective,
		[{ path: ["artifacts", "/card"], value: { description: "concurrent" } }]);
	const nav = new ContextProjection();
	nav.project([user("card", 1)], contextView(before, {}, []), () => user("HEAD", 0));
	const lazy = { ...after, lazy: { hidden: { secret: "DO-NOT-LEAK" } } };
	const notice = nav.acceptPatch(before, lazy, { session: { artifacts: { "/card": card }, lazy: { hidden: lazy.lazy.hidden } } }, {});
	assert.equal(notice, undefined, "both projected card and lazy navigation are predictable");
});

test("explicit Session replacements dominate lower-scope overlap without hiding drift", () => {
	for (const lower of [2, 3, null, { nested: true }]) {
		for (const upper of [2, [1, 2]]) {
			const before = { ...emptyState(), tactics: { x: 1, untouched: "old" } };
			const after = { ...before, tactics: { x: upper, untouched: "old" } };
			const patch = { global: { tactics: { x: lower } }, session: { tactics: { x: upper } } };
			const projection = new ContextProjection();
			projection.project([user("overlap", 1)], contextView(before, {}, []), () => user("HEAD", 0));
			assert.equal(projection.acceptPatch(before, after, patch, {}), undefined);
			const drifted = { ...after, tactics: { x: upper, untouched: "foreign" } };
			assert.deepEqual(projection.acceptPatch(after, drifted, patch, {})?.effective,
				[{ path: ["tactics", "untouched"], value: "foreign" }]);
		}
	}
	const before = { ...emptyState(), tactics: { x: 1 } };
	const projection = new ContextProjection();
	projection.project([user("overlap", 1)], contextView(before, {}, []), () => user("HEAD", 0));
	assert.deepEqual(projection.acceptPatch(before, { ...before, tactics: { x: 4 } },
		{ global: { tactics: { x: 2 } }, session: { tactics: { x: 3 } } }, {})?.effective,
		[{ path: ["tactics", "x"], value: 4 }], "mismatching acceptance must still reconcile");
});

test("multi-scope disjoint writes omit echoes while overlapping writes remain conservative", () => {
	const projection = new ContextProjection();
	const initial = { ...emptyState(), tactics: { shared: "old", project: "old", private: "old", collision: "old", masked: "old" } };
	projection.project([user("cohort", 1)], contextView(initial, {}, []), () => user("HEAD", 0));
	const patches = {
		global: { tactics: { shared: "new", collision: "global", masked: "requested" } },
		cwd: { tactics: { project: "new", collision: "cwd" } },
		session: { tactics: { private: "new", collision: null } },
	};
	const after = { ...initial, tactics: { shared: "new", project: "new", private: "new", collision: "cwd", masked: "unexpected", foreign: 2 } };
	assert.deepEqual(projection.acceptPatch(initial, after, patches, {})?.effective, [
		{ path: ["tactics", "collision"], value: "cwd" },
		{ path: ["tactics", "masked"], value: "unexpected" },
		{ path: ["tactics", "foreign"], value: 2 },
	]);
	const isolated = new ContextProjection();
	isolated.project([user("cohort", 1)], contextView(initial, {}, []), () => user("HEAD", 0));
	assert.equal(isolated.acceptPatch(initial, { ...initial, tactics: { ...initial.tactics, shared: "new", project: "new", private: "new" } },
		{ global: { tactics: { shared: "new", absent: null } }, cwd: { tactics: { project: "new" } }, session: { tactics: { private: "new" } } }, {}), undefined);
});

test("deletion receipts omit only unchanged effective values, not unknown fallback or independent removals", () => {
	for (const scope of ["global", "cwd", "session"] as const) {
		const projection = new ContextProjection();
		const visible = { ...emptyState(), tactics: { retained: "same", other: "before" } };
		projection.project([user("delete", 1)], contextView(visible, {}, []), () => user("HEAD", 0));
		const patch = { [scope]: { tactics: { absent: null, retained: null } } };
		assert.equal(projection.acceptPatch(visible, visible, patch, {}), undefined,
			"masked/no-op deletion reveals no new effective information");
		const changed = { ...visible, tactics: { retained: "unexpected fallback" } };
		assert.deepEqual(projection.acceptPatch(visible, changed, patch, {})?.effective, [
			{ path: ["tactics", "retained"], value: "unexpected fallback" },
			{ path: ["tactics", "other"], deleted: true },
		]);
	}
	const projection = new ContextProjection();
	const visible = { ...emptyState(), tactics: { owned: "visible" } };
	projection.project([user("delete", 1)], contextView(visible, {}, []), () => user("HEAD", 0));
	const removed = emptyState();
	assert.deepEqual(projection.acceptPatch(visible, removed, { session: { tactics: { owned: null } } }, {})?.effective,
		[{ path: ["tactics"], deleted: true }], "effective-only head cannot prove the deleted key's scope owner");
});

test("intent ownership cascades reach the receipt as deletions without rewriting the frozen head", () => {
	for (const scope of ["global", "cwd", "session"] as const) {
		const scopes = { global: emptyState(), cwd: emptyState(), session: emptyState() } as ScopedSemanticStates;
		scopes[scope] = { ...emptyState(),
			intents: { task: { owns: [{ $ref: `${scope}.tactics.step` }, { $ref: `${scope}.lazy.plan` }, { $ref: `${scope}.lazy.plans.x` }] } },
			tactics: { step: "draft", kept: "shared" }, lazy: { plan: { body: "HIDDEN" }, plans: { x: "HIDDEN-NESTED", y: "kept" }, notes: "kept" } };
		const before = overlayStates(scopes.global, scopes.cwd, scopes.session);
		const projection = new ContextProjection();
		const native = [user("close", 1)];
		const first = projection.project(native, contextView(before, {}, []), () => user(JSON.stringify(before.tactics), 0));
		const head = JSON.stringify(first[0]);
		const patch = { [scope]: { intents: { task: null } } };
		const stage = stageAtomicScopePatches(scopes, patch, [], "origin");
		const next = stage.nextStates;
		const after = overlayStates(next.global, next.cwd, next.session);
		const updates = projection.acceptPatch(before, after, patch, {}, stage.cascades);
		assert.ok(updates, scope);
		assert.deepEqual(updates.effective.filter(({ path }) => path[0] === "tactics"), [{ path: ["tactics", "step"], deleted: true }], scope);
		assert.deepEqual(updates.lazy_navigation?.keys, { plans: "object", notes: "string" }, scope);
		assert.deepEqual(updates.cascaded, [`${scope}.lazy.plan`, `${scope}.lazy.plans.x`, `${scope}.tactics.step`], scope);
		assert.deepEqual(next[scope].lazy, { plans: { y: "kept" }, notes: "kept" });
		assert.doesNotMatch(JSON.stringify(updates), /HIDDEN|draft/);
		const later = projection.project([...native, message("toolResult", JSON.stringify(updates), 2)], contextView(after, {}, []),
			() => { throw new Error("head rewritten"); });
		assert.equal(JSON.stringify(later[0]), head, "the frozen head still shows the pre-cascade values");
		assert.match(JSON.stringify(later[0]), /draft/);
	}
});

test("nested lazy cascade-only receipts survive predictable-write omission in deterministic scope order", () => {
	const scopes = { global: emptyState(), cwd: emptyState(), session: emptyState() } as ScopedSemanticStates;
	for (const scope of ["global", "cwd", "session"] as const) scopes[scope] = {
		...emptyState(), intents: { [`task_${scope}`]: { $ref: `${scope}.lazy.plans.x` } }, lazy: { plans: { x: "HIDDEN", y: "kept" } },
	};
	const before = overlayStates(scopes.global, scopes.cwd, scopes.session);
	const projection = new ContextProjection();
	// Communicated intent is already absent: every effective change is predictable/masked.
	projection.project([user("close", 1)], contextView({ ...before, intents: {} }, {}, []), () => user("HEAD", 0));
	const patch = { session: { intents: { task_session: null } }, cwd: { intents: { task_cwd: null } }, global: { intents: { task_global: null } } };
	const stage = stageAtomicScopePatches(scopes, patch, [], "origin");
	const after = overlayStates(stage.nextStates.global, stage.nextStates.cwd, stage.nextStates.session);
	const receipt = projection.acceptPatch(before, after, patch, {}, stage.cascades);
	assert.ok(receipt);
	assert.deepEqual(receipt.effective, []);
	assert.equal(receipt.lazy_navigation, undefined);
	assert.deepEqual(receipt.cascaded, ["global.lazy.plans.x", "cwd.lazy.plans.x", "session.lazy.plans.x"]);
	assert.doesNotMatch(JSON.stringify(receipt), /HIDDEN|kept/);
	assert.equal(projection.acceptPatch(after, after, patch, {}), undefined, "no repeat cascade notice");
});

test("cascade receipts describe the owner even when effective state reveals a fallback", () => {
	const scopes: ScopedSemanticStates = {
		global: { ...emptyState(), tactics: { draft: "global fallback" } }, cwd: emptyState(),
		session: { ...emptyState(), intents: { task: { $ref: "session.tactics.draft" } }, tactics: { draft: "private" } },
	};
	const before = overlayStates(scopes.global, scopes.cwd, scopes.session);
	const projection = new ContextProjection();
	projection.project([user("close", 1)], contextView(before, {}, []), () => user("HEAD", 0));
	const patch = { session: { intents: { task: null } } };
	const stage = stageAtomicScopePatches(scopes, patch, [], "origin");
	const after = overlayStates(stage.nextStates.global, stage.nextStates.cwd, stage.nextStates.session);
	const receipt = projection.acceptPatch(before, after, patch, {}, stage.cascades);
	assert.deepEqual(receipt?.cascaded, ["session.tactics.draft"]);
	assert.ok(receipt?.effective.some((entry) => JSON.stringify(entry) === JSON.stringify({ path: ["tactics", "draft"], value: "global fallback" })));
	const noCascade = projection.acceptPatch(after, { ...after, tactics: { draft: "foreign drift" } }, {}, {});
	assert.ok(noCascade);
	assert.equal(Object.hasOwn(noCascade, "cascaded"), false);
});

test("a frozen Stop handoff receives changes made before its first projection", () => {
	const projection = new ContextProjection();
	const initial = contextView(emptyState(), {}, []);
	const current = contextView({ ...emptyState(), tactics: { afterStop: true } }, {}, []);
	const result = projection.project([user("continue", 1)], current, () => user("FROZEN HANDOFF", 0), initial);
	assert.match(JSON.stringify(result.at(-1)), /afterStop/);
});

test("accepted updates project effective touched values, deletions and adopted drift without unrelated state", () => {
	const global = { ...emptyState(), tactics: { fallback: "global", masked: "global", other: "unchanged", removed: true } };
	const session = { ...emptyState(), tactics: { fallback: "session", masked: "private", rows: [{ name: "old", keep: true }] } };
	const before = overlayStates(global, session);
	const patches = { session: { tactics: { fallback: null, rows: { "[0]": { name: "new" } }, absent: null } }, global: { tactics: { masked: "accepted-shared" } } };
	const nextGlobal = applyPatch(global, { tactics: { foreign: "adopted", masked: "accepted-shared", removed: null } }) as MaterializedState;
	const nextSession = applyPatch(session, patches.session) as MaterializedState;
	const after = overlayStates(nextGlobal, nextSession);
	const result = acceptedStateUpdates(before, after, patches);
	assert.deepEqual(result, { effective: [
		{ path: ["tactics", "fallback"], value: "global" },
		{ path: ["tactics", "removed"], deleted: true },
		{ path: ["tactics", "rows", 0, "name"], value: "new" },
		{ path: ["tactics", "foreign"], value: "adopted" },
		{ path: ["tactics", "absent"], deleted: true },
		{ path: ["tactics", "masked"], value: "private" },
	] });
	assert.doesNotMatch(JSON.stringify(result), /unchanged|accepted-shared|"keep"/);
});

test("accepted updates coalesce replacements, preserve key identity and detach values", () => {
	const before = { ...emptyState(), tactics: { rows: [1, 2], shape: { old: true } } };
	const patch = JSON.parse('{"tactics":{"rows":[{"next":true}],"shape":"scalar","__proto__":{"safe":true},"a.b":{"[0]":"literal"}}}');
	const after = applyPatch(before, patch) as MaterializedState;
	const result = acceptedStateUpdates(before, after, { session: patch });
	assert.deepEqual(result.effective, [
		{ path: ["tactics", "rows"], value: [{ next: true }] },
		{ path: ["tactics", "shape"], value: "scalar" },
		{ path: ["tactics", "__proto__"], value: { safe: true } },
		{ path: ["tactics", "a.b"], value: { "[0]": "literal" } },
	]);
	(result.effective[0] as { value: any }).value[0].next = false;
	assert.deepEqual(after.tactics.rows, [{ next: true }]);
	assert.deepEqual(patch.tactics.rows, [{ next: true }]);
	assert.deepEqual(acceptedStateUpdates(after, after, { session: { tactics: { shape: "scalar", absent: null } } }).effective, [
		{ path: ["tactics", "shape"], value: "scalar" }, { path: ["tactics", "absent"], deleted: true },
	]);
});

test("accepted update projection excludes lazy bodies and artifact provenance even on whole replacements", () => {
	const before = { ...emptyState(), lazy: { old: { secret: "OLD-LAZY" } }, artifacts: { "/card": { description: "old", obsolete: true } } };
	const after = { ...emptyState(), lazy: { fresh: [{ secret: "NEW-LAZY" }] }, artifacts: { "/card": { description: "new", hash: "SECRET-HASH", compiler: "SECRET-COMPILER", compiled_at: "SECRET-TIME" } } };
	const result = acceptedStateUpdates(before, after, { session: { lazy: { old: null, fresh: after.lazy.fresh }, artifacts: after.artifacts } });
	assert.deepEqual(result, { effective: [{ path: ["artifacts", "/card"], value: { description: "new" } }],
		lazy_navigation: { available: true, path: "effective.lazy", keys: { fresh: "array" } } });
	assert.doesNotMatch(JSON.stringify(result), /SECRET|OLD-LAZY|NEW-LAZY|obsolete/);
	const changedBody = { ...after, lazy: { fresh: [{ secret: "CHANGED" }] } };
	assert.deepEqual(acceptedStateUpdates(after, changedBody, { session: { lazy: changedBody.lazy } }), { effective: [] });
});

test("refreshes only owned system protocol without mutating native frames", () => {
	for (const tailProtocol of ["OLD-TAIL", null]) for (const protocol of [undefined, "PASSIVE", "ACTIVE"]) {
		const head = { role: "system" as const, content: "FOREIGN-HEAD", sections: { state_flow: "OLD-HEAD", foreign: "KEEP" }, toolsAdded: [], timestamp: 1 };
		const request = user("USER-DATA", 2);
		const tail = { role: "system" as const, content: "FOREIGN-TAIL", sections: { state_flow: tailProtocol, foreign_tail: "KEEP-TAIL" }, toolsRemoved: [], timestamp: 3 };
		const reply = message("assistant", "UNFINISHED", 4);
		const messages: AgentMessage[] = [head, request, tail, reply];
		const before = structuredClone(messages);
		for (const frame of [head, tail]) { Object.freeze(frame.sections); Object.freeze(frame); }
		Object.freeze(messages);
		const projected = projectSystemProtocol(messages, protocol);
		const current = getCurrentSystemMessage(projected)!;
		assert.equal(current.sections?.state_flow, protocol === undefined ? undefined : `<state_flow>\n${protocol}\n</state_flow>`);
		assert.equal(current.sections?.foreign, "KEEP");
		assert.equal(current.sections?.foreign_tail, "KEEP-TAIL");
		assert.equal(current.content, "FOREIGN-HEAD\n\nFOREIGN-TAIL");
		assert.equal(projected[1], request);
		assert.equal(projected[3], reply);
		assert.deepEqual(projected.map((frame) => [frame.role, frame.timestamp]), messages.map((frame) => [frame.role, frame.timestamp]));
		assert.deepEqual(messages, before);
		assert.equal(projectSystemProtocol(projected, protocol), projected, "unchanged protocol reuses the projection");
		assert.ok(projected[0]?.role === "system" && projected[2]?.role === "system");
		assert.equal(projected[0].toolsAdded, head.toolsAdded);
		assert.equal(projected[2].toolsRemoved, tail.toolsRemoved);
	}
	const conversation = [user("No native system frame", 1)];
	assert.equal(projectSystemProtocol(conversation, "ACTIVE"), conversation, "projection must not invent native system authority");
	const alreadyCurrent: AgentMessage[] = [{ role: "system", content: "", sections: { state_flow: "<state_flow>\nACTIVE\n</state_flow>" }, timestamp: 1 }, user("request", 2), { role: "system", content: "foreign update", timestamp: 3 }];
	assert.equal(projectSystemProtocol(alreadyCurrent, "ACTIVE"), alreadyCurrent, "do not relocate an unchanged section over native deltas");
});

test("ordinary context derives compact lineage from cached runtime without Git queries", async () => {
	const h = harness();
	await start(h, "Continue");
	await commitTerminal(h, {}, { verified: true }, "Accepted");
	await h.beginRun("Continue");
	const spawn = childProcess.spawnSync;
	childProcess.spawnSync = (() => { throw new Error("Ordinary inference queried a process"); }) as typeof spawn;
	syncBuiltinESMExports();
	try {
		for (let inference = 0; inference < 2; inference++) {
			const projected = h.handlers.get("context")!({ messages: [user("Continue", 1)] });
			const text = projected.messages[0].content[0].text;
			assert.match(text, /recent_transitions/);
			assert.match(text, /"verified":true/);
			assert.equal(h.readState().tactics.verified, true);
			assert.equal(h.readState(1).tactics.verified, true);
		}
	} finally {
		childProcess.spawnSync = spawn;
		syncBuiltinESMExports();
	}
});

test("enabled context projects the complete overlay once in ordinary and bootstrap runs", async (t) => {
	const observations: Array<{ bootstrap: boolean; bytes: number; copies: number }> = [];
	for (const bootstrap of [false, true]) for (const bytes of [8192, 1048576]) {
		const h = harness();
		if (bootstrap) h.entries.push({ type: "message", message: user("Existing request", 1) });
		await start(h, "Current request");
		await h.tools.get("patch_state")!.execute("seed-context", {
			global: { strategy: { globalContext: true } },
			cwd: { strategy: { cwdContext: true } },
			session: {
				tactics: { contextPayload: "x".repeat(bytes) },
				intents: { current: { action: "Continue accepted work", detail: { $ref: "session.lazy.plan" } } },
				lazy: { plan: { steps: ["hidden until read"] } },
				artifacts: { "/context/source": { description: "Retained route", compilation: { decision: "Keep semantic metadata" } } },
			},
		}, undefined, undefined, h.ctx);
		await h.beginRun("Current request");
		const state = h.readState();
		const snapshot = h.resolveSnapshot();
		assert.equal(snapshot.meta.bootstrap === true, bootstrap);
		const entries = structuredClone(h.entries);
		const persistent = message("custom", "policy", 0, "foreign-policy");
		const old = user("Existing request", 1);
		const current = user("Current request", 2);
		const messages = [persistent, old, current];
		const originalMessages = structuredClone(messages);
		const clone = globalThis.structuredClone;
		let copies = 0;
		const observedClone = t.mock.method(globalThis, "structuredClone", <T>(value: T, options?: Parameters<typeof clone>[1]): T => {
			const candidate = value as Partial<MaterializedState> | null | undefined;
			if (candidate?.strategy?.globalContext === true && candidate.strategy.cwdContext === true
				&& typeof candidate.tactics?.contextPayload === "string") copies++;
			return clone(value, options);
		});
		let projected;
		try { projected = h.handlers.get("context")!({ messages }); }
		finally { observedClone.mock.restore(); }
		const text = projected.messages[0].content[0].text as string;
		const serialized = text.slice(text.indexOf("\n") + 1);
		const context = JSON.parse(serialized);
		assert.match(serialized, /"state":\{"intents":.*,"strategy":.*,"tactics":.*,"artifacts":/);
		const { response: _emptyResponse, ...visibleState } = state;
		if (Object.keys(visibleState.artifacts).length === 0) delete (visibleState as Partial<typeof visibleState>).artifacts;
		assert.deepEqual(context.state, visibleState);
		assert.deepEqual(context.state.intents.current, { action: "Continue accepted work", detail: { $ref: "session.lazy.plan" } });
		assert.equal(Object.hasOwn(context.state, "lazy"), false);
		assert.deepEqual(projected.messages.slice(1), bootstrap ? [persistent, old, current] : [persistent, current]);
		context.state.tactics.contextPayload = "caller mutation";
		assert.deepEqual(h.readState(), state);
		assert.deepEqual(h.resolveSnapshot(), snapshot);
		assert.deepEqual(h.entries, entries);
		assert.deepEqual(messages, originalMessages);
		observations.push({ bootstrap, bytes, copies });
	}
	assert.deepEqual(observations, [false, true].flatMap((bootstrap) => [8192, 1048576].map((bytes) => ({ bootstrap, bytes, copies: 1 }))));
});

test("current run trajectory allocates no arrays of discarded ordinary history", () => {
	const observations: Array<{ pairs: number; allocatedLengths: number[]; retained: number }> = [];
	for (const pairs of [0, 200]) {
		const persistent = message("custom", "policy", 0, "foreign-policy");
		const prefix = [persistent];
		for (let index = 0; index < pairs; index++) prefix.push(user(`Old request ${index}`, index + 2), message("assistant", `Old answer ${index}`, index + 2));
		const current = user("Current request", 1000);
		const call = toolAssistant("current-read");
		const result = { role: "toolResult", toolCallId: "current-read", toolName: "read", content: [{ type: "text", text: "Current evidence" }], timestamp: 1001 } as AgentMessage;
		const foreign = message("custom", "current policy", 1002, "foreign-current");
		const steering = user("Refinement", 1003);
		const messages: AgentMessage[] = [...prefix, current, call as AgentMessage, result, foreign, steering];
		const original = structuredClone(messages);
		const allocated: AgentMessage[][] = [];
		// Observe source-derived slice/filter arrays without replacing global Array methods.
		class ObservedMessages extends Array<AgentMessage> {
			constructor(length: number) { super(length); allocated.push(this); }
		}
		Object.defineProperty(messages, "constructor", { value: { [Symbol.species]: ObservedMessages } });
		const trajectory = currentRunTrajectory(messages, "Current request", current.timestamp);
		const expected = [persistent, current, call, result, foreign, steering];
		assert.deepEqual([...trajectory.messages], expected);
		assert.ok(trajectory.messages.every((item, index) => item === expected[index]), "retained native messages must keep identity and order");
		assert.equal(trajectory.anchorTimestamp, current.timestamp);
		assert.deepEqual([...messages], original);
		observations.push({ pairs, allocatedLengths: allocated.map((items) => items.length), retained: expected.length });
	}
	assert.ok(observations.every(({ allocatedLengths, retained }) => allocatedLengths.reduce((sum, length) => sum + length, 0) <= retained), JSON.stringify(observations));
});

test("projects the current run and persistent custom context", () => {
	const persistent = message("custom", "policy", 1, "policy");
	const first = user("current", 3);
	const later = user("current", 5);
	const steering = user("refinement", 6);
	const messages = [persistent, user("old", 2), first, later, steering];
	for (const [specification, anchor, expected, timestamp] of [
		["current", 3, [persistent, first, later, steering], 3],
		["current", undefined, messages, undefined],
		["current", 99, messages, undefined],
		["current", NaN, messages, undefined],
		["current", Infinity, messages, undefined],
		["missing", 3, [persistent, first, later, steering], 3],
		["missing", undefined, messages, undefined],
		["refinement", undefined, [persistent, steering], 6],
	] as const) {
		const result = currentRunTrajectory(messages, specification, anchor);
		assert.deepEqual(result.messages, expected);
		assert.equal(result.anchorTimestamp, timestamp);
	}
	const collision = [persistent, user("old", 2), first, user("Different text at the same timestamp", 3), steering];
	assert.deepEqual(currentRunTrajectory(collision, "current", 3), { messages: collision }, "text equality cannot disambiguate a colliding captured identity");
	const noUser = [persistent, message("assistant", "retained", 7)];
	assert.deepEqual(currentRunTrajectory(noUser, "missing", undefined), { messages: noUser });
	assert.deepEqual(currentRunTrajectory([], "missing", undefined), { messages: [] });
	assert.deepEqual(currentRunTrajectory([first, user("", 8)], "", undefined), { messages: [user("", 8)], anchorTimestamp: 8 });
});

test("captured run identity retains normalized user content, image, tools and steering", () => {
	const persistent = message("custom", "Persistent foreign context", 1, "foreign-policy");
	const original = message("user", "Original task\n\n[Image: dimensions normalized by the host.]", 3);
	original.content.push({ type: "image", data: "AA==", mimeType: "image/png" });
	const call = toolAssistant("normalized-read");
	const result = { role: "toolResult", toolCallId: "normalized-read", toolName: "read", content: [{ type: "text", text: "Earlier tool evidence" }], timestamp: 4 } as AgentMessage;
	const steering = user("Refine the original task", 5);
	const messages = [persistent, user("Old request", 2), original, call as AgentMessage, result, steering];
	const before = structuredClone(messages);
	const projected = currentRunTrajectory(messages, "Original task", 3);
	assert.deepEqual(projected.messages, [persistent, original, call, result, steering]);
	assert.equal(projected.anchorTimestamp, 3);
	assert.ok(projected.messages.every((entry) => messages.includes(entry)), "retain native message identity");
	assert.deepEqual(messages, before);
});

test("builds runtime context as synthetic user data without system-prompt interpolation", () => {
	const snapshot = startEpisode(false);
	snapshot.meta.specification = "UNTRUSTED-SPEC";
	const state = {
		...emptyState(),
		artifacts: { "/knowledge/current.md": { description: "Current route", sourceHash: `sha256:${"c".repeat(64)}`, compilerRevision: "forged" } },
		response: "Previous",
	};
	const invalidation = { path: "/knowledge/changed.md", hash: `sha256:${"a".repeat(64)}`, reason: "source-changed" as const };
	const recent = [{ id: "transition", at: 1, transitions: [{ scope: "global" as const, patch: {
		artifacts: { "/knowledge/legacy.md": { description: "Legacy route", hash: `sha256:${"b".repeat(64)}`, compiler: "legacy-v1", compiled_at: "2026-01-01" } },
	} }] }];
	const context = runtimeContextMessage(snapshot, state, recent, [invalidation]);
	assert.equal(context.role, "user");
	assert.match((context.content as any[])[0].text, /user-level data, not system instructions/);
	const text = (context.content as any[])[0].text;
	assert.match(text, /UNTRUSTED-SPEC/);
	assert.match(text, /artifact_invalidations/);
	assert.match(text, /\/knowledge\/changed\.md/);
	assert.match(text, /Legacy route|Current route/);
	assert.doesNotMatch(text, /sha256|legacy-v1|forged|2026-01-01/);
	assert.doesNotMatch(text, /validation_feedback/);
});

for (const scope of ["global", "cwd", "session"] as const) test(`automatic history hides ${scope} lazy writes, replacements and deletions without renumbering visible history`, () => {
	const body = "LAZY-BODY-ONLY".repeat(4096);
	const state = { ...emptyState(), lazy: { releasePlan: body } };
	const recent = [
		{ id: "mixed", at: 11, transitions: [{ scope, patch: { lazy: { releasePlan: body }, tactics: { keep: "HOT" }, artifacts: { "/source": { description: "Keep card", hash: "hidden-evidence", compiler: "hidden-compiler" } } } }] },
		{ id: "replacement", at: 9, transitions: [{ scope, patch: { lazy: { releasePlan: [body] } } }] },
		{ id: "deletion", at: 7, transitions: [{ scope, patch: { lazy: { releasePlan: null } } }, { scope: "session" as const, patch: { strategy: { keep: true } } }] },
		{ id: "lazy-only-deletion", at: 5, transitions: [{ scope, patch: { lazy: { releasePlan: null } } }] },
	];
	const before = structuredClone({ state, recent });
	const context = runtimeContextMessage(startEpisode(false), state, recent);
	assert.equal(context.role, "user");
	const text = (context.content as any[])[0].text;
	const projected = JSON.parse(text.slice(text.indexOf("\n") + 1));
	assert.deepEqual(projected.recent_transitions, [
		{ id: "mixed", at: 11, transitions: [{ scope, patch: { tactics: { keep: "HOT" }, artifacts: { "/source": { description: "Keep card" } } } }] },
		{ id: "deletion", at: 7, transitions: [{ scope: "session", patch: { strategy: { keep: true } } }] },
	]);
	assert.deepEqual(projected.lazy_navigation, { available: true, path: "effective.lazy", keys: { releasePlan: "string" } });
	assert.doesNotMatch(text, /LAZY-BODY-ONLY|hidden-evidence|hidden-compiler/);
	assert.deepEqual({ state, recent }, before, "visibility filtering cannot mutate the supplied history or current state");
	const onlyLazy = runtimeContextMessage(startEpisode(false), state, [recent[1]!, recent[3]!]);
	assert.equal(onlyLazy.role, "user");
	assert.doesNotMatch((onlyLazy.content as any[])[0].text, /recent_transitions|LAZY-BODY-ONLY/);
});

test("automatic history filtering does not redact previously seen lazy text from specification or response", () => {
	const snapshot = startEpisode(true);
	snapshot.meta.specification = "Already communicated LAZY-BODY";
	const state = { ...emptyState(), response: "Accepted LAZY-BODY", lazy: { body: "LAZY-BODY" } };
	const recent = [{ id: "answer", at: 3, transitions: [{ scope: "session" as const, patch: { response: "Historical LAZY-BODY", lazy: { body: "LAZY-BODY" } } }] }];
	const message = runtimeContextMessage(snapshot, state, recent);
	assert.equal(message.role, "user");
	const text = (message.content as any[])[0].text;
	const projected = JSON.parse(text.slice(text.indexOf("\n") + 1));
	assert.equal(projected.specification, snapshot.meta.specification);
	assert.equal(projected.state.response, state.response);
	assert.deepEqual(projected.recent_transitions[0].transitions[0].patch, { response: "Historical LAZY-BODY" });
});

test("projects accepted memory without resurrecting a completed specification for boundary continuation", () => {
	const snapshot = startEpisode(false);
	snapshot.meta.specification = "Completed original task";
	completeRun(snapshot);
	const state = { ...emptyState(), tactics: { accepted: true }, response: "Accepted answer", lazy: { detail: "not projected" } };
	const before = structuredClone({ snapshot, state });
	const context = runtimeContextMessage(snapshot, state);
	assert.equal(context.role, "user");
	const text = (context.content as any[])[0].text as string;
	const projected = JSON.parse(text.slice(text.indexOf("\n") + 1));
	assert.equal(Object.hasOwn(projected, "specification"), false);
	assert.equal(projected.state.tactics.accepted, true);
	assert.equal(projected.state.response, "Accepted answer");
	assert.equal(Object.hasOwn(projected.state, "lazy"), false);
	assert.doesNotMatch(text, /Completed original task|not projected/);
	assert.deepEqual({ snapshot, state }, before);
	const messages = [user("Earlier request", 1), user("Original run", 2), message("custom", "Boundary continuation", 3, "foreign-continuation")];
	assert.deepEqual(currentRunTrajectory(messages, undefined, undefined).messages, messages, "no specification or native capture must preserve available context");
	assert.deepEqual(currentRunTrajectory(messages, undefined, 2).messages, messages.slice(1), "the native run anchor remains usable without a specification");
});

test("projects bounded lazy navigation without hydrating lazy bodies or partial catalogs", () => {
	const state = { ...emptyState(), lazy: {
		memory: ["private body"], rules: { preserve: true }, enabled: false, count: 3, empty: null,
	} };
	assert.deepEqual(lazyNavigationHint(state), {
		available: true,
		path: "effective.lazy",
		keys: { memory: "array", rules: "object", enabled: "boolean", count: "number", empty: "null" },
	});
	const snapshot = startEpisode(false);
	snapshot.meta.specification = "Navigate";
	const context = runtimeContextMessage(snapshot, state);
	const text = ((context as any).content as any[])[0].text as string;
	const projected = JSON.parse(text.slice(text.indexOf("\n") + 1));
	assert.deepEqual(projected.lazy_navigation, lazyNavigationHint(state));
	assert.equal(Object.hasOwn(projected.state, "lazy"), false);
	assert.doesNotMatch(text, /private body|preserve/);

	const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key-${index}`, index]));
	assert.deepEqual(lazyNavigationHint({ ...emptyState(), lazy: tooMany }), {
		available: true, path: "effective.lazy",
	});
	assert.deepEqual(lazyNavigationHint(emptyState()), {
		available: false, path: "effective.lazy",
	});
});

test("passive projection retains the active run, later results, steering, and foreign context without completed history", () => {
	const persistent = message("custom", "Persistent policy", 1, "foreign-policy");
	const active = message("user", "Active request", 10);
	const call = toolAssistant("pending");
	const foreign = message("custom", "Current policy", 11, "foreign-current");
	const result = { role: "toolResult", toolCallId: "pending", toolName: "read", content: [{ type: "text", text: "Late result" }], timestamp: 21 } as any;
	const steering = message("user", "Refinement", 22);
	const continuation = createPassiveContinuation(emptyState(), 20, active.timestamp);
	const prefix = [persistent, message("user", "Completed request", 2), message("assistant", "Completed answer", 3)];
	assert.deepEqual(passiveContinuationMessages([...prefix, active, foreign, call], continuation), [continuation.handoff, persistent, active, foreign, call]);
	assert.deepEqual(passiveContinuationMessages([...prefix, active, foreign, call, result, steering], continuation), [continuation.handoff, persistent, active, foreign, call, result, steering]);
	assert.deepEqual(passiveContinuationMessages([persistent, steering], continuation), [continuation.handoff, persistent, steering], "an unavailable raw anchor must not reconstruct discarded entries");
});

for (const boundary of ["missing", "ambiguous", "nonfinite"] as const) test(`passive Stop preserves available native context for the ${boundary} active boundary`, () => {
	const persistent = message("custom", "Persistent foreign context", 1, "foreign-policy");
	const summary = { role: "compactionSummary", summary: "Native summary of the split turn", tokensBefore: 6000, timestamp: 15 } as AgentMessage;
	const call = toolAssistant("kept-read") as AgentMessage;
	const result = { role: "toolResult", toolCallId: "kept-read", toolName: "read", content: [{ type: "text", text: "Kept tool evidence" }], timestamp: 16 } as AgentMessage;
	const late = { ...result, toolCallId: "late-read", timestamp: 21 };
	const steering = user("Post-stop refinement", 22);
	const prefix = [persistent, summary, ...(boundary === "ambiguous" ? [user("One user", 10), user("Another user", 10)] : []), call, result];
	const continuation = createPassiveContinuation(emptyState(), 20, boundary === "nonfinite" ? NaN : 10);
	const beforeContinuation = structuredClone(continuation);
	for (const suffix of [[], [late], [late, steering]]) {
		const available = [...prefix, ...suffix];
		const before = structuredClone(available);
		const projected = passiveContinuationMessages(available, continuation);
		assert.deepEqual(projected, [continuation.handoff, ...available]);
		assert.ok(projected.slice(1).every((entry, index) => entry === available[index]), "preserve native message identity and order");
		assert.deepEqual(available, before);
		assert.deepEqual(continuation, beforeContinuation);
	}
});

test("unfinished compilation preserves all available native context without mutating or reconstructing messages", () => {
	const native: AgentMessage[] = [
		message("custom", "Foreign policy", 1, "foreign-policy"),
		{ role: "compactionSummary", summary: "Available native summary", tokensBefore: 5000, timestamp: 2 } as AgentMessage,
		user("Uncompiled earlier request", 3),
		message("assistant", "Uncompiled earlier result", 4),
		user("Bootstrap request", 10),
		toolAssistant("pending") as AgentMessage,
	];
	const before = structuredClone(native);
	const continuation = createPassiveContinuation(emptyState(), 20, 10, true);
	const projected = passiveContinuationMessages(native, continuation);
	assert.deepEqual(projected, [continuation.handoff, ...native]);
	assert.ok(projected.slice(1).every((entry, index) => entry === native[index]));
	assert.deepEqual(native, before);
	assert.deepEqual(passiveContinuationMessages([], continuation), [continuation.handoff]);
});

test("idle passive continuation keeps post-stop compaction and every later tool turn", () => {
	const continuation = createPassiveContinuation(emptyState(), 20);
	const persistent = message("custom", "Foreign policy", 1, "foreign-policy");
	const oldSummary = { role: "compactionSummary", summary: "Completed history", tokensBefore: 5000, timestamp: 10 } as AgentMessage;
	const summary = { role: "compactionSummary", summary: "Selected task and unfinished tools", tokensBefore: 6000, timestamp: 30 } as AgentMessage;
	const call = toolAssistant("early-read") as AgentMessage;
	const result = { role: "toolResult", toolCallId: "early-read", toolName: "read", content: [{ type: "text", text: "Early evidence" }], timestamp: 25 } as AgentMessage;
	const lateCall = toolAssistant("late-read") as AgentMessage;
	const lateResult = { ...result, toolCallId: "late-read", timestamp: 31 };
	const steering = user("Post-compaction refinement", 32);
	const nextSummary = { ...summary, summary: "Updated native summary", timestamp: 40 };
	const nativePrefix = [persistent, oldSummary, user("Completed request", 11)];
	const beforeContinuation = structuredClone(continuation);
	for (const suffix of [[summary, call, result], [summary, call, result, lateCall, lateResult],
		[summary, call, result, lateCall, lateResult, steering], [nextSummary, lateCall, lateResult]]) {
		const native = [...nativePrefix, ...suffix];
		const before = structuredClone(native);
		const projected = passiveContinuationMessages(native, continuation);
		assert.deepEqual(projected, [continuation.handoff, persistent, ...suffix]);
		assert.ok(projected.slice(1).every((entry, index) => entry === [persistent, ...suffix][index]), "preserve native identity and order");
		assert.deepEqual(native, before);
		assert.deepEqual(continuation, beforeContinuation);
	}
});

test("idle passive continuation does not promote old summaries or summary-looking text", () => {
	const continuation = createPassiveContinuation(emptyState(), 20);
	const persistent = message("custom", "Foreign policy", 1, "foreign-policy");
	const summary = { role: "compactionSummary", summary: "Completed history", tokensBefore: 5000, timestamp: 10 } as AgentMessage;
	const prefix = [persistent, summary, user("Completed request", 11), message("assistant", "compactionSummary after Stop", 30)];
	assert.deepEqual(passiveContinuationMessages(prefix, continuation), [continuation.handoff, persistent]);
	const later = user("Later request", 31);
	assert.deepEqual(passiveContinuationMessages([...prefix, later], continuation), [continuation.handoff, persistent, later]);
});

test("idle and legacy passive cutoffs retain only later conversation plus foreign custom context", () => {
	const persistent = message("custom", "Persistent policy", 1, "foreign-policy");
	const later = message("user", "Later request", 22);
	const continuation = createPassiveContinuation(emptyState(), 20);
	const prefix = [persistent, message("user", "Completed request", 2), message("assistant", "Completed answer", 3)];
	assert.deepEqual(passiveContinuationMessages(prefix, continuation), [continuation.handoff, persistent]);
	assert.deepEqual(passiveContinuationMessages([...prefix, later], continuation), [continuation.handoff, persistent, later]);
});

test("keeps existing context for one bootstrap run and commits its terminal handoff", async () => {
	const h = harness();
	h.entries.push({ type: "message", message: user("Existing goal", 1) });
	const protocol = await start(h, "Continue");
	assert.match(protocol.systemPrompt, /BOOTSTRAP RUN/);
	const projected = h.handlers.get("context")!({ messages: [user("Existing goal", 1), user("Continue", 2)] });
	assert.equal(projected.messages.length, 3);
	assert.match(projected.messages[0].content[0].text, /State Flow runtime context/);
	assert.equal(projected.messages[1].content[0].text, "Existing goal");
	assert.equal(projected.messages[2].content[0].text, "Continue");
	await commitTerminal(h, { goal: "Existing goal" }, { next: "continue" });
	const snapshot = h.entries.at(-1)!.data;
	assert.notEqual(h.resolveSnapshot(snapshot).meta.bootstrap, true);
	assert.equal(Object.hasOwn(snapshot, "state"), false);
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot), {
		artifacts: {},
		strategy: { goal: "Existing goal" },
		tactics: { next: "continue" },
		intents: {},
		response: "Done",
		lazy: {},
	});
});
test("rotates the user-authority turn specification while retaining committed state", async () => {
	const h = harness();
	await start(h, "First request");
	await commitTerminal(h, { mode: "stable" }, { phase: "one" });
	const next = await h.beginRun("Second request");
	assert.doesNotMatch(next.systemPrompt, /First request|Second request/);
	assert.equal(h.resolveSnapshot().meta.specification, "Second request");
	const projected = h.handlers.get("context")!({
		messages: [user("First request", 1), user("Second request", 2)],
	});
	assert.match(projected.messages[0].content[0].text, /"specification":"Second request"/);
	assert.equal(Object.hasOwn(h.entries.at(-1)!.data, "state"), false);
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot), {
		artifacts: {},
		strategy: { mode: "stable" },
		tactics: { phase: "one" },
		intents: {},
		response: "Done",
		lazy: {},
	});
});
test("never interpolates user-controlled specification text into the system prompt", async () => {
	const h = harness();
	const prompt = "UNTRUSTED-SPEC-DO-NOT-ELEVATE";
	const started = await start(h, prompt);
	assert.equal(started.handlerResult, undefined, "protocol sections must not force the entire native prompt");
	assert.doesNotMatch(started.systemPrompt, /UNTRUSTED-SPEC-DO-NOT-ELEVATE/);
	assert.match(started.systemPromptOptions.sections.state_flow!, /State Flow is enabled/);
	const projected = h.handlers.get("context")!({ messages: [user(prompt, 1)] });
	assert.match(projected.messages[0].content[0].text, /UNTRUSTED-SPEC-DO-NOT-ELEVATE/);
});
test("supports an empty text specification for image-only prompts", async () => {
	const h = harness();
	await start(h, "");
	const projected = h.handlers.get("context")!({ messages: [user("Old text request", 1), user("", 2)] });
	assert.equal(projected.messages.length, 2);
	assert.match(projected.messages[0].content[0].text, /"specification":""/);
	assert.equal(projected.messages[1].content[0].text, "");
});
test("preserves the current run trajectory, steering, and custom extension context", async () => {
	const h = harness();
	await start(h, "Current task");
	const oldUser = user("Old task", 1);
	const currentUser = user("Current task", 2);
	const first = h.handlers.get("context")!({ messages: [oldUser, currentUser] });
	assert.equal(first.messages.length, 2);
	assert.match(first.messages[0].content[0].text, /State Flow runtime context/);
	assert.equal(first.messages[1].content[0].text, "Current task");

	const assistant = toolAssistant("read-1");
	const toolResult = {
		role: "toolResult",
		toolCallId: "read-1",
		toolName: "read",
		content: [{ type: "text", text: "Useful evidence" }],
		isError: false,
		timestamp: 3,
	};
	const steeringUser = {
		role: "user",
		content: [{ type: "text", text: "Steering refinement" }],
		timestamp: 5,
	};
	const persistentCustom = {
		role: "custom",
		customType: "persistent-policy",
		content: "Persistent extension policy",
		display: false,
		timestamp: 0,
	};
	const custom = {
		role: "custom",
		customType: "authority-gate",
		content: "DENY operation",
		display: false,
		timestamp: 4,
	};
	const second = h.handlers.get("context")!({
		messages: [persistentCustom, oldUser, currentUser, custom, assistant, steeringUser, toolResult],
	});
	assert.equal(second.messages.length, 7);
	assert.equal(second.messages[1].content, "Persistent extension policy");
	assert.equal(second.messages[2].content[0].text, "Current task");
	assert.equal(second.messages[3].content, "DENY operation");
	assert.equal(second.messages[4].content[0].type, "toolCall");
	assert.equal(second.messages[5].content[0].text, "Steering refinement");
	assert.equal(second.messages[6].content[0].text, "Useful evidence");
	assert.equal(second.messages.some((message: any) => message.content?.[0]?.text === "Old task"), false);
});
test("projects only the latest seven compact accepted transitions", async () => {
	const h = harness();
	await start(h, "Current task");
	for (let index = 0; index < 10; index++) await commitTerminal(h, {}, { index });
	await h.beginRun("Current task");
	const projected = h.handlers.get("context")!({ messages: [user("Current task", 1)] });
	const text = projected.messages[0].content[0].text as string;
	const runtime = JSON.parse(text.slice(text.indexOf("\n") + 1));
	assert.equal(runtime.recent_transitions.length, 7);
	assert.deepEqual(
		runtime.recent_transitions.map((transition: any) => transition.transitions[0].patch.tactics.index),
		[3, 4, 5, 6, 7, 8, 9],
	);
	assert.equal(runtime.recent_transitions.some((transition: any) => Object.hasOwn(transition, "state")), false);
});

test("new sessions project durable causality without old conversation trajectories", async (t) => {
	const repositoryRoot = mkdtempSync(join(tmpdir(), "state-flow-context-durable-"));
	t.after(() => rmSync(repositoryRoot, { recursive: true, force: true }));
	const cwd = join(repositoryRoot, "project");
	const first = harness({ cwd, repositoryRoot });
	await start(first, "Persist project decision");
	await commitScopedTerminal(first, [{ scope: "cwd", patch: { strategy: { decision: "durable" } } }], "Saved.");

	const second = harness({ cwd, repositoryRoot, sessionId: "second-session", mode: "active" });
	await second.handlers.get("session_start")!({ reason: "new" }, second.ctx);
	await second.beginRun("Continue");
	const projected = second.handlers.get("context")!({ messages: [user("Continue", 2)] });
	const text = projected.messages[0].content[0].text as string;
	assert.match(text, /"decision":"durable"/);
	assert.doesNotMatch(text, /"recent_transitions"/); // New session origin proves no prior active transitions.
	assert.throws(() => second.readState(1), /predates the proven temporal origin/);
	assert.equal(projected.messages.some((item: any) => item.content?.[0]?.text === "Persist project decision"), false);
});

test("tree navigation keeps current memory; native steps never rewind any scope", async () => {
	const h = harness();
	await start(h, "Branch task");
	const commitAll = (value: string) => commitScopedTerminal(h, [
		{ scope: "global", patch: { strategy: { globalBranch: value } } },
		{ scope: "cwd", patch: { strategy: { cwdBranch: value } } },
		{ scope: "session", patch: { tactics: { sessionBranch: value } } },
	]);
	await commitAll("base");
	const base = structuredClone(h.entries);
	await commitAll("abandoned-future");
	h.entries.splice(0, h.entries.length, ...base);
	await h.handlers.get("session_tree")!({}, h.ctx);
	await h.beginRun("Branch task");
	const projected = h.handlers.get("context")!({ messages: [user("Branch task", 1)] });
	const text = projected.messages[0].content[0].text as string;
	// Memory is the current JSON state: a native branch step changes neither shared nor session scopes.
	for (const key of ["globalBranch", "cwdBranch", "sessionBranch"]) assert.match(text, new RegExp(`"${key}":"abandoned-future"`));

	await commitTerminal(h, {}, { sessionBranch: "restored-next" });
	assert.equal(h.resolveSnapshot().meta.validation, undefined);
	assert.doesNotMatch(JSON.stringify(h.sentMessages), /cannot publish/);
	// Patching continues from the current state.
	await h.beginRun("Branch task");
	const adopted = h.handlers.get("context")!({ messages: [user("Branch task", 2)] });
	const adoptedText = adopted.messages[0].content[0].text as string;
	assert.match(adoptedText, /"globalBranch":"abandoned-future"/);
	assert.match(adoptedText, /"cwdBranch":"abandoned-future"/);
	assert.match(adoptedText, /"sessionBranch":"restored-next"/);
});

{
	const { scopes, selections, fixture, withoutFileIO, body } = observationFixture;

	test("accepted selected cascade receipts need no context API expansion and reveal only current owner paths", async t => {
		for (const selection of selections) {
			const f = await fixture(t, selection);
			await f.patch(Object.fromEntries(selection.map(scope => [scope, { intents: { own: { $ref: `${scope}.lazy.plan` } }, lazy: { plan: { hidden: `SECRET-${scope}` } } }])));
			const projection = new ContextProjection(), before = f.runtime.readView(), view = contextView(before, {}, []);
			projection.project([], view, () => runtimeContextHead(f.snapshot(), view));
			const patches = Object.fromEntries(selection.map(scope => [scope, { intents: { own: null } }]));
			const stage = await f.patch(patches), accepted = f.runtime.selectedView(), after = f.runtime.readView();
			const updates = withoutFileIO(() => projection.acceptPatch(before, after, patches, {}, stage.cascades));
			const text = JSON.stringify(updates);
			assert.doesNotMatch(text, /SECRET-/);
			for (const scope of scopes) assert.equal(text.includes(`${scope}.lazy.plan`), selection.includes(scope));
			assert.deepEqual(f.runtime.selectedView(), accepted);
		}
	});

	test("selection reduction resets owned projection using newly accepted values; ordinary handoff uses model-projected data", async t => {
		const f = await fixture(t, ["global", "cwd", "session"]);
		await f.patch(Object.fromEntries(scopes.map(scope => [scope, { strategy: { [scope]: `${scope}-owned` }, lazy: { [scope]: { hidden: true } } }])));
		const projection = new ContextProjection(), first = contextView(f.runtime.readView(), {}, []);
		const oldHead = projection.project([], first, () => runtimeContextHead(f.snapshot(), first))[0]!;
		await f.runtime.withSelectedCurrentTransaction(["cwd"], (_snapshot, publish) => publish(), () => {});
		projection.reset();
		withoutFileIO(() => {
			const current = contextView(f.runtime.readView(), {}, []);
			const nextHead = projection.project([], current, () => runtimeContextHead(f.snapshot(), current))[0]!;
			assert.notEqual(nextHead, oldHead); assert.match(body(nextHead), /cwd-owned/); assert.doesNotMatch(body(nextHead), /global-owned|session-owned|"hidden"/);
			const handoff = createPassiveContinuation(projectStateForModel(f.runtime.readView()));
			assert.doesNotMatch(body(handoff.handoff), /global-owned|session-owned|"hidden"/);
		});
	});
}

{
	const owners: StateScope[] = ["global", "cwd", "session"];
	const choices = Array.from({ length: 7 }, (_, index) => owners.filter((_, bit) => (index + 1) & (1 << bit)) as unknown as ScopeSelection);
	const snapshot = startEpisode(false);
	function payload(message: AgentMessage) {
		assert.ok("content" in message && Array.isArray(message.content));
		const block = message.content[0];
		assert.ok(block?.type === "text");
		return JSON.parse(block.text.slice(block.text.indexOf("\n") + 1));
	}
	function view(state: SemanticState, scopes?: ScopeSelection) {
		return contextView(state, {}, [], undefined, true, scopes);
	}

	for (const scopes of choices) test(`body and recent presentation for ${scopes.join("+")}`, () => {
		const owner = scopes[0];
		const cross = owners.find(scope => scope !== owner)!;
		const refs = {
			current: { $ref: `${owner}.tactics.target` },
			historical: { $ref: `${owner}[1].tactics.target` },
			cross: { $ref: `${cross}.tactics.target` },
			effective: { $ref: "effective.tactics.target" },
			resource: { $ref: "/source.md" },
			text: `$${owner}.tactics.target`,
		};
		const state = { tactics: refs, lazy: { secret: "NEVER_AUTOMATIC" }, artifacts: { "/source": { description: "card", hash: "PRIVATE_HASH" } } };
		const before = structuredClone(state);
		const recent: RecentTransitionWindow = [{ id: "causal-id", at: 123, transitions: owners.map(scope => ({ scope, patch: { tactics: refs, lazy: { secret: "NEVER_AUTOMATIC" }, artifacts: state.artifacts } })) }];
		const captured = view(state, scopes);
		const active = payload(runtimeContextHead(snapshot, captured, recent));
		const passive = payload(passiveContextHead(captured));
		const expected = { ...refs, current: { $ref: scopes.length === 1 ? "tactics.target" : `${owner}.tactics.target` } };
		assert.deepEqual(active.state.tactics, expected);
		assert.deepEqual(passive.state.tactics, expected);
		assert.equal(active.lazy_navigation.path, scopes.length === 1 ? "lazy" : "effective.lazy");
		assert.deepEqual(passive.lazy_navigation, active.lazy_navigation);
		assert.equal(JSON.stringify(active).includes("NEVER_AUTOMATIC"), false);
		assert.equal(JSON.stringify(active).includes("PRIVATE_HASH"), false);
		const record = active.recent_transitions[0];
		assert.equal(record.id, "causal-id");
		assert.equal(record.at, 123);
		if (scopes.length === 1) {
			assert.deepEqual(Object.keys(record).sort(), ["at", "id", "patch"]);
			assert.deepEqual(record.patch.tactics, expected);
		} else {
			assert.deepEqual(record.transitions.map((entry: { scope: string }) => entry.scope), scopes);
			for (const transition of record.transitions) assert.deepEqual(transition.patch.tactics, refs);
		}
		assert.deepEqual(state, before);
		assert.equal(captured.state.tactics?.current && (captured.state.tactics.current as { $ref: string }).$ref, `${owner}.tactics.target`);
	});

	test("excluded recent owners are filtered before their patch getters; lazy-only records disappear", () => {
		let reads = 0;
		const excluded = { scope: "cwd" as const, get patch(): SemanticState { reads++; throw Error("excluded payload"); } };
		const recent: RecentTransitionWindow = [
			{ id: "keep", at: 4, transitions: [excluded, { scope: "session", patch: { tactics: { keep: 1 } } }] },
			{ id: "hidden", at: 5, transitions: [{ scope: "session", patch: { lazy: { body: "secret" } } }] },
		];
		const output = payload(runtimeContextHead(snapshot, view({}, ["session"]), recent));
		assert.deepEqual(output.recent_transitions, [{ id: "keep", at: 4, patch: { tactics: { keep: 1 } } }]);
		assert.equal(reads, 0);
	});

	test("omitted selection preserves all-owner presentation", () => {
		const state = { tactics: { ref: { $ref: "session.tactics.x" } }, lazy: { x: 1 } };
		assert.deepEqual(payload(runtimeContextHead(snapshot, view(state))), payload(runtimeContextHead(snapshot, view(state, ["global", "cwd", "session"]))));
	});

	test("canonical drift projects both scalar ref leaves and replacement object values at the edge", () => {
		for (const scopes of choices) {
			const owner = scopes[0];
			const projection = new ContextProjection();
			const before = { tactics: { link: { $ref: `${owner}.tactics.old` } } };
			projection.project([], view(before, scopes), () => syntheticUser("head"));
			const after = { tactics: { link: { $ref: `${owner}.tactics.new` }, added: [{ $ref: `${owner}.lazy.x` }] } };
			const output = projection.project([], view(after, scopes), () => { throw Error("unexpected head"); });
			const updates = payload(output.at(-1)!).state_updates.effective;
			const prefix = scopes.length === 1 ? "" : `${owner}.`;
			assert.deepEqual(updates, [
				{ path: ["tactics", "link", "$ref"], value: `${prefix}tactics.new` },
				{ path: ["tactics", "added"], value: [{ $ref: `${prefix}lazy.x` }] },
			]);
			assert.equal(projection.project([], view(after, scopes), () => { throw Error("unexpected head"); }).length, output.length);
		}
	});

	test("predictable writes compare canonical values and cascades use selected owner arity", () => {
		for (const scopes of choices) {
			const owner = scopes[0];
			const projection = new ContextProjection();
			const before = { tactics: { link: { $ref: `${owner}.tactics.old` } } };
			projection.project([], view(before, scopes), () => syntheticUser("head"));
			const after = { tactics: { link: { $ref: `${owner}.tactics.new` } } };
			assert.equal(projection.acceptPatch(before, after, { [owner]: after }, {}, {}, true, scopes), undefined);
			const cascades = Object.fromEntries(owners.map(scope => [scope, [{ plane: "lazy" as const, keys: ["gone"] }]]));
			const receipt = projection.acceptPatch(after, after, {}, {}, cascades, true, scopes);
			assert.deepEqual(receipt?.effective, []);
			assert.deepEqual(receipt?.cascaded, scopes.map(scope => scopes.length === 1 ? "lazy.gone" : `${scope}.lazy.gone`));
			assert.equal(projection.project([], view(after, scopes), () => { throw Error("unexpected head"); }).length, 1);
		}
	});

	test("special field keys stay exact path segments while reference values are translated", () => {
		const projection = new ContextProjection();
		projection.project([], view({}, ["session"]), () => syntheticUser("head"));
		const keys = ["a.b", "[0]", "$ref", "__proto__", "constructor"];
		const tactics = Object.fromEntries(keys.map(key => [key, [{ $ref: "session.lazy.target" }]]));
		const output = projection.project([], view({ tactics }, ["session"]), () => { throw Error("unexpected head"); });
		assert.deepEqual(payload(output.at(-1)!).state_updates.effective, keys.map(key => ({ path: ["tactics", key], value: [{ $ref: "lazy.target" }] })));
	});

	test("equal wanted choices preserve head identity; owner and arity changes refresh only projection", () => {
		const projection = new ContextProjection();
		const native = [syntheticUser("native history")];
		const saved = structuredClone(native);
		const project = (scopes: ScopeSelection) => projection.project(native, view({}, scopes), () => syntheticUser("head"));
		const first = project(["global", "session"]);
		assert.equal(project(["session", "global"])[0], first[0]);
		const single = project(["session"]);
		assert.notEqual(single[0], first[0]);
		const changedOwner = project(["cwd"]);
		assert.notEqual(changedOwner[0], single[0]);
		for (const result of [first, single, changedOwner]) assert.equal(result.at(-1), native[0]);
		const identities = [first, single, changedOwner].map(result => JSON.stringify(result[0]).match(/State Flow projection: ([a-f0-9-]+)/)![1]);
		assert.equal(new Set(identities).size, 3);
		assert.deepEqual(native, saved);
	});

	test("malformed present wanted selection rejects before semantic body access", () => {
		for (const malformed of [undefined, null, [], ["session", "session"], ["unknown"]]) {
			let reads = 0;
			const state = { get tactics(): never { reads++; throw Error("body accessed"); } };
			const invalid = { modelScopes: malformed, get state() { reads++; throw Error("view accessed"); }, artifact_invalidations: [], knowledge_rehydration: null } as unknown as ContextView;
			assert.throws(() => runtimeContextHead(snapshot, invalid), /scopes must/);
			assert.throws(() => passiveContextHead(invalid), /scopes must/);
			assert.throws(() => new ContextProjection().project([], invalid, () => syntheticUser("head")), /scopes must/);
			if (malformed !== undefined) assert.throws(() => contextView(state, {}, [], undefined, true, malformed as unknown as ScopeSelection), /scopes must/);
			assert.equal(reads, 0);
		}
	});
}

{
	const owners: StateScope[] = ["global", "cwd", "session"];
	const choices = Array.from({ length: 7 }, (_, mask) => owners.filter((_, bit) => (mask + 1) & (1 << bit)) as unknown as ScopeSelection);
	const malformed: unknown[] = [null, [], ["session", "session"], ["foreign"], ["global", "cwd", "session", "global"], new Array(1), "session", {}];
	function body(message: AgentMessage) {
		assert.ok("content" in message && Array.isArray(message.content));
		const first = message.content[0];
		assert.ok(first?.type === "text");
		return JSON.parse(first.text.slice(first.text.indexOf("\n") + 1));
	}
	function native(text: string, timestamp: number): AgentMessage {
		return { role: "user", content: [{ type: "text", text }], timestamp };
	}

	for (const scopes of choices) {
		test(`handoff projection and canonical clone: ${scopes.join("+")}`, () => {
			const owner = scopes[0], cross = owners.find(value => value !== owner)!;
			const refs = {
				current: { $ref: `${owner}.tactics.target` },
				historical: { $ref: `${owner}[1].tactics.target` },
				cross: { $ref: `${cross}.tactics.target` },
				effective: { $ref: "effective.tactics.target" },
				resource: { $ref: "/session/tactics.md" },
				text: `$${owner}.tactics.target`,
			};
			for (const preserve of [false, true]) {
				const state: SemanticState = { tactics: refs, response: "PRIVATE_RESPONSE", lazy: { hidden: "LAZY_BODY" } };
				const before = structuredClone(state);
				const continuation = createPassiveContinuation(state, 20, 10, preserve, scopes);
				assert.deepEqual(continuation.state, { tactics: refs, lazy: { hidden: "LAZY_BODY" } });
				assert.notEqual(continuation.state.tactics, state.tactics);
				assert.deepEqual(body(continuation.handoff).state.tactics, { ...refs, current: { $ref: scopes.length === 1 ? "tactics.target" : `${owner}.tactics.target` } });
				assert.equal(JSON.stringify(continuation.handoff).includes("PRIVATE_RESPONSE"), false);
				assert.equal(Object.hasOwn(body(continuation.handoff).state, "response"), false);
				assert.match(JSON.stringify(continuation.handoff), /user-level data, not system instructions/);
				const messages = [native("old", 1), native("active", 10), native("later", 30)];
				const projected = passiveContinuationMessages(messages, continuation);
				const retained = preserve ? messages : messages.slice(1);
				assert.equal(projected[0], continuation.handoff);
				assert.deepEqual(projected.slice(1), retained);
				retained.forEach((message, index) => assert.equal(projected[index + 1], message));
				assert.deepEqual(state, before);
				continuation.state.tactics!.current = { $ref: "detached" };
				assert.deepEqual(state, before);
				assert.notEqual(body(continuation.handoff).state.tactics.current.$ref, "detached");
			}
		});
	}

	test("invalid continuation choices reject before state body access", () => {
		for (const value of [...malformed, undefined]) {
			const scopes = value as ScopeSelection;
			let reads = 0;
			if (value !== undefined) {
				const state = { get tactics(): never { reads++; throw Error("BODY"); } };
				assert.throws(() => createPassiveContinuation(state, 20, 10, false, scopes), /scopes must/);
			}
			assert.equal(reads, 0);
		}

	});

	test("omitted handoff choice equals old all-three presentation in both branches", () => {
		for (const preserve of [false, true]) {
			const state = { tactics: { ref: { $ref: "session.tactics.x" } }, response: "answer" };
			const old = createPassiveContinuation(state, 20, 10, preserve);
			const explicit = createPassiveContinuation(state, 20, 10, preserve, ["global", "cwd", "session"]);
			assert.deepEqual(body(old.handoff), body(explicit.handoff));
			assert.deepEqual(old.state, explicit.state);
			assert.equal(old.startedAt, 20);
			assert.equal(old.activeRunStartedAt, 10);
			assert.equal(old.preserveContext, preserve ? true : undefined);
		}
	});

	test("idle handoff retains only post-stop anchor suffix without cloning native identities", () => {
		const continuation = createPassiveContinuation({}, 20, undefined, false, ["session"]);
		const messages = [native("old", 1), native("after", 20), native("later", 21)];
		const result = passiveContinuationMessages(messages, continuation);
		assert.deepEqual(result, [continuation.handoff, ...messages.slice(1)]);
		assert.equal(result[1], messages[1]);
		assert.equal(result[2], messages[2]);
		assert.deepEqual(passiveContinuationMessages(messages.slice(0, 1), continuation), [continuation.handoff]);
	});
}
