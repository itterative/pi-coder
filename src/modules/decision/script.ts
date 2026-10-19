import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { BashCommand, parseBashAst, unwrapWrapperCommand } from "../sandbox";
import type { BashAst, BashWordNode } from "../sandbox";

import type { ScriptArtifact, ScriptFileIdentity, ScriptOmission, ScriptRun } from "./types";

/**
 * Resolve the scripts a bash command runs, so the classifier judges bodies instead of names.
 *
 * The problem this exists for: `npm run test:run` and `npm run deploy` are the same shape on the command
 * line, and the risk is in the script body, which is on disk. A body is usually one indirection away from the
 * command — a package script line can itself invoke another package script, or a file — so the resolver
 * chases both:
 *
 * - **package**: `npm run|run-script <name>`, `npm test`, `npm start`, and the same `run` form for pnpm,
 *   yarn, and bun. The body is the script string in the nearest `package.json`.
 * - **file**: a known interpreter followed by literal path arguments that exist and are readable, or a
 *   command that is itself a literal path to such a file (`node scripts/deploy.js`, `./scripts/deploy.sh`).
 *   The body is the whole file.
 * - **inline**: an interpreter with `-c`/`-e`/`--eval`, or a heredoc feeding one. The literal code is a body
 *   like any other, so a capability verdict is a property of the code and not of the invocation; a dynamically
 *   built operand (`-c "$(cat file)"`) carries the kind only, because its bytes are not known here.
 * - **binary**: `npx`-family runners and `uv run`/`uvx`, whose code lives outside the repository. Kind only:
 *   the decision log then shows that the body was unavailable.
 *
 * A package script line is shell text, so the chase parses it with the same `parseBashAst` and
 * `unwrapWrapperCommand` machinery as the top-level command — never by re-tokenizing the string — and follows
 * every package-script invocation it finds, transitively. A visited set on the script name terminates a
 * cycle, and a depth cap bounds a pathological chain; either stop records an omission, so an incomplete
 * resolution is visible rather than silent, and neither clips a body that was resolved. Imports or requires
 * *inside* a file body are deliberately out of scope: the file is a body to judge, not another shell to
 * parse.
 *
 * Order is deterministic: the original script line first, then nested script lines in the order the chase
 * reached them, then file bodies in resolution order. `artifacts` is that list; `source` records provenance
 * (`package.json#deploy`, or the repo-relative path for a file) for the decision log.
 *
 * Deliberately not recognized: `yarn <name>` without `run`, `make`, and interpreter subcommands that are not
 * `-c`/`-e`/`--eval` (`deno eval`, `node -p`, `php -r`). A wrong kind would be worse than none, because the
 * log exists to say what was and was not read.
 *
 * Nothing here throws. A missing file, an unreadable file, a malformed `package.json`, or an unparseable
 * command all resolve to no body (and sometimes to a kind-only result); a consultation must degrade to a
 * prompt, never to an exception inside the permission gate.
 */

/** How many file bodies the reader memoizes. Small on purpose: each entry is a whole file. */
const READ_CACHE_LIMIT = 32;

/**
 * How many nested package-script references the chase follows below the original line.
 *
 * The cap bounds a pathological chain; reaching it records an omission instead of silently dropping a body,
 * and it never shortens a body that was resolved.
 */
const MAX_SCRIPT_DEPTH = 5;

const INTERPRETERS = new Set([
    "python",
    "python3",
    "node",
    "bash",
    "sh",
    "zsh",
    "deno",
    "ruby",
    "perl",
    "php",
    "tsx",
]);

/** Interpreter flags that put the code on the command line instead of in a file. */
const INLINE_FLAGS = new Set(["-c", "-e", "--eval"]);

/** Interpreter flags whose operand is a module, i.e. code that lives outside the repository. */
const MODULE_FLAGS = new Set(["-m"]);

