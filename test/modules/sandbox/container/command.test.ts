import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerSandboxCommand } from "../../../../src/modules/sandbox/container/command";
import type { ContainerReadiness } from "../../../../src/modules/sandbox/container/selection";
import { createContainerState } from "../../../../src/modules/sandbox/container/state";
import { createPiStub, stubCommandContext, stubUi } from "../../../helpers/pi-stub";

/**
 * `/sandbox` is the discoverable half of the backend, and its whole job is to answer "what runs my bash, and
 * how do I change that". These pin the wording for each state a user can be in, the persistence of a backend
 * answer, and the guards that keep a build from being attempted where it cannot work.
 *
 * Readiness is exercised through the real probe with a project-local config, so no podman is involved: a
 * checkout without a Containerfile and one with an unbuilt recipe are both answerable from the filesystem.
 */

const tempDirs: string[] = [];

beforeEach(() => {
    // Let the project config decide the backend instead of the suite-wide bwrap pin.
    vi.stubEnv("PI_SANDBOX_BACKEND", "");
});

afterEach(() => {
    vi.unstubAllEnvs();

    for (const directory of tempDirs.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function workspace(options: { backend?: string; recipe?: string; config?: object } = {}): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-command-"));
    tempDirs.push(directory);

    const configDirectory = path.join(directory, ".pi");
    fs.mkdirSync(configDirectory, { recursive: true });

    if (options.recipe !== undefined) {
        fs.writeFileSync(path.join(configDirectory, "Containerfile"), options.recipe);
    }

    const config =
        options.config ?? (options.backend ? { sandbox: { backend: options.backend } } : undefined);

    if (config !== undefined) {
        fs.writeFileSync(
            path.join(configDirectory, "bash-sandbox-config.json"),
            JSON.stringify(config),
        );
    }

    return directory;
}

function run(
    cwd: string,
    args: string,
    options: {
        active?: boolean;
        hasUI?: boolean;
        confirm?: boolean;
        readiness?: ContainerReadiness;
    } = {},
) {
    const stub = createPiStub();
    const state = createContainerState();
    state.active = options.active ?? false;
    const notifications: Array<{ message: string; level: string }> = [];
    const onImageBuilt = vi.fn(async () => {});
    const onConfigChanged = vi.fn(async () => {});

    registerSandboxCommand(stub.pi, {
        state,
        onImageBuilt,
        onConfigChanged,
        inspect: async () => options.readiness ?? { state: "no-recipe" },
    });

    const ctx = stubCommandContext({
        cwd,
        hasUI: options.hasUI ?? true,
        ui: stubUi({
            notify: (message, level) =>
                void notifications.push({ message, level: level ?? "info" }),
            confirm: async () => options.confirm ?? true,
        }),
    });

    const handler = stub.requireCommand("sandbox").handler;

    return { handler, ctx, notifications, onImageBuilt, onConfigChanged };
}

describe("/sandbox status", () => {
    it("names the container when it is the running backend", async () => {
        const { handler, ctx, notifications } = run(workspace({ backend: "container" }), "", {
            active: true,
        });

        await handler("", ctx);

        expect(notifications[0]?.message).toContain("runs in the sandbox container");
        expect(notifications[0]?.message).toContain("backend container");
    });

    it("says bubblewrap, and where that answer came from", async () => {
        const { handler, ctx, notifications } = run(workspace({ backend: "bwrap" }), "status");

        await handler("status", ctx);

        expect(notifications[0]?.message).toContain("bubblewrap");
        expect(notifications[0]?.message).toContain("config");
    });

    it("points at the one action that would change a missing image", async () => {
        const cwd = workspace({ backend: "container", recipe: "FROM debian:13\n" });
        const { handler, ctx, notifications } = run(cwd, "", {
            readiness: {
                state: "needs-build",
                image: "localhost/pi-coder-sandbox:abc123",
                recipePath: path.join(cwd, ".pi", "Containerfile"),
            },
        });

        await handler("", ctx);

        expect(notifications[0]?.message).toContain("no built image yet");
        expect(notifications[0]?.message).toContain("/sandbox build");
        expect(notifications[0]?.level).toBe("warning");
    });

    it("explains a repository with no recipe without pretending it is a problem", async () => {
        const { handler, ctx, notifications } = run(workspace(), "");

        await handler("", ctx);

        expect(notifications[0]?.message).toContain("no .pi/Containerfile");
        expect(notifications[0]?.level).toBe("info");
    });
});

describe("/sandbox backend", () => {
    it("writes the answer to the project config and says when it takes effect", async () => {
        const cwd = workspace();
        const { handler, ctx, notifications } = run(cwd, "backend bwrap");

        await handler("backend bwrap", ctx);

        const configPath = path.join(cwd, ".pi", "bash-sandbox-config.json");
        expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
            sandbox: { backend: "bwrap" },
        });
        expect(notifications[0]?.message).toContain("next session");
    });

    it("clears a remembered dismissal so a new container request can ask again", async () => {
        const cwd = workspace({
            config: { sandbox: { containerDeclinedTag: "localhost/x:1" } },
        });
        const { handler, ctx } = run(cwd, "backend container");

        await handler("backend container", ctx);

        const written = JSON.parse(
            fs.readFileSync(path.join(cwd, ".pi", "bash-sandbox-config.json"), "utf8"),
        );
        expect(written.sandbox).toEqual({ backend: "container" });
    });

    it("asks for a restart when this runtime already runs in the container", async () => {
        const cwd = workspace({ backend: "container" });
        const { handler, ctx, notifications } = run(cwd, "backend bwrap", { active: true });

        await handler("backend bwrap", ctx);

        expect(notifications[0]?.message).toContain("restart pi");
    });

    it("rejects an unknown backend without touching the file", async () => {
        const cwd = workspace();
        const { handler, ctx, notifications } = run(cwd, "backend docker");

        await handler("backend docker", ctx);

        expect(notifications[0]?.message).toContain("auto, container, or bwrap");
        expect(fs.existsSync(path.join(cwd, ".pi", "bash-sandbox-config.json"))).toBe(false);
    });
});

