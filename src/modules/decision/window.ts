/**
 * The window allocator: spend a char budget on the items that carry the most context.
 *
 * `planSessionWindow` and `renderFitted` are priority heuristics — a guaranteed set, then newest-first under
 * per-item floors, then shares handed out newest-first. This module does the same job as an explicit
 * optimization: every item has a value curve over the chars it is given, and the budget is allocated to
 * maximize the total value. It is a turn-level multiple-choice knapsack, which buys three things a heuristic
 * cannot:
 *
 *  - the allocation is optimal for the stated value curves, so a policy describes what matters rather than
 *    the order to try things in;
 *  - diminishing returns are part of the model (per turn and per kind), so one long turn cannot monopolize
 *    the budget with near-duplicate items;
 *  - the per-turn result ({@link WindowSelection.turns}) is a first-class value, so a policy can be inspected
 *    and compared instead of only scored.
 *
 * Policies are data. {@link WINDOW_POLICY_PLAN} carries the tier-2 window's numbers and lets the state
 * markers compete, so the allocator can be compared against `planSessionWindow` on the same budget;
 * {@link WINDOW_POLICY_REMINDER} is that policy at the budget the reminder-selection ask was measured at, and
 * is wired into it; {@link WINDOW_POLICY_CONVERSATION} is a message-heavy, marker-free alternative that was
 * measured below the plan policy for the same question; {@link WINDOW_POLICY_TRANSCRIPT} mirrors the tier-1
 * transcript's caps and turn span so the phase ask can adopt the allocator later. `planSessionWindow` still
 * builds the command and file-access windows, and `fittedTranscript` the tier-1 state transcript.
 */
import { ITEM_CHARS, ITEM_MIN, TOOL_ITEMS_KEPT } from "./session-context";
import type { DecisionRecentMessage } from "./types";

/** The kinds the allocator scores separately. A state marker has its own weight and is never trimmed. */
export type WindowItemKind = "user" | "assistant" | "tool";

/**
 * How a kept item's value grows with the chars it is given, as a fraction of its full weight.
 *
 * `log` is smooth and concave, so the first chars of an item are worth the most and a long item cannot win by
 * length. `twoSegment` is the linearization: the first `floor` chars are worth `headShare`, the rest is worth
 * the remainder at a constant rate. Both are normalized so an item at its cap is worth exactly its weight.
 */
export type WindowCurve = { kind: "log" } | { kind: "twoSegment"; headShare: number };

/** What the allocator does with the recorded state markers. */
export type WindowMarkerMode =
    /** Never rendered and never charged. */
    | "drop"
    /** A normal item with its own weight; short, so it competes well but can be priced out. */
    | "compete"
    /** Always rendered, at its exact length, charged to the budget like anything else. */
    | "forced";

/** Where the budget goes, and what the allocator must keep. Pure data; a policy is the whole configuration. */
export interface WindowPolicy {
    /** Chars the window may spend, before omission lines. */
    budget: number;
    /** Char granularity the allocation is quantized to. Smaller is more exact and slower; 8 is under a word. */
    bucket: number;
    curve: WindowCurve;
    /** Weight per kind; a kind at zero is never kept. */
    weights: Record<WindowItemKind, number>;
    /** Weight of a state marker when it competes. */
    markerWeight: number;
    /** Chars an item needs before it is worth keeping at all (the smallest allocation the domain allows). */
    floors: { message: number; tool: number };
    /** Most chars one item may take. */
    caps: { message: number; tool: number };
    /**
     * Newest turns drawn on in full. Older turns contribute their messages only, their tool calls dropped —
     * the rule the tier-1 transcript uses. Zero means no span limit.
     */
    keepTurns: number;
    /** Most items one turn may contribute, newest first, before the budget is even considered. */
    perTurn: { messages: number; tools: number };
    /** Multiplier for the k-th item of the same kind within one turn (diminishing returns). */
    saturation: number;
    /** Multiplier per turn of distance behind the newest turn. */
    recencyDecay: number;
    markers: WindowMarkerMode;
    /** Newest items of each kind that are always present, at least at their floor. */
    mustKeep: { user: number; assistant: number; tools: number };
    /** How dropped items are named: one line up front, or a marker where the gap is. */
    omissions: "leading" | "inline";
}

