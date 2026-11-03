import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        // Neutralize the development decision log so no suite can append to the
        // real <agent-dir>/pi-coder/bash-log.jsonl.
        setupFiles: ["test/setup.ts"],
        // Keep the repository's test command scoped to this checkout. A legacy `.state` directory, and any
        // complete project copy sitting in one, must never become a Vitest project of its own.
        include: ["test/**/*.test.ts"],
        exclude: ["**/.state/**", "**/node_modules/**", "**/dist/**"],
        coverage: {
            provider: "v8",
            reporter: ["text", "json", "html"],
            exclude: ["**/.state/**", "**/node_modules/**", "test/**"],
        },
    },
});
