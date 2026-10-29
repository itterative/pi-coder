import type { CommandSpec } from "./spec";
import { READER_COMMANDS } from "./readers";
import { DIRECTORY_COMMANDS } from "./directories";
import { PATH_COMMANDS } from "./paths";
import { TEXT_COMMANDS } from "./text";
import { SED_COMMANDS } from "./sed";
import { COMPARISON_COMMANDS } from "./comparison";
import { CHECKSUM_COMMANDS } from "./checksums";
import { ARCHIVE_COMMANDS } from "./archives";
import { VCS_COMMANDS } from "./vcs";
import { SYSTEM_COMMANDS } from "./system";
import { SCRATCHPAD_MUTATOR_COMMANDS } from "./mutators";

export { CommandTag } from "./spec";
export type { CommandSpec, FlagSpec } from "./spec";

/**
 * Registry of commands known to the cwd-confinement heuristic.
 *
 * Only commands that cannot modify files outside of explicitly given paths
 * (or execute other programs) should be listed here. Scratchpad-only mutators
 * are explicitly marked and remain ineligible without an additional root.
 * Unknown commands fall back to the permission system.
 *
 * Growth policy: this table is deliberately finite and is not the answer to every
 * unfamiliar command. A read-only child's allowlist miss already reaches the decision
 * model through the `child` surface, which costs roughly half a second and ~870 input
 * tokens per judged call but keeps no state and needs no maintenance; prefer that for
 * one-off commands. Add an entry here only for a command an agent hits repeatedly,
 * where that per-call cost is worth paying once, in code, for everyone.
 */
export const KNOWN_COMMANDS: Record<string, CommandSpec> = {
    ...READER_COMMANDS,
    ...DIRECTORY_COMMANDS,
    ...PATH_COMMANDS,
    ...TEXT_COMMANDS,
    ...SED_COMMANDS,
    ...COMPARISON_COMMANDS,
    ...CHECKSUM_COMMANDS,
    ...ARCHIVE_COMMANDS,
    ...VCS_COMMANDS,
    ...SYSTEM_COMMANDS,
    ...SCRATCHPAD_MUTATOR_COMMANDS,
};
