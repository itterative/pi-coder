#!/usr/bin/env node
/**
 * Read the decision model's verdicts out of the bash permission decision log written by
 * `src/modules/sandbox/decision-log.ts`.
 *
 * Every record with a `classifier` field is an access that no rule and no heuristic resolved, which is exactly
 * the population the model is asked about. The report answers the questions that decide `apply` and
 * `minConfidence`: what the model said, whether it was allowed to act on it, and what the human did when it was
 * not.
 *
 * One log carries two gates: Bash commands (`gate` absent or `"bash"`) and direct file accesses outside every
 * trusted root (`gate: "file"`). The command-shaped sections — script bodies and per-file scores — read only the
 * Bash rows, because a file access has no script facts and would silently dilute them. Everything else, including
 * the rows and the criteria histogram, covers both, since "did the verdict resolve it" means the same thing for
 * either. Use `--subject` to look at one gate alone.
 *
 * Usage:
 *   npm run decision-report -- [options]
 *
 *   --path <file>      log file (default: $SANDBOX_DECISION_LOG_PATH or the extension's
 *                      .state/bash-log.jsonl; every retained generation is read, oldest first)
 *   --since <dur>      only records newer than this age, e.g. 90m, 24h, 7d
 *   --criterion <id>   only records whose model verdict named this criterion (none, destructive,
 *                      privileged, exfiltration, remote_code, loses_content, out_of_scope, asked_for,
 *                      routine, unrelated)
 *   --subject <gate>   only records from one gate: `bash` or `file`
 *   --applied          only records where the verdict resolved the prompt
 *   --prompted         only records where a human was still asked
 *   --limit <n>        rows per section (default 25, newest kept)
 *   --json             machine-readable aggregates and rows, in log order
 *   --help             this message
 *
 * Text sections print newest first.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createJsonlRecordLog, discoverGenerations } from "../src/common/record-log";
import type {
    BashClassifierRecord,
    DecisionLogRecord,
    DecisionSubject,
} from "../src/modules/sandbox/decision-log";

// ---------------------------------------------------------------- arg parsing

const USAGE = `usage: npm run decision-report -- [options]\n${describeOptions()}`;

function describeOptions(): string {
    return [
        "  --path <file>      log file (default $SANDBOX_DECISION_LOG_PATH or .state/bash-log.jsonl)",
        "  --since <dur>      only newer than 90m | 24h | 7d",
        "  --criterion <id>   only this criterion (none, destructive, privileged, ...)",
        "  --applied          only verdicts that resolved the prompt",
        "  --prompted         only records where a human was asked",
        "  --subject <gate>     only this gate's records (bash, file)",
        "  --script           only consults with a script fact (body or kind)",
        "  --limit <n>        rows per section (default 25)",
        "  --json             machine-readable aggregates",
        "  --help             this message",
    ].join("\n");
}

export interface Options {
    path: string | undefined;
    since: string | undefined;
    criterion: string | undefined;
    subject: DecisionSubject | undefined;
    applied: boolean;
    prompted: boolean;
    script: boolean;
    limit: number;
    json: boolean;
    help: boolean;
}

export function parseArgs(argv: string[]): Options {
    const options: Options = {
        path: undefined,
        since: undefined,
        criterion: undefined,
        subject: undefined,
        applied: false,
        prompted: false,
        script: false,
        limit: 25,
        json: false,
        help: false,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = (): string | undefined => {
            i += 1;
            return argv[i];
        };

        if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else if (arg === "--applied") {
            options.applied = true;
        } else if (arg === "--prompted") {
            options.prompted = true;
        } else if (arg === "--script") {
            options.script = true;
        } else if (arg === "--json") {
            options.json = true;
        } else if (arg === "--path") {
            options.path = next();
        } else if (arg === "--since") {
            options.since = next();
        } else if (arg === "--criterion") {
            options.criterion = next();
        } else if (arg === "--subject") {
            options.subject = parseSubject(next());
        } else if (arg === "--limit") {
            const value = Number.parseInt(next() ?? "", 10);
            if (Number.isFinite(value) && value > 0) {
                options.limit = value;
            }
        } else if (arg !== undefined && arg.trim() !== "") {
            throw new Error(`unknown option: ${arg}`);
        }
    }

    return options;
}

/** The gate names as options; a Bash record is the one that carries no `gate`, so `bash` is not a typo for "absent". */
function parseSubject(value: string | undefined): DecisionSubject {
    if (value === "bash" || value === "file") {
        return value;
    }

    throw new Error(`--subject wants \`bash\` or \`file\`, got: ${value ?? "(nothing)"}`);
}