/** Runners that execute a package's binary; the code is in a package, not in this checkout. */
const BINARY_RUNNERS = new Set(["npx", "bunx", "pnpx", "uvx"]);

export interface ScriptRunOptions {
    /** Directory relative paths resolve against. */
    cwd: string;
    /** Read a file whole, or throw when it cannot be read. Injected so the resolver itself never touches disk. */
    readFile: (path: string) => string;
    /** mtime and size for a path, when the reader can report them; the verdict cache keys on them. */
    statFile?: (path: string) => ScriptFileIdentity | undefined;
}

/** Resolve the scripts one command runs, or `undefined` when the command is not a recognized script run. */
export function resolveScriptRun(
    command: string,
    options: ScriptRunOptions,
): ScriptRun | undefined {
    try {
        return findScriptRun(parseBashAst(command), options);
    } catch {
        return undefined;
    }
}

function findScriptRun(ast: BashAst, options: ScriptRunOptions): ScriptRun | undefined {
    const start = cdPrefix(ast, options.cwd);
    for (const command of ast.commands.slice(start.skip)) {
        const probe = commandProbe(command, start.cwd, options);
        if (probe === undefined) {
            continue;
        }

        return runForProbe(probe, start.cwd, options);
    }

    return undefined;
}

function runForProbe(probe: ScriptProbe, cwd: string, options: ScriptRunOptions): ScriptRun {
    if (probe.kind === "package") {
        return packageRun(probe.name, cwd, options);
    }

    if (probe.kind === "file" || probe.kind === "inline") {
        return { kind: probe.kind, artifacts: probe.artifacts };
    }

    // A binary form has no body to chase; the kind alone tells the log the body was unavailable.
    return { kind: probe.kind, artifacts: [] };
}

/** The directly recognized form of one shell command, before any body is chased. */
type ScriptProbe =
    | { kind: "package"; name: string }
    | { kind: "file"; artifacts: ScriptArtifact[] }
    | { kind: "inline"; artifacts: ScriptArtifact[] }
    | { kind: "binary" };

/**
 * The cheap half of a `cd`: only a literal path as the first command of the line, and only when `&&`
 * follows, so a later command's relative path resolves where the shell would put it. Anything else falls
 * back to the caller's cwd; reproducing the sandbox's whole directory state machine is out of scope.
 */
function cdPrefix(ast: BashAst, cwd: string): { cwd: string; skip: number } {
    const [first, operator] = ast.statements[0]?.parts ?? [];
    if (operator !== "&&" || !(first instanceof BashCommand)) {
        return { cwd, skip: 0 };
    }

    const target = literalCdTarget(first);
    if (target === undefined) {
        return { cwd, skip: 0 };
    }

    return { cwd: path.resolve(cwd, target.value), skip: 1 };
}

function commandProbe(
    command: BashCommand,
    cwd: string,
    options: ScriptRunOptions,
): ScriptProbe | undefined {
    const inner = unwrapWrapperCommand(command) ?? command;
    const packageName = packageScriptName(inner);
    if (packageName !== undefined) {
        return { kind: "package", name: packageName };
    }

    if (INTERPRETERS.has(inner.command ?? "")) {
        return interpreterProbe(inner, cwd, options);
    }

    if (isBinaryRunner(inner)) {
        return { kind: "binary" };
    }

    return pathFileProbe(inner, cwd, options);
}

/** The script name of a package-manager run, before the package.json lookup. */
function packageScriptName(command: BashCommand): string | undefined {
    const args = command.positionalArgs;
    let name: string | undefined;
    switch (command.command) {
        case "npm": {
            if (args[0] === "run" || args[0] === "run-script") {
                name = args[1];
            } else if (args[0] === "test") {
                name = "test";
            } else if (args[0] === "start") {
                name = "start";
            }
            break;
        }
        case "pnpm":
        case "yarn":
        case "bun": {
            name = args[0] === "run" ? args[1] : undefined;
            break;
        }
        default:
            break;
    }

    return name === undefined || name === "" || name.startsWith("-") ? undefined : name;
}

