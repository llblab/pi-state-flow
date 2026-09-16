// Domain: repository-global State Flow configuration, independent of session runtime and semantic state.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getDurableRepositoryRoot } from "./durable.ts";
import { isObject } from "./json.ts";

export interface StateFlowConfig {
	/** Canonical State Flow repository. SDK callers may still override it explicitly. */
	directory: string;
	autoStart: boolean;
	passiveBootstrap: boolean;
	passiveTools: boolean;
	/** Opt-in local capture of rejected patch attempts and unresolved terminal drafts. */
	logging: boolean;
	/** Show successful patch_state arguments in the interactive tool row. */
	showSuccessfulPatches: boolean;
	remotePublication?: "off" | "turn-end" | "transition";
}

/** Read the repository-global config once at extension load/reload. Missing config uses defaults; invalid config never falls back. */
export function loadStateFlowConfig(agentDir = getAgentDir(), repositoryRoot = getDurableRepositoryRoot(agentDir)): StateFlowConfig {
	const directory = repositoryRoot;
	const path = join(directory, "config.json");
	const defaults: StateFlowConfig = {
		directory,
		autoStart: false,
		passiveBootstrap: true,
		passiveTools: true,
		logging: false,
		showSuccessfulPatches: true,
	};
	let value: unknown;
	try {
		if (!lstatSync(path, { throwIfNoEntry: false })) return defaults;
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read State Flow configuration: ${path}`, { cause: error });
	}
	const allowed = new Set(["autoStart", "passiveBootstrap", "passiveTools", "logging", "showSuccessfulPatches", "remotePublication"]);
	if (!isObject(value) || Object.keys(value).some((key) => !allowed.has(key))) {
		throw new Error(`State Flow configuration contains unknown settings: ${path}`);
	}
	if (Object.hasOwn(value, "autoStart") && typeof value.autoStart !== "boolean") throw new Error(`State Flow autoStart must be a boolean: ${path}`);
	if (Object.hasOwn(value, "passiveBootstrap") && typeof value.passiveBootstrap !== "boolean") throw new Error(`State Flow passiveBootstrap must be a boolean: ${path}`);
	if (Object.hasOwn(value, "passiveTools") && typeof value.passiveTools !== "boolean") throw new Error(`State Flow passiveTools must be a boolean: ${path}`);
	if (Object.hasOwn(value, "logging") && typeof value.logging !== "boolean") throw new Error(`State Flow logging must be a boolean: ${path}`);
	if (Object.hasOwn(value, "showSuccessfulPatches") && typeof value.showSuccessfulPatches !== "boolean") throw new Error(`State Flow showSuccessfulPatches must be a boolean: ${path}`);
	if (Object.hasOwn(value, "remotePublication") && value.remotePublication !== "off" && value.remotePublication !== "turn-end" && value.remotePublication !== "transition") {
		throw new Error(`State Flow remotePublication must be off, turn-end, or transition: ${path}`);
	}
	return {
		directory,
		autoStart: value.autoStart === true,
		passiveBootstrap: value.passiveBootstrap !== false,
		passiveTools: value.passiveTools !== false,
		logging: value.logging === true,
		showSuccessfulPatches: value.showSuccessfulPatches !== false,
		...(value.remotePublication === undefined ? {} : { remotePublication: value.remotePublication as "off" | "turn-end" | "transition" }),
	};
}