/** `--since` units, keyed by the letter the pattern captures. */
const DURATION_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/** `90m`, `24h`, `7d`, `30s`, `2w` to milliseconds. */
function parseDuration(value: string): number {
    const match = /^(\d+)\s*([smhdw])$/iu.exec(value.trim());
    if (match === null) {
        throw new Error(`could not read duration: ${value} (expected e.g. 90m, 24h, 7d)`);
    }

    const unitSeconds = DURATION_UNITS[match[2].toLowerCase()];
    if (unitSeconds === undefined) {
        throw new Error(`could not read duration unit: ${match[2]}`);
    }

    return Number.parseInt(match[1], 10) * unitSeconds * 1000;
}

// ------------------------------------------------------------------ log input

/** Treat an unset or blank value as absent so the default can apply. */
function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

function defaultLogPath(): string {
    const fromEnv = nonEmpty(process.env.SANDBOX_DECISION_LOG_PATH);
    if (fromEnv !== undefined) {
        return fromEnv;
    }

    // The writer's default: PI_CODER_STATE_DIR, resolved from the extension root so source and compiled
    // layouts agree.
    return path.join(fileURLToPath(new URL("..", import.meta.url)), ".state", "bash-log.jsonl");
}

export interface ConsultedRecord {
    record: DecisionLogRecord;
    classifier: BashClassifierRecord;
    /** which gate wrote the record, and therefore which aggregates it belongs to */
    subject: DecisionSubject;
    /** what the row is about: the command text, or the operation and path */
    target: string;
}

export interface LoadResult {
    consulted: ConsultedRecord[];
    total: number;
    files: string[];
    malformed: number;
}

function subjectOf(record: DecisionLogRecord): DecisionSubject {
    return record.gate === "file" ? "file" : "bash";
}

function targetOf(record: DecisionLogRecord): string {
    return record.gate === "file" ? `${record.operation} ${record.path}` : record.command;
}

export function loadRecords(options: Options): LoadResult {
    const filePath = options.path ?? defaultLogPath();
    const log = createJsonlRecordLog<DecisionLogRecord>({
        filePath,
        // Reporting is not a reason to roll the file being reported on.
        maxBytes: 0,
        generations: discoverGenerations(filePath),
    });
    const files = log.stats().files;
    if (files.length === 0) {
        throw new Error(
            `no decision log found at ${filePath}\n` +
                "the gate writes it automatically; run some commands, or pass --path",
        );
    }

    const cutoff =
        options.since === undefined ? undefined : Date.now() - parseDuration(options.since);
    const consulted: ConsultedRecord[] = [];
    let total = 0;

    for (const record of log.read({ since: cutoff })) {
        if (record === null || typeof record !== "object") {
            continue;
        }

        total += 1;

        const classifier = record.classifier;
        if (typeof classifier !== "object" || classifier === null) {
            continue;
        }

        if (options.criterion !== undefined && classifier.criterion !== options.criterion) {
            continue;
        }
        if (options.subject !== undefined && subjectOf(record) !== options.subject) {
            continue;
        }
        if (options.applied && classifier.applied !== true) {
            continue;
        }
        if (options.prompted && record.prompt === undefined) {
            continue;
        }
        if (options.script && classifier.script === undefined) {
            continue;
        }

        consulted.push({
            record,
            classifier,
            subject: subjectOf(record),
            target: targetOf(record),
        });
    }

    return { consulted, total, files, malformed: log.stats().malformed };
}

// --------------------------------------------------------------- aggregation

function percent(value: number | undefined): string {
    return value === undefined ? "  -" : `${Math.round(value * 100)}%`.padStart(4);
}

