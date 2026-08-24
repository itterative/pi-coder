import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";

/**
 * A focus binding for one overlay participating in the local overlay stack.
 * Bind it from the custom component factory, then pass setHandle to the
 * ctx.ui.custom onHandle option.
 */
export interface OverlayStackBinding {
    bind(tui: TUI): void;
    setHandle(handle: OverlayHandle): void;
}

interface OverlayEntry {
    handle?: OverlayHandle;
    manager?: OverlayStackManager;
}

class OverlayStackManager {
    private readonly entries: OverlayEntry[] = [];
    private readonly removeInputListener: () => void;

    constructor(tui: TUI) {
        this.removeInputListener = tui.addInputListener(() => {
            this.focusTop();
            // Focus is corrected before TUI dispatches the current key.
            return undefined;
        });
    }

    add(entry: OverlayEntry): void {
        if (entry.manager) return;
        entry.manager = this;
        this.entries.push(entry);
        this.focusTop();
    }

    remove(entry: OverlayEntry): void {
        const index = this.entries.indexOf(entry);
        if (index === -1) return;
        this.entries.splice(index, 1);
        entry.manager = undefined;
        this.focusTop();
    }

    focusTop(): void {
        // Deliberately use the local stack rather than trying to infer whether
        // TUI focus was changed by an overlay or by a non-overlay component.
        // Participating overlays should use their OverlayHandle to change
        // focus intentionally; this guard catches all other focus changes.
        for (let index = this.entries.length - 1; index >= 0; index--) {
            const handle = this.entries[index]?.handle;
            if (!handle || handle.isHidden()) continue;
            if (!handle.isFocused()) handle.focus();
            return;
        }
    }

    isEmpty(): boolean {
        return this.entries.length === 0;
    }

    dispose(): void {
        this.removeInputListener();
    }
}

const managers = new WeakMap<TUI, OverlayStackManager>();

function managerFor(tui: TUI): OverlayStackManager {
    const existing = managers.get(tui);
    if (existing) return existing;
    const manager = new OverlayStackManager(tui);
    managers.set(tui, manager);
    return manager;
}

function releaseManager(tui: TUI, manager: OverlayStackManager): void {
    if (managers.get(tui) !== manager) return;
    managers.delete(tui);
    manager.dispose();
}

/**
 * Keep the top participating overlay focused for the lifetime of an overlay
 * operation. This is useful when a non-overlay custom component can call
 * TUI.setFocus() while a visible overlay remains on top.
 *
 * The custom factory must call binding.bind(tui), and its ctx.ui.custom
 * options should pass binding.setHandle as onHandle:
 *
 * await withOverlayStack((binding) => ctx.ui.custom(
 *   (tui, theme, _keybindings, done) => {
 *     binding.bind(tui);
 *     return createOverlay(tui, theme, done);
 *   },
 *   { overlay: true, onHandle: binding.setHandle },
 * ));
 *
 * Overlays not registered with this helper are not represented in its stack.
 * If one is simultaneously visible, this guard cannot distinguish it from a
 * non-overlay focus change and may reclaim focus; participating nested
 * overlays should also register with this helper.
 */
export async function withOverlayStack<T>(
    show: (binding: OverlayStackBinding) => Promise<T>,
): Promise<T> {
    const entry: OverlayEntry = {};
    let tui: TUI | undefined;

    const binding: OverlayStackBinding = {
        bind: (nextTui) => {
            if (tui && tui !== nextTui) {
                throw new Error("An overlay stack binding cannot move between TUI instances.");
            }
            tui = nextTui;
            managerFor(nextTui).add(entry);
        },
        setHandle: (handle) => {
            entry.handle = handle;
            entry.manager?.focusTop();
        },
    };

    try {
        return await show(binding);
    } finally {
        if (tui && entry.manager) {
            const manager = entry.manager;
            manager.remove(entry);
            // The manager is shared by nested stack entries. It is safe to
            // release its listener only once this entry was the last one.
            if (manager.isEmpty()) releaseManager(tui, manager);
        }
    }
}
