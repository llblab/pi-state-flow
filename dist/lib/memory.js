function hasSemanticMemory(state) {
    return Object.keys(state.contract).length > 0 || Object.keys(state.working).length > 0;
}
export function retainedMemoryScopes(states) {
    return {
        global: hasSemanticMemory(states.global),
        cwd: hasSemanticMemory(states.cwd),
        session: hasSemanticMemory(states.session),
    };
}