/**
 * What one package's script lines know: the package.json every nested reference resolves against, the
 * directory npm runs the scripts in, and every `scripts` entry, so a nested lookup is not another read.
 */
interface PackageOrigin {
    packageJsonPath: string;
    packageDir: string;
    scripts: ReadonlyMap<string, string>;
}

/** One script line waiting to be walked by the chase. */
interface PendingScript {
    name: string;
    body: string;
    /** 0 for the original line; each nested reference is one deeper. */
    depth: number;
}

function packageRun(name: string, cwd: string, options: ScriptRunOptions): ScriptRun {
    for (const candidate of packageJsonPaths(cwd)) {
        let content: string;
        try {
            content = options.readFile(candidate);
        } catch {
            continue;
        }

        const scripts = packageScripts(content);
        const body = scripts?.get(name);
        if (scripts === undefined || body === undefined) {
            // The nearest package.json exists but has no such script (or is not JSON); stopping here is what
            // npm itself would do, and the kind still tells the log the body was unavailable.
            return { kind: "package", artifacts: [] };
        }

        return chasePackageScripts(
            { packageJsonPath: candidate, packageDir: path.dirname(candidate), scripts },
            { name, body, depth: 0 },
            options,
        );
    }

    return { kind: "package", artifacts: [] };
}

/**
 * Walk one package's script lines transitively, collecting the line for each and every body (file or inline)
 * they invoke.
 *
 * The queue is breadth-first, so "nested script lines in the order they appear" means the order the chase
 * reaches them: every reference of the original line before the references of its first nested line. File
 * bodies are collected while walking the same lines and appended after all lines, which is the order the
 * resolver resolved them in.
 */
function chasePackageScripts(
    origin: PackageOrigin,
    first: PendingScript,
    options: ScriptRunOptions,
): ScriptRun {
    const lines: ScriptArtifact[] = [];
    const files: ScriptArtifact[] = [];
    const omissions: ScriptOmission[] = [];
    const visited = new Set<string>([first.name]);
    const resolvedBodies = new Set<string>();
    const queue: PendingScript[] = [first];

    while (queue.length > 0) {
        const pending = queue.shift();
        if (pending === undefined) {
            break;
        }

        lines.push(packageArtifact(origin.packageJsonPath, pending.name, pending.body, options));

        const ast = parseBashAst(pending.body);
        const start = cdPrefix(ast, origin.packageDir);
        for (const command of ast.commands.slice(start.skip)) {
            const probe = commandProbe(command, start.cwd, options);
            if (probe === undefined) {
                continue;
            }

            if (probe.kind === "package") {
                const omitted = chaseStop(probe.name, pending.depth, visited, origin, options.cwd);
                if (omitted !== undefined) {
                    omissions.push(omitted);
                    continue;
                }

                const nestedBody = origin.scripts.get(probe.name);
                if (nestedBody === undefined) {
                    // A reference to a script this package does not define: nothing to resolve.
                    continue;
                }

                visited.add(probe.name);
                queue.push({ name: probe.name, body: nestedBody, depth: pending.depth + 1 });
                continue;
            }

            collectArtifacts(probe, resolvedBodies, files);
        }
    }

    return {
        kind: "package",
        artifacts: [...lines, ...files],
        ...(omissions.length === 0 ? {} : { omissions }),
    };
}

/**
 * Why a nested package-script reference cannot be followed, or `undefined` when it can.
 *
 * The visited set is checked first: a name already in the chase is a cycle whatever its depth, and naming
 * the precise reason is the point of the marker.
 */
function chaseStop(
    name: string,
    depth: number,
    visited: ReadonlySet<string>,
    origin: PackageOrigin,
    root: string,
): ScriptOmission | undefined {
    const source = packageSource(origin.packageJsonPath, name, root);
    if (visited.has(name)) {
        return { reason: "cycle", source };
    }

    if (depth + 1 > MAX_SCRIPT_DEPTH) {
        return { reason: "depth", source };
    }

    return undefined;
}

