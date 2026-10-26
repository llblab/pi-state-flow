import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createHash } from "node:crypto";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, Type, validateToolArguments, fauxProvider, normalizeContext, type Model, type ToolCall, type Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI, AgentSession } from "@earendil-works/pi-coding-agent";
import { stream as openai } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as google } from "@earendil-works/pi-ai/api/google-generative-ai";
import { realPiFixture } from "./pi-harness.ts";
import { PROBE_OWNERS, PROBE_PLANES, PROBE_SCHEMAS, STABLE_PROBE_SCHEMA, FLAT_PROBE_SCHEMA, SCOPED_PROBE_SCHEMA } from "./schema-probe-fixture.ts";

test("all Pi peers and the pinned verification stack use the 1.0.0 baseline", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const name of ["pi-coding-agent", "pi-agent-core", "pi-ai", "pi-tui"]) {
    const dependency = "@earendil-works/" + name;
    assert.equal(pkg.peerDependencies[dependency], ">=1.0.0", dependency);
    assert.equal(pkg.devDependencies[dependency], "1.0.0", dependency);
  }
});

{
	// Installed-SDK capability probe only. These acknowledgements grant no State Flow authority.
	const answer = fauxAssistantMessage, call = fauxToolCall;

	type Candidate = "stable" | "replacement";
	const names = ["patch_state", "read_state"];
	const allowed = ["read", ...names, "schema_foreign"];
	const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
	function prototype(candidate: Candidate) {
		let owners: string[] = ["session"], mode = "active", signature = "flat";
		const calls: Array<{ id: string; name: string; args: unknown; owners: string[] }> = [];
		const entries: string[] = [];
		let registrations = 0;
		const factory = (pi: ExtensionAPI) => {
			const register = () => {
				for (const name of names) {
					registrations++;
					pi.registerTool({ name, label: `SDK-only ${name}`, description: candidate === "stable"
						? "SDK probe: one selected owner uses flat intents/strategy/tactics/artifacts/lazy; multiple owners use global/cwd/session. No memory writes or permission grants."
						: `SDK probe: ${owners.length === 1 ? "flat intents/strategy/tactics/artifacts/lazy" : "scoped global/cwd/session"}. No memory writes or permission grants.`,
						parameters: candidate === "stable" ? STABLE_PROBE_SCHEMA : owners.length === 1 ? FLAT_PROBE_SCHEMA : SCOPED_PROBE_SCHEMA,
						async execute(id, args) {
							entries.push(id);
							// Test policy only, deliberately not M2 request correlation or State Flow staging.
							const scoped = Object.keys(args).some(key => (PROBE_OWNERS as readonly string[]).includes(key));
							if (mode === "off" || scoped !== (owners.length > 1)) throw new Error("SDK probe runtime arity/mode gate");
							calls.push({ id, name, args: structuredClone(args), owners: [...owners] });
							return { content: [{ type: "text", text: "SDK-only validated acknowledgement" }], details: undefined };
						},
					});
				}
			};
			register();
			pi.registerTool({ name: "schema_foreign", label: "Foreign", description: "Unrelated SDK probe tool", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "foreign" }], details: undefined }; } });
			pi.registerCommand("sdk-schema-probe", { description: "SDK-only test policy, not State Flow selection", handler: async args => {
				const [nextMode, selection] = args.split(" ");
				mode = nextMode!; owners = selection!.split(",");
				const next = owners.length === 1 ? "flat" : "scoped";
				if (candidate === "replacement" && next !== signature && mode !== "off") { register(); signature = next; }
				const active = pi.getActiveTools().filter(name => !names.includes(name));
				pi.setActiveTools(mode === "off" ? active : [...active, ...names]);
			} });
		};
		return { factory, calls, entries, registrations: () => registrations };
	}
	function results(session: AgentSession, ids: string[]) {
		return ids.map(id => {
			const matches = session.messages.filter(message => message.role === "toolResult" && message.toolCallId === id);
			assert.equal(matches.length, 1, `original tool call ID ${id} has exactly one result`);
			const result = matches[0]!;
			assert.equal(result.role, "toolResult");
			return result as Extract<typeof result, { role: "toolResult" }>;
		});
	}
	function declarations(context: Context) { return structuredClone(getCurrentTools(context.messages)); }
	async function invoke(f: Awaited<ReturnType<typeof realPiFixture>>, session: AgentSession, batch: Array<{ id: string; args: Parameters<typeof call>[1]; name?: string }>) {
		const seen: ReturnType<typeof declarations>[] = [];
		f.faux.setResponses([context => { seen.push(declarations(context)); return answer(batch.map(item => call(item.name ?? "patch_state", item.args, { id: item.id })), { stopReason: "toolUse" }); }, context => { seen.push(declarations(context)); return answer("SDK probe settled"); }]);
		await session.prompt("Run SDK-only schema witnesses");
		assert.equal(seen.length, 2, "native continuation requested exactly once");
		return seen;
	}

	for (const candidate of ["stable", "replacement"] as const) {
		test(`SDK-only ${candidate}: sole-owner equivalence, arity transitions and native validation`, async t => {
			const p = prototype(candidate);
			const f = await realPiFixture(t, { stateFlow: false, initializeRepository: false, tools: allowed, extensions: [{ name: "sdk-schema-probe", factory: p.factory }] });
			const session = await f.createSession();
			const initial: string[] = [];
			for (const owner of PROBE_OWNERS) {
				await session.prompt(`/sdk-schema-probe active ${owner}`);
				const seen = await invoke(f, session, [{ id: `flat-${owner}`, args: { strategy: { witness: owner } } }, { id: `read-${owner}`, name: "read_state", args: { lazy: { witness: owner } } }]);
				assert.deepEqual(seen[0]!.map(tool => tool.name).sort(), [...allowed].sort());
				for (const name of names) {
					const tool = seen[0]!.find(tool => tool.name === name)!;
					assert.match(tool.description, /SDK probe/);
					assert.equal(digest(tool.parameters), digest(candidate === "stable" ? STABLE_PROBE_SCHEMA : FLAT_PROBE_SCHEMA));
				}
				initial.push(digest(seen[0]));
				const registered = p.registrations();
				await session.prompt(`/sdk-schema-probe passive ${owner}`);
				await session.prompt(`/sdk-schema-probe active ${owner}`);
				assert.equal(p.registrations(), registered, "mode-only/same-arity controls do not re-register schemas");
				assert.deepEqual(seen[1], seen[0]);
				assert.equal(results(session, [`flat-${owner}`, `read-${owner}`]).filter(result => result.isError).length, 0);
			}
			assert.equal(new Set(initial).size, 1, "sole owner changes require no schema churn");
			for (const selection of ["global,cwd", "global,cwd,session"]) {
				await session.prompt(`/sdk-schema-probe passive ${selection}`);
				const id = `scoped-${selection}`;
				const seen = await invoke(f, session, [{ id, args: { global: { intents: { witness: true } }, cwd: { tactics: { witness: true } } } }, { id: `${id}-read`, name: "read_state", args: { cwd: { lazy: { witness: true } } } }, { id: `${id}-arity`, args: { strategy: { wrong: true } } }]);
				for (const name of names) assert.equal(digest(seen[0]!.find(tool => tool.name === name)!.parameters), digest(candidate === "stable" ? STABLE_PROBE_SCHEMA : SCOPED_PROBE_SCHEMA));
				assert.deepEqual(results(session, [id, `${id}-read`, `${id}-arity`]).map(result => result.isError), [false, false, true]);
				assert.equal(p.entries.includes(`${id}-arity`), candidate === "stable", "stable wrong arity uses labeled runtime gate; replacement rejects in native schema validation");
			}
			await session.prompt("/sdk-schema-probe active session");
			const invalid: Array<Parameters<typeof call>[1]> = [{}, { strategy: {}, session: { strategy: {} } }, { goals: {} }, { response: "not model owned" }, { session: { strategy: {} } }];
			await invoke(f, session, invalid.map((args, index) => ({ id: `invalid-${index}`, args })));
			assert.equal(results(session, invalid.map((_, index) => `invalid-${index}`)).filter(result => result.isError).length, invalid.length);
			for (let index = 0; index < 4; index++) assert.equal(p.entries.includes(`invalid-${index}`), false, "invalid shape rejected before handler");
			assert.equal(p.entries.includes("invalid-4"), candidate === "stable");
			assert.equal(p.calls.length, 10);
			assert.equal(p.registrations(), candidate === "stable" ? 2 : 6);
		});

		test(`SDK-only ${candidate}: mid-response snapshot, same-flat stale-owner counterexample and Off`, async t => {
			const p = prototype(candidate);
			const f = await realPiFixture(t, { stateFlow: false, initializeRepository: false, tools: allowed, extensions: [{ name: "sdk-schema-probe", factory: p.factory }] });
			const session = await f.createSession();
			const seen: ReturnType<typeof declarations>[] = [];
			let changed = false;
			f.faux.setResponses([async context => {
				seen.push(declarations(context));
				await session.prompt("/sdk-schema-probe active global,cwd"); changed = true;
				return answer(call("patch_state", { strategy: { oldFlat: true } }, { id: "mid-replace" }), { stopReason: "toolUse" });
			}, context => { seen.push(declarations(context)); return answer("continued"); }]);
			await session.prompt("Probe mid-response schema replacement");
			assert.equal(changed, true); assert.equal(seen.length, 2);
			assert.equal(results(session, ["mid-replace"])[0]!.isError, true);
			// SDK 1.0.0 captures the old tool wrapper for the current response; runtime policy rejects it.
			assert.equal(p.entries.includes("mid-replace"), true);
			for (const name of names) {
				assert.equal(digest(seen[0]!.find(tool => tool.name === name)!.parameters), digest(candidate === "stable" ? STABLE_PROBE_SCHEMA : FLAT_PROBE_SCHEMA));
				assert.equal(digest(seen[1]!.find(tool => tool.name === name)!.parameters), digest(candidate === "stable" ? STABLE_PROBE_SCHEMA : SCOPED_PROBE_SCHEMA));
			}
			await session.prompt("/sdk-schema-probe active global");
			let moved = false;
			f.faux.setResponses([async () => {
				await session.prompt("/sdk-schema-probe active cwd"); moved = true;
				return answer(call("patch_state", { strategy: { staleOwner: true } }, { id: "same-flat-stale" }), { stopReason: "toolUse" });
			}, answer("continued")]);
			await session.prompt("Probe schema is not an owner receipt");
			assert.equal(moved, true);
			assert.equal(results(session, ["same-flat-stale"])[0]!.isError, false);
			assert.deepEqual(p.calls.find(item => item.id === "same-flat-stale")!.owners, ["cwd"], "counterexample: schema alone admits old flat A under flat B; M2 receipts remain necessary");
			let off = false;
			const offSeen: ReturnType<typeof declarations>[] = [];
			f.faux.setResponses([async context => {
				offSeen.push(declarations(context)); await session.prompt("/sdk-schema-probe off cwd"); off = true;
				return answer(call("patch_state", { strategy: { staleOff: true } }, { id: "old-after-off" }), { stopReason: "toolUse" });
			}, context => { offSeen.push(declarations(context)); return answer("Off continuation"); }]);
			await session.prompt("Probe Off in flight");
			assert.equal(off, true); assert.equal(offSeen.length, 2);
			assert.deepEqual(offSeen[1]!.map(tool => tool.name).sort(), ["read", "schema_foreign"]);
			assert.equal(results(session, ["old-after-off"])[0]!.isError, true);
			assert.equal(p.entries.includes("old-after-off"), true, "SDK current-response snapshot still enters old wrapper; runtime mode gate is required");
			assert.equal(p.calls.some(item => item.id === "old-after-off"), false, "old wrapper may enter runtime gate but no acknowledged call executes after Off");
			const after = await invoke(f, session, [{ id: "off-absent", args: { strategy: {} } }]);
			assert.deepEqual(after[0]!.map(tool => tool.name).sort(), ["read", "schema_foreign"]);
			assert.equal(results(session, ["off-absent"])[0]!.isError, true);
			assert.equal(p.entries.includes("off-absent"), false);
		});

		test(`SDK-only ${candidate}: host allowlist survives same-name re-registration`, async t => {
			const p = prototype(candidate);
			const f = await realPiFixture(t, { stateFlow: false, initializeRepository: false, tools: ["read", "schema_foreign"], extensions: [{ name: "sdk-schema-probe", factory: p.factory }] });
			const session = await f.createSession();
			await session.prompt("/sdk-schema-probe passive global,cwd");
			const seen = await invoke(f, session, [{ id: "excluded", args: { global: { strategy: {} } } }, { id: "foreign", name: "schema_foreign", args: {} }]);
			assert.deepEqual(seen[0]!.map(tool => tool.name).sort(), ["read", "schema_foreign"]);
			assert.deepEqual(results(session, ["excluded", "foreign"]).map(result => result.isError), [true, false]);
			assert.deepEqual(p.entries, []);
		});
	}
}

