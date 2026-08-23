import type { Usage } from "@earendil-works/pi-ai";

import type { AgentDefinition } from "./discovery";
import type { AgentTraceData, AgentTraceStore } from "./trace";

export type AgentRunStatus =
    | "starting"
    | "running"
    | "waiting_for_permission"
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
    permissionPending?: boolean;
}

export interface WorkerMutationReport {
    changedFiles: string[];
    bashApproved: boolean;
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
    getMutationReport?(): WorkerMutationReport;
}

export interface ChildAgentFactoryContext {
    cwd: string;
    definition: AgentDefinition;
    parentContext: unknown;
    background?: boolean;
    runId?: string;
    onProgress: (progress: ChildProgress) => void;
    onTrace?: (type: string, data?: AgentTraceData) => void;
}

export type ChildAgentFactory = (
    context: ChildAgentFactoryContext,
) => Promise<ChildAgentHandle>;

type AgentStartContext = Omit<
    ChildAgentFactoryContext,
    "definition" | "background" | "onProgress" | "onTrace"
>;

export interface AgentRunDetails {
    runId: string;
    agent: string;
    agentSource?: string;
    agentFilePath?: string;
    status: AgentRunStatus;
    background?: boolean;
    task: string;
    output?: string;
    question?: ParentQuestion;
    recentActivity: string[];
    usage: Usage;
    startedAt: number;
    updatedAt: number;
    error?: string;
    discoveryDiagnostics?: string[];
    mutating?: boolean;
    mutationReport?: WorkerMutationReport;
}

export interface AgentRunOutcome {
    content: string;
    details: AgentRunDetails;
    usage: Usage;
    isError: boolean;
}

export type AgentProgressCallback = (details: AgentRunDetails) => void;
export type AgentBackgroundCallback = (details: AgentRunDetails) => void;

export interface AgentRunSummary {
    runId: string;
    agent: string;
    status: AgentRunStatus;
    background: boolean;
    task: string;
    activity?: string;
    responsePreview?: string;
    question?: string;
    mutating?: boolean;
}

interface AgentRun {
    id: string;
    agent: string;
    agentSource: string;
    agentFilePath?: string;
    task: string;
    status: AgentRunStatus;
    background: boolean;
    handle?: ChildAgentHandle;
    setup?: Promise<ChildAgentHandle>;
    question?: ParentQuestion;
    usageCheckpoint: Usage;
    usageSnapshot: Usage;
    startedAt: number;
    updatedAt: number;
    disposed: boolean;
    shutdownRequested: boolean;
    cancelRequested: boolean;
    mutating: boolean;
    permissionPending: boolean;
    operation?: Promise<AgentRunOutcome>;
    backgroundTask?: Promise<AgentRunOutcome>;
    backgroundCallback?: AgentBackgroundCallback;
    terminalOutcome?: AgentRunOutcome;
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

function isTerminalStatus(status: AgentRunStatus): boolean {
    return status === "completed"
        || status === "failed"
        || status === "aborted"
        || status === "canceled";
}

export class AgentRunManager {
    private readonly runs = new Map<string, AgentRun>();
    private readonly terminalOrder: string[] = [];
    private nextRunNumber = 1;
    private closing = false;
    private shutdownPromise?: Promise<void>;

    constructor(
        private readonly factory: ChildAgentFactory,
        private readonly maxActiveRuns = 4,
        private readonly trace?: AgentTraceStore,
        private readonly maxRetainedResults = 20,
    ) {}

    get activeCount(): number {
        return [...this.runs.values()].filter((run) => !isTerminalStatus(run.status)).length;
    }

    listRuns(): AgentRunSummary[] {
        return [...this.runs.values()].map((run) => {
            const progress = this.progressSnapshot(run);
            const activity = progress.recentActivity[progress.recentActivity.length - 1];
            const response = progress.output.replace(/\s+/g, " ").trim();
            return {
                runId: run.id,
                agent: run.agent,
                status: run.permissionPending ? "waiting_for_permission" : run.status,
                background: run.background,
                task: truncate(run.task.replace(/\s+/g, " ").trim(), 120),
                activity: activity ? truncate(activity, 120) : undefined,
                responsePreview: response ? truncate(response, 120) : undefined,
                question: run.question ? truncate(run.question.question, 500) : undefined,
                mutating: run.mutating,
            };
        });
    }

