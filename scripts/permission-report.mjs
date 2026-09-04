#!/usr/bin/env node
/**
 * Mine the bash permission decision log written by
 * `src/modules/sandbox/decision-log.ts`.
 *
 * The point is development triage: which commands keep getting approved by hand
 * (heuristic or curated-rule candidates), which get refused (anti-patterns that
 * must not be widened), and what the existing rules and suggestions actually do.
 *
 * Usage:
 *   node scripts/permission-report.mjs [options]
 *
 *   --path <file>      log file (default: $SANDBOX_DECISION_LOG_PATH or the
 *                      extension's .state/bash-log.jsonl; a sibling `.1`
 *                      rotation file is included automatically)
 *   --since <dur>      only records newer than this age, e.g. 90m, 24h, 7d
 *   --surface <name>   parent | child
 *   --agent <name>     only records from this delegated agent
 *   --prompted         only records where a human was asked
 *   --group-depth <n>  tokens per group key (default: 3)
 *   --all-gaps         one row per uncovered segment instead of one per record
 *   --limit <n>        rows per section (default: 25)
 *   --json             emit machine-readable aggregates instead of a report
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- arg parsing

const USAGE = `usage: node scripts/permission-report.mjs [options]\n${describeOptions()}`;

function describeOptions() {
    return [
        "  --path <file>       log file (default $SANDBOX_DECISION_LOG_PATH or .state/bash-log.jsonl)",
        "  --since <dur>       only newer than 90m | 24h | 7d",
        "  --surface <name>    parent | child",
        "  --agent <name>      filter by delegated agent name",
        "  --prompted          only records that a human was asked about",
        "  --group-depth <n>   tokens per group key (default 3)",
        "  --all-gaps          count every uncovered segment, not one row per record",
        "  --limit <n>         rows per section (default 25)",
        "  --json              machine-readable aggregates",
        "  --help              this message",
    ].join("\n");
}

function parseArgs(argv) {
    const options = {
        path: undefined,
        since: undefined,
        surface: undefined,
        agent: undefined,
        prompted: false,
        groupDepth: 3,
        allGaps: false,
        limit: 25,
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
        } else if (arg === "--prompted") {
            options.prompted = true;
        } else if (arg === "--all-gaps") {
            options.allGaps = true;
        } else if (arg === "--json") {
            options.json = true;
        } else if (arg === "--path") {
            options.path = next();
        } else if (arg === "--since") {
            options.since = next();
        } else if (arg === "--surface") {
            options.surface = next();
        } else if (arg === "--agent") {
            options.agent = next();
        } else if (arg === "--group-depth") {
            options.groupDepth = Number.parseInt(next(), 10);
        } else if (arg === "--limit") {
            options.limit = Number.parseInt(next(), 10);
        } else {
            throw new Error(`unknown argument: ${arg}\n${USAGE}`);
        }
    }

    if (!Number.isFinite(options.groupDepth) || options.groupDepth < 1) {
        throw new Error("--group-depth must be a positive integer");
    }
    if (!Number.isFinite(options.limit) || options.limit < 1) {
        throw new Error("--limit must be a positive integer");
    }
    if (
        options.surface !== undefined &&
        options.surface !== "parent" &&
        options.surface !== "child"
    ) {
        throw new Error("--surface must be 'parent' or 'child'");
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
    const fromEnv = nonEmpty(process.env.SANDBOX_DECISION_LOG_PATH);
    if (fromEnv !== undefined) {
        return fromEnv;
    }

    // The writer's default: PI_CODER_STATE_DIR, resolved from the installed
    // extension root so source and compiled layouts agree.
    return path.join(fileURLToPath(new URL("..", import.meta.url)), ".state", "bash-log.jsonl");
}

/** Treat an unset or blank value as absent so the default can apply. */
function nonEmpty(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

function collectFiles(explicitPath) {
    const primary = explicitPath ?? defaultLogPath();
    if (!fs.existsSync(primary)) {
        return [];
    }

    const rotated = `${primary}.1`;
    return fs.existsSync(rotated) ? [rotated, primary] : [primary];
}

function* readRecords(file) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let lineNumber = 0;

    for (const line of lines) {
        lineNumber += 1;
        if (line.trim() === "") {
            continue;
        }

        try {
            yield JSON.parse(line);
        } catch {
            process.stderr.write(`${file}:${lineNumber}: skipping unparsable line\n`);
        }
    }
}

