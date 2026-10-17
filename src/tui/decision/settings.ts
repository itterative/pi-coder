/**
 * Decision Model Settings Dialog
 *
 * The list dialog behind the Settings tab's decision-model row. It owns the interaction only: the effective
 * configuration arrives as state, every edit leaves through `onChange`, and the model picker and text fields
 * are opened as nested overlays by `decisionModelDialog` so the component stays drivable in tests.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";

import { BORDER_STYLES } from "../border-box";
import {
    ListViewComponent,
    type ItemPrefix,
    type ListItem,
    type ListViewRenderItemOptions,
    type ListViewState,
} from "../list-view";
import { withOverlayStack } from "../overlay-stack";
import { SelectComponent } from "../select";
import { textInput } from "../text-input";

/** A classifier the user's providers offer, as a choice for the model row. */
export interface DecisionSettingsChoice {
    provider: string;
    model: string;
    /** Registry display name, shown dim when it differs from the id. */
    name?: string;
}

/** The effective configuration the dialog renders and edits. */
export interface DecisionSettingsState {
    enabled: boolean;
    apply: boolean;
    /** True when the model comes from the custom System One endpoint rather than a provider. */
    custom: boolean;
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiKeySet: boolean;
}

/** A change the dialog made, in dialog terms; the caller maps it onto the config. */
export interface DecisionSettingsPatch {
    enabled?: boolean;
    apply?: boolean;
    custom?: boolean;
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
}

export type DecisionTextField = "baseUrl" | "apiKey" | "modelId";

type DecisionModelTarget =
    { kind: "classifier"; provider: string; model: string; name?: string } | { kind: "custom" };

export interface DecisionSettingsCallbacks {
    onChange: (patch: DecisionSettingsPatch) => void | Promise<void>;
    /** Resolve the model row: a classifier pick, the custom endpoint, or nothing on cancel. */
    chooseModel: () => Promise<DecisionModelTarget | undefined>;
    /** Edit one field; `undefined` means cancelled or no change. */
    editField: (
        field: DecisionTextField,
        current: DecisionSettingsState,
    ) => Promise<string | undefined>;
    onError?: (error: unknown) => void;
}

type DecisionRowId = "enabled" | "apply" | "model" | DecisionTextField;

interface DecisionRow {
    id: DecisionRowId;
    toggle: boolean;
    title: string;
    value: string;
    description: string;
}

function modelLabel(state: DecisionSettingsState): string {
    if (state.custom) {
        return state.model === undefined
            ? "custom endpoint · not set"
            : `custom endpoint · ${state.model}`;
    }
    if (state.provider !== undefined && state.model !== undefined) {
        return `${state.provider}/${state.model}`;
    }
    if (state.model !== undefined) {
        return state.model;
    }
    return "not configured";
}

function rowsFor(state: DecisionSettingsState): DecisionRow[] {
    const rows: DecisionRow[] = [
        {
            id: "enabled",
            toggle: true,
            title: "Enabled",
            value: state.enabled ? "On" : "Off",
            description: "Consult the classifier for unresolved commands.",
        },
        {
            id: "apply",
            toggle: true,
            title: "Apply verdicts",
            value: state.apply ? "On" : "Off",
            description: state.apply
                ? "A confident verdict resolves the prompt."
                : "Dry run: verdicts are recorded, not applied.",
        },
        {
            id: "model",
            toggle: false,
            title: "Decision model",
            value: modelLabel(state),
            description: "Pick a provider classifier or the custom endpoint.",
        },
    ];

    if (state.custom) {
        rows.push(
            {
                id: "baseUrl",
                toggle: false,
                title: "Endpoint URL",
                value: state.baseUrl ?? "not set",
                description: "System One base URL, e.g. http://127.0.0.1:8000/v1.",
            },
            {
                id: "apiKey",
                toggle: false,
                title: "API key",
                value: state.apiKeySet ? "set" : "not set",
                description: "Stored in the global config, not the repository.",
            },
            {
                id: "modelId",
                toggle: false,
                title: "Model id",
                value: state.model ?? "not set",
                description: "Model name sent to the endpoint.",
            },
        );
    }

    return rows;
}

