#!/usr/bin/env node
/**
 * Mine the compaction trace written by `src/modules/compaction/trace.ts`.
 *
 * The point is development triage of a two-stage pipeline whose intermediates are invisible in the session
 * transcript: whether stage 1 reused the provider's cached prefix, what each stage cost, what the model
 * actually said, whether the reduce compressed or inflated, and which failure mode ended the run. Every
 * record of one compaction shares a run id, so the report groups by run and flags the runs that look wrong
 * rather than leaving a human to rebuild the join with jq each time.
 *
 * Usage:
 *   npm run compaction-report -- [options]
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { createJsonlRecordLog, discoverGenerations } from "../src/common/record-log";

// ---------------------------------------------------------------- arg parsing

const USAGE = `usage: npm run compaction-report -- [options]\n${describeOptions()}`;

const ROUTES = new Set([
    "two-stage",
    "native",
    "serialized",
    "core-default",
    "cancelled",
    "disabled",
]);

const REASONS = new Set(["manual", "threshold", "overflow"]);

/** Stage names accepted by `--dump`, matching the trace's own vocabulary. */
const DUMP_STAGES = new Set(["all", "native", "serialized", "final"]);

function describeOptions() {
    return [
        "  --path <file>       log (default $COMPACTION_TRACE_PATH or .state/compaction-trace.jsonl; a",
        "                      every retained generation is read automatically, oldest first)",
        "  --since <dur>       only newer than 90m | 24h | 7d",
        "  --session <prefix>  only runs whose session id starts with this",
        "  --grep <text>       only runs whose stage text contains this (case-insensitive)",
        "  --reason <name>     manual | threshold | overflow",
        "  --route <name>      two-stage | native | serialized | core-default | cancelled | disabled",
        "  --suspect           only runs that carry at least one flag",
        "  --runs <n>          run blocks to render, newest first (default 10, 0 means all)",
        "  --limit <n>         rows per aggregate section (default 15)",
        "  --text <n>          inline preview width per stage (default 120, 0 hides): only the first line is",
        "                      shown, with the line and char counts, because a checkpoint is markdown",
        "  --dump[=<stage>]    print stage text verbatim instead of a report: native (stage 1 answer),",
        "                      serialized (stage 2 answer), final (what was persisted), or all (default)",
        "  --min-chars <n>     accepted output below this many characters is flagged (default 300)",
        "  --inflate-factor <n>  flag a reduce this many times larger than its checkpoint (default 4)",
        "  --json              machine-readable runs and aggregates",
        "  --help              this message",
    ].join("\n");
}

function parseArgs(argv) {
    const options = {
        path: undefined,
        since: undefined,
        session: undefined,
        reason: undefined,
        route: undefined,
        suspect: false,
        runs: 10,
        limit: 15,
        text: 120,
        dump: undefined,
        grep: undefined,
        minChars: 300,
        inflateFactor: 4,
        json: false,
        help: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => {
            i += 1;
            return argv[i];
        };

        if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else if (arg === "--suspect") {
            options.suspect = true;
        } else if (arg === "--json") {
            options.json = true;
        } else if (arg === "--dump" || arg.startsWith("--dump=")) {
            options.dump = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : "all";
        } else if (arg === "--grep") {
            options.grep = next();
        } else if (arg === "--path") {
            options.path = next();
        } else if (arg === "--since") {
            options.since = next();
        } else if (arg === "--session") {
            options.session = next();
        } else if (arg === "--reason") {
            options.reason = next();
        } else if (arg === "--route") {
            options.route = next();
        } else if (arg === "--runs") {
            options.runs = Number.parseInt(next(), 10);
        } else if (arg === "--limit") {
            options.limit = Number.parseInt(next(), 10);
        } else if (arg === "--text") {
            options.text = Number.parseInt(next(), 10);
        } else if (arg === "--min-chars") {
            options.minChars = Number.parseInt(next(), 10);
        } else if (arg === "--inflate-factor") {
            options.inflateFactor = Number(next());
        } else {
            throw new Error(`unknown argument: ${arg}\n${USAGE}`);
        }
    }

    for (const name of ["limit", "minChars"]) {
        if (!Number.isFinite(options[name]) || options[name] < 1) {
            throw new Error(`--${name} must be a positive integer`);
        }
    }
    // `--runs 0` lifts the limit, which is what a dump over the whole file wants.
    for (const name of ["runs", "text"]) {
        if (!Number.isFinite(options[name]) || options[name] < 0) {
            throw new Error(`--${name} must be a non-negative integer`);
        }
    }
    if (options.dump !== undefined && !DUMP_STAGES.has(options.dump)) {
        throw new Error(`--dump must be one of: ${[...DUMP_STAGES].join(", ")}`);
    }
    if (!Number.isFinite(options.inflateFactor) || options.inflateFactor < 1) {
        throw new Error("--inflate-factor must be 1 or greater");
    }
    if (options.since !== undefined) {
        parseDuration(options.since);
    }
    if (options.reason !== undefined && !REASONS.has(options.reason)) {
        throw new Error(`--reason must be one of: ${[...REASONS].join(", ")}`);
    }
    if (options.route !== undefined && !ROUTES.has(options.route)) {
        throw new Error(`--route must be one of: ${[...ROUTES].join(", ")}`);
    }

    return options;
}

function parseDuration(value) {
    const match = /^(\d+)\s*([smhdw])$/i.exec(value.trim());
    if (!match) {
        throw new Error(`invalid --since value: ${value} (expected e.g. 90m, 24h, 7d)`);
    }

    const unitSeconds = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[match[2].toLowerCase()];
    return Number.parseInt(match[1], 10) * unitSeconds * 1000;
}

// ------------------------------------------------------------------ log input

function defaultLogPath() {
    const fromEnv = nonEmpty(process.env.COMPACTION_TRACE_PATH);
    if (fromEnv !== undefined) {
        return fromEnv;
    }

    // The writer's default: PI_CODER_STATE_DIR, resolved from the installed extension root so source and
    // compiled layouts agree.
    return path.join(
        fileURLToPath(new URL("..", import.meta.url)),
        ".state",
        "compaction-trace.jsonl",
    );
}

