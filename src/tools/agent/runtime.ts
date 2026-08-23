import type { Usage } from "@earendil-works/pi-ai";

import type { AgentDefinition } from "./discovery";
import type { AgentTraceData, AgentTraceStore } from "./trace";

export type AgentRunStatus =
    | "starting"
    | "running"
    | "waiting_for_parent"
    | "completed"
    | "failed"
    | "aborted"
    | "canceled";

export interface ParentQuestion {
    question: string;
    context?: string;
    options?: string[];
    recommendation?: string;
}

export interface ChildProgress {
    output: string;
    recentActivity: string[];
}

export interface ChildAgentHandle {
    prompt(text: string): Promise<void>;
    abort(): Promise<void>;
    dispose(): void;
    takeParentQuestion(): ParentQuestion | undefined;
    getProgress(): ChildProgress;
    getFinalOutput(): string;
    getError(): string | undefined;
    getUsage(): Usage;
}

export interface ChildAgentFactoryContext {
    cwd: string;
    definition: AgentDefinition;
    parentContext: unknown;
    onProgress: (progress: ChildProgress) => void;
    onTrace?: (type: string, data?: AgentTraceData) => void;
}

export type ChildAgentFactory = (
    context: ChildAgentFactoryContext,
) => Promise<ChildAgentHandle>;

export interface AgentRunDetails {
    runId: string;
    agent: string;
    agentSource?: string;
    agentFilePath?: string;
    status: AgentRunStatus;
    task: string;
    output?: string;
    question?: ParentQuestion;
    recentActivity: string[];
    usage: Usage;
    startedAt: number;
    updatedAt: number;
    error?: string;
    discoveryDiagnostics?: string[];
}

export interface AgentRunOutcome {
    content: string;
    details: AgentRunDetails;
    usage: Usage;
    isError: boolean;
}

export type AgentProgressCallback = (details: AgentRunDetails) => void;

interface AgentRun {
    id: string;
    agent: string;
    agentSource: string;
    agentFilePath?: string;
    task: string;
    status: AgentRunStatus;
    handle?: ChildAgentHandle;
    setup?: Promise<ChildAgentHandle>;
    question?: ParentQuestion;
    usageCheckpoint: Usage;
    startedAt: number;
    updatedAt: number;
    disposed: boolean;
    shutdownRequested: boolean;
    operation?: Promise<AgentRunOutcome>;
    abortPromise?: Promise<void>;
}

export class AgentActionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AgentActionError";
    }
}

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

function cloneUsage(usage: Usage): Usage {
    return {
        ...usage,
        cost: { ...usage.cost },
    };
}

