import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import type { AtomicScopePatches } from "../lib/state.ts";
import { modelPatchArguments } from "./model-patch-fixture.ts";

const root = new URL("../", import.meta.url);

test("index is only a composition and public-export boundary", async () => {
	const source = await readFile(new URL("index.ts", root), "utf8");
	assert.doesNotMatch(source, /registerCommand|pi\.on|function\s+/);
	assert.match(source, /lib\/extension\.ts/);
});

test("public API and Skill domain expose no retired Skill converter", async () => {
	const api = await import("../index.ts");
	const skills = await import("../lib/skills.ts");
	for (const module of [api, skills]) assert.equal(Object.hasOwn(module, "migrateLegacySkillCompilations"), false);
	assert.equal(typeof api.hashSkillSource, "function");
	assert.equal(api.hashSkillSource, skills.hashSkillSource);
});

test("extension composition delegates imperative mechanics to owning domains", async () => {
	const source = await readFile(new URL("lib/extension.ts", root), "utf8");
	assert.doesNotMatch(source, /PublicationWorkerController|loadPublicationQueue|pushGitTarget/);
	assert.doesNotMatch(source, /TurnBackupController/);
	assert.match(source, /backupCurrentStateFlowFiles/);
	assert.match(source, /new StateFlowDiagnosticWriter/);
	assert.match(source, /findAssistantToolBatch/);
	assert.match(source, /prepareSelectedBranchPolicy/);
	assert.doesNotMatch(source, /acquirePublicationWorkerLease|runPublicationWorker|appendStateFlowDiagnostic|projectDiagnosticContent/);
	assert.doesNotMatch(source, /function formatPatchStateArguments|function normalizePatchStateArguments/);
});

test("extension composition keeps one ceiling on mutable closure bindings and lifecycle holders", async () => {
	const source = await readFile(new URL("lib/extension.ts", root), "utf8");
	const bindings = source.match(/^\tlet /gm)?.length ?? 0;
	const holders = source.match(/new\s+(?:OwnedOperationSlot|RenewableLifetime|StateFlowModuleHost)\b/g)?.length ?? 0;
	// The public module host adds one owned, revocable registration lifetime; count it too.
	// Baseline: 17 bindings + 5 operation slots + 2 renewable lifetimes + 1 module host.
	assert.ok(bindings + holders <= 25,
		`lib/extension.ts has ${bindings + holders} closure state sites (${bindings} mutable bindings + ${holders} lifecycle holders); move state into its owning domain`);
	assert.doesNotMatch(source, /let (?:compactionPlan|compactionInFlight|compactionStopped|compactionMarker|turnAcceptedForBackup|backupPending|backupLifetime|pushFailureNotified)\b/);
	assert.match(source, /new StateFlowCompactionRequests\(\)/);
	assert.match(source, /new SettledTurnBackup\(\)/);
	assert.match(source, /new ArtifactAcquisitionState\(\)/);
	assert.doesNotMatch(source, /let (?:artifactInvalidations|artifactHints)\b/);
	assert.doesNotMatch(source, /let (?:startActivation|inactivePersistence|branchRestoration|inferencePreparation|responseReconciliation)\b/);
	assert.equal(source.match(/new OwnedOperationSlot</g)?.length, 5, "Start, inactive persistence, restoration, preparation and response reconciliation");
});

test("release verification requires the compiled package surfaces", async () => {
	const workflow = await readFile(new URL(".github/workflows/release.yml", root), "utf8");
	assert.match(workflow, /- name: Build exact local package\n\s+run: npm run build\n\s+- name: Capture exact local package inventory/);
	assert.match(workflow, /published\.pi\?\.extensions\?\.includes\("\.\/dist\/pi-state-flow\/index\.js"\)/);
	assert.match(workflow, /published\.pi\?\.skills\?\.includes\("\.\/dist\/skills"\)/);
	assert.match(workflow, /paths\.includes\("dist\/pi-state-flow\/index\.js"\)/);
	assert.match(workflow, /paths\.includes\("dist\/skills\/state-flow-memory\/SKILL\.md"\)/);
	assert.match(workflow, /paths\.includes\("dist\/skills\/state-flow-guide\/SKILL\.md"\)/);
	assert.doesNotMatch(workflow, /published\.pi\?\.extensions\?\.includes\("\.\/index\.ts"\)/);
});

