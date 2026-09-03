import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("index is only a composition and public-export boundary", async () => {
	const source = await readFile(new URL("index.ts", root), "utf8");
	assert.doesNotMatch(source, /registerCommand|pi\.on|function\s+/);
	assert.match(source, /lib\/extension\.ts/);
});

test("every lib domain has a mirrored test file", async () => {
	const domains = (await readdir(new URL("lib/", root)))
		.filter((name) => name.endsWith(".ts"))
		.map((name) => name.replace(/\.ts$/, ".test.ts"));
	const tests = new Set(await readdir(new URL("tests/", root)));
	for (const domain of domains) assert.ok(tests.has(domain), `missing tests/${domain}`);
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