/** One item's share of the budget, as the allocator decided it. */
export interface WindowAllocation {
    item: DecisionRecentMessage;
    /** Chars the item's text was allowed, after collapsing and clipping. */
    chars: number;
    /** The rendered line at that length. */
    line: string;
    /** True when the item is a must-keep or a forced marker rather than an optimization choice. */
    forced: boolean;
}

/** What one turn was given and the value it bought, so a policy's choices can be read without re-running it. */
export interface WindowTurnReport {
    turn: number;
    chars: number;
    value: number;
}

export interface WindowSelection {
    /** The rendered window, oldest first, with the omission line or markers the policy asked for. */
    lines: string[];
    /** Every kept item, oldest first. */
    kept: WindowAllocation[];
    /** Non-marker items the policy dropped, for the caller's own accounting. */
    omitted: number;
    /** Total value the allocation achieved; comparable across policies only on the same curve and budget. */
    value: number;
    /** Text chars actually spent, floors and markers included; omission lines and role prefixes are extra. */
    chars: number;
    /** Per turn: the chars it kept and the value that bought. */
    turns: WindowTurnReport[];
}

/** Tier-2 window numbers: the budget, floor and cap `planSessionWindow` plans inside. */
export const WINDOW_POLICY_PLAN: WindowPolicy = {
    budget: 1200,
    bucket: 8,
    curve: { kind: "twoSegment", headShare: 0.3 },
    weights: { user: 1, assistant: 0.95, tool: 0.01 },
    markerWeight: 0.2,
    floors: { message: ITEM_MIN, tool: ITEM_MIN },
    caps: { message: ITEM_CHARS, tool: ITEM_CHARS },
    keepTurns: 0,
    perTurn: { messages: 4, tools: 6 },
    saturation: 0.4,
    recencyDecay: 0.3,
    markers: "compete",
    mustKeep: { user: 1, assistant: 1, tools: TOOL_ITEMS_KEPT },
    omissions: "leading",
};

/**
 * The tier-2 reminder-selection window: {@link WINDOW_POLICY_PLAN} at a 2000-char budget.
 *
 * Measured as shape S11 over 70 mid-run points of three real sessions (171 point-by-reminder observations) at
 * the gate the module ships: kappa 0.28 against a hindsight oracle, per session 0.35 / 0.23 / -0.04. The signal
 * fields are what it drops - the same plan window with them beside it scored 0.05 (S7) and without them 0.19
 * (S10), and the conversation policy moved the same way (S5 -0.02 to S8 0.11), so the fields cost about +0.14
 * each; the budget is the one knob that held on the second branch. Named rather than inlined so production and
 * the `turn_shapes.mts` probe cannot drift onto different numbers.
 */
export const WINDOW_POLICY_REMINDER: WindowPolicy = {
    ...WINDOW_POLICY_PLAN,
    budget: 2000,
};

/**
 * Message-heavy and marker-free: the alternative the reminder-selection comparison ran against the plan policy,
 * which it lost (S8 0.11 against S10 0.19 at the same gate).
 */
export const WINDOW_POLICY_CONVERSATION: WindowPolicy = {
    budget: 1200,
    bucket: 8,
    curve: { kind: "log" },
    weights: { user: 1, assistant: 1, tool: 0.7 },
    markerWeight: 0,
    floors: { message: 180, tool: 80 },
    caps: { message: 600, tool: 160 },
    keepTurns: 0,
    perTurn: { messages: 6, tools: 4 },
    saturation: 0.85,
    recencyDecay: 0.75,
    markers: "drop",
    mustKeep: { user: 1, assistant: 1, tools: 1 },
    omissions: "leading",
};

/** The tier-1 transcript's caps and turn span, so the phase ask can move onto the allocator later. */
export const WINDOW_POLICY_TRANSCRIPT: WindowPolicy = {
    budget: 800,
    bucket: 8,
    curve: { kind: "log" },
    weights: { user: 1, assistant: 1, tool: 0.6 },
    markerWeight: 0,
    floors: { message: 220, tool: 40 },
    caps: { message: 900, tool: 120 },
    keepTurns: 3,
    perTurn: { messages: 4, tools: 8 },
    saturation: 0.8,
    recencyDecay: 0.7,
    markers: "forced",
    mustKeep: { user: 1, assistant: 1, tools: 2 },
    omissions: "inline",
};

/** The policy a caller gets when it does not name one. */
export const DEFAULT_WINDOW_POLICY: WindowPolicy = WINDOW_POLICY_PLAN;

