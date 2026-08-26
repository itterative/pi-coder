import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    getPathConfinementAssessment,
    getPathConfinementPermission,
    Heuristic,
    isPathWithinDirectory,
    UnsafeReason,
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
        expect(getPathConfinementPermission("../secrets.txt", "/project", {})).toBe(Heuristic.UNSAFE);
        expect(getPathConfinementPermission(".env", "/project", {})).toBe(Heuristic.UNSAFE);
        expect(getPathConfinementPermission("src/app.pem", "/project", {})).toBe(Heuristic.UNSAFE);
    });

    it("classifies sensitive paths outside cwd as sensitive before outside traversal", () => {
        const assessment = getPathConfinementAssessment(
            path.join(os.homedir(), ".ssh", "id_ed25519"),
            "/project",
            {},
        );

        expect(assessment.reasons).toEqual([UnsafeReason.SENSITIVE_PATH]);
    });

    it("honors the cwd heuristic configuration", () => {
        expect(getPathConfinementPermission("file.txt", "/project", {
            permission: "allow",
        })).toBe(Heuristic.SAFE_READONLY);
        expect(getPathConfinementPermission("file.txt", "/project", {
            enabled: false,
        })).toBe(Heuristic.UNSAFE);
    });

    it("rejects symlink escapes and dangling symlinks", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-paths-"));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-outside-"));
        temporaryDirectories.push(cwd, outside);
        fs.symlinkSync(outside, path.join(cwd, "link"), "dir");
        fs.symlinkSync(path.join(outside, "missing"), path.join(cwd, "dangling"));

        expect(getPathConfinementPermission("link/file.txt", cwd, {})).toBe(Heuristic.UNSAFE);
        expect(getPathConfinementPermission("dangling", cwd, {})).toBe(Heuristic.UNSAFE);
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