/** Treat an unset or blank value as absent so the default can apply. */
function nonEmpty(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

/**
 * Every retained generation, read through the same log the recorder writes.
 *
 * Sharing the reader is the point of this file: segment naming, oldest-first ordering, and torn-line tolerance
 * were each reimplemented per script, and a report that disagrees with its own recorder about which files hold
 * history is worse than no report. `maxBytes: 0` disables rotation, because reading is never a reason to roll
 * the file being described.
 */
function openTraceLog(explicitPath) {
    const filePath = explicitPath ?? defaultLogPath();

    return createJsonlRecordLog({
        filePath,
        maxBytes: 0,
        generations: discoverGenerations(filePath),
    });
}

function loadRecords(options) {
    const log = openTraceLog(options.path);
    const files = log.stats().files;
    if (files.length === 0) {
        throw new Error(
            `no compaction trace found at ${options.path ?? defaultLogPath()}\n` +
                "the recorder writes it during compaction; run /compact, or pass --path",
        );
    }

    const cutoff =
        options.since === undefined ? undefined : Date.now() - parseDuration(options.since);
    const records = [];
    let skipped = 0;

    for (const record of log.read({ since: cutoff })) {
        if (!isTraceRecord(record)) {
            skipped += 1;
            continue;
        }

        const matchesSession =
            options.session === undefined || String(record.session).startsWith(options.session);
        if (!matchesSession) {
            continue;
        }

        if (options.reason !== undefined && record.reason !== options.reason) {
            continue;
        }

        records.push(record);
    }

    return { records, files, skipped, malformed: log.stats().malformed };
}

/** Shape check only: an unrelated JSONL line must not become a run. */
function isTraceRecord(record) {
    return (
        record !== null &&
        typeof record === "object" &&
        typeof record.ts === "string" &&
        typeof record.stage === "string" &&
        typeof record.id === "string"
    );
}

// ------------------------------------------------------------ run collection

/**
 * One run is one compaction: every record sharing the run id the writer stamps per compaction, including the
 * rungs that never reached a provider call.
 */
function collectRuns(records) {
    const byRun = new Map();

    for (const record of records) {
        const group = byRun.get(record.id);
        if (group === undefined) {
            byRun.set(record.id, [record]);
            continue;
        }
        group.push(record);
    }

    const runs = [];
    for (const [id, group] of byRun) {
        group.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
        runs.push(describeRun(id, group));
    }

    runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    return runs;
}

/**
 * Defensive copy of a `prefix` record. The trace file keeps records from older builds across rotation, and
 * those predate fields such as `divergences` and `parameters`, so every reader here gets a complete shape.
 */
function normalizePrefix(prefix) {
    if (prefix === null || typeof prefix !== "object") {
        return undefined;
    }

    return {
        // `none` means no hash ladder covered this branch, which is not the same as a mismatch: the old
        // records reported both as `prefixUsable: false`, and that cost a whole debugging pass.
        reference:
            prefix.reference ?? (prefix.parentMessageCount === undefined ? "unknown" : "body"),
        usable: prefix.prefixUsable,
        first: prefix.firstDivergence ?? "(unknown)",
        divergences: Array.isArray(prefix.divergences) ? prefix.divergences : [],
        parameters: Array.isArray(prefix.parameters) ? prefix.parameters : [],
        // Named for what it is: the deepest reference depth the rebuild agreed with, not an index into our own
        // array. `--json` callers read this field directly.
        verifiedTo: prefix.commonPrefixMessages,
        // Pre-chain records named the reference depth `parentMessageCount`.
        referenceDepth: prefix.referenceDepth ?? prefix.parentMessageCount,
        ourCount: prefix.ourMessageCount,
        verifiedThrough: prefix.verifiedThrough,
        // Keep the record's own field names in `--json`, so a reader can grep the same key in both places.
        comparableDepth: prefix.comparableDepth,
        observations: prefix.observations,
        // The chain funnel: held -> on this branch -> comparable. The record used to print only the last of the
        // three, which let "nothing observed" and "observed plenty, matched none" share one rendering.
        chainObservations: prefix.chainObservations,
        branchObservations: prefix.branchObservations,
        ourSystemChars: prefix.ourRequest?.systemChars,
        ourSystemHash: prefix.ourRequest?.systemHash,
        parentSystemChars: prefix.parentRequest?.systemChars,
        parentSystemHash: prefix.parentRequest?.systemHash,
        parentDepth: prefix.parentRequest?.messageCount,
        unknowns: Array.isArray(prefix.unknowns) ? prefix.unknowns : [],
        historyTruncated: prefix.historyTruncated,
        modelDivergence: prefix.modelDivergence,
        truncated: prefix.truncated,
    };
}

/** Fold one run's records into the shape the report renders. */
function describeRun(id, group) {
    const attempts = [];
    const texts = new Map();
    let prefix;
    let final;
    let route;
    let routeDetail;
    let previousTs;

    for (const record of group) {
        // The writer emits an attempt record only once that attempt is over, so the gap to the previous
        // record is the closest thing to per-stage latency the trace has.
        const gapMs = previousTs === undefined ? 0 : Date.parse(record.ts) - Date.parse(previousTs);
        previousTs = record.ts;

        if (record.stage === "attempt") {
            attempts.push({
                strategy: record.strategy ?? "(none)",
                outcome: record.outcome ?? "(none)",
                stopReason: record.stopReason,
                cause: record.cause,
                retries: record.retries,
                detail: record.detail,
                usage: record.usage,
                fields: record.attempt ?? {},
                gapMs,
            });
            continue;
        }

        if (record.stage === "prefix") {
            prefix = normalizePrefix(record.prefix);
            continue;
        }

        if (record.stage === "model_response") {
            texts.set(record.strategy ?? "(none)", record.text ?? "");
            continue;
        }

        if (record.stage === "final_summary") {
            final = {
                strategy: record.strategy,
                text: record.text ?? "",
                fields: record.final ?? {},
            };
            continue;
        }

        if (record.stage === "outcome") {
            route = record.outcome;
            routeDetail = record.detail;
        }
    }

    const first = group[0];
    const last = group[group.length - 1];
    const declared = attempts.find((attempt) => attempt.fields.provider !== undefined);

    return {
        id,
        session: first.session,
        cwd: first.cwd,
        reason: first.reason,
        willRetry: first.willRetry === true,
        startedAt: first.ts,
        endedAt: last.ts,
        durationMs: Date.parse(last.ts) - Date.parse(first.ts),
        attempts,
        texts,
        prefix,
        final,
        route,
        routeDetail,
        // The last cause the run named: for a run that stopped, that is the reason it stopped, and for a run
        // that went through it is a leftover from a rung that failed before a later one succeeded.
        cause: [...attempts].reverse().find((attempt) => attempt.cause !== undefined)?.cause,
        provider: declared?.fields.provider,
        model: declared?.fields.model,
        ...runCost(attempts),
    };
}

/** Token totals for a run, separating what the provider read fresh from what it served from cache. */
function runCost(attempts) {
    let fresh = 0;
    let cached = 0;
    let output = 0;

    for (const attempt of attempts) {
        const usage = attempt.usage;
        if (usage === undefined) {
            continue;
        }
        fresh += number(usage.input);
        cached += number(usage.cacheRead);
        output += number(usage.output);
    }

    const prompt = fresh + cached;

    return {
        freshTokens: fresh,
        cachedTokens: cached,
        outputTokens: output,
        promptTokens: prompt,
        reuse: prompt === 0 ? null : cached / prompt,
    };
}

function number(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// ------------------------------------------------------------------- analysis

/** Turn a rejection detail into a groupable key without dropping the distinguishing words. */
function failureKey(attempt) {
    const detail = (attempt.detail ?? "").trim();
    if (detail === "") {
        return `${attempt.strategy} ${attempt.outcome}`;
    }

    const normalized = detail
        .replaceAll(/\{[^}]*\}/g, "<json>")
        .replaceAll(/"[^"]*"/g, "<str>")
        .replaceAll(/\d[\d,.]*/g, "<n>")
        .split(/\s+/)
        .filter((word) => word !== "")
        .slice(0, 12)
        .join(" ");

    // The cause leads the key: before classification, an exhausted quota and a context overflow shared a row
    // because their normalized messages looked alike, which is the ambiguity this whole layer exists to remove.
    const cause = attempt.cause === undefined ? "" : ` [${attempt.cause}]`;

    return `${attempt.strategy} ${attempt.outcome}${cause}: ${normalized}`;
}

function newGroup() {
    return { count: 0, runs: [], examples: [] };
}

function addRun(group, run, example) {
    group.count += 1;
    if (group.runs.length < 50) {
        group.runs.push(run);
    }
    if (example !== undefined && group.examples.length < 2) {
        group.examples.push(`${clock(run.startedAt)} ${example}`);
    }
}

function analyzeRuns(runs, thresholds) {
    const routes = new Map();
    const causes = new Map();
    const failures = new Map();
    const flags = new Map();
    const parameters = new Map();
    const divergences = new Map();
    const models = new Map();
    const suspects = [];
    const withUsage = [];
    const compression = [];

    for (const run of runs) {
        const routeGroup = bump(routes, run.route ?? "(no outcome record)", newGroup);
        addRun(routeGroup, run);

        const modelKey = `${run.provider ?? "?"}/${run.model ?? "?"}`;
        models.set(modelKey, number(models.get(modelKey)) + 1);

        for (const attempt of run.attempts) {
            if (attempt.cause !== undefined) {
                addRun(
                    bump(
                        causes,
                        `${attempt.strategy} ${attempt.outcome} ${attempt.cause}`,
                        newGroup,
                    ),
                    run,
                );
            }
            if (attempt.outcome === "accepted") {
                continue;
            }
            addRun(bump(failures, failureKey(attempt), newGroup), run, attempt.detail ?? "");
        }

        for (const parameter of run.prefix?.parameters ?? []) {
            parameters.set(parameter, number(parameters.get(parameter)) + 1);
        }
        for (const divergence of run.prefix?.divergences ?? []) {
            // Indexed message keys differ only by position, so they would each own a row.
            const key = divergence.replaceAll(/\[\d+\]/g, "[i]");
            divergences.set(key, number(divergences.get(key)) + 1);
        }

        if (run.reuse !== null) {
            withUsage.push(run);
        }

        const checkpointChars = checkpointOf(run);
        const finalChars = run.final?.text.length ?? 0;
        if (finalChars > 0) {
            compression.push({ run, checkpointChars, finalChars });
        }

        const flagged = flagRun(run, thresholds);
        if (flagged.length === 0) {
            continue;
        }
        suspects.push({ run, flags: flagged });
        for (const flag of flagged) {
            addRun(bump(flags, flag.key, newGroup), run, flag.detail);
        }
    }

    const invariants = new Map();
    for (const violation of invariantViolations(runs)) {
        addRun(bump(invariants, violation.key, newGroup), violation.run, violation.detail);
    }

    return {
        routes,
        causes,
        failures,
        flags,
        invariants,
        parameters,
        divergences,
        models,
        suspects,
        withUsage,
        compression,
    };
}

function bump(map, key, factory) {
    const existing = map.get(key);
    if (existing !== undefined) {
        return existing;
    }

    const created = factory();
    map.set(key, created);
    return created;
}

/** Stage 1's answer as the reduce saw it: the count stage 2 was handed, else the raw stage-1 text. */
function checkpointOf(run) {
    const serialized = run.attempts.find((attempt) => attempt.strategy === "serialized");
    const reported = serialized?.fields.segmentSummaryChars;
    if (typeof reported === "number") {
        return reported;
    }

    return run.texts.get("native")?.length ?? 0;
}

/**
 * Cross-field checks that must hold if the instrument itself is honest.
 *
 * Each one encodes a guarantee the code makes, so a violation is a bug in the trace rather than a bug in the
 * cache - a distinction that had to be made by hand on 2026-09-05 and should not have to be made again. Older
 * records simply lack the fields, which is not a violation.
 */
function invariantViolations(runs) {
    const out = [];

    for (const run of runs) {
        const prefix = run.prefix;
        if (prefix === undefined) {
            continue;
        }

        const held = prefix.chainObservations;
        const branch = prefix.branchObservations;
        const comparable = prefix.observations;
        const checks = [
            [
                typeof held === "number" && typeof branch === "number" && held === 0 && branch > 0,
                "chain-empty-contradiction",
                `chain holds nothing yet ${branch} entries are on the branch`,
            ],
            [
                prefix.reference === "none" && typeof branch === "number" && branch > 0,
                "none-with-branch",
                `reference=none with ${branch} on-branch entries to compare against`,
            ],
            [
                typeof comparable === "number" &&
                    comparable > 0 &&
                    typeof branch === "number" &&
                    branch === 0,
                "comparable-without-branch",
                `${comparable} comparable observations with none on the branch`,
            ],
            [
                prefix.usable === true && number(prefix.comparableDepth) <= 0,
                "usable-without-depth",
                "usable=true while comparable depth is zero or negative",
            ],
            [
                typeof prefix.parentSystemHash === "string" &&
                    typeof prefix.ourSystemHash === "string" &&
                    prefix.parentSystemHash === prefix.ourSystemHash &&
                    prefix.parentSystemChars !== prefix.ourSystemChars,
                "hash-length-conflict",
                `identical system hash over ${prefix.parentSystemChars}c and ${prefix.ourSystemChars}c prompts`,
            ],
        ];

        for (const [violated, key, detail] of checks) {
            if (violated) {
                out.push({ run, key, detail });
            }
        }
    }

    return out;
}

/**
 * The three states that all render as `obs=0`, named apart.
 *
 * They have nothing in common with each other, and debugging the wrong one is how a whole afternoon goes: an
 * empty chain is a cold process, an off-branch chain is navigation, and an incomparable chain is a prompt or
 * tool-set difference. Records written before these fields existed produce nothing, rather than a `chain-empty`
 * that is really just an older build.
 */
function chainFunnelSuspects(prefix) {
    const held = prefix?.chainObservations;
    const onBranch = prefix?.branchObservations;
    if (typeof held !== "number" || typeof onBranch !== "number") {
        return [];
    }

    const comparable = number(prefix.observations);
    const out = [];

    if (held === 0) {
        out.push({
            key: "chain-empty",
            detail:
                "no parent request observed in this process since the chain was created " +
                "(restart, reload, or a freshly built session view)",
        });
    } else if (onBranch === 0) {
        out.push({
            key: "chain-off-branch",
            detail: `chain holds ${held} entries, none with a leaf on this branch`,
        });
    } else if (comparable === 0) {
        out.push({
            key: "chain-incomparable",
            detail: `${onBranch} on-branch entries share neither our system prompt nor our tool set`,
        });
    }

    // A same-length, different-hash pair is prompt drift that no size figure can show; the reverse used to be
    // the normal reading, because the recorded hash covered only a 320-char excerpt.
    if (
        typeof prefix.ourSystemHash === "string" &&
        typeof prefix.parentSystemHash === "string" &&
        prefix.ourSystemHash !== prefix.parentSystemHash &&
        prefix.ourSystemChars === prefix.parentSystemChars
    ) {
        out.push({
            key: "system-prompt-drift",
            detail: `same length (${prefix.ourSystemChars}c), different system prompt`,
        });
    }

    return out;
}

/**
 * Automated suspicion. Every flag names a failure mode already seen in a live trace, so the report can point
 * at the runs that are wrong instead of leaving the reader to compare numbers by eye.
 */
function flagRun(run, options) {
    const out = [];
    const prefix = run.prefix;
    const native = run.attempts.find((attempt) => attempt.strategy === "native");
    const serialized = run.attempts.find((attempt) => attempt.strategy === "serialized");
    const finalChars = run.final?.text.length ?? 0;
    const checkpointChars = checkpointOf(run);

    if (prefix !== undefined && prefix.usable === false) {
        out.push({
            key: "prefix-unusable",
            detail: `first=${prefix.first} divergences=[${prefix.divergences.join(", ")}]`,
        });
    }

    // An absent reference is not a failure, but it is a blind spot worth listing: it is the case where the
    // cache question genuinely cannot be answered from this record.
    if (prefix !== undefined && prefix.reference === "none") {
        out.push({
            key: "no-prefix-reference",
            detail: `no hash ladder covered this branch; ${prefix.ourCount ?? 0} messages went unverified`,
        });
    }

    out.push(...chainFunnelSuspects(prefix));

    // The reference existed but nothing in it reached the depth our span carried: no verdict is possible, and
    // an earlier version of this code called that "unusable".
    const uncomparable =
        prefix !== undefined &&
        prefix.reference === "chain" &&
        typeof prefix.comparableDepth === "number" &&
        prefix.comparableDepth <= 0;
    if (uncomparable) {
        out.push({
            key: "prefix-uncomparable",
            detail: `reference reached depth ${dash(prefix.referenceDepth)}, the span carried ${dash(prefix.ourCount)}`,
        });
    }

    if (
        prefix !== undefined &&
        prefix.reference === "chain" &&
        typeof prefix.referenceDepth === "number" &&
        typeof prefix.ourCount === "number" &&
        prefix.referenceDepth < prefix.ourCount - 1
    ) {
        out.push({
            key: "prefix-reference-shallow",
            detail: `reference reached depth ${prefix.referenceDepth}, the span had ${prefix.ourCount - 1}`,
        });
    }

    // Stage 1 truncates by design, so a non-truncated span means the cut point was never found and the whole
    // live context went out again at full price.
    if (prefix !== undefined && prefix.truncated === false) {
        out.push({
            key: "span-not-truncated",
            detail: `ours=${prefix.ourCount} parent=${prefix.parentCount}`,
        });
    }

    // Only judge an answer that is actually here. The `model_response` record is separate from the attempt, so
    // a trimmed or rotated log - or a fixture that omits it deliberately - must not read as an empty reply.
    const nativeText = run.texts.get("native");
    if (
        native?.outcome === "accepted" &&
        nativeText !== undefined &&
        nativeText.length < options.minChars
    ) {
        out.push({
            key: "degenerate-native-output",
            detail: `stage 1 accepted with ${nativeText.length} chars: ${snippet(nativeText, 90)}`,
        });
    }

    // Stage 2 keeps a truncated answer on purpose - the alternative is pi's own compaction - so the trace's
    // stop reason is the only sign that the persisted summary is missing its tail. Reading the text cannot
    // tell a cut-off answer from a brief complete one.
    if (serialized?.outcome === "accepted" && serialized.stopReason === "length") {
        out.push({
            key: "summary-truncated",
            detail: `stage 2 hit the output limit; the persisted ${String(finalChars)} chars are missing their tail`,
        });
    }

    if (finalChars > 0 && finalChars < options.minChars) {
        out.push({
            key: "degenerate-final-summary",
            detail: `persisted summary is ${finalChars} chars`,
        });
    }

    const inflated =
        serialized?.outcome === "accepted" &&
        checkpointChars > 0 &&
        finalChars > options.minChars &&
        finalChars > checkpointChars * options.inflateFactor + 1000;
    if (inflated) {
        out.push({
            key: "reduce-inflated",
            detail: `${checkpointChars} checkpoint chars -> ${finalChars} final chars (>${options.inflateFactor}x)`,
        });
    }

    if (run.freshTokens > options.expensiveResendTokens && run.cachedTokens === 0) {
        out.push({
            key: "cache-read-zero",
            detail: `${run.freshTokens} fresh prompt tokens with 0 cache read`,
        });
    }

    const dropped = number(run.final?.fields.droppedBlocks);
    if (dropped > 0) {
        out.push({
            key: "blocks-dropped",
            detail: `${dropped} transcript blocks left out of the reduce request`,
        });
    }

    // Deliberate stops are not fallbacks: core never got the session. Named separately because the fix for
    // each is outside this codebase - a plan, a key, or a quieter request - and a run that stopped for quota
    // must not read as a pipeline defect.
    if (run.route === "abandoned") {
        out.push({
            key: "compaction-abandoned",
            detail: `${run.cause ?? "(no cause named)"} ${run.routeDetail ?? ""}`.trim(),
        });
    }

    // A transient failure that used its whole retry budget is the provider being unwell for longer than our
    // backoff tolerates; worth seeing as a count, because it is the signal to raise the budget or to stop
    // paying it.
    const exhausted = run.attempts.find(
        (attempt) => attempt.outcome !== "accepted" && number(attempt.retries) > 0,
    );
    if (exhausted) {
        out.push({
            key: "retry-exhausted",
            detail: `${exhausted.strategy} resent ${String(exhausted.retries)}x and still failed (cause=${exhausted.cause ?? "?"})`,
        });
    }

    if (run.route === "core-default" || run.route === "cancelled" || run.route === undefined) {
        const detail = `route=${run.route ?? "(missing)"} ${run.routeDetail ?? ""}`.trim();
        out.push({ key: "fell-back", detail });
    }

    const skew = estimateSkew(native ?? serialized);
    if (skew !== null && Math.abs(skew) > options.estimateSkew) {
        out.push({
            key: "estimate-skew",
            detail: `chars/4 estimate ${(skew * 100).toFixed(0)}% off the provider's own count`,
        });
    }

    return out;
}

/**
 * Thresholds that are not exposed as flags: a run above 50k fresh tokens with no cache read is the shape of
 * "we paid for the whole span again", and a chars/4 estimate more than 15% off the provider's own count is
 * the point where the fit gate starts deciding on a number that does not describe the request.
 */
const DEFAULT_THRESHOLDS = {
    minChars: 300,
    inflateFactor: 4,
    expensiveResendTokens: 50000,
    estimateSkew: 0.15,
};

/** Signed error of the chars/4 estimate against the provider-reported context size. */
function estimateSkew(attempt) {
    const estimated = attempt?.fields?.estimatedTokens;
    const reported = attempt?.fields?.reportedContextTokens;
    if (typeof estimated !== "number" || typeof reported !== "number" || reported === 0) {
        return null;
    }

    return (estimated - reported) / reported;
}

// -------------------------------------------------------------------- output

function countOf(value) {
    if (typeof value === "number") {
        return value;
    }
    if (value !== null && typeof value === "object") {
        if (typeof value.count === "number") {
            return value.count;
        }
        if (Array.isArray(value)) {
            return value.length;
        }
    }

    return 1;
}

function topEntries(map, limit) {
    return [...map.entries()]
        .sort((a, b) => countOf(b[1]) - countOf(a[1]) || String(a[0]).localeCompare(String(b[0])))
        .slice(0, limit);
}

/** Short one-line preview for the report body; `--dump` is where the full text lives. */
function quote(text, max) {
    if (text === undefined || text === "") {
        return "(empty)";
    }

    const lines = text.split("\n").filter((line) => line.trim() !== "");
    const first = (lines[0] ?? "").trim();
    const clipped = first.length > max;
    const shown = clipped ? first.slice(0, Math.max(0, max)) : first;

    const extra = [];
    if (lines.length > 1) {
        extra.push(`+${lines.length - 1} more lines`);
    }
    if (clipped || extra.length > 0) {
        extra.push(`${text.length}c`);
    }
    const suffix = extra.length > 0 ? `… (${extra.join(", ")})` : "";

    return `"${shown}${suffix}"`;
}

/** Hard single-line cut, for places that must stay on one line and need no accounting. */
function snippet(text, max) {
    const flat = (text ?? "").replaceAll(/\s+/g, " ").trim();
    if (flat.length <= max) {
        return `"${flat}"`;
    }

    return `"${flat.slice(0, Math.max(0, max - 1))}…"`;
}

function tokens(value) {
    if (typeof value !== "number") {
        return "-";
    }
    if (Math.abs(value) >= 10000) {
        return `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k`;
    }
    return String(value);
}

function seconds(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) {
        return "-";
    }
    return `${(ms / 1000).toFixed(1)}s`;
}

