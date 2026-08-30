import { describe, it, expect } from "vitest";
import { parseBashAst } from "../../../src/modules/sandbox/bash";

function commandFor(input: string) {
    return parseBashAst(input).commands[0]!;
}

function wordsFor(input: string): string[] {
    return commandFor(input).words.map((word) => word.value);
}

describe("parseBashAst", () => {
    describe("basic commands", () => {
        it.each([
            ["simple command", "echo hello", ["echo", "hello"]],
            [
                "command with multiple args",
                "git commit -m message",
                ["git", "commit", "-m", "message"],
            ],
            ["multiple spaces between args", "cmd  arg", ["cmd", "arg"]],
            ["leading/trailing whitespace", "  ls -la  ", ["ls", "-la"]],
            ["tabs as separators", "cmd\targ", ["cmd", "arg"]],
            ["empty input", "", []],
            ["whitespace only", "   \t  ", []],
        ])("parses %s", (_description, input, expected) => {
            expect(
                parseBashAst(input).commands.flatMap((command) =>
                    command.words.map((word) => word.value),
                ),
            ).toEqual(expected);
        });

        it("handles very long arguments", () => {
            const long = "a".repeat(1000);
            expect(wordsFor(`echo ${long}`)).toEqual(["echo", long]);
        });
    });

    describe("multiple commands", () => {
        it.each([
            [
                "splits by newline",
                "echo hello\necho world",
                [
                    ["echo", "hello"],
                    ["echo", "world"],
                ],
            ],
            [
                "filters out empty lines",
                "echo hello\n\necho world\n",
                [
                    ["echo", "hello"],
                    ["echo", "world"],
                ],
            ],
            ["leading newlines", "\n\necho hello", [["echo", "hello"]]],
            ["trailing newlines", "echo hello\n\n", [["echo", "hello"]]],
        ])("%s", (_description, input, expected) => {
            expect(
                parseBashAst(input).commands.map((command) =>
                    command.words.map((word) => word.value),
                ),
            ).toEqual(expected);
        });
    });

    describe("quoted strings", () => {
        it.each([
            ["strips double quotes", 'echo "hello world"', ["echo", "hello world"]],
            ["strips single quotes", "echo 'hello world'", ["echo", "hello world"]],
            ["mixed quotes", "echo \"hello\" 'world'", ["echo", "hello", "world"]],
            ["adjacent quoted strings", 'echo "hello""world"', ["echo", "helloworld"]],
            [
                "quote in middle of unquoted",
                'echo hello"world"goodbye',
                ["echo", "helloworldgoodbye"],
            ],
            ["empty double quotes", 'echo ""', ["echo", ""]],
            ["empty single quotes", "echo ''", ["echo", ""]],
            [
                "escaped chars in double quotes",
                String.raw`echo "hello \"world\""`,
                ["echo", String.raw`hello \"world\"`],
            ],
            ["unclosed double quote", 'echo "hello', ["echo", "hello"]],
            ["unclosed single quote", "echo 'hello", ["echo", "hello"]],
        ])("%s", (_description, input, expected) => {
            expect(wordsFor(input)).toEqual(expected);
        });

        it("retains quote provenance on words", () => {
            const command = commandFor("echo 'literal' \"quoted\" plain");

            expect(command.words.slice(1).map((word) => word.quoted)).toEqual([true, true, false]);
        });
    });

    describe("escaping and line continuations", () => {
        it.each([
            ["escaped space", "echo hello\\ world", ["echo", "hello world"]],
            ["multiple escaped spaces", "echo hello\\ \\ world", ["echo", "hello  world"]],
            ["escaped tab", "echo hello\\\tworld", ["echo", "hello\tworld"]],
            ["escaped backslash", "echo hello\\\\world", ["echo", "hello\\world"]],
            ["removes backslash-newline", "echo hello \\\nworld", ["echo", "hello", "world"]],
            ["multiple continuations", "echo \\\nhello \\\nworld", ["echo", "hello", "world"]],
            ["continuation at start", "\\\necho hello", ["echo", "hello"]],
            ["continuation at end", "echo hello\\\n", ["echo", "hello"]],
        ])("%s", (_description, input, expected) => {
            expect(wordsFor(input)).toEqual(expected);
        });

        it("preserves escaped syntax as a word", () => {
            const command = commandFor("echo \\| \\> \\$(id)");

            expect(command.words.slice(1).map((word) => word.value)).toEqual(["|", ">", "$(id)"]);
            expect(command.substitutions).toEqual([]);
            expect(command.words.slice(1).every((word) => word.quoted)).toBe(true);
        });
    });

    describe("operators", () => {
        it.each([
            ["&& (and)", "a && b", ["&&"]],
            ["|| (or)", "a || b", ["||"]],
            ["pipe", "cat file | grep foo", ["|"]],
            ["sequential", "cd /tmp; ls", [";"]],
            ["background", "sleep 1 &", ["&"]],
            ["operators without spaces", "a&&b||c|d;e&f", ["&&", "||", "|", ";", "&"]],
        ])("recognizes %s", (_description, input, expected) => {
            expect(parseBashAst(input).statements[0]?.operators).toEqual(expected);
        });

        it("keeps commands and operators in statement order", () => {
            const ast = parseBashAst("cd src && cat file.txt |& tee output.txt");

            expect(ast.statements).toHaveLength(1);
            expect(ast.statements[0]?.operators).toEqual(["&&", "|&"]);
            expect(ast.commands.map((command) => command.command)).toEqual(["cd", "cat", "tee"]);
            expect(
                ast.statements[0]?.parts.map((part) =>
                    typeof part === "string" ? part : part.command,
                ),
            ).toEqual(["cd", "&&", "cat", "|&", "tee"]);
        });
    });

    describe("redirections", () => {
        it("keeps redirection targets separate from command words", () => {
            const command = commandFor("cat file > out");

            expect(command.words.map((word) => word.value)).toEqual(["cat", "file"]);
            expect(command.redirections).toMatchObject([
                { operator: ">", target: { value: "out" } },
            ]);
            expect(command.toTokens()).toEqual(["cat", "file", ">", "out"]);
        });

        it.each([
            ["append", "cat file >> out", ">>", "out"],
            ["input", "cat < in", "<", "in"],
            ["stderr", "cmd 2> err", "2>", "err"],
            ["stderr append", "cmd 2>> err", "2>>", "err"],
            ["combined output", "echo &>out", "&>", "out"],
            ["multi-digit fd", "echo 10>out", "10>", "out"],
        ])("recognizes %s redirection", (_description, input, operator, target) => {
            expect(commandFor(input).redirections).toMatchObject([
                { operator, target: { value: target } },
            ]);
        });

        it.each([
            ["stderr to stdout", "cmd 2>&1", "2>&1"],
            ["stdout to fd", "cmd >&1", ">&1"],
            ["multi-digit fd duplication", "cmd 10>&1", "10>&1"],
        ])("recognizes %s", (_description, input, operator) => {
            const command = commandFor(input);

            expect(command.redirections).toMatchObject([{ operator }]);
            expect(command.redirections[0]?.target).toBeUndefined();
        });

        it("does not mistake command names containing digits for fd redirections", () => {
            const command = commandFor("cat2>out");

            expect(command.command).toBe("cat2");
            expect(command.redirections).toMatchObject([
                { operator: ">", target: { value: "out" } },
            ]);
        });

        it("includes substitutions in redirection targets", () => {
            const command = commandFor("echo > $(pwd)");

            expect(command.substitutions).toMatchObject([{ kind: "command", content: "pwd" }]);
            expect(command.redirections[0]?.target?.quoted).toBe(false);
        });
    });

    describe("substitutions", () => {
        it.each([
            ["command substitution", "echo $(pwd)", "command", "pwd"],
            ["backtick substitution", "echo `pwd`", "backtick", "pwd"],
            ["process input", "diff <(cat a) <(cat b)", "process-input", "cat a"],
            ["process output", "tee >(cat)", "process-output", "cat"],
        ])("captures %s", (_description, input, kind, content) => {
            const substitution = commandFor(input).substitutions[0];

            expect(substitution).toMatchObject({ kind, content });
        });

        it("keeps nested substitutions in semantic words", () => {
            const command = commandFor('echo pre$(echo "$(pwd)")post');

            expect(command.args).toEqual(['pre$(echo "$(pwd)")post']);
            expect(command.subshells).toMatchObject([
                { kind: "command", content: 'echo "$(pwd)"' },
            ]);
            expect(
                command.subshells[0]?.ast.statements[0]?.commands[0]?.words[1]?.substitutions[0]
                    ?.content,
            ).toBe("pwd");
        });

        it("handles quoted and escaped parentheses inside substitutions", () => {
            const quoted = commandFor("echo $(printf ')')");
            const escaped = commandFor(String.raw`echo $(printf \))`);

            expect(quoted.subshells[0]?.content).toBe("printf ')'");
            expect(escaped.subshells[0]?.content).toBe(String.raw`printf \)`);
        });

        it("does not treat escaped closing delimiters as complete", () => {
            const command = commandFor(String.raw`echo $(printf \)`);
            const substitution = command.subshells[0];

            expect(substitution).toMatchObject({
                content: String.raw`printf \)`,
                complete: false,
            });
        });

        it("tracks incomplete escaped backticks", () => {
            const command = commandFor("echo `printf \\\`");
            const substitution = command.subshells[0];

            expect(substitution).toMatchObject({ content: "printf \\`", complete: false });
        });

        it("keeps an outer substitution incomplete around an escaped nested backtick", () => {
            const command = commandFor("echo $(echo `printf \\\`)");
            const substitution = command.subshells[0];

            expect(substitution?.complete).toBe(false);
        });

        it("keeps substitutions in assignments and distinguishes command kind", () => {
            const assignment = commandFor("FOO=$(pwd) echo ok");
            const quoted = commandFor('echo "$(pwd)"');

            expect(assignment.envs).toEqual({ FOO: "$(pwd)" });
            expect(assignment.command).toBe("echo");
            expect(quoted.words[1]?.kind).toBe("subshell");
            expect(
                quoted.words[1]?.substitutions[0]?.ast.statements[0]?.commands[0]?.words[0]?.value,
            ).toBe("pwd");
        });

        it("represents incomplete substitutions without recursing forever", () => {
            const ast = parseBashAst("echo $(");

            expect(ast.commands[0]?.words[1]).toMatchObject({ kind: "subshell", value: "$(" });
            expect(ast.commands[0]?.words[1]?.substitutions[0]?.content).toBe("");
        });
    });

    describe("heredocs", () => {
        it.each([
            ["content", "cat <<EOF\nhello\nEOF", "hello", false],
            ["without trailing body", "cat <<EOF", "", false],
            ["space before delimiter", "cat << EOF", "", false],
            ["tab-stripped", "cat <<-EOF\n\tcontent\nEOF", "\tcontent", true],
            ["empty content", "cat <<EOF\nEOF", "", false],
        ])("captures heredoc %s", (_description, input, body, stripTabs) => {
            const heredoc = commandFor(input).redirections[0]?.heredoc;

            expect(heredoc).toMatchObject({
                delimiter: "EOF",
                body,
                stripTabs,
                complete: input.includes("\nEOF"),
            });
        });

        it("keeps heredoc body lines out of the command stream", () => {
            const ast = parseBashAst("cat <<EOF\nhello\nEOF\necho done");

            expect(ast.commands.map((command) => command.command)).toEqual(["cat", "echo"]);
            expect(ast.commands[0]?.redirections[0]?.heredoc).toMatchObject({
                body: "hello",
                complete: true,
                terminator: "EOF",
            });
        });

        it("queues multiple heredoc bodies", () => {
            const command = commandFor("cat <<A <<B\none\nA\ntwo\nB");

            expect(command.redirections).toMatchObject([
                { heredoc: { delimiter: "A", body: "one", complete: true, terminator: "A" } },
                { heredoc: { delimiter: "B", body: "two", complete: true, terminator: "B" } },
            ]);
        });

        it("retains incomplete heredoc metadata", () => {
            expect(commandFor("cat <<EOF\nhello").redirections[0]?.heredoc).toMatchObject({
                delimiter: "EOF",
                body: "hello",
                complete: false,
            });
        });
    });

    describe("command views and edge cases", () => {
        it("separates flags from positional arguments after --", () => {
            const command = commandFor("cmd -a -- -literal value");

            expect(command.flags).toEqual(["-a", "--"]);
            expect(command.positionalArgs).toEqual(["-literal", "value"]);
        });

        it("tracks environment assignments before the command", () => {
            const command = commandFor("MODE=quiet FOO=bar echo ok");

            expect(command.environment.map(({ name, value }) => ({ name, value }))).toEqual([
                { name: "MODE", value: "quiet" },
                { name: "FOO", value: "bar" },
            ]);
            expect(command.envs).toEqual({ MODE: "quiet", FOO: "bar" });
            expect(command.args).toEqual(["ok"]);
        });

        it.each([
            ["dollar sign literally", "echo $HOME", ["echo", "$HOME"]],
            ["glob patterns literally", "ls *.txt", ["ls", "*.txt"]],
            ["brace expansion literally", "echo {a,b}", ["echo", "{a,b}"]],
            ["tilde literally", "cat ~/file", ["cat", "~/file"]],
            ["equals sign", "cmd --key=value", ["cmd", "--key=value"]],
            ["dashes", "cmd -a --bc", ["cmd", "-a", "--bc"]],
            ["paths with slashes", "cat /path/to/file", ["cat", "/path/to/file"]],
            ["unicode", "echo 你好 🎉", ["echo", "你好", "🎉"]],
        ])("preserves %s", (_description, input, expected) => {
            expect(wordsFor(input)).toEqual(expected);
        });

        it("does not activate quoted operators or redirections", () => {
            const command = commandFor("echo '|' '>' \\|");

            expect(parseBashAst("echo '|' '>' \\|").statements[0]?.operators).toEqual([]);
            expect(command.redirections).toEqual([]);
            expect(command.words.slice(1).map((word) => word.value)).toEqual(["|", ">", "|"]);
        });
    });
});