test("production mirrors and test placement agree in both directions with reasoned exceptions", async () => {
	const domains = new Set((await readdir(new URL("lib/", root))).filter(name => name.endsWith(".ts")));
	const benchmarks = new Set(await readdir(new URL("benchmarks/", root)));
	const tests = new Set((await readdir(new URL("tests/", root), { recursive: true }))
		.map(name => name.replaceAll("\\", "/")).filter(name => /\.test\.(?:[cm]?[jt]s|[jt]sx)$/.test(name)));
	const benchmarkOwners = new Map([
		["benchmark.test.ts", "benchmark.ts"],
		["benchmark-session.test.ts", "benchmark-session.ts"],
	]);
	// These own cross-domain evidence, not a feature awaiting an invented production module.
	const exceptions = new Map([
		["documentation.test.ts", "Distributed Markdown links, packaged Skills and executable documentation examples."],
		["integration.test.ts", "Composed stage/publication and multi-consumer contracts that no single leaf owns."],
		["invariants.test.ts", "Architecture, release-surface and test-evidence integrity constraints."],
		["pi-compatibility.test.ts", "Installed SDK peer baseline, host tool loop, argument validator and local provider serializers."],
	]);
	const check = (sources: ReadonlySet<string>, benchmarkSources: ReadonlySet<string>, suites: ReadonlySet<string>) => {
		const mirrors = new Set([...sources].map(name => name.replace(/\.ts$/, ".test.ts")));
		for (const domain of mirrors) assert.ok(suites.has(domain), `missing tests/${domain}`);
		for (const [suite, owner] of benchmarkOwners) {
			assert.ok(benchmarkSources.has(owner), `missing production owner benchmarks/${owner}`);
			assert.ok(suites.has(suite), `missing tests/${suite}`);
		}
		for (const suite of suites) {
			assert.ok(!suite.includes("/") && suite.endsWith(".test.ts"), `undiscovered test surface tests/${suite}`);
			assert.ok(mirrors.has(suite) || benchmarkOwners.has(suite) || exceptions.has(suite), `unowned test tests/${suite}`);
		}
		for (const [suite, reason] of exceptions) {
			assert.ok(reason.trim(), `missing ownership reason for tests/${suite}`);
			assert.ok(suites.has(suite), `stale test exception tests/${suite}`);
			assert.equal(mirrors.has(suite), false, `remove exception now owned by lib/${suite.replace(/\.test\.ts$/, ".ts")}`);
		}
	};
	check(domains, benchmarks, tests);
	assert.throws(() => check(domains, benchmarks, new Set([...tests].filter(name => name !== "context.test.ts"))), /missing tests\/context/);
	assert.throws(() => check(domains, benchmarks, new Set([...tests, "scope-fragment.test.ts"])), /unowned test/);
	assert.throws(() => check(domains, benchmarks, new Set([...tests, "nested\/extension.test.ts"])), /undiscovered test surface/);
	assert.throws(() => check(domains, new Set([...benchmarks].filter(name => name !== "benchmark-session.ts")), tests), /missing production owner/);
	assert.throws(() => check(domains, benchmarks, new Set([...tests].filter(name => name !== "pi-compatibility.test.ts"))), /stale test exception/);
	assert.throws(() => check(new Set([...domains, "pi-compatibility.ts"]), benchmarks, tests), /remove exception now owned/);
});

