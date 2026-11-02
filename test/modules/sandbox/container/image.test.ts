import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
    ImageBuildError,
    createPodmanImageRunner,
    createPodmanImageStore,
    ensureSandboxImage,
    type ImageRunner,
    type ImageStore,
} from "../../../../src/modules/sandbox/container/image";

/** The minimum of `ChildProcess` the runner touches, driven by hand so no podman is involved. */
class FakeChild extends EventEmitter {
    readonly stdout = new EventEmitter();
    readonly stderr = new EventEmitter();
    readonly signals: (NodeJS.Signals | number)[] = [];

    kill(signal?: NodeJS.Signals | number): boolean {
        this.signals.push(signal ?? "SIGTERM");

        return true;
    }

    writeStdout(text: string): void {
        this.stdout.emit("data", Buffer.from(text, "utf8"));
    }

    writeStderr(text: string): void {
        this.stderr.emit("data", Buffer.from(text, "utf8"));
    }

    finish(exitCode: number | null, signalName: NodeJS.Signals | null = null): void {
        this.emit("close", exitCode, signalName);
    }

    asChildProcess(): ChildProcess {
        return this as unknown as ChildProcess;
    }
}

interface Call {
    command: string;
    args: readonly string[];
    child: FakeChild;
}

function runnerHarness(): { runner: ImageRunner; calls: Call[] } {
    const calls: Call[] = [];

    const runner = createPodmanImageRunner("/usr/bin/podman", (command, args) => {
        const child = new FakeChild();
        calls.push({ command, args, child });

        return child.asChildProcess();
    });

    return { runner, calls };
}

const dirs: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-image-"));
    dirs.push(dir);

    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe("createPodmanImageRunner.exists", () => {
    it("asks podman whether the exact tag is in local storage", async () => {
        const { runner, calls } = runnerHarness();
        const pending = runner.exists("pi-coder-sandbox:abc");
        calls[0].child.finish(0);

        await expect(pending).resolves.toBe(true);
        expect(calls[0].command).toBe("/usr/bin/podman");
        expect(calls[0].args).toEqual(["image", "exists", "pi-coder-sandbox:abc"]);
    });

    it("treats exit 1 as 'not built', which is the only reason to build", async () => {
        const { runner, calls } = runnerHarness();
        const pending = runner.exists("pi-coder-sandbox:abc");
        calls[0].child.finish(1);

        await expect(pending).resolves.toBe(false);
    });

    it("reports a real podman failure instead of pretending the image is absent", async () => {
        const { runner, calls } = runnerHarness();
        const pending = runner.exists("pi-coder-sandbox:abc");
        calls[0].child.writeStderr("cannot connect to podman socket");
        calls[0].child.finish(125);

        await expect(pending).rejects.toThrow(/exit 125[\s\S]*cannot connect/);
    });
});

describe("createPodmanImageRunner.build", () => {
    it("builds the generated Containerfile with the recipe's directory as context", async () => {
        const { runner, calls } = runnerHarness();
        const pending = runner.build({
            imageTag: "pi-coder-sandbox:abc",
            containerfilePath: "/state/container/Containerfile.abc",
            contextDir: "/project/.pi/sandbox",
        });
        calls[0].child.finish(0);

        await pending;

        expect(calls[0].args).toEqual([
            "build",
            "--tag",
            "pi-coder-sandbox:abc",
            "--file",
            "/state/container/Containerfile.abc",
            "/project/.pi/sandbox",
        ]);
    });

    it("streams podman's output as it arrives", async () => {
        const { runner, calls } = runnerHarness();
        const chunks: string[] = [];
        const pending = runner.build({
            imageTag: "tag",
            containerfilePath: "/cf",
            contextDir: "/ctx",
            onOutput: (chunk) => chunks.push(chunk),
        });

        calls[0].child.writeStdout("STEP 1/3\n");
        calls[0].child.writeStderr("warning: something\n");
        calls[0].child.finish(0);
        await pending;

        expect(chunks).toEqual(["STEP 1/3\n", "warning: something\n"]);
    });

    it("surfaces the tail of the output when the build fails", async () => {
        const { runner, calls } = runnerHarness();
        const pending = runner.build({
            imageTag: "tag",
            containerfilePath: "/cf",
            contextDir: "/ctx",
        });

        calls[0].child.writeStdout("STEP 1/3\n");
        calls[0].child.writeStderr("E: Unable to locate package git\n");
        calls[0].child.finish(125);

        await expect(pending).rejects.toThrow(
            /podman build failed \(exit 125\)[\s\S]*Unable to locate package git/,
        );
    });

    it("rejects before spawning when the caller already aborted", async () => {
        const { runner, calls } = runnerHarness();
        const controller = new AbortController();
        controller.abort();

        await expect(
            runner.build({
                imageTag: "tag",
                containerfilePath: "/cf",
                contextDir: "/ctx",
                signal: controller.signal,
            }),
        ).rejects.toBeInstanceOf(ImageBuildError);
        expect(calls).toHaveLength(0);
    });

    it("kills a running build when the caller aborts", async () => {
        const { runner, calls } = runnerHarness();
        const controller = new AbortController();
        const pending = runner.build({
            imageTag: "tag",
            containerfilePath: "/cf",
            contextDir: "/ctx",
            signal: controller.signal,
        });

        controller.abort();
        calls[0].child.finish(null, "SIGTERM");

        await expect(pending).rejects.toThrow(/aborted/);
        expect(calls[0].child.signals).toEqual(["SIGTERM"]);
    });
});

