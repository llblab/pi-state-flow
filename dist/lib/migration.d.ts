import { type JsonObject } from "./json.ts";
import { type RetainedModules } from "./semantic-module.ts";
import { type StateScope } from "./state.ts";
import { type ScopeStream } from "./temporal.ts";
/** Owns the pure v3/v4 semantic codec and module-descriptor upgrade; excludes I/O, publication, backup and lifecycle authority. */
export interface SemanticMigrationCandidate {
    sourceVersion: 3 | 4;
    targetVersion: 3 | 4;
    /** A format conversion is not an authored semantic transition or revision. */
    requiresConversion: boolean;
    stream: ScopeStream;
}
export type ScopeMigrationFile = "checkpoint" | "patches" | "meta";
export type ScopeMigrationSources = Partial<Record<ScopeMigrationFile, Uint8Array>>;
/** Detached evidence for later backup/CAS, not a publication capability or a filesystem observation. */
export interface MigrationByteReceipt {
    bytes: Uint8Array;
    identity: `sha256:${string}`;
}
export interface SerializedSemanticMigrationCandidate extends SemanticMigrationCandidate {
    basis: Record<ScopeMigrationFile, MigrationByteReceipt>;
    target: Record<ScopeMigrationFile, string>;
}
/** A known retired format, not corruption: self-healing must never reset it. */
export declare class RetiredSemanticFormatError extends Error {
}
/** State Flow 1.0.0 ended the temporary contract/working conversion window; refusal stays explicit. */
export declare function refuseRetiredSemanticVersion(version: unknown): never;
/** Build a detached target candidate; publication still belongs to the guarded storage transaction. */
export declare function prepareSemanticMigration(value: unknown, scope: StateScope, sourceVersion: number, historyLimit?: number, targetModules?: RetainedModules): SemanticMigrationCandidate;
/** Format and identity only, before any body decoding. This is not a source receipt. */
export declare function parseScopeMetadataHeader(source: string, scope: StateScope, expectedCwd?: string): {
    metadata: JsonObject;
    version: number;
};
/** Decode a complete raw owner cohort before filtering; never load files, normalize authority or publish. */
export declare function prepareSerializedScopeMigration(sources: ScopeMigrationSources, scope: StateScope, expectedCwd?: string, targetModules?: RetainedModules): SerializedSemanticMigrationCandidate;
