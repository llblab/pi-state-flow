import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each test process owns a private Git config. Child benchmarks inherit it; Git
// subprocesses and Pi's asynchronous backup see the same configuration.
const root = mkdtempSync(join(tmpdir(), "state-flow-git-config-"));
writeFileSync(join(root, "config"), `[user]\n\tname = State Flow Tests\n\temail = state-flow@example.invalid\n${process.env.STATE_FLOW_TEST_PUSH_NEGOTIATE === "1" ? "[push]\n\tnegotiate = true\n" : ""}`);
process.env.GIT_CONFIG_GLOBAL = join(root, "config");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