function clock(ts) {
    return String(ts).slice(11, 19);
}

/** Long enough to disambiguate a uuid prefix, short enough to keep a run header on one line. */
function shortId(id) {
    return String(id ?? "").slice(0, 12);
}

function median(values) {
    const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (sorted.length === 0) {
        return null;
    }

    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return sorted[middle];
    }

    return (sorted[middle - 1] + sorted[middle]) / 2;
}

function pct(value) {
    if (typeof value !== "number") {
        return "-";
    }
    return `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`;
}

/** The request-side numbers of one attempt, minus the keys that are always absent. */
function fieldParts(fields) {
    const parts = [];
    const add = (label, value) => {
        if (value !== undefined && value !== null && value !== "") {
            parts.push(`${label}=${value}`);
        }
    };

    add("msgs", fields.messageCount);
    add("sys", suffix(fields.systemChars, "c"));
    add("copied", fields.copiedEntries);
    add("skippedEnt", zeroToUndefined(fields.skippedEntries));
    add("est", tokens(fields.estimatedTokens));
    add("rep", tokens(fields.reportedContextTokens));
    add("win", tokens(fields.contextWindow));
    add("maxTok", tokens(fields.maxTokens));
    add("tools", fields.toolCount);
    add("ser", suffix(fields.serializedChars, "c"));
    add("dropped", fields.droppedBlocks);
    add("seg", suffix(fields.segmentSummaryChars, "c"));
    add("prev", fields.previousSummaryChars);
    add("focus", fields.customInstructions === undefined ? undefined : "yes");

    return parts;
}

