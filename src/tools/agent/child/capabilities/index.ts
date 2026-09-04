import type { InlineExtension, ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * pi accepts either a bare factory or a named record; every capability here is a named record, so
 * publishers carry the `name`/`hidden`/`factory` members instead of a union that hides them.
 */
export type NamedInlineExtension = Exclude<InlineExtension, ExtensionFactory>;

import { hasAgentCapability } from "../../definitions/types";
import type { AgentCapability, AgentDefinition } from "../../definitions/types";
import type { ChildAgentFactoryContext } from "../../contracts/runs";
import type { ChildProgressTracker } from "../progress";
import { READ_UNIT } from "./read";
import { SEARCH_UNIT } from "./search";
import { EDIT_UNIT } from "./edit";
import { SAFE_BASH_UNIT } from "./safe-bash";
import { COMMAND_RUNNER_UNIT } from "./command-runner";
import { MEMORIES_UNIT } from "./memories";
import { SCRATCHPAD_UNIT } from "./scratchpad";
import { TODOLIST_UNIT } from "./todolist";

/** What a unit needs from the running child to contribute an extension. */
export interface ChildExtensionRuntime {
    tracker: ChildProgressTracker;
    onProgress: NonNullable<ChildAgentFactoryContext["onProgress"]>;
}

/**
 * One capability, and everything the child side grants for it.
 *
 * A unit answers three questions and owns no branching over its siblings: which tools it puts on the
 * session allowlist, which read roots it publishes, and which extension it registers. Anything that
 * depends on *other* capabilities is not resolved here: the ladder (`definitions/types.ts`) orders
 * command access, and the prompt profiles (`child/prompt`) describe the combination.
 *
 * Capability *implications* are deliberately absent from this interface. `command-runner` implying
 * `safe-bash` and `todolist` implying `scratchpad` are visible to the parent-facing catalog and hashed
 * into the persisted definition fingerprint, so they belong to the declaration layer in
 * `definitions/types.ts`. Duplicating them here would put two sources of truth on a durable contract.
 */
export interface ChildCapabilityUnit {
    readonly id: AgentCapability;
    /** SDK tool names this capability adds, in the order the session allowlist expects them. */
    readonly tools?: readonly string[];
    /** Additional read-only roots this capability publishes. */
    readonly readRoots?: (definition: AgentDefinition) => readonly string[];
    /** The extension this capability registers, or undefined when it needs none. */
    readonly extension?: (runtime: ChildExtensionRuntime) => NamedInlineExtension;
}

/**
 * Every unit, in the order its contributions must appear.
 *
 * The order is load-bearing twice over: the session allowlist is an ordered list the model sees, and
 * extension registration order decides which `tool_call` handler runs first. Read/search come before
 * edit and bash because that is the historical allowlist order, and the resource extensions follow in
 * memory, scratchpad, todolist order.
 */
const CAPABILITY_UNITS: readonly ChildCapabilityUnit[] = [
    READ_UNIT,
    SEARCH_UNIT,
    EDIT_UNIT,
    SAFE_BASH_UNIT,
    COMMAND_RUNNER_UNIT,
    MEMORIES_UNIT,
    SCRATCHPAD_UNIT,
    TODOLIST_UNIT,
];

/** The units a definition grants, baseline included. */
export function appliedUnits(definition: AgentDefinition): ChildCapabilityUnit[] {
    return CAPABILITY_UNITS.filter((unit) => hasAgentCapability(definition, unit.id));
}

/** Tools the granted capabilities put on the session allowlist. */
export function capabilityTools(definition: AgentDefinition): string[] {
    return appliedUnits(definition).flatMap((unit) => [...(unit.tools ?? [])]);
}

/**
 * Read roots beyond the working directory: the definition's own paths first, then whatever the
 * granted capabilities publish.
 */
export function capabilityReadRoots(definition: AgentDefinition): string[] {
    const roots = [...(definition.additionalPaths ?? [])];
    for (const unit of appliedUnits(definition)) {
        roots.push(...(unit.readRoots?.(definition) ?? []));
    }
    return [...new Set(roots)];
}

/** Extensions the granted capabilities register, in registry order. */
export function capabilityExtensions(runtime: ChildExtensionRuntime, definition: AgentDefinition) {
    return appliedUnits(definition).flatMap((unit) => {
        const extension = unit.extension?.(runtime);
        return extension ? [extension] : [];
    });
}
