import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import resolvePermission from "../../../src/modules/sandbox/resolve";
import type { Permission } from "../../../src/modules/sandbox/permissions";

/**
 * Property-style fuzz tests for permission resolution. Deterministic (seeded
 * PRNG) so failures reproduce. The generators build *structured* command
 * chains, so the invariants can be stated in terms of what was generated:
 *
 * - token soup never crashes the resolver
 * - a chain containing an unsafe segment is never auto-allowed
 * - a chain of only known-safe pieces resolves to allow:sandbox
 * - appending an unsafe segment degrades a safe chain to ask
 * - deny dominates; explicit allow rules dominate heuristic segments
 */

// fixed seed for reproducibility; override with FUZZ_SEED to explore
const SEED = Number(process.env.FUZZ_SEED ?? 42);
const PERMISSIONS: Permission[] = ["allow", "allow:sandbox", "ask", "deny"];

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

class Rng {
    private next: () => number;
    constructor(seed: number) {
        this.next = mulberry32(seed);
    }
    int(n: number): number {
        return Math.floor(this.next() * n);
    }
    pick<T>(arr: readonly T[]): T {
        return arr[this.int(arr.length)];
    }
    chance(p: number): boolean {
        return this.next() < p;
    }
}

const SAFE_PATHS = ["file.txt", "src/index.ts", "./README.md", "sub/dir/f.md", "a b.txt", "."];

// Pathname expansion must stay unquoted to be live, so it cannot go through quoteMaybe: a quoted
// glob is a literal filename and keeps prompting on purpose. The fixture tree below is what makes
// these match real confined entries instead of falling back to the literal.
const SAFE_GLOBS = ["src/*.ts", "*.txt", "sub/*/*.md", "src/?", "nomatch-*"];

// Refused as a command argument, but not an *escape*: assignment values are never pathname-expanded,
// so `FOO=src/** cat file.txt` keeps the literal string inside the cwd and is correctly allowed.
// Keeping these out of ESCAPE_PATHS is the lesson from the first version of these seeds, which put
// them there and failed a property test that was right to complain.
const ARG_UNSAFE_PATTERNS = ["src/**", "[z-a]*", "!(*.env)", "*(a)b", "a]b"];

// Every entry must make its segment unsafe whether it appears as a command argument or as a
// leading-assignment value (`FOO=<entry> cat file.txt`), because assignment values are not
// pathname-expanded and a confined relative string stays inside the cwd. That excludes shapes like
// `src/**` or `[z-a]*`, whose argument-level refusal is pinned in heuristics.test.ts instead.
const ESCAPE_PATHS = [
    "/etc/passwd",
    "../secret.txt",
    "~/hidden",
    "/tmp/evil",
    ".env",
    ".git/config",
    "key.pem",
    "src/../../outside.txt",
    "/*",
    "~/*",
    "/etc/ho*st",
    "/tmp/pi-coder-scratchpad-*",
];

const CHAIN_OPS = ["&&", "||", ";", "|", "&"];
const BENIGN_ENV = ["FOO=bar", "CI=true", "X=1"];
const SAFE_REDIRECTS = ["> out.txt", ">> log.txt", "2>/dev/null", "< file.txt"];

function quoteMaybe(rng: Rng, s: string): string {
    return rng.chance(0.3) ? `"${s}"` : s;
}

