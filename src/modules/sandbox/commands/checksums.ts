import type { CommandSpec } from "./spec";

/**
 * Checksums (all flags are booleans; -c reads a checksums file positional).
 * Includes the macOS aliases of the coreutils checksum tools.
 */
export const CHECKSUM_COMMANDS: Record<string, CommandSpec> = {
    cksum: {},
    md5sum: {},
    sha1sum: {},
    sha224sum: {},
    sha256sum: {},
    sha384sum: {},
    sha512sum: {},
    shasum: {},
    md5: {},
};
