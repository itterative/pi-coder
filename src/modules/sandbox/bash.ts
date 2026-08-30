export type BashChainOperator = "&&" | "||" | "|" | "|&" | ";" | "&";
export type BashRedirectionOperator =
    | "<"
    | ">"
    | ">>"
    | "2>"
    | "2>>"
    | "2>&1"
    | "<<"
    | "<<-"
    | "&>"
    | "&>>"
    | `${number}>`
    | `${number}>>`
    | `${number}>&${number}`
    | `>&${number}`;

interface BashLexedSubstitution {
    kind: "command" | "backtick" | "process-input" | "process-output";
    value: string;
    content: string;
    complete: boolean;
}

interface BashDelimitedRead {
    value: string;
    complete: boolean;
}

interface BashLexedHeredoc {
    delimiter: string;
    delimiterToken: BashLexedWordToken;
    stripTabs: boolean;
    body: string;
    complete: boolean;
    terminator?: string;
}

interface BashLexedWordToken {
    type: "word";
    value: string;
    protected: boolean;
    substitutions: BashLexedSubstitution[];
    assignment?: { name: string; value: string };
    heredoc?: BashLexedHeredoc;
}

interface BashLexedOperatorToken {
    type: "operator";
    value: BashChainOperator;
}

interface BashLexedRedirectionToken {
    type: "redirection";
    value: BashRedirectionOperator;
}

interface BashLexedHeredocTerminatorToken {
    type: "heredoc-terminator";
    value: string;
}

type BashLexedToken =
    | BashLexedWordToken
    | BashLexedOperatorToken
    | BashLexedRedirectionToken
    | BashLexedHeredocTerminatorToken;
type BashLexedCommand = BashLexedToken[];

type AssignmentState = "candidate" | "value" | "invalid";

/**
 * Tokenize a bash script into structured tokens.
 *
 * Handles: line continuations, quotes, subshells $(...) `...`, process substitution,
 * heredocs, operators (| && || ; &), and redirections.
 *
 * Quotes are stripped from output but content is preserved.
 */
