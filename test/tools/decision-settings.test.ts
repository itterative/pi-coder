import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import decisionConfig from "../../src/modules/decision/config";
import {
    decisionModelSetting,
    openDecisionModelSettings,
    registerDecisionModelShortcut,
} from "../../src/tools/decision-settings";
import { asSettingsListItems } from "../../src/tui/agents/formatting";
import { KEY, mockTheme, renderText, stubTui } from "../helpers";
import {
    createPiStub,
    stubClassifierRegistry,
    stubCommandContext,
    stubContext,
    stubUi,
    stubUiWithDialogs,
} from "../helpers/pi-stub";

let root: string;
let workspace: string;
let globalPath: string;

function writeGlobalConfig(data: unknown): void {
    fs.writeFileSync(globalPath, JSON.stringify(data));
}

function readGlobalConfig(): { decisionModel?: Record<string, unknown> } {
    return JSON.parse(fs.readFileSync(globalPath, "utf-8"));
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-decision-settings-"));
    workspace = path.join(root, "project");
    fs.mkdirSync(workspace, { recursive: true });
    globalPath = path.join(root, "global.json");
    vi.stubEnv("DECISION_MODEL_CONFIG_PATH_GLOBAL", globalPath);
    // Blank means no project walk-up, so the suite never reads this checkout's own file.
    vi.stubEnv("DECISION_MODEL_CONFIG_PATH", "");
    vi.stubEnv("SYSTEMONE_API_URL", "");
    vi.stubEnv("SYSTEMONE_API_TOKEN", "");
    vi.stubEnv("SYSTEMONE_MODEL", "");
    decisionConfig.reset();
});

afterEach(() => {
    decisionConfig.reset();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
});

describe("decisionModelSetting", () => {
    it("summarizes a provider classifier", () => {
        writeGlobalConfig({
            decisionModel: { enabled: true, provider: "anthropic", model: "classifier-1" },
        });

        const setting = decisionModelSetting(workspace);
        expect(setting).toMatchObject({
            id: "decisionModel",
            label: "Decision model",
            status: "On · anthropic/classifier-1",
        });
        expect(asSettingsListItems([setting])[0]?.label).toBe(
            "Decision model · On · anthropic/classifier-1",
        );
    });

    it("summarizes the custom endpoint and the unconfigured state", () => {
        writeGlobalConfig({
            decisionModel: {
                provider: "systemone",
                baseUrl: "http://127.0.0.1:8000/v1",
                model: "vllm-d3-flash",
            },
        });
        expect(decisionModelSetting(workspace).status).toBe("Off · custom · vllm-d3-flash");

        writeGlobalConfig({});
        expect(decisionModelSetting(workspace).status).toBe("Off · not configured");
    });
});

describe("openDecisionModelSettings", () => {
    function stubTuiForDialogs() {
        return stubTui({
            addInputListener: () => () => {},
            getFocusedComponent: () => null,
            setFocus: () => {},
        });
    }

    it("saves a toggle to the global file and drops the endpoint registration", async () => {
        writeGlobalConfig({
            decisionModel: {
                enabled: true,
                provider: "systemone",
                baseUrl: "http://127.0.0.1:8000/v1",
                model: "vllm-d3-flash",
            },
        });
        const stub = createPiStub();
        const { ui, dialogs } = stubUiWithDialogs(mockTheme, stubTuiForDialogs());
        const opening = openDecisionModelSettings(
            stub.pi,
            stubCommandContext({
                hasUI: true,
                mode: "tui",
                cwd: workspace,
                modelRegistry: stubClassifierRegistry(),
                ui,
            }),
        );

        await vi.waitFor(() => expect(dialogs).toHaveLength(1));
        dialogs[0]!.handleInput(KEY.enter); // Enabled: on -> off
        dialogs[0]!.handleInput(KEY.escape);
        await opening;

        expect(readGlobalConfig().decisionModel).toMatchObject({ enabled: false });
        expect(stub.unregisteredProviders).toEqual(["systemone"]);
        expect(stub.providers).toEqual([]);
    });

    it("lists provider classifiers and switches to the custom endpoint", async () => {
        writeGlobalConfig({
            decisionModel: { enabled: true, provider: "anthropic", model: "classifier-1" },
        });
        const stub = createPiStub();
        const { ui, dialogs } = stubUiWithDialogs(mockTheme, stubTuiForDialogs());
        const opening = openDecisionModelSettings(
            stub.pi,
            stubCommandContext({
                hasUI: true,
                mode: "tui",
                cwd: workspace,
                modelRegistry: stubClassifierRegistry([
                    { provider: "anthropic", id: "classifier-1", name: "Classifier One" },
                ]),
                ui,
            }),
        );

        await vi.waitFor(() => expect(dialogs).toHaveLength(1));
        dialogs[0]!.handleInput(KEY.down);
        dialogs[0]!.handleInput(KEY.down);
        dialogs[0]!.handleInput(KEY.enter);
        await vi.waitFor(() => expect(dialogs).toHaveLength(2));
        expect(renderText(dialogs[1] as unknown as Component, 60)).toContain(
            "anthropic/classifier-1",
        );

        // The picker starts on the configured classifier; one step up is the custom endpoint.
        dialogs[1]!.handleInput(KEY.up);
        dialogs[1]!.handleInput(KEY.enter);
        await vi.waitFor(() =>
            expect(readGlobalConfig().decisionModel?.provider).toBe("systemone"),
        );

        dialogs[0]!.handleInput(KEY.escape);
        await opening;
        expect(stub.unregisteredProviders).toEqual(["systemone"]);
    });
});

