import path from "node:path";
import { describe, expect, it } from "vitest";

import type { SandboxConfig } from "../../../src/common/config";
import { fileRootsForOperation, getFileAccessRoots } from "../../../src/modules/sandbox/file-roots";

/**
 * `getFileAccessRoots` is the one place that decides what the direct file tools may touch beyond the working
 * directory, so the cases here are the policy: explicit lists always apply, a mount list only widens when the
 * user opts into it, the runtime resource roots are readable by default, and nothing about a read grant
 * touches writes.
 *
 * The derived resource roots are injected as `[]` wherever an assertion is about the declared list, so the
 * test does not depend on the packages installed on the machine. The default derivation is covered by
 * `resource-roots.test.ts`.
 */

const NO_RESOURCE_ROOTS = { resourceRoots: [] as const };

function config(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
    return {
        sandbox: { mounts: {}, env: {}, inheritEnv: {} },
        permissions: {},
        ...overrides,
    };
}

function filesConfig(
    files: Record<string, unknown>,
    mounts: Record<string, "readonly" | "readwrite"> = {},
) {
    return config({ files: files as never, sandbox: { mounts, env: {}, inheritEnv: {} } });
}

describe("file access roots", () => {
    it("takes the explicit lists in both directions", () => {
        const roots = getFileAccessRoots(
            filesConfig({
                readRoots: ["/srv/docs"],
                writeRoots: ["/srv/outbox"],
                honorPiPackage: false,
            }),
            NO_RESOURCE_ROOTS,
        );

        expect(roots.read).toEqual(["/srv/docs"]);
        expect(roots.write).toEqual(["/srv/outbox"]);
    });

    it("ignores the mount list until it is declared as a file-access source", () => {
        const mounts = { "/home/user/.nvm": "readonly", "/home/user/.pi": "readwrite" } as const;

        const off = getFileAccessRoots(
            filesConfig({ honorPiPackage: false }, mounts),
            NO_RESOURCE_ROOTS,
        );
        expect(off.read).toEqual([]);
        expect(off.write).toEqual([]);

        const on = getFileAccessRoots(
            filesConfig({ honorPiPackage: false, honorMounts: true }, mounts),
            NO_RESOURCE_ROOTS,
        );
        expect(on.read).toEqual(["/home/user/.nvm", "/home/user/.pi"]);
    });

    it("widens writes from a readwrite mount only once mounts are honoured", () => {
        const mounts = { "/home/user/.cache/uv": "readwrite", "/etc": "readonly" } as const;

        const honoured = getFileAccessRoots(
            filesConfig({ honorPiPackage: false, honorMounts: true }, mounts),
            NO_RESOURCE_ROOTS,
        );

        expect(honoured.write).toEqual(["/home/user/.cache/uv"]);
        expect(honoured.read).toContain("/etc");
    });

    it("adds the runtime resource roots to reads and never to writes", () => {
        const roots = getFileAccessRoots(config(), {
            resourceRoots: ["/opt/pi/skills", "/opt/pi/package"],
        });

        expect(roots.read).toEqual(["/opt/pi/skills", "/opt/pi/package"]);
        expect(roots.write).toEqual([]);
    });

    it("derives absolute resource roots by default", () => {
        const roots = getFileAccessRoots(config());

        expect(roots.write).toEqual([]);
        for (const root of roots.read) {
            expect(path.isAbsolute(root)).toBe(true);
        }
    });

    it("drops blank and duplicate entries and keeps the declared order", () => {
        const roots = getFileAccessRoots(
            filesConfig(
                {
                    readRoots: ["/a", "  ", "/b", "/a", ""],
                    writeRoots: ["/b", "/b", "/c"],
                    honorPiPackage: false,
                },
                { "/a": "readonly" },
            ),
            NO_RESOURCE_ROOTS,
        );

        expect(roots.read).toEqual(["/a", "/b"]);
        expect(roots.write).toEqual(["/b", "/c"]);
    });

    it("drops duplicate resource roots already declared explicitly", () => {
        const roots = getFileAccessRoots(filesConfig({ readRoots: ["/skills"] }), {
            resourceRoots: ["/skills", "/other"],
        });

        expect(roots.read).toEqual(["/skills", "/other"]);
    });

    it("treats a missing config as no declared roots", () => {
        const roots = getFileAccessRoots(null, NO_RESOURCE_ROOTS);

        expect(roots.read).toEqual([]);
        expect(roots.write).toEqual([]);
        expect(fileRootsForOperation(undefined, "write", NO_RESOURCE_ROOTS)).toEqual([]);
    });

    it("selects the operation's own list", () => {
        const candidate = filesConfig({
            readRoots: ["/only-read"],
            writeRoots: ["/only-write"],
            honorPiPackage: false,
        });

        expect(fileRootsForOperation(candidate, "read", NO_RESOURCE_ROOTS)).toEqual(["/only-read"]);
        expect(fileRootsForOperation(candidate, "write", NO_RESOURCE_ROOTS)).toEqual([
            "/only-write",
        ]);
    });
});