function tokenizeBash(input: string): BashLexedCommand[] {
    const commands: BashLexedCommand[] = [];
    const currentArgs: BashLexedToken[] = [];
    let currentArg = "";
    let currentArgProtected = false;
    let currentSubstitutions: BashLexedSubstitution[] = [];
    let assignmentState: AssignmentState = "candidate";
    let quote: string | null = null;
    const heredocs: BashLexedHeredoc[] = [];
    let i = 0;

    const pushArg = (allowEmpty = false): BashLexedWordToken | undefined => {
        if (!allowEmpty && currentArg === "") {
            return undefined;
        }

        const assignment =
            assignmentState === "invalid"
                ? undefined
                : /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(currentArg);
        const token: BashLexedWordToken = {
            type: "word",
            value: currentArg,
            protected: currentArgProtected,
            substitutions: currentSubstitutions,
            ...(assignment === null || assignment === undefined
                ? {}
                : { assignment: { name: assignment[1], value: assignment[2] } }),
        };
        currentArgs.push(token);
        currentArg = "";
        currentArgProtected = false;
        currentSubstitutions = [];
        assignmentState = "candidate";
        return token;
    };

    const pushSyntaxToken = (
        token:
            | {
                  type: "operator";
                  value: BashChainOperator;
              }
            | {
                  type: "redirection";
                  value: BashRedirectionOperator;
              },
    ): void => {
        pushArg();
        currentArgs.push(token as BashLexedToken);
    };

    const appendSubstitution = (substitution: BashLexedSubstitution): void => {
        currentArg += substitution.value;
        currentSubstitutions.push(substitution);
    };

    const appendUnquotedChar = (char: string): void => {
        if (assignmentState === "candidate") {
            if (char === "=") {
                const prefix = currentArg;
                assignmentState = /^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix) ? "value" : "invalid";
            } else {
                const validNameChar =
                    currentArg.length === 0
                        ? /^[A-Za-z_]$/.test(char)
                        : /^[A-Za-z0-9_]$/.test(char);
                if (!validNameChar) {
                    assignmentState = "invalid";
                }
            }
        }
        currentArg += char;
    };

    const pushCommand = () => {
        pushArg();
        if (currentArgs.length > 0) {
            commands.push([...currentArgs]);
            currentArgs.length = 0;
        }
    };

    const readBalanced = (open: string, close: string): BashDelimitedRead => {
        let depth = 1;
        let result = "";
        let complete = false;
        let nestedComplete = true;
        const quotes: string[] = [];
        while (i < input.length && depth > 0) {
            const c = input[i];
            const quote = quotes[quotes.length - 1];
            if (quote !== undefined) {
                if (quote !== "'" && c === "$" && input[i + 1] === "(") {
                    result += "$(";
                    i += 2;
                    const nested = readBalanced("(", ")");
                    result += nested.value;
                    if (!nested.complete) {
                        nestedComplete = false;
                    }
                    continue;
                }
                if ((quote === '"' || quote === "`") && c === "\\" && i + 1 < input.length) {
                    result += c + input[i + 1];
                    i += 2;
                    continue;
                }
                if (c === quote) {
                    quotes.pop();
                }
                result += c;
                i++;
                continue;
            }
            if (c === "\\" && i + 1 < input.length) {
                result += c + input[i + 1];
                i += 2;
                continue;
            }
            if (c === "$" && input[i + 1] === "(") {
                result += "$(";
                i += 2;
                const nested = readBalanced("(", ")");
                result += nested.value;
                if (!nested.complete) {
                    nestedComplete = false;
                }
                continue;
            }
            if (c === '"' || c === "'" || c === "`") {
                quotes.push(c);
                result += c;
                i++;
                continue;
            }
            if (c === open) {
                depth++;
            } else if (c === close) {
                depth--;
                complete = depth === 0 && nestedComplete;
            }
            result += c;
            i++;
        }
        return { value: result, complete };
    };

    const readBacktick = (): BashDelimitedRead => {
        i++;
        let result = "`";
        let complete = false;
        while (i < input.length && input[i] !== "`") {
            if (input[i] === "\\" && i + 1 < input.length) {
                result += input[i] + input[i + 1];
                i += 2;
                continue;
            }
            result += input[i];
            i++;
        }
        if (i < input.length) {
            result += "`";
            i++;
            complete = true;
        }
        return { value: result, complete };
    };

    while (i < input.length) {
        const char = input[i];

        // Heredoc content mode - consume queued bodies in declaration order.
        if (heredocs.length > 0) {
            if (char === "\n") {
                pushArg();
                i++;
                const pending = heredocs.splice(0);
                for (let index = 0; index < pending.length; index++) {
                    const current = pending[index];
                    const bodyLines: string[] = [];
                    let complete = false;
                    while (i < input.length) {
                        const lineStart = i;
                        const lineEnd = input.indexOf("\n", lineStart);
                        const line =
                            lineEnd === -1
                                ? input.slice(lineStart)
                                : input.slice(lineStart, lineEnd);
                        const lineToCheck = current.stripTabs ? line.replace(/^\t+/, "") : line;

                        if (lineToCheck === current.delimiter) {
                            current.body = bodyLines.join("\n");
                            current.complete = true;
                            current.terminator = line;
                            currentArgs.push({
                                type: "heredoc-terminator",
                                value: current.delimiter,
                            });
                            complete = true;
                            i = lineEnd === -1 ? input.length : lineEnd + 1;
                            break;
                        }
                        bodyLines.push(line);
                        i = lineEnd === -1 ? input.length : lineEnd + 1;
                    }
                    if (complete) {
                        continue;
                    }

                    current.body = bodyLines.join("\n");
                    current.complete = false;
                    for (const remaining of pending.slice(index + 1)) {
                        remaining.body = "";
                        remaining.complete = false;
                    }
                    i = input.length;
                    break;
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
            if (quote === '"' && char === "$" && input[i + 1] === "(") {
                i += 2;
                const balanced = readBalanced("(", ")");
                const substitution = "$(" + balanced.value;
                appendSubstitution({
                    kind: "command",
                    value: substitution,
                    content: balanced.complete ? balanced.value.slice(0, -1) : balanced.value,
                    complete: balanced.complete,
                });
                continue;
            }
            if (quote === '"' && char === "`") {
                const backtick = readBacktick();
                appendSubstitution({
                    kind: "backtick",
                    value: backtick.value,
                    content: backtick.complete
                        ? backtick.value.slice(1, -1)
                        : backtick.value.slice(1),
                    complete: backtick.complete,
                });
                continue;
            }
            if (char === "\\" && quote === '"' && i + 1 < input.length) {
                const next = input[i + 1];
                if (
                    next === '"' ||
                    next === "\\" ||
                    next === "$" ||
                    next === "`" ||
                    next === "\n"
                ) {
                    currentArgProtected = true;
                    if (next !== "\n") {
                        currentArg += "\\" + next;
                    }
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
            currentArgProtected = true;
            i += 2;
            continue;
        }

        // Quote start
        if (char === '"' || char === "'") {
            currentArgProtected = true;
            if (assignmentState === "candidate") {
                assignmentState = "invalid";
            }
            quote = char;
            i++;
            continue;
        }

        // Subshell $(...)
        if (char === "$" && input[i + 1] === "(") {
            i += 2;
            const balanced = readBalanced("(", ")");
            const substitution = "$(" + balanced.value;
            appendSubstitution({
                kind: "command",
                value: substitution,
                content: balanced.complete ? balanced.value.slice(0, -1) : balanced.value,
                complete: balanced.complete,
            });
            continue;
        }

        // Backtick subshell `...`
        if (char === "`") {
            const backtick = readBacktick();
            appendSubstitution({
                kind: "backtick",
                value: backtick.value,
                content: backtick.complete ? backtick.value.slice(1, -1) : backtick.value.slice(1),
                complete: backtick.complete,
            });
            continue;
        }

        // Process substitution <(...) or >(...)
        if ((char === "<" || char === ">") && input[i + 1] === "(") {
            i += 2;
            const balanced = readBalanced("(", ")");
            const substitution = char + "(" + balanced.value;
            appendSubstitution({
                kind: char === "<" ? "process-input" : "process-output",
                value: substitution,
                content: balanced.complete ? balanced.value.slice(0, -1) : balanced.value,
                complete: balanced.complete,
            });
            continue;
        }

        // Heredoc << or <<-
        if (char === "<" && input[i + 1] === "<") {
            const isStrip = input[i + 2] === "-";
            pushSyntaxToken({ type: "redirection", value: isStrip ? "<<-" : "<<" });
            i += isStrip ? 3 : 2;

            while (i < input.length && /[ \t]/.test(input[i])) i++;

            let delimiter = "";
            let delimiterProtected = false;
            if (i < input.length && (input[i] === '"' || input[i] === "'")) {
                const q = input[i];
                delimiterProtected = true;
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
                currentArgProtected = delimiterProtected;
                assignmentState = "invalid";
                const delimiterToken = pushArg();
                if (delimiterToken !== undefined) {
                    const pendingHeredoc: BashLexedHeredoc = {
                        delimiter,
                        delimiterToken,
                        stripTabs: isStrip,
                        body: "",
                        complete: false,
                    };
                    delimiterToken.heredoc = pendingHeredoc;
                    heredocs.push(pendingHeredoc);
                }
            }
            continue;
        }

        // Operators: && || | ; &
        if (char === "&" && input[i + 1] === "&") {
            pushSyntaxToken({ type: "operator", value: "&&" });
            i += 2;
            continue;
        }
        if (char === "|" && input[i + 1] === "|") {
            pushSyntaxToken({ type: "operator", value: "||" });
            i += 2;
            continue;
        }
        if (char === "|" && input[i + 1] === "&") {
            pushSyntaxToken({ type: "operator", value: "|&" });
            i += 2;
            continue;
        }
        if (char === "|") {
            pushSyntaxToken({ type: "operator", value: "|" });
            i++;
            continue;
        }
        if (char === ";") {
            pushSyntaxToken({ type: "operator", value: ";" });
            i++;
            continue;
        }
        if (char === "&" && input[i + 1] === ">" && input[i + 2] === ">") {
            pushSyntaxToken({ type: "redirection", value: "&>>" });
            i += 3;
            continue;
        }
        if (char === "&" && input[i + 1] === ">") {
            pushSyntaxToken({ type: "redirection", value: "&>" });
            i += 2;
            continue;
        }
        if (char === "&") {
            pushSyntaxToken({ type: "operator", value: "&" });
            i++;
            continue;
        }

        // Redirections: < > >> 2> 2>> 2>&1
        if (
            currentArg === "" &&
            char === "2" &&
            input[i + 1] === ">" &&
            input[i + 2] === "&" &&
            input[i + 3] === "1" &&
            (input[i + 4] === undefined || /[\s;&|<>()]/.test(input[i + 4]))
        ) {
            pushSyntaxToken({ type: "redirection", value: "2>&1" });
            i += 4;
            continue;
        }
        if (currentArg === "" && /^\d$/.test(char)) {
            let fdEnd = i + 1;
            while (/^\d$/.test(input[fdEnd] ?? "")) {
                fdEnd++;
            }
            if (input[fdEnd] === ">" && input[fdEnd + 1] === "&") {
                let targetEnd = fdEnd + 2;
                while (/^\d$/.test(input[targetEnd] ?? "")) {
                    targetEnd++;
                }
                const targetBoundary =
                    input[targetEnd] === undefined || /[\s;&|<>()]/.test(input[targetEnd] ?? "");
                if (targetEnd > fdEnd + 2 && targetBoundary) {
                    const fd = input.slice(i, fdEnd);
                    const target = input.slice(fdEnd + 2, targetEnd);
                    const operator = `${fd}>&${target}` as BashRedirectionOperator;
                    pushSyntaxToken({ type: "redirection", value: operator });
                    i = targetEnd;
                    continue;
                }
            }
            if (input[fdEnd] === ">") {
                const fd = input.slice(i, fdEnd);
                const append = input[fdEnd + 1] === ">";
                const operator = `${fd}${append ? ">>" : ">"}` as BashRedirectionOperator;
                pushSyntaxToken({ type: "redirection", value: operator });
                i = fdEnd + (append ? 2 : 1);
                continue;
            }
        }
        if (currentArg === "" && char === "2" && input[i + 1] === ">" && input[i + 2] === ">") {
            pushSyntaxToken({ type: "redirection", value: "2>>" });
            i += 3;
            continue;
        }
        if (currentArg === "" && char === "2" && input[i + 1] === ">") {
            pushSyntaxToken({ type: "redirection", value: "2>" });
            i += 2;
            continue;
        }
        if (char === ">" && input[i + 1] === "&" && /^\d$/.test(input[i + 2] ?? "")) {
            let targetEnd = i + 2;
            while (/^\d$/.test(input[targetEnd + 1] ?? "")) {
                targetEnd++;
            }
            const target = input.slice(i + 2, targetEnd + 1);
            const targetBoundary =
                input[targetEnd + 1] === undefined ||
                /[\s;&|<>()]/.test(input[targetEnd + 1] ?? "");
            if (!targetBoundary) {
                pushSyntaxToken({ type: "redirection", value: ">" });
                i++;
                continue;
            }
            const operator = `>&${target}` as BashRedirectionOperator;
            pushSyntaxToken({ type: "redirection", value: operator });
            i = targetEnd + 1;
            continue;
        }
        if (char === ">" && input[i + 1] === ">") {
            pushSyntaxToken({ type: "redirection", value: ">>" });
            i += 2;
            continue;
        }
        if (char === ">" || char === "<") {
            pushSyntaxToken({ type: "redirection", value: char });
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
            currentArgProtected = true;
            if (assignmentState === "candidate") {
                assignmentState = "invalid";
            }
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
        appendUnquotedChar(char);
        i++;
    }

    for (const pendingHeredoc of heredocs) {
        pendingHeredoc.complete = false;
    }
    pushCommand();
    return commands;
}

export type BashWordKind = "word" | "subshell" | "process-substitution";

export interface BashSubstitutionNode {
    type: "substitution";
    kind: "command" | "backtick" | "process-input" | "process-output";
    value: string;
    content: string;
    complete: boolean;
    ast: BashAstNode;
}

export interface BashWordNode {
    type: "word";
    kind: BashWordKind;
    value: string;
    quoted: boolean;
    assignment?: { name: string; value: string };
    substitutions: readonly BashSubstitutionNode[];
}

export interface BashHeredocNode {
    delimiter: string;
    stripTabs: boolean;
    body: string;
    complete: boolean;
    terminator?: string;
}

export interface BashRedirectionNode {
    type: "redirection";
    operator: BashRedirectionOperator;
    target?: BashWordNode;
    heredoc?: BashHeredocNode;
}

export type BashCommandPart = BashWordNode | BashRedirectionNode;

export interface BashCommandNode {
    type: "command";
    /** Words and redirections in their original command order. */
    parts: readonly BashCommandPart[];
    words: readonly BashWordNode[];
    redirections: readonly BashRedirectionNode[];
}

export interface BashOperatorNode {
    type: "operator";
    value: BashChainOperator;
}

export interface BashStatementNode {
    type: "statement";
    parts: readonly (BashCommandNode | BashOperatorNode)[];
    commands: readonly BashCommandNode[];
    operators: readonly BashOperatorNode[];
}

export interface BashScriptNode {
    type: "script";
    statements: readonly BashStatementNode[];
}

export type BashAstNode = BashScriptNode;
export type BashCommandAst = BashCommandNode;
export type BashStatementAst = BashStatementNode;
export type BashWordAst = BashWordNode;

export interface BashEnvironmentAssignment {
    name: string;
    value: string;
    word: BashWordNode;
}

const BASH_CHAIN_OPERATORS = new Set<BashChainOperator>(["&&", "||", "|", "|&", ";", "&"]);

function createWordNode(token: BashLexedWordToken): BashWordNode {
    const substitutions = token.substitutions.map((substitution) => ({
        type: "substitution" as const,
        kind: substitution.kind,
        value: substitution.value,
        content: substitution.content,
        complete: substitution.complete,
        ast: parseBashAst(substitution.content).tree,
    }));
    const substitution = substitutions[0];
    let kind: BashWordKind = "word";
    if (substitution?.kind === "command" || substitution?.kind === "backtick") {
        kind = "subshell";
    } else if (substitution !== undefined) {
        kind = "process-substitution";
    }

    return {
        type: "word",
        kind,
        value: token.value,
        quoted: token.protected,
        ...(token.assignment === undefined ? {} : { assignment: token.assignment }),
        substitutions,
    };
}

function createHeredocNode(heredoc: BashLexedHeredoc): BashHeredocNode {
    return {
        delimiter: heredoc.delimiter,
        stripTabs: heredoc.stripTabs,
        body: heredoc.body,
        complete: heredoc.complete,
        ...(heredoc.terminator === undefined ? {} : { terminator: heredoc.terminator }),
    };
}

function createCommandNode(tokens: BashLexedToken[]): BashCommandNode {
    const parts: BashCommandPart[] = [];
    const words: BashWordNode[] = [];
    const redirections: BashRedirectionNode[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type === "word") {
            const word = createWordNode(token);
            parts.push(word);
            words.push(word);
            continue;
        }
        if (token.type === "heredoc-terminator") {
            continue;
        }
        if (token.type === "operator") {
            continue;
        }

        const redirection: BashRedirectionNode = { type: "redirection", operator: token.value };
        const target = tokens[i + 1];
        const duplicatesFileDescriptor = token.value.includes(">&");
        if (!duplicatesFileDescriptor && target?.type === "word") {
            redirection.target = createWordNode(target);
            if (target.heredoc !== undefined) {
                redirection.heredoc = createHeredocNode(target.heredoc);
            }
            i++;
        }
        parts.push(redirection);
        redirections.push(redirection);
    }

    return {
        type: "command",
        parts,
        words,
        redirections,
    };
}

function createStatementNode(tokens: BashLexedToken[]): BashStatementNode {
    const parts: (BashCommandNode | BashOperatorNode)[] = [];
    const commands: BashCommandNode[] = [];
    const operators: BashOperatorNode[] = [];
    let commandTokens: BashLexedToken[] = [];

    const pushCommand = () => {
        if (commandTokens.length === 0) {
            return;
        }
        const command = createCommandNode(commandTokens);
        parts.push(command);
        commands.push(command);
        commandTokens = [];
    };

    for (const token of tokens) {
        if (token.type === "operator" && BASH_CHAIN_OPERATORS.has(token.value)) {
            pushCommand();
            const operator = { type: "operator" as const, value: token.value };
            parts.push(operator);
            operators.push(operator);
            continue;
        }
        commandTokens.push(token);
    }
    pushCommand();

    return { type: "statement", parts, commands, operators };
}

/** A structured parse of a Bash input string. */
export class BashAst {
    public readonly type = "script" as const;

    /** Return the substitution represented by a word value, if unambiguous. */
    public static substitutionFor(
        word: BashWordNode,
        value: string = word.value,
    ): BashSubstitutionNode | undefined {
        const matches = word.substitutions.filter((substitution) => substitution.value === value);
        return matches.length === 1 ? matches[0] : undefined;
    }
    public readonly tree: BashScriptNode;
    public readonly statements: readonly BashStatement[];
    public readonly commands: readonly BashCommand[];

    public constructor(
        public readonly input: string,
        tree: BashScriptNode,
    ) {
        this.tree = tree;
        this.statements = tree.statements.map((node) => new BashStatement(node));
        this.commands = this.statements.flatMap((statement) => statement.commands);
    }

    /** Return the structured AST as immutable-by-convention plain nodes. */
    public get ast(): BashScriptNode {
        return this.tree;
    }

    /** Return the only simple command when this AST contains exactly one. */
    public get singleCommand(): BashCommand | undefined {
        if (this.statements.length !== 1) {
            return undefined;
        }
        const [statement] = this.statements;
        if (statement.parts.length !== 1 || statement.commands.length !== 1) {
            return undefined;
        }
        return statement.commands[0];
    }
}

export class BashStatement {
    public readonly parts: readonly (BashCommand | string)[];
    public readonly commands: readonly BashCommand[];
    public readonly operators: readonly BashChainOperator[];
    public readonly operatorNodes: readonly BashOperatorNode[];

    public constructor(public readonly node: BashStatementNode) {
        this.parts = node.parts.map((part) =>
            part.type === "command" ? new BashCommand(part) : part.value,
        );
        this.commands = node.commands.map((command) => new BashCommand(command));
        this.operatorNodes = node.operators;
        this.operators = node.operators.map((operator) => operator.value);
    }
}

/** Convenience view over one simple command in a BashAst. */
export class BashCommand {
    public constructor(public readonly node: BashCommandNode) {}

    public get parts(): readonly BashCommandPart[] {
        return this.node.parts;
    }

    /** Return the only word when this command contains no redirection. */
    public get singleWord(): BashWordNode | undefined {
        if (this.node.words.length !== 1 || this.node.redirections.length !== 0) {
            return undefined;
        }
        return this.node.words[0];
    }

    /** Return the only redirection when this command contains no words. */
    public get singleRedirection(): BashRedirectionNode | undefined {
        if (this.node.words.length !== 0 || this.node.redirections.length !== 1) {
            return undefined;
        }
        return this.node.redirections[0];
    }

    /** Return the complete substitution represented by this one-word command. */
    public get singleSubstitution(): BashSubstitutionNode | undefined {
        const word = this.singleWord;
        if (word === undefined || word.substitutions.length !== 1) {
            return undefined;
        }
        const [substitution] = word.substitutions;
        if (substitution.value !== word.value || !substitution.complete) {
            return undefined;
        }
        return substitution;
    }

    /** Return ordered word and redirection values for this command. */
    public toTokens(): string[] {
        return this.node.parts.flatMap((part) => {
            if (part.type === "word") {
                return [part.value];
            }
            return [part.operator, ...(part.target === undefined ? [] : [part.target.value])];
        });
    }

    public get words(): readonly BashWordNode[] {
        return this.node.words;
    }

    /** The executable name, after any leading NAME=value assignments. */
    public get command(): string | undefined {
        return this.node.words[this.commandIndex]?.value;
    }

    public get commandName(): string | undefined {
        return this.command;
    }

    private get commandIndex(): number {
        return this.environment.length;
    }

    public get environment(): readonly BashEnvironmentAssignment[] {
        const assignments: BashEnvironmentAssignment[] = [];
        for (const word of this.node.words) {
            if (word.assignment === undefined) {
                break;
            }
            assignments.push({ ...word.assignment, word });
        }
        return assignments;
    }

    /** Environment assignments keyed by variable name. */
    public get envs(): Readonly<Record<string, string>> {
        return Object.fromEntries(this.environment.map(({ name, value }) => [name, value]));
    }

    public get envAssignments(): readonly BashEnvironmentAssignment[] {
        return this.environment;
    }

    private get argumentWords(): readonly BashWordNode[] {
        if (this.command === undefined) {
            return [];
        }
        return this.node.words.slice(this.commandIndex + 1);
    }

    /** All command arguments, including flags, but excluding env assignments. */
    public get args(): readonly string[] {
        return this.argumentWords.map((word) => word.value);
    }

    public get arguments(): readonly string[] {
        return this.args;
    }

    public get flagWords(): readonly BashWordNode[] {
        const flags: BashWordNode[] = [];
        for (const word of this.argumentWords) {
            if (word.value === "--") {
                flags.push(word);
                break;
            }
            if (word.value.startsWith("-") && word.value !== "-") {
                flags.push(word);
            }
        }
        return flags;
    }

    public get flags(): readonly string[] {
        return this.flagWords.map((word) => word.value);
    }

    public get positionalWords(): readonly BashWordNode[] {
        const positional: BashWordNode[] = [];
        let optionsEnded = false;
        for (const word of this.argumentWords) {
            if (word.value === "--") {
                optionsEnded = true;
                continue;
            }
            if (!optionsEnded && word.value.startsWith("-") && word.value !== "-") {
                continue;
            }
            positional.push(word);
        }
        return positional;
    }

    public get positionalArgs(): readonly string[] {
        return this.positionalWords.map((word) => word.value);
    }

    public get substitutions(): readonly BashSubstitutionNode[] {
        return [
            ...this.node.words.flatMap((word) => word.substitutions),
            ...this.node.redirections.flatMap(
                (redirection) => redirection.target?.substitutions ?? [],
            ),
        ];
    }

    public get subshells(): readonly BashSubstitutionNode[] {
        return this.substitutions.filter(
            (substitution) => substitution.kind === "command" || substitution.kind === "backtick",
        );
    }

    public get redirections(): readonly BashRedirectionNode[] {
        return this.node.redirections;
    }
}

export function parseBashAst(input: string): BashAst {
    const tokenizedCommands = tokenizeBash(input);
    const tree: BashScriptNode = {
        type: "script",
        statements: tokenizedCommands.map(createStatementNode),
    };
    return new BashAst(input, tree);
}