    listWaiting(): Array<{ runId: string; agent: string; question: string }> {
        return this.listRuns()
            .filter((run) => run.status === "waiting_for_parent" && run.question !== undefined)
            .map((run) => ({
                runId: run.runId,
                agent: run.agent,
                question: run.question!,
            }));
    }

    async start(
        definitionOrName: AgentDefinition | string,
        task: string,
        context: AgentStartContext,
        signal?: AbortSignal,
        onProgress?: AgentProgressCallback,
    ): Promise<AgentRunOutcome> {
        const { definition, run } = this.createRun(definitionOrName, task, false);
        const setupOutcome = await this.setupRun(
            run,
            definition,
            context,
            signal,
            onProgress,
        );
        if (setupOutcome) return setupOutcome;
        return this.beginOperation(run, task, signal, onProgress);
    }

    spawn(
        definitionOrName: AgentDefinition | string,
        task: string,
        context: AgentStartContext,
        signal?: AbortSignal,
        onBackgroundUpdate?: AgentBackgroundCallback,
    ): AgentRunOutcome {
        if (signal?.aborted) throw new AgentActionError("Agent spawn was aborted before launch.");
        const { definition, run } = this.createRun(definitionOrName, task, true);
        run.backgroundCallback = onBackgroundUpdate;
        const taskPromise = this.launchBackground(run, definition, context).catch((error) => {
            if (isTerminalStatus(run.status)) return run.terminalOutcome!;
            return this.finishFailure(
                run,
                `Background agent failed unexpectedly: ${errorMessage(error)}`,
            );
        });
        this.trackBackgroundTask(run, taskPromise);
        return this.checkpointOutcome(
            run,
            `Agent ${run.id} started in the background. Do not poll its status; you will receive an automatic notification when it finishes or needs parent guidance. After a terminal notification, retrieve the full result with agent(action="collect", runId="${run.id}").`,
            false,
            { output: "", recentActivity: [] },
        );
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

        if (signal?.aborted) throw new AgentActionError("Agent resume was aborted before launch.");
        this.record(run, "resume.requested", { guidanceChars: guidance.length });
        run.status = "running";
        run.question = undefined;
        run.updatedAt = Date.now();
        const prompt = `Parent guidance:\n${guidance}`;
        if (!run.background) {
            return this.beginOperation(run, prompt, signal, onProgress);
        }

        const taskPromise = Promise.resolve()
            .then(() => this.beginOperation(run, prompt))
            .catch((error) => {
                if (isTerminalStatus(run.status)) return run.terminalOutcome!;
                return this.finishFailure(
                    run,
                    `Background agent failed unexpectedly: ${errorMessage(error)}`,
                );
            });
        this.trackBackgroundTask(run, taskPromise);
        return this.checkpointOutcome(
            run,
            `Agent ${run.id} resumed in the background. Do not poll its status; you will receive an automatic notification when it finishes or needs parent guidance.`,
            false,
            run.handle?.getProgress() ?? { output: "", recentActivity: [] },
        );
    }

    async cancel(runId: string): Promise<AgentRunOutcome> {
        const run = this.requireRun(runId);
        if (isTerminalStatus(run.status)) {
            throw new AgentActionError(
                `Agent run ${runId} is already ${run.status}; collect its result instead.`,
            );
        }
        if (!run.background && run.status !== "waiting_for_parent") {
            throw new AgentActionError(
                `Agent run ${runId} is ${run.status}; only waiting foreground runs can be canceled.`,
            );
        }

        this.record(run, "cancel.requested", { status: run.status });
        run.cancelRequested = true;
        if (run.status === "starting" || run.status === "running") {
            void this.abortRun(run)?.catch(() => {});
            await run.backgroundTask?.catch(() => {});
        }
        let terminalOutcome = run.terminalOutcome;
        if (!isTerminalStatus(run.status)) {
            terminalOutcome = this.finishTerminal(
                run,
                "canceled",
                `Agent run ${runId} canceled.`,
                false,
            );
        }
        if (!run.background) return terminalOutcome!;

        const outcome = this.checkpointOutcome(
            run,
            terminalOutcome?.content ?? `Agent run ${runId} canceled.`,
            terminalOutcome?.isError ?? false,
            this.progressSnapshot(run),
            terminalOutcome?.details.error,
        );
        this.removeRun(run);
        return outcome;
    }