/** One item after preparation: its kind, its weight, and the allocation domain the knapsack searches. */
interface Atom {
    item: DecisionRecentMessage;
    index: number;
    kind: WindowItemKind | "marker";
    turn: number;
    text: string;
    /** Smallest allocation worth keeping, in chars, clamped to the text the item actually has. */
    floor: number;
    /** Largest allocation the item may take, in chars, clamped to its text. */
    cap: number;
    required: boolean;
    weight: number;
    floorUnits: number;
    capUnits: number;
    /** Units already paid outside the knapsack, so a required item's cheapest option costs zero. */
    paidUnits: number;
}

const MARKER_ROLE = "state";

function collapse(text: string): string {
    return text.replace(/\s+/gu, " ").trim();
}

function clip(text: string, limit: number): string {
    if (limit <= 0) {
        return "";
    }

    return text.length <= limit ? text : `${text.slice(0, Math.max(limit - 1, 0))}…`;
}

/** The item's kind for scoring and for the limits; every non-tool role reads as a message. */
function kindOf(role: string): WindowItemKind | "marker" {
    if (role === MARKER_ROLE) {
        return "marker";
    }

    return role === "command" || role === "tool"
        ? "tool"
        : role === "assistant"
          ? "assistant"
          : "user";
}

/** The rendered line, matching the existing renderers' `User:` / `Assistant:` / `Tool:` shapes. */
function renderLine(item: DecisionRecentMessage, chars: number): string {
    const text = clip(collapse(item.text), chars);

    if (item.role === MARKER_ROLE) {
        return text;
    }
    if (item.role === "command") {
        return `Tool: bash(${text})`;
    }
    if (item.role === "tool") {
        return `Tool: ${text}`;
    }

    const label =
        item.role === "user" ? "User" : item.role === "assistant" ? "Assistant" : item.role;
    return `${label}: ${text}`;
}

/**
 * The text one allocation sends: the item's text collapsed and clipped to the chars the allocator gave it.
 *
 * This is exactly the text {@link WindowAllocation.line} renders - behind a `User:` / `Assistant:` prefix, inside
 * a `Tool: ...` wrapper - and neither the prefix nor the wrapper is charged to the budget, so a caller that
 * records what the model actually read (the debug entry's window, a replay) takes the text from here rather than
 * from the item, which still holds its unclipped length.
 */
export function allocationText(allocation: WindowAllocation): string {
    return clip(collapse(allocation.item.text), allocation.chars);
}

/**
 * An item's value at `chars`, normalized so it reaches exactly its weight at its own cap.
 *
 * `floor` and `cap` are the item's own limits, clamped to the text it actually has, so a short message is
 * worth its full weight at its full length rather than being penalized for being short.
 */
function curveRatio(curve: WindowCurve, chars: number, floor: number, cap: number): number {
    if (chars <= 0) {
        return 0;
    }
    if (cap <= floor || chars >= cap) {
        return 1;
    }

    if (curve.kind === "twoSegment" && chars <= floor) {
        return curve.headShare * (chars / floor);
    }

    const ratio = Math.log(1 + chars / floor) / Math.log(1 + cap / floor);
    if (curve.kind === "log" || chars <= floor) {
        return ratio;
    }

    return curve.headShare + (1 - curve.headShare) * ((chars - floor) / (cap - floor));
}

// --------------------------------------------------------------------------- #
// preparation
// --------------------------------------------------------------------------- #

function prepare(items: readonly DecisionRecentMessage[], policy: WindowPolicy): Atom[] {
    return items.map((item, index) => {
        const kind = kindOf(item.role);
        const text = collapse(item.text);
        const floor =
            kind === "marker"
                ? text.length
                : kind === "tool"
                  ? policy.floors.tool
                  : policy.floors.message;
        const cap =
            kind === "marker"
                ? text.length
                : kind === "tool"
                  ? policy.caps.tool
                  : policy.caps.message;

        return {
            item,
            index,
            kind,
            turn: item.turn ?? 0,
            text,
            floor: Math.min(floor, text.length),
            cap: Math.min(cap, text.length),
            required: false,
            weight: 0,
            floorUnits: 0,
            capUnits: 0,
            paidUnits: 0,
        };
    });
}

/** Keep the newest `count` atoms, leaving the list in its original order. */
function newest(atoms: readonly Atom[], count: number): Atom[] {
    if (count >= atoms.length) {
        return [...atoms];
    }

    return atoms
        .toSorted((left, right) => left.index - right.index)
        .slice(Math.max(0, atoms.length - count));
}

