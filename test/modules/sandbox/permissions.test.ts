import { describe, it, expect } from "vitest";
import getPermission, {
    getArgsPermissionMatch,
    Permission,
} from "../../../src/modules/sandbox/permissions";

interface PermissionTest {
    desc: string;
    command: string;
    permissions: Record<string, Permission>;
    expected: Permission;
}

const testPermission = (test: PermissionTest) => {
    expect(getPermission(test.command, test.permissions)).toBe(test.expected);
};

const runTests = (tests: PermissionTest[]) => {
    it.each(tests)("$desc", testPermission);
};

describe("parsed argument permission matching", () => {
    it("does not authorize an incomplete substitution as a heredoc terminator", () => {
        expect(
            getArgsPermissionMatch(["cat", "<<", "EOF", "$(cat /etc/passwd"], {
                "cat << EOF": "allow",
            }),
        ).toEqual({ permission: "ask", matched: false, pattern: null });
    });
});

describe("getPermission", () => {
    describe("default behavior", () => {
        runTests([
            {
                desc: "returns ask when no permissions configured",
                command: "some-command",
                permissions: {},
                expected: "ask",
            },
            {
                desc: "returns ask when command doesn't match any permission",
                command: "random-command",
                permissions: { "other-command": "allow" },
                expected: "ask",
            },
        ]);
    });

    describe('"**" default permission', () => {
        runTests([
            {
                desc: "** allows unknown commands by default",
                command: "some-command",
                permissions: { "**": "allow" },
                expected: "allow",
            },
            {
                desc: "** allow:sandbox for unknown commands",
                command: "some-command",
                permissions: { "**": "allow:sandbox" },
                expected: "allow:sandbox",
            },
            {
                desc: "** deny as default",
                command: "some-command",
                permissions: { "**": "deny" },
                expected: "deny",
            },
            {
                desc: "** ask as default (explicit)",
                command: "some-command",
                permissions: { "**": "ask" },
                expected: "ask",
            },
            {
                desc: "** does not override specific patterns",
                command: "rm -rf /",
                permissions: { "**": "allow:sandbox", "rm *": "deny" },
                expected: "deny",
            },
            {
                desc: "** applies to multi-line commands with no match",
                command: "unknown1\nunknown2",
                permissions: { "**": "allow:sandbox" },
                expected: "allow:sandbox",
            },
            {
                desc: "** with specific allow, unmatched command gets **",
                command: "ls -la",
                permissions: { "**": "allow:sandbox", "npm *": "allow" },
                expected: "allow:sandbox",
            },
            {
                desc: "** at top, specific overrides below",
                command: "sudo apt update",
                permissions: { "**": "allow:sandbox", "sudo *": "deny" },
                expected: "deny",
            },
            {
                desc: "** with empty command",
                command: "",
                permissions: { "**": "allow" },
                expected: "allow",
            },
            {
                desc: "** does not match as a glob pattern",
                command: "**",
                permissions: { "**": "allow:sandbox", "*": "deny" },
                expected: "deny",
            },
            {
                desc: "** allow:sandbox is more restrictive than allow from match",
                command: "ls\nunknown",
                permissions: { "**": "allow:sandbox", ls: "allow" },
                expected: "allow:sandbox",
            },
            {
                desc: "** deny overrides matched allow",
                command: "ls\nunknown",
                permissions: { "**": "deny", ls: "allow" },
                expected: "deny",
            },
        ]);
    });

    describe("exact matches", () => {
        runTests([
            {
                desc: "allow",
                command: "ls -la",
                permissions: { "ls -la": "allow" },
                expected: "allow",
            },
            {
                desc: "deny",
                command: "rm -rf /",
                permissions: { "rm -rf /": "deny" },
                expected: "deny",
            },
            {
                desc: "ask",
                command: "sudo apt update",
                permissions: { "sudo apt update": "ask" },
                expected: "ask",
            },
            {
                desc: "allow:sandbox",
                command: "docker ps",
                permissions: { "docker ps": "allow:sandbox" },
                expected: "allow:sandbox",
            },
        ]);
    });

    describe("wildcard matching", () => {
        describe("wildcard at end", () => {
            runTests([
                {
                    desc: "matches command with wildcard at end",
                    command: "grep pattern",
                    permissions: { "grep *": "allow" },
                    expected: "allow",
                },
                {
                    desc: "matches multi-argument command",
                    command: "npm install --save-dev",
                    permissions: { "npm *": "allow" },
                    expected: "allow",
                },
                {
                    desc: "matches specific subcommand pattern",
                    command: "npm run dev",
                    permissions: { "npm run *": "allow" },
                    expected: "allow",
                },
                {
                    desc: "trailing wildcard requires an argument",
                    command: "npm run test:run",
                    permissions: { "npm run test:run *": "allow" },
                    expected: "ask",
                },
                {
                    desc: "doesn't match when command lacks prefix",
                    command: "ls -la",
                    permissions: { "grep *": "allow" },
                    expected: "ask",
                },
            ]);
        });

        describe("wildcard at start", () => {
            runTests([
                {
                    desc: "matches command with wildcard at start",
                    command: "find /tmp",
                    permissions: { "* /tmp": "allow" },
                    expected: "allow",
                },
                {
                    desc: "matches any command ending with specific arg",
                    command: "cat file.txt",
                    permissions: { "* file.txt": "allow" },
                    expected: "allow",
                },
                {
                    desc: "doesn't match if path is absolute but rule is relative",
                    command: "ls -la /path/to/file.txt",
                    permissions: { "* file.txt": "allow" },
                    expected: "ask",
                },
            ]);
        });

        describe("wildcard in middle", () => {
            runTests([
                {
                    desc: "matches command with wildcard in middle",
                    command: "find /tmp -name test",
                    permissions: { "find * -name *": "allow" },
                    expected: "allow",
                },
                {
                    desc: "matches multiple wildcards in pattern",
                    command: "find /tmp -type f -name test.txt",
                    permissions: { "find * -name *": "allow" },
                    expected: "allow",
                },
                {
                    desc: "requires correct number of args before wildcard",
                    command: "find -name test",
                    permissions: { "find /tmp -name *": "allow" },
                    expected: "ask",
                },
            ]);
        });

        describe("multiple wildcards", () => {
            runTests([
                {
                    desc: "matches command with multiple separate wildcards",
                    command: "cp source.txt dest.txt",
                    permissions: { "* *": "allow" },
                    expected: "allow",
                },
                {
                    desc: "matches complex pattern with multiple wildcards",
                    command: "git add file.txt",
                    permissions: { "git * *": "allow" },
                    expected: "allow",
                },
            ]);
        });

        describe("single wildcard", () => {
            runTests([
                {
                    desc: "matches anything",
                    command: "any command here",
                    permissions: { "*": "allow" },
                    expected: "allow",
                },
                {
                    desc: "matches literal * in argument",
                    command: "npm run test:all",
                    permissions: { "npm run test:*": "allow" },
                    expected: "allow",
                },
            ]);
        });
    });

    describe("special characters in arguments", () => {
        runTests([
            {
                desc: "literal dot",
                command: "ls -la .",
                permissions: { "ls -la .": "allow" },
                expected: "allow",
            },
            {
                desc: "literal dollar sign",
                command: "echo $HOME",
                permissions: { "echo $HOME": "allow" },
                expected: "allow",
            },
            {
                desc: "literal caret",
                command: "grep ^pattern",
                permissions: { "grep ^pattern": "allow" },
                expected: "allow",
            },
            {
                desc: "literal plus",
                command: "npm install +foo",
                permissions: { "npm install +foo": "allow" },
                expected: "allow",
            },
            {
                desc: "literal question mark",
                command: "ls file?.txt",
                permissions: { "ls file?.txt": "allow" },
                expected: "allow",
            },
            {
                desc: "literal parentheses",
                command: "mkdir (test)",
                permissions: { "mkdir (test)": "allow" },
                expected: "allow",
            },
            {
                desc: "literal square brackets",
                command: "ls [abc].txt",
                permissions: { "ls [abc].txt": "allow" },
                expected: "allow",
            },
            {
                desc: "literal curly braces",
                command: "echo {a,b}",
                permissions: { "echo {a,b}": "allow" },
                expected: "allow",
            },
            {
                desc: "literal pipe",
                command: "cmd | other",
                permissions: { "cmd | other": "allow" },
                expected: "allow",
            },
            {
                desc: "literal backslash",
                command: "path\\to\\file",
                permissions: { "path\\to\\file": "allow" },
                expected: "allow",
            },
        ]);
    });

    describe("quoted arguments", () => {
        runTests([
            {
                desc: "double-quoted with spaces",
                command: 'npm run "dev server"',
                permissions: { 'npm run "dev server"': "allow" },
                expected: "allow",
            },
            {
                desc: "double-quoted with wildcard",
                command: 'git commit -am "test commit"',
                permissions: { 'git commit -am "*"': "allow" },
                expected: "allow",
            },
            {
                desc: "single-quoted with spaces",
                command: "cat 'hello world.txt'",
                permissions: { "cat 'hello world.txt'": "allow" },
                expected: "allow",
            },
            {
                desc: "single-quoted with wildcard",
                command: "git commit -am 'test commit'",
                permissions: { "git commit -am '*'": "allow" },
                expected: "allow",
            },
            {
                desc: "wildcard matches quoted argument",
                command: 'npm run "dev server"',
                permissions: { "npm run *": "allow" },
                expected: "allow",
            },
            {
                desc: "escaped space",
                command: "echo hello\\ world",
                permissions: { "echo hello\\ world": "allow" },
                expected: "allow",
            },
            {
                desc: "quoted process-looking literal does not match live substitution",
                command: "echo <(cat /etc/passwd)",
                permissions: { 'echo "<(cat /etc/passwd)"': "allow" },
                expected: "ask",
            },
            {
                desc: "quoted command-looking literal does not match live substitution",
                command: "echo $(cat /etc/passwd)",
                permissions: { "echo '$(cat /etc/passwd)'": "allow" },
                expected: "ask",
            },
        ]);
    });

    describe("multiple permissions - last one wins", () => {
        runTests([
            {
                desc: "last matching permission wins (allow then deny)",
                command: "grep pattern",
                permissions: { "grep *": "allow", "grep pattern": "deny" },
                expected: "deny",
            },
            {
                desc: "last matching permission wins for wildcards",
                command: "find /tmp",
                permissions: { "*": "allow", "find *": "deny" },
                expected: "deny",
            },
            {
                desc: "first matching permission when only one matches",
                command: "ls -la",
                permissions: { "ls -la": "allow", "grep *": "deny" },
                expected: "allow",
            },
        ]);
    });

    describe("edge cases", () => {
        runTests([
            {
                desc: "empty command with empty permission",
                command: "",
                permissions: { "": "allow" },
                expected: "allow",
            },
            {
                desc: "empty command without empty permission",
                command: "",
                permissions: { ls: "allow" },
                expected: "ask",
            },
            {
                desc: "whitespace-only command without wildcard",
                command: "   ",
                permissions: { ls: "allow" },
                expected: "ask",
            },
            {
                desc: "whitespace-only command with wildcard",
                command: "   ",
                permissions: { "*": "allow" },
                expected: "allow",
            },
            {
                desc: "case-sensitive matching",
                command: "LS -LA",
                permissions: { "ls -la": "allow" },
                expected: "ask",
            },
            {
                desc: "Unicode characters",
                command: "echo 你好",
                permissions: { "echo 你好": "allow" },
                expected: "allow",
            },
            {
                desc: "many arguments",
                command: "cp file1.txt file2.txt file3.txt file4.txt",
                permissions: { "cp *": "allow" },
                expected: "allow",
            },
            {
                desc: "multiple consecutive wildcards",
                command: "git commit -m message",
                permissions: { "git * *": "allow" },
                expected: "allow",
            },
            {
                desc: "wildcard at start with multiple lookaheads",
                command: "rm -rf /tmp",
                permissions: { "* -rf /tmp": "allow" },
                expected: "allow",
            },
            {
                desc: "wildcard at end with multiple args",
                command: "echo hello world",
                permissions: { "echo *": "allow" },
                expected: "allow",
            },
            {
                desc: "doesn't match when lookahead arg missing",
                command: "grep pattern",
                permissions: { "* file.txt": "allow" },
                expected: "ask",
            },
            {
                desc: "pattern with only wildcards",
                command: "anything goes",
                permissions: { "* * *": "allow" },
                expected: "allow",
            },
            {
                desc: "exact match after wildcard pattern",
                command: "npm install",
                permissions: { "npm *": "allow" },
                expected: "allow",
            },
            {
                desc: "partial match rejection",
                command: "git add",
                permissions: { "git add file.txt": "allow" },
                expected: "ask",
            },
        ]);
    });

    describe("redirections", () => {
        runTests([
            {
                desc: "multiple redirections",
                command: "cmd < in > out",
                permissions: { "cmd < in > out": "allow" },
                expected: "allow",
            },
            {
                desc: "stderr redirect 2>",
                command: "cmd 2>err",
                permissions: { "cmd 2> *": "allow" },
                expected: "allow",
            },
            {
                desc: "2>&1 redirect",
                command: "cmd 2>&1",
                permissions: { "cmd 2>&1": "allow" },
                expected: "allow",
            },
            {
                desc: "different stderr redirect types don't match",
                command: "cmd 2>err",
                permissions: { "cmd 2>&1": "allow" },
                expected: "ask",
            },
            {
                desc: "input redirection",
                command: "cat < file.txt",
                permissions: { "cat < *": "allow" },
                expected: "allow",
            },
            {
                desc: "exact output redirection",
                command: "cat file.txt > output.txt",
                permissions: { "cat file.txt > output.txt": "allow" },
                expected: "allow",
            },
            {
                desc: "command without redirection doesn't match",
                command: "cat file.txt > output.txt",
                permissions: { "cat file.txt": "allow" },
                expected: "ask",
            },
            {
                desc: "redirection with wildcard",
                command: "cat file.txt > output.txt",
                permissions: { "cat * > *": "allow" },
                expected: "allow",
            },
            {
                desc: "different redirection types don't match",
                command: "cat file.txt > output.txt",
                permissions: { "cat file.txt >> output.txt": "allow" },
                expected: "ask",
            },
        ]);
    });

    describe("background process &", () => {
        runTests([
            {
                desc: "matches command with background &",
                command: "sleep 10 &",
                permissions: { "sleep 10 &": "allow" },
                expected: "allow",
            },
            {
                desc: "doesn't match background with non-background pattern",
                command: "sleep 10 &",
                permissions: { "sleep 10": "allow" },
                expected: "ask",
            },
            {
                desc: "wildcard doesn't match background &",
                command: "sleep 10 &",
                permissions: { "sleep *": "allow" },
                expected: "ask",
            },
        ]);
    });

    describe("subshells", () => {
        runTests([
            {
                desc: "empty subshell",
                command: "echo $()",
                permissions: { "echo $()": "allow" },
                expected: "allow",
            },
            {
                desc: "subshell with pipe inside",
                command: "echo $(cat file | grep foo)",
                permissions: { "echo $(cat * | grep *)": "allow" },
                expected: "allow",
            },
            {
                desc: "exact subshell match",
                command: "echo $(echo hello)",
                permissions: { "echo $(echo hello)": "allow" },
                expected: "allow",
            },
            {
                desc: "different subshell content doesn't match",
                command: "echo $(echo world)",
                permissions: { "echo $(echo hello)": "allow" },
                expected: "ask",
            },
            {
                desc: "wildcard inside subshell",
                command: "echo $(echo hello)",
                permissions: { "echo $(echo *)": "allow" },
                expected: "allow",
            },
            {
                desc: "different command with wildcard in subshell",
                command: "echo $(echo hello)",
                permissions: { "echo $(cat *)": "allow" },
                expected: "ask",
            },
            {
                desc: "wildcard for subshell argument",
                command: "echo $(cat file.txt)",
                permissions: { "echo $(cat *)": "allow" },
                expected: "allow",
            },
            {
                desc: "multiple wildcards in subshell",
                command: "echo $(cat /tmp/file.txt)",
                permissions: { "echo $(cat * *)": "allow" },
                expected: "allow",
            },
            {
                desc: "wildcard for entire subshell",
                command: "echo $(echo hello)",
                permissions: { "echo *": "allow" },
                expected: "allow",
            },
            {
                desc: "wildcard subshell pattern",
                command: "echo $(cat file.txt)",
                permissions: { "echo $(*)": "allow" },
                expected: "allow",
            },
            {
                desc: "extra args after subshell don't match",
                command: "echo $(cat file.txt) extra",
                permissions: { "echo $(cat *)": "allow" },
                expected: "ask",
            },
            {
                desc: "nested subshells with wildcards",
                command: "echo $(cat $(echo file.txt))",
                permissions: { "echo $(cat $(echo *))": "allow" },
                expected: "allow",
            },
            {
                desc: "different nested subshell",
                command: "echo $(cat $(echo file.txt))",
                permissions: { "echo $(cat $(cat *))": "allow" },
                expected: "ask",
            },
            {
                desc: "backtick subshell with wildcard",
                command: "echo `cat file.txt`",
                permissions: { "echo `cat *`": "allow" },
                expected: "allow",
            },
            {
                desc: "incomplete command substitution does not match",
                command: "echo $(cat /etc/passwd",
                permissions: { "echo $(cat *)": "allow" },
                expected: "ask",
            },
            {
                desc: "trailing wildcard does not consume incomplete substitution",
                command: "echo safe $(cat /etc/passwd",
                permissions: { "echo *": "allow" },
                expected: "ask",
            },
        ]);
    });

    describe("process substitution", () => {
        runTests([
            {
                desc: "output process substitution >(...)",
                command: "tee >(cat)",
                permissions: { "tee >(*)": "allow" },
                expected: "allow",
            },
            {
                desc: "different process substitution types don't match",
                command: "diff <(cat a) <(cat b)",
                permissions: { "diff >(cat *) >(cat *)": "allow" },
                expected: "ask",
            },
            {
                desc: "exact process substitution",
                command: "diff <(cat a.txt) <(cat b.txt)",
                permissions: { "diff <(cat a.txt) <(cat b.txt)": "allow" },
                expected: "allow",
            },
            {
                desc: "process substitution with wildcard",
                command: "diff <(cat a.txt) <(cat b.txt)",
                permissions: { "diff <(cat *) <(cat *)": "allow" },
                expected: "allow",
            },
            {
                desc: "different process substitution content",
                command: "diff <(cat a.txt) <(cat b.txt)",
                permissions: { "diff <(echo *) <(echo *)": "allow" },
                expected: "ask",
            },
        ]);
    });

    describe("heredocs", () => {
        runTests([
            {
                desc: "empty heredoc",
                command: "cat <<EOF\nEOF",
                permissions: { "cat << EOF": "allow" },
                expected: "allow",
            },
            {
                desc: "heredoc with content",
                command: "cat <<EOF\ncontent\nEOF",
                permissions: { "cat << EOF": "allow" },
                expected: "allow",
            },
            {
                desc: "heredoc with quoted delimiter",
                command: 'cat <<"EOF"\ncontent\nEOF',
                permissions: { "cat << EOF": "allow" },
                expected: "allow",
            },
            {
                desc: "heredoc wildcard delimiter",
                command: "cat <<MYEOF\ncontent\nMYEOF",
                permissions: { "cat << *": "allow" },
                expected: "allow",
            },
            {
                desc: "heredoc with <<- operator",
                command: "cat <<-EOF\ncontent\nEOF",
                permissions: { "cat <<- EOF": "allow" },
                expected: "allow",
            },
            {
                desc: "any delimiter matches",
                command: "cat <<EOF\ncontent\nEOF",
                permissions: { "cat << OTHER": "allow" },
                expected: "allow",
            },
            {
                desc: "different heredoc operators don't match",
                command: "cat <<EOF\ncontent\nEOF",
                permissions: { "cat <<- EOF": "allow" },
                expected: "ask",
            },
            {
                desc: "heredoc with content and matching delimiter",
                command: "cat <<EOF\nhello world\nEOF",
                permissions: { "cat <<EOF": "allow" },
                expected: "allow",
            },
            {
                desc: "heredoc rule does not consume an extra command argument",
                command: "cat <<EOF /etc/passwd\nbody\nEOF",
                permissions: { "cat << EOF": "allow" },
                expected: "ask",
            },
            {
                desc: "delimiter in content doesn't close heredoc",
                command: "cat <<EOF\nnot the EOF\nreal line\nEOF",
                permissions: { "cat << EOF": "allow" },
                expected: "allow",
            },
            {
                desc: "unclosed heredoc",
                command: "cat <<EOF\nno close",
                permissions: { "cat << EOF": "allow" },
                expected: "allow",
            },
        ]);
    });

    describe("heredocs with pipes", () => {
        runTests([
            {
                desc: "piped command doesn't match non-piped pattern",
                command: "cat file.txt | grep foo",
                permissions: { "cat file.txt": "allow" },
                expected: "ask",
            },
            {
                desc: "heredoc with pipe doesn't match pattern without pipe",
                command: "cat file.txt <<EOF | grep test\ntesting\nEOF",
                permissions: { "cat file.txt << EOF": "allow" },
                expected: "ask",
            },
            {
                desc: "heredoc with pipe matches pattern with pipe",
                command: "cat file.txt <<EOF | grep test\ntesting\nEOF",
                permissions: { "cat file.txt << EOF | grep test": "allow" },
                expected: "allow",
            },
        ]);
    });

    describe("comments (no comment parsing)", () => {
        runTests([
            {
                desc: "# treated as literal argument",
                command: "echo hello # comment",
                permissions: { "echo hello # comment": "allow" },
                expected: "allow",
            },
            {
                desc: "# matches with wildcard",
                command: "echo # comment",
                permissions: { "echo *": "allow" },
                expected: "allow",
            },
        ]);
    });

    // NOTE: Variable expansion is NOT handled by the permission system.
    // Variables like $HOME, $((expr)), ${arr[0]}, ~, etc. are treated as literal strings.
    // These tests verify literal matching of such strings, NOT expansion.
    // Do not add tests for variable expansion matching.

    describe("variable-like literals", () => {
        runTests([
            {
                desc: "$VAR as literal string",
                command: "echo $HOME",
                permissions: { "echo $HOME": "allow" },
                expected: "allow",
            },
            {
                desc: "arithmetic expansion as literal",
                command: "echo $((1+2))",
                permissions: { "echo $((1+2))": "allow" },
                expected: "allow",
            },
            {
                desc: "tilde as literal",
                command: "cd ~",
                permissions: { "cd ~": "allow" },
                expected: "allow",
            },
            {
                desc: "array subscript as literal",
                command: "echo ${arr[0]}",
                permissions: { "echo ${arr[0]}": "allow" },
                expected: "allow",
            },
        ]);
    });

    describe("glob patterns as literals", () => {
        runTests([
            {
                desc: "* in command matched literally",
                command: "ls *.txt",
                permissions: { "ls *.txt": "allow" },
                expected: "allow",
            },
            {
                desc: "brace expansion as literal",
                command: "echo {a,b,c}",
                permissions: { "echo {a,b,c}": "allow" },
                expected: "allow",
            },
        ]);
    });

    describe("malformed/edge commands", () => {
        runTests([
            {
                desc: "command that is just an operator",
                command: "&&",
                permissions: { "&&": "allow" },
                expected: "allow",
            },
            {
                desc: "multiple consecutive newlines",
                command: "ls\n\necho",
                permissions: { ls: "allow", echo: "allow" },
                expected: "allow",
            },
            {
                desc: "deny if any command is denied",
                command: "ls\n\nrm file",
                permissions: { ls: "allow", "rm *": "deny" },
                expected: "deny",
            },
        ]);
    });

    describe("command chaining", () => {
        runTests([
            {
                desc: "exact && chain",
                command: "cat file.txt && rm file.txt",
                permissions: { "cat file.txt && rm file.txt": "allow" },
                expected: "allow",
            },
            {
                desc: "partial chain doesn't match",
                command: "cat file.txt && rm file.txt",
                permissions: { "cat file.txt": "allow" },
                expected: "ask",
            },
            {
                desc: "&& chain with wildcard",
                command: "cat file.txt && rm file.txt",
                permissions: { "cat * && rm *": "allow" },
                expected: "allow",
            },
            {
                desc: "different chain operators don't match",
                command: "cat file.txt && rm file.txt",
                permissions: { "cat file.txt || rm file.txt": "allow" },
                expected: "ask",
            },
            {
                desc: "wildcard doesn't match && chain",
                command: "cat file.txt && rm file.txt",
                permissions: { "cat *": "allow" },
                expected: "ask",
            },
            {
                desc: "wildcard doesn't match || chain",
                command: "cat file.txt || rm file.txt",
                permissions: { "cat *": "allow" },
                expected: "ask",
            },
            {
                desc: "wildcard doesn't match ; chain",
                command: "cat file.txt; rm file.txt",
                permissions: { "cat *": "allow" },
                expected: "ask",
            },
            {
                desc: "wildcard doesn't match | pipe",
                command: "cat file.txt | grep foo",
                permissions: { "cat *": "allow" },
                expected: "ask",
            },
            {
                desc: "single wildcard doesn't match chained commands",
                command: "cat file.txt && rm file.txt",
                permissions: { "*": "allow" },
                expected: "ask",
            },
            {
                desc: "explicit || chain with wildcards",
                command: "cat file.txt || rm file.txt",
                permissions: { "cat * || rm *": "allow" },
                expected: "allow",
            },
            {
                desc: "explicit ; chain with wildcards",
                command: "cat file.txt; rm file.txt",
                permissions: { "cat *; rm *": "allow" },
                expected: "allow",
            },
            {
                desc: "explicit | pipe with wildcards",
                command: "cat file.txt | grep foo",
                permissions: { "cat * | grep *": "allow" },
                expected: "allow",
            },
            {
                desc: "wildcard doesn't match multiple chained commands",
                command: "a && b && c",
                permissions: { "a *": "allow" },
                expected: "ask",
            },
            {
                desc: "wildcard doesn't match pipe-and-merge chains",
                command: "echo hi |& rm -rf x",
                permissions: { "echo *": "allow" },
                expected: "ask",
            },
            {
                desc: "multiple explicit chain operators with wildcards",
                command: "a && b && c",
                permissions: { "a * && b && *": "allow" },
                expected: "allow",
            },
            {
                desc: "different first command in chain",
                command: "cat file.txt && rm file.txt",
                permissions: { "dog * && rm *": "allow" },
                expected: "ask",
            },
            {
                desc: "chain operator mismatch with wildcard",
                command: "cat file.txt && rm file.txt",
                permissions: { "cat * || rm *": "allow" },
                expected: "ask",
            },
            {
                desc: "wildcard before explicit chain operator",
                command: "npm install && npm test",
                permissions: { "npm * && npm test": "allow" },
                expected: "allow",
            },
            {
                desc: "wildcard after explicit chain operator",
                command: "npm install && npm run build",
                permissions: { "npm install && npm *": "allow" },
                expected: "allow",
            },
            {
                desc: "multiple wildcards around chain operators",
                command: "git add . && git commit -m msg && git push",
                permissions: { "git * && git * && git *": "allow" },
                expected: "allow",
            },
        ]);
    });

    describe("multi-line commands", () => {
        describe("line continuations", () => {
            runTests([
                {
                    desc: "line continuation joins commands",
                    command: "echo hello \\\nworld",
                    permissions: { "echo hello world": "allow" },
                    expected: "allow",
                },
                {
                    desc: "line continuation with denied command",
                    command: "echo hello \\\n&& rm -rf /",
                    permissions: { "echo *": "allow", "rm *": "deny" },
                    expected: "ask",
                },
                {
                    desc: "line continuation with explicit chain denial",
                    command: "echo hello \\\n&& rm -rf /",
                    permissions: { "echo * && rm *": "deny" },
                    expected: "deny",
                },
            ]);
        });

        describe("multiple commands separated by newlines", () => {
            runTests([
                {
                    desc: "each command on separate lines",
                    command: "echo hello\necho world",
                    permissions: { "echo *": "allow" },
                    expected: "allow",
                },
                {
                    desc: "deny if any command is denied",
                    command: "echo hello\nrm -rf /",
                    permissions: { "echo *": "allow", "rm *": "deny" },
                    expected: "deny",
                },
                {
                    desc: "ask if any command needs asking",
                    command: "echo hello\nsudo apt update",
                    permissions: { "echo *": "allow" },
                    expected: "ask",
                },
                {
                    desc: "returns most restrictive permission",
                    command: "ls\necho hello\nrm file",
                    permissions: { ls: "allow", "echo *": "allow:sandbox", "rm *": "ask" },
                    expected: "ask",
                },
                {
                    desc: "allow:sandbox vs allow",
                    command: "ls\necho hello",
                    permissions: { ls: "allow", "echo *": "allow:sandbox" },
                    expected: "allow:sandbox",
                },
                {
                    desc: "three commands with different permissions",
                    command: "ls\necho hello\nrm file",
                    permissions: { ls: "allow:sandbox", "echo *": "allow", "rm *": "deny" },
                    expected: "deny",
                },
                {
                    desc: "all permissions allowed",
                    command: "ls\necho hello\ncat test",
                    permissions: { ls: "allow", "echo *": "allow", "cat *": "allow" },
                    expected: "allow",
                },
            ]);
        });

        describe("heredocs in multi-line commands", () => {
            runTests([
                {
                    desc: "heredoc content not split into separate commands",
                    command: "cat <<EOF\nhello\nEOF",
                    permissions: { "cat << EOF": "allow" },
                    expected: "allow",
                },
                {
                    desc: "heredoc followed by denied command",
                    command: "cat <<EOF\ncontent\nEOF\nrm file",
                    permissions: { "cat << EOF": "allow", "rm *": "deny" },
                    expected: "deny",
                },
                {
                    desc: "heredoc followed by allowed command",
                    command: "cat <<EOF\ncontent\nEOF\necho done",
                    permissions: { "cat << EOF": "allow", "echo *": "allow" },
                    expected: "allow",
                },
            ]);
        });
    });
});
