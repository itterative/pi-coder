import { READ_ONLY_AGENT_TOOLS } from "../../definitions/types";

/**
 * Repository search: the name/contents/path tools a child uses to find code before reading it.
 *
 * Shares its tool list with `read.ts` because both are baseline grants: the remaining three
 * read-only tools come from here, so a child that declares nothing still gets the same four tools the
 * `READ_ONLY_AGENT_TOOLS` constant names, in that order.
 */
export const SEARCH_UNIT = {
    id: "search",
    tools: READ_ONLY_AGENT_TOOLS.slice(1),
} as const;