function safeSegment(rng: Rng): string {
    const kind = rng.pick([
        "cat",
        "ls",
        "head",
        "tail",
        "wc",
        "grep",
        "sort",
        "find",
        "echo",
        "pwd",
    ] as const);
    const parts: string[] = [];

    if (rng.chance(0.2)) {
        parts.push(rng.pick(BENIGN_ENV));
    }

    parts.push(kind);

    const pathArg = () =>
        rng.chance(0.2) ? rng.pick(SAFE_GLOBS) : quoteMaybe(rng, rng.pick(SAFE_PATHS));

    switch (kind) {
        case "cat":
        case "ls":
        case "wc":
            if (rng.chance(0.6)) parts.push(pathArg());
            break;
        case "head":
        case "tail":
            parts.push("-n", "5");
            if (rng.chance(0.6)) parts.push(pathArg());
            break;
        case "grep":
            if (rng.chance(0.3)) parts.push(rng.pick(["-r", "-n", "-i"] as const));
            parts.push("foo");
            if (rng.chance(0.6)) parts.push(pathArg());
            break;
        case "sort":
            if (rng.chance(0.4)) parts.push(rng.pick(["-n", "-r"] as const));
            if (rng.chance(0.6)) parts.push(pathArg());
            break;
        case "find":
            parts.push(".");
            if (rng.chance(0.5)) parts.push("-name", "foo");
            break;
        case "echo":
            parts.push("hello");
            break;
        case "pwd":
            break;
    }

    if (rng.chance(0.15)) {
        parts.push(rng.pick(SAFE_REDIRECTS));
    }

    // safe subshell as argument (not for pwd: it takes no positionals)
    if (kind !== "pwd" && rng.chance(0.1)) {
        parts.push("$(echo file.txt)");
    }

    return parts.join(" ");
}

function unsafeSegment(rng: Rng): string {
    switch (rng.int(6)) {
        case 0:
            return rng.pick([
                "nc host 80",
                "curl example.com",
                "rm -rf build",
                "bash -c id",
                "chmod 777 x",
                "python3 -c pass",
                "sudo ls",
            ] as const);
        case 1:
            // known command, escaping/sensitive path, or a pattern shape the enumerator refuses
            return `${rng.pick(["cat", "ls", "wc", "head", "tail"] as const)} ${rng.pick([...ESCAPE_PATHS, ...ARG_UNSAFE_PATTERNS])}`;
        case 2:
            // unsafe subshell content
            return rng.pick(["cat $(nc evil)", "echo `curl evil.com`"] as const);
        case 3:
            // dangerous or escaping environment assignment
            return rng.pick([
                "LD_PRELOAD=/tmp/x.so cat file.txt",
                "PATH=/tmp/evil cat file.txt",
                `FOO=${rng.pick(ESCAPE_PATHS)} cat file.txt`,
            ] as const);
        case 4:
            // redirect escaping cwd or into a sensitive file
            return rng.pick([
                "cat file.txt > /tmp/out.txt",
                "echo x > .env",
                "echo x > ../out.txt",
            ] as const);
        default:
            // unsafe flags on known commands
            return rng.pick([
                "find . -delete",
                "find . -exec rm {} \\;",
                "sort --compress-program=/tmp/x file.txt",
                "grep -R foo .",
            ] as const);
    }
}

function chain(rng: Rng, segments: string[]): string {
    const ops: string[] = [];
    for (let i = 0; i < segments.length - 1; i++) {
        ops.push(rng.pick(CHAIN_OPS));
    }
    return segments.map((s, i) => (i < ops.length ? `${s} ${ops[i]}` : s)).join(" ");
}

function safeChain(rng: Rng): string {
    const n = 1 + rng.int(3);
    return chain(
        rng,
        Array.from({ length: n }, () => safeSegment(rng)),
    );
}

const TOKEN_SOUP = [
    "cat",
    "nc",
    "rm",
    "&&",
    "||",
    "|",
    ";",
    "&",
    ">",
    ">>",
    "2>",
    "<<",
    "EOF",
    '"',
    "'",
    "\\",
    "$(",
    ")",
    "`",
    "/etc/passwd",
    ".",
    "..",
    "~",
    "-",
    "--",
    "-rf",
    "file.txt",
    "2>&1",
    "=",
    "FOO=bar",
    "\n",
    "x",
] as const;

function tokenSoup(rng: Rng): string {
    const n = 1 + rng.int(14);
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
        parts.push(rng.pick(TOKEN_SOUP));
    }
    return parts.join(" ");
}

