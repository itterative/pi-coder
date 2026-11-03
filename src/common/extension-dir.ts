import path from "node:path";
import { fileURLToPath } from "node:url";

/** Root of this installed pi-coder extension, for both source and compiled layouts. */
export const PI_CODER_EXTENSION_DIR = path.resolve(
    fileURLToPath(new URL("../..", import.meta.url)),
);
