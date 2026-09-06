/**
 * The one development switch for pi-coder's own diagnostic traces.
 *
 * It lives in `common` rather than in the agent observability module because both the delegated-agent
 * timelines and the compaction trace consult it, and a session module should not reach into the agent tool
 * to ask whether it may write a file. `observability/trace.ts` re-exports it unchanged, so the agent-side
 * imports and suites keep resolving where they always did.
 */

import { randomBytes } from "node:crypto";

export const AGENT_TRACE_ENV = "PI_CODER_AGENT_TRACE";

/**
 * A short random id for one extension load, stamped on every diagnostic record pi-coder writes.
 *
 * Records describe a session and a time, which is not enough to reason about them once a session outlives a
 * process: two reloads can leave rows in the same file whose chains, config, and registered handlers were all
 * different, and nothing in the data said so. This is the field that makes "did these records come from the same
 * runtime?" a comparison instead of an inference - the question that cost a day to answer by other means.
 */
export const PROCESS_INSTANCE = randomBytes(4).toString("hex");

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function isAgentTraceEnabled(value = process.env[AGENT_TRACE_ENV]): boolean {
    // return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
    // TODO: enabled temporarily while developing the extension
    return true;
}
