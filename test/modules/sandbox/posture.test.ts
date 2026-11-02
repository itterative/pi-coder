import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SandboxConfig } from "../../../src/common/config";
import {
    resolveConfiguredMounts,
    resolveSandboxPosture,
    runtimeRootsFor,
    unconfinedPosture,
    type PostureRequest,
} from "../../../src/modules/sandbox/posture";

/**
 * The posture is what a future rule may trust to answer "can this command write there?", so the tests are
 * about the *derivation*: a path reaches `writableRoots` only through a mount that a backend really binds
 * writable.
 */
describe("resolveSandboxPosture", () => {
    let root: string;
    let home: string;
    let cwd: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "posture-"));
        home = path.join(root, "home");
        cwd = path.join(root, "project");
        fs.mkdirSync(home, { recursive: true });
        fs.mkdirSync(cwd, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    const config = (sandbox: Partial<SandboxConfig["sandbox"]>): SandboxConfig => ({
        sandbox: { mounts: {}, ...sandbox },
        permissions: {},
    });

    const posture = (overrides: Partial<PostureRequest> = {}) =>
        resolveSandboxPosture({ cwd, env: { HOME: home }, ...overrides });

    it("binds the checkout writable for a mutating runtime and read-only for a read-only one", () => {
        expect(posture().writableRoots).toEqual([cwd]);
        expect(posture({ role: "readonly" }).writableRoots).toEqual([]);
        expect(posture({ role: "readonly" }).readOnlyRoots).toContain(cwd);
    });

    it("mounts the sessions directory read-only even for a mutating runtime", () => {
        const sessions = path.join(home, ".pi", "agent", "sessions");
        const scratchpad = path.join(root, "scratchpad");
        fs.mkdirSync(sessions, { recursive: true });
        fs.mkdirSync(scratchpad);

        const write = posture({
            ...runtimeRootsFor("write", { scratchpadPath: scratchpad, sessionsDir: sessions }),
        });
        expect(write.readOnlyRoots).toEqual([sessions]);
        expect(write.writableRoots).toEqual([cwd, scratchpad]);

        const readonly = posture({
            role: "readonly",
            ...runtimeRootsFor("readonly", { scratchpadPath: scratchpad, sessionsDir: sessions }),
        });
        expect(readonly.readOnlyRoots).toContain(sessions);
        expect(readonly.writableRoots).toEqual([scratchpad]);
    });

    it("keeps the network for a mutating runtime and takes it away from a read-only one", () => {
        expect(posture().network).toEqual({ mode: "egress", publish: [] });
        expect(posture({ role: "readonly" }).network).toEqual({ mode: "none", publish: [] });
    });

    it("lets a read-only runtime write its own scratchpad and nothing else", () => {
        const scratchpad = path.join(root, "scratchpad");
        fs.mkdirSync(scratchpad);

        const readonly = posture({
            role: "readonly",
            extraWritableRoots: [scratchpad],
            extraReadOnlyRoots: [path.join(home, ".pi")],
        });

        expect(readonly.writableRoots).toEqual([scratchpad]);
    });

    it("derives writable roots from the declared mounts, not from the backend", () => {
        const cache = path.join(home, ".cache");
        fs.mkdirSync(cache);

        const resolved = posture({ config: config({ mounts: { [cache]: "readwrite" } }) });

        expect(resolved.writableRoots).toContain(cache);
        expect(resolved.readOnlyRoots).not.toContain(cache);
    });

    it("refuses to widen a declared writable mount for a read-only runtime", () => {
        const cache = path.join(home, ".cache");
        fs.mkdirSync(cache);

        const resolved = posture({
            role: "readonly",
            config: config({ mounts: { [cache]: "readwrite" } }),
        });

        expect(resolved.writableRoots).toEqual([]);
        expect(resolved.readOnlyRoots).toContain(cache);
    });

    it("forces git support mounts read-only for a read-only runtime", () => {
        const gitDir = path.join(root, "main", ".git", "worktrees", "wt");
        fs.mkdirSync(gitDir, { recursive: true });

        expect(
            posture({ gitMounts: [{ source: gitDir, target: gitDir, mode: "rw" }] }).writableRoots,
        ).toContain(gitDir);

        expect(
            posture({
                role: "readonly",
                gitMounts: [{ source: gitDir, target: gitDir, mode: "rw" }],
            }).readOnlyRoots,
        ).toContain(gitDir);
    });

    it("mounts a long-form entry at its declared target with its declared mode", () => {
        const cache = path.join(home, ".cache", "uv");
        fs.mkdirSync(cache, { recursive: true });

        const resolved = posture({
            config: config({
                mounts: { [cache]: { mode: "readwrite", target: "/cache/uv" } },
            }),
        });
        const entry = resolved.entries.find((candidate) => candidate.source === cache);

        expect(entry).toEqual({ source: fs.realpathSync(cache), target: "/cache/uv", mode: "rw" });
        expect(resolved.writableRoots).toContain("/cache/uv");
        expect(resolved.warnings.join("\n")).toContain(
            "the two sides no longer name the same path",
        );
    });

    it("creates a missing mount path when the entry asks for it, host-owned and canonical", () => {
        const cache = path.join(home, ".cache", "huggingface");

        const resolved = posture({
            config: config({ mounts: { [cache]: { mode: "readwrite", create: true } } }),
        });

        expect(fs.existsSync(cache)).toBe(true);
        expect(resolved.entries.map((entry) => entry.source)).toContain(fs.realpathSync(cache));
        expect(resolved.writableRoots).toContain(fs.realpathSync(cache));
    });

    it("refuses to create a credential path, and says why", () => {
        const ssh = path.join(home, ".ssh");

        const resolved = posture({
            config: config({ mounts: { [ssh]: { mode: "readonly", create: true } } }),
        });

        expect(fs.existsSync(ssh)).toBe(false);
        expect(resolved.entries.map((entry) => entry.source)).not.toContain(ssh);
        expect(resolved.warnings.join("\n")).toContain("refusing to create");
    });

    it("refuses to create through a symlinked parent into a credential directory", () => {
        const ssh = path.join(home, ".ssh");
        const link = path.join(home, "link");
        fs.mkdirSync(ssh);
        fs.symlinkSync(ssh, link);

        const resolved = posture({
            config: config({ mounts: { [`${link}/keys`]: { mode: "readonly", create: true } } }),
        });

        expect(fs.existsSync(path.join(ssh, "keys"))).toBe(false);
        expect(resolved.warnings.join("\n")).toContain("refusing to create");
    });

    it("does not create anything when a caller only describes the plan", () => {
        const cache = path.join(home, ".cache", "plan-only");

        const resolved = posture({
            create: false,
            config: config({ mounts: { [cache]: { mode: "readwrite", create: true } } }),
        });

        expect(fs.existsSync(cache)).toBe(false);
        expect(resolved.warnings.join("\n")).toContain("does not exist");
    });

    it("warns that homeMounts is gone instead of silently ignoring it", () => {
        const resolved = posture({ config: config({ homeMounts: [".local"] }) });

        expect(resolved.warnings.join("\n")).toContain("sandbox.homeMounts is no longer used");
        expect(resolved.entries.map((entry) => entry.source)).not.toContain(
            path.join(home, ".local"),
        );
    });

    it("publishes ports on loopback by default, and keeps an address the user wrote out", () => {
        const resolved = posture({
            config: config({
                network: { mode: "egress", ports: [3000, "8080:80", "0.0.0.0:9000:9000"] },
            }),
        });

        expect(resolved.network).toEqual({
            mode: "egress",
            publish: ["127.0.0.1:3000:3000", "127.0.0.1:8080:80", "0.0.0.0:9000:9000"],
        });
    });

    it("drops ports that contradict the network, and ports that are not ports", () => {
        const none = posture({ config: config({ network: { mode: "none", ports: [3000] } }) });

        expect(none.network.publish).toEqual([]);
        expect(none.warnings.join("\n")).toContain("ports are not published");

        const invalid = posture({
            config: config({ network: { mode: "egress", ports: ["nope", 70000] } }),
        });

        expect(invalid.network.publish).toEqual([]);
        expect(
            invalid.warnings.filter((warning) => warning.includes("not a valid port")),
        ).toHaveLength(2);
    });

    it("pins the network and the devices for a read-only runtime, whatever the config says", () => {
        const device = path.join(root, "fake-device");
        fs.writeFileSync(device, "");

        const resolved = posture({
            role: "readonly",
            config: config({ network: { mode: "host", ports: [3000] }, devices: [device] }),
        });

        expect(resolved.network).toEqual({ mode: "none", publish: [] });
        expect(resolved.devices).toEqual({ paths: [], keepGroups: false });
    });

    it("passes configured devices through, and reports a missing one", () => {
        const device = path.join(root, "fake-device");
        fs.writeFileSync(device, "");
        const missing = path.join(root, "no-such-device");

        const resolved = posture({ config: config({ devices: [device, missing] }) });

        expect(resolved.devices).toEqual({ paths: [device], keepGroups: true });
        expect(resolved.warnings.join("\n")).toContain("no-such-device");
    });

    it("reports a gpu shorthand on a host without GPU nodes instead of failing", () => {
        const resolved = posture({ config: config({ devices: "gpu" }) });

        // This repository's test host has no /dev/kfd or /dev/dri; the plan is allowed to be empty.
        if (resolved.devices.paths.length === 0) {
            expect(resolved.warnings.join("\n")).toContain("no GPU device nodes");
        }
    });

    it("drops a mount that does not exist instead of letting podman create an empty directory", () => {
        const resolved = posture({
            config: config({ mounts: { [path.join(root, "nope")]: "readonly" } }),
        });

        expect(resolved.entries.map((entry) => entry.source)).not.toContain(
            path.join(root, "nope"),
        );
        expect(resolved.warnings.join("\n")).toContain("does not exist");
    });

    it("drops a relative mount path and says so", () => {
        const resolved = posture({ config: config({ mounts: { "relative/path": "readonly" } }) });

        expect(resolved.entries).toHaveLength(1);
        expect(resolved.warnings.join("\n")).toContain("not an absolute path");
    });

    it("warns once about a mount that exposes credentials", () => {
        const ssh = path.join(home, ".ssh");
        fs.mkdirSync(ssh);

        const resolved = posture({ config: config({ mounts: { [ssh]: "readonly" } }) });

        expect(resolved.warnings.filter((warning) => warning.includes(".ssh"))).toHaveLength(1);
    });

    it("warns about a parent mount that reaches a credential path underneath it", () => {
        const pi = path.join(home, ".pi");
        fs.mkdirSync(path.join(pi, "agent", "sessions"), { recursive: true });

        const resolved = posture({ config: config({ mounts: { [pi]: "readwrite" } }) });

        expect(resolved.warnings.join("\n")).toContain("exposes a credential path");
    });

    it("keeps the more permissive mode when two sources claim one target", () => {
        const shared = path.join(home, ".config");
        fs.mkdirSync(shared);
        const link = path.join(root, "link-to-config");
        fs.symlinkSync(shared, link);

        const resolved = posture({
            config: config({ mounts: { [shared]: "readonly", [link]: "readwrite" } }),
        });

        const matching = resolved.entries.filter(
            (entry) => entry.target === fs.realpathSync(shared),
        );

        expect(matching).toHaveLength(1);
        expect(matching[0]?.mode).toBe("rw");
    });

    it("orders parents before children so a later mount cannot shadow a deeper one", () => {
        const parent = path.join(home, ".config");
        const child = path.join(parent, "gh");
        fs.mkdirSync(child, { recursive: true });

        const resolved = posture({
            config: config({ mounts: { [child]: "readwrite", [parent]: "readonly" } }),
        });

        const targets = resolved.entries.map((entry) => entry.target);

        expect(targets.indexOf(fs.realpathSync(parent))).toBeLessThan(
            targets.indexOf(fs.realpathSync(child)),
        );
    });
});

