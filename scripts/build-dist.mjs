#!/usr/bin/env node

/** Builds distributable JavaScript, declarations, the Pi identity shim, and runtime assets. */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
run(process.execPath, [join("node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"]);

mkdirSync(join("dist", "pi-state-flow"), { recursive: true });
writeFileSync(join("dist", "pi-state-flow", "index.js"), 'export { default } from "../index.js";\n', "utf8");
cpSync("skills", join("dist", "skills"), { recursive: true });
cpSync("package.json", join("dist", "package.json"));

run(process.execPath, ["--check", join("dist", "pi-state-flow", "index.js")]);
