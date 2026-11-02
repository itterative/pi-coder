import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerContainerBackend } from "../../../../src/modules/sandbox/container";
import type { ContainerReadiness } from "../../../../src/modules/sandbox/container/selection";
import { createContainerState } from "../../../../src/modules/sandbox/container/state";
import { createPiStub, stubContext, stubToolInfo, stubUi } from "../../../helpers/pi-stub";

/**
 * The backend now resolves per session from configuration rather than from the environment, and two kinds of
 * runtime load it. These pin the states a session can be in — bubblewrap by configuration, container when the
 * image is ready, an accepted build adopted later — plus the parts a child depends on: no prompt, no
 * announcement, and a container it can still reap.
 *
 * Nothing here starts podman. The readiness probe is injected, `eagerStart` is off, and the one test that
 * needs a container session asserts on the failure *after* close.
 */

const tempDirs: string[] = [];

beforeEach(() => {
    // `test/setup.ts` pins PI_SANDBOX_BACKEND=bwrap for the suite; clearing it lets configuration decide.
    vi.stubEnv("PI_SANDBOX_BACKEND", "");
});

afterEach(() => {
    vi.unstubAllEnvs();

    for (const directory of tempDirs.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function workspace(backend: "auto" | "container" | "bwrap" | undefined): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-container-backend-"));
    tempDirs.push(directory);

    const configDirectory = path.join(directory, ".pi");
    fs.mkdirSync(configDirectory, { recursive: true });

    if (backend !== undefined) {
        fs.writeFileSync(
            path.join(configDirectory, "bash-sandbox-config.json"),
            JSON.stringify({ sandbox: { backend } }),
        );
    }

    return directory;
}

function ready(image = "localhost/pi-coder-sandbox:abc123"): () => Promise<ContainerReadiness> {
    return async () => ({ state: "ready", image });
}

function backendWith(
    stub: ReturnType<typeof createPiStub>,
    options: {
        state?: ReturnType<typeof createContainerState>;
        inspect?: () => Promise<ContainerReadiness>;
        notify?: boolean;
        prompt?: boolean;
    } = {},
) {
    return registerContainerBackend(stub.pi, {
        state: options.state ?? createContainerState(),
        notify: options.notify ?? false,
        eagerStart: false,
        ...(options.inspect === undefined ? {} : { inspect: options.inspect }),
        ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
    });
}

describe("registerContainerBackend", () => {
    it("installs nothing when the project asked for bubblewrap", async () => {
        const cwd = workspace("bwrap");
        const stub = createPiStub();
        const handle = backendWith(stub, { inspect: ready() });

        await stub.handlersFor("session_start")[0]?.({}, stubContext({ cwd }));

        expect(stub.tools).toEqual([]);
        expect(handle).toBeDefined();
    });

    it("installs bash and the file tools when the image is ready", async () => {
        const cwd = workspace("container");
        const stub = createPiStub();
        const state = createContainerState();
        stub.toolSurface.active = ["read", "write"];
        stub.toolSurface.all = ["read", "write"].map((name) => stubToolInfo(name));

        registerContainerBackend(stub.pi, {
            state,
            notify: false,
            eagerStart: false,
            inspect: ready(),
        });

        await stub.handlersFor("session_start")[0]?.({}, stubContext({ cwd }));

        expect(state.active).toBe(true);
        expect(stub.tools.map((tool) => tool.name).toSorted()).toEqual(["bash", "read", "write"]);
    });

    it("stays on bubblewrap when the recipe has not been built, and asks first", async () => {
        const cwd = workspace("auto");
        const stub = createPiStub();
        const state = createContainerState();

        registerContainerBackend(stub.pi, {
            state,
            notify: false,
            eagerStart: false,
            prompt: true,
            inspect: async () => ({
                state: "needs-build",
                image: "localhost/pi-coder-sandbox:abc123",
                recipePath: path.join(cwd, ".pi", "Containerfile"),
            }),
        });

        // A dismissed dialog must leave the session exactly as it was: no tools, no active state.
        const ctx = stubContext({ cwd, ui: stubUi({ custom: async () => undefined }) });

        await stub.handlersFor("session_start")[0]?.({}, ctx);

        expect(state.active).toBe(false);
        expect(stub.tools).toEqual([]);
    });

    it("never asks when this runtime cannot prompt", async () => {
        const cwd = workspace("container");
        const stub = createPiStub();
        const state = createContainerState();
        const notifications: string[] = [];

        registerContainerBackend(stub.pi, {
            state,
            notify: true,
            eagerStart: false,
            inspect: async () => ({
                state: "needs-build",
                image: "localhost/pi-coder-sandbox:abc123",
                recipePath: path.join(cwd, ".pi", "Containerfile"),
            }),
        });

        const ctx = stubContext({
            cwd,
            hasUI: false,
            ui: stubUi({ notify: (message: string) => void notifications.push(message) }),
        });

        await stub.handlersFor("session_start")[0]?.({}, ctx);

        expect(state.active).toBe(false);
        expect(stub.tools).toEqual([]);
        // An explicit container request that cannot be honoured says so instead of silently using bubblewrap.
        expect(notifications.join("\n")).toContain("has not been built");
    });

    it("adopts an image built after the session started", async () => {
        const cwd = workspace("container");
        const stub = createPiStub();
        const state = createContainerState();
        const handle = backendWith(stub, { state, inspect: ready() });
        const ctx = stubContext({ cwd });

        await handle.adoptImage(ctx);

        expect(state.active).toBe(true);
        expect(stub.tools.map((tool) => tool.name)).toEqual(["bash"]);
    });

    it("stays containerized after a session switch, because its tools cannot be withdrawn", async () => {
        const cwd = workspace("container");
        const stub = createPiStub();
        const state = createContainerState();
        let readiness: ContainerReadiness = {
            state: "ready",
            image: "localhost/pi-coder-sandbox:a",
        };

        registerContainerBackend(stub.pi, {
            state,
            notify: false,
            eagerStart: false,
            inspect: async () => readiness,
        });

        await stub.handlersFor("session_start")[0]?.({}, stubContext({ cwd }));
        // A switch reaps the containers; pi keeps the tools, so the next session must stay on the container
        // rather than run a registered container tool against a config that now says bubblewrap.
        await stub.handlersFor("session_shutdown")[0]?.({}, stubContext({ cwd }));

        expect(state.active).toBe(true);

        readiness = { state: "no-recipe" };
        await stub.handlersFor("session_start")[0]?.({}, stubContext({ cwd }));

        expect(state.active).toBe(true);
        expect(stub.tools.map((tool) => tool.name)).toContain("bash");
    });

    it("rejects a command after close instead of starting a container nothing will reap", async () => {
        const cwd = workspace("container");
        const stub = createPiStub();
        const handle = backendWith(stub, { inspect: ready() });

        await stub.handlersFor("session_start")[0]?.({}, stubContext({ cwd }));
        await handle.close();

        const bash = stub.tools.find((tool) => tool.name === "bash");

        await expect(
            bash?.execute("call-1", { command: "echo hi" }, undefined, undefined, {
                cwd: "/repo",
            } as never),
        ).rejects.toThrow(/closed/);
    });
});
