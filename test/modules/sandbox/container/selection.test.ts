import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SandboxConfig } from "../../../../src/common/config";
import {
    inspectContainerReadiness,
    parseBackendChoice,
    planSessionBackend,
    selectBackend,
    type ContainerReadiness,
} from "../../../../src/modules/sandbox/container/selection";

/**
 * The state machine a user experiences, without podman, a build, or a TTY.
 *
 * The three questions that matter: which layer wins the backend, what readiness actually means, and when a
 * session may ask. Each row is a situation a real checkout is in — a fresh clone with a recipe, a machine
 * without podman, a project that already answered "bubblewrap".
 */

const tempDirs: string[] = [];

afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function configWith(backend: SandboxConfig["sandbox"]["backend"]): SandboxConfig {
    return {
        sandbox: { backend, mounts: {} },
        permissions: {},
    };
}

function project(options: { recipe?: string } = {}): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readiness-"));
    tempDirs.push(directory);

    if (options.recipe !== undefined) {
        fs.mkdirSync(path.join(directory, ".pi"), { recursive: true });
        fs.writeFileSync(path.join(directory, ".pi", "Containerfile"), options.recipe);
    }

    return directory;
}

async function readinessFor(
    projectDir: string,
    overrides: {
        imageExists?: boolean;
        host?: { ok: true; podmanPath: string } | { ok: false; reason: string };
        env?: NodeJS.ProcessEnv;
    } = {},
): Promise<ContainerReadiness> {
    return inspectContainerReadiness({
        projectDir,
        homeDir: path.join(projectDir, "no-home"),
        stateDir: path.join(projectDir, ".state"),
        env: overrides.env ?? {},
        host: async () => overrides.host ?? { ok: true, podmanPath: "/usr/bin/podman" },
        imageExists: async () => overrides.imageExists ?? false,
    });
}

describe("backend precedence", () => {
    it("lets the environment override the config, for tests and CI", () => {
        expect(selectBackend(configWith("bwrap"), { PI_SANDBOX_BACKEND: "container" })).toEqual({
            choice: "container",
            source: "env",
        });
    });

    it("reads the config when the environment is silent", () => {
        expect(selectBackend(configWith("container"), {})).toEqual({
            choice: "container",
            source: "config",
        });
    });

    it("defaults to auto so a fresh checkout is asked rather than assumed", () => {
        expect(selectBackend(null, {})).toEqual({ choice: "auto", source: "default" });
    });

    it("ignores an unrecognized value instead of forcing an error", () => {
        expect(selectBackend(configWith("container"), { PI_SANDBOX_BACKEND: "docker" })).toEqual({
            choice: "container",
            source: "config",
        });
        expect(parseBackendChoice(" Container ")).toBe("container");
        expect(parseBackendChoice("podman")).toBeUndefined();
    });
});

describe("session plan", () => {
    const ready: ContainerReadiness = { state: "ready", image: "localhost/pi-coder-sandbox:a" };
    const needsBuild: ContainerReadiness = {
        state: "needs-build",
        image: "localhost/pi-coder-sandbox:b",
        recipePath: "/repo/.pi/Containerfile",
    };

    it("uses bubblewrap when the project settled on it, even with a ready image", () => {
        expect(
            planSessionBackend({
                selection: { choice: "bwrap", source: "config" },
                readiness: ready,
                interactive: true,
            }),
        ).toEqual({ kind: "bwrap" });
    });

    it("uses the container when the image is ready", () => {
        expect(
            planSessionBackend({
                selection: { choice: "auto", source: "default" },
                readiness: ready,
                interactive: false,
            }),
        ).toEqual({ kind: "container", image: ready.image });
    });

    it("asks once when a recipe has never been built", () => {
        expect(
            planSessionBackend({
                selection: { choice: "auto", source: "default" },
                readiness: needsBuild,
                interactive: true,
            }),
        ).toEqual({ kind: "ask", image: needsBuild.image, recipePath: needsBuild.recipePath });
    });

    it("does not ask again for the recipe state the user dismissed", () => {
        expect(
            planSessionBackend({
                selection: { choice: "auto", source: "default" },
                readiness: needsBuild,
                interactive: true,
                declinedTag: needsBuild.image,
            }),
        ).toEqual({ kind: "bwrap", reason: undefined });
    });

    it("explains a downgrade only when the container was requested explicitly", () => {
        const plan = planSessionBackend({
            selection: { choice: "container", source: "config" },
            readiness: needsBuild,
            interactive: false,
        });

        expect(plan).toMatchObject({
            kind: "bwrap",
            reason: expect.stringContaining("has not been built"),
        });
    });

    it("stays silent about a repository that has nothing to containerize", () => {
        expect(
            planSessionBackend({
                selection: { choice: "auto", source: "default" },
                readiness: { state: "no-recipe" },
                interactive: true,
            }),
        ).toEqual({ kind: "bwrap" });
    });

    it("carries the host's reason through when the container cannot run here", () => {
        expect(
            planSessionBackend({
                selection: { choice: "auto", source: "default" },
                readiness: { state: "unavailable", reason: "needs podman on PATH" },
                interactive: true,
            }),
        ).toEqual({ kind: "bwrap", reason: "needs podman on PATH" });
    });
});

describe("readiness", () => {
    it("reports a recipe whose tag is absent as work to do, not as an error", async () => {
        const projectDir = project({ recipe: "FROM debian:13\n" });

        expect(await readinessFor(projectDir, { imageExists: false })).toMatchObject({
            state: "needs-build",
            recipePath: path.join(projectDir, ".pi", "Containerfile"),
        });
    });

    it("reports a built image as ready", async () => {
        const projectDir = project({ recipe: "FROM debian:13\n" });

        expect(await readinessFor(projectDir, { imageExists: true })).toMatchObject({
            state: "ready",
        });
    });

    it("reports a host without podman instead of failing", async () => {
        const projectDir = project({ recipe: "FROM debian:13\n" });

        expect(
            await readinessFor(projectDir, { host: { ok: false, reason: "needs podman on PATH" } }),
        ).toEqual({ state: "unavailable", reason: "needs podman on PATH" });
    });

    it("reports a checkout with no recipe as nothing to containerize", async () => {
        expect(await readinessFor(project())).toEqual({ state: "no-recipe" });
    });

    it("treats an explicitly named image as ready without consulting a recipe", async () => {
        expect(
            await readinessFor(project(), {
                env: { PI_SANDBOX_IMAGE: "localhost/custom:1" },
                host: { ok: false, reason: "never asked" },
            }),
        ).toEqual({ state: "ready", image: "localhost/custom:1" });
    });

    it("refuses a musl base before podman is invoked", async () => {
        expect(
            await readinessFor(project({ recipe: "FROM alpine:3.20\n" }), {
                host: { ok: false, reason: "never asked" },
            }),
        ).toMatchObject({ state: "unsupported" });
    });
});
