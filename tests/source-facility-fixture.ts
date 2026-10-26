import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { captureScopeSelection, type ScopeSelection } from "../lib/selection.ts";
import type { ScopeStateValues } from "../lib/state.ts";

const scopes = ["global", "cwd", "session"] as const;
const selections = Array.from({ length: 7 }, (_, mask) => captureScopeSelection(scopes.filter((_, bit) => ((mask + 1) & (1 << bit)) !== 0)));
function fixture(t: TestContext) {
	const directory = mkdtempSync(join(tmpdir(), "state-flow-selected-sources-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const sources = join(directory, "sources"); mkdirSync(sources);
	const paths = Object.fromEntries(scopes.map(scope => [scope, join(sources, `${scope}.txt`)])) as Record<typeof scopes[number], string>;
	for (const scope of scopes) writeFileSync(paths[scope], `source-${scope}`);
	return { directory, sources, paths };
}

function selectedStates(selection: ScopeSelection, paths: Record<typeof scopes[number], string>): ScopeStateValues {
	return Object.fromEntries(selection.map(scope => [scope, { artifacts: { [paths[scope]]: { description: scope } } }]));
}

export { scopes, selections, fixture, selectedStates };
