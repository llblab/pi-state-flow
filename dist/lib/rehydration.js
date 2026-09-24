import { decideArtifactAcquisition, } from "./acquisition.js";
/** Plan visible reads only; this function never reads, compiles, mutates, or publishes sources. */
export function planKnowledgeRehydration(phase, routes, options = {}) {
    const maxReads = Math.max(0, Math.floor(options.maxReads ?? 1));
    const maxSourceBytes = Math.max(0, Math.floor(options.maxSourceBytes ?? 64 * 1024));
    const reads = [];
    const materialized = [];
    const deferred = [];
    let sourceBytes = 0;
    for (const route of [...routes].sort((left, right) => left.source.path.localeCompare(right.source.path))) {
        if (phase === "new-bootstrap" && route.scope === "session") {
            deferred.push({ path: route.source.path, reason: "new-session-scope" });
            continue;
        }
        const decision = decideArtifactAcquisition(route.source, route.metadata, route.compiler, {
            intent: route.intent,
            ...(route.materializedSufficient === undefined ? {} : { materializedSufficient: route.materializedSufficient }),
            ...(route.explicitRefresh === undefined ? {} : { explicitRefresh: route.explicitRefresh }),
            ...(route.provenance === undefined ? {} : { provenance: route.provenance }),
        });
        if (decision.kind === "use-materialized") {
            materialized.push(route.source.path);
            continue;
        }
        if (reads.length >= maxReads) {
            deferred.push({ path: route.source.path, reason: "read-count-limit" });
            continue;
        }
        const bytes = route.sourceBytes ?? 0;
        if (sourceBytes + bytes > maxSourceBytes) {
            deferred.push({ path: route.source.path, reason: "source-byte-limit" });
            continue;
        }
        sourceBytes += bytes;
        reads.push({
            scope: route.scope, path: route.source.path, reason: decision.reason,
            ...(route.source.hash === undefined ? {} : { hash: route.source.hash }),
            ...(route.source.sourceFingerprint === undefined ? {} : { sourceFingerprint: structuredClone(route.source.sourceFingerprint) }),
        });
    }
    return { reads, materialized, deferred };
}
