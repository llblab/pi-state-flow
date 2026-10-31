import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { loadSkillsFromDir } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js";
import { normalizeModelPatches, normalizeModelReadPath } from "../lib/model-interface.ts";
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
	const bodies = new Map(discovered.skills.map((skill) => [skill.name, readFileSync(skill.filePath, "utf8")]));

	test("packaged Skills condition grammar on WANTED arity without granting unavailable transfers", () => {
		assert.deepEqual(discovered.diagnostics, []);
		assert.deepEqual([...bodies.keys()].sort(), ["state-flow-guide", "state-flow-memory"]);
		for (const body of bodies.values()) {
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
		}
	});

	test("actual guide JSON examples normalize flat for every sole owner and cascade canonically", () => {
		const guide = bodies.get("state-flow-guide")!;
		const examples = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
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

	test("memory inline examples are actual sole-owner read and patch arguments", () => {
		const memory = bodies.get("state-flow-memory")!;
		const read = JSON.parse(memory.match(/`(\{"path":"tactics"\})`/)![1]);
		const patch = JSON.parse(memory.match(/Sole-owner example: `(.*?)`/)![1]);
		for (const owner of ["global", "cwd", "session"] as const) {
			assert.equal(normalizeModelReadPath(read.path, [owner]), `${owner}.tactics`);
			assert.deepEqual(normalizeModelPatches(patch, [owner]), { [owner]: patch });
		}
	});
}