describe("resolveConfiguredMounts", () => {
    it("returns the configured entries in a form both backends can bind", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "posture-split-"));
        const cache = path.join(root, ".cache");
        fs.mkdirSync(cache);
        const warnings: string[] = [];

        const resolved = resolveConfiguredMounts(
            {
                sandbox: { mounts: { [cache]: "readwrite" } },
                permissions: {},
            },
            { role: "write", env: { HOME: root }, warnings },
        );

        expect(resolved).toEqual([
            { source: fs.realpathSync(cache), target: fs.realpathSync(cache), mode: "rw" },
        ]);
        expect(warnings).toEqual([]);

        fs.rmSync(root, { recursive: true, force: true });
    });
});

describe("runtimeRootsFor", () => {
    it("gives a mutating runtime both writable roots and a read-only one only its scratchpad", () => {
        expect(
            runtimeRootsFor("write", { scratchpadPath: "/scratch", memoryDir: "/memory" }),
        ).toEqual({ extraWritableRoots: ["/scratch", "/memory"], extraReadOnlyRoots: [] });

        expect(
            runtimeRootsFor("readonly", { scratchpadPath: "/scratch", memoryDir: "/memory" }),
        ).toEqual({ extraWritableRoots: ["/scratch"], extraReadOnlyRoots: ["/memory"] });
    });

    it("mounts the sessions directory read-only, for either role", () => {
        // pi writes transcripts on the host; a runtime reads one to review it. A write role has no more reason
        // to rewrite a transcript than a scout does, so this is the one root a mutating runtime gets read-only.
        expect(
            runtimeRootsFor("write", { scratchpadPath: "/scratch", sessionsDir: "/sessions" }),
        ).toEqual({ extraWritableRoots: ["/scratch"], extraReadOnlyRoots: ["/sessions"] });

        expect(runtimeRootsFor("readonly", { sessionsDir: "/sessions" })).toEqual({
            extraWritableRoots: [],
            extraReadOnlyRoots: ["/sessions"],
        });
    });

    it("omits roots the session does not have", () => {
        expect(runtimeRootsFor("readonly", {})).toEqual({
            extraWritableRoots: [],
            extraReadOnlyRoots: [],
        });
    });
});

describe("unconfinedPosture", () => {
    it("describes a host command honestly: nothing is read-only because nothing is enforced", () => {
        const host = unconfinedPosture("/work");

        expect(host.enforcement).toBe("none");
        expect(host.writableRoots).toEqual(["/work"]);
        expect(host.readOnlyRoots).toEqual([]);
    });
});