function suffix(value, unit) {
    if (typeof value !== "number") {
        return undefined;
    }
    return `${value}${unit}`;
}

function zeroToUndefined(value) {
    if (typeof value !== "number" || value === 0) {
        return undefined;
    }
    return value;
}

function renderRunBlock(run, flags, options) {
    const lines = [];
    const head =
        `${clock(run.startedAt)}  ${(run.route ?? "??").padEnd(12)} ${String(run.reason).padEnd(8)}` +
        `${run.willRetry ? "retry" : "     "}  session=${shortId(run.session)}  ` +
        `${run.provider ?? "?"}/${run.model ?? "?"}  ${seconds(run.durationMs)}`;
    lines.push("", `  ${head}`);

    if (run.prefix !== undefined) {
        const prefix = run.prefix;
        const bits = [
            `reference=${prefix.reference}`,
            `usable=${dash(prefix.usable)}`,
            `verified=${dash(prefix.verifiedTo)}/${dash(prefix.comparableDepth ?? prefix.referenceDepth)}`,
            `ours=${dash(prefix.ourCount)}`,
            `obs=${dash(prefix.observations)}`,
            `first=${prefix.first}`,
        ];

        // `chain=held/branch/comparable` and `sys=ours/parent` are the two pairs that decide whether a prefix
        // verdict means anything, so they belong on the line rather than one flag deeper.
        if (typeof prefix.chainObservations === "number") {
            bits.push(
                `chain=${prefix.chainObservations}/${prefix.branchObservations}/${prefix.observations}`,
            );
        }
        if (typeof prefix.ourSystemChars === "number") {
            bits.push(`sys=${prefix.ourSystemChars}c`);
            if (typeof prefix.parentSystemChars === "number") {
                bits.push(`parent-sys=${prefix.parentSystemChars}c`);
            }
        }
        if (prefix.truncated === true) {
            bits.push("truncated");
        }
        if (prefix.historyTruncated === true) {
            bits.push("history-capped");
        }
        if (prefix.modelDivergence) {
            bits.push(`model=${prefix.modelDivergence}`);
        }
        if (prefix.parameters.length > 0) {
            bits.push(`params=${prefix.parameters.join(",")}`);
        }
        if (prefix.divergences.length > 0) {
            bits.push(`div=${prefix.divergences.join(",")}`);
        }
        lines.push(`    prefix      ${bits.join("  ")}`);
    }

    for (const attempt of run.attempts) {
        const usage = attempt.usage;
        const cost =
            usage === undefined
                ? "no usage"
                : `in=${tokens(usage.input)} cached=${tokens(usage.cacheRead)} ` +
                  `cw=${tokens(usage.cacheWrite)} out=${tokens(usage.output)}`;
        lines.push(
            `    ${attempt.strategy.padEnd(11)} ${String(attempt.outcome).padEnd(8)} +${seconds(attempt.gapMs).padStart(6)}  ${cost}`,
        );

        const parts = fieldParts(attempt.fields);
        if (parts.length > 0) {
            lines.push(`                  ${parts.join(" ")}`);
        }
        if (attempt.detail !== undefined && attempt.detail !== "") {
            lines.push(`                  detail: ${quote(attempt.detail, 130)}`);
        }

        const text = run.texts.get(attempt.strategy);
        if (text !== undefined && options.text > 0) {
            lines.push(`                  said:   ${quote(text, options.text)}`);
        }
    }

    if (run.final !== undefined) {
        const fields = run.final.fields;
        lines.push(
            `    final       ${run.final.text.length}c via=${run.final.strategy ?? "-"} ` +
                `keptFrom=${shortId(fields.firstKeptEntryId)} before=${tokens(fields.tokensBefore)} ` +
                `summarized=${dash(fields.summarizedMessages)} dropped=${dash(fields.droppedBlocks)} ` +
                `files=${dash(fields.readFiles)}/${dash(fields.modifiedFiles)}`,
        );
    }

    for (const flag of flags) {
        lines.push(`    ! ${flag.key}: ${flag.detail}`);
    }

    // What the record cannot answer, in its own words. Printed apart from suspects because these are not
    // findings about the run, they are statements about the instrument's reach.
    for (const unknown of run.prefix?.unknowns ?? []) {
        lines.push(`    ~ cannot tell: ${unknown}`);
    }

    return lines.join("\n");
}