    status(runId: string): AgentRunOutcome {
        const run = this.requireRun(runId);
        const progress = this.progressSnapshot(run);
        let content: string;
        if (run.status === "waiting_for_parent" && run.question) {
            content = this.waitingContent(run, run.question, progress);
        } else if (isTerminalStatus(run.status)) {
            content = run.status === "completed"
                ? `Agent ${run.id} completed. Retrieve its result with agent(action="collect", runId="${run.id}").`
                : `Agent ${run.id} ${run.status}: ${truncate(run.terminalOutcome?.content ?? "", 2_000)}\n\nRetrieve the retained result with agent(action="collect", runId="${run.id}").`;
        } else {
            const sections = [`Agent ${run.id} is ${run.status} in the background.`];
            if (progress.output.trim()) {
                sections.push(`Partial output:\n${truncate(progress.output.trim(), 4_000)}`);
            }
            if (progress.recentActivity.length) {
                sections.push(`Recent activity:\n- ${progress.recentActivity.slice(-8).join("\n- ")}`);
            }
            sections.push("Do not poll again; an automatic notification will arrive when the run finishes or needs parent guidance.");
            content = sections.join("\n\n");
        }
        return this.checkpointOutcome(
            run,
            content,
            run.status === "failed" || run.status === "aborted",
            progress,
            run.terminalOutcome?.details.error,
        );
    }

    collect(runId: string): AgentRunOutcome {
        const run = this.requireRun(runId);
        if (!run.background) {
            throw new AgentActionError(`Agent run ${runId} is not a background run.`);
        }
        if (!isTerminalStatus(run.status) || !run.terminalOutcome) {
            throw new AgentActionError(
                `Agent run ${runId} is ${run.status}; wait for its automatic terminal notification before collecting.`,
            );
        }
        const progress = this.progressSnapshot(run);
        const outcome = this.checkpointOutcome(
            run,
            run.terminalOutcome.content,
            run.terminalOutcome.isError,
            progress,
            run.terminalOutcome.details.error,
        );
        this.record(run, "result.collected");
        this.removeRun(run);
        return outcome;
    }

