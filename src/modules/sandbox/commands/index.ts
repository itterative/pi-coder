import type { CommandSpec } from "./spec";
import { READER_COMMANDS } from "./readers";
import { DIRECTORY_COMMANDS } from "./directories";
import { PATH_COMMANDS } from "./paths";
import { TEXT_COMMANDS } from "./text";
import { COMPARISON_COMMANDS } from "./comparison";
import { CHECKSUM_COMMANDS } from "./checksums";
import { ARCHIVE_COMMANDS } from "./archives";
import { VCS_COMMANDS } from "./vcs";
import { SYSTEM_COMMANDS } from "./system";

export type { CommandSpec, FlagSpec } from "./spec";

/**
 * Registry of commands known to the cwd-confinement heuristic.
 *
 * Only commands that cannot modify files outside of explicitly given paths
 * (or execute other programs) should be listed here. Unknown commands fall
 * back to the permission system.
 */
export const KNOWN_COMMANDS: Record<string, CommandSpec> = {
    ...READER_COMMANDS,
    ...DIRECTORY_COMMANDS,
    ...PATH_COMMANDS,
    ...TEXT_COMMANDS,
    ...COMPARISON_COMMANDS,
    ...CHECKSUM_COMMANDS,
    ...ARCHIVE_COMMANDS,
    ...VCS_COMMANDS,
    ...SYSTEM_COMMANDS,
};
