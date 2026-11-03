import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    agentResourceRoots,
    clearAgentResourceRootsCache,
    resolveAgentResourceRoots,
    standardAgentResourceRoots,
} from "../../../src/modules/sandbox/resource-roots";

/**
 * The resource roots are how the sandbox gets the files the system prompt advertises: skill files, the scripts
 * they reference, and pi's own docs. The standard set is what can be derived without asking pi; the resolver
 * adds exact package roots for resources outside the managed stores.
 *
 * Every case injects temp directories. The default `getAgentDir()` and `getPackageDir()` values are real
 * installs, so an assertion against them would describe the machine rather than the rule.
 */
const tempDirs: string[] = [];

beforeEach(() => {
    clearAgentResourceRootsCache();
});

afterEach(() => {
    clearAgentResourceRootsCache();

    for (const directory of tempDirs.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function workspace(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resource-roots-"));
    tempDirs.push(directory);

    return directory;
}

function makeDirectory(candidate: string): string {
    fs.mkdirSync(candidate, { recursive: true });

    return candidate;
}

function makePackage(candidate: string): string {
    makeDirectory(candidate);
    fs.writeFileSync(path.join(candidate, "package.json"), JSON.stringify({ name: "package" }));

    return candidate;
}

function standardOptions(root: string) {
    const agentDir = makeDirectory(path.join(root, "agent"));
    const home = makeDirectory(path.join(root, "home"));
    const extensionDir = makePackage(path.join(root, "pi-coder"));
    const piPackageDir = makePackage(path.join(root, "pi-package"));

    return { agentDir, home, extensionDir, piPackageDir };
}

describe("standardAgentResourceRoots", () => {
    it("returns the managed package stores, user skill dirs, and both packages in a stable order", () => {
        const root = workspace();
        const { agentDir, home, extensionDir, piPackageDir } = standardOptions(root);
        const skills = makeDirectory(path.join(agentDir, "skills"));
        const git = makeDirectory(path.join(agentDir, "git"));
        const npm = makeDirectory(path.join(agentDir, "npm"));
        const temporary = makeDirectory(path.join(agentDir, "tmp", "extensions"));
        const agentsSkills = makeDirectory(path.join(home, ".agents", "skills"));

        expect(
            standardAgentResourceRoots({
                agentDir,
                env: { HOME: home },
                extensionDir,
                piPackageDir,
            }),
        ).toEqual([extensionDir, piPackageDir, skills, git, npm, temporary, agentsSkills]);
    });

    it("omits roots that do not exist instead of mounting a path podman would create", () => {
        const root = workspace();
        const { agentDir, home, extensionDir, piPackageDir } = standardOptions(root);
        makeDirectory(path.join(agentDir, "git"));

        expect(
            standardAgentResourceRoots({
                agentDir,
                env: { HOME: home },
                extensionDir,
                piPackageDir,
            }),
        ).toEqual([extensionDir, piPackageDir, path.join(agentDir, "git")]);
    });

    it("omits a path that is not an extension package root", () => {
        const root = workspace();
        const { agentDir, home, extensionDir } = standardOptions(root);
        const notAPackage = makeDirectory(path.join(root, "not-a-package"));

        expect(
            standardAgentResourceRoots({
                agentDir,
                env: { HOME: home },
                extensionDir: notAPackage,
                piPackageDir: extensionDir,
            }),
        ).toEqual([extensionDir]);
    });

    it("lets a caller omit the running pi package", () => {
        const root = workspace();
        const { agentDir, home, extensionDir } = standardOptions(root);

        expect(
            standardAgentResourceRoots({
                agentDir,
                env: { HOME: home },
                extensionDir,
                piPackageDir: null,
            }),
        ).toEqual([extensionDir]);
    });

    it("deduplicates a package directory that is also the extension root", () => {
        const root = workspace();
        const { agentDir, home, extensionDir } = standardOptions(root);

        expect(
            standardAgentResourceRoots({
                agentDir,
                env: { HOME: home },
                extensionDir,
                piPackageDir: extensionDir,
            }),
        ).toEqual([extensionDir]);
    });

    it("includes pi-coder's state root once it exists, because the prompt names files inside it", () => {
        const root = workspace();
        const { agentDir, home, extensionDir, piPackageDir } = standardOptions(root);
        const stateDir = makeDirectory(path.join(agentDir, "pi-coder"));

        expect(
            standardAgentResourceRoots({
                agentDir,
                env: { HOME: home },
                extensionDir,
                piPackageDir,
            }),
        ).toEqual([extensionDir, piPackageDir, stateDir]);
    });

    it("follows an explicit state root and lets a caller omit the state tree", () => {
        const root = workspace();
        const { agentDir, home, extensionDir } = standardOptions(root);
        makeDirectory(path.join(agentDir, "pi-coder"));
        const relocated = makeDirectory(path.join(root, "relocated-state"));
        const options = { agentDir, env: { HOME: home }, extensionDir, piPackageDir: null };

        expect(standardAgentResourceRoots({ ...options, stateDir: relocated })).toEqual([
            extensionDir,
            relocated,
        ]);
        expect(standardAgentResourceRoots({ ...options, stateDir: null })).toEqual([extensionDir]);
    });
});

describe("agentResourceRoots", () => {
    it("adds the package root of a locally installed skill outside the standard stores", async () => {
        const root = workspace();
        const { agentDir, home, extensionDir, piPackageDir } = standardOptions(root);
        const cwd = makeDirectory(path.join(root, "project"));
        const packageDir = makeDirectory(path.join(root, "local-skill-package"));
        const skillDir = makeDirectory(path.join(packageDir, "skills", "local-review"));

        fs.writeFileSync(
            path.join(packageDir, "package.json"),
            JSON.stringify({
                name: "local-skill-package",
                version: "1.0.0",
                pi: { skills: ["./skills"] },
            }),
        );
        fs.writeFileSync(
            path.join(skillDir, "SKILL.md"),
            "---\nname: local-review\ndescription: A local skill\n---\n\n# Local review\n",
        );
        fs.writeFileSync(
            path.join(agentDir, "settings.json"),
            JSON.stringify({ packages: [packageDir] }),
        );

        const roots = await resolveAgentResourceRoots({
            cwd,
            agentDir,
            env: { HOME: home },
            extensionDir,
            piPackageDir,
        });

        expect(roots).toContain(packageDir);
    });

    it("returns the standard roots when the package manager cannot resolve", async () => {
        const root = workspace();
        const { agentDir, home, extensionDir, piPackageDir } = standardOptions(root);
        const cwd = makeDirectory(path.join(root, "project"));

        // A settings file that is not valid JSON is the cheapest resolver failure: the session must still get
        // the standard roots rather than lose every skill mount.
        fs.writeFileSync(path.join(agentDir, "settings.json"), "{ not json");

        const roots = await resolveAgentResourceRoots({
            cwd,
            agentDir,
            env: { HOME: home },
            extensionDir,
            piPackageDir,
        });

        expect(roots).toEqual(
            standardAgentResourceRoots({
                agentDir,
                env: { HOME: home },
                extensionDir,
                piPackageDir,
            }),
        );
    });

    it("memoizes the resolution for a cwd and agent dir", async () => {
        const root = workspace();
        const { agentDir, home, extensionDir, piPackageDir } = standardOptions(root);
        const cwd = makeDirectory(path.join(root, "project"));

        const first = await agentResourceRoots({
            cwd,
            agentDir,
            env: { HOME: home },
            extensionDir,
            piPackageDir,
        });
        const second = await agentResourceRoots({
            cwd,
            agentDir,
            env: { HOME: home },
            extensionDir,
            piPackageDir,
        });

        expect(second).toBe(first);
    });
});
