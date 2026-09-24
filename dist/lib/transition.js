import { compileArtifact, ORDINARY_ARTIFACT_COMPILER, validateArtifactMetadata, validateArtifactRegistry, validateModelArtifactPatch, } from "./artifact.js";
import { createAcceptedTransition } from "./history.js";
import { applyPatch, containsNull, hashJson, isObject, validatePatch } from "./json.js";
import { hasCompiledSkillArtifact, SKILL_ARTIFACT_COMPILER } from "./skills.js";
const SCOPES = new Set(["global", "cwd", "session"]);
const PATCH_KEYS = new Set(["intents", "contract", "working", "artifacts", "lazy"]);
function compileReadArtifacts(nextState, patch, successfulArtifactReads, provenance) {
    for (const read of successfulArtifactReads) {
        const output = patch.artifacts[read.path];
        if (!isObject(output)) {
            throw new Error(`Successfully read invalidated artifact requires compiler output at ${read.scope ?? "global"}.artifacts[${JSON.stringify(read.path)}]`);
        }
        const compiled = compileArtifact({
            source: { path: read.path, scope: read.scope, hash: read.hash, sourceFingerprint: read.sourceFingerprint },
            compiler: ORDINARY_ARTIFACT_COMPILER,
            output: output,
        });
        validateArtifactMetadata(compiled.semantic, read.path);
        Object.defineProperty(nextState.artifacts, read.path, {
            value: compiled.semantic,
            enumerable: true,
            configurable: true,
            writable: true,
        });
        provenance[read.path] = compiled.provenance;
    }
}
function validateSkillCompilerOutput(scope, path, output) {
    const problems = [];
    if (!isObject(output))
        problems.push("artifact entry is missing");
    else {
        if (typeof output.description !== "string" || output.description.trim().length === 0)
            problems.push("description must be non-empty");
        if (output.kind !== "skill")
            problems.push('kind must be "skill"');
        if (!isObject(output.compilation) || Object.keys(output.compilation).length === 0)
            problems.push("compilation object must be non-empty");
    }
    if (problems.length === 0)
        return;
    const target = `${scope}.artifacts[${JSON.stringify(path)}]`;
    throw new Error(`Invalid Skill at ${target}: ${problems.join("; ")}`);
}
function validateSkillCompilerTargets(patches, successfulSkillReads) {
    for (const read of successfulSkillReads) {
        for (const scope of SCOPES) {
            if (scope === read.scope)
                continue;
            const artifacts = patches.get(scope)?.artifacts;
            if (artifacts && Object.hasOwn(artifacts, read.path) && artifacts[read.path] !== null) {
                throw new Error(`Registered Skill compiler output for ${read.path} belongs at ${read.scope}.artifacts[${JSON.stringify(read.path)}], not ${scope}.artifacts`);
            }
        }
    }
}
function compileReadSkills(scope, nextState, patch, successfulSkillReads, provenance) {
    for (const read of successfulSkillReads) {
        if (!Object.hasOwn(patch.artifacts, read.path))
            continue;
        if (read.hash === undefined) {
            throw new Error(`Could not capture the source hash for successfully read Skill ${read.path}: ${read.error ?? "unknown error"}`);
        }
        const output = patch.artifacts[read.path];
        validateSkillCompilerOutput(scope, read.path, output);
        const compiled = compileArtifact({
            source: { path: read.path, scope, hash: read.hash },
            compiler: SKILL_ARTIFACT_COMPILER,
            output: { ...structuredClone(output), kind: "skill" },
        });
        validateArtifactMetadata(compiled.semantic, read.path);
        Object.defineProperty(nextState.artifacts, read.path, {
            value: compiled.semantic,
            enumerable: true,
            configurable: true,
            writable: true,
        });
        provenance[read.path] = compiled.provenance;
        if (!hasCompiledSkillArtifact(nextState.artifacts, provenance[read.path], read.path, read.hash)) {
            throw new Error(`Skill artifact compilation at ${read.path} is not locally materialized for its executed source identity`);
        }
    }
}
function validateMaterializedTransition(nextState, scope) {
    if (containsNull(nextState)) {
        throw new Error("Materialized state cannot contain null; use null only as an object-key deletion marker");
    }
    validateArtifactRegistry(nextState.artifacts, `${scope}.artifacts`);
    if (Object.hasOwn(nextState.contract, "compiled_skills")) {
        throw new Error("contract.compiled_skills is retired; Skill compilations belong only in source-addressed artifacts");
    }
}
function validateScopePatch(scope, patch) {
    if (typeof scope !== "string" || !SCOPES.has(scope)) {
        throw new Error(`Unknown State Flow transition scope: ${String(scope)}`);
    }
    validatePatch(patch);
    for (const key of Object.keys(patch)) {
        if (!PATCH_KEYS.has(key)) {
            throw new Error(`Unknown State Flow patch key ${JSON.stringify(key)}; expected one of: ${[...PATCH_KEYS].join(", ")}`);
        }
    }
    for (const key of ["artifacts", "contract", "working", "intents"]) {
        if (Object.hasOwn(patch, key) && !isObject(patch[key])) {
            throw new Error(`Scoped State Flow patch field ${key} must be a JSON object`);
        }
    }
    if (Object.hasOwn(patch, "lazy") && !isObject(patch.lazy)) {
        throw new Error("Scoped State Flow patch field lazy must be a JSON object");
    }
    if (isObject(patch.artifacts))
        validateModelArtifactPatch(patch.artifacts, `${scope}.artifacts`);
}
function completePatch(patch, response) {
    return {
        artifacts: patch.artifacts ?? {},
        contract: patch.contract ?? {},
        working: patch.working ?? {},
        intents: patch.intents ?? {},
        response,
        lazy: structuredClone(patch.lazy ?? {}),
    };
}
/** Stage all scope updates against one immutable basis before any state is published. */
function stageScopedSemanticTransition(currentStates, transition, successfulSkillReads, causalBasis, successfulArtifactReads, acceptedResponse) {
    if (!Array.isArray(transition.transitions))
        throw new Error("State Flow transitions must be an array");
    const patches = new Map();
    for (const item of transition.transitions) {
        if (!isObject(item))
            throw new Error("Every State Flow transition must be an object");
        const keys = Object.keys(item).sort();
        if (keys.length !== 2 || keys[0] !== "patch" || keys[1] !== "scope") {
            throw new Error('Every State Flow transition must contain exactly "scope" and "patch"');
        }
        validateScopePatch(item.scope, item.patch);
        const scope = item.scope;
        if (patches.has(scope))
            throw new Error(`Duplicate State Flow transition scope: ${scope}`);
        patches.set(scope, item.patch);
    }
    const artifactReads = [...successfulArtifactReads];
    const skillReads = [...successfulSkillReads];
    validateSkillCompilerTargets(patches, skillReads);
    const nextStates = { ...currentStates };
    const provenanceUpdates = { global: {}, cwd: {}, session: {} };
    for (const scope of SCOPES) {
        const authored = patches.get(scope) ?? {};
        const response = scope === "session" && acceptedResponse !== undefined
            ? acceptedResponse
            : currentStates[scope].response;
        const patch = completePatch(authored, response);
        const nextState = applyPatch(currentStates[scope], patch);
        compileReadArtifacts(nextState, { artifacts: authored.artifacts ?? {} }, artifactReads.filter((read) => (read.scope ?? "global") === scope), provenanceUpdates[scope]);
        compileReadSkills(scope, nextState, { artifacts: authored.artifacts ?? {} }, skillReads.filter((read) => read.scope === scope), provenanceUpdates[scope]);
        validateMaterializedTransition(nextState, scope);
        nextStates[scope] = nextState;
    }
    return {
        nextStates,
        provenanceUpdates,
        stateHashes: {
            global: hashJson(currentStates.global),
            cwd: hashJson(currentStates.cwd),
            session: hashJson(currentStates.session),
        },
        causalBasis,
        committed: false,
    };
}
/** Stage one canonical atomic scope cohort without changing the finalized response. */
export function stageAtomicScopePatches(currentStates, patches, successfulSkillReads, causalBasis, successfulArtifactReads = []) {
    if (!isObject(patches))
        throw new Error("Atomic State Flow scope patches must be an object");
    for (const key of Object.keys(patches)) {
        if (!SCOPES.has(key))
            throw new Error(`Unknown atomic State Flow scope: ${key}`);
    }
    const transitions = [];
    for (const scope of ["global", "cwd", "session"]) {
        if (Object.hasOwn(patches, scope))
            transitions.push({ scope, patch: patches[scope] });
    }
    return stageScopedSemanticTransition(currentStates, { transitions }, successfulSkillReads, causalBasis, successfulArtifactReads);
}
export function stageScopedTransition(currentStates, transition, successfulSkillReads, causalBasis, successfulArtifactReads = []) {
    if (typeof transition.response !== "string") {
        throw new Error("Accepted State Flow response body must be a string");
    }
    return stageScopedSemanticTransition(currentStates, transition, successfulSkillReads, causalBasis, successfulArtifactReads, transition.response);
}
export function commitScopedTransition(snapshot, states, stage, publishDurable, causalBasis, options = {}) {
    if (stage.committed)
        return false;
    if (causalBasis !== stage.causalBasis)
        throw new Error("State Flow causal basis changed before response reconciliation; rematerialize state before retrying");
    for (const scope of SCOPES) {
        if (hashJson(states[scope]) !== stage.stateHashes[scope]) {
            throw new Error(`State Flow ${scope} scope changed before response reconciliation; rematerialize state before retrying`);
        }
    }
    // The finalized response may differ from message_end after chained handlers.
    // Derive replay input only here, from the complete accepted semantic result.
    const accepted = createAcceptedTransition(states, stage.nextStates);
    if (accepted !== undefined && snapshot.meta.step >= Number.MAX_SAFE_INTEGER) {
        throw new Error("State Flow iteration counter is exhausted; start a fresh episode");
    }
    const nextSnapshot = structuredClone(snapshot);
    if (accepted !== undefined)
        nextSnapshot.meta.step += 1;
    if (options.finalizeRun !== false) {
        nextSnapshot.meta.validation = undefined;
        nextSnapshot.meta.bootstrap = false;
    }
    publishDurable(accepted, nextSnapshot);
    states.global = structuredClone(stage.nextStates.global);
    states.cwd = structuredClone(stage.nextStates.cwd);
    states.session = structuredClone(stage.nextStates.session);
    if (accepted !== undefined)
        snapshot.meta.step += 1;
    if (options.finalizeRun !== false) {
        snapshot.meta.validation = undefined;
        snapshot.meta.bootstrap = false;
    }
    stage.committed = true;
    return true;
}
