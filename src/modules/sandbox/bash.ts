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
    nextIndex: number;
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
class BashTokenizer {
    private readonly commands: BashLexedCommand[] = [];
    private readonly currentArgs: BashLexedToken[] = [];
    private currentArg = "";
    private currentArgProtected = false;
    private currentSubstitutions: BashLexedSubstitution[] = [];
    private assignmentState: AssignmentState = "candidate";
    private quote: string | null = null;
    private readonly heredocs: BashLexedHeredoc[] = [];

    public constructor(private readonly input: string) {}

    public tokenize(): BashLexedCommand[] {
        for (let index = 0; index < this.input.length;) {
            index = this.parseNext(index);
        }

        for (const pendingHeredoc of this.heredocs) {
            pendingHeredoc.complete = false;
        }
        this.pushCommand();
        return this.commands;
    }

    /**
     * Try parsers in grammar order. A parser returns the input index when it
     * does not recognize anything; a successful parser must return a larger
     * index. The final regular-character parser guarantees progress.
     *
     * Keep this order in sync with Bash syntax precedence: heredoc bodies,
     * quoted content, continuations/quotes, substitutions, heredoc
     * declarations, operators, redirections, separators, escapes, and words.
     */
    private parseNext(index: number): number {
        let nextIndex = this.parseHeredocContent(index);
        if (nextIndex !== index) {
            return nextIndex;
        }
        nextIndex = this.parseQuotedCharacter(index);
        if (nextIndex !== index) {
            return nextIndex;
        }
        nextIndex = this.parseLineContinuation(index);
        if (nextIndex !== index) {
            return nextIndex;
        }
        nextIndex = this.parseQuoteStart(index);
        if (nextIndex !== index) {
            return nextIndex;
        }
        nextIndex = this.parseCommandSubstitution(index);
        if (nextIndex !== index) {
            return nextIndex;
        }
        nextIndex = this.parseBacktickSubstitution(index);
        if (nextIndex !== index) {
            return nextIndex;
        }
        nextIndex = this.parseProcessSubstitution(index);
        if (nextIndex !== index) {
            return nextIndex;
        }
        nextIndex = this.parseHeredocDeclaration(index);
        if (nextIndex !== index) {
            return nextIndex;
        }
        nextIndex = this.parseOperator(index);
        if (nextIndex !== index) {
            return nextIndex;
        }
        nextIndex = this.parseRedirection(index);
        if (nextIndex !== index) {
            return nextIndex;
        }
        nextIndex = this.parseNewline(index);
        if (nextIndex !== index) {
            return nextIndex;
        }
        nextIndex = this.parseEscape(index);
        if (nextIndex !== index) {
            return nextIndex;
        }
        nextIndex = this.parseWhitespace(index);
        if (nextIndex !== index) {
            return nextIndex;
        }
        return this.parseRegularCharacter(index);
    }

    private pushArg(allowEmpty = false): BashLexedWordToken | undefined {
        if (!allowEmpty && this.currentArg === "") {
            return undefined;
        }

        const assignment =
            this.assignmentState === "invalid"
                ? undefined
                : /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(this.currentArg);
        const token: BashLexedWordToken = {
            type: "word",
            value: this.currentArg,
            protected: this.currentArgProtected,
            substitutions: this.currentSubstitutions,
            ...(assignment === null || assignment === undefined
                ? {}
                : { assignment: { name: assignment[1], value: assignment[2] } }),
        };
        this.currentArgs.push(token);
        this.currentArg = "";
        this.currentArgProtected = false;
        this.currentSubstitutions = [];
        this.assignmentState = "candidate";
        return token;
    }

    private pushSyntaxToken(token: BashLexedOperatorToken | BashLexedRedirectionToken): void {
        this.pushArg();
        this.currentArgs.push(token);
    }

    private appendSubstitution(substitution: BashLexedSubstitution): void {
        this.currentArg += substitution.value;
        this.currentSubstitutions.push(substitution);
    }

