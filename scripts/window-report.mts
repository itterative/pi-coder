#!/usr/bin/env node
/**
 * Print the window allocator's view of a recorded session, turn by turn.
 *
 * At every user prompt the report rebuilds the branch prefix the live consult would read, allocates it through
 * `selectWindow`, and prints the rendered window plus what the budget bought: chars spent, items kept, items
 * dropped, and the per-turn spread. Reading a session through the allocator is the same view the model gets -
 * priced, clipped, and bounded - so a long transcript stays readable instead of arriving at full length.
 *
 * The default policy is `reminder` (`WINDOW_POLICY_REMINDER`), the production tier-2 window, so a plain run
 * shows what the module actually sends. Any named policy can be selected and the two knobs that are usually
 * varied - `budget` and `keepTurns` - can be overridden without editing a policy.
 *
 * A turn here is the branch's own stamp: a user message starts one unless it was submitted while the previous
 * run was still streaming (a steer), which joins the turn it was delivered into. Steered prompts are still
 * reported, because they change the branch, but labeled `(steer)` so the numbering stays the module's. A prompt
 * with no text adds no atom and was never in a window, so it is not reported at all.
 *
 * The budget is on text chars; role prefixes (`User: `) and omission lines are extra, so the printed window can
 * be longer than the char count. A window whose required floors do not fit can also exceed the budget.
 *
 * With no session file the report reads the session `pi --continue` would resume for the current working
 * directory - the newest transcript pi recorded for it. Discovery goes through `SessionManager.continueRecent`,
 * so it follows the same rule the resume path does, including the per-cwd session directory pi creates on first
 * use. A directory pi has never recorded a session in is an error, not an empty report.
 *
 * `--mid-run` adds the tier-2 consults the live module made *inside* a run: every `pi-coder-reminder:debug`
 * record whose trigger is `mid-run`, allocated from the branch prefix ending at that record. That prefix holds
 * the turn's own work - the assistant message with its tool calls, and any results after it - which a turn
 * boundary does not. One crossing can be re-recorded many times without the branch changing; records that share
 * a state collapse into one window that prints how many decisions it stands for. A session recorded without
 * debug entries has none.
 *
 * Usage:
 *   npm run window-report -- [<session.jsonl...>] [options]
 *
 *   <session.jsonl>   recorded session file to replay; repeat it to scan several transcripts in one run
 *                    (default: the session `pi --continue` would resume for the current directory)
 *   --turns a,b       only these turns (default: every turn)
 *   --policy <name>   plan | reminder | conversation | transcript (default: reminder, the production policy)
 *   --budget <n>      override the policy's char budget
 *   --keep <n>        override keepTurns (turns drawn on in full; 0 means no span limit)
 *   --compact         one line per turn instead of the rendered window
 *   --help            this message
 *
 * This file is `.mts` because the root package is not `"type": "module"`: under `node --import tsx` a `.ts`
 * script here is CommonJS, and the pi package is ESM-only.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { decisionSessionContext } from "../src/modules/decision/session-context";
import {
    selectWindow,
    WINDOW_POLICY_CONVERSATION,
    WINDOW_POLICY_PLAN,
    WINDOW_POLICY_REMINDER,
    WINDOW_POLICY_TRANSCRIPT,
    type WindowPolicy,
    type WindowSelection,
} from "../src/modules/decision/window";
import {
    REMINDER_DEBUG_ENTRY_TYPE,
    reminderStateMarker,
} from "../src/modules/reminders/session-signals";

const USAGE = `usage: npm run window-report -- [<session.jsonl...>] [options]

  <session.jsonl>   recorded session file to replay; repeat it to scan several transcripts
                    (default: the session \`pi --continue\` would resume for the current directory)
  --turns a,b       only these turns (default: every turn)
  --policy <name>   plan | reminder | conversation | transcript (default: reminder)
  --budget <n>      override the policy's char budget
  --keep <n>        override keepTurns (0 means no span limit)
  --compact         one line per turn instead of the rendered window
  --mid-run         also report the recorded mid-run (mid-turn) consults
  --help            this message`;

/** The named policies, by the flag value that selects them. */
export const POLICIES: Readonly<Record<string, WindowPolicy>> = {
    plan: WINDOW_POLICY_PLAN,
    reminder: WINDOW_POLICY_REMINDER,
    conversation: WINDOW_POLICY_CONVERSATION,
    transcript: WINDOW_POLICY_TRANSCRIPT,
};

