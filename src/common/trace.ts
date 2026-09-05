/**
 * The one development switch for pi-coder's own diagnostic traces.
 *
 * It lives in `common` rather than in the agent observability module because both the delegated-agent
 * timelines and the compaction trace consult it, and a session module should not reach into the agent tool
 * to ask whether it may write a file. `observability/trace.ts` re-exports it unchanged, so the agent-side
 * imports and suites keep resolving where they always did.
 */

export const AGENT_TRACE_ENV = "PI_CODER_AGENT_TRACE";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function isAgentTraceEnabled(value = process.env[AGENT_TRACE_ENV]): boolean {
    // return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
    // TODO: enabled temporarily while developing the extension
    return true;
}
