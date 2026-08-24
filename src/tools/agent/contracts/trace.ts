export type AgentTraceValue = string | number | boolean | null;
export type AgentTraceData = Record<string, AgentTraceValue>;

export interface AgentTraceSink {
    start(runId: string, agent: string, data?: AgentTraceData): void;
    record(runId: string, type: string, data?: AgentTraceData): void;
    finish(runId: string, terminalStatus: string, data?: AgentTraceData): void;
}