/** The production tier-2 policy, so a plain run shows what the consult actually sends. */
export const DEFAULT_POLICY = "reminder";

export interface Options {
    files: string[];
    turns: ReadonlySet<number>;
    policy: string;
    budget: number | undefined;
    keepTurns: number | undefined;
    compact: boolean;
    midRun: boolean;
    help: boolean;
}

export function parseArgs(argv: readonly string[]): Options {
    const files: string[] = [];
    const turns = new Set<number>();
    const options: Options = {
        files,
        turns,
        policy: DEFAULT_POLICY,
        budget: undefined,
        keepTurns: undefined,
        compact: false,
        midRun: false,
        help: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === undefined) {
            continue;
        }

        if (arg === "-h" || arg === "--help") {
            options.help = true;
            continue;
        }
        if (arg === "--compact") {
            options.compact = true;
            continue;
        }
        if (arg === "--mid-run" || arg === "--midturn") {
            options.midRun = true;
            continue;
        }
        if (!arg.startsWith("-")) {
            files.push(arg);
            continue;
        }

        const flag = arg;
        const value = (): string => {
            index += 1;
            const next = argv[index];
            if (next === undefined) {
                throw new Error(`${flag} needs a value\n\n${USAGE}`);
            }
            return next;
        };

        if (flag === "--policy") {
            const name = value();
            if (POLICIES[name] === undefined) {
                throw new Error(unknownPolicy(name));
            }
            options.policy = name;
        } else if (flag === "--budget") {
            options.budget = integerAtLeast(flag, value(), 1);
        } else if (flag === "--keep") {
            options.keepTurns = integerAtLeast(flag, value(), 0);
        } else if (flag === "--turns") {
            for (const turn of turnList(value())) {
                turns.add(turn);
            }
        } else {
            throw new Error(`unknown flag ${flag}\n\n${USAGE}`);
        }
    }

    return options;
}

/** The policy a run uses: the named one, with the two allocation knobs the flags override. */
export function resolvePolicy(
    name: string,
    budget: number | undefined,
    keepTurns: number | undefined,
): WindowPolicy {
    const base = POLICIES[name];
    if (base === undefined) {
        throw new Error(unknownPolicy(name));
    }

    return {
        ...base,
        ...(budget === undefined ? {} : { budget }),
        ...(keepTurns === undefined ? {} : { keepTurns }),
    };
}

function unknownPolicy(name: string): string {
    return `unknown policy ${JSON.stringify(name)}; expected ${Object.keys(POLICIES).join(" | ")}`;
}

function integerAtLeast(flag: string, raw: string, minimum: number): number {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < minimum) {
        throw new Error(
            `${flag} needs an integer of at least ${String(minimum)}, got ${JSON.stringify(raw)}`,
        );
    }

    return value;
}

function turnList(raw: string): number[] {
    return raw.split(",").map((part) => integerAtLeast("--turns", part.trim(), 1));
}

/** One user prompt's window, as the allocator built it from the branch prefix before that prompt. */
/** One allocator window at a point where the reminder module consults. */
export interface WindowPoint {
    /** `turn` is a user prompt's boundary; `mid-run` is a recorded threshold consult inside a run. */
    kind: "turn" | "mid-run";
    turn: number;
    /** A prompt submitted while the previous run was streaming; it shares the turn it joined. */
    steer: boolean;
    /** Mid-run points: the first debug record's entry id, the point's identity in the session. */
    entry?: string;
    /** Decisions that shared this state - a declined crossing can be re-asked without the branch changing. */
    records: number;
    /** Atoms the allocator priced, before any of them were clipped. */
    items: number;
    selection: WindowSelection;
}

/** Whether an entry can add a window item: the unit of state a repeated mid-run record does not change. */
function affectsItems(entry: SessionEntry): boolean {
    if (entry.type === "message") {
        return entry.message.role === "user" || entry.message.role === "assistant";
    }

    return reminderStateMarker(entry) !== undefined;
}

/** A tier-2 mid-run record: the live module's own decision point inside a run. */
function isMidRunRecord(entry: SessionEntry): boolean {
    if (entry.type !== "custom" || entry.customType !== REMINDER_DEBUG_ENTRY_TYPE) {
        return false;
    }

    const data: unknown = entry.data;

    return (
        typeof data === "object" && data !== null && "trigger" in data && data.trigger === "mid-run"
    );
}

