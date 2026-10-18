/**
 * Footer help tips: the short strings the status footer shows from time to time, and the rotator that
 * decides when one is on the line.
 *
 * Timing lives here rather than in the footer so the footer stays a renderer of current state: the
 * rotator owns its timers, reports tip appear/disappear through `onChange`, and is disposed with the
 * footer that created it.
 */

import decisionConfig from "../../modules/decision/config";

/** A one-line help tip. Keep them short and concrete; no trailing period. */
export interface FooterTip {
    /** The text shown after the `tip: ` prefix. */
    text: string;
    /** When set, the tip is only offered while this returns true. */
    when?: () => boolean;
    /** Lead with this tip at the first window where it is available, once per rotator. */
    preferFirst?: boolean;
}

/** The tips shown in rotation. */
const FOOTER_TIPS: readonly FooterTip[] = [
    {
        text: "alt+a toggles the Bash tool's auto mode",
        // The shortcut is only news while the classifier is off: the badge already says "auto".
        when: () => decisionConfig.current.enabled !== true,
        preferFirst: true,
    },
    { text: "/agents lists runs, workspaces, and settings" },
    { text: "Blocked commands? Edit .pi/bash-sandbox-config.json" },
    { text: "Ask for a scout to explore before I change code" },
    { text: "Say 'remember this' to keep it in project memory" },
    { text: "Tune the command classifier in /agents → Settings" },
];

const DEFAULT_TIP_FIRST_DELAY_MS = 20_000;
const DEFAULT_TIP_INTERVAL_MS = 90_000;
const DEFAULT_TIP_VISIBLE_MS = 10_000;

export interface TipRotatorOptions {
    /** Tips to rotate through; defaults to `FOOTER_TIPS`. */
    tips?: readonly FooterTip[];
    /** Delay before the first tip; later tips follow at `intervalMs`. */
    firstDelayMs?: number;
    /** How long to wait between tips. */
    intervalMs?: number;
    /** How long a tip stays visible. */
    visibleMs?: number;
    /** Random source for the shuffle order; tests inject a deterministic one. */
    random?: () => number;
}

/**
 * Shows one tip per interval for a short visible window, never repeating a tip until the whole list has
 * been shown. `onChange` fires with the tip when it appears and with `undefined` when it goes away, so
 * the owner only has to re-render.
 */
export class TipRotator {
    private readonly tips: readonly FooterTip[];
    private readonly firstDelayMs: number;
    private readonly intervalMs: number;
    private readonly visibleMs: number;
    private readonly random: () => number;
    private readonly preferredShown = new Set<FooterTip>();
    private queue: FooterTip[] = [];
    private nextTimer?: ReturnType<typeof setTimeout>;
    private hideTimer?: ReturnType<typeof setTimeout>;
    private disposed = false;

    constructor(
        private readonly onChange: (tip: FooterTip | undefined) => void,
        options: TipRotatorOptions = {},
    ) {
        this.tips = options.tips ?? FOOTER_TIPS;
        this.firstDelayMs = options.firstDelayMs ?? DEFAULT_TIP_FIRST_DELAY_MS;
        this.intervalMs = options.intervalMs ?? DEFAULT_TIP_INTERVAL_MS;
        this.visibleMs = options.visibleMs ?? DEFAULT_TIP_VISIBLE_MS;
        this.random = options.random ?? Math.random;
    }

    /** Begin rotating. Idempotent: a started rotator ignores further `start` calls. */
    start(): void {
        if (this.disposed || this.nextTimer || this.hideTimer) return;

        this.scheduleNext(this.firstDelayMs);
    }

    /** Stop rotating and drop any visible tip, without the change callback. */
    dispose(): void {
        this.disposed = true;
        this.cancelTimers();
    }

    private cancelTimers(): void {
        if (this.nextTimer) clearTimeout(this.nextTimer);
        if (this.hideTimer) clearTimeout(this.hideTimer);

        this.nextTimer = undefined;
        this.hideTimer = undefined;
    }

    private scheduleNext(delayMs: number): void {
        this.nextTimer = setTimeout(() => {
            this.nextTimer = undefined;
            this.showNext();
        }, delayMs);
    }

    private showNext(): void {
        const tip = this.takeTip();
        if (tip === undefined) {
            this.scheduleNext(this.intervalMs);
            return;
        }

        this.onChange(tip);
        this.hideTimer = setTimeout(() => {
            this.hideTimer = undefined;
            this.onChange(undefined);
            this.scheduleNext(this.intervalMs);
        }, this.visibleMs);
    }

    /**
     * Pick the tip for this window: a `preferFirst` tip that is available and has not led yet jumps the
     * queue once, then rotation continues through the shuffled remainder. Unavailable tips stay queued so
     * they appear in their place once their condition holds, and a window with nothing available is
     * skipped without consuming anything.
     */
    private takeTip(): FooterTip | undefined {
        if (this.queue.length === 0) {
            this.queue = shuffled(this.tips, this.random);
        }

        return this.takePreferredTip() ?? this.takeRotatedTip();
    }

    private takePreferredTip(): FooterTip | undefined {
        const preferred = this.tips.find(
            (tip) =>
                tip.preferFirst === true && !this.preferredShown.has(tip) && isTipAvailable(tip),
        );
        if (preferred === undefined) {
            return undefined;
        }

        this.preferredShown.add(preferred);
        const index = this.queue.indexOf(preferred);
        if (index !== -1) {
            this.queue.splice(index, 1);
        }

        return preferred;
    }

    private takeRotatedTip(): FooterTip | undefined {
        const index = this.queue.findLastIndex((tip) => isTipAvailable(tip));
        if (index === -1) {
            return undefined;
        }

        return this.queue.splice(index, 1)[0];
    }
}

/** A tip with no `when` is always available; a false condition defers it to a later window. */
function isTipAvailable(tip: FooterTip): boolean {
    return tip.when?.() !== false;
}

/** Fisher-Yates over a copy, so the configured tip list keeps its order. */
function shuffled(values: readonly FooterTip[], random: () => number): FooterTip[] {
    const items = [...values];

    for (let index = items.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        const value = items[index];
        items[index] = items[swap];
        items[swap] = value;
    }

    return items;
}