/** The nearest package.json first, then each ancestor; npm walks up the same way. */
function packageJsonPaths(cwd: string): string[] {
    const candidates: string[] = [];
    let directory = path.resolve(cwd);
    while (true) {
        candidates.push(path.join(directory, "package.json"));
        const parent = path.dirname(directory);
        if (parent === directory) {
            return candidates;
        }
        directory = parent;
    }
}

/** Every string-valued entry of a package.json's `scripts`, or `undefined` when there is no such map. */
function packageScripts(content: string): Map<string, string> | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        return undefined;
    }

    if (!isRecord(parsed) || !isRecord(parsed.scripts)) {
        return undefined;
    }

    const scripts = new Map<string, string>();
    for (const [name, body] of Object.entries(parsed.scripts)) {
        if (typeof body === "string") {
            scripts.set(name, body);
        }
    }

    return scripts;
}

function interpreterProbe(
    command: BashCommand,
    cwd: string,
    options: ScriptRunOptions,
): ScriptProbe | undefined {
    const args = command.args;
    if (args.some((arg) => MODULE_FLAGS.has(arg))) {
        return { kind: "binary" };
    }

    if (hasInlineFlag(command) || command.redirections.some((part) => part.heredoc !== undefined)) {
        return { kind: "inline", artifacts: inlineArtifacts(command) };
    }

    const artifacts = fileArtifacts(command, cwd, options);
    if (artifacts.length === 0) {
        return undefined;
    }

    return { kind: "file", artifacts };
}

/**
 * A command that is itself a path (`./scripts/deploy.sh`, `scripts/deploy.sh`) is a file body.
 *
 * The slash is required because that is what makes it a path to the shell: a bare `deploy.sh` is a PATH
 * lookup, not this directory's file.
 */
function pathFileProbe(
    command: BashCommand,
    cwd: string,
    options: ScriptRunOptions,
): ScriptProbe | undefined {
    const name = command.command;
    if (name === undefined || !name.includes("/")) {
        return undefined;
    }

    const word = command.words[command.environment.length];
    if (word === undefined || !isLiteralWord(word)) {
        return undefined;
    }

    const artifact = readFileArtifact(path.resolve(cwd, name), options);
    if (artifact === undefined) {
        return undefined;
    }

    return { kind: "file", artifacts: [artifact] };
}

/** Add the bodies a probe resolved, skipping bodies that were already collected from an earlier line. */
function collectArtifacts(
    probe: ScriptProbe,
    resolved: Set<string>,
    artifacts: ScriptArtifact[],
): void {
    if (probe.kind !== "file" && probe.kind !== "inline") {
        return;
    }

    for (const artifact of probe.artifacts) {
        // The same file invoked twice is one body in the state; an inline body is keyed by its text because it
        // has no path. The first resolution order wins.
        const key = artifact.path ?? `${artifact.source}\u0000${artifact.text}`;
        if (resolved.has(key)) {
            continue;
        }

        resolved.add(key);
        artifacts.push(artifact);
    }
}

/** Read a literal path as a file body, or nothing when it is missing, unreadable, or a directory. */
function readFileArtifact(filePath: string, options: ScriptRunOptions): ScriptArtifact | undefined {
    let text: string;
    try {
        text = options.readFile(filePath);
    } catch {
        // The path is gone, unreadable, or a directory. Without a body there is no `file` run to report;
        // guessing here would label commands such as `tsx watch` or `php -r 'code'` as file runs.
        return undefined;
    }

    return scriptArtifact(relativeSource(options.cwd, filePath), filePath, text, options.statFile);
}

/** The positional arguments that could be a script path, skipping a leading flag or a `deno run` subcommand. */
function scriptWords(command: BashCommand): BashWordNode[] {
    const positionals = command.positionalWords;
    const offset = command.command === "deno" && positionals[0]?.value === "run" ? 1 : 0;

    return positionals.slice(offset).filter((word) => word.value !== "-" && isLiteralWord(word));
}