function loadRecords(options) {
    const files = collectFiles(options.path);
    if (files.length === 0) {
        throw new Error(
            `no decision log found at ${options.path ?? defaultLogPath()}\n` +
                "the gate writes it automatically; run some commands, or pass --path",
        );
    }

    const cutoff = options.since === undefined ? null : Date.now() - parseDuration(options.since);
    const records = [];
    let skipped = 0;

    for (const file of files) {
        for (const record of readRecords(file)) {
            if (
                record === null ||
                typeof record !== "object" ||
                typeof record.command !== "string"
            ) {
                skipped += 1;
                continue;
            }
            if (cutoff !== null && Date.parse(record.ts ?? "") < cutoff) {
                continue;
            }
            if (options.surface !== undefined && record.surface !== options.surface) {
                continue;
            }
            if (options.agent !== undefined && record.agent !== options.agent) {
                continue;
            }
            if (options.prompted && record.prompt === undefined) {
                continue;
            }

            records.push(record);
        }
    }

    return { records, files, skipped };
}

// --------------------------------------------------------------- aggregation

/** Collapse the volatile parts of a command into a shape that groups well. */
function normalizeToken(token) {
    if (/^[./~]/.test(token) || token.includes("/")) {
        return "<path>";
    }
    if (/^-?\d+(\.\d+)?$/.test(token)) {
        return "<n>";
    }
    if (/^[0-9a-f]{7,}$/.test(token)) {
        return "<sha>";
    }
    if (/[=]/.test(token) && !token.startsWith("-")) {
        return "<kv>";
    }
    if (/^.+\.(ts|js|mjs|cjs|json|py|go|rs|md|txt|sh|yaml|yml|toml)$/.test(token)) {
        return "<file>";
    }
    return token;
}

/**
 * Words that carry no command of their own: the record already shows the line,
 * so they would only add noise to a group key.
 */
const CONTROL_FLOW_WORDS = new Set([
    "do",
    "done",
    "then",
    "else",
    "elif",
    "fi",
    "esac",
    "in",
    "{",
    "}",
]);

/** Words that introduce the real command of a segment and can be dropped from it. */
const CONTROL_FLOW_PREFIXES = new Set(["do", "then", "else", "elif", "time"]);

/** Strip a leading control-flow word so `do echo hi` groups as `echo hi`. */
function dropControlFlowPrefix(tokens) {
    if (tokens.length > 1 && CONTROL_FLOW_PREFIXES.has(tokens[0])) {
        return tokens.slice(1);
    }
    return [...tokens];
}

/** True when nothing but control-flow words remains, such as a bare `done`. */
function isControlFlowNoise(tokens) {
    return tokens.length > 0 && tokens.every((token) => CONTROL_FLOW_WORDS.has(token));
}

/**
 * Uncovered segments of a decision — the part of the line that actually needed
 * the human, with shell control-flow noise removed. Falls back to the raw
 * unresolved segments when normalization would leave nothing to group on.
 */
function gapSegments(record) {
    const unresolved = (record.resolution?.segments ?? []).filter(
        (segment) => segment.source === "unresolved",
    );

    const gaps = [];
    for (const segment of unresolved) {
        const tokens = dropControlFlowPrefix(segment.tokens ?? []);
        if (isControlFlowNoise(tokens)) {
            continue;
        }
        gaps.push({ ...segment, tokens });
    }

    return gaps.length > 0 ? gaps : unresolved;
}

function shapeOf(tokens, depth) {
    if (!Array.isArray(tokens) || tokens.length === 0) {
        return "<empty>";
    }

    return tokens
        .filter((token) => token !== undefined && token !== "")
        .slice(0, depth)
        .map(normalizeToken)
        .join(" ");
}

/** Cap a composite key so a long loop stays readable; the `+N` suffix counts the rest. */
function joinShapes(shapes, max = 3) {
    if (shapes.length <= max) {
        return shapes.join(" + ");
    }

    return `${shapes.slice(0, max).join(" + ")} (+${shapes.length - max})`;
}

/**
 * Group keys for one record. A decision with several uncovered segments gets a
 * composite key by default, so a formatter hiding behind a heredoc stays visible;
 * `--all-gaps` counts every segment on its own row instead.
 */
