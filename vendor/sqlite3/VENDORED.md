# Vendored sqlite3

This is an adapted copy of the JavaScript portion of `sqlite3@6.0.1` with
install/build scripts removed and the N-API v6 native binaries vendored under
`lib/binding/`. It is used by pi-coder through the `file:vendor/sqlite3`
dependency, so installation does not need npm install scripts, a compiler, or
network access.

The native binaries come from the
[`v6.0.1` node-sqlite3 release](https://github.com/TryGhost/node-sqlite3/releases/tag/v6.0.1)
and report SQLite `3.52.0`.

## Local adaptations

Compared with the upstream package, this vendored copy:

- removes `install`, `prebuild`, `rebuild`, and `upload` scripts;
- removes build/download-only dependencies and upstream build sources;
- replaces `lib/sqlite3-binding.js` with a loader that selects the vendored
  N-API v6 binary by platform, architecture, and Linux libc variant; and
- adds `VENDORED.md` and `SHA256SUMS` to document provenance and verify the
  committed native files.

The upstream `LICENSE` file is retained unchanged. The package license is
`BSD-3-Clause`, matching node-sqlite3; the surrounding pi-coder project may
remain MIT because permissive MIT and BSD-3-Clause licenses are compatible.
Redistribution retains the upstream copyright notice and disclaimer.

## Supported binaries

| Platform | Architecture | libc |
| --- | --- | --- |
| Linux | x64 | glibc |
| Linux | arm64 | glibc |
| Linux | x64 | musl |
| Linux | arm64 | musl |
| macOS | x64 | system |
| macOS | arm64 | system |
| Windows | x64 | system |

The loader selects the N-API, platform, architecture, and Linux libc variant.
Windows ARM64 and 32-bit ARM are not currently included.

## Integrity

Verify the committed native files from this directory with:

```sh
sha256sum -c SHA256SUMS
```

`SHA256SUMS` contains hashes of the files actually committed to this
repository. The SHA-256 values below are the corresponding GitHub release
archive digests used as provenance when the files were imported:

| Archive | GitHub SHA-256 |
| --- | --- |
| `sqlite3-v6.0.1-napi-v6-darwin-arm64.tar.gz` | `65ddb932a774b7beaba9d97dc3c5a3750ae9405e96ee52b8ec9beec7c8eea597` |
| `sqlite3-v6.0.1-napi-v6-darwin-x64.tar.gz` | `04c9e612a9fce5f62f1a779b44cb75f4d944c02dde615dbd8a1dff51569a2570` |
| `sqlite3-v6.0.1-napi-v6-linux-arm64.tar.gz` | `57b036cc4fd1664be6995d8c3d0ed740a89d8eedfa7c07b7198d1551327f6bb9` |
| `sqlite3-v6.0.1-napi-v6-linux-x64.tar.gz` | `3b2aba05ec737aeed4d686b7309df57b1c93a217c8d7f3a09aa952a87db071b6` |
| `sqlite3-v6.0.1-napi-v6-linuxmusl-arm64.tar.gz` | `9d57c6e3dc06815dab05ade1b2ae4f47325b4f81315ca06c59259ae7d7f0dfd7` |
| `sqlite3-v6.0.1-napi-v6-linuxmusl-x64.tar.gz` | `04f9ab67fec37ecc9330f423438c121231785e768a36ae7b85d17226018523b7` |
| `sqlite3-v6.0.1-napi-v6-win32-x64.tar.gz` | `e0bbbb6e43b45378e6d6e2c5cc096e61e4c8932dbc2d2c9c08b8e3aaa80c9adf` |

## Updating

1. Select a node-sqlite3 release and its N-API v6 assets.
2. Verify each downloaded archive against the GitHub release digest.
3. Extract `build/Release/node_sqlite3.node` into the matching
   `lib/binding/napi-v6-*/` directory.
4. Update `package.json`, the SQLite version, and both hash lists.
5. Run `sha256sum -c SHA256SUMS`, `npm install --ignore-scripts`, and the
   pi-coder TypeScript and test suites.

Only the native files and runtime JavaScript are needed; the upstream source
and build dependencies are intentionally not included in this vendored
package.