/**
 * Every literal positional that reads as a file, in argument order and deduplicated by path.
 *
 * All of them, not just the first: a flag that takes a value puts that value in the positional list, so
 * taking only the first candidate misses the script the command actually runs — `node --import tsx
 * scripts/scratch.ts` reads as the positional `tsx` and stops. `--require ./setup.js main.js` runs code from
 * both files, and both are worth sending. More evidence is the direction this module wants; the endpoint's
 * rejection is the only cap.
 */
function fileArtifacts(
    command: BashCommand,
    cwd: string,
    options: ScriptRunOptions,
): ScriptArtifact[] {
    const seen = new Set<string>();
    const artifacts: ScriptArtifact[] = [];

    for (const word of scriptWords(command)) {
        const filePath = path.resolve(cwd, word.value);
        if (seen.has(filePath)) {
            continue;
        }

        const artifact = readFileArtifact(filePath, options);
        if (artifact === undefined) {
            continue;
        }

        seen.add(filePath);
        artifacts.push(artifact);
    }

    return artifacts;
}

/** `-c`/`-e`/`--eval` before the first operand; `bash script.sh -c` passes `-c` to the script, not bash. */
function hasInlineFlag(command: BashCommand): boolean {
    return inlineFlagIndex(command) !== undefined;
}

/**
 * The index of the first `-c`/`-e`/`--eval` word, or `undefined` when the code is not inline.
 *
 * The scan starts after the command word and stops at `--` or the first operand, so a later flag cannot make a
 * file invocation look inline.
 */
function inlineFlagIndex(command: BashCommand): number | undefined {
    for (let index = command.environment.length + 1; index < command.words.length; index++) {
        const word = command.words[index];
        if (word === undefined) {
            return undefined;
        }
        if (word.value === "--") {
            return undefined;
        }
        if (INLINE_FLAGS.has(word.value)) {
            return index;
        }
        if (!word.value.startsWith("-") || word.value === "-") {
            return undefined;
        }
    }

    return undefined;
}

/**
 * The literal code an inline interpreter form carries: the operand of `-c`/`-e`/`--eval` when it is a literal
 * word, and every heredoc body.
 *
 * The code is a property of the code, so it is classified exactly like a file body. A dynamically assembled
 * operand (`-c "$(cat file)"`) yields no artifact: its bytes are not known here, and sending the unexpanded
 * word would be a capability verdict about the wrong text.
 */
function inlineArtifacts(command: BashCommand): ScriptArtifact[] {
    const artifacts: ScriptArtifact[] = [];
    const operand = inlineCodeOperand(command);
    if (operand !== undefined) {
        const flagIndex = inlineFlagIndex(command);
        const flag = flagIndex === undefined ? undefined : command.words[flagIndex];
        artifacts.push({
            source: `inline:${command.command ?? "?"} ${flag?.value ?? "-c"}`,
            text: operand.value,
        });
    }

    for (const part of command.redirections) {
        const body = part.heredoc?.body;
        if (body !== undefined && body !== "") {
            artifacts.push({ source: "inline:heredoc", text: body });
        }
    }

    return artifacts;
}

/**
 * The literal inline code operand a command carries, or `undefined` when there is none.
 *
 * Exported for the read-only gate's confinement re-check, which must treat this argument as code rather than
 * as a path. The check is the same one `inlineArtifacts` uses: `-c`/`-e`/`--eval` before the first operand,
 * and a literal word after it.
 */
export function inlineCodeOperand(command: BashCommand): BashWordNode | undefined {
    const flagIndex = inlineFlagIndex(command);
    if (flagIndex === undefined) {
        return undefined;
    }

    const operand = command.words[flagIndex + 1];
    if (operand === undefined || !isLiteralWord(operand) || operand.value === "") {
        return undefined;
    }

    return operand;
}

