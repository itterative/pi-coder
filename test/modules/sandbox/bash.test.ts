import { describe, it, expect } from "vitest";
import {
    parseBash,
    isHeredocOperator,
    isSubshell,
    isProcessSubstitution,
    getSubshellContent,
} from "../../../src/modules/sandbox/bash";

interface ParseTest {
    desc: string;
    input: string;
    expected: string[][];
}

const runParseTests = (tests: ParseTest[]) => {
    it.each(tests)("$desc", ({ input, expected }) => {
        expect(parseBash(input)).toEqual(expected);
    });
};

describe("parseBash", () => {
    describe("basic commands", () => {
        runParseTests([
            { desc: "simple command", input: "echo hello", expected: [["echo", "hello"]] },
            { desc: "command with multiple args", input: "git commit -m message", expected: [["git", "commit", "-m", "message"]] },
            { desc: "multiple spaces between args", input: "cmd  arg", expected: [["cmd", "arg"]] },
            { desc: "leading/trailing whitespace", input: "  ls -la  ", expected: [["ls", "-la"]] },
            { desc: "tabs as separators", input: "cmd\targ", expected: [["cmd", "arg"]] },
            { desc: "empty input", input: "", expected: [] },
            { desc: "whitespace only", input: "   \t  ", expected: [] },
        ]);
    });

    describe("multiple commands", () => {
        runParseTests([
            { desc: "splits by newline", input: "echo hello\necho world", expected: [["echo", "hello"], ["echo", "world"]] },
            { desc: "filters out empty lines", input: "echo hello\n\necho world\n", expected: [["echo", "hello"], ["echo", "world"]] },
            { desc: "leading newlines", input: "\n\necho hello", expected: [["echo", "hello"]] },
            { desc: "trailing newlines", input: "echo hello\n\n", expected: [["echo", "hello"]] },
        ]);
    });

    describe("quoted strings", () => {
        runParseTests([
            { desc: "strips double quotes, preserves content", input: 'echo "hello world"', expected: [["echo", "hello world"]] },
            { desc: "strips single quotes, preserves content", input: "echo 'hello world'", expected: [["echo", "hello world"]] },
            { desc: "mixed quotes", input: 'echo "hello" \'world\'', expected: [["echo", "hello", "world"]] },
            { desc: "adjacent quoted strings", input: 'echo "hello""world"', expected: [["echo", "helloworld"]] },
            { desc: "quote in middle of unquoted", input: 'echo hello"world"goodbye', expected: [["echo", "helloworldgoodbye"]] },
            { desc: "empty double quotes", input: 'echo ""', expected: [["echo", ""]] },
            { desc: "empty single quotes", input: "echo ''", expected: [["echo", ""]] },
            { desc: "escaped chars in double quotes", input: 'echo "hello \\"world\\""', expected: [["echo", 'hello \\"world\\"']] },
            { desc: "unclosed double quote", input: 'echo "hello', expected: [["echo", "hello"]] },
            { desc: "unclosed single quote", input: "echo 'hello", expected: [["echo", "hello"]] },
        ]);
    });

    describe("escaping", () => {
        runParseTests([
            { desc: "escaped space", input: "echo hello\\ world", expected: [["echo", "hello world"]] },
            { desc: "multiple escaped spaces", input: "echo hello\\ \\ world", expected: [["echo", "hello  world"]] },
            { desc: "escaped tab", input: "echo hello\\\tworld", expected: [["echo", "hello\tworld"]] },
            { desc: "escaped backslash", input: "echo hello\\\\world", expected: [["echo", "hello\\world"]] },
        ]);
    });

    describe("line continuations", () => {
        runParseTests([
            { desc: "removes backslash-newline", input: "echo hello \\\nworld", expected: [["echo", "hello", "world"]] },
            { desc: "multiple continuations", input: "echo \\\nhello \\\nworld", expected: [["echo", "hello", "world"]] },
            { desc: "backslash-newline inside double quotes (removed)", input: 'echo "hello\\\nworld"', expected: [["echo", "helloworld"]] },
            { desc: "backslash-newline inside single quotes (preserved)", input: "echo 'hello\\\nworld'", expected: [["echo", "hello\\\nworld"]] },
            { desc: "continuation at start", input: "\\\necho hello", expected: [["echo", "hello"]] },
            { desc: "continuation at end", input: "echo hello\\\n", expected: [["echo", "hello"]] },
        ]);
    });

    describe("operators", () => {
        runParseTests([
            { desc: "&& (and)", input: "a && b", expected: [["a", "&&", "b"]] },
            { desc: "|| (or)", input: "a || b", expected: [["a", "||", "b"]] },
            { desc: "| (pipe)", input: "cat file | grep foo", expected: [["cat", "file", "|", "grep", "foo"]] },
            { desc: "; (sequential)", input: "cd /tmp; ls", expected: [["cd", "/tmp", ";", "ls"]] },
            { desc: "& (background)", input: "sleep 1 &", expected: [["sleep", "1", "&"]] },
            { desc: "operators without spaces", input: "a&&b||c|d;e&f", expected: [["a", "&&", "b", "||", "c", "|", "d", ";", "e", "&", "f"]] },
        ]);
    });

    describe("redirections", () => {
        runParseTests([
            { desc: "output >", input: "cat file > out", expected: [["cat", "file", ">", "out"]] },
            { desc: "append >>", input: "cat file >> out", expected: [["cat", "file", ">>", "out"]] },
            { desc: "input <", input: "cat < in", expected: [["cat", "<", "in"]] },
            { desc: "stderr 2>", input: "cmd 2> err", expected: [["cmd", "2>", "err"]] },
            { desc: "stderr append 2>>", input: "cmd 2>> err", expected: [["cmd", "2>>", "err"]] },
            { desc: "stderr to stdout 2>&1", input: "cmd 2>&1", expected: [["cmd", "2>&1"]] },
        ]);
    });

    describe("subshells", () => {
        runParseTests([
            { desc: "$(...) subshell", input: "echo $(pwd)", expected: [["echo", "$(pwd)"]] },
            { desc: "backtick subshell", input: "echo `pwd`", expected: [["echo", "`pwd`"]] },
            { desc: "nested subshells", input: "echo $(cat $(echo file))", expected: [["echo", "$(cat $(echo file))"]] },
            { desc: "subshell with operators inside", input: "echo $(cat f | grep x)", expected: [["echo", "$(cat f | grep x)"]] },
            { desc: "empty subshell", input: "echo $()", expected: [["echo", "$()"]] },
            { desc: "unclosed subshell", input: "echo $(hello", expected: [["echo", "$(hello"]] },
        ]);
    });

    describe("process substitution", () => {
        runParseTests([
            { desc: "<() substitution", input: "diff <(cat a) <(cat b)", expected: [["diff", "<(cat a)", "<(cat b)"]] },
            { desc: ">() substitution", input: "tee >(cat)", expected: [["tee", ">(cat)"]] },
            { desc: "empty substitution", input: "cat <()", expected: [["cat", "<()"]] },
        ]);
    });

    describe("heredocs", () => {
        runParseTests([
            { desc: "heredoc with content", input: "cat <<EOF\nhello\nEOF", expected: [["cat", "<<", "EOF", "EOF"]] },
            { desc: "heredoc without content (no newline)", input: "cat <<EOF", expected: [["cat", "<<", "EOF"]] },
            { desc: "heredoc with space before delimiter", input: "cat << EOF", expected: [["cat", "<<", "EOF"]] },
            { desc: "<<- (tab-stripped heredoc)", input: "cat <<-EOF\n\tcontent\nEOF", expected: [["cat", "<<-", "EOF", "EOF"]] },
            { desc: "heredoc followed by more commands", input: "cat <<EOF\ncontent\nEOF\necho done", expected: [["cat", "<<", "EOF", "EOF"], ["echo", "done"]] },
            { desc: "unclosed heredoc", input: "cat <<EOF\ncontent without end", expected: [["cat", "<<", "EOF"]] },
            { desc: "heredoc with empty content", input: "cat <<EOF\nEOF", expected: [["cat", "<<", "EOF", "EOF"]] },
            { desc: "heredoc with delimiter-like text in content", input: "cat <<EOF\nnot EOF but not alone\nEOF", expected: [["cat", "<<", "EOF", "EOF"]] },
        ]);
    });

    describe("special characters and edge cases", () => {
        runParseTests([
            { desc: "dollar sign literally", input: "echo $HOME", expected: [["echo", "$HOME"]] },
            { desc: "glob patterns literally", input: "ls *.txt", expected: [["ls", "*.txt"]] },
            { desc: "brace expansion literally", input: "echo {a,b}", expected: [["echo", "{a,b}"]] },
            { desc: "tilde literally", input: "cat ~/file", expected: [["cat", "~/file"]] },
            { desc: "equals sign", input: "cmd --key=value", expected: [["cmd", "--key=value"]] },
            { desc: "dashes", input: "cmd -a --bc", expected: [["cmd", "-a", "--bc"]] },
            { desc: "paths with slashes", input: "cat /path/to/file", expected: [["cat", "/path/to/file"]] },
            { desc: "Unicode", input: "echo 你好 🎉", expected: [["echo", "你好", "🎉"]] },
        ]);

        it("handles very long arguments", () => {
            const long = "a".repeat(1000);
            expect(parseBash(`echo ${long}`)).toEqual([["echo", long]]);
        });
    });
});

