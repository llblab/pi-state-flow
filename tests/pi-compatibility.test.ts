import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("all Pi peers and the pinned verification stack use the 1.0.0 baseline", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const name of ["pi-coding-agent", "pi-agent-core", "pi-ai", "pi-tui"]) {
    const dependency = "@earendil-works/" + name;
    assert.equal(pkg.peerDependencies[dependency], ">=1.0.0", dependency);
    assert.equal(pkg.devDependencies[dependency], "1.0.0", dependency);
  }
});
