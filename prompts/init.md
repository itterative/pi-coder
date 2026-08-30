---
description: Initialize or update AGENTS.md for the current project
---

Create or update the `AGENTS.md` file in the project root. AGENTS.md is loaded into every session, so it must be concise — only include what the model would get wrong without it.

## Phase 1: Ask what to set up

Ask the user what they want to document. pi loads `AGENTS.md` files automatically:

- **Project `AGENTS.md`** at the repo root — checked into source control, shared with the team.
- **Global `~/.pi/agent/AGENTS.md`** — personal instructions loaded for all projects, not shared.

Clarify which file(s) to create or update. If the user wants personal preferences that shouldn't be committed, guide them to the global file or suggest keeping those details out of the project AGENTS.md.

## Phase 2: Explore the codebase

Survey the codebase by reading key files to understand the project: manifest files (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`, etc.), README, Makefile/build configs, CI config, existing `AGENTS.md`, `.cursor/rules` or `.cursorrules`, `.github/copilot-instructions.md`, `.windsurfrules`, `.clinerules`, any `.pi/` config.

Detect:

- Build, test, and lint commands (especially non-standard ones)
- Languages, frameworks, and package manager
- Project structure (monorepo with workspaces, multi-module, or single project)
- Code style rules that differ from language defaults
- Non-obvious gotchas, required env vars, or workflow quirks
- Formatter configuration (prettier, biome, ruff, black, gofmt, rustfmt, or a unified format script like `npm run format` / `make fmt`)
- Existing `.pi/agent/` directory contents

Note what you could NOT figure out from code alone — these become interview questions.

## Phase 3: Fill in the gaps

Ask the user only about things the code can't answer.

If the user chose project AGENTS.md or both: ask about codebase practices — non-obvious commands, gotchas, branch/PR conventions, required env setup, testing quirks. Skip things already in README or obvious from manifest files. Do not mark any options as "recommended" — this is about how their team works, not best practices.

If the user wants to set up global personal rules: ask about them, not the codebase. Do not mark any options as "recommended" — this is about their personal preferences, not best practices. Examples:

- What's their role? (e.g., "backend engineer", "data scientist", "new hire onboarding")
- How familiar are they with this codebase and its languages/frameworks? (so responses can calibrate explanation depth)
- Do they have personal sandbox URLs, test accounts, API key paths, or local setup details worth noting?
- Any communication preferences? (e.g., "be terse", "always explain tradeoffs", "don't summarize at the end")

Show the proposed AGENTS.md content directly and ask: "Does this look right? Anything to add, change, or remove?" Iterate based on feedback.

## Phase 4: Write AGENTS.md (if user chose project or both)

Write a minimal AGENTS.md at the project root. Every line must pass this test: "Would removing this cause mistakes?" If no, cut it.

Include:

- Build/test/lint commands the model can't guess (non-standard scripts, flags, or sequences)
- Code style rules that DIFFER from language defaults (e.g., "prefer type over interface")
- Testing instructions and quirks (e.g., "run single test with: pytest -k 'test_name'")
- Repo etiquette (branch naming, PR conventions, commit style)
- Required env vars or setup steps
- Non-obvious gotchas or architectural decisions
- Important parts from existing AI coding tool configs if they exist (`.cursor/rules`, `.cursorrules`, `.github/copilot-instructions.md`, `.windsurfrules`, `.clinerules`)

Exclude:

- File-by-file structure or component lists (the model can discover these by reading the codebase)
- Standard language conventions the model already knows
- Generic advice ("write clean code", "handle errors")
- Detailed API docs or long references — use relative paths to reference separate docs
- Information that changes frequently — reference the source file so the model reads the current version
- Long tutorials or walkthroughs
- Commands obvious from manifest files (e.g., standard "npm test", "cargo test", "pytest")

Be specific: "Use 2-space indentation in TypeScript" is better than "Format code properly."

Do not repeat yourself and do not make up sections like "Common Development Tasks" or "Tips for Development" — only include information expressly found in files you read.

If AGENTS.md already exists: read it, propose specific changes, and explain why each change improves it. Do not silently overwrite.

## Phase 5: Write global rules (if user chose global or both)

Write a minimal `~/.pi/agent/AGENTS.md`. This file is loaded for all projects.

Include:

- The user's role and general familiarity levels (so responses can calibrate explanations)
- Personal workflow or communication preferences
- Any cross-project setup details worth noting

Keep it short — only include what would make responses noticeably better for this user. Project-specific details belong in the project AGENTS.md.

If the file already exists: read it, propose specific additions, and do not silently overwrite.

## Phase 6: Summary and next steps

Recap what was set up — which files were written and the key points included in each. Remind the user these files are a starting point: they should review and tweak them, and can run `/init` again anytime to re-scan.

Then suggest a few additional optimizations based on what you found, presented as a concise to-do list with the most impactful items first. Only include what applies:

- If linting is missing for the project's language, suggest setting it up.
- If tests are missing or sparse, suggest a test framework so the model can verify its own changes.
- If a formatter exists but isn't wired into the project config, suggest integrating it.
