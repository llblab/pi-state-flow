import { type ArtifactProvenance, type ArtifactRegistry } from "./artifact.ts";
import { type ScopeSelection } from "./selection.ts";
import type { AtomicScopePatches, StateScope } from "./state.ts";
export declare const SKILL_ARTIFACT_COMPILER = "skill-artifact-v1";
export declare function hasCompiledSkillArtifact(artifacts: ArtifactRegistry, provenance: ArtifactProvenance | undefined, source: string, expectedHash?: string): boolean;
export type SkillSourceHasher = (source: string) => string;
export declare function hashSkillSource(source: string): string;
export interface SuccessfulSkillRead {
    path: string;
    scope: StateScope;
    hash?: string;
    error?: string;
}
export interface SkillCommandInfo {
    source: string;
    sourceInfo: {
        path: string;
        scope: string;
    };
}
export interface RegisteredSkillSource {
    path: string;
    scope: StateScope;
}
export type RegisteredSkillResolver = (path: string) => RegisteredSkillSource | undefined;
export declare function registeredSkillResolver(cwd: string, commands: readonly SkillCommandInfo[]): RegisteredSkillResolver;
/** Correlates Pi's mutable tool lifecycle and captures trusted source identity. */
export declare class SkillReadTracker {
    #private;
    readonly successful: Map<string, SuccessfulSkillRead>;
    readonly hashSource: SkillSourceHasher;
    readonly resolveRegistered: RegisteredSkillResolver;
    constructor(hashSource?: SkillSourceHasher, resolveRegistered?: RegisteredSkillResolver, selection?: ScopeSelection);
    /** Selection changes revoke correlated reads; a disabled Skill still retains ownership-only volatile evidence. */
    select(selection: ScopeSelection): void;
    /** Rehash only attempted selected compilations; this body acquisition must run outside canonical exclusion. */
    validateCompilations(patches: AtomicScopePatches): void;
    clear(): void;
    recordStart(toolCallId: string, toolName: string, args: unknown): void;
    recordCall(toolCallId: string, toolName: string, input: unknown): void;
    recordEnd(toolCallId: string, toolName: string, isError: boolean): void;
    recordResult(toolName: string, input: unknown, isError: boolean): SuccessfulSkillRead | undefined;
    delete(path: string): void;
}