function dash(value) {
    if (value === undefined || value === null) {
        return "-";
    }
    return String(value);
}

function renderCountSection(title, blurb, map, options, formatRow) {
    const rows = topEntries(map, options.limit);
    const out = ["", `${title} (${map.size} distinct, showing ${rows.length})`, `  ${blurb}`, ""];
    if (rows.length === 0) {
        out.push("  none");
        return out.join("\n");
    }

    for (const [key, value] of rows) {
        out.push(`  ${String(countOf(value)).padStart(5)}  ${formatRow(key, value)}`);
    }

    return out.join("\n");
}

function routeRow(key, group) {
    const runs = group.runs ?? [];
    const sessions = new Set(runs.map((run) => shortId(run.session))).size;

    return `${key.padEnd(14)} sessions=${sessions} median=${seconds(median(runs.map((run) => run.durationMs)))}`;
}

function exampleRow(key, group) {
    const example = group.examples?.[0];
    if (example === undefined) {
        return key;
    }

    return `${String(key).slice(0, 70)}\n          ${example}`;
}

function renderReport(runs, analysis, stats, options) {
    const out = [];
    const attempts = runs.reduce((sum, run) => sum + run.attempts.length, 0);

    out.push("compaction trace report");
    out.push(`  files:    ${stats.files.join(", ")}`);
    out.push(
        `  records:  ${stats.recordCount} in ${runs.length} run(s)` +
            `${stats.skipped > 0 ? ` (${stats.skipped} foreign skipped)` : ""}` +
            `${stats.malformed > 0 ? ` (${stats.malformed} unreadable)` : ""}`,
    );
    if (runs.length > 0) {
        out.push(`  span:     ${runs[0].startedAt} → ${runs[runs.length - 1].endedAt}`);
    }
    out.push(`  attempts: ${attempts}   suspects: ${analysis.suspects.length}`);
    out.push(
        `  models:   ${[...topEntries(analysis.models, 4)].map(([k, v]) => `${k} x${v}`).join("   ")}`,
    );

    const shown = options.runs === 0 ? runs : runs.slice(-options.runs);

    out.push(
        "",
        `RUNS (${runs.length} matching, showing ${shown.length} newest, oldest first)`,
        "  prefix = cache alignment · native = stage 1 on the live context · serialized = stage 2 reduce",
        "  +Ns after a stage is the gap since the previous record, i.e. that stage's wall time",
        "",
    );
    if (shown.length === 0) {
        out.push("  none");
    }
    for (const run of shown) {
        const flags = analysis.suspects.find((entry) => entry.run === run)?.flags ?? [];
        out.push(renderRunBlock(run, flags, options));
    }

    out.push(
        renderCountSection(
            "ROUTES",
            "how each compaction ended; core-default/cancelled/abandoned means the pipeline did not own the result",
            analysis.routes,
            options,
            routeRow,
        ),
    );
    out.push(
        renderCountSection(
            "CAUSES",
            "why each request failed, as classified by pi-ai's own overflow and retry predicates plus our cause policy",
            analysis.causes,
            options,
            (key) => key,
        ),
    );
    out.push(
        renderCountSection(
            "ATTEMPT FAILURES",
            "rejected and skipped stages keyed by normalized detail - the shape of what keeps going wrong",
            analysis.failures,
            options,
            exampleRow,
        ),
    );
    out.push(
        renderCountSection(
            "SUSPECTS",
            "automated flags, each one a failure mode already observed in a live trace",
            analysis.flags,
            options,
            exampleRow,
        ),
    );
    out.push(
        renderCountSection(
            "INVARIANTS",
            "cross-field checks that must hold; a violation is a bug in the instrument, not in the cache",
            analysis.invariants,
            options,
            exampleRow,
        ),
    );
    out.push(
        renderCountSection(
            "PREFIX DIVERGENCES",
            "content that actually differed, indexed messages collapsed to [i]",
            analysis.divergences,
            options,
            (key) => key,
        ),
    );
    out.push(
        renderCountSection(
            "PREFIX PARAMETERS",
            "request keys only one side sent - expected while tool_choice carries the prohibition",
            analysis.parameters,
            options,
            (key) => key,
        ),
    );

    out.push(
        "",
        "COST AND CACHE",
        "  fresh = tokens the provider had to read, cached = served from its prefix cache",
        "",
    );
    out.push(...renderCostRows(analysis.withUsage, options));

    out.push(
        "",
        "COMPRESSION",
        "  checkpoint = what stage 1 produced · summary = what was persisted, including appended file lists",
        "  on a native-only route the ratio is that section overhead, not a reduce; on two-stage it is the",
        "  compression the reduce achieved, and a large value means stage 2 rebuilt the summary itself",
        "",
    );
    out.push(...renderCompressionRows(analysis.compression, options));

    return out.join("\n");
}