describe("ensureSandboxImage", () => {
    function recordingRunner(present: boolean): ImageRunner & { builds: number } {
        const runner = {
            builds: 0,
            async exists() {
                return present;
            },
            async build() {
                runner.builds += 1;
            },
        };

        return runner;
    }

    it("leaves the Containerfile alone on a cache hit, so it never describes text that was not built", async () => {
        const dir = tempDir();
        const containerfilePath = path.join(dir, "Containerfile");
        const runner = recordingRunner(true);

        const outcome = await ensureSandboxImage({
            runner,
            imageTag: "pi-coder-sandbox:abc",
            containerfileText: "FROM base\n",
            containerfilePath,
            contextDir: dir,
        });

        expect(outcome.outcome).toBe("present");
        expect(runner.builds).toBe(0);
        expect(fs.existsSync(containerfilePath)).toBe(false);
    });

    it("writes the effective Containerfile for the build that reads it", async () => {
        const dir = tempDir();
        const containerfilePath = path.join(dir, "nested", "Containerfile");
        const runner = recordingRunner(false);

        const outcome = await ensureSandboxImage({
            runner,
            imageTag: "pi-coder-sandbox:abc",
            containerfileText: "FROM base\n",
            containerfilePath,
            contextDir: dir,
        });

        expect(outcome.outcome).toBe("built");
        expect(runner.builds).toBe(1);
        expect(fs.readFileSync(containerfilePath, "utf8")).toBe("FROM base\n");
    });

    it("builds when the tag is missing", async () => {
        const dir = tempDir();
        const runner = recordingRunner(false);

        const outcome = await ensureSandboxImage({
            runner,
            imageTag: "pi-coder-sandbox:abc",
            containerfileText: "FROM base\n",
            containerfilePath: path.join(dir, "nested", "Containerfile"),
            contextDir: dir,
        });

        expect(outcome.outcome).toBe("built");
        expect(runner.builds).toBe(1);
    });

    function recordingStore(): ImageStore & { removed: string[][]; inUseCalls: number } {
        const store = {
            removed: [] as string[][],
            inUseCalls: 0,
            async listSandboxImages() {
                return [
                    {
                        id: "aaaaaaaaaaaa",
                        reference: "localhost/pi-coder-sandbox:new",
                        created: "n",
                    },
                    {
                        id: "bbbbbbbbbbbb",
                        reference: "localhost/pi-coder-sandbox:old",
                        created: "o",
                    },
                ].map((image) => ({
                    ...image,
                    created: "2025-01-01 00:00:00.000000000 +0000 UTC",
                }));
            },
            async containersInUse() {
                store.inUseCalls += 1;

                return [];
            },
            async removeImages(ids: readonly string[]) {
                store.removed.push([...ids]);
            },
        };

        return store;
    }

    it("prunes only after a build, so a cache hit touches no images", async () => {
        const dir = tempDir();
        const store = recordingStore();
        const outcome = await ensureSandboxImage({
            runner: recordingRunner(true),
            store,
            keep: 1,
            imageTag: "localhost/pi-coder-sandbox:new",
            containerfileText: "FROM base\n",
            containerfilePath: path.join(dir, "Containerfile.abc"),
            contextDir: dir,
        });

        expect(outcome.pruned).toEqual([]);
        expect(store.inUseCalls).toBe(0);
        expect(store.removed).toEqual([]);
    });

    it("keeps the tag it just built and reports what it removed", async () => {
        const dir = tempDir();
        const store = recordingStore();
        const outcome = await ensureSandboxImage({
            runner: recordingRunner(false),
            store,
            keep: 1,
            imageTag: "localhost/pi-coder-sandbox:new",
            containerfileText: "FROM base\n",
            containerfilePath: path.join(dir, "Containerfile.abc"),
            contextDir: dir,
        });

        expect(outcome.pruned).toEqual(["localhost/pi-coder-sandbox:old"]);
        expect(store.removed).toEqual([["bbbbbbbbbbbb"]]);
    });

    it("reports a failed retention pass without failing the build", async () => {
        const dir = tempDir();
        const store: ImageStore = {
            async listSandboxImages() {
                throw new Error("podman socket unavailable");
            },
            async containersInUse() {
                return [];
            },
            async removeImages() {},
        };
        const outcome = await ensureSandboxImage({
            runner: recordingRunner(false),
            store,
            keep: 1,
            imageTag: "localhost/pi-coder-sandbox:new",
            containerfileText: "FROM base\n",
            containerfilePath: path.join(dir, "Containerfile.abc"),
            contextDir: dir,
        });

        expect(outcome.outcome).toBe("built");
        expect(outcome.pruned).toEqual([]);
        expect(outcome.pruneError).toBe("podman socket unavailable");
    });
});

