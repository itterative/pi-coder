/**
 * Memory-tree audit.
 *
 * Validates the indexed memory trees (project `.pi/agent/memory/` and user
 * `~/.pi/agent/memory/`) with the same parser that decides what an agent actually sees, so a
 * memory that silently fails to index cannot pass an audit that used a different reader.
 *
 * The checks encode the two-tier convention: top-level files are indexes that appear in every
 * system prompt, and nested files are on-demand reference docs reachable only through an index.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { FrontmatterParseError, parseFrontmatter, type MemoryMeta } from "./frontmatter";

/**
 * Advisory budget for a top-level index: its whole body lands in each session prompt. This is a review
 * signal, not a hard limit - a deliberately dense index is a legitimate choice.
 */
export const INDEX_BUDGET_BYTES = 8192;

/** Advisory limit for indexed descriptions, which are rendered verbatim into every system prompt. */
const INDEXED_DESCRIPTION_LIMIT = 150;

const KNOWN_CATEGORIES = ["architecture", "meta", "workflow", "tools", "convention"];

type AuditSeverity = "error" | "warning";

type AuditRule =
    | "frontmatter"
    | "name"
    | "description"
    | "category"
    | "index-budget"
    | "reachability"
    | "dangling-reference"
    | "broken-link"
    | "stale-memory-reference";

export interface AuditFinding {
    severity: AuditSeverity;
    /** POSIX path relative to the audited memory directory. */
    path: string;
    rule: AuditRule;
    message: string;
}

export interface AuditResult {
    label: "project" | "user";
    dir: string;
    indexed: number;
    nested: number;
    findings: AuditFinding[];
}

interface MemoryFile {
    /** POSIX path relative to the memory directory. */
    rel: string;
    abs: string;
    indexed: boolean;
    text: string;
}

/** Audit both memory trees, sharing the name set so cross-tree references are not misreported. */
export async function auditMemoryTrees(options: {
    projectDir: string;
    userDir: string;
    projectRoot: string;
}): Promise<AuditResult[]> {
    const [projectFiles, userFiles] = await Promise.all([
        loadMemoryFiles(options.projectDir),
        loadMemoryFiles(options.userDir),
    ]);

    const indexedNames = new Set<string>();
    for (const files of [projectFiles, userFiles]) {
        for (const file of files.filter((entry) => entry.indexed)) {
            const meta = parseMeta(file);
            if (meta) {
                indexedNames.add(meta.name.toLowerCase());
            }
        }
    }

    const results: AuditResult[] = [];
    for (const [label, files] of [
        ["project", projectFiles],
        ["user", userFiles],
    ] as const) {
        results.push(buildResult(label, options, files, indexedNames));
    }

    return results;
}

async function loadMemoryFiles(dir: string): Promise<MemoryFile[]> {
    if (!existsSync(dir)) {
        return [];
    }

    const files: MemoryFile[] = [];
    await collectMarkdown(dir, "", files);
    return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

async function collectMarkdown(dir: string, prefix: string, out: MemoryFile[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
        const abs = join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
            await collectMarkdown(abs, rel, out);
            continue;
        }

        if (!entry.isFile() || !entry.name.endsWith(".md")) {
            continue;
        }

        out.push({
            rel,
            abs,
            indexed: !rel.includes("/"),
            text: await readFile(abs, "utf8"),
        });
    }
}

function buildResult(
    label: "project" | "user",
    options: { projectDir: string; userDir: string; projectRoot: string },
    files: MemoryFile[],
    knownNames: Set<string>,
): AuditResult {
    const findings: AuditFinding[] = [];
    const dir = label === "project" ? options.projectDir : options.userDir;

    findings.push(...checkIndexed(dir, files));
    findings.push(...checkFrontmatter(files));
    findings.push(...checkReachability(files));
    findings.push(...checkDanglingReferences(files));
    findings.push(...checkBrokenLinks(files, dir, options.projectRoot));
    findings.push(...checkStaleMemoryReferences(files, knownNames));

    return {
        label,
        dir,
        indexed: files.filter((file) => file.indexed).length,
        nested: files.filter((file) => !file.indexed).length,
        findings: sortFindings(findings),
    };
}

