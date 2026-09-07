import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { hashArtifactSource } from "../lib/artifact.ts";
import {
	discoverGlobalMarkdownSources,
	getKnowledgeRoot,
	GlobalMarkdownDiscovery,
} from "../lib/discovery.ts";

function fixture(): { root: string; cleanup: () => void } {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-discovery-"));
	const root = join(parent, "knowledge");
	mkdirSync(root);
	return { root, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

test("resolves the configured Knowledge root beneath Pi's agent directory", () => {
	assert.equal(getKnowledgeRoot("./agent-root"), resolve("./agent-root", "knowledge"));
});

test("discovers root and nested regular Markdown as normalized path/hash metadata", (t) => {
	const { root, cleanup } = fixture();
	t.after(cleanup);
	mkdirSync(join(root, "nested", "deep"), { recursive: true });
	writeFileSync(join(root, "root.md"), "root source\n");
	writeFileSync(join(root, "nested", "deep", "source.md"), "nested source\n");
	writeFileSync(join(root, "nested", "ignored.MD"), "wrong extension\n");
	writeFileSync(join(root, "notes.txt"), "not Markdown\n");
	mkdirSync(join(root, "directory.md"));

	assert.deepEqual(discoverGlobalMarkdownSources(root), [
		{
			path: join(root, "nested", "deep", "source.md"),
			hash: hashArtifactSource("nested source\n"),
			bytes: Buffer.byteLength("nested source\n"),
		},
		{
			path: join(root, "root.md"),
			hash: hashArtifactSource("root source\n"),
			bytes: Buffer.byteLength("root source\n"),
		},
	]);
});

test("refresh reports additions through the current source set and removals explicitly", (t) => {
	const { root, cleanup } = fixture();
	t.after(cleanup);
	const firstPath = join(root, "first.md");
	const secondPath = join(root, "nested", "second.md");
	writeFileSync(firstPath, "first");
	const discovery = new GlobalMarkdownDiscovery(root);

	assert.deepEqual(discovery.refresh(), {
		sources: [{ path: firstPath, hash: hashArtifactSource("first"), bytes: 5 }],
		removed: [],
	});
	mkdirSync(join(root, "nested"));
	writeFileSync(secondPath, "second");
	rmSync(firstPath);
	assert.deepEqual(discovery.refresh(), {
		sources: [{ path: secondPath, hash: hashArtifactSource("second"), bytes: 6 }],
		removed: [firstPath],
	});
});

test("does not follow file or directory symlinks outside or inside the Knowledge root", (t) => {
	const { root, cleanup } = fixture();
	t.after(cleanup);
	const outside = join(root, "..", "outside");
	mkdirSync(outside);
	writeFileSync(join(outside, "secret.md"), "outside");
	writeFileSync(join(root, "safe.md"), "safe");
	symlinkSync(join(outside, "secret.md"), join(root, "escaped.md"));
	symlinkSync(outside, join(root, "escaped-directory"));
	symlinkSync(join(root, "safe.md"), join(root, "alias.md"));

	assert.deepEqual(discoverGlobalMarkdownSources(root), [
		{ path: join(root, "safe.md"), hash: hashArtifactSource("safe"), bytes: 4 },
	]);
});

test("treats a missing Knowledge root as an empty discovery and rejects a file root", (t) => {
	const { root, cleanup } = fixture();
	t.after(cleanup);
	const missing = join(root, "missing");
	assert.deepEqual(discoverGlobalMarkdownSources(missing), []);
	const file = join(root, "not-a-root");
	writeFileSync(file, "data");
	assert.throws(() => discoverGlobalMarkdownSources(file), /not a directory/);
});