function renderCostRows(runs, options) {
    if (runs.length === 0) {
        return ["  no accepted attempt reported usage"];
    }

    const fresh = runs.reduce((sum, run) => sum + run.freshTokens, 0);
    const cached = runs.reduce((sum, run) => sum + run.cachedTokens, 0);
    const output = runs.reduce((sum, run) => sum + run.outputTokens, 0);
    const zeroCache = runs.filter((run) => run.cachedTokens === 0).length;

    const out = [
        `  totals:   fresh=${tokens(fresh)}  cached=${tokens(cached)}  output=${tokens(output)}`,
        `  reuse:    median=${pct(median(runs.map((run) => run.reuse)))}   zero-cache runs=${zeroCache}/${runs.length}`,
        "",
    ];

    for (const run of runs.slice(-options.runs)) {
        out.push(
            `  ${clock(run.startedAt)} ${(run.route ?? "??").padEnd(12)} ` +
                `fresh=${tokens(run.freshTokens).padStart(7)} cached=${tokens(run.cachedTokens).padStart(7)} ` +
                `reuse=${pct(run.reuse).padStart(5)} out=${tokens(run.outputTokens).padStart(6)}`,
        );
    }

    return out;
}

function renderCompressionRows(rows, options) {
    if (rows.length === 0) {
        return ["  no final_summary record found"];
    }

    const ratioOf = (row) =>
        row.checkpointChars > 0 ? row.finalChars / row.checkpointChars : null;
    const ratios = rows.map(ratioOf).filter((value) => typeof value === "number");
    const out = [
        `  checkpoint median=${median(rows.map((row) => row.checkpointChars)) ?? "-"}c  ` +
            `summary median=${median(rows.map((row) => row.finalChars)) ?? "-"}c  ` +
            `ratio median=${median(ratios) === null ? "-" : `${median(ratios).toFixed(1)}x`}`,
        "",
    ];

    for (const row of rows.slice(-options.runs)) {
        const ratio = ratioOf(row);
        out.push(
            `  ${clock(row.run.startedAt)} ${(row.run.route ?? "??").padEnd(12)} ` +
                `checkpoint=${String(row.checkpointChars).padStart(6)}c summary=${String(row.finalChars).padStart(6)}c ` +
                `ratio=${(ratio === null ? "-" : `${ratio.toFixed(1)}x`).padStart(6)} ` +
                `before=${tokens(row.run.final?.fields.tokensBefore)} summarized=${dash(row.run.final?.fields.summarizedMessages)} ` +
                `dropped=${dash(row.run.final?.fields.droppedBlocks)}`,
        );
    }

    return out;
}

