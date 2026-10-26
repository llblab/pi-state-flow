const SCOPE_ORDER = ["global", "cwd", "session"];
/** Missing global configuration defaults to all owners; this is not a retained-session fallback. */
export const DEFAULT_SCOPE_SELECTION = Object.freeze([...SCOPE_ORDER]);
/** Validate an explicit value and detach it in canonical overlay order, without granting owner acquisition. */
export function captureScopeSelection(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > SCOPE_ORDER.length) {
        throw new Error("State Flow scopes must be a nonempty unique array of global, cwd, session");
    }
    const requested = new Set();
    for (let index = 0; index < value.length; index++) {
        const scope = value[index];
        if (!Object.hasOwn(value, index) || !SCOPE_ORDER.some((allowed) => allowed === scope) || requested.has(scope)) {
            throw new Error("State Flow scopes must be a nonempty unique array of global, cwd, session");
        }
        requested.add(scope);
    }
    return Object.freeze(SCOPE_ORDER.filter((scope) => requested.has(scope)));
}
/** Complete only the next unused owner; values replace the full argument prefix. */
export function scopeSelectionArgumentCompletions(prefix) {
    const tokens = prefix.trimStart().split(/\s+/);
    const partial = tokens.pop();
    if (new Set(tokens).size !== tokens.length || tokens.some(token => !SCOPE_ORDER.some(scope => scope === token)))
        return [];
    return SCOPE_ORDER.filter(scope => !tokens.includes(scope) && scope.startsWith(partial))
        .map(scope => [...tokens, scope].join(" "));
}
/** Blank command arguments preserve policy; callers must not reinterpret them as all scopes. */
export function parseScopeSelectionArguments(args) {
    const tokens = args.trim();
    return tokens.length === 0 ? undefined : captureScopeSelection(tokens.split(/\s+/));
}
