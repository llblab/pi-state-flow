// Domain: agent-level State Flow configuration, independent of session runtime and semantic state.
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getDurableRepositoryRoot } from "./durable.ts";
import { isObject } from "./json.ts";

export interface StateFlowConfig {
	directory: string;
	autoStart: boolean;
}

/** Read once at extension load/reload. Missing config uses defaults; invalid config never falls back. */
export function loadStateFlowConfig(agentDir = getAgentDir()): StateFlowConfig {
	const path = resolve(agentDir, "state-flow.json");
	const defaults = { directory: getDurableRepositoryRoot(agentDir), autoStart: false };
	let value: unknown;
	try {
		if (!lstatSync(path, { throwIfNoEntry: false })) return defaults;
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read State Flow configuration: ${path}`, { cause: error });
	}
	if (!isObject(value) || Object.keys(value).some((key) => key !== "directory" && key !== "autoStart")) {
		throw new Error(`State Flow configuration must be an object with only directory and autoStart: ${path}`);
	}
	if (Object.hasOwn(value, "autoStart") && typeof value.autoStart !== "boolean") throw new Error(`State Flow autoStart must be a boolean: ${path}`);
	if (Object.hasOwn(value, "directory") && (typeof value.directory !== "string" || !value.directory.trim() || value.directory.includes("\0"))) {
		throw new Error(`State Flow directory must be a non-empty path: ${path}`);
	}
	const directory = value.directory as string | undefined;
	if (directory?.startsWith("~") && directory !== "~" && !directory.startsWith("~/")) throw new Error(`State Flow directory supports ~ or ~/ paths, not named-user expansion: ${path}`);
	const expanded = directory === "~" ? homedir() : directory?.startsWith("~/") ? resolve(homedir(), directory.slice(2)) : directory;
	return { directory: expanded === undefined ? defaults.directory : resolve(dirname(path), expanded), autoStart: value.autoStart === true };
}
