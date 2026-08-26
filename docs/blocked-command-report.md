# Blocked command report

## Context

Read-only `scout` and `reviewer` agents reviewed recent Git changes in this repository. The commands below were attempted during those reviews but could not execute in the delegated read-only command environment. These are environment/harness restrictions, not test or type-check failures.

## Blocked commands

| Agent | Command | Result |
| --- | --- | --- |
| scout | `npx vitest ...` | Blocked as `UNKNOWN_COMMAND` |
| scout | `npx tsc --noEmit` | Blocked as `UNKNOWN_COMMAND` |
| scout | `npm run test:run` | Blocked as `UNKNOWN_COMMAND` |
| scout | `./node_modules/.bin/vitest ...` | Blocked as `COMMAND_PATH` |
| scout | `./node_modules/.bin/tsc --noEmit` | Blocked as `COMMAND_PATH` |
| scout | `vitest ...` | Blocked as `UNKNOWN_COMMAND` |
| scout | `tsc --noEmit` | Blocked as `UNKNOWN_COMMAND` |
| reviewer | `npx tsc --noEmit` | Blocked as `UNKNOWN_COMMAND` |
| reviewer | `npx vitest run ...` | Blocked as `UNKNOWN_COMMAND` |
| reviewer | `npm run test:run` | Blocked as `UNKNOWN_COMMAND` |

## Additional blocked Git commands

The reviewer also reported that some compound Git inspection commands were rejected as `UNSAFE_COMMAND` / `UNSAFE_SUBCOMMAND`, including combined stat/remote commands and `git diff HEAD^ HEAD`. Simpler Git status, log, show, and diff commands succeeded.

## Follow-up

Run the project checks from a normal development session where the command policy permits them:

```sh
npm run test:run
npx tsc --noEmit
```

If those commands remain unavailable outside delegated read-only execution, inspect the shell `PATH`, npm installation, and the active pi bash-sandbox policy before treating the result as a project failure.
