import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
    BUILTIN_REVIEWER,
    BUILTIN_SCOUT,
    BUILTIN_WORKER,
} from "../../src/tools/agent/definitions/discovery";
import type { AgentDefinition } from "../../src/tools/agent/definitions/types";
import { buildChildRun, probeDefinition, type ChildRunMode } from "./child-run-fixture";

/**
 * The decision each installed gate returns for a fixed set of calls, per run profile.
 *
 * This is the truth table the capability restructure had to preserve: who may read, write, and run
 * what, and with which reason. The parent has no UI on purpose, so every prompt path denies
 * deterministically. Each row lists one entry per installed `tool_call` handler, in registration
 * order, which also pins the sequencing between the file-access, command, and confinement gates. The
 * rendered reasons are model-facing text, hence the file snapshot. Rows for a tool the child was never
 * granted (write and edit for a read-only child) are inert by construction: the SDK allowlist keeps the
 * call from existing, so no gate sees it.
 *
 * Temp directories, the repository path, the user's home, and the whole bubblewrap argument list are
 * normalized out of the snapshot; a sandboxed command reads as `sandbox(<inner command>)`.
 *
 * The two `sandbox(...)` rows need `bwrap` on this machine: the default heuristic permission runs
 * classified-safe commands inside the sandbox, and without the executable the command gate fails closed
 * with "bubblewrap is unavailable" instead. That difference is the intended behavior, not flakiness.
 */

const OUTSIDE_READ = "/etc/passwd";
const OUTSIDE_WRITE = "/etc/hosts";

interface HandlerResult {
    block?: boolean;
    reason?: string;
}

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Case {
    readonly label: string;
    readonly definition: AgentDefinition;
    readonly mode: ChildRunMode;
}

const CASES: Case[] = [
    {
        label: "custom definition, no bash capability",
        definition: probeDefinition("plain", []),
        mode: {},
    },
    {
        label: "scout (read-only plus heuristic bash)",
        definition: BUILTIN_SCOUT,
        mode: {},
    },
    {
        label: "reviewer (command runner, no edit)",
        definition: BUILTIN_REVIEWER,
        mode: {},
    },
    {
        label: "worker in the parent checkout",
        definition: BUILTIN_WORKER,
        mode: {},
    },
    {
        label: "worker in an isolated worktree",
        definition: BUILTIN_WORKER,
        mode: { isolated: true, workspaceId: "workspace-1" },
    },
    {
        label: "worker with no parent session to borrow approvals from",
        definition: BUILTIN_WORKER,
        mode: { parentHasNoSession: true },
    },
];

function call(toolName: string, input: Record<string, unknown>) {
    return { type: "tool_call", toolName, toolCallId: `call-${toolName}`, input };
}

function describeOutcome(result: unknown): string {
    if (result === undefined || result === null) {
        return "allow";
    }
    const resolved = result as HandlerResult;
    if (resolved.block) {
        return `block ${JSON.stringify(resolved.reason)}`;
    }
    return "allow";
}

const SANDBOX_WRAPPER = /\/usr\/bin\/bwrap .*-- \/usr\/bin\/bash -c '(.*?)'\s*$/s;

/**
 * Removes everything a snapshot must not carry: the per-run temp directory, the real repository and
 * home paths, and the entire bubblewrap argument list, which is a machine-level detail rather than a
 * permission decision. A sandboxed command is recorded as `sandbox(<inner command>)`.
 */
function normalize(text: string, cwd: string): string {
    return text
        .replace(SANDBOX_WRAPPER, "sandbox($1)")
        .split(cwd)
        .join("<cwd>")
        .split(fs.realpathSync(cwd))
        .join("<cwd>")
        .split(os.homedir())
        .join("<home>")
        .split(process.cwd())
        .join("<repo>");
}

