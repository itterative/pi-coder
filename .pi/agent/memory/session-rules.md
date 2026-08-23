---
name: session-rules
description: Session-scoped permission suggestions and mode handling in the bash permission prompt.
category: workflow
---

# Suggested session rules

When `src/tools/bash/index.ts` receives an `ask` caused by exactly one uncovered command segment, it can offer a suggested rule. Suggestions are explicit user choices, never auto-applied, and live only for the current session.

- `src/modules/sandbox/resolve.ts` returns unresolved tokenized segments through `resolvePermissionDetails()`.
- `src/modules/sandbox/suggestions.ts` uses a curated table, not token-shape inference. Scoped rows cover runners such as `npx`, `npm run`, `yarn`, `pnpm`, `bun`, `uv`, `docker`, `cargo`, and `poetry`; fixed rows cover tools such as `make`, `tox`, `ruff`, and `pytest`.
- Tokens used in a suggested pattern must match the safe-token policy. Unsafe tokens or missing rows produce no suggestion. The final pattern is reparsed before it is used.
- Session rules are module state, cleared on `session_start`, merged after config rules, and therefore win on identical patterns. They are never written to config or shown by `/bash-sandbox-config`.
- The remembered action is resolved when the prompt is confirmed. The session prompt mode resets to sandbox on session start; `s` toggles sandbox/direct mode, while configured rules and heuristic grants retain their own actions. Prompt choices put one-shot `Yes` first, remembered `Yes, and allow ...` second, and `No` third, making the default selection least-privileged across bash and file access.

The prompt uses `src/tui/select-with-message.ts`: its title is live, the border tone indicates sandbox/direct mode, and `InlineEditor` handles optional notes. The suggested option appears only for one unresolved segment; multiple unresolved segments use the plain prompt.

Tests: `test/modules/sandbox/suggestions.test.ts` and the unresolved-segment block in `test/modules/sandbox/resolve.test.ts`.