function parseMeta(file: MemoryFile): MemoryMeta | undefined {
    try {
        return parseFrontmatter(file.text, file.abs);
    } catch {
        return undefined;
    }
}

/** The indexed tree is the one the extension actually reads, so report its real failures. */
function checkIndexed(dir: string, files: MemoryFile[]): AuditFinding[] {
    const findings: AuditFinding[] = [];
    for (const file of files.filter((entry) => entry.indexed)) {
        const rel = relative(dir, file.abs).split("\\").join("/");
        findings.push(...checkIndexedFile(file, rel));
    }
    return findings;
}

function checkIndexedFile(file: MemoryFile, rel: string): AuditFinding[] {
    const findings: AuditFinding[] = [];
    const size = Buffer.byteLength(file.text, "utf8");

    if (size > INDEX_BUDGET_BYTES) {
        findings.push({
            severity: "warning",
            path: rel,
            rule: "index-budget",
            message: `index body is ${size} bytes (advisory budget ${INDEX_BUDGET_BYTES}); consider moving detail into a nested doc`,
        });
    }

    if (!hasFrontmatterBlock(file.text)) {
        findings.push({
            severity: "error",
            path: rel,
            rule: "frontmatter",
            message:
                "no frontmatter block; scanMemories drops this memory from every system prompt",
        });
        return findings;
    }

    let meta: MemoryMeta;
    try {
        meta = parseFrontmatter(file.text, file.abs);
    } catch (error) {
        const reason = error instanceof FrontmatterParseError ? error.message : String(error);
        findings.push({
            severity: "error",
            path: rel,
            rule: "frontmatter",
            message: `invalid frontmatter (${reason}); this memory is not indexed`,
        });
        return findings;
    }

    if (meta.name !== file.rel.slice(0, -3)) {
        findings.push({
            severity: "error",
            path: rel,
            rule: "name",
            message: `name "${meta.name}" must match the filename stem "${file.rel.slice(0, -3)}"`,
        });
    }

    if (meta.description.length > INDEXED_DESCRIPTION_LIMIT) {
        findings.push({
            severity: "warning",
            path: rel,
            rule: "description",
            message: `description is ${meta.description.length} chars (advisory limit ${INDEXED_DESCRIPTION_LIMIT}); it is rendered into every system prompt`,
        });
    }

    const rawCategory = readFrontmatterValue(file.text, "category");
    if (rawCategory !== undefined && rawCategory !== rawCategory.toLowerCase()) {
        findings.push({
            severity: "warning",
            path: rel,
            rule: "category",
            message: `category "${rawCategory}" is not lowercase; it renders its own section instead of joining "${rawCategory.toLowerCase()}"`,
        });
    }

    if (
        rawCategory !== undefined &&
        !KNOWN_CATEGORIES.includes(rawCategory.toLowerCase()) &&
        rawCategory === rawCategory.toLowerCase()
    ) {
        findings.push({
            severity: "warning",
            path: rel,
            rule: "category",
            message: `category "${rawCategory}" is unknown; it renders as its own titled section`,
        });
    }

    return findings;
}

function checkFrontmatter(files: MemoryFile[]): AuditFinding[] {
    const findings: AuditFinding[] = [];

    for (const file of files.filter((entry) => !entry.indexed)) {
        if (!hasFrontmatterBlock(file.text)) {
            findings.push({
                severity: "warning",
                path: file.rel,
                rule: "frontmatter",
                message: "nested doc has no frontmatter; add name/description for consistency",
            });
            continue;
        }

        findings.push(...checkNestedFrontmatter(file));
    }

    return findings;
}