describe("/sandbox build", () => {
    it("explains that an explicitly named image is not built from a recipe", async () => {
        const cwd = workspace({ recipe: "FROM debian:13\n" });
        const { handler, ctx, notifications } = run(cwd, "build");
        vi.stubEnv("PI_SANDBOX_IMAGE", "localhost/custom:1");

        await handler("build", ctx);

        expect(notifications[0]?.message).toContain("nothing to build");
        expect(notifications[0]?.message).toContain("PI_SANDBOX_IMAGE");
    });

    it("says there is nothing to build in a repository without a recipe", async () => {
        const { handler, ctx, notifications } = run(workspace(), "build");

        await handler("build", ctx);

        expect(notifications[0]?.message).toContain("no .pi/Containerfile");
    });

    it("refuses a recipe this build cannot support before touching podman", async () => {
        const cwd = workspace({ recipe: "FROM alpine:3.20\n" });
        const { handler, ctx, notifications } = run(cwd, "build");

        await handler("build", ctx);

        expect(notifications[0]?.level).toBe("error");
        expect(notifications[0]?.message).toContain("musl");
    });

    it("needs a prompt, so it refuses in a mode that cannot show one", async () => {
        const cwd = workspace({ recipe: "FROM debian:13\n" });
        const { handler, ctx, notifications } = run(cwd, "build", { hasUI: false });

        await handler("build", ctx);

        expect(notifications[0]?.message).toContain("approval prompt");
    });
});

describe("/sandbox mounts", () => {
    function readConfig(cwd: string): Record<string, unknown> {
        return JSON.parse(
            fs.readFileSync(path.join(cwd, ".pi", "bash-sandbox-config.json"), "utf8"),
        );
    }

    it("adds a mount, applies it to the live session, and shows the resulting plan", async () => {
        const cwd = workspace();
        const cache = path.join(cwd, "cache");
        fs.mkdirSync(cache);
        const { handler, ctx, notifications, onConfigChanged } = run(cwd, "mounts add");

        await handler(`mounts add ${cache} rw`, ctx);

        expect(readConfig(cwd)).toEqual({ sandbox: { mounts: { [cache]: "readwrite" } } });
        expect(onConfigChanged).toHaveBeenCalledOnce();
        expect(notifications.at(-1)?.message).toContain(`${fs.realpathSync(cache)} (rw)`);
    });

    it("refuses a path that is not there unless the entry creates it", async () => {
        const cwd = workspace();
        const cache = path.join(cwd, "cache");
        const { handler, ctx, notifications } = run(cwd, "status");

        await handler(`mounts add ${cache}`, ctx);

        expect(notifications[0]?.message).toContain("does not exist");
        expect(fs.existsSync(path.join(cwd, ".pi", "bash-sandbox-config.json"))).toBe(false);

        await handler(`mounts add ${cache} create`, ctx);

        expect(fs.existsSync(cache)).toBe(true);
        expect(readConfig(cwd)).toEqual({
            sandbox: { mounts: { [cache]: { mode: "readonly", create: true } } },
        });
    });

    it("keeps a declared target and reports that paths no longer match", async () => {
        const cwd = workspace();
        const shared = path.join(cwd, "shared");
        fs.mkdirSync(shared);
        const { handler, ctx, notifications } = run(cwd, "status");

        await handler(`mounts add ${shared} ro target=/workspace/shared`, ctx);

        expect(readConfig(cwd)).toEqual({
            sandbox: { mounts: { [shared]: { mode: "readonly", target: "/workspace/shared" } } },
        });
        expect(notifications.map((n) => n.message).join("\n")).toContain(
            "no longer name the same path",
        );
    });

    it("removes a mount", async () => {
        const cwd = workspace();
        const cache = path.join(cwd, "cache");
        fs.mkdirSync(cache);
        const { handler, ctx } = run(cwd, "status");

        await handler(`mounts add ${cache} rw`, ctx);
        await handler(`mounts remove ${cache}`, ctx);

        expect(readConfig(cwd)).toEqual({ sandbox: { mounts: {} } });
    });

    it("says when a mount it cannot remove comes from the global config", async () => {
        const cwd = workspace();
        const cache = path.join(cwd, "cache");
        fs.mkdirSync(cache);
        const globalPath = path.join(cwd, "global.json");
        fs.writeFileSync(
            globalPath,
            JSON.stringify({ sandbox: { mounts: { [cache]: "readonly" } } }),
        );
        vi.stubEnv("SANDBOX_CONFIG_PATH_GLOBAL", globalPath);
        const { handler, ctx, notifications } = run(cwd, "status");

        await handler(`mounts remove ${cache}`, ctx);

        expect(notifications.map((n) => n.message).join("\n")).toContain("global config");
    });
});