describe("createPodmanImageStore", () => {
    /** Wait for the store's next podman invocation instead of guessing how many microtasks it takes. */
    async function waitForCall(calls: Call[], index: number): Promise<Call> {
        for (let attempt = 0; attempt < 100 && calls.length <= index; attempt += 1) {
            await new Promise((resolve) => setImmediate(resolve));
        }

        const call = calls[index];

        if (call === undefined) {
            throw new Error(`podman call ${index + 1} never happened`);
        }

        return call;
    }

    function storeHarness(): { store: ImageStore; calls: Call[] } {
        const calls: Call[] = [];
        const store = createPodmanImageStore("/usr/bin/podman", (command, args) => {
            const child = new FakeChild();
            calls.push({ command, args, child });

            return child.asChildProcess();
        });

        return { store, calls };
    }

    it("lists only sandbox images and joins their creation stamps by ID", async () => {
        const { store, calls } = storeHarness();
        const pending = store.listSandboxImages();

        calls[0].child.writeStdout(
            "aaaaaaaaaaaa localhost/pi-coder-sandbox:new\n" +
                "bbbbbbbbbbbb docker.io/library/node:24-trixie\n",
        );
        calls[0].child.finish(0);

        expect(calls[0].args).toEqual(["images", "--format", "{{.ID}} {{.Repository}}:{{.Tag}}"]);

        calls[1] = (await waitForCall(calls, 1)) as Call;
        calls[1].child.writeStdout(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa " +
                "2025-02-09 12:34:56.123456789 +0000 UTC\n",
        );
        calls[1].child.finish(0);

        await expect(pending).resolves.toEqual([
            {
                id: "aaaaaaaaaaaa",
                reference: "localhost/pi-coder-sandbox:new",
                created: "2025-02-09 12:34:56.123456789 +0000 UTC",
            },
        ]);
        expect(calls[1].args.slice(0, 3)).toEqual(["image", "inspect", "--format"]);
        expect(calls[1].args.slice(4)).toEqual(["aaaaaaaaaaaa"]);
    });

    it("asks nothing else when no sandbox image exists", async () => {
        const { store, calls } = storeHarness();
        const pending = store.listSandboxImages();

        calls[0].child.writeStdout("bbbbbbbbbbbb docker.io/library/node:24-trixie\n");
        calls[0].child.finish(0);

        await expect(pending).resolves.toEqual([]);
        expect(calls).toHaveLength(1);
    });

    it("reports a listing failure instead of an empty image list", async () => {
        const { store, calls } = storeHarness();
        const pending = store.listSandboxImages();

        calls[0].child.writeStderr("cannot connect to podman socket\n");
        calls[0].child.finish(125);

        await expect(pending).rejects.toThrow(/podman images failed \(exit 125\)[\s\S]*socket/);
    });

    it("collects the image every container references, stopped ones included", async () => {
        const { store, calls } = storeHarness();
        const pending = store.containersInUse();

        calls[0].child.writeStdout("container-1\ncontainer-2\n");
        calls[0].child.finish(0);

        expect(calls[0].args).toEqual(["ps", "--all", "--quiet"]);

        calls[1] = await waitForCall(calls, 1);
        calls[1].child.writeStdout("sha256:aaaaaaaaaaaa\naaaaaaaaaaaa\n");
        calls[1].child.finish(0);

        await expect(pending).resolves.toEqual(["aaaaaaaaaaaa"]);
        expect(calls[1].args.slice(0, 3)).toEqual(["inspect", "--format", "{{.Image}}"]);
        expect(calls[1].args.slice(3)).toEqual(["container-1", "container-2"]);
    });

    it("does not inspect containers when there are none", async () => {
        const { store, calls } = storeHarness();
        const pending = store.containersInUse();

        calls[0].child.finish(0);

        await expect(pending).resolves.toEqual([]);
        expect(calls).toHaveLength(1);
    });

    it("removes by ID, so a moved tag cannot redirect the removal", async () => {
        const { store, calls } = storeHarness();
        const pending = store.removeImages(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);

        calls[0].child.finish(0);

        await expect(pending).resolves.toBeUndefined();
        expect(calls[0].args).toEqual(["image", "rm", "aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    });

    it("spawns nothing when there is nothing to remove", async () => {
        const { store, calls } = storeHarness();

        await expect(store.removeImages([])).resolves.toBeUndefined();
        expect(calls).toHaveLength(0);
    });
});
