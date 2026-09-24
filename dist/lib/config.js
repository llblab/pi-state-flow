// Domain: repository-global State Flow configuration, independent of session runtime and semantic state.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getDurableRepositoryRoot } from "./durable.js";
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT } from "./history.js";
import { isObject } from "./json.js";
/** Read the repository-global config once at extension load/reload. Missing config uses defaults; invalid config never falls back. */
export function loadStateFlowConfig(agentDir = getAgentDir(), repositoryRoot = getDurableRepositoryRoot(agentDir)) {
    const directory = repositoryRoot;
    const path = join(directory, "config.json");
    const defaults = {
        directory,
        autoStart: false,
        passiveBootstrap: true,
        passiveTools: true,
        logging: false,
        showSuccessfulPatches: true,
        historyLimit: DEFAULT_HISTORY_LIMIT,
    };
    let value;
    try {
        if (!lstatSync(path, { throwIfNoEntry: false }))
            return defaults;
        value = JSON.parse(readFileSync(path, "utf8"));
    }
    catch (error) {
        throw new Error(`Cannot read State Flow configuration: ${path}`, { cause: error });
    }
    const allowed = new Set(["autoStart", "passiveBootstrap", "passiveTools", "logging", "showSuccessfulPatches", "historyLimit"]);
    if (!isObject(value) || Object.keys(value).some((key) => !allowed.has(key))) {
        throw new Error(`State Flow configuration contains unknown settings: ${path}`);
    }
    if (Object.hasOwn(value, "autoStart") && typeof value.autoStart !== "boolean")
        throw new Error(`State Flow autoStart must be a boolean: ${path}`);
    if (Object.hasOwn(value, "passiveBootstrap") && typeof value.passiveBootstrap !== "boolean")
        throw new Error(`State Flow passiveBootstrap must be a boolean: ${path}`);
    if (Object.hasOwn(value, "passiveTools") && typeof value.passiveTools !== "boolean")
        throw new Error(`State Flow passiveTools must be a boolean: ${path}`);
    if (Object.hasOwn(value, "logging") && typeof value.logging !== "boolean")
        throw new Error(`State Flow logging must be a boolean: ${path}`);
    if (Object.hasOwn(value, "showSuccessfulPatches") && typeof value.showSuccessfulPatches !== "boolean")
        throw new Error(`State Flow showSuccessfulPatches must be a boolean: ${path}`);
    if (Object.hasOwn(value, "historyLimit") && (!Number.isSafeInteger(value.historyLimit) || value.historyLimit < 0 || value.historyLimit > MAX_HISTORY_LIMIT))
        throw new Error(`State Flow historyLimit must be an integer from 0 to ${MAX_HISTORY_LIMIT}: ${path}`);
    return {
        directory,
        autoStart: value.autoStart === true,
        passiveBootstrap: value.passiveBootstrap !== false,
        passiveTools: value.passiveTools !== false,
        logging: value.logging === true,
        showSuccessfulPatches: value.showSuccessfulPatches !== false,
        historyLimit: typeof value.historyLimit === "number" ? value.historyLimit : DEFAULT_HISTORY_LIMIT,
    };
}