{
	for (const roundtrip of [false, true]) test(`SDK-only candidate closed schema validation survives JSON serialization roundtrip=${roundtrip}`, () => {
		for (const [candidate, schema] of Object.entries(PROBE_SCHEMAS)) {
			const tool = { name: "patch_state", description: "SDK-only candidate", parameters: roundtrip ? JSON.parse(JSON.stringify(schema)) : schema };
			const accepts = (args: unknown) => {
				const call = { type: "toolCall" as const, id: "candidate", name: "patch_state", arguments: args as ToolCall["arguments"] };
				return validateToolArguments(tool, call);
			};
			if (candidate !== "scoped") assert.deepEqual(accepts({ tactics: { deleteKey: null } }), { tactics: { deleteKey: null } });
			else assert.throws(() => accepts({ tactics: {} }), /Validation/);
			if (candidate !== "flat") assert.deepEqual(accepts({ cwd: { tactics: {} } }), { cwd: { tactics: {} } });
			else assert.throws(() => accepts({ cwd: { tactics: {} } }), /Validation/);
			for (const args of [{}, [], { response: "runtime-only" }, { contract: {} }, { working: {} }, { tactics: 7 }, { tactics: {}, cwd: { tactics: {} } }]) assert.throws(() => accepts(args), /Validation/);
			// SDK optional-null normalization may drop a whole null plane, but it must not create a patch.
			assert.throws(() => accepts({ tactics: null }), /Validation/);
		}
	});
}

