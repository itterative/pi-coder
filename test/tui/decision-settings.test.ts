import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import {
    DecisionSettingsComponent,
    decisionModelDialog,
    type DecisionSettingsCallbacks,
    type DecisionSettingsState,
} from "../../src/tui/decision";
import { KEY, interact, mockTheme, renderText, snapshotText, stubTui } from "../helpers";
import { stubCommandContext, stubUiWithDialogs } from "../helpers/pi-stub";

const KNOWN_STATE: DecisionSettingsState = {
    enabled: true,
    apply: false,
    custom: false,
    provider: "anthropic",
    model: "classifier-1",
    apiKeySet: false,
};

const CUSTOM_STATE: DecisionSettingsState = {
    enabled: true,
    apply: true,
    custom: true,
    provider: "systemone",
    model: "vllm-d3-flash",
    baseUrl: "http://127.0.0.1:8000/v1",
    apiKeySet: true,
};

const OFF_STATE: DecisionSettingsState = {
    enabled: false,
    apply: false,
    custom: false,
    apiKeySet: false,
};

function stubCallbacks(
    overrides: Partial<DecisionSettingsCallbacks> = {},
): DecisionSettingsCallbacks {
    return {
        onChange: vi.fn(),
        chooseModel: vi.fn(async () => undefined),
        editField: vi.fn(async () => undefined),
        ...overrides,
    };
}

function createComponent(
    state: DecisionSettingsState,
    callbacks: DecisionSettingsCallbacks,
): DecisionSettingsComponent {
    const component = new DecisionSettingsComponent(structuredClone(state), callbacks);
    component.initialize(mockTheme);
    return component;
}

describe("DecisionSettingsComponent", () => {
    it("renders a classifier from a provider", async () => {
        const component = createComponent(KNOWN_STATE, stubCallbacks());

        await expect(snapshotText(renderText(component, 72))).toMatchFileSnapshot(
            "__snapshots__/decision-settings.known-model.txt",
        );
    });

    it("renders the custom endpoint fields", async () => {
        const component = createComponent(CUSTOM_STATE, stubCallbacks());

        await expect(snapshotText(renderText(component, 72))).toMatchFileSnapshot(
            "__snapshots__/decision-settings.custom-endpoint.txt",
        );
    });

    it("renders an unconfigured, disabled model", async () => {
        const component = createComponent(OFF_STATE, stubCallbacks());

        await expect(snapshotText(renderText(component, 72))).toMatchFileSnapshot(
            "__snapshots__/decision-settings.disabled.txt",
        );
    });

    it("warns when a project config overrides the saved values", async () => {
        const component = new DecisionSettingsComponent(
            structuredClone(KNOWN_STATE),
            stubCallbacks(),
            {
                note: "A project config overrides these values:\n/repo/.pi/decision-model-config.json",
            },
        );
        component.initialize(mockTheme);

        await expect(snapshotText(renderText(component, 72))).toMatchFileSnapshot(
            "__snapshots__/decision-settings.project-override.txt",
        );
    });

    it("toggles Enabled and Apply with Enter", async () => {
        const onChange = vi.fn();
        const component = createComponent(OFF_STATE, stubCallbacks({ onChange }));
        const ui = interact(component, 72);

        ui.press(KEY.enter);
        await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ enabled: true }));
        expect(ui.render()).toContain("[x] Enabled");

        ui.press(KEY.down, KEY.enter);
        await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ apply: true }));
        expect(ui.render()).toContain("[x] Apply verdicts");
    });

    it("stores a provider classifier picked from the model row", async () => {
        const onChange = vi.fn();
        const component = createComponent(
            KNOWN_STATE,
            stubCallbacks({
                onChange,
                chooseModel: async () => ({
                    kind: "classifier",
                    provider: "openai",
                    model: "gpt-x",
                }),
            }),
        );
        const ui = interact(component, 72);

        ui.press(KEY.down, KEY.down, KEY.enter);
        await vi.waitFor(() =>
            expect(onChange).toHaveBeenLastCalledWith({
                custom: false,
                provider: "openai",
                model: "gpt-x",
            }),
        );
        expect(ui.render()).toContain("Decision model: openai/gpt-x");
    });

    it("reveals the endpoint fields when the custom endpoint is chosen", async () => {
        const onChange = vi.fn();
        const component = createComponent(
            KNOWN_STATE,
            stubCallbacks({ onChange, chooseModel: async () => ({ kind: "custom" }) }),
        );
        const ui = interact(component, 72);

        ui.press(KEY.down, KEY.down, KEY.enter);
        await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ custom: true }));
        expect(ui.render()).toContain("Endpoint URL");
        expect(ui.render()).toContain("Model id");
    });

    it("saves an edited field and leaves a cancelled one alone", async () => {
        const onChange = vi.fn();
        const editField = vi.fn<DecisionSettingsCallbacks["editField"]>(
            async () => "http://example.test:9000/v1",
        );
        const component = createComponent(CUSTOM_STATE, stubCallbacks({ onChange, editField }));
        const ui = interact(component, 72);

        // Rows: Enabled, Apply, Decision model, Endpoint URL.
        ui.press(KEY.down, KEY.down, KEY.down, KEY.enter);
        await vi.waitFor(() =>
            expect(onChange).toHaveBeenLastCalledWith({ baseUrl: "http://example.test:9000/v1" }),
        );
        expect(ui.render()).toContain("Endpoint URL: http://example.test:9000/v1");

        editField.mockResolvedValue(undefined);
        onChange.mockClear();
        ui.press(KEY.enter);
        await Promise.resolve();
        expect(onChange).not.toHaveBeenCalled();
    });

    it("closes on Escape", () => {
        const done = vi.fn();
        const component = createComponent(KNOWN_STATE, stubCallbacks());
        component.setDoneCallback(done);
        const ui = interact(component, 72);

        ui.press(KEY.escape);
        expect(done).toHaveBeenCalledWith(undefined);
    });
});

describe("decisionModelDialog", () => {
    it("opens the classifier picker as a nested overlay", async () => {
        const tui = stubTui({
            addInputListener: () => () => {},
            getFocusedComponent: () => null,
            setFocus: () => {},
        });
        const { ui, dialogs } = stubUiWithDialogs(mockTheme, tui);
        const onChange = vi.fn();
        const dialog = decisionModelDialog(
            {
                state: structuredClone(KNOWN_STATE),
                choices: [
                    { provider: "openai", model: "classifier-x", name: "Classifier X" },
                    { provider: "anthropic", model: "classifier-1" },
                ],
                onChange,
            },
            stubCommandContext({ hasUI: true, mode: "tui", ui }),
        );

        await vi.waitFor(() => expect(dialogs).toHaveLength(1));
        const settings = dialogs[0]!;
        // Rows: Enabled, Apply, Decision model.
        settings.handleInput(KEY.down);
        settings.handleInput(KEY.down);
        settings.handleInput(KEY.enter);
        await vi.waitFor(() => expect(dialogs).toHaveLength(2));

        await expect(
            snapshotText(renderText(dialogs[1] as unknown as Component, 64)),
        ).toMatchFileSnapshot("__snapshots__/decision-settings.model-picker.txt");

        // The picker starts on the configured classifier, so Enter keeps it.
        dialogs[1]!.handleInput(KEY.enter);
        await vi.waitFor(() =>
            expect(onChange).toHaveBeenLastCalledWith({
                custom: false,
                provider: "anthropic",
                model: "classifier-1",
            }),
        );

        settings.handleInput(KEY.escape);
        await expect(dialog).resolves.toBeUndefined();
    });
});