/** The branch prefix through `index`, and the prompt its items belong to. */
function contextAt(entries: readonly SessionEntry[], index: number) {
    const context = decisionSessionContext(entries.slice(0, index + 1), {
        stateMarker: reminderStateMarker,
    });

    return {
        context,
        request: context.items.findLast((item) => item.role === "user"),
    };
}

/**
 * Allocate the branch prefix at each point the reminder module consults.
 *
 * A turn boundary's prefix ends *after* the prompt, which is the state the live consult reads: pi persists the
 * user message before `before_agent_start` runs for a normal turn. A mid-run point's prefix ends at the recorded
 * decision entry, so it carries the run's own assistant and tool entries. The turn label is the prompt's own
 * stamp from `decisionSessionContext`, not a count of user messages, so a steer and the mid-run points inside its
 * run share the turn number instead of shifting every later turn.
 *
 * `midRun` includes the recorded mid-run points. Records whose last item-changing entry is the same describe one
 * state - the module re-asks a declined crossing while the branch is unchanged - and collapse into one window
 * with `records` counting them, so a streamed run does not print hundreds of identical windows.
 */
export function readTurns(
    entries: readonly SessionEntry[],
    policy: WindowPolicy,
    wanted: ReadonlySet<number> = new Set<number>(),
    midRun = false,
): WindowPoint[] {
    const points: WindowPoint[] = [];
    let previousTurn = 0;
    let version = 0;
    let midRunVersion = -1;
    let lastMidRun: WindowPoint | undefined;

    for (const [index, entry] of entries.entries()) {
        if (affectsItems(entry)) {
            version += 1;
        }

        if (midRun && isMidRunRecord(entry)) {
            if (midRunVersion === version) {
                if (lastMidRun !== undefined) {
                    lastMidRun.records += 1;
                }
                continue;
            }

            midRunVersion = version;
            lastMidRun = undefined;

            const { context, request } = contextAt(entries, index);
            if (request === undefined) {
                continue;
            }

            const turn = request.turn ?? 0;
            if (wanted.size > 0 && !wanted.has(turn)) {
                continue;
            }

            lastMidRun = {
                kind: "mid-run",
                turn,
                steer: false,
                entry: entry.id,
                records: 1,
                items: context.items.length,
                selection: selectWindow(context.items, policy),
            };
            points.push(lastMidRun);
            continue;
        }

        if (entry.type !== "message" || entry.message.role !== "user") {
            continue;
        }

        const { context, request } = contextAt(entries, index);
        // A prompt with no text adds no item, so the branch the allocator reads did not change here.
        if (request === undefined || context.items.at(-1) !== request) {
            continue;
        }

        const turn = request.turn ?? 0;
        if (wanted.size > 0 && !wanted.has(turn)) {
            continue;
        }

        points.push({
            kind: "turn",
            turn,
            steer: turn === previousTurn,
            records: 1,
            items: context.items.length,
            selection: selectWindow(context.items, policy),
        });
        previousTurn = turn;
    }

    return points;
}

/** One session's points and the policy they were read under. */
export interface SessionReport {
    file: string;
    cwd: string;
    policyName: string;
    policy: WindowPolicy;
    /** Whether mid-run points were requested, so a zero still shows the mode was on. */
    midRun: boolean;
    windows: readonly WindowPoint[];
}

