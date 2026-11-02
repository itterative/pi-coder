import type {
    EditOperations,
    FindOperations,
    LsOperations,
    ReadOperations,
    WriteOperations,
} from "@earendil-works/pi-coding-agent";

import type { ContainerSession } from "./client";
import { IMAGE_TYPE_SNIFF_BYTES, detectImageMimeType } from "./image-type";

/**
 * pi's file tools over a container session's filesystem.
 *
 * These exist because the sandbox is only honest if a tool call and a command answer from the same place:
 * `bash` runs in the container, so the checkout is shared by construction, but the sandbox has its own
 * `$HOME` and `/tmp` and the image's own `/etc`. Reading those host-side would let `read` describe a file
 * `bash` cannot open, and `write` create a file no command will ever see.
 *
 * Everything else stays pi's: its truncation, image resizing, diff preview, mutation queue, renderers, and
 * prompts are built on top of these operations, not replaced by them.
 */
export interface ContainerFileOperations {
    read: ReadOperations;
    write: WriteOperations;
    edit: EditOperations;
    ls: LsOperations;
    find: FindOperations;
}

export function createContainerFileOperations(session: ContainerSession): ContainerFileOperations {
    const readFileBuffer = async (absolutePath: string): Promise<Buffer> => {
        const result = await session.fs({ op: "readFile", path: absolutePath });

        return Buffer.from(result.data, "base64");
    };

    const read = {
        readFile: readFileBuffer,
        access: async (absolutePath: string): Promise<void> => {
            await session.fs({ op: "access", path: absolutePath, mode: "r" });
        },
        // Sniffing happens on a small prefix rather than the whole file: the seam runs before the read that
        // would fetch it anyway, and an image can be large.
        detectImageMimeType: async (absolutePath: string): Promise<string | null> => {
            const result = await session.fs({
                op: "readFile",
                path: absolutePath,
                bytes: IMAGE_TYPE_SNIFF_BYTES,
            });

            return detectImageMimeType(Buffer.from(result.data, "base64"));
        },
    } satisfies ReadOperations;

    const write = {
        writeFile: async (absolutePath: string, content: string): Promise<void> => {
            await session.fs({ op: "writeFile", path: absolutePath, content });
        },
        mkdir: async (directory: string): Promise<void> => {
            await session.fs({ op: "mkdir", path: directory });
        },
    } satisfies WriteOperations;

    const edit = {
        readFile: readFileBuffer,
        writeFile: write.writeFile,
        // The seam means "readable and writable"; the container answers with the flag it will need.
        access: async (absolutePath: string): Promise<void> => {
            await session.fs({ op: "access", path: absolutePath, mode: "w" });
        },
    } satisfies EditOperations;

    const ls = {
        exists: async (absolutePath: string): Promise<boolean> => {
            const result = await session.fs({ op: "exists", path: absolutePath });

            return result.exists;
        },
        stat: async (absolutePath: string) => {
            const result = await session.fs({ op: "stat", path: absolutePath });

            return { isDirectory: () => result.isDirectory };
        },
        readdir: async (absolutePath: string): Promise<string[]> => {
            const result = await session.fs({ op: "readdir", path: absolutePath });

            return result.entries;
        },
    } satisfies LsOperations;

    const find = {
        exists: async (absolutePath: string): Promise<boolean> => {
            const result = await session.fs({ op: "exists", path: absolutePath });

            return result.exists;
        },
        glob: async (
            pattern: string,
            cwd: string,
            options: { ignore: string[]; limit: number },
        ): Promise<string[]> => {
            const result = await session.fs({
                op: "glob",
                path: cwd,
                pattern,
                ignore: options.ignore,
                limit: options.limit,
            });

            return result.paths;
        },
    } satisfies FindOperations;

    return { read, write, edit, ls, find };
}