// ---------------------------------------------------------------------- dump

/**
 * Verbatim stage text, unindented and unterminated, so a checkpoint reads as the markdown it is and pipes
 * straight into a file or `less -R`. Each block is preceded by a header naming the run and the stage.
 */
function renderDump(runs, analysis, options) {
    const out = [];
    const shown = options.runs === 0 ? runs : runs.slice(-options.runs);

    for (const run of shown) {
        const flags = analysis.suspects.find((entry) => entry.run === run)?.flags ?? [];
        const summary =
            `${clock(run.startedAt)} route=${run.route ?? "??"} reason=${run.reason} ` +
            `session=${run.session} ${run.provider ?? "?"}/${run.model ?? "?"} ` +
            `fresh=${tokens(run.freshTokens)} cached=${tokens(run.cachedTokens)} reuse=${pct(run.reuse)}`;
        const header = `run ${run.id}
${"=".repeat(Math.max(8, summary.length))}
${summary}
${"-".repeat(summary.length)}`;
        const blocks = [];

        if (wants(options.dump, "native") && run.texts.has("native")) {
            blocks.push(
                block(
                    `stage 1 answer (native), ${run.texts.get("native").length} chars`,
                    run.texts.get("native"),
                ),
            );
        }
        if (wants(options.dump, "serialized") && run.texts.has("serialized")) {
            blocks.push(block("stage 2 answer (serialized)", run.texts.get("serialized")));
        }
        if (wants(options.dump, "final") && run.final !== undefined) {
            const fields = run.final.fields;
            blocks.push(
                block(
                    `persisted summary (${run.final.text.length} chars, keptFrom=${shortId(fields.firstKeptEntryId)} ` +
                        `before=${tokens(fields.tokensBefore)} dropped=${dash(fields.droppedBlocks)})`,
                    run.final.text,
                ),
            );
        }
        if (flags.length > 0) {
            blocks.push(
                block("flags", flags.map((flag) => `${flag.key}: ${flag.detail}`).join("\n")),
            );
        }

        if (blocks.length === 0) {
            continue;
        }
        out.push("", header, ...blocks);
    }

    if (out.length === 0) {
        return "no stage text matched the filters";
    }

    return out.join("\n") + "\n";
}

