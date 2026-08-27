import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { AgentWorkspaceBrowserItem, AgentSessionBrowserItem, WorkspaceDispositionAction } from "../../tools/agent/presentation/browser-models";
import type { BuiltinAgentName } from "../../tools/agent/config";

export type AgentSettingId = BuiltinAgentName | "advisorEnabled" | "notifyBusyWorkerChanges";

export interface AgentSetting {
    id: AgentSettingId;
    label: string;
    description: string;
    model?: string;
    enabled?: boolean;
}

export interface AgentModelOption {
    id?: string;
    label: string;
    description?: string;
}

export interface AgentSessionBrowserData {
    current: AgentSessionBrowserItem[];
    /** Persisted agents owned by the current parent session. */
    sessionPast?: AgentSessionBrowserItem[];
    /** Cwd-wide persisted agents, used by the historical view. */
    past: AgentSessionBrowserItem[];
    workspaces?: AgentWorkspaceBrowserItem[];
    settings?: AgentSetting[];
    models?: AgentModelOption[];
}

export interface AgentSessionBrowserOptions extends AgentSessionBrowserData {
    cwd?: string;
    eventBus?: EventBus;
    /** Render the Agents tab as loading until the initial async data arrives. */
    loadingAgents?: boolean;
    /** Render the Workspaces tab as loading until the initial async data arrives. */
    loadingWorkspaces?: boolean;
    onInitialLoad?: (signal: AbortSignal) => Promise<AgentSessionBrowserData>;
    onRefresh?: () => Promise<AgentSessionBrowserData>;
    fixedHeight?: () => number;
    onResume?: (item: AgentSessionBrowserItem) => void | Promise<void>;
    onCancel?: (item: AgentSessionBrowserItem) => void | Promise<void>;
    onWorkspaceAction?: (
        workspace: AgentWorkspaceBrowserItem,
        action: WorkspaceDispositionAction,
    ) => AgentWorkspaceBrowserItem | null | undefined | Promise<AgentWorkspaceBrowserItem | null | undefined>;
    onWorkspaceInspect?: (workspace: AgentWorkspaceBrowserItem) => string | Promise<string>;
    onModelChange?: (agent: BuiltinAgentName, model: string | undefined) => void | Promise<void>;
    onToggleChange?: (
        setting: "advisorEnabled" | "notifyBusyWorkerChanges",
        enabled: boolean,
    ) => void | Promise<void>;
    onModelChangeError?: (error: unknown) => void;
    onInvalidate?: () => void;
}

export interface AgentWorkspaceBrowserOptions {
    cwd: string;
    workspaces: AgentWorkspaceBrowserItem[];
    fixedHeight?: () => number;
}

export interface AgentWorkspaceActionCallbacks {
    onInspect?: () => string | Promise<string>;
    onAction?: (
        action: WorkspaceDispositionAction,
    ) => AgentWorkspaceBrowserItem | null | undefined | Promise<AgentWorkspaceBrowserItem | null | undefined>;
    onInvalidate?: () => void;
}