/** `1 turn` / `2 turns`, so the header does not read "1 turns". */
function plural(count: number, word: string): string {
    return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

export function renderSession(report: SessionReport, compact: boolean): string {
    const { policy } = report;
    const midRun = report.windows.filter((window) => window.kind === "mid-run").length;
    const turns = report.windows.length - midRun;
    const scope = report.midRun
        ? `reported: ${plural(turns, "turn")} + ${String(midRun)} mid-run`
        : `reported: ${plural(turns, "turn")}`;
    const lines = [
        `session: ${report.file}`,
        `cwd: ${report.cwd}   ${scope}   ` +
            `policy: ${report.policyName}   budget: ${String(policy.budget)}   ` +
            `keepTurns: ${String(policy.keepTurns)}`,
    ];

    for (const window of report.windows) {
        lines.push("");
        lines.push(...renderPoint(window, policy, compact));
    }

    return lines.join("\n");
}

/** The label that says which turn, and which point inside it, a window belongs to. */
function pointLabel(point: WindowPoint): string {
    if (point.kind === "mid-run") {
        const records = point.records > 1 ? `, ${String(point.records)} records` : "";
        return `turn ${String(point.turn)} mid-run (entry ${point.entry ?? "?"}${records})`;
    }

    return point.steer ? `turn ${String(point.turn)} (steer)` : `turn ${String(point.turn)}`;
}

function renderPoint(point: WindowPoint, policy: WindowPolicy, compact: boolean): string[] {
    const { selection } = point;
    const label = pointLabel(point);
    const stats =
        `window: ${String(selection.chars)}/${String(policy.budget)} chars, ` +
        `${String(selection.kept.length)}/${String(point.items)} items, ` +
        `${String(selection.omitted)} dropped, value ${selection.value.toFixed(2)}`;

    if (compact) {
        return [`${label}  ${stats}`];
    }

    const lines = [`===== ${label} =====`, stats];
    const spread = renderSpread(selection);
    if (spread !== undefined) {
        lines.push(`spread: ${spread}`);
    }

    lines.push(...selection.lines);
    return lines;
}

/** Which turns the budget reached, plus the count that survived the caps but took nothing. */
function renderSpread(selection: WindowSelection): string | undefined {
    const allocated = selection.turns.filter((turn) => turn.chars > 0);
    if (allocated.length === 0) {
        return undefined;
    }

    const spread = allocated
        .map((turn) => `t${String(turn.turn)} ${String(turn.chars)}c`)
        .join("  ");
    const idle = selection.turns.length - allocated.length;

    return idle === 0 ? spread : `${spread}   (${String(idle)} took nothing)`;
}

/** The file to report and the manager already holding its branch. */
interface Target {
    file: string;
    session: SessionManager;
}

/**
 * The session `pi --continue` would resume for `cwd`.
 *
 * `SessionManager.continueRecent` is the public discovery path, so the report cannot drift from pi's resume
 * rule: newest session in the cwd's session directory, filtered to the cwd recorded in the session header. The
 * directory pi derives is created on first use, exactly as a pi run in that cwd would create it; `sessionDir`
 * is for a caller that owns another root (tests), and the CLI leaves it out.
 */
export function latestSession(cwd: string, sessionDir?: string): Target | undefined {
    const session = SessionManager.continueRecent(cwd, sessionDir);
    const file = session.getSessionFile();
    // A manager with no file to resume reserves a path for the session it would start; the file itself only
    // appears at the first prompt, so existence on disk is what separates a recorded session from a reserved one.
    if (file === undefined || !fs.existsSync(file)) {
        return undefined;
    }

    return { file, session };
}

function defaultTarget(): Target {
    const target = latestSession(process.cwd());
    if (target === undefined) {
        throw new Error(
            `no session recorded for ${process.cwd()}; pass a session file or run from a directory pi has used`,
        );
    }

    return target;
}

function fileTarget(name: string): Target {
    const file = path.resolve(name);
    if (!fs.existsSync(file)) {
        throw new Error(`session file not found: ${file}`);
    }

    return { file, session: SessionManager.open(file) };
}

function main(): void {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(`${USAGE}\n`);
        return;
    }

    const policy = resolvePolicy(options.policy, options.budget, options.keepTurns);
    const targets = options.files.length > 0 ? options.files.map(fileTarget) : [defaultTarget()];
    let turnsReported = 0;
    let midRunReported = 0;
    let first = true;

    for (const { file, session } of targets) {
        const windows = readTurns(session.getBranch(), policy, options.turns, options.midRun);
        for (const point of windows) {
            if (point.kind === "mid-run") {
                midRunReported += 1;
            } else {
                turnsReported += 1;
            }
        }

        const report: SessionReport = {
            file,
            cwd: session.getCwd(),
            policyName: options.policy,
            policy,
            midRun: options.midRun,
            windows,
        };
        process.stdout.write(`${first ? "" : "\n"}${renderSession(report, options.compact)}\n`);
        first = false;
    }

    process.stderr.write(
        `window-report: ${String(targets.length)} session(s), ` +
            `${String(turnsReported)} turn(s), ${String(midRunReported)} mid-run window(s), ` +
            `policy ${options.policy}, budget ${String(policy.budget)}, ` +
            `keepTurns ${String(policy.keepTurns)}\n`,
    );
}

/** Whether this file is the program being run, rather than a module a test imported. */
function isDirectRun(): boolean {
    const invoked = process.argv[1];
    if (invoked === undefined) {
        return false;
    }

    try {
        return fs.realpathSync(invoked) === fs.realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isDirectRun()) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
