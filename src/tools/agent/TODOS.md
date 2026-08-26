# User-managed todos (DO NOT MODIFY)

* agent tool tui output needs refinement
  * list action shows usage
  * clean up both compact view and detailed view
* /agent-sessions needs refinemnt (TBC)
* scout agents could use the bash tool instead of grep and ls tool
  * either we make more specific tools for it
  * or, we make use of heuristics to give it restrained access to bash tool
  * if we do the second, we might want to extend the heuristics a bit to
    give more details on why certain bash commands are not allowed
* big: persistence tests run against the actual database...

* non-isolated agents workflow is kinda hard to use
  * isolated workers are mostly fine atm (might want to use the same prompt gating as parent, but without inheritance)
  * especially workers, but review and scouts might want to use the same ideas
  * non-isolated workers should be allowed to edit files by default instead of prompting the user
  * same read/write access prompts should also be used (i.e., asking if it can read or edit from folder outside the cwd)
  * non-isolated agents should inherit the permissions of the parent
  * that is, if I allowed for example "npm vitest *", it should also be able to do the same
  * if I didn't allow "npm vitest *" before, and it runs one similar command, I should still be prompted to allow for this session

* sometimes (isolated) workers get stuck
  * applies to more types of workers, also setup ones seem to get stuck
  * seems to always happen during an (pre-)approved command
  * /home/sd/.pi/agent/traces/2026-08-25T10-20-38.932Z-worker-5.json
  * issue: calls are preflighted, which acquire a mutation lock, but the lock is only released on the
  * see TODO in src/tools/agent/child.ts ("session.agent.toolExecution = "sequential";")
  * long termm would be to recreate the tools and the permission gate inside the tool call instead

AGENT:
The deadlock is real and follows directly from Pi 0.84.1’s execution order:
- Parallel mode preflights calls sequentially, but executes them only after all preflights finish (`node_modules/.../pi-agent-core/dist/agent-loop.js:287-371`).
- The first mutation acquires `MutationQueue` in `tool_call` and stores its release until `tool_result` (`src/tools/agent/child/command-permissions.ts:181-216, 294-301`).
- A second mutation therefore waits during preflight for a result that cannot exist yet.
