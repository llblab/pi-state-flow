import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("removal evidence is root-owned, non-consuming, and reconstructible from retained paths", (t) => {
	const { root, cleanup } = fixture();
	t.after(cleanup);
	const outside = join(root, "..", "outside");
	mkdirSync(outside);
	const kept = join(root, "keep.md");
	writeFileSync(kept, "keep");
	const gone = join(root, "deleted-directory", "gone.md");
	const preserved = [
		join(outside, "external.md"), join(root, "data.txt"), join(root, "uppercase.MD"),
		join(root, "linked-directory", "missing.md"), join(root, "linked.md"), join(root, "directory.md"),
		"relative.md", `${root}/../outside/alias.md`,
	];
	symlinkSync(outside, join(root, "linked-directory"));
	symlinkSync(join(outside, "absent.md"), join(root, "linked.md"));
	mkdirSync(join(root, "directory.md"));
	const retained = [kept, gone, ...preserved];
	const discovery = new GlobalMarkdownDiscovery(root);
	for (const owner of [discovery, discovery, new GlobalMarkdownDiscovery(root)]) {
		assert.deepEqual(owner.refresh(retained).removed, [gone]);
	}
	renameSync(root, `${root}-unavailable`);
	const unavailable = discovery.refresh(retained);
	assert.deepEqual(unavailable.sources, []);
	assert.deepEqual(unavailable.removed, [], "a missing whole root is not evidence to delete its compiled registry");
	assert.match(unavailable.unavailable ?? "", /Knowledge root is unavailable/);
	renameSync(`${root}-unavailable`, root);
	assert.deepEqual(discovery.refresh(retained).removed, [gone]);
});

test("repointing a configured root does not remove artifacts belonging to its previous target", (t) => {
	const { root, cleanup } = fixture();
	t.after(cleanup);
	const alias = join(root, "..", "alias");
	const other = join(root, "..", "other");
	mkdirSync(other);
	const first = join(root, "first.md");
	writeFileSync(first, "first");
	symlinkSync(root, alias);
	const discovery = new GlobalMarkdownDiscovery(alias);
	assert.equal(discovery.refresh().sources[0]!.path, first);
	rmSync(alias);
	symlinkSync(other, alias);
	assert.deepEqual(discovery.refresh(), { sources: [], removed: [] });
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