function recordShapes(record, options) {
    const gaps = gapSegments(record);
    if (gaps.length > 0) {
        const shapes = gaps.map((segment) => shapeOf(segment.tokens, options.groupDepth));
        return options.allGaps ? shapes : [joinShapes(shapes)];
    }

    const segments = record.resolution?.segments ?? [];
    if (segments.length > 0) {
        return [segments.map((segment) => shapeOf(segment.tokens, options.groupDepth)).join(" ; ")];
    }

    return [shapeOf(record.command.trim().split(/\s+/), options.groupDepth)];
}

function bump(map, key, value) {
    const bucket = map.get(key);
    if (bucket === undefined) {
        map.set(key, value());
        return map.get(key);
    }
    return bucket;
}

function newGroup() {
    return {
        count: 0,
        examples: [],
        notes: [],
        suggestions: new Map(),
        rules: new Map(),
        agents: new Set(),
        surfaces: new Set(),
        lastTs: "",
    };
}

function addRecord(group, record) {
    group.count += 1;
    group.lastTs = group.lastTs < (record.ts ?? "") ? record.ts : group.lastTs;
    if (group.examples.length < 3 && !group.examples.includes(record.command)) {
        group.examples.push(record.command);
    }
    if (record.agent !== undefined) {
        group.agents.add(record.agent);
    }
    group.surfaces.add(record.surface);
    if (record.note !== undefined && !group.notes.includes(record.note)) {
        group.notes.push(record.note);
    }
    if (record.prompt?.suggestion !== undefined) {
        group.suggestions.set(
            record.prompt.suggestion,
            (group.suggestions.get(record.prompt.suggestion) ?? 0) + 1,
        );
    }
    if (record.prompt?.rule !== undefined) {
        group.rules.set(record.prompt.rule, (group.rules.get(record.prompt.rule) ?? 0) + 1);
    }
}

function isApproved(record) {
    return record.blocked !== true;
}

function analyze(records, options) {
    const promptedApproved = new Map();
    const promptedDenied = new Map();
    const heuristicGrants = new Map();
    const unasked = new Map();
    const ruleHits = new Map();

    for (const record of records) {
        const keys = recordShapes(record, options);

        if (record.prompt !== undefined) {
            const target = isApproved(record) ? promptedApproved : promptedDenied;
            for (const key of keys) {
                addRecord(bump(target, key, newGroup), record);
            }
            continue;
        }

        if (record.resolution?.source === "heuristic") {
            for (const key of keys) {
                addRecord(bump(heuristicGrants, key, newGroup), record);
            }
        } else if (record.resolution?.source === "unresolved") {
            // No human was consulted although nothing covered the command: a
            // headless child denial, or a gate that could not open a dialog.
            for (const key of keys) {
                addRecord(bump(unasked, key, newGroup), record);
            }
        }

        const pattern = record.resolution?.pattern;
        if (pattern !== undefined && pattern !== null) {
            const patternKey = `${pattern}\t${record.resolution.permission}`;
            ruleHits.set(patternKey, (ruleHits.get(patternKey) ?? 0) + 1);
        }
    }

    return { promptedApproved, promptedDenied, heuristicGrants, unasked, ruleHits };
}

// -------------------------------------------------------------------- output

