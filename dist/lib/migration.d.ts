import { type JsonObject } from "./json.ts";
import { type RetainedModules } from "./semantic-module.ts";
import { type StateScope } from "./state.ts";
import { type ScopeStream } from "./temporal.ts";
/** Owns temporary pure semantic-dialect conversion; excludes I/O, publication, backup and lifecycle authority. */
export interface SemanticMigrationCandidate {
    sourceVersion: 1 | 2 | 3 | 4;
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
/** Translate a raw legacy checkpoint or replay patch before any known-field filtering. */
export declare function translateLegacySemanticObject(value: unknown): JsonObject;
/** Build a detached target candidate; publication still belongs to the guarded storage transaction. */
export declare function prepareSemanticMigration(value: unknown, scope: StateScope, sourceVersion: number, historyLimit?: number, targetModules?: RetainedModules): SemanticMigrationCandidate;
/** Decode a complete raw owner cohort before filtering; never load files, normalize authority or publish. */
export declare function prepareSerializedScopeMigration(sources: ScopeMigrationSources, scope: StateScope, expectedCwd?: string, targetModules?: RetainedModules): SerializedSemanticMigrationCandidate;