function isBinaryRunner(command: BashCommand): boolean {
    if (BINARY_RUNNERS.has(command.command ?? "")) {
        return true;
    }

    return command.command === "uv" && command.positionalArgs[0] === "run";
}

function literalCdTarget(command: BashCommand): BashWordNode | undefined {
    const [target] = command.positionalWords;
    if (
        command.command !== "cd" ||
        command.flags.length > 0 ||
        command.positionalWords.length !== 1 ||
        target === undefined ||
        !isLiteralWord(target)
    ) {
        return undefined;
    }

    return target;
}

/** A word whose value is the text itself: no variables, globs, braces, tildes, or substitutions to expand. */
function isLiteralWord(word: BashWordNode): boolean {
    if (word.substitutions.length > 0) {
        return false;
    }

    const expansions = word.expansions;
    return !expansions.tilde && !expansions.glob && !expansions.brace && !expansions.variable;
}

function packageArtifact(
    packageJsonPath: string,
    name: string,
    body: string,
    options: ScriptRunOptions,
): ScriptArtifact {
    return scriptArtifact(
        packageSource(packageJsonPath, name, options.cwd),
        packageJsonPath,
        body,
        options.statFile,
    );
}

/** The source of a package script line: where the line lives and which script it is. */
function packageSource(packageJsonPath: string, name: string, root: string): string {
    return `${relativeSource(root, packageJsonPath)}#${name}`;
}

/** Provenance is relative to the caller's cwd, which is the closest thing to a repo root the resolver has. */
function relativeSource(root: string, absolutePath: string): string {
    const relative = path.relative(root, absolutePath);
    return relative === "" ? absolutePath : relative;
}

function scriptArtifact(
    source: string,
    filePath: string,
    text: string,
    statFile: ScriptRunOptions["statFile"],
): ScriptArtifact {
    const identity = statFile?.(filePath);
    return {
        source,
        path: filePath,
        text,
        ...(identity === undefined ? {} : { identity }),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const bodyCache = new Map<string, string>();

/**
 * Read a file for the resolver, memoized by absolute path, mtime, and size.
 *
 * The cache exists so an unchanged script is not read again on every consult; a changed mtime or size misses,
 * so a stale body can never be sent. Bounded and oldest-first, because a script can be large and this is a
 * long-lived process. Throws exactly as `readFileSync` does, so the resolver keeps its no-body path.
 */
export function readScriptFile(absolutePath: string): string {
    const identity = scriptFileIdentity(absolutePath);
    const key =
        identity === undefined
            ? absolutePath
            : `${absolutePath}\u0000${identity.mtimeMs}\u0000${identity.size}`;
    const cached = bodyCache.get(key);
    if (cached !== undefined) {
        return cached;
    }

    const body = fs.readFileSync(absolutePath, "utf8");
    if (bodyCache.size >= READ_CACHE_LIMIT) {
        const oldest = bodyCache.keys().next().value;
        if (oldest !== undefined) {
            bodyCache.delete(oldest);
        }
    }
    bodyCache.set(key, body);

    return body;
}

/** The mtime and size the read cache and the verdict cache key on; `undefined` when the file cannot be read. */
export function scriptFileIdentity(absolutePath: string): ScriptFileIdentity | undefined {
    try {
        const stat = fs.statSync(absolutePath);
        return { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
        return undefined;
    }
}

/**
 * The content identity of a script body: what the script verdict is a property of.
 *
 * The evaluator keys a body's answer cache on this, so the same bytes share one verdict no matter which
 * command invoked them, how the file's mtime moved, or what the session said. It is content, where the read
 * cache's path/mtime/size is only a budget for not re-reading a file.
 */
export function scriptContentHash(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Drop the memoized script bodies, so tests do not inherit another case's files. */
export function resetDecisionScriptCache(): void {
    bodyCache.clear();
}
