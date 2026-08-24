import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    getPathConfinementPermission,
    Heuristic,
    isPathWithinDirectory,
} from "../../../src/modules/sandbox/heuristics";

describe("file path confinement", () => {
    let temporaryDirectories: string[] = [];

    afterEach(() => {
        for (const directory of temporaryDirectories) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
        temporaryDirectories = [];
    });

    it("allows ordinary paths in cwd and rejects paths outside or sensitive paths", () => {
        expect(getPathConfinementPermission("src/index.ts", "/project", {})).toBe(Heuristic.SAFE_READONLY);
        expect(getPathConfinementPermission("../secrets.txt", "/project", {})).toBeUndefined();
        expect(getPathConfinementPermission(".env", "/project", {})).toBeUndefined();
        expect(getPathConfinementPermission("src/app.pem", "/project", {})).toBeUndefined();
    });

    it("honors the cwd heuristic configuration", () => {
        expect(getPathConfinementPermission("file.txt", "/project", {
            permission: "allow",
        })).toBe(Heuristic.SAFE_READONLY);
        expect(getPathConfinementPermission("file.txt", "/project", {
            enabled: false,
        })).toBeUndefined();
    });

    it("rejects symlink escapes and dangling symlinks", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-paths-"));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-outside-"));
        temporaryDirectories.push(cwd, outside);
        fs.symlinkSync(outside, path.join(cwd, "link"), "dir");
        fs.symlinkSync(path.join(outside, "missing"), path.join(cwd, "dangling"));

        expect(getPathConfinementPermission("link/file.txt", cwd, {})).toBeUndefined();
        expect(getPathConfinementPermission("dangling", cwd, {})).toBeUndefined();
        expect(getPathConfinementPermission("new/file.txt", cwd, {})).toBe(Heuristic.SAFE_READONLY);
        expect(getPathConfinementPermission("new/file.txt", cwd, {}, "write")).toBe(Heuristic.SAFE_EDIT);
    });

    it("keeps an approved folder scoped to that folder", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-paths-"));
        const folder = path.join(cwd, "approved");
        fs.mkdirSync(folder);
        temporaryDirectories.push(cwd);

        expect(isPathWithinDirectory("approved/file.txt", folder, cwd, {})).toBe(true);
        expect(isPathWithinDirectory("other/file.txt", folder, cwd, {})).toBe(false);
    });
});
