import {
    createEventBus,
    SessionManager,
    type AgentToolResult,
    type EventBus,
    type ExtensionAPI,
    type ExtensionContext,
    type ExtensionUIContext,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * Test doubles for the two `pi` surfaces a suite has to fabricate: `ExtensionAPI` (what an extension
 * registers into) and `ExtensionContext` (what a handler is invoked with).
 *
 * Unmodelled members read as **absent**, exactly like the `as any` object literals these replace. That is
 * deliberate and load-bearing: production branches on presence, not just on calls —
 * `typeof sessionManager.getEntries === "function"` chooses whether the session has an entry index
 * (`src/tools/agent/runs/persistence/load.ts:97`), and `permissionSource()?.getMode?.()` reports no
 * mode when the source is missing. A double that answered unknown reads with a placeholder function
 * would pass every presence check and silently move tests onto different code paths. A direct call on an
 * unmodelled member still fails, with `x is not a function`.
 *
 * `createPiStub` keeps the one thing separate recorders cannot: `order`, the registration sequence
 * *across* members. Handler registration order is permission precedence in `child/gates/`, so suites
 * assert on the interleaving.
 *
 * To give a member real behavior in one test, pass it to the factory or assign it afterwards:
 * `stub.pi.appendEntry = (type, data) => store.push({ type, data })` stays typechecked.
 *
 * Handler and event *arguments* stay untyped. Tests hand partial events on purpose, and forcing full
 * `ToolCallEvent` literals at every call site is more noise than the casts it replaces.
 */

/**
 * The factory pi hands to `ui.custom`, widened to what a test can actually call it with: these suites
 * drive a real dialog component but have no TUI, no keybindings, and a resolve callback as `done`.
 */
type StubComponentFactory = (
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    done: (result: unknown) => void,
) => unknown;

/** A recorded handler called through {@link handlerView}: the context is optional, as in the suites. */
export type RecordedHandler = (event: unknown, ctx?: unknown) => Promise<unknown>;

/** A handler exactly as recorded: no invented event or context shape. */
export type StubHandler = (event: unknown, ctx: unknown) => unknown;

/** Derived from the real API so a pi signature change surfaces here first. */
type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];
type ShortcutOptions = Parameters<ExtensionAPI["registerShortcut"]>[1];
// pi's `sendMessage<T>` instantiated at its default: keeps `display` and `details`, which a hand-written
// `{ customType, content }` shape narrowed away and forced suites to re-record the argument themselves.
type SentMessage = Parameters<ExtensionAPI["sendMessage"]>[0];
// Derived from the context member itself: pi does not export this type from its root.
export type SessionManagerLike = ExtensionContext["sessionManager"];

/**
 * A registered tool plus a call signature. `Details` re-materializes the generic pi erases from
 * `ToolDefinition.execute`, so a suite that knows its tool's `AgentToolResult<TDetails>` asks for it at
 * the lookup instead of casting every call.
 */
interface StubTool<Details = unknown> {
    readonly name: string;
    readonly definition: ToolDefinition;
    execute(
        toolCallId: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: unknown,
    ): Promise<AgentToolResult<Details>>;
}

export interface PiStub {
    /** Pass this to the extension factory under test. */
    readonly pi: ExtensionAPI;
    /** `on:<event>`, `tool:<name>`, `command:<name>`, `shortcut:<key>` in registration order. */
    readonly order: string[];
    readonly tools: StubTool[];
    readonly commands: Array<{ name: string; options: CommandOptions }>;
    readonly shortcuts: Array<{ key: ShortcutKey; options: ShortcutOptions }>;
    readonly entries: Array<{ customType: string; data: unknown }>;
    /** One entry per call, holding pi's own argument pair rather than a narrowed projection. */
    readonly sentMessages: Array<{ message: SentMessage; options: unknown }>;
    /** Handlers registered for one event, in registration order. */
    handlersFor(event: string): StubHandler[];
    /** The handler registered for `event` at `index`; fails naming the event when absent. */
    requireHandler(event: string, index?: number): StubHandler;
    /** The single tool registered under `name`; fails listing what was registered. */
    requireTool<Details = unknown>(name: string): StubTool<Details>;
    /** The options the command `name` was registered with; fails listing what was registered. */
    requireCommand(name: string): CommandOptions;
}

