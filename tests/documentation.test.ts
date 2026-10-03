import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

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