function checkNestedFrontmatter(file: MemoryFile): AuditFinding[] {
    const stem = file.rel.split("/").pop()!.slice(0, -3);

    let meta: MemoryMeta;
    try {
        meta = parseFrontmatter(file.text, file.abs);
    } catch (error) {
        const reason = error instanceof FrontmatterParseError ? error.message : String(error);
        return [
            {
                severity: "warning",
                path: file.rel,
                rule: "frontmatter",
                message: `nested doc has invalid frontmatter (${reason})`,
            },
        ];
    }

    if (meta.name !== stem) {
        return [
            {
                severity: "warning",
                path: file.rel,
                rule: "name",
                message: `name "${meta.name}" does not match the filename stem "${stem}"`,
            },
        ];
    }

    return [];
}

/** A nested doc that no index names is unreachable: nothing lists it and nothing links to it. */
function checkReachability(files: MemoryFile[]): AuditFinding[] {
    const indexText = files
        .filter((file) => file.indexed)
        .map((file) => file.text)
        .join("\n");

    return files
        .filter((file) => !file.indexed)
        .filter((file) => !indexText.includes(file.rel))
        .map((file) => ({
            severity: "warning" as const,
            path: file.rel,
            rule: "reachability" as const,
            message:
                "no indexed memory names this nested doc, so an agent can reach it only from another nested doc",
        }));
}