    private createRun(
        definitionOrName: AgentDefinition | string,
        task: string,
        background: boolean,
    ): { definition: AgentDefinition; run: AgentRun } {
        if (this.closing) throw new AgentActionError("Agent runtime is shutting down.");
        if (!task.trim()) throw new AgentActionError("Agent task must not be empty.");
        if (task.length > MAX_TASK_CHARS) {
            throw new AgentActionError(`Agent task exceeds ${MAX_TASK_CHARS} characters.`);
        }
        if (this.activeCount >= this.maxActiveRuns) {
            throw new AgentActionError(
                `Agent run limit reached (${this.maxActiveRuns}). Resume, collect, or cancel an existing run first.`,
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
        if (
            definition.mutating
            && [...this.runs.values()].some((candidate) => (
                candidate.mutating && !isTerminalStatus(candidate.status)
            ))
        ) {
            throw new AgentActionError("A mutation-capable worker is already active.");
        }
        const now = Date.now();
        const id = `${definition.name}-${this.nextRunNumber++}`;
        const run: AgentRun = {
            id,
            agent: definition.name,
            agentSource: definition.source,
            agentFilePath: definition.filePath,
            task,
            status: "starting",
            background,
            usageCheckpoint: cloneUsage(ZERO_USAGE),
            usageSnapshot: cloneUsage(ZERO_USAGE),
            startedAt: now,
            updatedAt: now,
            disposed: false,
            shutdownRequested: false,
            cancelRequested: false,
            mutating: definition.mutating === true,
            permissionPending: false,
        };
        this.runs.set(id, run);
        this.trace?.start(id, definition.name, {
            source: definition.source,
            taskChars: task.length,
            model: definition.model ?? "parent",
            background,
        });
        return { definition, run };
    }

    private async setupRun(
        run: AgentRun,
        definition: AgentDefinition,
        context: AgentStartContext,
        signal?: AbortSignal,
        onProgress?: AgentProgressCallback,
    ): Promise<AgentRunOutcome | undefined> {
        try {
            this.record(run, "setup.started");
            const setup = this.factory({
                ...context,
                definition,
                background: run.background,
                runId: run.id,
                onProgress: (progress) => {
                    run.updatedAt = Date.now();
                    run.permissionPending = progress.permissionPending === true;
                    this.record(run, "child.progress", {
                        outputChars: progress.output.length,
                        activity: progress.recentActivity[progress.recentActivity.length - 1] ?? "",
                    });
                    const details = this.details(run, progress);
                    onProgress?.(details);
                    if (run.background) this.emitBackgroundUpdate(run, details);
                },
                onTrace: (type, data) => this.record(run, `child.${type}`, data),
            });
            run.setup = setup;
            run.handle = await setup;
            run.setup = undefined;
            this.record(run, "setup.completed");
        } catch (error) {
            run.setup = undefined;
            const message = errorMessage(error);
            this.record(run, "setup.failed", { error: truncate(message, 500) });
            return this.finishFailure(run, `Failed to create child session: ${message}`);
        }

        if (run.cancelRequested) {
            this.record(run, "setup.canceled_after_completion");
            return this.finishTerminal(run, "canceled", `Agent run ${run.id} canceled.`, false);
        }
        if (this.closing || run.shutdownRequested || signal?.aborted) {
            this.record(run, "setup.aborted_after_completion");
            if (signal?.aborted) await this.abortRun(run)?.catch(() => {});
            return this.finishTerminal(run, "aborted", "Agent run was aborted.", true);
        }
        return undefined;
    }

    private async launchBackground(
        run: AgentRun,
        definition: AgentDefinition,
        context: AgentStartContext,
    ): Promise<AgentRunOutcome> {
        const setupOutcome = await this.setupRun(run, definition, context);
        if (setupOutcome) return setupOutcome;
        return this.beginOperation(run, run.task);
    }

    private requireRun(runId: string): AgentRun {
        const run = this.runs.get(runId);
        if (!run) throw new AgentActionError(`Unknown or stale agent run ID: ${runId}`);
        return run;
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
            if (!isTerminalStatus(run.status)) {
                run.status = "aborted";
                run.updatedAt = Date.now();
                this.disposeRun(run);
                this.trace?.finish(run.id, "aborted", {
                    isError: true,
                    reason: "session_shutdown",
                });
            }
            this.removeRun(run);
        }
    }

    private async beginOperation(
        run: AgentRun,
        prompt: string,
        signal?: AbortSignal,
        onProgress?: AgentProgressCallback,
    ): Promise<AgentRunOutcome> {
        if (run.cancelRequested) {
            return this.finishTerminal(run, "canceled", `Agent run ${run.id} canceled.`, false);
        }
        if (this.closing || run.shutdownRequested || signal?.aborted) {
            if (signal?.aborted) await this.abortRun(run)?.catch(() => {});
            return this.finishTerminal(run, "aborted", "Agent run was aborted.", true);
        }
        run.status = "running";
        run.updatedAt = Date.now();
        if (run.background) {
            this.emitBackgroundUpdate(
                run,
                this.details(run, run.handle?.getProgress() ?? { output: "", recentActivity: [] }),
            );
        }
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
            if (run.cancelRequested) {
                this.record(run, "operation.canceled_before_prompt");
            } else if (aborted) {
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
            if (!aborted && !run.shutdownRequested && !run.cancelRequested) {
                return this.finishFailure(run, message);
            }
        } finally {
            signal?.removeEventListener("abort", abort);
        }

        if (run.cancelRequested) {
            return this.finishTerminal(run, "canceled", `Agent run ${run.id} canceled.`, false);
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
            if (!run.background) {
                run.usageCheckpoint = cloneUsage(run.handle!.getUsage());
            }
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
        if (isTerminalStatus(run.status) && run.terminalOutcome) return run.terminalOutcome;
        run.status = status;
        run.permissionPending = false;
        run.updatedAt = Date.now();
        const report = run.handle?.getMutationReport?.();
        if (run.mutating) {
            const files = report?.changedFiles.length
                ? report.changedFiles.map((file) => `  - ${file}`).join("\n")
                : "  - none tracked";
            const bashCaveat = report?.bashApproved
                ? "\n- One or more approved bash commands may have changed additional files; inspect the checkout before attributing the final diff."
                : "";
            content += `\n\nMutation report:\n- Files changed by successful edit/write calls:\n${files}${bashCaveat}`;
        }
        const outcome = this.outcome(run, content, isError, progress, status === "failed" ? content : undefined);
        this.disposeRun(run);
        this.trace?.finish(run.id, status, {
            isError,
            inputTokens: outcome.details.usage.input,
            outputTokens: outcome.details.usage.output,
            contentChars: content.length,
            background: run.background,
        });
        if (run.background) {
            run.terminalOutcome = outcome;
            this.terminalOrder.push(run.id);
            this.pruneRetainedResults();
        } else {
            this.runs.delete(run.id);
        }
        return outcome;
    }

    private outcome(
        run: AgentRun,
        content: string,
        isError: boolean,
        progress: ChildProgress,
        error?: string,
    ): AgentRunOutcome {
        const cumulative = this.readUsage(run);
        const usage = subtractUsage(cumulative, run.usageCheckpoint);
        const details = this.details(run, progress, error, cumulative);
        return { content, details, usage, isError };
    }

    private checkpointOutcome(
        run: AgentRun,
        content: string,
        isError: boolean,
        progress: ChildProgress,
        error?: string,
    ): AgentRunOutcome {
        const outcome = this.outcome(run, content, isError, progress, error);
        run.usageCheckpoint = cloneUsage(outcome.details.usage);
        return outcome;
    }

    private details(
        run: AgentRun,
        progress: ChildProgress,
        error?: string,
        usage?: Usage,
    ): AgentRunDetails {
        const cumulative = usage ?? this.readUsage(run);
        return {
            runId: run.id,
            agent: run.agent,
            agentSource: run.agentSource,
            agentFilePath: run.agentFilePath,
            status: run.permissionPending ? "waiting_for_permission" : run.status,
            background: run.background,
            task: truncate(run.task, 2_000),
            output: progress.output ? truncate(progress.output, MAX_OUTPUT_CHARS) : undefined,
            question: run.question,
            recentActivity: progress.recentActivity.slice(-8),
            usage: cloneUsage(cumulative),
            startedAt: run.startedAt,
            updatedAt: run.updatedAt,
            error,
            mutating: run.mutating,
            mutationReport: run.handle?.getMutationReport?.(),
        };
    }

    private emitBackgroundUpdate(run: AgentRun, details: AgentRunDetails): void {
        if (this.closing || run.cancelRequested) return;
        try {
            run.backgroundCallback?.(details);
        } catch {
            // UI callbacks must not disrupt child lifecycle settlement.
        }
    }

    private readUsage(run: AgentRun): Usage {
        if (run.handle) run.usageSnapshot = cloneUsage(run.handle.getUsage());
        return cloneUsage(run.usageSnapshot);
    }

    private trackBackgroundTask(run: AgentRun, task: Promise<AgentRunOutcome>): void {
        run.backgroundTask = task;
        void task.then(
            (outcome) => {
                if (outcome.details.status === "waiting_for_parent" || isTerminalStatus(outcome.details.status)) {
                    this.emitBackgroundUpdate(run, outcome.details);
                }
                if (isTerminalStatus(outcome.details.status)) run.backgroundCallback = undefined;
                if (run.backgroundTask === task) run.backgroundTask = undefined;
            },
            () => {
                run.backgroundCallback = undefined;
                if (run.backgroundTask === task) run.backgroundTask = undefined;
            },
        );
    }

    private progressSnapshot(run: AgentRun): ChildProgress {
        if (run.handle) return run.handle.getProgress();
        return {
            output: run.terminalOutcome?.details.output ?? "",
            recentActivity: run.terminalOutcome?.details.recentActivity ?? [],
        };
    }

    private pruneRetainedResults(): void {
        while (this.terminalOrder.length > this.maxRetainedResults) {
            const runId = this.terminalOrder.shift();
            if (runId) this.runs.delete(runId);
        }
    }

    private removeRun(run: AgentRun): void {
        run.backgroundCallback = undefined;
        this.runs.delete(run.id);
        const terminalIndex = this.terminalOrder.indexOf(run.id);
        if (terminalIndex >= 0) this.terminalOrder.splice(terminalIndex, 1);
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
        const handle = run.handle;
        run.handle = undefined;
        run.setup = undefined;
        run.abortPromise = undefined;
        handle?.dispose();
    }

    private record(run: AgentRun, type: string, data?: AgentTraceData): void {
        this.trace?.record(run.id, type, data);
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
