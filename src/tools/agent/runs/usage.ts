import type { Usage } from "@earendil-works/pi-ai";

export const ZERO_USAGE: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
    },
};

export function cloneUsage(usage: Usage): Usage {
    return {
        ...usage,
        cost: { ...usage.cost },
    };
}

export function subtractUsage(current: Usage, previous: Usage): Usage {
    const reasoning = current.reasoning === undefined && previous.reasoning === undefined
        ? undefined
        : Math.max(0, (current.reasoning ?? 0) - (previous.reasoning ?? 0));
    const cacheWrite1h = current.cacheWrite1h === undefined && previous.cacheWrite1h === undefined
        ? undefined
        : Math.max(0, (current.cacheWrite1h ?? 0) - (previous.cacheWrite1h ?? 0));
    return {
        input: Math.max(0, current.input - previous.input),
        output: Math.max(0, current.output - previous.output),
        cacheRead: Math.max(0, current.cacheRead - previous.cacheRead),
        cacheWrite: Math.max(0, current.cacheWrite - previous.cacheWrite),
        ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
        ...(reasoning === undefined ? {} : { reasoning }),
        totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
        cost: {
            input: Math.max(0, current.cost.input - previous.cost.input),
            output: Math.max(0, current.cost.output - previous.cost.output),
            cacheRead: Math.max(0, current.cost.cacheRead - previous.cost.cacheRead),
            cacheWrite: Math.max(0, current.cost.cacheWrite - previous.cost.cacheWrite),
            total: Math.max(0, current.cost.total - previous.cost.total),
        },
    };
}