/** An index may not name a nested path that does not exist. */
function checkDanglingReferences(files: MemoryFile[]): AuditFinding[] {
    const existing = new Set(files.map((file) => file.rel));
    const directories = new Set(
        files
            .filter((file) => !file.indexed)
            .map((file) => file.rel.split("/")[0]!)
            .concat(listNestedDirsFromPaths(files)),
    );
    const findings: AuditFinding[] = [];

    for (const file of files.filter((entry) => entry.indexed)) {
        for (const match of file.text.matchAll(/`([^`\n]+\.md)`|\]\(([^)\s]+\.md)\)/g)) {
            const target = (match[1] ?? match[2] ?? "").trim();
            if (!looksLikeMemoryPath(target, directories)) {
                continue;
            }

            if (!existing.has(target)) {
                findings.push({
                    severity: "error",
                    path: file.rel,
                    rule: "dangling-reference",
                    message: `names "${target}", which does not exist in this memory tree`,
                });
            }
        }
    }

    return dedupe(findings);
}

function listNestedDirsFromPaths(files: MemoryFile[]): string[] {
    return files.filter((file) => !file.indexed).map((file) => file.rel.split("/")[0]!);
}

function looksLikeMemoryPath(target: string, directories: Set<string>): boolean {
    if (target.startsWith("/") || /^[a-z]+:\/\//i.test(target)) {
        return false;
    }

    if (target.includes("../") || target.includes("./")) {
        return false;
    }

    // A bare "foo.md" is ambiguous with repo filenames, so only scoped paths are checked here.
    const head = target.split("/")[0];
    return target.includes("/") && head !== undefined && directories.has(head);
}

/** Relative markdown links must resolve from the doc that carries them. */
function checkBrokenLinks(
    files: MemoryFile[],
    memoryDir: string,
    projectRoot: string,
): AuditFinding[] {
    const findings: AuditFinding[] = [];

    for (const file of files) {
        for (const match of file.text.matchAll(/\]\(([^)#\s]+\.md)\)/g)) {
            const target = match[1]!;
            if (target.startsWith("/") || /^[a-z]+:\/\//i.test(target)) {
                continue;
            }

            if (linkResolves(target, file, memoryDir, projectRoot)) {
                continue;
            }

            findings.push({
                severity: "error",
                path: file.rel,
                rule: "broken-link",
                message: `link target "${target}" does not resolve (a file moved one level deeper needs one more "../")`,
            });
        }
    }

    return findings;
}

function linkResolves(
    target: string,
    file: MemoryFile,
    memoryDir: string,
    projectRoot: string,
): boolean {
    // An explicit relative link belongs to the file that carries it: resolving `../` links against the
    // memory dir or the project root would hide exactly the bug this rule exists to catch - a doc moved
    // one level deeper without adding a `../`.
    if (target.startsWith("./") || target.startsWith("../")) {
        return existsSync(resolve(dirname(file.abs), target));
    }

    return [
        resolve(dirname(file.abs), target),
        resolve(memoryDir, target),
        resolve(projectRoot, target),
    ].some((candidate) => existsSync(candidate));
}

/** "see the `heuristics` memory" outlives its memory when the tree is restructured. */
function checkStaleMemoryReferences(files: MemoryFile[], knownNames: Set<string>): AuditFinding[] {
    const findings: AuditFinding[] = [];

    for (const file of files) {
        for (const match of file.text.matchAll(/`([a-z0-9][a-z0-9_-]{1,63})`\s+memory/g)) {
            const name = match[1]!;
            const line = lineAt(file.text, match.index ?? 0);

            if (knownNames.has(name)) {
                continue;
            }

            if (isHistoricalFraming(line)) {
                continue;
            }

            findings.push({
                severity: "warning",
                path: file.rel,
                rule: "stale-memory-reference",
                message: `refers to the "${name}" memory, which is not an indexed memory name; name the final path instead`,
            });
        }
    }

    return dedupe(findings);
}

function isHistoricalFraming(line: string): boolean {
    return /(former|old|previously|retired|no longer|archive)/i.test(line);
}

function lineAt(text: string, index: number): string {
    const start = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
    const end = text.indexOf("\n", index);
    return text.slice(start, end === -1 ? text.length : end);
}

function hasFrontmatterBlock(text: string): boolean {
    return /^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(text);
}

function readFrontmatterValue(text: string, key: string): string | undefined {
    const match = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(text.split("\n---\n", 1)[0] ?? text);

    if (!match) {
        return undefined;
    }

    return match[1]!.trim().replace(/^["']|["']$/g, "");
}

function sortFindings(findings: AuditFinding[]): AuditFinding[] {
    return findings.toSorted((a, b) => {
        const severity = a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1;
        if (severity !== 0) {
            return severity;
        }

        const rule = a.rule.localeCompare(b.rule);
        if (rule !== 0) {
            return rule;
        }

        return a.path.localeCompare(b.path) || a.message.localeCompare(b.message);
    });
}

function dedupe(findings: AuditFinding[]): AuditFinding[] {
    const seen = new Set<string>();
    const kept: AuditFinding[] = [];

    for (const finding of findings) {
        const key = `${finding.path} ${finding.rule} ${finding.message}`;
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        kept.push(finding);
    }

    return kept;
}

/** Compact one-line-per-tree summary, for `ctx.ui.notify` and tool headers. */
export function summarizeAudit(results: AuditResult[]): string {
    return results
        .map((result) => {
            const errors = result.findings.filter((f) => f.severity === "error").length;
            const warnings = result.findings.length - errors;
            return `${result.label}: ${result.indexed} indexed, ${result.nested} nested, ${errors} errors, ${warnings} warnings`;
        })
        .join(" · ");
}

/** Full report text: findings grouped per tree, errors first, plus the tree line. */
export function formatAuditReport(results: AuditResult[]): string {
    const hasWarnings = results.some((result) =>
        result.findings.some((finding) => finding.severity === "warning"),
    );
    const blocks = results.map((result) => {
        const lines = [`${result.label} memory tree: ${result.dir}`];

        if (result.findings.length === 0) {
            lines.push(`  no findings (${result.indexed} indexed, ${result.nested} nested)`);
            return lines.join("\n");
        }

        for (const finding of result.findings) {
            const marker = finding.severity === "error" ? "ERROR" : "warn ";
            lines.push(`  ${marker} ${finding.path} [${finding.rule}] ${finding.message}`);
        }

        return lines.join("\n");
    });

    return `${summarizeAudit(results)}\n\n${blocks.join("\n\n")}${hasWarnings ? WarningsLegend : ""}`;
}

/** Said out loud because an advisory number is not a defect: see the tool description. */
export const WarningsLegend =
    "\n\nWarnings are review indicators, not defects. Fix the ones that hide content (an unindexed memory, an unreachable nested doc, a broken or stale reference); leave a deliberate index size or description length alone and say why.";