/** `body package×2 6.2k scripts/scratch.ts` — the evidence sent, so a row's score can be read against it. */
function bodyTag(classifier: BashClassifierRecord): string {
    const script = classifier.script;
    if (script === undefined) {
        return "body -";
    }

    const count = script.sources?.length ?? 0;
    const size = script.chars === undefined ? "" : ` ${compactSize(script.chars)}`;
    const last = script.sources?.at(-1);
    const shown = last !== undefined && last.includes("/") ? ` ${last.split("/").at(-1)}` : "";

    return `body ${script.kind}×${count}${size}${shown}`;
}

function compactSize(chars: number): string {
    return chars < 1000 ? `${chars}c` : `${(chars / 1000).toFixed(1)}k`;
}

function clock(ts: string): string {
    return typeof ts === "string" && ts.length >= 19 ? ts.slice(11, 19) : "?";
}

function oneLine(command: string, limit = 68): string {
    const collapsed = command.replace(/\s+/gu, " ").trim();
    return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

function tally(values: readonly string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const value of values) {
        counts[value] = (counts[value] ?? 0) + 1;
    }

    return counts;
}

/** `"none 7, destructive 1"`, biggest first, ties in first-seen order. */
function histogram(counts: Record<string, number>): string {
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (entries.length === 0) {
        return "-";
    }

    return entries.map(([key, count]) => `${key} ${count}`).join(", ");
}

interface BodySummary {
    consulted: number;
    resolved: number;
    /** mean confidence as a whole percent */
    meanConfidence: number;
}

export interface Summary {
    consulted: number;
    applied: number;
    abstained: number;
    failed: number;
    /** consults per gate, so a file-access spike cannot read as a Bash one */
    bySubject: Record<string, number>;
    /** the file gates alone: they are judged on different criteria and have no script facts at all */
    file: BodySummary;
    byAction: Record<string, number>;
    byCriterion: Record<string, number>;
    byOutcome: Record<string, number>;
    /** what the human did on the rows the model abstained: permission -> count */
    humanDecision: Record<string, number>;
    /** how many abstained rows the human ran sandboxed */
    humanSandboxed: number;
    /** consults that carried a script body, and those that did not: the pair the body is judged by */
    withBody: BodySummary;
    withoutBody: BodySummary;
    byScriptKind: Record<string, number>;
    bodyChars: number;
    maxBodyChars: number;
    meanLatencyMs: number;
    maxLatencyMs: number;
    inputTokens: number;
    outputTokens: number;
}

export function summarize(consulted: readonly ConsultedRecord[]): Summary {
    const applied = consulted.filter(({ classifier }) => classifier.applied === true);
    const failed = consulted.filter(({ classifier }) => isFailed(classifier.status));
    const abstained = consulted.filter(
        ({ classifier }) => classifier.applied !== true && !isFailed(classifier.status),
    );
    const latencies = consulted.map(({ classifier }) => classifier.latencyMs).filter(isNumber);
    const tokens = consulted.map(({ classifier }) => classifier.tokens);
    const prompted = abstained.filter(({ record }) => record.prompt !== undefined);
    // A script *fact* is not a body: `binary` and `inline` carry the kind only, and add nothing to the state.
    // File accesses carry none at all, so the body pair counts Bash rows only — mixing them would read as a
    // drop in "with a script body" every time someone reads a file outside the repo.
    const commands = consulted.filter(({ subject }) => subject === "bash");
    const withBody = commands.filter(
        ({ classifier }) => (classifier.script?.sources?.length ?? 0) > 0,
    );
    const withoutBody = commands.filter(
        ({ classifier }) => (classifier.script?.sources?.length ?? 0) === 0,
    );
    const bodySizes = withBody.map(({ classifier }) => classifier.script?.chars).filter(isNumber);

    const inputTokens = tokens.reduce((sum, entry) => sum + (entry?.input ?? 0), 0);
    const outputTokens = tokens.reduce((sum, entry) => sum + (entry?.output ?? 0), 0);

    return {
        consulted: consulted.length,
        applied: applied.length,
        abstained: abstained.length,
        failed: failed.length,
        bySubject: tally(consulted.map(({ subject }) => subject)),
        file: bodySummary(consulted.filter(({ subject }) => subject === "file")),
        byAction: tally(consulted.map(({ classifier }) => classifier.action ?? "(no answer)")),
        byCriterion: tally(
            consulted.map(({ classifier }) => classifier.criterion ?? "(no answer)"),
        ),
        byOutcome: tally(consulted.map(({ classifier }) => classifier.outcome)),
        humanDecision: tally(
            prompted.map(({ record }) =>
                record.prompt === undefined ? "(unasked)" : record.decision,
            ),
        ),
        // Sandboxing is a Bash outcome; a file access has no such mode and must not read as "direct".
        humanSandboxed: prompted.filter(({ record }) => record.gate !== "file" && record.sandboxed)
            .length,
        withBody: bodySummary(withBody),
        withoutBody: bodySummary(withoutBody),
        byScriptKind: tally(
            commands
                .map(({ classifier }) => classifier.script?.kind ?? "")
                .filter((kind) => kind !== ""),
        ),
        bodyChars: bodySizes.reduce((sum, value) => sum + value, 0),
        maxBodyChars: bodySizes.length === 0 ? 0 : Math.max(...bodySizes),
        meanLatencyMs:
            latencies.length === 0
                ? 0
                : Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
        maxLatencyMs: latencies.length === 0 ? 0 : Math.max(...latencies),
        inputTokens,
        outputTokens,
    };
}

