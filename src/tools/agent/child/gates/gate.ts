import type { ChildGateRuntime } from "./runtime";

/** A block decision returned by a `tool_call` handler, in pi's event-result shape. */
export interface ChildGateBlock {
    block: boolean;
    reason?: string;
}

/**
 * One authorization surface a child installs.
 *
 * A gate decides *whether it applies* from the resolved grant, and installs whatever hooks, tools, or
 * prompts its capability needs. Gates must not reach into each other's state: anything shared lives on
 * the runtime, precisely so that a capability can be read in one file without knowing which other
 * capabilities the child holds.
 */
export interface ChildGate {
    /** Identifies the gate in comments, traces, and the composition test. */
    readonly id: string;
    /** Defaults to always installed, for gates whose state is harmless without the capability. */
    readonly applies?: (runtime: ChildGateRuntime) => boolean;
    readonly install: (runtime: ChildGateRuntime) => void;
}

export function gateApplies(gate: ChildGate, runtime: ChildGateRuntime): boolean {
    return gate.applies?.(runtime) ?? true;
}
