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
	/** Opt-in local capture of rejected patch attempts and unresolved terminal drafts. */
	logging: boolean;
	remotePublication?: "off" | "turn-end" | "transition";
}

/** Read once at extension load/reload. Missing config uses defaults; invalid config never falls back. */
export function loadStateFlowConfig(agentDir = getAgentDir()): StateFlowConfig {
	const path = resolve(agentDir, "state-flow.json");
	const defaults: StateFlowConfig = {
		directory: getDurableRepositoryRoot(agentDir),
		autoStart: false,
		logging: false,
	};
	let value: unknown;
	try {
		if (!lstatSync(path, { throwIfNoEntry: false })) return defaults;
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read State Flow configuration: ${path}`, { cause: error });
	}
	const allowed = new Set(["directory", "autoStart", "logging", "remotePublication"]);
	if (!isObject(value) || Object.keys(value).some((key) => !allowed.has(key))) {
		throw new Error(`State Flow configuration contains unknown settings: ${path}`);
	}
	if (Object.hasOwn(value, "autoStart") && typeof value.autoStart !== "boolean") throw new Error(`State Flow autoStart must be a boolean: ${path}`);
	if (Object.hasOwn(value, "logging") && typeof value.logging !== "boolean") throw new Error(`State Flow logging must be a boolean: ${path}`);
	if (Object.hasOwn(value, "remotePublication") && value.remotePublication !== "off" && value.remotePublication !== "turn-end" && value.remotePublication !== "transition") {
		throw new Error(`State Flow remotePublication must be off, turn-end, or transition: ${path}`);
	}
	if (Object.hasOwn(value, "directory") && (typeof value.directory !== "string" || !value.directory.trim() || value.directory.includes("\0"))) {
		throw new Error(`State Flow directory must be a non-empty path: ${path}`);
	}
	const directory = value.directory as string | undefined;
	if (directory?.startsWith("~") && directory !== "~" && !directory.startsWith("~/")) throw new Error(`State Flow directory supports ~ or ~/ paths, not named-user expansion: ${path}`);
	const expanded = directory === "~" ? homedir() : directory?.startsWith("~/") ? resolve(homedir(), directory.slice(2)) : directory;
	return {
		directory: expanded === undefined ? defaults.directory : resolve(dirname(path), expanded),
		autoStart: value.autoStart === true,
		logging: value.logging === true,
		...(value.remotePublication === undefined ? {} : { remotePublication: value.remotePublication as "off" | "turn-end" | "transition" }),
	};
}