describe("registerDecisionModelShortcut", () => {
    function runToggle(cwd = workspace) {
        const stub = createPiStub();
        registerDecisionModelShortcut(stub.pi);
        const shortcut = stub.shortcuts[0];
        if (!shortcut) {
            throw new Error("the auto-mode shortcut was not registered");
        }

        const notifications: Array<{ message: string; type?: string }> = [];
        const ui = stubUi({
            notify: (message, type) => {
                notifications.push({ message, type });
            },
        });
        shortcut.options.handler(stubContext({ cwd, ui }));

        return { stub, shortcut, notifications };
    }

    it("registers alt+a and turns auto mode on with the endpoint", () => {
        writeGlobalConfig({
            decisionModel: {
                enabled: false,
                provider: "systemone",
                baseUrl: "http://127.0.0.1:8000/v1",
                model: "vllm-d3-flash",
            },
        });

        const { stub, shortcut, notifications } = runToggle();

        expect(shortcut.key).toBe("alt+a");
        expect(shortcut.options.description).toBe("Toggle the bash tool's auto mode");
        expect(readGlobalConfig().decisionModel).toMatchObject({ enabled: true });
        expect(stub.providers.map((provider) => provider.id)).toEqual(["systemone"]);
        expect(notifications).toEqual([
            { message: "pi-coder: Bash tool auto mode on", type: "info" },
        ]);
    });

    it("turns auto mode off and drops the endpoint registration", () => {
        writeGlobalConfig({
            decisionModel: {
                enabled: true,
                provider: "systemone",
                baseUrl: "http://127.0.0.1:8000/v1",
                model: "vllm-d3-flash",
            },
        });

        const { stub, notifications } = runToggle();

        expect(readGlobalConfig().decisionModel).toMatchObject({ enabled: false });
        expect(stub.unregisteredProviders).toEqual(["systemone"]);
        expect(stub.providers).toEqual([]);
        expect(notifications).toEqual([
            { message: "pi-coder: Bash tool auto mode off", type: "info" },
        ]);
    });

    it("warns when a project config outranks the saved value", () => {
        writeGlobalConfig({ decisionModel: { enabled: true } });
        const projectPath = path.join(root, "project-override.json");
        fs.writeFileSync(projectPath, JSON.stringify({ decisionModel: { enabled: true } }));
        vi.stubEnv("DECISION_MODEL_CONFIG_PATH", projectPath);
        decisionConfig.reset();

        const { notifications } = runToggle();

        expect(readGlobalConfig().decisionModel).toMatchObject({ enabled: false });
        expect(notifications).toEqual([
            {
                message: `Decision model auto mode is overridden by ${projectPath}`,
                type: "warning",
            },
        ]);
    });

    it("warns when enabling finds no classifier endpoint", () => {
        writeGlobalConfig({ decisionModel: { enabled: false } });

        const { stub, notifications } = runToggle();

        expect(readGlobalConfig().decisionModel).toMatchObject({ enabled: true });
        expect(stub.providers).toEqual([]);
        expect(notifications).toEqual([
            {
                message:
                    "Decision model auto mode on, but no classifier endpoint is configured (/agents → Settings)",
                type: "warning",
            },
        ]);
    });

    it("warns instead of throwing when the global config path is disabled", () => {
        vi.stubEnv("DECISION_MODEL_CONFIG_PATH_GLOBAL", "");

        const { notifications } = runToggle();

        expect(notifications).toEqual([
            {
                message:
                    "Could not toggle the decision model: The global decision-model config path is disabled.",
                type: "warning",
            },
        ]);
    });
});