/**
 * One source path and the consults that carried it: the closest thing to a per-file score the log holds.
 *
 * A single consult contributes to every source it sent, so `npm run deploy` counts against both its
 * `package.json` line and the file that line invokes. Per-file character counts are *not* here: the record
 * stores the total sent, not the size of each artifact, so any per-file number would be an invention.
 */
interface ScriptFileSummary {
    source: string;
    consults: number;
    /** newest first, so the newest score reads first */
    confidences: number[];
    newestTs: string;
    newestCommand: string;
}

function scriptFiles(consulted: readonly ConsultedRecord[]): ScriptFileSummary[] {
    const bySource = new Map<string, ScriptFileSummary>();

    for (const { classifier, record, target } of consulted.toReversed()) {
        for (const entry of scriptConfidences(classifier)) {
            // `package.json#deploy` names a script entry, not a file; this section is about files.
            if (!entry.source.includes("/") || entry.source.includes("#")) {
                continue;
            }

            const existing = bySource.get(entry.source) ?? {
                source: entry.source,
                consults: 0,
                confidences: [],
                newestTs: record.ts,
                newestCommand: target,
            };

            existing.consults += 1;
            if (isNumber(entry.confidence)) {
                existing.confidences.push(entry.confidence);
            }
            bySource.set(entry.source, existing);
        }
    }

    // Newest-first insertion order breaks ties, so equally consulted files stay in recency order.
    return [...bySource.values()].toSorted((left, right) => right.consults - left.consults);
}

/**
 * One confidence per file the consult sent.
 *
 * When the log carries per-body answers, each body contributes its own score — the number a per-file column
 * should mean. Older records, written before commands were classified form by form, only have the command's
 * folded confidence, so that is what each of their sources gets.
 */
function scriptConfidences(
    classifier: BashClassifierRecord,
): { source: string; confidence: number | undefined }[] {
    const answers = classifier.script?.answers;
    if (answers !== undefined && answers.length > 0) {
        return answers.map((answer) => ({
            source: answer.source,
            confidence: answer.confidence,
        }));
    }

    return (classifier.script?.sources ?? []).map((source) => ({
        source,
        confidence: classifier.confidence,
    }));
}

function scoreList(values: readonly number[]): string {
    if (values.length === 0) {
        return "-";
    }

    const shown = values.slice(0, 4).map((value) => `${Math.round(value * 100)}%`);

    return values.length > shown.length ? `${shown.join(", ")}…` : shown.join(", ");
}

function isFailed(status: string): boolean {
    return status === "error" || status === "timeout";
}

