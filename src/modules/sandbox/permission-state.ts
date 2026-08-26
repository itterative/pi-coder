import type { Permission } from "./permissions";

/** Permission choices shared by a parent runtime and its non-isolated children. */
export interface PermissionState {
    bashRules: Record<string, Permission>;
    bashSandboxed: boolean;
    fileFolders: {
        read: Set<string>;
        write: Set<string>;
    };
}

const states = new WeakMap<object, PermissionState>();

export function createPermissionState(): PermissionState {
    return {
        bashRules: {},
        bashSandboxed: true,
        fileFolders: {
            read: new Set<string>(),
            write: new Set<string>(),
        },
    };
}

export function getPermissionState(sessionManager: object): PermissionState {
    const existing = states.get(sessionManager);
    if (existing) return existing;

    const state = createPermissionState();
    states.set(sessionManager, state);
    return state;
}

export function resetBashPermissionState(state: PermissionState): void {
    state.bashRules = {};
    state.bashSandboxed = true;
}
