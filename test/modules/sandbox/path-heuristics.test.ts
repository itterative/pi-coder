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

    it("treats an additional managed root like cwd", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-paths-cwd-"));
        const scratchpad = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-paths-scratchpad-"));
        temporaryDirectories.push(cwd, scratchpad);

        const filePath = path.join(scratchpad, "notes.txt");
        expect(getPathConfinementPermission(filePath, cwd, {}, "read", [scratchpad]))
            .toBe(Heuristic.SAFE_READONLY);
        expect(getPathConfinementPermission(filePath, cwd, {}, "write", [scratchpad]))
            .toBe(Heuristic.SAFE_EDIT);
        expect(getPathConfinementPermission(path.join(scratchpad, ".env"), cwd, {}, "read", [scratchpad]))
            .toBe(Heuristic.SAFE_READONLY);
        expect(getPathConfinementPermission(path.join(scratchpad, "..", "outside.txt"), cwd, {}, "read", [scratchpad]))
            .toBe(Heuristic.UNSAFE);
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

    it("does not let a scratchpad symlink expose a sensitive project path", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-paths-cwd-"));
        const scratchpad = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-paths-scratchpad-"));
        const secret = path.join(cwd, ".env");
        const ordinary = path.join(cwd, "ordinary.txt");
        temporaryDirectories.push(cwd, scratchpad);
        fs.writeFileSync(secret, "secret");
        fs.writeFileSync(ordinary, "ordinary");
        fs.symlinkSync(secret, path.join(scratchpad, "secret-link"));
        fs.symlinkSync(ordinary, path.join(scratchpad, "ordinary-link"));

        expect(getPathConfinementPermission(
            path.join(scratchpad, "secret-link"),
            cwd,
            {},
            "read",
            [scratchpad],
        )).toBe(Heuristic.UNSAFE);
        expect(getPathConfinementPermission(
            path.join(scratchpad, "ordinary-link"),
            cwd,
            {},
            "read",
            [scratchpad],
        )).toBe(Heuristic.UNSAFE);
    });

    it("resolves symlinks before following parent components", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-paths-cwd-"));
        const scratchpad = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-paths-scratchpad-"));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-paths-outside-"));
        const target = path.join(outside, "target");
        temporaryDirectories.push(cwd, scratchpad, outside);
        fs.mkdirSync(target);
        fs.symlinkSync(target, path.join(scratchpad, "link"), "dir");

        expect(getPathConfinementPermission(
            `${scratchpad}/link/../owned.txt`,
            cwd,
            {},
            "write",
            [scratchpad],
        )).toBe(Heuristic.UNSAFE);
    });

    it("does not let one additional root authorize another", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-paths-cwd-"));
        const first = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-paths-first-"));
        const second = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-paths-second-"));
        temporaryDirectories.push(cwd, first, second);
        fs.symlinkSync(second, path.join(first, "link"), "dir");

        expect(getPathConfinementPermission(
            path.join(first, "link", "owned.txt"),
            cwd,
            {},
            "write",
            [first, second],
        )).toBe(Heuristic.UNSAFE);
    });

    it("uses the most-specific nested additional root", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-paths-cwd-"));
        const outer = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-paths-outer-"));
        const nested = path.join(outer, "nested");
        const sibling = path.join(outer, "sibling");
        temporaryDirectories.push(cwd, outer);
        fs.mkdirSync(nested);
        fs.mkdirSync(sibling);
        fs.symlinkSync(sibling, path.join(nested, "link"), "dir");

        expect(getPathConfinementPermission(
            path.join(nested, "link", "owned.txt"),
            cwd,
            {},
            "write",
            [outer, nested],
        )).toBe(Heuristic.UNSAFE);
    });

    it("rejects additional-root inputs containing parent components", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-paths-cwd-"));
        const container = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-paths-container-"));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-paths-outside-"));
        const target = path.join(outside, "target");
        temporaryDirectories.push(cwd, container, outside);
        fs.mkdirSync(target);
        fs.symlinkSync(target, path.join(container, "link"), "dir");

        for (const config of [{}, { resolveSymlinks: false }]) {
            expect(getPathConfinementPermission(
                path.join(container, "owned.txt"),
                cwd,
                config,
                "write",
                [`${container}/link/..`],
            )).toBe(Heuristic.UNSAFE);
        }
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
