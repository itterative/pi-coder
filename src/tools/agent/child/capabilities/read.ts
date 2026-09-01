import { READ_ONLY_AGENT_TOOLS } from "../../definitions/types";

/**
 * Direct file reading. Baseline capability: every child has it, and together with `search` it is the
 * whole read-only tool surface (`READ_ONLY_AGENT_TOOLS`), which
 * `test/tools/agent-capability-units.test.ts` keeps in step with the two units below.
 */
export const READ_UNIT = {
    id: "read",
    tools: READ_ONLY_AGENT_TOOLS.slice(0, 1),
} as const;