    private appendUnquotedChar(char: string): void {
        if (this.assignmentState === "candidate") {
            if (char === "=") {
                const prefix = this.currentArg;
                this.assignmentState = /^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)
                    ? "value"
                    : "invalid";
            } else {
                const validNameChar =
                    this.currentArg.length === 0
                        ? /^[A-Za-z_]$/.test(char)
                        : /^[A-Za-z0-9_]$/.test(char);
                if (!validNameChar) {
                    this.assignmentState = "invalid";
                }
            }
        }
        this.currentArg += char;
    }

    private pushCommand(): void {
        this.pushArg();
        if (this.currentArgs.length === 0) {
            return;
        }
        this.commands.push([...this.currentArgs]);
        this.currentArgs.length = 0;
    }

    private readBalanced(index: number, open: string, close: string): BashDelimitedRead {
        let depth = 1;
        let result = "";
        let complete = false;
        let nestedComplete = true;
        let nextIndex = index;
        const quotes: string[] = [];

        while (nextIndex < this.input.length && depth > 0) {
            const char = this.input[nextIndex]!;
            const nextChar = this.input[nextIndex + 1];
            const quote = quotes[quotes.length - 1];

            if (quote !== undefined) {
                if (quote !== "'" && char === "$" && nextChar === "(") {
                    result += "$(";
                    const nested = this.readBalanced(nextIndex + 2, "(", ")");
                    result += nested.value;
                    nextIndex = nested.nextIndex;
                    nestedComplete = nestedComplete && nested.complete;
                    continue;
                }

                if ((quote === '"' || quote === "`") && char === "\\" && nextChar !== undefined) {
                    result += char + nextChar;
                    nextIndex += 2;
                    continue;
                }

                if (char === quote) {
                    quotes.pop();
                }

                result += char;
                nextIndex++;
                continue;
            }

            if (char === "\\" && nextChar !== undefined) {
                result += char + nextChar;
                nextIndex += 2;
                continue;
            }

            if (char === "$" && nextChar === "(") {
                result += "$(";
                const nested = this.readBalanced(nextIndex + 2, "(", ")");
                result += nested.value;
                nextIndex = nested.nextIndex;
                nestedComplete = nestedComplete && nested.complete;
                continue;
            }

            if (char === '"' || char === "'" || char === "`") {
                quotes.push(char);
                result += char;
                nextIndex++;
                continue;
            }

            if (char === open) {
                depth++;
            } else if (char === close) {
                depth--;
                complete = depth === 0 && nestedComplete;
            }

            result += char;
            nextIndex++;
        }

        return { value: result, complete, nextIndex };
    }

    private readBacktick(index: number): BashDelimitedRead {
        let nextIndex = index + 1;
        let result = "`";

        while (nextIndex < this.input.length && this.input[nextIndex] !== "`") {
            const char = this.input[nextIndex]!;
            const nextChar = this.input[nextIndex + 1];
            if (char === "\\" && nextChar !== undefined) {
                result += char + nextChar;
                nextIndex += 2;
                continue;
            }
            result += char;
            nextIndex++;
        }
        if (nextIndex >= this.input.length) {
            return { value: result, complete: false, nextIndex };
        }
        result += "`";
        nextIndex++;
        return { value: result, complete: true, nextIndex };
    }

    private parseHeredocContent(index: number): number {
        if (this.heredocs.length === 0 || this.input[index] !== "\n") {
            return index;
        }

        this.pushArg();
        let nextIndex = index + 1;
        const pending = this.heredocs.splice(0);
        for (let pendingIndex = 0; pendingIndex < pending.length; pendingIndex++) {
            const current = pending[pendingIndex];
            const body = this.parseHeredocBody(nextIndex, current);
            nextIndex = body.nextIndex;
            if (body.complete) {
                continue;
            }
            for (const remaining of pending.slice(pendingIndex + 1)) {
                remaining.body = "";
                remaining.complete = false;
            }
            nextIndex = this.input.length;
            break;
        }
        this.pushCommand();
        return nextIndex;
    }

    private parseHeredocBody(
        index: number,
        heredoc: BashLexedHeredoc,
    ): { complete: boolean; nextIndex: number } {
        const bodyLines: string[] = [];
        let nextIndex = index;
        while (nextIndex < this.input.length) {
            const lineStart = nextIndex;
            const lineEnd = this.input.indexOf("\n", lineStart);
            const line =
                lineEnd === -1 ? this.input.slice(lineStart) : this.input.slice(lineStart, lineEnd);
            const lineToCheck = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
            if (lineToCheck === heredoc.delimiter) {
                heredoc.body = bodyLines.join("\n");
                heredoc.complete = true;
                heredoc.terminator = line;
                this.currentArgs.push({
                    type: "heredoc-terminator",
                    value: heredoc.delimiter,
                });
                nextIndex = lineEnd === -1 ? this.input.length : lineEnd + 1;
                return { complete: true, nextIndex };
            }
            bodyLines.push(line);
            nextIndex = lineEnd === -1 ? this.input.length : lineEnd + 1;
        }
        heredoc.body = bodyLines.join("\n");
        heredoc.complete = false;
        return { complete: false, nextIndex };
    }

    private parseQuotedCharacter(index: number): number {
        const quote = this.quote;
        if (quote === null) {
            return index;
        }

        const char = this.input[index]!;
        const nextChar = this.input[index + 1];
        if (quote === '"' && char === "$" && nextChar === "(") {
            return this.parseCommandSubstitution(index);
        }
        if (quote === '"' && char === "`") {
            return this.appendBacktickSubstitution(index);
        }
        if (char === "\\" && quote === '"' && nextChar !== undefined) {
            if (
                nextChar !== '"' &&
                nextChar !== "\\" &&
                nextChar !== "$" &&
                nextChar !== "`" &&
                nextChar !== "\n"
            ) {
                this.currentArg += char;
                return index + 1;
            }
            this.currentArgProtected = true;
            if (nextChar !== "\n") {
                this.currentArg += "\\" + nextChar;
            }
            return index + 2;
        }
        if (char === quote) {
            this.quote = null;
            const nextIndex = index + 1;
            if (this.input[nextIndex] === undefined || /[\s]/.test(this.input[nextIndex]!)) {
                this.pushArg(true);
            }
            return nextIndex;
        }
        this.currentArg += char;
        return index + 1;
    }

    private parseLineContinuation(index: number): number {
        if (this.input[index] !== "\\" || this.input[index + 1] !== "\n") {
            return index;
        }
        this.currentArgProtected = true;
        return index + 2;
    }

    private parseQuoteStart(index: number): number {
        const char = this.input[index];
        if (char !== '"' && char !== "'") {
            return index;
        }
        this.currentArgProtected = true;
        if (this.assignmentState === "candidate") {
            this.assignmentState = "invalid";
        }
        this.quote = char;
        return index + 1;
    }

    private parseCommandSubstitution(index: number): number {
        if (this.input[index] !== "$" || this.input[index + 1] !== "(") {
            return index;
        }
        const balanced = this.readBalanced(index + 2, "(", ")");
        const substitution = "$(" + balanced.value;
        this.appendSubstitution({
            kind: "command",
            value: substitution,
            content: balanced.complete ? balanced.value.slice(0, -1) : balanced.value,
            complete: balanced.complete,
        });
        return balanced.nextIndex;
    }

    private parseBacktickSubstitution(index: number): number {
        if (this.input[index] !== "`") {
            return index;
        }
        return this.appendBacktickSubstitution(index);
    }

    private appendBacktickSubstitution(index: number): number {
        const backtick = this.readBacktick(index);
        this.appendSubstitution({
            kind: "backtick",
            value: backtick.value,
            content: backtick.complete ? backtick.value.slice(1, -1) : backtick.value.slice(1),
            complete: backtick.complete,
        });
        return backtick.nextIndex;
    }

    private parseProcessSubstitution(index: number): number {
        const operator = this.input[index];
        if ((operator !== "<" && operator !== ">") || this.input[index + 1] !== "(") {
            return index;
        }
        const balanced = this.readBalanced(index + 2, "(", ")");
        const substitution = operator + "(" + balanced.value;
        this.appendSubstitution({
            kind: operator === "<" ? "process-input" : "process-output",
            value: substitution,
            content: balanced.complete ? balanced.value.slice(0, -1) : balanced.value,
            complete: balanced.complete,
        });
        return balanced.nextIndex;
    }

    private parseHeredocDeclaration(index: number): number {
        if (this.input[index] !== "<" || this.input[index + 1] !== "<") {
            return index;
        }
        const isStrip = this.input[index + 2] === "-";
        this.pushSyntaxToken({ type: "redirection", value: isStrip ? "<<-" : "<<" });
        let nextIndex = index + (isStrip ? 3 : 2);

        while (nextIndex < this.input.length && /[ \t]/.test(this.input[nextIndex]!)) {
            nextIndex++;
        }

        let delimiter = "";
        let delimiterProtected = false;
        const delimiterQuote = this.input[nextIndex];
        if (delimiterQuote === '"' || delimiterQuote === "'") {
            const quote = delimiterQuote;
            delimiterProtected = true;
            nextIndex++;
            while (nextIndex < this.input.length) {
                const char = this.input[nextIndex]!;
                if (char === quote) {
                    break;
                }
                delimiter += char;
                nextIndex++;
            }
            if (nextIndex < this.input.length) {
                nextIndex++;
            }
        } else {
            while (nextIndex < this.input.length && !/[\s]/.test(this.input[nextIndex]!)) {
                delimiter += this.input[nextIndex]!;
                nextIndex++;
            }
        }

        if (delimiter === "") {
            return nextIndex;
        }
        this.currentArg = delimiter;
        this.currentArgProtected = delimiterProtected;
        this.assignmentState = "invalid";
        const delimiterToken = this.pushArg();
        if (delimiterToken === undefined) {
            return nextIndex;
        }
        const pendingHeredoc: BashLexedHeredoc = {
            delimiter,
            delimiterToken,
            stripTabs: isStrip,
            body: "",
            complete: false,
        };
        delimiterToken.heredoc = pendingHeredoc;
        this.heredocs.push(pendingHeredoc);
        return nextIndex;
    }

    private parseOperator(index: number): number {
        const char = this.input[index];
        const next = this.input[index + 1];
        if (char === "&" && next === "&") {
            this.pushSyntaxToken({ type: "operator", value: "&&" });
            return index + 2;
        }
        if (char === "|" && next === "|") {
            this.pushSyntaxToken({ type: "operator", value: "||" });
            return index + 2;
        }
        if (char === "|" && next === "&") {
            this.pushSyntaxToken({ type: "operator", value: "|&" });
            return index + 2;
        }
        if (char === "|") {
            this.pushSyntaxToken({ type: "operator", value: "|" });
            return index + 1;
        }
        if (char === ";") {
            this.pushSyntaxToken({ type: "operator", value: ";" });
            return index + 1;
        }
        if (char === "&" && next === ">" && this.input[index + 2] === ">") {
            this.pushSyntaxToken({ type: "redirection", value: "&>>" });
            return index + 3;
        }
        if (char === "&" && next === ">") {
            this.pushSyntaxToken({ type: "redirection", value: "&>" });
            return index + 2;
        }
        if (char !== "&") {
            return index;
        }
        this.pushSyntaxToken({ type: "operator", value: "&" });
        return index + 1;
    }

    private parseRedirection(index: number): number {
        let nextIndex = this.parseNumberedRedirection(index);
        if (nextIndex !== index) {
            return nextIndex;
        }
        nextIndex = this.parseOutputFdDuplication(index);
        if (nextIndex !== index) {
            return nextIndex;
        }
        if (this.input[index] === ">" && this.input[index + 1] === ">") {
            this.pushSyntaxToken({ type: "redirection", value: ">>" });
            return index + 2;
        }
        if (this.input[index] !== ">" && this.input[index] !== "<") {
            return index;
        }
        this.pushSyntaxToken({ type: "redirection", value: this.input[index] });
        return index + 1;
    }

    private parseNumberedRedirection(index: number): number {
        if (this.currentArg !== "") {
            return index;
        }
        const char = this.input[index]!;
        if (
            char === "2" &&
            this.input[index + 1] === ">" &&
            this.input[index + 2] === "&" &&
            this.input[index + 3] === "1" &&
            (this.input[index + 4] === undefined || /[\s;&|<>()]/.test(this.input[index + 4]!))
        ) {
            this.pushSyntaxToken({ type: "redirection", value: "2>&1" });
            return index + 4;
        }
        if (!/^\d$/.test(char)) {
            return index;
        }
        let fdEnd = index + 1;
        while (/^\d$/.test(this.input[fdEnd] ?? "")) {
            fdEnd++;
        }
        if (this.input[fdEnd] === ">" && this.input[fdEnd + 1] === "&") {
            let targetEnd = fdEnd + 2;
            while (/^\d$/.test(this.input[targetEnd] ?? "")) {
                targetEnd++;
            }
            const targetBoundary =
                this.input[targetEnd] === undefined ||
                /[\s;&|<>()]/.test(this.input[targetEnd] ?? "");
            if (targetEnd > fdEnd + 2 && targetBoundary) {
                const fd = this.input.slice(index, fdEnd);
                const target = this.input.slice(fdEnd + 2, targetEnd);
                const operator = `${fd}>&${target}` as BashRedirectionOperator;
                this.pushSyntaxToken({ type: "redirection", value: operator });
                return targetEnd;
            }
        }
        if (this.input[fdEnd] !== ">") {
            return index;
        }
        const fd = this.input.slice(index, fdEnd);
        const append = this.input[fdEnd + 1] === ">";
        const operator = `${fd}${append ? ">>" : ">"}` as BashRedirectionOperator;
        this.pushSyntaxToken({ type: "redirection", value: operator });
        return fdEnd + (append ? 2 : 1);
    }

    private parseOutputFdDuplication(index: number): number {
        if (this.input[index] !== ">" || this.input[index + 1] !== "&") {
            return index;
        }
        if (!/^\d$/.test(this.input[index + 2] ?? "")) {
            return index;
        }
        let targetEnd = index + 2;
        while (/^\d$/.test(this.input[targetEnd + 1] ?? "")) {
            targetEnd++;
        }
        const target = this.input.slice(index + 2, targetEnd + 1);
        const targetBoundary =
            this.input[targetEnd + 1] === undefined ||
            /[\s;&|<>()]/.test(this.input[targetEnd + 1] ?? "");
        if (!targetBoundary) {
            this.pushSyntaxToken({ type: "redirection", value: ">" });
            return index + 1;
        }
        const operator = `>&${target}` as BashRedirectionOperator;
        this.pushSyntaxToken({ type: "redirection", value: operator });
        return targetEnd + 1;
    }

    private parseNewline(index: number): number {
        if (this.input[index] !== "\n") {
            return index;
        }
        this.pushCommand();
        return index + 1;
    }

    private parseEscape(index: number): number {
        if (this.input[index] !== "\\" || this.input[index + 1] === undefined) {
            return index;
        }
        this.currentArgProtected = true;
        if (this.assignmentState === "candidate") {
            this.assignmentState = "invalid";
        }
        this.currentArg += this.input[index + 1];
        return index + 2;
    }

    private parseWhitespace(index: number): number {
        if (this.input[index] !== " " && this.input[index] !== "\t") {
            return index;
        }
        this.pushArg();
        return index + 1;
    }

    private parseRegularCharacter(index: number): number {
        this.appendUnquotedChar(this.input[index]!);
        return index + 1;
    }
}

function tokenizeBash(input: string): BashLexedCommand[] {
    return new BashTokenizer(input).tokenize();
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
