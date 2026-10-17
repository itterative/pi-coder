import type { DecisionContext } from "../../../src/modules/decision";

/**
 * Fixed decision contexts the request snapshots share.
 *
 * `packageDeploy` is the two-body case and has two pins by design: `strategies.test.ts` snapshots the
 * composite `buildRequest` output for it — the shape the probe arms used — while production no longer sends
 * that request whole. `DecisionEvaluator` splits the artifacts into one form per body, and those exact
 * per-form requests are pinned in `evaluator.test.ts`, each file named for the artifact it carries
 * (`decision-evaluator.veto.package-deploy.package.json-deploy.json`, `...scripts-deploy.js.json`).
 */
export const parentRewrite: DecisionContext = {
    command: `cd /repo && python3 - <<'PY'\nfrom pathlib import Path\np = Path("docs/agent-snapshot-gc.md")\np.write_text("## Snapshot GC\\n\\n" + p.read_text())\nPY`,
    cwd: "/repo",
    request: "add a note about snapshot GC to the docs",
    recent: [
        { role: "user", text: "add a note about snapshot GC to the docs" },
        { role: "assistant", text: "I'll put a short section at the top." },
    ],
    history: [
        "cd /repo && git status --short",
        "cd /repo && rg -n 'Snapshot GC' docs/",
        "cd /repo && sed -n '1,40p' docs/agent-snapshot-gc.md",
        "cd /repo && npm run typecheck:tests",
        `cd /repo && python3 - <<'PY'\nfrom pathlib import Path\nprint(Path("docs/agent-snapshot-gc.md").read_text()[:120])\nPY`,
        "cd /repo && git diff --stat",
    ],
};

export const scoutNote: DecisionContext = {
    command: "cd /repo && cat > notes/gate.md <<'EOF'\n- rules, then heuristics\nEOF",
    cwd: "/repo",
    runner: "scout",
    request: "map how the gate decides",
};

const workerWorktree: DecisionContext = {
    command: "git commit -am 'fix: keep the parser state'",
    cwd: "/worktree",
    runner: "worker",
    isolation: "worktree",
    request: "commit the parser fix",
};

export const packageDeploy: DecisionContext = {
    command: "npm run deploy",
    cwd: "/repo",
    request: "ship the current build",
    recent: [{ role: "assistant", text: "Running the deploy script." }],
    script: {
        kind: "package",
        artifacts: [
            {
                source: "package.json#deploy",
                path: "/repo/package.json",
                text: "node scripts/deploy.js --prod",
                identity: { mtimeMs: 1730000000000, size: 28 },
            },
            {
                source: "scripts/deploy.js",
                path: "/repo/scripts/deploy.js",
                text: "deploy({ production: true });",
                identity: { mtimeMs: 1730000001000, size: 29 },
            },
        ],
    },
};

export const FIXTURES: Record<string, DecisionContext> = {
    "parent-rewrite": parentRewrite,
    "scout-note": scoutNote,
    "worker-worktree": workerWorktree,
    "package-deploy": packageDeploy,
};

/** A payload as the request snapshots store it: two-space indent, trailing newline. */
export function indentedJson(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

/** A snapshot-safe label for an artifact source: separators and `#` become dashes. */
export function sourceLabel(source: string): string {
    return source.replaceAll("/", "-").replaceAll("#", "-");
}