/**
 * Draw on the newest `keepTurns` turns in full and let older turns contribute messages only.
 *
 * This is the tier-1 transcript's rule and the reason a long session does not drown the budget in markers:
 * without it, every state change in the branch is a candidate item.
 */
function applyTurnSpan(atoms: readonly Atom[], keepTurns: number): Atom[] {
    if (keepTurns <= 0) {
        return [...atoms];
    }

    const newestTurn = atoms.reduce((max, atom) => Math.max(max, atom.turn), 0);
    return atoms.filter(
        (atom) =>
            atom.turn === newestTurn ||
            (atom.kind !== "tool" && atom.turn > newestTurn - keepTurns),
    );
}

/** Enforce the per-turn item caps before the budget is considered, so one long turn cannot flood the pool. */
function capPerTurn(atoms: readonly Atom[], policy: WindowPolicy): Atom[] {
    const byTurn = new Map<number, Atom[]>();
    for (const atom of atoms) {
        const group = byTurn.get(atom.turn);
        if (group === undefined) {
            byTurn.set(atom.turn, [atom]);
            continue;
        }

        group.push(atom);
    }

    const kept: Atom[] = [];
    for (const group of byTurn.values()) {
        kept.push(
            ...newest(
                group.filter((atom) => atom.kind !== "tool"),
                policy.perTurn.messages,
            ),
            ...newest(
                group.filter((atom) => atom.kind === "tool"),
                policy.perTurn.tools,
            ),
        );
    }

    return kept.toSorted((left, right) => left.index - right.index);
}

/** The newest `mustKeep` items of each kind, whichever turn they came from. */
function mustKeepIndexes(atoms: readonly Atom[], policy: WindowPolicy): Set<number> {
    const wanted: readonly { kind: WindowItemKind; count: number }[] = [
        { kind: "user", count: policy.mustKeep.user },
        { kind: "assistant", count: policy.mustKeep.assistant },
        { kind: "tool", count: policy.mustKeep.tools },
    ];
    const kept = new Set<number>();

    for (const { kind, count } of wanted) {
        let taken = 0;
        for (let index = atoms.length - 1; index >= 0 && taken < count; index -= 1) {
            const atom = atoms[index];
            if (atom === undefined || atom.kind !== kind) {
                continue;
            }

            kept.add(atom.index);
            taken += 1;
        }
    }

    return kept;
}

/**
 * Assign every atom its weight and its allocation domain.
 *
 * The weight is the kind's weight, decayed by how many turns behind the newest turn it is, then decayed again
 * by how many items of the same kind already appear in its own turn — that second decay is the diminishing
 * return that stops a turn's fifth near-identical tool line from out-bidding another turn's message.
 */
function assignWeights(atoms: readonly Atom[], policy: WindowPolicy, bucket: number): Atom[] {
    const newestTurn = atoms.reduce((max, atom) => Math.max(max, atom.turn), 0);
    const rankByKind = new Map<string, number>();
    const ordered = [...atoms].toSorted(
        (left, right) => right.turn - left.turn || right.index - left.index,
    );

    for (const atom of ordered) {
        const key = `${String(atom.turn)}:${atom.kind}`;
        const rank = rankByKind.get(key) ?? 0;
        rankByKind.set(key, rank + 1);

        const base = atom.kind === "marker" ? policy.markerWeight : policy.weights[atom.kind];
        atom.weight =
            base * policy.recencyDecay ** (newestTurn - atom.turn) * policy.saturation ** rank;
        atom.floorUnits = Math.max(1, Math.ceil(atom.floor / bucket));
        atom.capUnits = Math.max(atom.floorUnits, Math.floor(atom.cap / bucket));
        atom.paidUnits = 0;
    }

    return ordered.toSorted((left, right) => left.index - right.index);
}

// --------------------------------------------------------------------------- #
// knapsack
// --------------------------------------------------------------------------- #

/** One item's value at an absolute allocation of `units`. */
function atomValue(atom: Atom, units: number, curve: WindowCurve, bucket: number): number {
    const floorChars = atom.floorUnits * bucket;
    const capChars = Math.max(atom.capUnits * bucket, floorChars);

    return (
        atom.weight * curveRatio(curve, units * bucket, Math.min(atom.floor, floorChars), capChars)
    );
}