/** The `pi` members production calls — measured across `src/`, not guessed. */
/**
 * `eventBus: null` produces a double with **no** `events` member at all: pi types `events` as required,
 * but production treats it as optional (`AgentLifecycle` falls back to no dialog bus), and a suite that
 * pins that absent shape needs `pi.events` to stay absent rather than be deleted afterwards. Omitting the
 * key is what makes `pi.events?.on(...)` skip, exactly as it would on a real minimal context.
 */
export function createPiStub(options: { eventBus?: EventBus | null } = {}): PiStub {
    const events = options.eventBus === null ? undefined : (options.eventBus ?? createEventBus());
    const order: string[] = [];
    const tools: StubTool[] = [];
    const commands: Array<{ name: string; options: CommandOptions }> = [];
    const shortcuts: Array<{ key: ShortcutKey; options: ShortcutOptions }> = [];
    const entries: Array<{ customType: string; data: unknown }> = [];
    const sentMessages: Array<{ message: SentMessage; options: unknown }> = [];
    const handlers = new Map<string, StubHandler[]>();

    return {
        pi: {
            ...(events ? { events } : {}),
            on(event: string, handler: StubHandler) {
                order.push(`on:${event}`);
                const registered = handlers.get(event) ?? [];
                registered.push(handler);
                handlers.set(event, registered);
            },
            registerTool(definition: ToolDefinition) {
                order.push(`tool:${definition.name}`);
                tools.push({
                    name: definition.name,
                    definition,
                    execute: definition.execute as never,
                });
            },
            registerCommand(name: string, commandOptions: CommandOptions) {
                order.push(`command:${name}`);
                commands.push({ name, options: commandOptions });
            },
            registerShortcut(key: ShortcutKey, shortcutOptions: ShortcutOptions) {
                order.push(`shortcut:${key}`);
                shortcuts.push({ key, options: shortcutOptions });
            },
            appendEntry(customType: string, data?: unknown) {
                entries.push({ customType, data });
            },
            sendMessage(message: SentMessage, opts?: unknown) {
                sentMessages.push({ message, options: opts });
            },
        } as unknown as ExtensionAPI,
        order,
        tools,
        commands,
        shortcuts,
        entries,
        sentMessages,
        handlersFor(event: string): StubHandler[] {
            return handlers.get(event) ?? [];
        },
        requireHandler(event: string, index = 0): StubHandler {
            const registered = handlers.get(event) ?? [];
            const handler = registered[index];
            if (!handler) {
                const seen = [...handlers.keys()].join(", ") || "none";
                throw new Error(
                    `pi stub: no handler at index ${index} for "${event}" ` +
                        `(registered events: ${seen}).`,
                );
            }

            return handler;
        },
        requireTool<Details = unknown>(name: string): StubTool<Details> {
            const found = tools.find((candidate) => candidate.name === name);
            if (!found) {
                const registered = tools.map((tool) => tool.name).join(", ") || "none";
                throw new Error(
                    `pi stub: no tool named "${name}" was registered (saw: ${registered}).`,
                );
            }

            // The `tools` array is heterogeneous, so the per-tool result generic is asserted here, once,
            // rather than at every call site.
            return found as StubTool<Details>;
        },
        requireCommand(name: string): CommandOptions {
            const found = commands.find((candidate) => candidate.name === name);
            if (!found) {
                const registered = commands.map((command) => command.name).join(", ") || "none";
                throw new Error(
                    `pi stub: no command named "${name}" was registered (saw: ${registered}).`,
                );
            }

            return found.options;
        },
    };
}

/**
 * UI overrides. `custom` is re-declared rather than inherited because it is a *generic method*
 * (`custom<T>(factory, options): Promise<T>`): no concrete return value is assignable to `T`, so a double
 * cannot implement it faithfully. Taking a `StubComponentFactory` keeps the common test shape — drive the
 * factory with a partial environment, resolve it with a plain value — working without a cast. This is the
 * one place the double is deliberately looser than the real type.
 */
type UiStubOverrides = Partial<Omit<ExtensionUIContext, "custom">> & {
    custom?: (factory: StubComponentFactory) => unknown;
};

