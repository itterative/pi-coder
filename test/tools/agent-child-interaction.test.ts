import { describe, expect, it } from "vitest";
import type { AskUserComponent } from "../../src/tui/ask-user";
import { askChildUser, type ChildUserQuestion } from "../../src/tools/agent/child";
import { stubContext, stubUi } from "../helpers/pi-stub";
import { KEY, mockTheme, renderText } from "../helpers";

const question: ChildUserQuestion = {
    title: "Which implementation?",
    description: "Both satisfy the interface.",
    options: [
        { label: "Implementation A", description: "Recommended because it is simpler" },
        { label: "You decide", description: "Use your judgment" },
    ],
};

function interactiveContext(actions: Array<"select" | "cancel">) {
    const rendered: string[] = [];
    const ui = stubUi({
        setWorkingVisible() {},
        custom(factory) {
            return new Promise<unknown>((resolve, reject) => {
                void Promise.resolve(factory(undefined, mockTheme, undefined, resolve)).then(
                    (component) => {
                        // The stub's factory returns `unknown`; this suite drives the real dialog.
                        const dialog = component as AskUserComponent;
                        rendered.push(renderText(dialog, 80));
                        dialog.handleInput(actions.shift() === "cancel" ? KEY.escape : KEY.enter);
                    },
                    reject,
                );
            });
        },
    });

    return { context: stubContext({ hasUI: true, mode: "tui", ui }), rendered };
}

describe("child-to-user interaction", () => {
    it("returns direct answers and supports repeated questions", async () => {
        const { context, rendered } = interactiveContext(["select", "select"]);

        const first = await askChildUser(question, context, "scout");
        const second = await askChildUser(
            {
                ...question,
                title: "Apply the recommendation?",
            },
            context,
            "scout",
        );

        expect(first).toMatchObject({
            content: [{ text: "User selected: Implementation A" }],
            details: { answer: "Implementation A", optionIndex: 0 },
        });
        expect(second.details).toMatchObject({ answer: "Implementation A" });
        expect(rendered).toHaveLength(2);
        expect(rendered[0]).toContain("scout asks: Which implementation?");
    });

    it("returns a recoverable result when the user cancels", async () => {
        const { context } = interactiveContext(["cancel"]);

        const result = await askChildUser(question, context, "scout");

        expect(result.details).toEqual({ canceled: true });
        await expect(result.content[0]?.text).toMatchFileSnapshot(
            "__snapshots__/agent-child-interaction.user-canceled.txt",
        );
    });

    it("does not open a dialog outside interactive TUI mode", async () => {
        let customCalls = 0;
        const context = stubContext({
            hasUI: false,
            mode: "print",
            ui: stubUi({
                custom: () => {
                    customCalls++;
                    // Never settled: the gate must not open a dialog in this mode.
                    return new Promise<never>(() => {});
                },
            }),
        });

        const result = await askChildUser(question, context, "scout");

        expect(result.details).toEqual({ unavailable: true });
        expect(result.content[0]?.text).toContain("Use ask_parent");
        expect(customCalls).toBe(0);
    });

    it("propagates cancellation after closing the dialog", async () => {
        const controller = new AbortController();
        const context = stubContext({
            hasUI: true,
            mode: "tui",
            ui: stubUi({
                setWorkingVisible() {},
                custom(factory) {
                    return new Promise<unknown>((resolve, reject) => {
                        void Promise.resolve(
                            factory(undefined, mockTheme, undefined, resolve),
                        ).then(() => controller.abort(), reject);
                    });
                },
            }),
        });

        await expect(
            askChildUser(question, context, "scout", controller.signal),
        ).rejects.toMatchObject({ name: "AbortError" });
    });
});
