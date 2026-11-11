import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    artifactsPresent,
    ensureArtifacts,
    type ArtifactSpec,
} from "../../../src/tools/code/semantic/artifacts";

const dirs: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-artifacts-"));

    dirs.push(dir);

    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function sha256(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function specFor(
    bytes: Buffer,
    name = "file.bin",
    overrides: Partial<ArtifactSpec> = {},
): ArtifactSpec {
    return {
        path: name,
        url: `https://example.test/${name}`,
        sha256: sha256(bytes),
        bytes: bytes.length,
        ...overrides,
    };
}

function fetchReturning(bodies: Map<string, Buffer>, counter = { count: 0 }): typeof fetch {
    const impl = async (input: string | URL | Request): Promise<Response> => {
        counter.count += 1;
        const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body = bodies.get(url);

        if (body === undefined) {
            return new Response(new Uint8Array(), { status: 404 });
        }

        return new Response(new Uint8Array(body), { status: 200 });
    };

    return impl as unknown as typeof fetch;
}

describe("outline semantic artifacts", () => {
    it("downloads a verified artifact and records it", async () => {
        const dir = tempDir();
        const bytes = Buffer.from("runtime bytes");
        const spec = specFor(bytes);
        const counter = { count: 0 };

        await ensureArtifacts({
            dir,
            specs: [spec],
            fetchImpl: fetchReturning(new Map([[spec.url, bytes]]), counter),
        });

        expect(fs.readFileSync(path.join(dir, spec.path))).toEqual(bytes);
        expect(verifiedCount(dir)).toBe(1);
        expect(artifactsPresent(dir, [spec])).toBe(true);
    });

    it("skips a file whose size and mtime are already verified", async () => {
        const dir = tempDir();
        const bytes = Buffer.from("runtime bytes");
        const spec = specFor(bytes);
        const counter = { count: 0 };
        const fetchImpl = fetchReturning(new Map([[spec.url, bytes]]), counter);

        await ensureArtifacts({ dir, specs: [spec], fetchImpl });
        await ensureArtifacts({ dir, specs: [spec], fetchImpl });

        expect(counter.count).toBe(1);
    });

    it("rejects a checksum mismatch and leaves no usable file", async () => {
        const dir = tempDir();
        const bytes = Buffer.from("tampered");
        const spec = specFor(Buffer.from("expected"));

        await expect(
            ensureArtifacts({
                dir,
                specs: [spec],
                fetchImpl: fetchReturning(new Map([[spec.url, bytes]])),
            }),
        ).rejects.toThrow(/checksum/);

        expect(fs.existsSync(path.join(dir, spec.path))).toBe(false);
        expect(fs.existsSync(path.join(dir, `${spec.path}.part`))).toBe(false);
    });

    it("rejects a truncated download", async () => {
        const dir = tempDir();
        const bytes = Buffer.from("short");
        const spec = specFor(bytes, "file.bin", { bytes: bytes.length + 10 });

        await expect(
            ensureArtifacts({
                dir,
                specs: [spec],
                fetchImpl: fetchReturning(new Map([[spec.url, bytes]])),
            }),
        ).rejects.toThrow(/expected/);
    });

    it("reports a missing artifact", () => {
        const dir = tempDir();

        expect(artifactsPresent(dir, [] as ArtifactSpec[])).toBe(true);
        expect(artifactsPresent(dir, [specFor(Buffer.from("x"))])).toBe(false);
    });
});

function verifiedCount(dir: string): number {
    const verified = JSON.parse(fs.readFileSync(path.join(dir, "verified.json"), "utf8")) as {
        files: Record<string, unknown>;
    };

    return Object.keys(verified.files).length;
}