test("support modules contain setup and assertions, not hidden test registration or suite dependencies", async () => {
	// Static source hygiene after Node type erasure, not an arbitrary-code sandbox or semantic ownership proof.
	const check = (source: string, name: string) => {
		const executable = stripTypeScriptTypes(source);
		const dependencies = [...executable.matchAll(/\b(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)(["'])([^"'\n]+)\1/g)].map(match => match[2]!);
		for (const dependency of dependencies) {
			assert.notEqual(dependency, "node:test", `${name}: test registration dependency`);
			assert.notEqual(dependency, "test", `${name}: test registration dependency`);
			assert.doesNotMatch(dependency, /\.test\.(?:[cm]?[jt]s|[jt]sx)$/, `${name}: suite dependency`);
		}
		assert.doesNotMatch(executable, /(?:^|[;\n])\s*(?:await\s+)?(?:test|describe|suite)(?:\.(?:only|skip|todo))?\s*\(/, `${name}: direct test registration`);
	};
	const files = (await readdir(new URL("tests/", root), { recursive: true }))
		.filter(name => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(name) && !name.endsWith(".test.ts"));
	for (const name of files) check(await readFile(new URL(`tests/${name}`, root), "utf8"), name);
	check('import type { TestContext } from "node:test"; export function setup(t: TestContext) { t.after(() => {}); return { test: "data" }; }', "setup.ts");
	for (const source of [
		'import test from "node:test";',
		'import { test as hidden } from "node:test";',
		'import * as hidden from "node:test";',
		'export { test } from "node:test";',
		'const hidden = await import("node:test");',
		'const hidden = require("node:test");',
		'import "./misplaced.test.ts";',
		'test("hidden", () => {});',
		'describe.skip("hidden", () => {});',
	]) assert.throws(() => check(source, "hidden.ts"), /test registration|suite dependency/);
});

test("semantic core has no Git, backup, transport, or Pi lifecycle dependencies", async () => {
	const semanticCore = ["json.ts", "state.ts", "selection.ts", "history.ts", "temporal.ts", "query.ts", "ownership.ts", "transition.ts", "migration.ts", "model-interface.ts"];
	const forbidden = ["git", "publication", "telegram", "extension", "runtime", "storage"];
	for (const name of semanticCore) {
		const source = await readFile(new URL(`lib/${name}`, root), "utf8");
		assert.doesNotMatch(source, /from ["']@earendil-works\/pi-coding-agent/,
			`${name} must remain independent from the Pi lifecycle SDK`);
		for (const dependency of forbidden) {
			assert.doesNotMatch(source, new RegExp(`from ["']\\./${dependency}\\.ts["']`),
				`${name} must not depend on ${dependency}`);
		}
	}
});

test("canonical file persistence owns no Git capability or backup policy", async () => {
	const source = await readFile(new URL("lib/storage.ts", root), "utf8");
	assert.doesNotMatch(source, /from ["']\.\/git\.ts["']|from ["']\.\/publication\.ts["']/);
	assert.doesNotMatch(source, /node:child_process|git --version|detectGitCapability/);
});

test("domain dependency graph is acyclic and never points at composition", async () => {
	const names = (await readdir(new URL("lib/", root))).filter((name) => name.endsWith(".ts"));
	const graph = new Map<string, string[]>();
	for (const name of names) {
		const source = await readFile(new URL(`lib/${name}`, root), "utf8");
		assert.doesNotMatch(source, /from ["']\.\.\/index\.ts["']/);
		const dependencies = [...source.matchAll(/from ["']\.\/([^"']+)\.ts["']/g)]
			.map((match) => `${match[1]}.ts`);
		graph.set(name, dependencies);
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (name: string): void => {
		if (visiting.has(name)) assert.fail(`cyclic lib dependency at ${name}`);
		if (visited.has(name)) return;
		visiting.add(name);
		for (const dependency of graph.get(name) ?? []) visit(dependency);
		visiting.delete(name);
		visited.add(name);
	};
	for (const name of names) visit(name);
});

// Negative witnesses must not become green because their authoring adapter drops invalid targets.
test("fixture argument projection preserves invalid mixed/foreign cohorts instead of dropping targets", () => {
	const valid: AtomicScopePatches = { cwd: { tactics: { x: 1 } } };
	assert.deepEqual(modelPatchArguments(["cwd"], valid), valid.cwd);
	for (const invalid of [{ global: { tactics: { x: 1 } } }, { ...valid, session: { tactics: { x: 1 } } }]) assert.equal(modelPatchArguments(["cwd"], invalid), invalid);
	assert.equal(modelPatchArguments(["global", "cwd"], valid), valid);
});