describe("/sandbox network", () => {
    function readConfig(cwd: string): Record<string, unknown> {
        return JSON.parse(
            fs.readFileSync(path.join(cwd, ".pi", "bash-sandbox-config.json"), "utf8"),
        );
    }

    it("sets the mode, and keeps the ports already declared", async () => {
        const cwd = workspace({
            config: { sandbox: { network: { mode: "egress", ports: [3000] } } },
        });
        const { handler, ctx } = run(cwd, "status");

        await handler("network none", ctx);

        expect(readConfig(cwd)).toEqual({
            sandbox: { network: { mode: "none", ports: [3000] } },
        });
    });

    it("publishes a port on loopback and stops publishing it again", async () => {
        const cwd = workspace();
        const { handler, ctx, notifications } = run(cwd, "status");

        await handler("network port add 3000", ctx);

        expect(readConfig(cwd)).toEqual({
            sandbox: { network: { mode: "egress", ports: [3000] } },
        });
        expect(notifications.at(-1)?.message).toContain("127.0.0.1:3000:3000");

        await handler("network port remove 3000", ctx);

        expect(readConfig(cwd)).toEqual({ sandbox: { network: "egress" } });
    });

    it("refuses a port that is not a port", async () => {
        const cwd = workspace();
        const { handler, ctx, notifications } = run(cwd, "status");

        await handler("network port add 99999", ctx);

        expect(notifications[0]?.message).toContain("not a valid port");
        expect(fs.existsSync(path.join(cwd, ".pi", "bash-sandbox-config.json"))).toBe(false);
    });
});

describe("/sandbox devices", () => {
    function readConfig(cwd: string): Record<string, unknown> {
        return JSON.parse(
            fs.readFileSync(path.join(cwd, ".pi", "bash-sandbox-config.json"), "utf8"),
        );
    }

    it("asks for the GPU shorthand", async () => {
        const cwd = workspace();
        const { handler, ctx, onConfigChanged } = run(cwd, "status");

        await handler("devices gpu", ctx);

        expect(readConfig(cwd)).toEqual({ sandbox: { devices: "gpu" } });
        expect(onConfigChanged).toHaveBeenCalledOnce();
    });

    it("adds and removes an explicit device", async () => {
        const cwd = workspace();
        const device = path.join(cwd, "fake-device");
        fs.writeFileSync(device, "");
        const { handler, ctx } = run(cwd, "status");

        await handler(`devices add ${device}`, ctx);

        expect(readConfig(cwd)).toEqual({ sandbox: { devices: [device] } });

        await handler(`devices remove ${device}`, ctx);

        expect(readConfig(cwd)).toEqual({ sandbox: {} });
    });

    it("refuses a device that is not on this host", async () => {
        const cwd = workspace();
        const { handler, ctx, notifications } = run(cwd, "status");

        await handler(`devices add ${path.join(cwd, "nope")}`, ctx);

        expect(notifications[0]?.message).toContain("does not exist on this host");
    });
});

describe("/sandbox status plan", () => {
    it("shows the effective mount, network, and device plan", async () => {
        const cwd = workspace();
        const cache = path.join(cwd, "cache");
        fs.mkdirSync(cache);
        const { handler, ctx, notifications } = run(cwd, "status");

        await handler(`mounts add ${cache} rw`, ctx);
        await handler("network port add 3000", ctx);
        await handler("devices gpu", ctx);

        const plan = notifications.filter((notification) =>
            notification.message.includes("mounts:"),
        );

        expect(plan.at(-1)?.message).toContain(`${fs.realpathSync(cache)} (rw)`);
        expect(plan.at(-1)?.message).toContain("network: egress");
        expect(plan.at(-1)?.message).toContain("ports: 127.0.0.1:3000:3000");
    });
});
