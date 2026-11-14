import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PI_CODER_EXTENSION_DIR } from "../../../src/common/constants";
import { TRUSTED_SKILLS, trustedSkillForScript } from "../../../src/modules/decision";

const SCRIPT_EXTENSIONS = new Set([
    ".py",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".mts",
    ".cts",
    ".tsx",
    ".jsx",
    ".sh",
    ".bash",
    ".zsh",
    ".rb",
    ".pl",
    ".php",
    ".lua",
]);

describe("trusted skill scripts", () => {
    it("names a bundled pi-coder skill", () => {
        expect(TRUSTED_SKILLS).toContain("session-review");
    });

    it("matches a script below skills/<name>/", () => {
        expect(
            trustedSkillForScript(
                "/home/sd/Repos/pi-coder/skills/session-review/scripts/session-transcript.mts",
            ),
        ).toBe("session-review");
    });

    it("matches a package line under the trusted skill", () => {
        expect(
            trustedSkillForScript("/installed/pi-coder/skills/session-review/package.json"),
        ).toBe("session-review");
    });

    it("ignores a directory that only shares the skill's name", () => {
        expect(trustedSkillForScript("/repo/session-review/scripts/deploy.mts")).toBeUndefined();
    });

    it("ignores untrusted and missing paths", () => {
        expect(trustedSkillForScript("/repo/skills/other/scripts/deploy.mts")).toBeUndefined();
        expect(trustedSkillForScript("/repo/scripts/deploy.mts")).toBeUndefined();
        expect(trustedSkillForScript(undefined)).toBeUndefined();
    });

    it("resolves a relative path before matching", () => {
        expect(trustedSkillForScript("skills/session-review/scripts/session-transcript.mts")).toBe(
            "session-review",
        );
    });
});

describe("bundled pi-coder skills", () => {
    it("have every script in the trusted list", () => {
        const skillsRoot = path.join(PI_CODER_EXTENSION_DIR, "skills");
        const scripts = fs
            .readdirSync(skillsRoot, { recursive: true, encoding: "utf8" })
            .map((entry) => path.join(skillsRoot, entry))
            .filter(
                (file) => SCRIPT_EXTENSIONS.has(path.extname(file)) && fs.statSync(file).isFile(),
            );
        const untrusted = scripts.filter((file) => trustedSkillForScript(file) === undefined);

        expect(
            untrusted,
            "add the skill name to TRUSTED_SKILLS in src/modules/decision/trusted-scripts.ts",
        ).toEqual([]);
    });
});
