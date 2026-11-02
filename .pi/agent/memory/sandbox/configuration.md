---
name: configuration
description: sandbox.mounts/network/devices schema, resolver rules, warning channels, and /sandbox editing.
category: architecture
---

# Sandbox configuration: mounts, network, devices

Verified against `src/common/config.ts` (types, `tryLoad`, `updateSandboxConfigField`),
`src/modules/sandbox/posture.ts` (`resolveConfiguredMounts`, `resolveNetworkPlan`, `resolveDevicePlan`),
`src/modules/sandbox/container/{args,settings,command}.ts`, and `src/modules/sandbox/bubblewrap.ts`.
The design record is `docs/sandbox-config-redesign.md`.

## Shape

```jsonc
"sandbox": {
  "mounts": {
    "~/.config/gh": "readonly",                                   // short form, target = source
    "~/.cache/uv": "readwrite",
    "~/dev/shared": { "mode": "readonly", "target": "/workspace/shared" },
    "~/.cache/huggingface": { "mode": "readwrite", "create": true }
  },
  "network": "egress",                                            // or "none" | "host"
  "network": { "mode": "egress", "ports": [3000, "127.0.0.1:8080:80"] },
  "devices": "gpu"                                                // or ["/dev/dri"]
}
```

`homeMounts` is **legacy**: still parsed, never applied, and the posture resolver emits one warning naming
`sandbox.mounts`. `mountAccessOf()` defaults to `readonly`; `ro`/`rw` are accepted aliases.

## Rules that matter

- **`target` is opt-in and warned.** It breaks Shape A's "same path inside and out", so the posture names it.
  Sources are `realpath`ed; targets are only `~`-expanded and normalized (they need not exist on the host).
- **`create` is a host `mkdir -p` and is guarded.** It runs as the user before the container starts and is
  refused for a `CREDENTIAL_PATHS` match (creating `~/.ssh` so it can be mounted read-only is not a request);
  the guard resolves every existing ancestor first, so a symlinked parent into `.ssh` cannot slip past it.
  `resolveConfiguredMounts({ create: false })` describes the plan without the side effect; `/sandbox status`
  uses it, so missing `create` mounts show as warnings instead of being materialized by a status query.
- **Ports default to loopback.** `3000` → `127.0.0.1:3000:3000`; long form is
  `[ip:][host-port:]container-port`, validated (1–65535, IPv4 octets). `none`/`host` + `ports` are a
  contradiction: ports are dropped with a warning, not handed to podman where the failure looks like a bug.
- **The read-only role pins the plan**: network `none`, devices `[]`, `rw` mounts downgraded to `ro`, whatever
  the config says. Config can only widen a write runtime.
- **Devices are optional and rootless-hostile without help.** A missing node is dropped with a warning,
  `"gpu"` on a host with neither `/dev/kfd` nor `/dev/dri` warns once, and a non-empty device list sets
  `keepGroups`, which `buildPodmanArgs` turns into `--group-add keep-groups`. Without it a rootless container
  gets `EACCES` on `/dev/dri/renderD*` even with matching uid/gid.
- **Both backends now honour `readwrite`.** `bubblewrap.ts` passes the real role to
  `resolveConfiguredMounts`; it used to resolve with `role: "readonly"`, silently making every configured
  mount read-only. `devices` are `--dev-bind-try`; the bwrap profile's unconditional `/dev/kfd` + `/dev/dri`
  binds are gone, so neither backend invents hardware access.
- **Warnings have two channels.** The container reports posture warnings once at session start
  (`reportPostureWarnings`); bubblewrap builds one command at a time and pushes into `SandboxOptions.warnings`,
  which the parent bash hook drains into a per-session `Set` so a setting is named once, not per command.
- **`writableRoots` follows the targets**, including a remap, and is still derived from `entries`, never
  declared. A target collision between different sources is warned about and the first source wins.

## Editing

`/sandbox mounts [add <path> [ro|rw] [target=…] [create] | remove <path>]`,
`/sandbox network [egress|none|host | port add|remove <spec>]`,
`/sandbox devices [gpu|none|add|remove <path>]`, `/sandbox status` (prints `describeSandboxSettings`).

Each edit writes the project config through `updateSandboxConfigField` (mount edits patch single keys so
global mounts survive; `network`/`devices` are whole-value replace because the project file overrides the
global one), reloads `config.load()`, then calls the backend's `reloadConfig`, which marks sessions stale so
`sessionFor` replaces the container at the next command boundary. Mounts, ports, and devices are frozen at
`podman run`, so without this an edit would silently wait for a restart. The image and the backend cannot be
changed live. `/bash-sandbox-config` renders the long form.

## Landmines

- A new `sandbox` key must be added to the interface, `tryLoad`, and `mergeConfigs`; `tryLoad` whitelists, so a
  missing entry is silently dropped. Per-entry mount parsing is in `parseMountEntry`.
- `updateSandboxConfigField` patches the raw JSON document, never the merged config: writing a merged value
  would move global settings into the project file.
- No free-form `podmanArgs`/`privileged`: `writableRoots` is derived from known entries, and an arbitrary flag
  would silently falsify what a rule may trust.