export function stubUi(overrides: UiStubOverrides = {}): ExtensionUIContext {
    return { notify: () => {}, ...overrides } as ExtensionUIContext;
}

/**
 * A typed view over recorded handlers, keyed by event, so a suite can keep the
 * `handlers.tool_call[0](event, ctx)` shape it was written with. Registration order and indexing are
 * preserved because each list is the double's own.
 *
 * The view is a **snapshot**: build it only after every extension that registers for those events has
 * run. A suite that registers something afterwards sees a stale list, so move that registration into the
 * setup helper (keeping its order) rather than reaching for the double again.
 */
export function handlerView<E extends string>(
    stub: PiStub,
    ...events: readonly E[]
): Record<E, RecordedHandler[]> {
    const view = {} as Record<E, RecordedHandler[]>;
    for (const event of events) {
        view[event] = stub
            .handlersFor(event)
            .map((handler) => async (event_: unknown, ctx?: unknown) => await handler(event_, ctx));
    }

    return view;
}

/**
 * Invoke a recorded handler. The result stays `unknown`, because a suite asserts on its *shape* with
 * `toEqual`/`toMatchObject`; read properties off it only after narrowing at the call site.
 */
export async function invoke(handler: StubHandler, event: unknown, ctx: unknown): Promise<unknown> {
    return await handler(event, ctx);
}

/**
 * An `ExtensionContext` with pi's required members filled in, overridable per test.
 *
 * `ui` defaults to a no-op UI; `sessionManager`, `modelRegistry`, and the rest of the object graph have
 * no meaningful default, so they arrive empty and a test that needs behavior passes its own — often a
 * real `SessionManager.create(...)`.
 */
export function stubContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
    const defaults = {
        ui: stubUi(),
        mode: "print",
        hasUI: false,
        cwd: "/tmp/project",
        sessionManager: stubSessionManager(),
        modelRegistry: {} as ExtensionContext["modelRegistry"],
        model: undefined,
        scopedModels: [],
        isIdle: () => true,
        isProjectTrusted: () => false,
        signal: undefined,
        abort: () => {},
        hasPendingMessages: () => false,
        shutdown: () => {},
        getContextUsage: () => undefined,
        compact: async () => ({ text: "", entries: [] }),
        getSystemPrompt: () => "",
    } satisfies Partial<ExtensionContext>;

    return { ...defaults, ...overrides };
}

/** A `ReadonlySessionManager` stand-in: pi declares fourteen members and tests usually need three. */
/**
 * An `ExtensionContext` whose session manager is the write-capable class rather than the read-only view.
 * Persistence suites need `sessionManager.appendCustomEntry(...)` while still handing the context to
 * functions typed against `ExtensionContext`.
 */
export type SessionBackedContext = ExtensionContext & { sessionManager: SessionManager };

/** `stubContext` for a real `SessionManager`, narrowed so writes on `sessionManager` stay typed. */
export function stubSessionContext(
    sessionManager: SessionManager,
    overrides: Partial<ExtensionContext> = {},
): SessionBackedContext {
    return { ...stubContext({ sessionManager, ...overrides }), sessionManager };
}

/** What these suites drive a dialog component with: focus, then a raw key sequence. */
export interface StubDialog {
    focused: boolean;
    handleInput(key: string): void;
}

/**
 * A `ui` whose `custom` runs the production component factory and collects what it built, so a test can
 * assert how many dialogs opened and drive them. Three suites had a private copy of this, including the
 * `focused = true` assignment the components require before they accept input.
 */
export function stubUiWithDialogs(theme: ExtensionUIContext["theme"]): {
    ui: ExtensionUIContext;
    dialogs: StubDialog[];
} {
    const dialogs: StubDialog[] = [];
    const ui = stubUi({
        theme,
        setWorkingVisible() {},
        custom(factory) {
            return new Promise<unknown>((resolve) => {
                const component = factory(undefined, theme, undefined, resolve) as StubDialog;
                component.focused = true;
                dialogs.push(component);
            });
        },
    });

    return { ui, dialogs };
}

export function stubSessionManager(
    overrides: Partial<SessionManagerLike> = {},
): SessionManagerLike {
    return overrides as SessionManagerLike;
}
