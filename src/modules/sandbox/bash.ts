/**
 * Parse a bash script into a list of commands, where each command is a list of arguments.
 *
 * Handles: line continuations, quotes, subshells $(...) `...`, process substitution,
 * heredocs, operators (| && || ; &), and redirections.
 *
 * Quotes are stripped from output but content is preserved.
 */
export function parseBash(input: string): string[][] {
    const commands: string[][] = [];
    const currentArgs: string[] = [];
    let currentArg = "";
    let quote: string | null = null;
    let heredoc: { delimiter: string; stripTabs: boolean } | null = null;
    let heredocContent = "";
    let i = 0;

    const pushArg = (allowEmpty = false) => {
        if (allowEmpty || currentArg !== "") {
            currentArgs.push(currentArg);
            currentArg = "";
        }
    };

    const pushCommand = () => {
        pushArg();
        if (currentArgs.length > 0) {
            commands.push([...currentArgs]);
            currentArgs.length = 0;
        }
    };

    const readBalanced = (open: string, close: string): string => {
        let depth = 1;
        let result = "";
        while (i < input.length && depth > 0) {
            const c = input[i];
            if (c === open) depth++;
            else if (c === close) depth--;
            result += c;
            i++;
        }
        return result;
    };

    while (i < input.length) {
        const char = input[i];

        // Heredoc content mode - consume until delimiter found on its own line
        if (heredoc) {
            if (char === "\n") {
                pushArg();
                i++;
                while (i < input.length) {
                    const lineStart = i;
                    const lineEnd = input.indexOf("\n", lineStart);
                    const line = lineEnd === -1 ? input.slice(lineStart) : input.slice(lineStart, lineEnd);
                    const lineToCheck = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;

                    heredocContent += (heredocContent ? "\n" : "") + line;

                    if (lineToCheck === heredoc.delimiter) {
                        currentArgs.push(heredoc.delimiter);
                        heredoc = null;
                        heredocContent = "";
                        i = lineEnd === -1 ? input.length : lineEnd + 1;
                        break;
                    }
                    i = lineEnd === -1 ? input.length : lineEnd + 1;
                }
                if (currentArgs.length > 0) {
                    commands.push([...currentArgs]);
                    currentArgs.length = 0;
                }
                continue;
            }
        }

        // Inside quotes
        if (quote) {
            if (char === "\\" && quote === '"' && i + 1 < input.length) {
                const next = input[i + 1];
                if (next === '"' || next === "\\" || next === "$" || next === "`" || next === "\n") {
                    if (next !== "\n") currentArg += "\\" + next;
                    i += 2;
                    continue;
                }
            }
            if (char === quote) {
                quote = null;
                i++;
                const next = input[i];
                if (next === undefined || /[\s]/.test(next)) {
                    pushArg(true);
                }
                continue;
            }
            currentArg += char;
            i++;
            continue;
        }

        // Line continuation
        if (char === "\\" && input[i + 1] === "\n") {
            i += 2;
            continue;
        }

        // Quote start
        if (char === '"' || char === "'") {
            quote = char;
            i++;
            continue;
        }

        // Subshell $(...)
        if (char === "$" && input[i + 1] === "(") {
            pushArg();
            i += 2;
            currentArg = "$(" + readBalanced("(", ")");
            pushArg();
            continue;
        }

        // Backtick subshell `...`
        if (char === "`") {
            pushArg();
            i++;
            let subshell = "`";
            while (i < input.length && input[i] !== "`") {
                if (input[i] === "\\" && i + 1 < input.length) {
                    subshell += input[i] + input[i + 1];
                    i += 2;
                } else {
                    subshell += input[i];
                    i++;
                }
            }
            if (i < input.length) {
                subshell += "`";
                i++;
            }
            currentArg = subshell;
            pushArg();
            continue;
        }

        // Process substitution <(...) or >(...)
        if ((char === "<" || char === ">") && input[i + 1] === "(") {
            pushArg();
            i += 2;
            currentArg = char + "(" + readBalanced("(", ")");
            pushArg();
            continue;
        }

        // Heredoc << or <<-
        if (char === "<" && input[i + 1] === "<") {
            pushArg();
            const isStrip = input[i + 2] === "-";
            currentArg = isStrip ? "<<-" : "<<";
            pushArg();
            i += isStrip ? 3 : 2;

            while (i < input.length && /[ \t]/.test(input[i])) i++;

            let delimiter = "";
            if (i < input.length && (input[i] === '"' || input[i] === "'")) {
                const q = input[i];
                i++;
                while (i < input.length && input[i] !== q) {
                    delimiter += input[i];
                    i++;
                }
                if (i < input.length) i++;
            } else {
                while (i < input.length && !/[\s]/.test(input[i])) {
                    delimiter += input[i];
                    i++;
                }
            }

            if (delimiter) {
                currentArg = delimiter;
                pushArg();
                heredoc = { delimiter, stripTabs: isStrip };
                heredocContent = "";
            }
            continue;
        }

        // Operators: && || | ; &
        if (char === "&" && input[i + 1] === "&") {
            pushArg();
            currentArg = "&&";
            pushArg();
            i += 2;
            continue;
        }
        if (char === "|" && input[i + 1] === "|") {
            pushArg();
            currentArg = "||";
            pushArg();
            i += 2;
            continue;
        }
        if (char === "|") {
            pushArg();
            currentArg = "|";
            pushArg();
            i++;
            continue;
        }
        if (char === ";") {
            pushArg();
            currentArg = ";";
            pushArg();
            i++;
            continue;
        }
        if (char === "&") {
            pushArg();
            currentArg = "&";
            pushArg();
            i++;
            continue;
        }

        // Redirections: < > >> 2> 2>> 2>&1
        if (char === "2" && input[i + 1] === ">" && input[i + 2] === "&" && input[i + 3] === "1") {
            pushArg();
            currentArg = "2>&1";
            pushArg();
            i += 4;
            continue;
        }
        if (char === "2" && input[i + 1] === ">" && input[i + 2] === ">") {
            pushArg();
            currentArg = "2>>";
            pushArg();
            i += 3;
            continue;
        }
        if (char === "2" && input[i + 1] === ">") {
            pushArg();
            currentArg = "2>";
            pushArg();
            i += 2;
            continue;
        }
        if (char === ">" && input[i + 1] === ">") {
            pushArg();
            currentArg = ">>";
            pushArg();
            i += 2;
            continue;
        }
        if (char === ">" || char === "<") {
            pushArg();
            currentArg = char;
            pushArg();
            i++;
            continue;
        }

        // Newline - command separator
        if (char === "\n") {
            pushCommand();
            i++;
            continue;
        }

        // Escape (not line continuation)
        if (char === "\\" && i + 1 < input.length) {
            i++;
            currentArg += input[i];
            i++;
            continue;
        }

        // Whitespace - argument separator
        if (/[ \t]/.test(char)) {
            pushArg();
            i++;
            continue;
        }

        // Regular character
        currentArg += char;
        i++;
    }

    pushCommand();
    return commands;
}

export function isHeredocOperator(value: string): boolean {
    return value === "<<" || value === "<<-";
}

export function isSubshell(value: string): boolean {
    return (
        (value.startsWith("$(") && value.endsWith(")")) ||
        (value.startsWith("`") && value.endsWith("`"))
    );
}

export function isProcessSubstitution(value: string): boolean {
    return (
        (value.startsWith("<(") || value.startsWith(">(")) &&
        value.endsWith(")")
    );
}

export function getSubshellContent(value: string): string {
    if (value.startsWith("$(") && value.endsWith(")")) return value.slice(2, -1);
    if (value.startsWith("`") && value.endsWith("`")) return value.slice(1, -1);
    if ((value.startsWith("<(") || value.startsWith(">(")) && value.endsWith(")")) {
        return value.slice(2, -1);
    }
    return value;
}