function listItems(state: DecisionSettingsState): ListItem<DecisionRow>[] {
    return rowsFor(state).map((row) => ({
        value: row,
        label: row.toggle ? row.title : `${row.title}: ${row.value}`,
    }));
}

function renderRow(
    item: ListItem<DecisionRow>,
    options: ListViewRenderItemOptions<DecisionRow, ListViewState<DecisionRow>>,
): string {
    const row = item.value;
    const title = options.theme.fg("text", row.title);
    const first = row.toggle ? title : `${title}: ${options.theme.fg("accent", row.value)}`;
    return `${first}\n${options.theme.fg("muted", row.description)}`;
}

/** The settings rows, as a list dialog. */
export interface DecisionSettingsComponentOptions {
    /** Total frame height, evaluated per render. */
    fixedHeight?: () => number;
    /** Dim warning line above the help footer, e.g. a project config overriding the saved values. */
    note?: string;
}

/** The settings rows, as a list dialog. */
export class DecisionSettingsComponent extends ListViewComponent<
    DecisionRow,
    void,
    ListViewState<DecisionRow>
> {
    private readonly settings: DecisionSettingsState;
    private readonly callbacks: DecisionSettingsCallbacks;
    private readonly note: string | undefined;
    private busy = false;

    constructor(
        settings: DecisionSettingsState,
        callbacks: DecisionSettingsCallbacks,
        options: DecisionSettingsComponentOptions = {},
    ) {
        super(
            {
                title: "Decision model",
                borderColor: "borderMuted",
                borderCharacters: BORDER_STYLES.rounded,
                itemSpacing: 1,
                trailingSpacer: false,
                ...(options.fixedHeight === undefined ? {} : { fixedHeight: options.fixedHeight }),
                headerContent: (container, theme) => {
                    container.addChild(
                        new Text(
                            theme.fg("muted", "  Optional classifier for unresolved commands."),
                            1,
                            0,
                        ),
                    );
                },
                renderItem: renderRow,
                helpText: "↑/↓ navigate · Enter toggle or edit · Esc close",
            },
            {
                items: listItems(settings),
                cursor: 0,
                scrollOffset: 0,
                maxVisibleLines: 24,
            },
        );
        this.settings = settings;
        this.callbacks = callbacks;
        this.note = options.note;
    }

    protected override renderStatus(container: Box): void {
        if (this.note === undefined || this.theme === null) {
            return;
        }

        container.addChild(new Spacer(1));
        for (const line of this.note.split("\n")) {
            container.addChild(new Text(this.theme.fg("warning", `  ${line}`), 1, 0));
        }
    }

    protected override getItemPrefix(index: number, isCursor: boolean): ItemPrefix {
        const cursor = isCursor && this.theme ? this.theme.fg("accent", "→ ") : "  ";
        const row = this.state.items[index]?.value;
        if (row === undefined || !row.toggle) {
            return { first: cursor, continuation: "  " };
        }

        const box =
            row.value === "On"
                ? (this.theme?.fg("success", "[x] ") ?? "[x] ")
                : (this.theme?.fg("dim", "[ ] ") ?? "[ ] ");
        return { first: `${cursor}${box}`, continuation: "      " };
    }

    protected override handleAction(key: string): void {
        if (matchesKey(key, "escape") || key === "q") {
            this.finish();
            return;
        }
        if (!matchesKey(key, "enter") && key !== " ") {
            return;
        }

        const row = this.state.items[this.state.cursor ?? 0]?.value;
        if (row === undefined) {
            return;
        }

        switch (row.id) {
            case "enabled":
            case "apply":
                this.toggle(row.id);
                return;
            case "model":
                void this.chooseModel();
                return;
            case "baseUrl":
            case "apiKey":
            case "modelId":
                void this.editField(row.id);
                return;
        }
    }

    private toggle(field: "enabled" | "apply"): void {
        const next = !this.settings[field];
        this.settings[field] = next;
        this.rebuild();
        this.save(field === "enabled" ? { enabled: next } : { apply: next });
    }

    private chooseModel(): Promise<void> {
        return this.run(async () => {
            const target = await this.callbacks.chooseModel();
            if (target === undefined) {
                return;
            }

            if (target.kind === "custom") {
                this.settings.custom = true;
                this.rebuild();
                this.save({ custom: true });
                return;
            }

            this.settings.custom = false;
            this.settings.provider = target.provider;
            this.settings.model = target.model;
            this.rebuild();
            this.save({ custom: false, provider: target.provider, model: target.model });
        });
    }

    private editField(field: DecisionTextField): Promise<void> {
        return this.run(async () => {
            const value = await this.callbacks.editField(field, this.settings);
            if (value === undefined) {
                return;
            }

            if (field === "baseUrl") {
                this.settings.baseUrl = value;
                this.rebuild();
                this.save({ baseUrl: value });
                return;
            }
            if (field === "apiKey") {
                this.settings.apiKeySet = true;
                this.rebuild();
                this.save({ apiKey: value });
                return;
            }

            this.settings.model = value;
            this.rebuild();
            this.save({ model: value });
        });
    }

    private rebuild(): void {
        this.state.items = listItems(this.settings);
        this.state.cursor = Math.min(this.state.cursor ?? 0, this.state.items.length - 1);
        this.invalidate();
    }

    private save(patch: DecisionSettingsPatch): void {
        void Promise.resolve()
            .then(() => this.callbacks.onChange(patch))
            .catch((error: unknown) => this.callbacks.onError?.(error));
    }

    /** Serialize one nested-overlay interaction so a fast double Enter cannot open two overlays. */
    private run(work: () => Promise<void>): Promise<void> {
        if (this.busy) {
            return Promise.resolve();
        }

        this.busy = true;
        return work()
            .catch((error: unknown) => this.callbacks.onError?.(error))
            .finally(() => {
                this.busy = false;
            });
    }
}

