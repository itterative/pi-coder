---
name: session-rules
description: Session-scoped permission suggestions and mode handling in the bash permission prompt.
category: workflow
---

# Suggested session rules

When `src/tools/bash/index.ts` receives an `ask` caused by exactly one uncovered command segment, it can offer a suggested rule. Suggestions are explicit user choices, never auto-applied, and live only for the current session.

- `src/modules/sandbox/resolve.ts` returns unresolved tokenized segments through `resolvePermissionDetails()`.
- `src/modules/sandbox/suggestions.ts` uses a curated table, not token-shape inference. Scoped rows cover runners such as `npx`, `npm run`, `yarn`, `yarn dlx`, `pnpm`, `pnpm dlx`, `bun`, `bunx`, `uv`, `docker`, `cargo`, `go test`, `go vet`, `go fmt`, `go generate`, `dotnet test`, `mvn test`, `gradle test`, `bazel test`, `flutter test`, `dart test`, `swift test`, `mix test`, `deno test`, `deno fmt`, `deno lint`, and `cmake --build`; fixed rows cover tools such as `make`, `just`, `task`, `ninja`, `eslint`, `prettier`, `biome`, `tsc`, `stylelint`, `tox`, `ruff`, and `pytest`.
- Tokens used in a suggested pattern must match the safe-token policy. Unsafe tokens or missing rows produce no suggestion. The final pattern is reparsed before it is used.
- A transparent wrapper is unwrapped before suggesting, so `timeout 600 npm run test:run` offers `npm run test:run`—the same rule the bare command offers—because the matcher accepts the wrapped form too. A `timeout *` rule is never offered: it would authorize any command run under a timeout. Wrapper grammar lives in `command-wrappers.ts`; see the `heuristics` memory.
- Session rules are per-parent-session-manager runtime state, cleared on `session_start`, merged after config rules, and therefore win on identical patterns. Non-isolated delegated children share this live state; isolated workers use a separate state and do not inherit these rules. An explicit remembered rule selected in an isolated worker is also copied into the parent state for later parent or non-isolated child calls. They are never written to config or shown by `/bash-sandbox-config`.
- The remembered action is resolved when the prompt is confirmed. The session prompt mode resets to sandbox on session start; `s` toggles sandbox/direct mode, while configured rules and heuristic grants retain their own actions. Prompt choices put one-shot `Yes` first, remembered `Yes, and allow ...` second, and `No` third, making the default selection least-privileged across bash and file access.
- Every prompt is recorded in the bash decision log with its outcome — `yes`, `remember`, `no`, or `dismissed` for an Esc/abort, which the gates treat as a denial but which is not a judgement on the command — plus the rule the suggestion table offered and the rule actually saved. See the `bash-decision-log` memory.

The prompt uses `src/tui/select-with-message.ts`: its title is live, the border tone indicates sandbox/direct mode, `InlineEditor` handles optional notes, and `j/k` page-scroll the command/file content while `↑/↓` navigate permission choices (unmodified PageUp/PageDown are consumed by pi fullscreen viewport routing). Child edit/write mutation previews use pi's `generateDiffString` and `renderDiff` from the proposed payload only; they do not read an unapproved target path. Bash and child-agent permission prompts set a 150 ms `confirmationDelayMs` grace period so buffered terminal input cannot immediately approve a command or mutation; the guard is on the confirmation flow, not general input. The suggested option appears only for one unresolved segment; multiple unresolved segments use the plain prompt.

Tests: `test/modules/sandbox/suggestions.test.ts` and the unresolved-segment block in `test/modules/sandbox/resolve.test.ts`.