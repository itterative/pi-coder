import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        // Neutralize the development decision log so no suite can append to the
        // real .state/bash-log.jsonl.
        setupFiles: ["test/setup.ts"],
        // Keep the repository's test command scoped to this checkout. Persistent
        // isolated worktrees under .state are complete project copies and must
        // never become Vitest projects of their own.
        include: ["test/**/*.test.ts"],
        exclude: ["**/.state/**", "**/node_modules/**", "**/dist/**"],
        coverage: {
            provider: "v8",
            reporter: ["text", "json", "html"],
            exclude: ["**/.state/**", "**/node_modules/**", "test/**"],
        },
    },
});
