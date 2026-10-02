import { parseRetainedPiCheckpoint, readCheckpointMode } from "./snapshot.js";
export const SNAPSHOT_ENTRY_TYPE = "state-flow-snapshot";
/** Enumerate active-branch snapshots newest-first while containing hostile entries. */
export function discoverSnapshotData(branch) {
    const candidates = [];
    const errors = [];
    for (let index = branch.length - 1; index >= 0; index--) {
        try {
            const entry = branch[index];
            if (entry?.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE)
                candidates.push(entry.data);
        }
        catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
        }
    }
    return { candidates, errors };
}
/** Read native mode policy only; semantic checkpoint validity remains the recovery owner's concern. */
export function findBranchPolicy(branch, sessionId, stopEntryType, inactiveMode) {
    let stopReset = false;
    for (let index = branch.length - 1; index >= 0; index--) {
        try {
            const entry = branch[index];
            if (entry?.type !== "custom")
                continue;
            if (entry.customType === SNAPSHOT_ENTRY_TYPE) {
                const mode = readCheckpointMode(entry.data, inactiveMode);
                if (mode !== undefined)
                    return { mode };
                const data = entry.data;
                if (data?.disabled === true && !Object.hasOwn(data, "mode") && !Object.hasOwn(data, "enabled"))
                    return { mode: inactiveMode };
            }
            else if (stopEntryType !== undefined && entry.customType === stopEntryType) {
                const data = entry.data;
                if (!data || stopReset || (sessionId === undefined ? typeof data.owner !== "string" || !data.owner.trim() : data.owner !== sessionId))
                    continue;
                if (data.reset === true) {
                    stopReset = true;
                    continue;
                }
                if (Number.isSafeInteger(data.at) && data.at >= 0 && data.memoryDeferred === true && data.mode === "off") {
                    return { mode: "off", ...(typeof data.persistenceError === "string" && data.persistenceError.trim() ? { persistenceError: data.persistenceError } : {}) };
                }
                if (Number.isSafeInteger(data.at) && data.at >= 0 && typeof data.persistenceError === "string" && data.persistenceError.trim()) {
                    return { mode: data.mode === "off" || data.mode === "passive" ? data.mode : inactiveMode, persistenceError: data.persistenceError };
                }
            }
        }
        catch {
            // Malformed native policy cannot prevent another explicit retained choice from being read.
        }
    }
    return undefined;
}
/** Native policy bookkeeping retains an unacquired fork across extension reloads. */
export function hasPendingFork(branch, sessionId, entryType) {
    for (let index = branch.length - 1; index >= 0; index--) {
        try {
            const entry = branch[index];
            if (entry?.type !== "custom" || entry.customType !== entryType)
                continue;
            const data = entry.data;
            if (data?.owner !== sessionId)
                continue;
            if (data.reset === true)
                return false;
            if (data.forkPending === true)
                return true;
        }
        catch {
            // Unrelated native entries grant no fork authority.
        }
    }
    return false;
}
export function snapshotDataNewestFirst(branch) {
    return discoverSnapshotData(branch).candidates;
}
export function latestSnapshotData(branch) {
    return snapshotDataNewestFirst(branch)[0];
}
export function hasPriorConversation(branch) {
    for (const entry of branch) {
        try {
            if (entry.type !== "message")
                continue;
            const role = entry.message?.role;
            if (role === "user" || role === "assistant" || role === "toolResult")
                return true;
        }
        catch {
            // A hostile unrelated entry must not prevent explicit episode startup.
        }
    }
    return false;
}
/** Native conversation after the latest valid checkpoint may contain uncompiled work, not a new semantic authority. */
export function hasUncheckpointedConversation(branch) {
    for (let index = branch.length - 1; index >= 0; index--) {
        try {
            const entry = branch[index];
            if (entry?.type === "message") {
                const role = entry.message?.role;
                if (role === "user" || role === "assistant" || role === "toolResult")
                    return true;
            }
            if (entry?.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE) {
                parseRetainedPiCheckpoint(entry.data);
                return false;
            }
        }
        catch {
            // Malformed entries cannot prove that pending input was checkpointed.
        }
    }
    return false;
}
/** Auto-start eligibility is session identity/lifecycle, not the presence of CWD materialization. */
export function isNewSession(reason, branch) {
    if (reason === "new")
        return true;
    return reason === "startup" && !hasPriorConversation(branch);
}
export function findAssistantToolBatch(session, toolCallId) {
    for (let cursor = session.getLeafEntry(); cursor; cursor = cursor.parentId ? session.getEntry(cursor.parentId) : undefined) {
        if (cursor.type !== "message" || cursor.message?.role !== "assistant" || !Array.isArray(cursor.message.content))
            continue;
        const calls = cursor.message.content.filter((block) => {
            return typeof block === "object" && block !== null
                && block.type === "toolCall"
                && typeof block.id === "string"
                && typeof block.name === "string";
        });
        if (calls.some(({ id }) => id === toolCallId))
            return calls.map(({ name }) => name);
    }
    return undefined;
}
export function findPassiveStopBoundary(branch, sessionId, entryType) {
    let checkpointSeen = false;
    for (const entry of [...branch].reverse()) {
        try {
            if (entry?.type !== "custom")
                continue;
            if (entry.customType === SNAPSHOT_ENTRY_TYPE) {
                parseRetainedPiCheckpoint(entry.data);
                checkpointSeen = true;
                continue;
            }
            if (entry.customType !== entryType)
                continue;
            const { at, from, reset, owner, preserveContext, persistenceError, mode } = entry.data ?? {};
            if (reset === true && owner === sessionId)
                return undefined;
            if (owner !== undefined && owner !== sessionId)
                continue;
            if (typeof at === "number" && Number.isSafeInteger(at) && at >= 0)
                return {
                    at,
                    ...(typeof from === "number" && Number.isSafeInteger(from) && from >= 0 ? { from } : {}),
                    ...(preserveContext === true ? { preserveContext: true } : {}),
                    ...(!checkpointSeen && owner === sessionId && typeof persistenceError === "string" && persistenceError.trim().length > 0 ? { persistenceError } : {}),
                    ...(mode === "passive" || mode === "off" ? { mode } : {}),
                };
        }
        catch {
            // A hostile unrelated branch entry cannot manufacture or suppress a valid marker.
        }
    }
    return undefined;
}
export function retainsPhysicalSessionProjection(reason) {
    return reason === undefined || reason === "startup" || reason === "reload" || reason === "resume";
}
