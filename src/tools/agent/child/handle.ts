import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

import type { AgentTraceData } from "../contracts/trace";
import type { ChildAgentHandle } from "../contracts/runs";
import {
    aggregateUsage,
    childError,
    mutationReport,
    snapshotProgress,
    textFromAssistantMessage,
    type ChildProgressTracker,
} from "./progress";
import { repairInterruptedToolCalls } from "./transcript";

/**
 * The handle the parent runs and collects a child through.
 *
 * Every accessor reads live session or tracker state rather than a snapshot taken here, so the
 * manager can poll progress, output, usage, and errors at any point in the run without the child
 * having to push them. The two exceptions are deliberate: `sessionFile` is captured at construction,
 * because the transcript path identifies this run even after the session is disposed, and
 * `takeParentQuestion` clears as it reads, because a question is a one-shot signal that must not be
 * answered twice.
 *
 * `dispose` is guarded by a flag because both the manager's teardown and the factory's own rollback
 * path can reach it; the guard is what keeps a single session from being unsubscribed and disposed
 * twice. Prompt templates are never expanded here either, since a child's task text comes from its
 * parent rather than from an end user's slash command.
 */
export function createChildHandle(request: {
    session: AgentSession;
    sessionManager: SessionManager;
    tracker: ChildProgressTracker;
    unsubscribe: () => void;
    onTrace?: (type: string, data?: AgentTraceData) => void;
}): ChildAgentHandle {
    const { session, sessionManager, tracker, unsubscribe, onTrace } = request;
    let disposed = false;

    return {
        prompt: (text) =>
            session.prompt(text, { expandPromptTemplates: false, source: "extension" }),
        abort: () => session.abort(),
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            onTrace?.("session.dispose_called");
            unsubscribe();
            session.dispose();
        },
        takeParentQuestion() {
            const question = tracker.pendingQuestion;
            tracker.pendingQuestion = undefined;
            return question;
        },
        getProgress: () => snapshotProgress(tracker),
        getFinalOutput() {
            const assistant = [...session.state.messages]
                .reverse()
                .find((message) => message.role === "assistant");
            return textFromAssistantMessage(assistant);
        },
        getError: () => childError(session),
        getUsage: () => aggregateUsage(session),
        getSessionLeafId: () => sessionManager.getLeafId(),
        repairInterrupted: () => {
            const repaired = repairInterruptedToolCalls(sessionManager);
            onTrace?.("session.repaired", { unmatchedToolCalls: repaired });
            return repaired;
        },
        getMutationReport: () => mutationReport(tracker),
        sessionFile: sessionManager.getSessionFile(),
    };
}
