# pi-coder

Personal setup for coding with pi.

## Vendored SQLite driver

pi-coder uses a script-free vendored `sqlite3@6.0.1` driver with SQLite 3.52.0.
It supports N-API v6 on Linux, macOS, and Windows, including Linux and macOS
ARM64. The loader selects the appropriate platform binary at runtime.

See [`vendor/sqlite3/VENDORED.md`](vendor/sqlite3/VENDORED.md) for provenance
and update instructions, and [`vendor/sqlite3/SHA256SUMS`](vendor/sqlite3/SHA256SUMS)
for integrity hashes of the committed binaries.

## Documentation

- [Agent tool overview](src/tools/agent/README.md)
- [Agent tool reference](docs/agent-tool.md)
- [Isolated workspace lifecycle](docs/agent-workspaces.md)
- [Persistence and recovery](docs/agent-persistence.md)
