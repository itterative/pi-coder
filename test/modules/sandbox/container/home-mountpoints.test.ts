import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureHomeMountPoints } from "../../../../src/modules/sandbox/container/home-mountpoints";

/**
 * Podman creates a missing `--volume` destination inside whatever is mounted over its parent, so a mountpoint
 * under the sandbox home that does not exist is created by podman *as container-root* — a subuid on the host,
 * mode 1755 — which makes `~/.config`, `~/.pi` and `~/Repos` unwritable inside the session and impossible to
 * delete from the host without `sudo`. These cases pin the pre-creation that keeps podman from doing it.
 */
const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

interface Fixture {
    root: string;
    home: string;
    homeTarget: string;
}

function fixture(): Fixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-home-mountpoints-"));
    temporaryDirectories.push(root);

    return {
        root,
        home: path.join(root, "home"),
        homeTarget: "/home/dev",
    };
}

function directoryMode(directory: string): number {
    return fs.statSync(directory).mode & 0o777;
}

function mount(target: string, source = target): { source: string; target: string; mode: "rw" } {
    return { source, target, mode: "rw" };
}

describe("ensureHomeMountPoints", () => {
    it("creates every mountpoint under the home as a writable directory owned by the user", async () => {
        const { home, homeTarget } = fixture();

        await ensureHomeMountPoints({
            home,
            homeTarget,
            mounts: [
                mount(`${homeTarget}/Repos/pi-coder`),
                mount(`${homeTarget}/.pi/agent/memory`),
                mount(`${homeTarget}/.config/gh`),
            ],
        });

        for (const relative of ["Repos/pi-coder", ".pi/agent/memory", ".config/gh"]) {
            const directory = path.join(home, relative);

            expect(fs.statSync(directory).isDirectory()).toBe(true);
            expect(directoryMode(directory) & 0o200).toBe(0o200);

            if (typeof process.getuid === "function") {
                expect(fs.statSync(directory).uid).toBe(process.getuid());
            }
        }
    });

    it("leaves an existing directory and its contents alone", async () => {
        const { home, homeTarget } = fixture();
        const config = path.join(home, ".config");
        fs.mkdirSync(config, { recursive: true, mode: 0o755 });
        fs.writeFileSync(path.join(config, "kept"), "value");

        await ensureHomeMountPoints({
            home,
            homeTarget,
            mounts: [mount(`${homeTarget}/.config/gh`)],
        });

        expect(fs.readFileSync(path.join(config, "kept"), "utf8")).toBe("value");
    });

    it("ignores targets outside the home, the home itself, and a sibling with the same prefix", async () => {
        const { home, homeTarget } = fixture();

        await ensureHomeMountPoints({
            home,
            homeTarget,
            mounts: [
                mount(homeTarget),
                mount("/srv/elsewhere/data"),
                mount(`${homeTarget}-other/Repos`),
            ],
        });

        expect(fs.existsSync(home)).toBe(false);
    });

    it("does not scaffold a mount that another mount already covers", async () => {
        const { home, homeTarget } = fixture();

        await ensureHomeMountPoints({
            home,
            homeTarget,
            mounts: [
                mount(`${homeTarget}/Repos/pi-coder`),
                // A worktree or shared clone also mounts git data inside the checkout; the checkout mount is
                // applied first, so this path never needs a directory in the home scaffold.
                mount(`${homeTarget}/Repos/pi-coder/.git/objects`),
            ],
        });

        expect(fs.statSync(path.join(home, "Repos", "pi-coder")).isDirectory()).toBe(true);
        expect(fs.existsSync(path.join(home, "Repos", "pi-coder", ".git"))).toBe(false);
    });

    it("creates only the parents when the mount source is a file", async () => {
        const { root, home, homeTarget } = fixture();
        const file = path.join(root, "gh-token");
        fs.writeFileSync(file, "secret");

        await ensureHomeMountPoints({
            home,
            homeTarget,
            mounts: [mount(`${homeTarget}/.config/gh/hosts.yml`, file)],
        });

        expect(fs.statSync(path.join(home, ".config", "gh")).isDirectory()).toBe(true);
        expect(fs.existsSync(path.join(home, ".config", "gh", "hosts.yml"))).toBe(false);
    });
});