export interface DecisionSettingsDialogOptions {
    state: DecisionSettingsState;
    choices: readonly DecisionSettingsChoice[];
    onChange: (patch: DecisionSettingsPatch) => void | Promise<void>;
    /** A project config file that overrides the saved global values, shown as a warning when present. */
    projectConfigPath?: string;
    onError?: (error: unknown) => void;
}

/** Open the decision-model settings list with its picker and field editors as nested overlays. */
export async function decisionModelDialog(
    options: DecisionSettingsDialogOptions,
    ctx: ExtensionCommandContext,
): Promise<void> {
    if (!ctx.hasUI || ctx.mode !== "tui") {
        return;
    }

    const callbacks: DecisionSettingsCallbacks = {
        onChange: options.onChange,
        ...(options.onError === undefined ? {} : { onError: options.onError }),
        chooseModel: () => chooseModel(options, ctx),
        editField: (field, current) => editField(field, current, ctx),
    };

    await withOverlayStack((overlay) =>
        ctx.ui.custom<void>(
            (tui, theme, _keybindings, done) => {
                const terminalRows = tui.terminal?.rows;
                const component = new DecisionSettingsComponent(options.state, callbacks, {
                    ...(terminalRows === undefined
                        ? {}
                        : {
                              fixedHeight: () =>
                                  Math.max(
                                      2,
                                      Math.min(Math.floor(terminalRows * 0.8), terminalRows - 2),
                                  ),
                          }),
                    ...(options.projectConfigPath === undefined
                        ? {}
                        : {
                              note: `A project config overrides these values:\n${options.projectConfigPath}`,
                          }),
                });
                component.setDoneCallback(() => done());
                component.initialize(theme);
                overlay.bind(tui);
                return component;
            },
            {
                overlay: true,
                overlayOptions: {
                    width: "72%",
                    minWidth: 56,
                    maxHeight: "80%",
                    anchor: "center",
                    margin: 1,
                },
                onHandle: overlay.setHandle,
            },
        ),
    );
}

