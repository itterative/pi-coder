import {
    createEventBus,
    type ExtensionContext,
    type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReminderStateLabels } from "../../../src/modules/decision";
import { DECISION_STATE_EVENT } from "../../../src/modules/decision/events";
import registerRemindersExtension from "../../../src/modules/reminders";
import { createPiStub, stubContext, stubSessionManager, type PiStub } from "../../helpers/pi-stub";
import {
    assistantEntry,
    cleanupBranches,
    sessionManager,
    toolCall,
    userEntry,
} from "../../helpers/session-branch";

/**
 * The session state the reminder module publishes for the footer's badge.
 *
 * The labels are derived from the branch alone, so the badge tracks a turn the rotation skipped just as well
 * as one the model judged. A child session stays silent - its bus is the parent's, and a child's labels must
 * not overwrite the parent's badge - as does the whole module while `PI_CODER_REMINDER=false`, because the
 * readout belongs to it.
 */

interface Harness {
    stub: PiStub;
    ctx: ExtensionContext;
    /** Every state published since the harness was built, in order. */
    published: ReminderStateLabels[];
}

/** An assistant turn that edits a file: the activity the `implementing` phase is inferred from. */
function appendEdit(manager: SessionManager): void {
    manager.appendMessage(assistantEntry([toolCall("edit", { path: "/repo/src/a.ts" })], 2));
}

function harness(options: { manager: SessionManager; scope?: "full" | "memory" }): Harness {
    const events = createEventBus();
    const published: ReminderStateLabels[] = [];
    events.on(DECISION_STATE_EVENT, (data) => {
        published.push((data as { labels: ReminderStateLabels }).labels);
    });

    const stub = createPiStub({ eventBus: events });
    registerRemindersExtension(
        stub.pi,
        options.scope === undefined ? {} : { scope: options.scope },
    );

    const ctx = stubContext({
        cwd: "/repo",
        sessionManager: stubSessionManager({
            getBranch: () => options.manager.getBranch(),
            getSessionFile: () => "/tmp/pi/sessions/state.jsonl",
        }),
    });

    return { stub, ctx, published };
}

async function restart(stub: PiStub, ctx: ExtensionContext): Promise<void> {
    await stub.requireHandler("session_start")({ reason: "startup" }, ctx);
}

async function userTurn(stub: PiStub, ctx: ExtensionContext): Promise<void> {
    await stub.requireHandler("before_agent_start")(
        { systemPrompt: "", prompt: "do the thing" },
        ctx,
    );
}

afterEach(() => {
    vi.unstubAllEnvs();
    cleanupBranches();
});

describe("published session state", () => {
    it("publishes the branch's inferred phase at a restart", async () => {
        const manager = sessionManager("/repo");
        manager.appendMessage(userEntry("change the file", 1));
        appendEdit(manager);

        const { stub, ctx, published } = harness({ manager });
        await restart(stub, ctx);

        // The labels are the model's persisted ones with the deterministic inference filling the gaps, so a
        // reload shows the phase at once instead of waiting for the next turn to judge it.
        expect(published).toEqual([{ phase: "implementing", unvalidated: true }]);
    });

    it("publishes the discussing state for a branch with no activity", async () => {
        const { stub, ctx, published } = harness({ manager: sessionManager("/repo") });

        await restart(stub, ctx);
        await userTurn(stub, ctx);

        // The scan answers every turn, so an empty branch reads `discussing`; the badge shows it and a repeat
        // publish keeps it current rather than letting a stale phase outlive its branch.
        expect(published).toEqual([{ phase: "discussing" }, { phase: "discussing" }]);
    });

    it("tracks a turn the rotation skipped, and picks up new work", async () => {
        const manager = sessionManager("/repo");
        const { stub, ctx, published } = harness({ manager });

        await restart(stub, ctx);
        // The first turn carries the session reminder, so the rotation never runs: the state publishes anyway.
        await userTurn(stub, ctx);
        expect(published.at(-1)).toEqual({ phase: "discussing" });
        appendEdit(manager);
        await userTurn(stub, ctx);
        expect(published.at(-1)).toEqual({ phase: "implementing", unvalidated: true });
    });

    it("stays silent for a child session", async () => {
        const manager = sessionManager("/repo");
        appendEdit(manager);

        const { stub, ctx, published } = harness({ manager, scope: "memory" });
        await restart(stub, ctx);
        await userTurn(stub, ctx);

        expect(published).toEqual([]);
    });

    it("stays silent while the reminder module is off", async () => {
        vi.stubEnv("PI_CODER_REMINDER", "false");
        const manager = sessionManager("/repo");
        appendEdit(manager);

        const { stub, ctx, published } = harness({ manager });
        await restart(stub, ctx);
        await userTurn(stub, ctx);

        expect(published).toEqual([]);
    });

    it("leaves pi without an event bus alone", async () => {
        const manager = sessionManager("/repo");
        appendEdit(manager);
        const stub = createPiStub({ eventBus: null });
        registerRemindersExtension(stub.pi);
        const ctx = stubContext({
            cwd: "/repo",
            sessionManager: stubSessionManager({ getBranch: () => manager.getBranch() }),
        });

        // No bus to publish on is a valid extension host, not an error path.
        await expect(restart(stub, ctx)).resolves.toBeUndefined();
        await expect(userTurn(stub, ctx)).resolves.toBeUndefined();
    });
});