function wants(stage, name) {
    if (stage === undefined || stage === "all") {
        return name === "native" || name === "serialized" || name === "final";
    }

    return stage === name;
}

function block(label, text) {
    return [
        "",
        `--- ${label} ---------------------------------------------------------------`,
        "",
        text === undefined || text === "" ? "(empty)" : text,
    ].join("\n");
}

// ----------------------------------------------------------------- main flow

function toPlainRun(run, flags) {
    return {
        id: run.id,
        session: run.session,
        cwd: run.cwd,
        reason: run.reason,
        willRetry: run.willRetry,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        durationMs: run.durationMs,
        route: run.route,
        routeDetail: run.routeDetail,
        cause: run.cause,
        provider: run.provider,
        model: run.model,
        freshTokens: run.freshTokens,
        cachedTokens: run.cachedTokens,
        outputTokens: run.outputTokens,
        promptTokens: run.promptTokens,
        reuse: run.reuse,
        checkpointChars: checkpointOf(run),
        finalChars: run.final?.text.length ?? 0,
        final: run.final?.fields,
        prefix: run.prefix,
        attempts: run.attempts.map((attempt) => ({
            strategy: attempt.strategy,
            outcome: attempt.outcome,
            cause: attempt.cause,
            retries: attempt.retries,
            stopReason: attempt.stopReason,
            detail: attempt.detail,
            gapMs: attempt.gapMs,
            usage: attempt.usage,
            ...attempt.fields,
        })),
        texts: Object.fromEntries(run.texts),
        flags,
    };
}

function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 2;
        return;
    }

    if (options.help) {
        process.stdout.write(`${USAGE}\n`);
        return;
    }

    let stats;
    try {
        const records = loadRecords(options);
        stats = {
            records: records.records,
            files: records.files,
            skipped: records.skipped,
            malformed: records.malformed,
            recordCount: records.records.length,
        };
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
        return;
    }

    const allRuns = collectRuns(stats.records);
    const thresholds = {
        ...DEFAULT_THRESHOLDS,
        minChars: options.minChars,
        inflateFactor: options.inflateFactor,
    };
    const analysis = analyzeRuns(allRuns, thresholds);
    const runs = selectRuns(allRuns, analysis, options);
    const flagsByRun = new Map(analysis.suspects.map((entry) => [entry.run, entry.flags]));

    if (options.dump !== undefined) {
        process.stdout.write(renderDump(runs, analysis, options));
        return;
    }

    if (options.json) {
        process.stdout.write(
            `${JSON.stringify(
                {
                    files: stats.files,
                    records: stats.recordCount,
                    skipped: stats.skipped,
                    malformed: stats.malformed,
                    total: runs.length,
                    suspects: analysis.suspects.length,
                    thresholds: {
                        minChars: options.minChars,
                        inflateFactor: options.inflateFactor,
                    },
                    runs: runs.map((run) => toPlainRun(run, flagsByRun.get(run) ?? [])),
                    aggregates: {
                        routes: counts(analysis.routes),
                        failures: counts(analysis.failures),
                        flags: counts(analysis.flags),
                        invariants: counts(analysis.invariants),
                        causes: counts(analysis.causes),
                        parameters: counts(analysis.parameters),
                        divergences: counts(analysis.divergences),
                        models: counts(analysis.models),
                    },
                },
                null,
                2,
            )}\n`,
        );
        return;
    }

    process.stdout.write(`${renderReport(runs, analysis, stats, options)}\n`);
}

/** `--route`, `--suspect` and `--grep` narrow the same run list that every renderer walks. */
function selectRuns(runs, analysis, options) {
    const suspects = new Set(analysis.suspects.map((entry) => entry.run));
    const needle = options.grep?.toLowerCase();

    return runs.filter((run) => {
        if (options.route !== undefined && run.route !== options.route) {
            return false;
        }
        if (options.suspect && !suspects.has(run)) {
            return false;
        }
        if (needle !== undefined && !runText(run).toLowerCase().includes(needle)) {
            return false;
        }

        return true;
    });
}

/** Everything the model said and everything that got persisted, for `--grep`. */
function runText(run) {
    const parts = [...run.texts.values()];
    if (run.final !== undefined) {
        parts.push(run.final.text);
    }

    return parts.join("\n");
}

function counts(map) {
    return Object.fromEntries([...map.entries()].map(([key, value]) => [key, countOf(value)]));
}

// A closed pipe (`| head`, a pager quitting) must not print a stack trace over the report.
process.stdout.on("error", (error) => {
    if (error.code === "EPIPE") {
        process.exit(0);
    }

    throw error;
});

main();