{
	// Local serializer capability evidence only; no provider acceptance or model-quality claim.
	type JsonObject = Record<string, unknown>;
	function object(value: unknown): JsonObject {
		assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
		return value as JsonObject;
	}
	function array(value: unknown): unknown[] {
		assert.ok(Array.isArray(value));
		return value;
	}
	function wireSchema(api: string, body: JsonObject): JsonObject {
		const tool = object(array(body.tools)[0]);
		if (api === "openai-responses") return object(tool.parameters);
		if (api === "anthropic-messages") return object(tool.input_schema);
		return object(object(array(tool.functionDeclarations)[0]).parametersJsonSchema);
	}
	const adapters = [
		{ api: "openai-responses", provider: "openai", id: "gpt-4.1" },
		{ api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-4-5" },
		{ api: "google-generative-ai", provider: "google", id: "gemini-2.5-flash" },
	] as const;

	for (const adapter of adapters) {
		for (const [candidate, parameters] of Object.entries(PROBE_SCHEMAS)) {
			test(`${adapter.api}: ${candidate} actual local request schema`, async () => {
				const originalFetch = globalThis.fetch;
				const requests: Array<{ url: string; body: unknown }> = [];
				let unexpectedFetches = 0;
				const capture: typeof fetch = async (input, init) => {
					const request = new Request(input, init);
					requests.push({ url: request.url, body: await request.json() });
					return new Response(JSON.stringify({ error: { message: "LOCAL_SCHEMA_PROBE_STOP", type: "invalid_request_error", code: 400 } }), {
						status: 400, headers: { "content-type": "application/json" },
					});
				};
				// Google rejects a distinct custom fetch; its supported route uses this same guarded global.
				globalThis.fetch = adapter.api === "google-generative-ai" ? capture : async () => {
					unexpectedFetches++;
					throw new Error("Unexpected default fetch blocked locally");
				};
				let result;
				try {
					const base = fauxProvider().getModel();
					const model = { ...base, api: adapter.api, provider: adapter.provider, id: adapter.id, baseUrl: "https://schema-probe.invalid" };
					const context = normalizeContext({ messages: [{ role: "user", content: "Local serialization probe", timestamp: 0 }], tools: [{ name: "patch_state", description: "Local schema probe", parameters, constrainedSampling: false }] });
					// Each public API has a narrower model discriminant; all descriptors use the public Model structure.
					if (adapter.api === "openai-responses") result = await openai(model as Model<"openai-responses">, context, { apiKey: "LOCAL-NONCREDENTIAL", fetch: capture, transport: "sse", maxRetries: 0, timeoutMs: 1000 }).result();
					else if (adapter.api === "anthropic-messages") result = await anthropic(model as Model<"anthropic-messages">, context, { apiKey: "LOCAL-NONCREDENTIAL", fetch: capture, transport: "sse", maxRetries: 0, timeoutMs: 1000 }).result();
					else result = await google(model as Model<"google-generative-ai">, context, { apiKey: "LOCAL-NONCREDENTIAL", fetch: capture, transport: "sse", maxRetries: 0, timeoutMs: 1000 }).result();
				} finally {
					globalThis.fetch = originalFetch;
				}
				assert.equal(unexpectedFetches, 0);
				assert.equal(requests.length, 1, result?.errorMessage ?? "Expected local request capture");
				assert.equal(new URL(requests[0].url).hostname, "schema-probe.invalid");
				assert.equal(result?.stopReason, "error");
				assert.match(result?.errorMessage ?? "", /LOCAL_SCHEMA_PROBE_STOP/);
				const actual = wireSchema(adapter.api, object(requests[0].body));
				const expected = object(JSON.parse(JSON.stringify(parameters)));
				const expectedNames = candidate === "stable" ? [...PROBE_PLANES, ...PROBE_OWNERS] : candidate === "flat" ? [...PROBE_PLANES] : candidate === "scoped" ? [...PROBE_OWNERS] : [];
				assert.deepEqual(Object.keys(object(actual.properties ?? {})), expectedNames);
				if (adapter.api !== "anthropic-messages") {
					assert.deepEqual(actual, expected);
				} else {
					// Known counterexample: non-strict Anthropic loses root exclusivity, closure and nonempty constraints.
					assert.equal(actual.oneOf, undefined);
					assert.equal(actual.anyOf, undefined);
					assert.equal(actual.minProperties, undefined);
					assert.equal(actual.additionalProperties, undefined);
					assert.deepEqual(actual, { type: "object", properties: expected.properties ?? {}, required: expected.required ?? [] });
				}
			});
		}
	}
}