async function rowsFor(testCase: Case): Promise<string[]> {
    const fixture = buildChildRun(testCase.definition, {
        parentKind: "no-ui",
        ...testCase.mode,
    });
    const installed = fixture.install();
    const inside = path.join(fixture.cwd, "notes.md");
    fs.writeFileSync(inside, "# notes\n");
    const ctx = {
        cwd: fixture.cwd,
        sessionManager: undefined,
        signal: new AbortController().signal,
    };

    const events = [
        call("read", { path: inside }),
        call("read", { path: OUTSIDE_READ }),
        call("grep", { pattern: "notes", path: fixture.cwd }),
        // The only call carrying an end-user note: an approval comment is prepended to the tool result
        // so the child learns why it was allowed, and only gates that saw the call can do that.
        {
            ...call("write", { path: inside, content: "rewritten\n" }),
            input: { path: inside, content: "rewritten\n", _userMessage: "keep it scoped" },
        },
        call("write", { path: OUTSIDE_WRITE, content: "nope\n" }),
        call("edit", { path: inside, edits: [{ oldText: "# notes", newText: "# Notes" }] }),
        call("edit", { path: OUTSIDE_WRITE, edits: [{ oldText: "127", newText: "128" }] }),
        call("bash", { command: `cat ${inside}` }),
        call("bash", { command: "git status" }),
        call("bash", { command: "rm -rf /tmp/definitely-outside" }),
        call("bash", { command: "npm run test:run" }),
    ];

    const rows: string[] = [];
    for (const event of events) {
        const outcomes: string[] = [];
        for (const handler of installed.toolCall as Handler[]) {
            outcomes.push(describeOutcome(normalizeSync(await handler(event, ctx), fixture.cwd)));
        }

        // A gated call holds its mutation lock until the result arrives, so the driver sends one to
        // keep the queue moving exactly as a real turn would - but only for a call that was allowed,
        // otherwise the tracked change set would record edits that never happened.
        const allowed = outcomes.every((outcome) => !outcome.startsWith("block"));
        if (allowed) {
            for (const handler of installed.toolResult as Handler[]) {
                const result = (await handler(
                    {
                        toolName: event.toolName,
                        toolCallId: event.toolCallId,
                        input: event.input,
                        content: [{ type: "text", text: "ok" }],
                        isError: false,
                    },
                    ctx,
                )) as { content?: Array<{ text?: string }> } | undefined;
                // An end-user note attached to an approval is prepended to the tool result, which is
                // how the child learns why a command was allowed; recorded so the rewrite is pinned.
                const note = result?.content?.[0]?.text ?? "";
                if (note.includes("<user_note>")) {
                    outcomes.push("result:note-prepended");
                }
            }
        }

        const input = event.input as { command?: string; path?: string };
        const subject = input.command ?? input.path ?? fixture.cwd;
        rows.push(
            `${event.toolName} ${JSON.stringify(normalize(subject, fixture.cwd))} -> [` +
                `${outcomes.join(", ")}]`,
        );
    }

    rows.push(
        normalize(
            `tracked: readFiles=${JSON.stringify([...fixture.tracker.readFiles].sort())} ` +
                `changedFiles=${JSON.stringify([...fixture.tracker.changedFiles].sort())} ` +
                `bashApproved=${String(fixture.tracker.bashApproved)} ` +
                `permissionPending=${String(fixture.tracker.progress.permissionPending)}`,
            fixture.cwd,
        ),
    );
    return rows;
}

/** Applies the same path normalization to a handler's block reason. */
function normalizeSync(result: unknown, cwd: string): unknown {
    if (!result || typeof result !== "object") {
        return result;
    }
    const resolved = result as HandlerResult;
    if (typeof resolved.reason !== "string") {
        return result;
    }
    return { ...resolved, reason: normalize(resolved.reason, cwd) };
}

describe("child gate decisions", () => {
    it("blocks and allows the same calls for every run profile", async () => {
        const blocks: string[] = [];
        for (const testCase of CASES) {
            blocks.push(`### ${testCase.label}`, ...(await rowsFor(testCase)));
        }

        await expect(blocks.join("\n")).toMatchFileSnapshot(
            "__snapshots__/agent-child-decisions.txt",
        );
    }, 60_000);
});
