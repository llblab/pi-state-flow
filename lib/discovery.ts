import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { hashArtifactSource, type ArtifactSourceIdentity } from "./artifact.ts";

/** Opaque source metadata discovered without decoding or retaining Markdown bodies. */
export interface ArtifactSourceCandidate extends ArtifactSourceIdentity {
	/** Raw byte count used as a conservative maintenance token-budget ceiling. */
	bytes: number;
}

export interface GlobalMarkdownDiscoveryResult {
	sources: ArtifactSourceCandidate[];
	removed: string[];
}

export function getKnowledgeRoot(agentDir = getAgentDir()): string {
	return resolve(agentDir, "knowledge");
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error
		? (error as NodeJS.ErrnoException).code
		: undefined;
}

function isMissing(error: unknown): boolean {
	return errorCode(error) === "ENOENT";
}

function isInside(root: string, path: string): boolean {
	const child = relative(root, path);
	return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function canonicalExistingPath(path: string): string | undefined {
	try {
		return realpathSync.native(path);
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

function readRegularFile(path: string): Buffer | undefined {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		if (!fstatSync(descriptor).isFile()) return undefined;
		return readFileSync(descriptor);
	} catch (error) {
		if (isMissing(error) || errorCode(error) === "ELOOP") return undefined;
		throw error;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

/** Discover regular `*.md` files beneath a Knowledge root without following directory or file symlinks. */
export function discoverGlobalMarkdownSources(knowledgeRoot = getKnowledgeRoot()): ArtifactSourceCandidate[] {
	const configuredRoot = resolve(knowledgeRoot);
	const root = canonicalExistingPath(configuredRoot);
	if (root === undefined) return [];
	if (!statSync(root).isDirectory()) throw new Error(`Knowledge root is not a directory: ${configuredRoot}`);

	const sources: ArtifactSourceCandidate[] = [];
	const visit = (directory: string): void => {
		const entries = readdirSync(directory, { withFileTypes: true })
			.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
		for (const entry of entries) {
			const candidate = join(directory, entry.name);
			let metadata;
			try {
				metadata = lstatSync(candidate);
			} catch (error) {
				if (isMissing(error)) continue;
				throw error;
			}
			if (metadata.isSymbolicLink()) continue;

			const canonical = canonicalExistingPath(candidate);
			if (canonical === undefined || !isInside(root, canonical)) continue;
			if (metadata.isDirectory()) {
				visit(canonical);
				continue;
			}
			if (!metadata.isFile() || !entry.name.endsWith(".md")) continue;

			const body = readRegularFile(canonical);
			if (body === undefined) continue;
			sources.push({ path: canonical, hash: hashArtifactSource(body), bytes: body.byteLength });
		}
	};

	visit(root);
	return sources.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

/** Session-lifetime index that makes source removals explicit on each initialization refresh. */
export class GlobalMarkdownDiscovery {
	readonly knowledgeRoot: string;
	#knownPaths = new Set<string>();

	constructor(knowledgeRoot = getKnowledgeRoot()) {
		this.knowledgeRoot = resolve(knowledgeRoot);
	}

	refresh(): GlobalMarkdownDiscoveryResult {
		const sources = discoverGlobalMarkdownSources(this.knowledgeRoot);
		const currentPaths = new Set(sources.map((source) => source.path));
		const removed = [...this.#knownPaths]
			.filter((path) => !currentPaths.has(path))
			.sort();
		this.#knownPaths = currentPaths;
		return { sources, removed };
	}
}