interface BoolTest {
    desc: string;
    input: string;
    expected: boolean;
}

interface StringTest {
    desc: string;
    input: string;
    expected: string;
}

describe("helper functions", () => {
    describe("isHeredocOperator", () => {
        const tests: BoolTest[] = [
            { desc: "<< is heredoc operator", input: "<<", expected: true },
            { desc: "<<- is heredoc operator", input: "<<-", expected: true },
            { desc: "< is not heredoc operator", input: "<", expected: false },
            { desc: ">>> is not heredoc operator", input: ">>>", expected: false },
        ];
        it.each(tests)("$desc", ({ input, expected }) => {
            expect(isHeredocOperator(input)).toBe(expected);
        });
    });

    describe("isSubshell", () => {
        const tests: BoolTest[] = [
            { desc: "$(echo hi) is subshell", input: "$(echo hi)", expected: true },
            { desc: "$(cat) is subshell", input: "$(cat)", expected: true },
            { desc: "$() is subshell", input: "$()", expected: true },
            { desc: "`echo hi` is subshell", input: "`echo hi`", expected: true },
            { desc: "`` is subshell", input: "``", expected: true },
            { desc: "echo is not subshell", input: "echo", expected: false },
            { desc: "$VAR is not subshell", input: "$VAR", expected: false },
        ];
        it.each(tests)("$desc", ({ input, expected }) => {
            expect(isSubshell(input)).toBe(expected);
        });
    });

    describe("isProcessSubstitution", () => {
        const tests: BoolTest[] = [
            { desc: "<(cat a) is process substitution", input: "<(cat a)", expected: true },
            { desc: ">(tee) is process substitution", input: ">(tee)", expected: true },
            { desc: "<() is process substitution", input: "<()", expected: true },
            { desc: "(cat a) is not process substitution", input: "(cat a)", expected: false },
            { desc: "echo is not process substitution", input: "echo", expected: false },
        ];
        it.each(tests)("$desc", ({ input, expected }) => {
            expect(isProcessSubstitution(input)).toBe(expected);
        });
    });

    describe("getSubshellContent", () => {
        const tests: StringTest[] = [
            { desc: "extracts from $(...)", input: "$(echo hi)", expected: "echo hi" },
            { desc: "extracts from backticks", input: "`echo hi`", expected: "echo hi" },
            { desc: "extracts from <()", input: "<(cat a)", expected: "cat a" },
            { desc: "extracts from >()", input: ">(tee)", expected: "tee" },
            { desc: "returns input unchanged for non-subshells", input: "echo", expected: "echo" },
        ];
        it.each(tests)("$desc", ({ input, expected }) => {
            expect(getSubshellContent(input)).toBe(expected);
        });
    });
});
