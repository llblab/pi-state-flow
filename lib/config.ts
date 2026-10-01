// Domain: repository-global State Flow configuration, independent of session runtime and semantic state.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getDurableRepositoryRoot } from "./durable.ts";
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT } from "./history.ts";
import { isObject } from "./json.ts";
import { isStateFlowMode, type InactiveMode, type StateFlowMode } from "./snapshot.ts";

export interface StateFlowConfig {
	/** Canonical State Flow repository. SDK callers may still override it explicitly. */
	directory: string;
	/** Default mode for genuinely new sessions only; each session owns its selected mode. */
	mode: StateFlowMode;
	/** Non-active fallback for legacy `enabled:false` evidence and unavailable selections; never serialized. */
	inactiveMode: InactiveMode;
	/** Opt-in local capture of rejected patch attempts and unresolved terminal drafts. */
	logging: boolean;
	/** Show successful patch_state arguments in the interactive tool row. */
	showSuccessfulPatches: boolean;
	historyLimit: number;
}

/** Read the repository-global config once at extension load/reload. Missing config uses defaults; invalid config never falls back. */
export function loadStateFlowConfig(agentDir = getAgentDir(), repositoryRoot = getDurableRepositoryRoot(agentDir)): StateFlowConfig {
	const directory = repositoryRoot;
	const path = join(directory, "config.json");
	const defaults: StateFlowConfig = {
		directory,
		mode: "off",
		inactiveMode: "off",
		logging: false,
		showSuccessfulPatches: true,
		historyLimit: DEFAULT_HISTORY_LIMIT,
	};
	let value: unknown;
	try {
		if (!lstatSync(path, { throwIfNoEntry: false })) return defaults;
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read State Flow configuration: ${path}`, { cause: error });
	}
	// autoStart/passiveBootstrap/passiveTools are read-only compatibility inputs; explicit mode is authoritative.
	const allowed = new Set(["mode", "autoStart", "passiveBootstrap", "passiveTools", "logging", "showSuccessfulPatches", "historyLimit"]);
	if (!isObject(value) || Object.keys(value).some((key) => !allowed.has(key))) {
		throw new Error(`State Flow configuration contains unknown settings: ${path}`);
	}
	if (Object.hasOwn(value, "mode") && !isStateFlowMode(value.mode)) throw new Error(`State Flow mode must be "active", "passive" or "off": ${path}`);
	if (Object.hasOwn(value, "autoStart") && typeof value.autoStart !== "boolean") throw new Error(`State Flow autoStart must be a boolean: ${path}`);
	if (Object.hasOwn(value, "passiveBootstrap") && typeof value.passiveBootstrap !== "boolean") throw new Error(`State Flow passiveBootstrap must be a boolean: ${path}`);
	if (Object.hasOwn(value, "passiveTools") && typeof value.passiveTools !== "boolean") throw new Error(`State Flow passiveTools must be a boolean: ${path}`);
	if (Object.hasOwn(value, "logging") && typeof value.logging !== "boolean") throw new Error(`State Flow logging must be a boolean: ${path}`);
	if (Object.hasOwn(value, "showSuccessfulPatches") && typeof value.showSuccessfulPatches !== "boolean") throw new Error(`State Flow showSuccessfulPatches must be a boolean: ${path}`);
	if (Object.hasOwn(value, "historyLimit") && (!Number.isSafeInteger(value.historyLimit) || (value.historyLimit as number) < 0 || (value.historyLimit as number) > MAX_HISTORY_LIMIT)) throw new Error(`State Flow historyLimit must be an integer from 0 to ${MAX_HISTORY_LIMIT}: ${path}`);
	const legacyInactive: InactiveMode = value.passiveBootstrap !== false || value.passiveTools !== false ? "passive" : "off";
	const hasLegacyMode = Object.hasOwn(value, "autoStart") || Object.hasOwn(value, "passiveBootstrap") || Object.hasOwn(value, "passiveTools");
	const mode = isStateFlowMode(value.mode) ? value.mode : value.autoStart === true ? "active" : hasLegacyMode ? legacyInactive : "off";
	return {
		directory,
		mode,
		inactiveMode: isStateFlowMode(value.mode) ? inactiveModeFor(value.mode) : hasLegacyMode ? legacyInactive : "off",
		logging: value.logging === true,
		showSuccessfulPatches: value.showSuccessfulPatches !== false,
		historyLimit: typeof value.historyLimit === "number" ? value.historyLimit : DEFAULT_HISTORY_LIMIT,
	};
}

/** Explicit modes never carry a separate passive policy: only Off stays off when inactive. */
export function inactiveModeFor(mode: StateFlowMode): InactiveMode {
	return mode === "off" ? "off" : "passive";
}