/** The best allocation of one turn's items per budget, with the choice per item kept for the backtrack. */
function turnKnapsack(
    atoms: readonly Atom[],
    units: number,
    curve: WindowCurve,
    bucket: number,
): { value: Float64Array; picks: Uint16Array[] } {
    let table = new Float64Array(units + 1);
    const picks: Uint16Array[] = [];

    for (const atom of atoms) {
        const previous = table;
        const next = new Float64Array(previous);
        const pick = new Uint16Array(units + 1);

        for (let budget = 0; budget <= units; budget += 1) {
            // A required item has no skip option, so an unaffordable turn still keeps its must-keeps at floor.
            let bestValue = atom.required ? Number.NEGATIVE_INFINITY : (previous[budget] ?? 0);
            let bestUnits = 0;

            for (let candidate = atom.floorUnits; candidate <= atom.capUnits; candidate += 1) {
                const cost = candidate - atom.paidUnits;
                if (cost > budget) {
                    break;
                }

                const value =
                    (previous[budget - cost] ?? 0) + atomValue(atom, candidate, curve, bucket);
                if (value > bestValue) {
                    bestValue = value;
                    bestUnits = candidate;
                }
            }

            next[budget] =
                bestValue === Number.NEGATIVE_INFINITY ? (previous[budget] ?? 0) : bestValue;
            pick[budget] = bestUnits;
        }

        picks.push(pick);
        table = next;
    }

    return { value: table, picks };
}

/** Split the budget across turns: the multiple-choice stage, one choice (chars) per turn. */
function combineTurns(
    curves: readonly Float64Array[],
    units: number,
): { total: number; perTurn: number[] } {
    let accumulated = new Float64Array(units + 1);
    const choices: Uint16Array[] = [];

    for (const curve of curves) {
        const next = new Float64Array(units + 1);
        const choice = new Uint16Array(units + 1);

        for (let budget = 0; budget <= units; budget += 1) {
            let best = Number.NEGATIVE_INFINITY;
            let bestUnits = 0;

            for (let take = 0; take <= budget; take += 1) {
                const value = (accumulated[budget - take] ?? 0) + (curve[take] ?? 0);
                if (value > best) {
                    best = value;
                    bestUnits = take;
                }
            }

            next[budget] = best;
            choice[budget] = bestUnits;
        }

        choices.push(choice);
        accumulated = next;
    }

    const perTurn = new Array<number>(curves.length).fill(0);
    let remaining = units;
    for (let turn = curves.length - 1; turn >= 0; turn -= 1) {
        const choice = choices[turn];
        if (choice === undefined) {
            continue;
        }

        const take = choice[remaining] ?? 0;
        perTurn[turn] = take;
        remaining -= take;
    }

    return { total: accumulated[units] ?? 0, perTurn };
}

// --------------------------------------------------------------------------- #
// selection
// --------------------------------------------------------------------------- #

/** Render the kept lines with the policy's omission style. */
function assemble(
    atoms: readonly Atom[],
    allocation: ReadonlyMap<number, number>,
    omitted: number,
    policy: WindowPolicy,
): string[] {
    const lines: string[] = [];
    if (policy.omissions === "leading" && omitted > 0) {
        lines.push(`… ${String(omitted)} earlier item${omitted === 1 ? "" : "s"} omitted …`);
    }

    let gap = 0;
    for (const atom of atoms) {
        const chars = allocation.get(atom.index);
        if (chars === undefined) {
            gap += atom.kind === "marker" ? 0 : 1;
            continue;
        }

        if (policy.omissions === "inline" && gap > 0) {
            lines.push(`  … ${String(gap)} item${gap === 1 ? "" : "s"} omitted …`);
        }
        gap = 0;
        lines.push(renderLine(atom.item, chars));
    }

    if (policy.omissions === "inline" && gap > 0) {
        lines.push(`  … ${String(gap)} item${gap === 1 ? "" : "s"} omitted …`);
    }

    return lines;
}

/**
 * Drop the oldest forced markers until the required floors fit the budget.
 *
 * A forced marker is never trimmed and never dropped for value, so a branch with more accepted states than
 * the budget can hold has to give up its oldest ones. Must-keeps are not touched: a policy that cannot afford
 * its required messages is a misconfiguration, not a reason to lose the request.
 */