function subtractUsage(current: Usage, previous: Usage): Usage {
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

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

const MAX_TASK_CHARS = 16_000;
const MAX_GUIDANCE_CHARS = 16_000;
const MAX_OUTPUT_CHARS = 32_000;

export class AgentRunManager {
    private readonly runs = new Map<string, AgentRun>();
    private nextRunNumber = 1;
    private closing = false;
    private shutdownPromise?: Promise<void>;

    constructor(
        private readonly factory: ChildAgentFactory,
        private readonly maxActiveRuns = 4,
        private readonly trace?: AgentTraceStore,
    ) {}

    get activeCount(): number {
        return this.runs.size;
    }

    listWaiting(): Array<{ runId: string; agent: string; question: string }> {
        return [...this.runs.values()]
            .filter((run) => run.status === "waiting_for_parent" && run.question !== undefined)
            .map((run) => ({
                runId: run.id,
                agent: run.agent,
                question: truncate(run.question!.question, 500),
            }));
    }

    async start(
        definitionOrName: AgentDefinition | string,
        task: string,
        context: Omit<ChildAgentFactoryContext, "definition" | "onProgress">,
        signal?: AbortSignal,
        onProgress?: AgentProgressCallback,
    ): Promise<AgentRunOutcome> {
        if (this.closing) {
            throw new AgentActionError("Agent runtime is shutting down.");
        }
        if (!task.trim()) {
            throw new AgentActionError("Agent task must not be empty.");
        }
        if (task.length > MAX_TASK_CHARS) {
            throw new AgentActionError(`Agent task exceeds ${MAX_TASK_CHARS} characters.`);
        }
        if (this.runs.size >= this.maxActiveRuns) {
            throw new AgentActionError(
                `Agent run limit reached (${this.maxActiveRuns}). Resume or cancel a waiting run first.`,
            );
        }

        const definition: AgentDefinition = typeof definitionOrName === "string"
            ? {
                name: definitionOrName,
                description: "Test or built-in agent",
                tools: ["read", "grep", "find", "ls"],
                systemPrompt: "",
                source: "builtin",
            }
            : definitionOrName;
        const now = Date.now();
        const id = `${definition.name}-${this.nextRunNumber++}`;
        const run: AgentRun = {
            id,
            agent: definition.name,
            agentSource: definition.source,
            agentFilePath: definition.filePath,
            task,
            status: "starting",
            usageCheckpoint: cloneUsage(ZERO_USAGE),
            startedAt: now,
            updatedAt: now,
            disposed: false,
            shutdownRequested: false,
        };
        this.runs.set(id, run);
        this.trace?.start(id, definition.name, {
            source: definition.source,
            taskChars: task.length,
            model: definition.model ?? "parent",
        });

        try {
            this.record(run, "setup.started");
            run.setup = this.factory({
                ...context,
                definition,
                onProgress: (progress) => {
                    run.updatedAt = Date.now();
                    this.record(run, "child.progress", {
                        outputChars: progress.output.length,
                        activity: progress.recentActivity[progress.recentActivity.length - 1] ?? "",
                    });
                    onProgress?.(this.details(run, progress));
                },
                onTrace: (type, data) => this.record(run, `child.${type}`, data),
            });
            run.handle = await run.setup;
            this.record(run, "setup.completed");
        } catch (error) {
            const message = errorMessage(error);
            this.record(run, "setup.failed", { error: truncate(message, 500) });
            return this.finishFailure(run, `Failed to create child session: ${message}`);
        }

        if (this.closing || run.shutdownRequested || signal?.aborted) {
            this.record(run, "setup.aborted_after_completion");
            return this.finishTerminal(run, "aborted", "Agent run was aborted.", true);
        }

        return this.beginOperation(run, task, signal, onProgress);
    }

    async resume(
        runId: string,
        guidance: string,
        signal?: AbortSignal,
        onProgress?: AgentProgressCallback,
    ): Promise<AgentRunOutcome> {
        const run = this.runs.get(runId);
        if (!run) {
            throw new AgentActionError(`Unknown or stale agent run ID: ${runId}`);
        }
        if (run.status !== "waiting_for_parent") {
            throw new AgentActionError(
                `Agent run ${runId} is ${run.status}; only waiting runs can be resumed.`,
            );
        }
        if (!guidance.trim()) {
            throw new AgentActionError("Parent guidance must not be empty.");
        }
        if (guidance.length > MAX_GUIDANCE_CHARS) {
            throw new AgentActionError(`Parent guidance exceeds ${MAX_GUIDANCE_CHARS} characters.`);
        }
        if (this.closing) {
            throw new AgentActionError("Agent runtime is shutting down.");
        }

        this.record(run, "resume.requested", { guidanceChars: guidance.length });
        run.status = "running";
        run.question = undefined;
        run.updatedAt = Date.now();
        return this.beginOperation(
            run,
            `Parent guidance:\n${guidance}`,
            signal,
            onProgress,
        );
    }

    cancel(runId: string): AgentRunOutcome {
        const run = this.runs.get(runId);
        if (!run) {
            throw new AgentActionError(`Unknown or stale agent run ID: ${runId}`);
        }
        if (run.status !== "waiting_for_parent") {
            throw new AgentActionError(
                `Agent run ${runId} is ${run.status}; only waiting runs can be canceled.`,
            );
        }
        this.record(run, "cancel.requested");
        return this.finishTerminal(run, "canceled", `Agent run ${runId} canceled.`, false);
    }

    shutdown(): Promise<void> {
        this.shutdownPromise ??= this.performShutdown();
        return this.shutdownPromise;
    }

    private async performShutdown(): Promise<void> {
        this.closing = true;

        const runs = [...this.runs.values()];
        for (const run of runs) {
            this.record(run, "shutdown.requested", { status: run.status });
            run.shutdownRequested = true;
            if (run.status === "running" || run.status === "starting") {
                void this.abortRun(run)?.catch(() => {});
            }
        }

        await Promise.allSettled(
            runs
                .map((run) => run.setup)
                .filter((setup): setup is Promise<ChildAgentHandle> => setup !== undefined),
        );

        for (const run of runs) {
            run.shutdownRequested = true;
            if (run.status === "running" || run.status === "starting") {
                void this.abortRun(run)?.catch(() => {});
            }
        }
        await Promise.allSettled(
            runs
                .map((run) => run.operation)
                .filter((operation): operation is Promise<AgentRunOutcome> => operation !== undefined),
        );

        for (const run of runs) {
            if (!this.runs.has(run.id)) continue;
            this.disposeRun(run);
            this.trace?.finish(run.id, "aborted", {
                isError: true,
                reason: "session_shutdown",
            });
            this.runs.delete(run.id);
        }
    }

    private async beginOperation(
        run: AgentRun,
        prompt: string,
        signal?: AbortSignal,
        onProgress?: AgentProgressCallback,
    ): Promise<AgentRunOutcome> {
        run.status = "running";
        run.updatedAt = Date.now();
        this.record(run, "operation.started", {
            kind: prompt.startsWith("Parent guidance:\n") ? "resume" : "start",
            promptChars: prompt.length,
        });
        const operation = this.drive(run, prompt, signal, onProgress);
        run.operation = operation;
        try {
            return await operation;
        } finally {
            if (run.operation === operation) run.operation = undefined;
        }
    }

    private async drive(
        run: AgentRun,
        prompt: string,
        signal?: AbortSignal,
        onProgress?: AgentProgressCallback,
    ): Promise<AgentRunOutcome> {
        const handle = run.handle!;
        let aborted = signal?.aborted ?? false;
        const abort = () => {
            aborted = true;
            this.record(run, "operation.abort_requested");
            this.abortRun(run);
        };
        signal?.addEventListener("abort", abort, { once: true });

        try {
            if (aborted) {
                abort();
            } else {
                await handle.prompt(prompt);
                this.record(run, "operation.prompt_settled");
            }
            await run.abortPromise?.catch(() => {});
        } catch (error) {
            const message = errorMessage(error);
            this.record(run, "operation.prompt_failed", { error: truncate(message, 500) });
            await run.abortPromise?.catch(() => {});
            if (!aborted && !run.shutdownRequested) {
                return this.finishFailure(run, message);
            }
        } finally {
            signal?.removeEventListener("abort", abort);
        }

        if (aborted || run.shutdownRequested || this.closing) {
            return this.finishTerminal(run, "aborted", "Agent run was aborted.", true);
        }

        const question = handle.takeParentQuestion();
        const progress = handle.getProgress();
        const childError = handle.getError();
        if (question) {
            this.record(run, "guidance.requested", {
                questionChars: question.question.length,
                questionPreview: truncate(question.question.replace(/\s+/g, " "), 240),
                optionCount: question.options?.length ?? 0,
            });
            run.status = "waiting_for_parent";
            run.question = question;
            run.updatedAt = Date.now();
            const outcome = this.outcome(
                run,
                this.waitingContent(run, question, progress),
                false,
                progress,
            );
            run.usageCheckpoint = cloneUsage(run.handle!.getUsage());
            onProgress?.(outcome.details);
            return outcome;
        }

        if (childError) {
            this.record(run, "child.error_selected", { error: truncate(childError, 500) });
            return this.finishFailure(run, childError, progress);
        }

        const rawOutput = handle.getFinalOutput().trim();
        const output = truncate(rawOutput, MAX_OUTPUT_CHARS);
        if (!output) {
            this.record(run, "final_output.empty", {
                progressChars: progress.output.length,
                activityCount: progress.recentActivity.length,
            });
            const traceHint = this.trace
                ? ` Inspect trace ${run.id} with /agent-trace ${run.id}.`
                : "";
            return this.finishFailure(
                run,
                `Child agent completed without a final response.${traceHint}`,
                progress,
            );
        }
        this.record(run, "final_output.selected", {
            outputChars: rawOutput.length,
            outputPreview: truncate(rawOutput.replace(/\s+/g, " "), 240),
        });
        return this.finishTerminal(run, "completed", output, false, progress);
    }

    private waitingContent(
        run: AgentRun,
        question: ParentQuestion,
        progress: ChildProgress,
    ): string {
        const sections = [
            `Agent ${run.id} is waiting for parent guidance.`,
            `Question: ${truncate(question.question, 4_000)}`,
        ];
        if (question.context) sections.push(`Context:\n${truncate(question.context, 12_000)}`);
        if (progress.output.trim()) {
            sections.push(`Partial child output:\n${truncate(progress.output.trim(), 12_000)}`);
        }
        if (question.options?.length) {
            sections.push(`Options:\n${question.options.map((option) => `- ${truncate(option, 1_000)}`).join("\n")}`);
        }
        if (question.recommendation) {
            sections.push(`Recommendation: ${truncate(question.recommendation, 4_000)}`);
        }
        sections.push(`Resume with agent(action="resume", runId="${run.id}", guidance="...").`);
        return sections.join("\n\n");
    }

    private finishFailure(
        run: AgentRun,
        error: string,
        progress: ChildProgress = run.handle?.getProgress() ?? { output: "", recentActivity: [] },
    ): AgentRunOutcome {
        return this.finishTerminal(run, "failed", error, true, progress);
    }

    private finishTerminal(
        run: AgentRun,
        status: "completed" | "failed" | "aborted" | "canceled",
        content: string,
        isError: boolean,
        progress: ChildProgress = run.handle?.getProgress() ?? { output: "", recentActivity: [] },
    ): AgentRunOutcome {
        run.status = status;
        run.updatedAt = Date.now();
        const outcome = this.outcome(run, content, isError, progress, status === "failed" ? content : undefined);
        this.disposeRun(run);
        this.trace?.finish(run.id, status, {
            isError,
            inputTokens: outcome.details.usage.input,
            outputTokens: outcome.details.usage.output,
            contentChars: content.length,
        });
        this.runs.delete(run.id);
        return outcome;
    }

    private outcome(
        run: AgentRun,
        content: string,
        isError: boolean,
        progress: ChildProgress,
        error?: string,
    ): AgentRunOutcome {
        const cumulative = run.handle?.getUsage() ?? cloneUsage(ZERO_USAGE);
        const usage = subtractUsage(cumulative, run.usageCheckpoint);
        const details = this.details(run, progress, error, cumulative);
        return { content, details, usage, isError };
    }

    private details(
        run: AgentRun,
        progress: ChildProgress,
        error?: string,
        usage: Usage = run.handle?.getUsage() ?? cloneUsage(ZERO_USAGE),
    ): AgentRunDetails {
        return {
            runId: run.id,
            agent: run.agent,
            agentSource: run.agentSource,
            agentFilePath: run.agentFilePath,
            status: run.status,
            task: truncate(run.task, 2_000),
            output: progress.output ? truncate(progress.output, MAX_OUTPUT_CHARS) : undefined,
            question: run.question,
            recentActivity: progress.recentActivity.slice(-8),
            usage: cloneUsage(usage),
            startedAt: run.startedAt,
            updatedAt: run.updatedAt,
            error,
        };
    }

    private abortRun(run: AgentRun): Promise<void> | undefined {
        if (!run.handle) {
            this.record(run, "child.abort_deferred_until_setup");
            return undefined;
        }
        if (!run.abortPromise) {
            this.record(run, "child.abort_called");
            run.abortPromise = run.handle.abort();
        }
        return run.abortPromise;
    }

    private disposeRun(run: AgentRun): void {
        if (run.disposed) return;
        run.disposed = true;
        this.record(run, "child.disposed");
        run.handle?.dispose();
    }

    private record(run: AgentRun, type: string, data?: AgentTraceData): void {
        this.trace?.record(run.id, type, data);
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