function topEntries(map, limit) {
    return [...map.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .slice(0, limit);
}

function singleLine(text, max = 90) {
    const flat = text.replaceAll("\n", " ⏎ ").trim();
    return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function mostUsed(map) {
    let best = "";
    let bestCount = 0;
    for (const [key, count] of map) {
        if (count > bestCount) {
            best = key;
            bestCount = count;
        }
    }
    return best;
}

function renderGroupSection(title, blurb, map, options) {
    const rows = topEntries(map, options.limit);
    const lines = ["", `${title} (${map.size} distinct, showing ${rows.length})`, blurb, ""];
    if (rows.length === 0) {
        lines.push("  none");
        return lines.join("\n");
    }

    for (const [key, group] of rows) {
        lines.push(`  ${String(group.count).padStart(4)}x  ${key}`);
        for (const example of group.examples) {
            lines.push(`          e.g. ${singleLine(example)}`);
        }
        const rule = mostUsed(group.rules);
        if (rule !== "") {
            lines.push(`          remembered rule: ${rule}`);
        }
        const suggestion = mostUsed(group.suggestions);
        if (suggestion !== "") {
            lines.push(`          offered rule:    ${suggestion}`);
        }
        for (const note of group.notes.slice(0, 2)) {
            lines.push(`          user note:       ${singleLine(note, 70)}`);
        }
        if (group.agents.size > 0) {
            lines.push(`          agents:          ${[...group.agents].join(", ")}`);
        }
    }

    return lines.join("\n");
}

/** Explain how uncovered segments were counted, since it changes what a row means. */
function gapViewNote(options) {
    if (options.allGaps) {
        return "counting each uncovered segment separately (--all-gaps); counts exceed records";
    }

    return "one row per record with every uncovered segment joined by ' + ' (--all-gaps splits them)";
}

function renderReport(records, stats, options) {
    const out = [];
    out.push(`bash permission decision report`);
    out.push(`  files:   ${stats.files.join(", ")}`);
    out.push(
        `  records: ${records.length}${stats.skipped > 0 ? ` (${stats.skipped} unparsable skipped)` : ""}`,
    );
    if (records.length > 0) {
        out.push(`  span:    ${records[0].ts} → ${records[records.length - 1].ts}`);
    }

    const prompted = records.filter((record) => record.prompt !== undefined).length;
    const denied = records.filter((record) => !isApproved(record)).length;
    out.push(`  prompted: ${prompted}   blocked: ${denied}`);
    out.push(`  gaps: ${gapViewNote(options)}`);

    out.push(
        renderGroupSection(
            "APPROVED AFTER PROMPT",
            "  candidates for a heuristic spec or a curated rules entry — humans kept saying yes",
            stats.analysis.promptedApproved,
            options,
        ),
    );
    out.push(
        renderGroupSection(
            "REFUSED AT PROMPT",
            "  anti-patterns: do not widen coverage for these, and check why they were suggested",
            stats.analysis.promptedDenied,
            options,
        ),
    );
    out.push(
        renderGroupSection(
            "AUTO-ALLOWED BY HEURISTIC",
            "  what cwd confinement already grants silently — verify these are still intended",
            stats.analysis.heuristicGrants,
            options,
        ),
    );
    out.push(
        renderGroupSection(
            "UNCOVERED WITHOUT A PROMPT",
            "  blocked because no human could be asked — usually a headless child needing a rule",
            stats.analysis.unasked,
            options,
        ),
    );

    const ruleRows = [...stats.analysis.ruleHits.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, options.limit);
    out.push(
        "",
        `RULE HITS (${ruleRows.length} shown)`,
        "  which configured patterns actually fire",
        "",
    );
    if (ruleRows.length === 0) {
        out.push("  none");
    }
    for (const [key, count] of ruleRows) {
        const [pattern, permission] = key.split("\t");
        out.push(`  ${String(count).padStart(4)}x  ${permission.padEnd(13)} ${pattern}`);
    }

    return out.join("\n");
}

// ----------------------------------------------------------------- main flow

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

    let records;
    let files;
    let skipped;
    try {
        const loaded = loadRecords(options);
        records = loaded.records;
        files = loaded.files;
        skipped = loaded.skipped;
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
        return;
    }

    records.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));
    const analysis = analyze(records, options);

    if (options.json) {
        const toPlain = (map) =>
            Object.fromEntries(
                [...map.entries()].map(([key, group]) => [
                    key,
                    {
                        count: group.count,
                        examples: group.examples,
                        notes: group.notes,
                        rules: Object.fromEntries(group.rules),
                        suggestions: Object.fromEntries(group.suggestions),
                        agents: [...group.agents],
                        surfaces: [...group.surfaces],
                        lastTs: group.lastTs,
                    },
                ]),
            );

        process.stdout.write(
            `${JSON.stringify(
                {
                    files,
                    total: records.length,
                    gapView: options.allGaps ? "segments" : "records",
                    prompted: records.filter((record) => record.prompt !== undefined).length,
                    blocked: records.filter((record) => !isApproved(record)).length,
                    promptedApproved: toPlain(analysis.promptedApproved),
                    promptedDenied: toPlain(analysis.promptedDenied),
                    heuristicGrants: toPlain(analysis.heuristicGrants),
                    unasked: toPlain(analysis.unasked),
                    ruleHits: Object.fromEntries(analysis.ruleHits),
                },
                null,
                2,
            )}\n`,
        );
        return;
    }

    process.stdout.write(`${renderReport(records, { files, skipped, analysis }, options)}\n`);
}

main();
