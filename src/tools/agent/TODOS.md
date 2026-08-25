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
* non-isolated workers should notify the parent there was a change
  * should notify the parent immediatly if the parent is working
  * otherwise, it should either coalesce at the end (probably flow is already there for the agent collection side)
* isolated worker workspace apply should still work if there's no conflict
  * needs ironing out for the proper flow here



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
- The first mutation acquires `MutationQueue` in `tool_call` and stores its release until `tool_result` (`src/tools/agent/child/worker-permissions.ts:181-216, 294-301`).
- A second mutation therefore waits during preflight for a result that cannot exist yet.
