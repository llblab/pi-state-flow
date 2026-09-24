// Domain: opt-in diagnostic capture for rejected State Flow resolutions.
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isObject } from "./json.js";
/** Preserve exact text blocks and block boundaries; reasoning bodies are never duplicated. */
export function projectDiagnosticContent(content) {
    if (!Array.isArray(content))
        return [];
    return content.map((block) => {
        if (!isObject(block) || typeof block.type !== "string")
            return { type: "unknown" };
        if (block.type === "text" && typeof block.text === "string")
            return { type: "text", text: block.text };
        return { type: block.type };
    });
}
/** Diagnostic JSONL lives beneath the active Pi agent directory, never inside the state repository. */
export function stateFlowLogPath(agentDir) {
    return join(agentDir, "tmp", "state-flow", "logs.jsonl");
}
function ensureDiagnosticDirectory(path) {
    if (dirname(path) !== path)
        ensureDiagnosticDirectory(dirname(path));
    if (!lstatSync(path, { throwIfNoEntry: false }))
        mkdirSync(path);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`State Flow diagnostic directory is not a regular directory: ${path}`);
}
export function appendStateFlowDiagnostic(path, record) {
    ensureDiagnosticDirectory(dirname(path));
    const descriptor = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
        if (!fstatSync(descriptor).isFile())
            throw new Error(`State Flow diagnostic destination is not a regular file: ${path}`);
        appendFileSync(descriptor, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
    }
    finally {
        closeSync(descriptor);
    }
}
/** Own diagnostic path safety, projection, persistence, and one-shot failure reporting. */
export class StateFlowDiagnosticWriter {
    warningReported = false;
    enabled;
    path;
    repositoryRoot;
    notify;
    constructor(enabled, path, repositoryRoot, notify) {
        this.enabled = enabled;
        this.path = path;
        this.repositoryRoot = repositoryRoot;
        this.notify = notify;
    }
    record(sessionId, cwd, error, category, extras = {}) {
        if (!this.enabled)
            return;
        this.write(sessionId, cwd, error, category, extras);
    }
    /** Push warnings stay short; retain the available Git failure detail locally even without opt-in logging. */
    recordBackupPushFailure(sessionId, cwd, error) {
        return this.write(sessionId, cwd, error, "publication-conflict", {}, false);
    }
    write(sessionId, cwd, error, category, extras, reportFailure = true) {
        try {
            const fromRepository = relative(this.repositoryRoot, this.path);
            if (fromRepository === "" || (!isAbsolute(fromRepository) && fromRepository !== ".." && !fromRepository.startsWith(`..${sep}`))) {
                throw new Error("diagnostic path overlaps the State Flow repository");
            }
            appendStateFlowDiagnostic(this.path, {
                at: new Date().toISOString(),
                sessionId,
                cwd: resolve(cwd),
                category,
                error,
                ...(extras.content === undefined ? {} : { content: projectDiagnosticContent(extras.content) }),
                ...(extras.input === undefined ? {} : { input: extras.input }),
                ...(extras.tool === undefined ? {} : { tool: extras.tool }),
                ...(extras.toolCallId === undefined ? {} : { toolCallId: extras.toolCallId }),
            });
            return true;
        }
        catch (failure) {
            if (reportFailure && !this.warningReported) {
                this.warningReported = true;
                this.notify(`State Flow could not write diagnostics: ${failure instanceof Error ? failure.message : String(failure)}`);
            }
            return false;
        }
    }
}
