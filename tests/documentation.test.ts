import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { loadSkillsFromDir } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js";
import { normalizeModelPatches, normalizeModelReadPath } from "../lib/model-interface.ts";
import { contextView } from "../lib/context.ts";
import { stageAtomicScopePatches } from "../lib/transition.ts";
import { readProjectedState } from "../lib/query.ts";
import { createTemporalState } from "../lib/temporal.ts";

const root = resolve(import.meta.dirname, "..");
const sources = [
	"README.md",
	"AGENTS.md",
	"BACKLOG.md",
	"CHANGELOG.md",
	...readdirSync(join(root, "docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`),
	...readdirSync(join(root, "skills")).map((name) => `skills/${name}/SKILL.md`),
];

/** GitHub-style heading anchor. */
function slug(heading: string): string {
	return heading.trim().toLowerCase()
		.replace(/`/g, "")
		.replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
		.replace(/\s/g, "-");
}

function anchors(file: string): Set<string> {
	const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
	const seen = new Map<string, number>();
	const result = new Set<string>();
	for (const match of text.matchAll(/^#{1,6} (.+)$/gm)) {
		const base = slug(match[1]!);
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		result.add(count === 0 ? base : `${base}-${count}`);
	}
	return result;
}

test("every relative markdown link and anchor in human and Skill documentation resolves", () => {
	const broken: string[] = [];
	for (const source of sources) {
		const file = join(root, source);
		const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
		for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
			const target = match[1]!;
			if (/^[a-z]+:/i.test(target)) continue;
			const [path, anchor] = target.split("#") as [string, string | undefined];
			const resolved = path === "" ? file : resolve(dirname(file), path);
			if (!existsSync(resolved)) {
				broken.push(`${source}: ${target} (missing file)`);
				continue;
			}
			if (anchor !== undefined && resolved.endsWith(".md") && !anchors(resolved).has(anchor)) {
				broken.push(`${source}: ${target} (missing anchor)`);
			}
		}
	}
	assert.deepEqual(broken, []);
});

test("documented effective lazy keys expose structural metadata, not source ownership", () => {
	const section = readFileSync(join(root, "docs/lazy-state.md"), "utf8").split("### `keys`")[1]!;
	const [request, expected] = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].slice(0, 2).map(match => JSON.parse(match[1]!));
	const view = createTemporalState({
		global: { lazy: { memory: ["entry"], rules: { ranges: "Half-open" } } },
		cwd: { lazy: { soul: ["later"] } },
		session: {},
	}, "documentation-keys");
	assert.deepEqual(readProjectedState(view, [request.path], request.projection), expected);
});

{
	const discovered = loadSkillsFromDir({ dir: join(import.meta.dirname, "..", "skills"), source: "package:pi-state-flow" });
	const body = readFileSync(discovered.skills.find(skill => skill.name === "state-flow")!.filePath, "utf8");

	test("the State Flow Skill conditions grammar on WANTED arity without granting unavailable transfers", () => {
		assert.deepEqual(discovered.diagnostics, []);
		assert.deepEqual(discovered.skills.map(skill => skill.name), ["state-flow"]);
		assert.match(body, /exactly one WANTED owner/);
		assert.match(body, /flat object planes/);
		assert.match(body, /without an owner wrapper/);
		assert.match(body, /multiple WANTED owners/);
		assert.match(body, /not available view|not whichever owners happen to have an available view/);
		assert.match(body, /sole-owner selection cannot perform.*two-owner transfer/);
		assert.match(body, /effective\[N\].tactics/);
		assert.match(body, /tactics.items\[N\]/);
		assert.match(body, /patches\[N\].*scalar owner patch-history alias/);
		assert.match(body, /before canonical.*ownership\/cascade processing/);
		assert.match(body, /no finalization patch/);
	});

	test("actual Skill JSON examples normalize flat for every sole owner and cascade canonically", () => {
		const examples = [...body.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
		assert.equal(examples.length, 5);
		const [keys, batch, opening, closing, preservation] = examples;
		for (const owner of ["global", "cwd", "session"] as const) {
			assert.equal(normalizeModelReadPath(keys.path, [owner]), `${owner}.lazy`);
			assert.deepEqual(batch.paths.map((path: string) => normalizeModelReadPath(path, [owner])), [`${owner}.tactics`, `${owner}.strategy`]);
			const normalized = normalizeModelPatches(opening, [owner]);
			assert.deepEqual(normalized[owner]!.intents, { check_api: { action: "Verify the API", notes: { $ref: `${owner}.tactics.api` }, plan: { $ref: `${owner}.lazy.api_plan` } } });
			const seeded = stageAtomicScopePatches({ global: {}, cwd: {}, session: {} }, normalized, [], "open").nextStates;
			const closed = stageAtomicScopePatches(seeded, normalizeModelPatches(closing, [owner]), [], "close");
			assert.equal(closed.nextStates[owner].tactics, undefined);
			assert.equal(closed.nextStates[owner].lazy, undefined);
			assert.deepEqual(closed.nextStates[owner].strategy, { api: "verified: v2 only" });
			assert.deepEqual(normalizeModelPatches(preservation, [owner]), { [owner]: preservation });
			assert.throws(() => normalizeModelPatches({ [owner]: opening }, [owner]));
		}
	});

	test("the Skill's hot release cue routes a task-driven lazy read without projecting the checklist", () => {
		const routing = body.split("## Use hot memory to route lazy reads\n")[1]!.split("\n## Read")[0]!;
		assert.match(routing, /Follow the user's explicit placement choice/);
		assert.match(routing, /without waiting for a separate user request/);
		assert.match(routing, /No background scans, automatic hydration, widening of participation or write-back on read/);
		const cue = routing.match(/Example: keep “([^”]+)”/)![1]!;
		const { path } = JSON.parse(routing.match(/\x60(\{"path":"[^"]+"\})\x60/)![1]!);
		assert.ok(cue.includes("$" + path));
		const checklist = ["verify inventory", "check package entrypoint"];
		const cwd = { strategy: { release: cue }, lazy: { releaseChecks: checklist } };
		const projected = contextView(cwd, {}, []);
		assert.equal(projected.state.strategy?.release, cue);
		assert.equal(projected.state.lazy, undefined);
		const view = createTemporalState({ global: {}, cwd, session: {} }, "lazy-release-cue");
		assert.deepEqual(readProjectedState(view, [normalizeModelReadPath(path, ["cwd"])]), { value: checklist });
		assert.throws(() => normalizeModelReadPath(path, ["session"]), /excluded/);
	});

	test("the inline multi-owner read requires both owners to participate", () => {
		const example = JSON.parse(body.match(/Multi-owner example, requiring both CWD and Session to participate: `(\{[^`]+\})`/)![1]);
		assert.deepEqual(example.paths.map((path: string) => normalizeModelReadPath(path, ["cwd", "session"])), ["cwd.tactics", "session.tactics"]);
		assert.throws(() => normalizeModelReadPath(example.paths[1], ["cwd"]), /excluded/);
	});
}
