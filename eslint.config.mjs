import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";
import tseslint from "typescript-eslint";

// NOTE: read by scripts/cognitive_load_report.py
const COMPLEXITY_THRESHOLD = 60;
const COGNITIVE_COMPLEXITY_THRESHOLD = 30;

export default [
    {
        ignores: [
            "**/.git/**",
            "**/.state/**",
            "**/.workspace-validation/**",
            "**/coverage/**",
            "**/dist/**",
            "**/node_modules/**",
            "vendor/**",
        ],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["**/*.ts"],
        languageOptions: {
            globals: globals.node,
            parserOptions: {
                ecmaVersion: "latest",
                sourceType: "module",
            },
        },
        plugins: {
            sonarjs,
        },
        rules: {
            // TypeScript's compiler performs this check more accurately.
            "no-undef": "off",
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                    destructuredArrayIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                },
            ],

            // Start as warnings so the existing codebase can adopt the checks
            // without making unrelated cleanup part of this setup change.
            complexity: ["warn", { max: COMPLEXITY_THRESHOLD }],
            "sonarjs/cognitive-complexity": ["warn", COGNITIVE_COMPLEXITY_THRESHOLD],
        },
    },
    {
        files: ["test/**/*.ts"],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.vitest,
            },
        },
    },
    eslintConfigPrettier,
];