function fitForcedMarkers(chosen: readonly Atom[], bucket: number, budget: number): Atom[] {
    const required = (atoms: readonly Atom[]): number =>
        atoms.reduce(
            (total, atom) => (atom.required ? total + atom.floorUnits * bucket : total),
            0,
        );
    if (required(chosen) <= budget) {
        return [...chosen];
    }

    const dropped = new Set<number>();
    const forcedMarkers = chosen
        .filter((atom) => atom.kind === "marker" && atom.required)
        .toSorted((left, right) => right.index - left.index);

    for (const marker of forcedMarkers) {
        if (required(chosen.filter((atom) => !dropped.has(atom.index))) <= budget) {
            break;
        }

        dropped.add(marker.index);
    }

    return chosen.filter((atom) => !dropped.has(atom.index));
}

/**
 * Allocate `policy.budget` across `items` and render the result.
 *
 * The stages are: prepare and weight the items, draw the turn span, take the markers and the must-keeps out of
 * the optimization, run one knapsack per turn, split the budget across turns, then backtrack to per-item
 * chars. The output is deterministic for the same items and policy.
 */
export function selectWindow(
    items: readonly DecisionRecentMessage[],
    policy: WindowPolicy = DEFAULT_WINDOW_POLICY,
): WindowSelection {
    const bucket = Math.max(1, policy.bucket);
    const prepared = prepare(items, policy);
    const spanned = applyTurnSpan(prepared, policy.keepTurns);
    const markerAtoms =
        policy.markers === "drop" ? [] : spanned.filter((atom) => atom.kind === "marker");
    const content = capPerTurn(
        spanned.filter((atom) => atom.kind !== "marker"),
        policy,
    );
    const must = mustKeepIndexes(content, policy);
    const chosen = fitForcedMarkers(
        assignWeights(
            [...content, ...markerAtoms].map((atom) => ({
                ...atom,
                required:
                    atom.kind === "marker" ? policy.markers === "forced" : must.has(atom.index),
            })),
            policy,
            bucket,
        ),
        bucket,
        policy.budget,
    );
    for (const atom of chosen) {
        atom.paidUnits = atom.required ? atom.floorUnits : 0;
    }

    const floorChars = chosen
        .filter((atom) => atom.required)
        .reduce((total, atom) => total + atom.floorUnits * bucket, 0);
    const units = Math.max(0, Math.floor((policy.budget - floorChars) / bucket));

    const turnOrder = [...new Set(chosen.map((atom) => atom.turn))].toSorted(
        (left, right) => left - right,
    );
    const turnAtoms = turnOrder.map((turn) => chosen.filter((atom) => atom.turn === turn));
    const turnDps = turnAtoms.map((atoms) => turnKnapsack(atoms, units, policy.curve, bucket));
    const combined = combineTurns(
        turnDps.map((dp) => dp.value),
        units,
    );

    const allocation = new Map<number, number>();
    const turns: WindowTurnReport[] = [];
    let spent = 0;
    let value = 0;
    for (const [position, atoms] of turnAtoms.entries()) {
        const dp = turnDps[position];
        if (dp === undefined) {
            continue;
        }

        let remaining = combined.perTurn[position] ?? 0;
        let turnChars = 0;
        for (let index = atoms.length - 1; index >= 0; index -= 1) {
            const atom = atoms[index];
            const pick = dp.picks[index];
            if (atom === undefined || pick === undefined) {
                continue;
            }

            const candidate = pick[remaining] ?? 0;
            if (candidate === 0) {
                continue;
            }

            const chars = candidate * bucket;
            allocation.set(atom.index, chars);
            value += atomValue(atom, candidate, policy.curve, bucket);
            turnChars += chars;
            remaining -= candidate - atom.paidUnits;
        }

        spent += turnChars;
        turns.push({
            turn: turnOrder[position] ?? 0,
            chars: turnChars,
            value: dp.value[combined.perTurn[position] ?? 0] ?? 0,
        });
    }

    const kept: WindowAllocation[] = [];
    for (const atom of chosen.toSorted((left, right) => left.index - right.index)) {
        const chars = allocation.get(atom.index);
        if (chars === undefined) {
            continue;
        }

        kept.push({
            item: atom.item,
            chars,
            line: renderLine(atom.item, chars),
            forced: atom.required,
        });
    }

    const droppedContent = prepared.filter((atom) => atom.kind !== "marker").length;
    const keptContent = kept.filter((entry) => entry.item.role !== MARKER_ROLE).length;

    return {
        lines: assemble(prepared, allocation, droppedContent - keptContent, policy),
        kept,
        omitted: droppedContent - keptContent,
        value,
        chars: spent,
        turns,
    };
}