/** What a body-carrying group scored, so the two groups can be compared without reading every row. */
function bodySummary(rows: readonly ConsultedRecord[]): BodySummary {
    const confidences = rows.map(({ classifier }) => classifier.confidence).filter(isNumber);

    return {
        consulted: rows.length,
        resolved: rows.filter(({ classifier }) => classifier.applied === true).length,
        meanConfidence:
            confidences.length === 0
                ? 0
                : Math.round(
                      (confidences.reduce((sum, value) => sum + value, 0) / confidences.length) *
                          100,
                  ),
    };
}

function isNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

// --------------------------------------------------------------------- output

/** The abstained row, which is the only section whose shape differs by gate: a file access is never sandboxed. */
function abstainedRow(entry: ConsultedRecord): string {
    const { classifier, record } = entry;
    const mode = record.gate === "file" ? "  -   " : record.sandboxed ? "sandbox" : "direct ";

    return (
        `  ${(classifier.criterion ?? "-").padEnd(13)} ${percent(classifier.confidence)} ` +
        `model ${(classifier.action ?? "-").padEnd(8)} human ${record.decision.padEnd(14)} ` +
        `${mode} ${record.prompt?.outcome ?? "-"} ${bodyTag(classifier)}`
    );
}

export function renderText(result: LoadResult, options: Options): string {
    const { consulted } = result;
    const summary = summarize(consulted);
    const lines: string[] = [];
    const newestFirst = consulted.toReversed();

    lines.push(
        `decision model: ${consulted.length} consulted of ${result.total} records ` +
            `in ${result.files.length} file${result.files.length === 1 ? "" : "s"}` +
            (consulted.length > 0
                ? ` — ${clock(consulted[0]?.record.ts ?? "")} to ${clock(newestFirst[0]?.record.ts ?? "")}`
                : ""),
    );
    if (options.since !== undefined) {
        lines.push(`  window: last ${options.since}`);
    }
    if (options.criterion !== undefined) {
        lines.push(`  criterion filter: ${options.criterion}`);
    }
    if (options.subject !== undefined) {
        lines.push(`  subject filter: ${options.subject}`);
    }
    lines.push("");

    lines.push(`  resolved by the model   ${summary.applied}`);
    lines.push(`  abstained               ${summary.abstained}   the human was still asked`);
    lines.push(`  failed                  ${summary.failed}   error or timeout, then cooldown`);
    lines.push(`  subjects                ${histogram(summary.bySubject)}`);
    lines.push(`  criteria named          ${histogram(summary.byCriterion)}`);
    lines.push(`  action                  ${histogram(summary.byAction)}`);
    lines.push(`  outcome                 ${histogram(summary.byOutcome)}`);
    lines.push(
        `  latency                 mean ${summary.meanLatencyMs}ms, max ${summary.maxLatencyMs}ms`,
    );
    lines.push(`  tokens                  ${summary.inputTokens} in, ${summary.outputTokens} out`);
    if (summary.withBody.consulted > 0) {
        lines.push(
            `  with a script body      ${summary.withBody.consulted} consults, mean ` +
                `${summary.withBody.meanConfidence}%, resolved ${summary.withBody.resolved}`,
        );
        lines.push(
            `  without a body          ${summary.withoutBody.consulted} consults, mean ` +
                `${summary.withoutBody.meanConfidence}%, resolved ${summary.withoutBody.resolved}`,
        );
        lines.push(`  script kinds            ${histogram(summary.byScriptKind)}`);
        lines.push(
            `  body size               ${summary.bodyChars} chars sent, max ${summary.maxBodyChars}`,
        );
    }
    if (summary.file.consulted > 0) {
        lines.push(
            `  file accesses           ${summary.file.consulted} consults, mean ` +
                `${summary.file.meanConfidence}%, resolved ${summary.file.resolved}`,
        );
    }
    if (summary.abstained > 0) {
        lines.push(
            `  human on those rows     ${histogram(summary.humanDecision)}` +
                ` (sandboxed ${summary.humanSandboxed})`,
        );
    }
    lines.push("");

    const applied = newestFirst.filter(({ classifier }) => classifier.applied === true);
    const abstained = newestFirst.filter(
        ({ classifier }) => classifier.applied !== true && !isFailed(classifier.status),
    );
    const failed = newestFirst.filter(({ classifier }) => isFailed(classifier.status));

    pushSection(
        lines,
        "RESOLVED BY THE MODEL",
        applied,
        options.limit,
        ({ classifier }) =>
            `  ${classifier.strategy.padEnd(12)} ${(classifier.criterion ?? "-").padEnd(13)} ` +
            `${percent(classifier.confidence)} ${(classifier.action ?? "-").padEnd(8)} ` +
            `${String(classifier.latencyMs).padStart(4)}ms ${bodyTag(classifier)}`,
    );

    pushSection(lines, "ABSTAINED — THE HUMAN DECIDED", abstained, options.limit, (entry) =>
        abstainedRow(entry),
    );

    pushSection(
        lines,
        "FAILED — NO VERDICT",
        failed,
        options.limit,
        ({ classifier }) =>
            `  ${classifier.status.padEnd(8)} ${String(classifier.latencyMs).padStart(4)}ms ` +
            `${classifier.reason}`,
    );

    const files = scriptFiles(consulted);
    if (files.length > 0) {
        lines.push(`FILES SENT TO THE MODEL (${files.length})`);
        for (const file of files.slice(0, options.limit)) {
            lines.push(`  ${file.source}  ${file.consults}×  ${scoreList(file.confidences)}`);
            lines.push(`      ${oneLine(file.newestCommand)}  ${clock(file.newestTs)}`);
        }
        lines.push("");
    }

    lines.push(
        `${summary.applied} of ${summary.consulted} consulted accesses were resolved without a prompt.`,
    );

    return lines.join("\n");
}

