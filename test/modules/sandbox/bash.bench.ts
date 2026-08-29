import { bench, describe } from "vitest";
import { parseBashAst } from "../../../src/modules/sandbox/bash";

interface BenchmarkCorpus {
    level: "simple" | "medium" | "high";
    commands: readonly string[];
}

const corpora: readonly BenchmarkCorpus[] = [
    {
        level: "simple",
        commands: [
            "ls -la",
            "cat README.md",
            "echo hello",
            "git status --short",
            "npm test",
        ],
    },
    {
        level: "medium",
        commands: [
            'cd src && grep -R "parseBashAst" --include "*.ts" . | head -20',
            "FOO=bar git diff --stat -- src/index.ts",
            "find . -type f -name '*.ts' -print | sort | head -50",
            "printf '%s\\n' one two three > output.txt && cat output.txt",
            "npm run test -- --run test/modules/sandbox/bash.test.ts",
        ],
    },
    {
        level: "high",
        commands: [
            `cat <<'EOF' | sed -n '1,20p' > output.txt
$(printf '%s\\n' "$(git status --short)")
EOF
printf '%s\\n' done`,
            "cd src && git diff --name-only | while read file; do grep -n \"parseBashAst\" \"$file\"; done | sort -u",
            "result=$(printf '%s' \"$(printf '%s' nested.txt)\") && cat \"$(printf '%s' \"$result\")\" 2>&1 | tee >(sort > sorted.txt)",
            "FOO=$(printf '%s' value) BAR=$(printf '%s' other) echo \"$(printf '%s' \"$FOO-$BAR\")\" > output.txt 2>> errors.txt",
            `git log --format='%H %s' --all -- src | head -100 && git show --stat --oneline HEAD | cat 2>&1`,
        ],
    },
];

for (const corpus of corpora) {
    describe(`Bash parser: ${corpus.level} scenarios`, () => {
        bench("parseBashAst", () => {
            for (const command of corpus.commands) {
                parseBashAst(command);
            }
        });
    });
}