describe("AST syntax views", () => {
    it.each([
        ["command substitution", "$(echo hi)", "command", "echo hi", true],
        ["backtick substitution", "`echo hi`", "backtick", "echo hi", true],
        ["process input", "<(cat a)", "process-input", "cat a", true],
        ["process output", ">(tee)", "process-output", "tee", true],
        ["incomplete substitution", "$(incomplete", "command", "incomplete", false],
    ])("represents %s in the tree", (_description, value, kind, content, complete) => {
        const word = parseBashAst(value).singleCommand?.singleWord;
        const substitution = word?.substitutions[0];

        expect(word?.kind).toBe(
            kind === "command" || kind === "backtick" ? "subshell" : "process-substitution",
        );
        expect(substitution).toMatchObject({ kind, content, complete });
    });

    it.each([
        ["heredoc", "<<", "<<"],
        ["tab-stripped heredoc", "<<-", "<<-"],
    ])("represents %s operators in the tree", (_description, value, operator) => {
        expect(parseBashAst(value).singleCommand?.singleRedirection?.operator).toBe(operator);
    });

    it("does not classify ordinary words as substitutions", () => {
        expect(parseBashAst("$HOME").singleCommand?.singleSubstitution).toBeUndefined();
        expect(parseBashAst("echo").singleCommand?.singleSubstitution).toBeUndefined();
        expect(parseBashAst("(cat a)").singleCommand?.singleSubstitution).toBeUndefined();
    });
});