describe("fuzz: permission resolution invariants", () => {
    let cwd: string;

    beforeAll(() => {
        cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-fuzz-"));
        // A benign tree the SAFE_GLOBS can actually match, so the generator exercises traversal and
        // not only the zero-match fallback. Nothing sensitive is created: a real key.pem or .env in
        // this directory would correctly make `*` an unsafe operand.
        fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
        fs.mkdirSync(path.join(cwd, "sub/dir"), { recursive: true });
        fs.writeFileSync(path.join(cwd, "file.txt"), "x");
        fs.writeFileSync(path.join(cwd, "a b.txt"), "x");
        fs.writeFileSync(path.join(cwd, "README.md"), "x");
        fs.writeFileSync(path.join(cwd, "src/index.ts"), "x");
        fs.writeFileSync(path.join(cwd, "sub/dir/f.md"), "x");
    });

    afterAll(() => {
        fs.rmSync(cwd, { recursive: true, force: true });
    });

    const resolve = (command: string, permissions: Record<string, Permission> = {}) =>
        resolvePermission(command, cwd, { permissions, cwdConfinement: {} });

    // Allow headroom for this 2,000-input parser stress test when the full
    // suite runs concurrently with the other sandbox tests.
    it("never crashes on token soup and never denies without deny rules", () => {
        const rng = new Rng(SEED);
        for (let i = 0; i < 2000; i++) {
            const command = tokenSoup(rng);
            let result: Permission | undefined;
            expect(() => {
                result = resolve(command);
            }).not.toThrow();
            expect(PERMISSIONS).toContain(result);
            expect(result).not.toBe("deny");
        }
    }, 10_000);

    it("chains with an unsafe segment are never auto-allowed", () => {
        const rng = new Rng(SEED + 1);
        for (let i = 0; i < 800; i++) {
            const segments = [safeSegment(rng), safeSegment(rng)];
            segments.splice(rng.int(3), 0, unsafeSegment(rng));
            const command = chain(rng, segments);
            expect(resolve(command)).toBe("ask");
        }
    });

    it("chains of only known-safe segments resolve to allow:sandbox", () => {
        const rng = new Rng(SEED + 2);
        for (let i = 0; i < 800; i++) {
            const command = safeChain(rng);
            expect(resolve(command)).toBe("allow:sandbox");
        }
    });

    it("appending an unsafe segment degrades a safe chain to ask", () => {
        const rng = new Rng(SEED + 3);
        for (let i = 0; i < 800; i++) {
            const command = chain(rng, [safeChain(rng), unsafeSegment(rng)]);
            expect(resolve(command)).toBe("ask");
        }
    });

    it("deny rules dominate anywhere in a chain", () => {
        const rng = new Rng(SEED + 4);
        for (let i = 0; i < 800; i++) {
            const segments = [safeSegment(rng), "rm -rf build", safeSegment(rng)];
            // shuffle the rm segment to a random position
            const rmSeg = segments.splice(1, 1)[0];
            segments.splice(rng.int(3), 0, rmSeg);
            const command = chain(rng, segments);
            expect(resolve(command, { "rm *": "deny" })).toBe("deny");
        }
    });

    it("explicit allow rules dominate heuristic segments", () => {
        const rng = new Rng(SEED + 5);
        for (let i = 0; i < 800; i++) {
            const npmSeg = rng.pick(["npm test", "npm run build"] as const);
            const segments = [safeSegment(rng), npmSeg, safeSegment(rng)];
            const command = chain(rng, segments);
            expect(resolve(command, { "npm *": "allow" })).toBe("allow");
        }
    });

    it("deterministic: same seed produces same commands and verdicts", () => {
        const verdicts1: string[] = [];
        const verdicts2: string[] = [];
        const rng1 = new Rng(SEED + 6);
        const rng2 = new Rng(SEED + 6);
        for (let i = 0; i < 100; i++) {
            verdicts1.push(resolve(safeChain(rng1)));
            verdicts2.push(resolve(safeChain(rng2)));
        }
        expect(verdicts1).toEqual(verdicts2);
    });
});