async function chooseModel(
    options: DecisionSettingsDialogOptions,
    ctx: ExtensionCommandContext,
): Promise<DecisionModelTarget | undefined> {
    const items = [
        { value: { kind: "custom" } as DecisionModelTarget, label: "Custom endpoint…" },
        ...options.choices.map((choice) => ({
            value: {
                kind: "classifier",
                provider: choice.provider,
                model: choice.model,
                ...(choice.name === undefined ? {} : { name: choice.name }),
            } as DecisionModelTarget,
            label: `${choice.provider}/${choice.model}`,
        })),
    ];
    const initialCursor = items.findIndex(
        (item) =>
            item.value.kind === "classifier" &&
            item.value.provider === options.state.provider &&
            item.value.model === options.state.model,
    );

    return withOverlayStack((overlay) =>
        ctx.ui.custom<DecisionModelTarget | undefined>(
            (tui, theme, _keybindings, done) => {
                const component = new SelectComponent<DecisionModelTarget>({
                    title: "Decision model",
                    items,
                    ...(initialCursor < 0 ? {} : { initialCursor }),
                    enableSearch: true,
                    headerSpacing: false,
                    headerContent: (container) => {
                        container.addChild(
                            new Text(
                                theme.fg(
                                    "muted",
                                    "  Provider classifiers, or the custom endpoint.",
                                ),
                                1,
                                0,
                            ),
                        );
                    },
                    helpText: "Type to search · ↑/↓ navigate · Enter select · Esc back",
                    renderItem: (item) => {
                        const target = item.value;
                        if (target.kind === "classifier" && target.name !== undefined) {
                            return `${item.label}\n${theme.fg("muted", `  ${target.name}`)}`;
                        }
                        return item.label;
                    },
                });
                component.setDoneCallback(done);
                component.initialize(theme);
                overlay.bind(tui);
                return component;
            },
            {
                overlay: true,
                overlayOptions: {
                    width: "60%",
                    minWidth: 52,
                    maxHeight: "70%",
                    anchor: "center",
                    margin: 1,
                },
                onHandle: overlay.setHandle,
            },
        ),
    );
}

interface DecisionFieldSpec {
    title: string;
    description: string;
    initialValue: string;
    placeholder: string;
    fieldLabel: string;
    allowEmpty: boolean;
    emptyError: string;
}

function fieldSpec(field: DecisionTextField, state: DecisionSettingsState): DecisionFieldSpec {
    switch (field) {
        case "baseUrl":
            return {
                title: "Endpoint URL",
                description: "System One base URL, for example http://127.0.0.1:8000/v1.",
                initialValue: state.baseUrl ?? "",
                placeholder: "http://127.0.0.1:8000/v1",
                fieldLabel: "URL: ",
                allowEmpty: false,
                emptyError: "Enter the endpoint URL.",
            };
        case "apiKey":
            return {
                title: "API key",
                description: "Stored in the global decision-model config, never in the repository.",
                initialValue: "",
                placeholder: "paste a key · blank keeps the current one",
                fieldLabel: "Key: ",
                allowEmpty: true,
                emptyError: "",
            };
        case "modelId":
            return {
                title: "Model id",
                description: "Model name sent to the endpoint.",
                initialValue: state.model ?? "",
                placeholder: "vllm-d3-flash",
                fieldLabel: "Model: ",
                allowEmpty: false,
                emptyError: "Enter the model id.",
            };
    }
}

async function editField(
    field: DecisionTextField,
    state: DecisionSettingsState,
    ctx: ExtensionCommandContext,
): Promise<string | undefined> {
    const spec = fieldSpec(field, state);
    const value = await textInput(
        {
            title: spec.title,
            description: spec.description,
            initialValue: spec.initialValue,
            placeholder: spec.placeholder,
            fieldLabel: spec.fieldLabel,
            helpText: "Enter save · Esc cancel",
            parse: (text) => {
                const trimmed = text.trim();
                if (trimmed === "" && !spec.allowEmpty) {
                    return { error: spec.emptyError };
                }
                return { value: trimmed };
            },
        },
        ctx,
    );

    // A blank submission keeps the current value; Esc cancels the same way.
    return value === undefined || value === "" ? undefined : value;
}
