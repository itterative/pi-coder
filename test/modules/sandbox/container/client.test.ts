import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
    ContainerSession,
    ContainerSessionError,
    type ContainerLaunch,
} from "../../../../src/modules/sandbox/container/client";

const DISPATCHER = fileURLToPath(
    new URL("../../../../src/modules/sandbox/container/dispatch.mjs", import.meta.url),
);

const temporaryDirectories: string[] = [];
const sessions: ContainerSession[] = [];

afterEach(async () => {
    for (const session of sessions.splice(0)) {
        await session.close().catch(() => undefined);
    }

    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-container-test-"));
    temporaryDirectories.push(directory);

    return directory;
}

function homeDir(): string {
    return path.join(temporaryDirectory(), "home");
}

/**
 * Stands in for `podman run`: it runs the dispatcher from the host path the client mounted, so the client's
 * framing, request lifecycle, cancellation, and teardown are exercised without a container runtime or image.
 */
const launchDispatcher: ContainerLaunch = (_command, args): ChildProcess => {
    // The real launcher runs the dispatcher inside the container; here it runs the same file from wherever the
    // mount argument points, which is also a check that the mount argument names a path that really exists.
    const dispatcherMount = args.find((arg) => arg.endsWith(":/run/pi/dispatch.mjs:ro"));
    const dispatcherPath = dispatcherMount?.split(":").at(0);

    if (dispatcherPath === undefined || dispatcherPath.length === 0) {
        throw new Error("launch received no dispatcher mount");
    }

    return spawn(process.execPath, [dispatcherPath], {
        stdio: ["pipe", "pipe", "pipe"],
    });
};

async function startSession(overrides: Partial<Parameters<typeof ContainerSession.start>[0]> = {}) {
    const session = await ContainerSession.start({
        cwd: process.cwd(),
        image: "test-image",
        sessionId: `test-${Math.random().toString(16).slice(2)}`,
        homeDir: homeDir(),
        spawn: launchDispatcher,
        ...overrides,
    });
    sessions.push(session);

    return session;
}

describe("container session", () => {
    it("passes the posture's own mount list to podman, without adding the checkout back", async () => {
        const seen: (readonly string[])[] = [];
        const session = await startSession({
            mounts: [{ source: process.cwd(), target: process.cwd(), mode: "ro" }],
            network: "none",
            spawn: (_command, args) => {
                seen.push(args);

                return launchDispatcher(_command, args);
            },
        });

        expect(session.isClosed).toBe(false);

        const args = seen[0] ?? [];
        const volumes = args.filter((arg, index) => args[index - 1] === "--volume");
        const cwdVolumes = volumes.filter((volume) => volume.startsWith(`${process.cwd()}:`));

        // Exactly one volume for the checkout, read-only: the caller decides, and nothing re-adds it writable.
        expect(cwdVolumes).toEqual([`${process.cwd()}:${process.cwd()}:ro`]);
        expect(args).toContain("--network=none");
    });

    it("starts by launching the dispatcher through the injected launcher", async () => {
        const session = await startSession();

        expect(session.containerName).toMatch(/^pi-coder-sandbox-test-/);
        expect(session.shell).toMatch(/bash|sh/);
        expect(session.isClosed).toBe(false);
    });

    it("mounts the dispatcher read-only from its own path, without copying it", async () => {
        const seen: (readonly string[])[] = [];

        await startSession({
            spawn: (command, args) => {
                seen.push(args);

                return launchDispatcher(command, args);
            },
        });

        expect(seen[0]).toContain(`${DISPATCHER}:/run/pi/dispatch.mjs:ro`);
    });

    it("mounts the shared home at the real home path", async () => {
        const home = homeDir();
        const seen: (readonly string[])[] = [];

        await startSession({
            homeDir: home,
            spawn: (command, args) => {
                seen.push(args);

                return launchDispatcher(command, args);
            },
        });

        expect(seen[0]).toContain(`${home}:${os.homedir()}:rw`);
        expect(fs.existsSync(home)).toBe(true);
    });

    it("seeds the host identity into the home and leaves an unchanged one alone", async () => {
        const home = homeDir();
        const identity = { name: "A U Thor", email: "author@example.com" };
        await startSession({ homeDir: home, gitIdentity: identity });

        const file = path.join(home, ".gitconfig");
        expect(fs.readFileSync(file, "utf8")).toContain("author@example.com");

        const marker = new Date("2020-01-01T00:00:00Z");
        fs.utimesSync(file, marker, marker);
        await startSession({ homeDir: home, gitIdentity: identity });
        expect(fs.statSync(file).mtimeMs).toBe(marker.getTime());

        await startSession({
            homeDir: home,
            gitIdentity: { ...identity, email: "new@example.com" },
        });
        expect(fs.readFileSync(file, "utf8")).toContain("new@example.com");
    });

    it("returns the exit code and forwards output", async () => {
        const session = await startSession();
        const chunks: Buffer[] = [];

        const result = await session.exec({
            command: "echo hello; echo oops >&2; exit 7",
            cwd: process.cwd(),
            onOutput: (chunk) => chunks.push(chunk),
        });

        expect(result.exitCode).toBe(7);
        expect(Buffer.concat(chunks).toString("utf8")).toContain("hello");
    });

    it("runs concurrent commands without interleaving their results", async () => {
        const session = await startSession();
        const slow = session.exec({ command: "sleep 0.2; echo slow", cwd: process.cwd() });
        const fast = session.exec({ command: "echo fast", cwd: process.cwd() });

        const [slowResult, fastResult] = await Promise.all([slow, fast]);

        expect(slowResult.exitCode).toBe(0);
        expect(fastResult.exitCode).toBe(0);
    });

    it("cancels through the abort signal and reports the command as cancelled", async () => {
        const session = await startSession();
        const controller = new AbortController();

        const running = session.exec({
            command: "sleep 30",
            cwd: process.cwd(),
            signal: controller.signal,
        });

        await new Promise((resolve) => setTimeout(resolve, 100));
        controller.abort();

        const result = await running;

        expect(result.cancelled).toBe(true);
    });

    it("rejects immediately when the signal is already aborted", async () => {
        const session = await startSession();
        const controller = new AbortController();
        controller.abort();

        await expect(
            session.exec({ command: "echo never", cwd: process.cwd(), signal: controller.signal }),
        ).rejects.toThrow(/aborted/);
    });

    it("surfaces a missing working directory as a typed failure", async () => {
        const session = await startSession();

        await expect(
            session.exec({ command: "pwd", cwd: "/nonexistent-directory-for-tests" }),
        ).rejects.toMatchObject({ kind: "cwd-missing" });
    });

    it("passes the timeout through to the dispatcher", async () => {
        const session = await startSession();

        const result = await session.exec({
            command: "sleep 30",
            cwd: process.cwd(),
            timeoutMs: 100,
        });

        expect(result.timedOut).toBe(true);
    });

    it("closes the dispatcher and refuses further commands", async () => {
        const session = await startSession();

        await session.close();

        expect(session.isClosed).toBe(true);
        await expect(
            session.exec({ command: "echo late", cwd: process.cwd() }),
        ).rejects.toBeInstanceOf(ContainerSessionError);
    });

    it("fails in-flight commands when the container disappears", async () => {
        const session = await startSession();
        const running = session.exec({ command: "sleep 30", cwd: process.cwd() });

        await new Promise((resolve) => setTimeout(resolve, 100));
        session.close();

        await expect(running).rejects.toMatchObject({ kind: "container-exited" });
    });

    it("reports a launcher that cannot start anything", async () => {
        await expect(
            ContainerSession.start({
                cwd: process.cwd(),
                image: "test-image",
                sessionId: "test-missing-podman",
                homeDir: homeDir(),
                spawn: () => {
                    throw new Error("no podman here");
                },
            }),
        ).rejects.toMatchObject({ kind: "start" });
    });

    it("reports a dispatcher that exits before becoming ready", async () => {
        await expect(
            ContainerSession.start({
                cwd: process.cwd(),
                image: "test-image",
                sessionId: "test-immediate-exit",
                homeDir: homeDir(),
                spawn: () =>
                    spawn(process.execPath, ["-e", "process.exit(3)"], {
                        stdio: ["pipe", "pipe", "pipe"],
                    }),
                startTimeoutMs: 5_000,
            }),
        ).rejects.toMatchObject({ kind: "container-exited" });
    });
});
