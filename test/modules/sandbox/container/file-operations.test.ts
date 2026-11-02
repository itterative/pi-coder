import { describe, expect, it, vi } from "vitest";

import type { ContainerSession } from "../../../../src/modules/sandbox/container/client";
import { createContainerFileOperations } from "../../../../src/modules/sandbox/container/file-operations";
import { IMAGE_TYPE_SNIFF_BYTES } from "../../../../src/modules/sandbox/container/image-type";

/**
 * The adapter is thin on purpose, so these cases pin the two things a thin adapter gets wrong: the shape it
 * hands to pi (a Buffer, not base64; a predicate, not a boolean) and the cheap-but-wrong shortcuts it could
 * take (reading a whole image to sniff four bytes, checking access on the host).
 */

function recordingSession(handler: (request: { op: string; [key: string]: unknown }) => unknown) {
    const calls: { op: string; [key: string]: unknown }[] = [];
    const session = {
        fs: async (request: { op: string; [key: string]: unknown }) => {
            calls.push(request);

            return handler(request);
        },
    };

    return { session: session as unknown as ContainerSession, calls };
}

const PNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

describe("container file operations", () => {
    it("decodes file contents into a Buffer", async () => {
        const { session } = recordingSession(() => ({
            data: Buffer.from("hello\n").toString("base64"),
            size: 6,
        }));

        const operations = createContainerFileOperations(session);
        const buffer = await operations.read.readFile("/repo/notes.txt");

        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.toString("utf8")).toBe("hello\n");
    });

    it("sniffs an image from a small prefix rather than the whole file", async () => {
        const { session, calls } = recordingSession((request) => ({
            data: (request.op === "readFile" ? PNG : Buffer.alloc(0)).toString("base64"),
            size: PNG.length,
        }));

        const operations = createContainerFileOperations(session);
        const mime = await operations.read.detectImageMimeType?.("/repo/logo.png");

        expect(mime).toBe("image/png");
        expect(calls).toEqual([
            { op: "readFile", path: "/repo/logo.png", bytes: IMAGE_TYPE_SNIFF_BYTES },
        ]);
    });

    it("reports no image type for text", async () => {
        const { session } = recordingSession(() => ({
            data: Buffer.from("plain text\n").toString("base64"),
            size: 11,
        }));

        const operations = createContainerFileOperations(session);

        await expect(operations.read.detectImageMimeType?.("/repo/notes.txt")).resolves.toBeNull();
    });

    it("writes and creates directories inside the container", async () => {
        const { session, calls } = recordingSession(() => ({}));
        const operations = createContainerFileOperations(session);

        await operations.write.writeFile("/repo/notes.txt", "hello");
        await operations.write.mkdir("/repo/nested");

        expect(calls).toEqual([
            { op: "writeFile", path: "/repo/notes.txt", content: "hello" },
            { op: "mkdir", path: "/repo/nested" },
        ]);
    });

    it("checks writability for edit and readability for read", async () => {
        const { session, calls } = recordingSession(() => ({}));
        const operations = createContainerFileOperations(session);

        await operations.read.access("/repo/a.txt");
        await operations.edit.access("/repo/a.txt");

        expect(calls).toEqual([
            { op: "access", path: "/repo/a.txt", mode: "r" },
            { op: "access", path: "/repo/a.txt", mode: "w" },
        ]);
    });

    it("hands ls a directory predicate and find the glob parameters", async () => {
        const { session, calls } = recordingSession((request) => {
            if (request.op === "stat") {
                return { isDirectory: true, isFile: false, size: 0 };
            }

            return { paths: ["/repo/src/a.ts"] };
        });
        const operations = createContainerFileOperations(session);

        const stat = await operations.ls.stat("/repo/src");
        expect(stat.isDirectory()).toBe(true);

        const paths = await operations.find.glob("*.ts", "/repo/src", {
            ignore: ["**/node_modules/**"],
            limit: 50,
        });
        expect(paths).toEqual(["/repo/src/a.ts"]);
        expect(calls[1]).toEqual({
            op: "glob",
            path: "/repo/src",
            pattern: "*.ts",
            ignore: ["**/node_modules/**"],
            limit: 50,
        });
    });

    it("asks the container whether a path exists instead of stat-ing the host", async () => {
        const { session } = recordingSession(() => ({ exists: false }));
        const operations = createContainerFileOperations(session);

        await expect(operations.ls.exists("/sandbox-only/path")).resolves.toBe(false);
        await expect(operations.find.exists("/sandbox-only/path")).resolves.toBe(false);
        expect(vi.isMockFunction(session.fs)).toBe(false);
    });
});
