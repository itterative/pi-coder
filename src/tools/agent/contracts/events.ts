import type { AgentRunStatus } from "./runs";

export type AgentRunEvent = (
    | {
          type: "run";
          action: "created" | "restored";
          runId: string;
          agent: string;
          background: boolean;
          status: AgentRunStatus;
          workspaceId?: string;
      }
    | {
          type: "run";
          action: "progress";
          runId: string;
          status: AgentRunStatus;
          workspaceId?: string;
      }
    | {
          type: "run";
          action: "status_changed";
          runId: string;
          status: AgentRunStatus;
          previousStatus: AgentRunStatus;
          workspaceId?: string;
      }
    | {
          type: "run";
          action: "removed";
          runId: string;
          status: AgentRunStatus;
          reason:
              "collected" | "pruned" | "shutdown" | "terminal" | "canceled" | "restored_terminal";
          workspaceId?: string;
      }
) & {
    /** Parent project cwd used to scope browser refreshes for isolated worktrees. */
    parentCwd?: string;
};

export type AgentWorkspaceEvent = {
    type: "workspace";
    action: "created" | "updated" | "lease_changed" | "result_changed" | "removed";
    workspaceId: string;
    reason?: string;
};

export type AgentRuntimeEvent = {
    type: "runtime";
    action: "restored" | "reconciled" | "reset" | "shutdown";
    released?: number;
};

export type AgentEvent = (AgentRunEvent | AgentWorkspaceEvent | AgentRuntimeEvent) & {
    cwd: string;
    timestamp: number;
};

export type AgentEventPayload = AgentRunEvent | AgentWorkspaceEvent | AgentRuntimeEvent;

export interface AgentEventSink {
    emit(event: AgentEvent): void;
}