function pushSection(
    lines: string[],
    title: string,
    rows: readonly ConsultedRecord[],
    limit: number,
    format: (entry: ConsultedRecord) => string,
): void {
    if (rows.length === 0) {
        return;
    }

    lines.push(`${title} (${rows.length}${rows.length > limit ? `, newest ${limit}` : ""})`);
    for (const entry of rows.slice(0, limit)) {
        lines.push(`${format(entry)}  ${clock(entry.record.ts)}`);
        lines.push(`      ${oneLine(entry.target)}`);
    }
    lines.push("");
}

export function renderJson(result: LoadResult): string {
    const summary = summarize(result.consulted);

    return `${JSON.stringify(
        {
            files: result.files,
            scriptFiles: scriptFiles(result.consulted),
            total: result.total,
            malformed: result.malformed,
            ...summary,
            consulted: result.consulted.length,
            rows: result.consulted.map(({ record, classifier, subject, target }) => ({
                ts: record.ts,
                gate: subject,
                surface: record.surface,
                command: record.gate === "file" ? undefined : target,
                operation: record.gate === "file" ? record.operation : undefined,
                path: record.gate === "file" ? record.path : undefined,
                folder: record.gate === "file" ? record.folder : undefined,
                strategy: classifier.strategy,
                provider: classifier.provider,
                model: classifier.model,
                criterion: classifier.criterion,
                action: classifier.action,
                confidence: classifier.confidence,
                outcome: classifier.outcome,
                status: classifier.status,
                reason: classifier.reason,
                latencyMs: classifier.latencyMs,
                applied: classifier.applied,
                tokens: classifier.tokens,
                script: classifier.script,
                human: record.prompt?.outcome,
                decision: record.decision,
                sandboxed: record.gate === "file" ? undefined : record.sandboxed,
            })),
        },
        null,
        2,
    )}`;
}

// ----------------------------------------------------------------------- main

function main(): void {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(`${USAGE}\n`);
        return;
    }

    const result = loadRecords(options);
    process.stdout.write(
        options.json ? `${renderJson(result)}\n` : `${renderText(result, options)}\n`,
    );
}

/**
 * Whether this file is the program being run, rather than a module a test imported.
 *
 * The parts are exported so `test/scripts/decision-report.test.ts` can feed a mixed log through them: a reader
 * that assumed every record was a command used to throw only when a real log happened to contain a file-access
 * row, which is the one thing a unit test of the gate cannot catch. Compared by `realpath`, because a guard that
 * never matches fails silently — the script would exit 0 having printed nothing, which reads as an empty log
 * rather than as a broken check.
 */
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
