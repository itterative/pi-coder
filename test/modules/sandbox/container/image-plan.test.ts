import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { planSandboxImage } from "../../../../src/modules/sandbox/container/image-plan";
import { RECIPE_RELATIVE_PATH } from "../../../../src/modules/sandbox/container/recipe";

const dirs: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-"));
    dirs.push(dir);

    return dir;
}

function writeRecipe(root: string, text: string): void {
    const target = path.join(root, RECIPE_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, "utf8");
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

const NO_RECIPE_HOME = () => tempDir();

describe("planSandboxImage", () => {
    it("uses the default image when there is no recipe, so an existing checkout is untouched", () => {
        const plan = planSandboxImage({
            projectDir: tempDir(),
            homeDir: NO_RECIPE_HOME(),
            stateDir: "/state",
            env: {},
        });

        expect(plan).toEqual({ kind: "default", image: "node:24-trixie-slim", nodePath: "node" });
    });

    it("lets an explicit image win over a recipe, as the escape hatch", () => {
        const project = tempDir();
        writeRecipe(project, "FROM debian:bookworm-slim\n");

        const plan = planSandboxImage({
            projectDir: project,
            homeDir: NO_RECIPE_HOME(),
            stateDir: "/state",
            env: { PI_SANDBOX_IMAGE: "custom:1" },
        });

        expect(plan.kind).toBe("explicit");
        expect(plan).toMatchObject({ image: "custom:1", nodePath: "node" });
    });

    it("derives the tag from the recipe content and the base image", () => {
        const project = tempDir();
        writeRecipe(project, "FROM debian:bookworm-slim\n");

        const plan = planSandboxImage({
            projectDir: project,
            homeDir: NO_RECIPE_HOME(),
            stateDir: "/state",
            env: {},
        });

        expect(plan.kind).toBe("recipe");

        if (plan.kind !== "recipe") {
            return;
        }

        expect(plan.image).toMatch(/^localhost\/pi-coder-sandbox:[0-9a-f]{12}$/);
        expect(plan.nodePath).toBe("/opt/pi/node");
        expect(plan.containerfilePath).toBe("/state/container/Containerfile");
        expect(plan.contextDir).toBe(path.join(project, path.dirname(RECIPE_RELATIVE_PATH)));
        expect(plan.effectiveText).toContain("FROM debian:bookworm-slim");
        expect(plan.effectiveText).toContain("COPY --from=pi-dispatcher-node");
    });

    it("changes the tag when the recipe changes", () => {
        const project = tempDir();
        writeRecipe(project, "FROM debian:bookworm-slim\n");

        const first = planSandboxImage({
            projectDir: project,
            homeDir: NO_RECIPE_HOME(),
            stateDir: "/s",
            env: {},
        });

        writeRecipe(project, "FROM debian:bookworm-slim\nRUN apt-get install -y git\n");

        const second = planSandboxImage({
            projectDir: project,
            homeDir: NO_RECIPE_HOME(),
            stateDir: "/s",
            env: {},
        });

        expect(first.kind).toBe("recipe");
        expect(second.kind).toBe("recipe");

        if (first.kind !== "recipe" || second.kind !== "recipe") {
            return;
        }

        expect(first.hash).not.toBe(second.hash);
    });

    it("honours PI_SANDBOX_BASE_IMAGE as the runtime source", () => {
        const project = tempDir();
        writeRecipe(project, "FROM debian:bookworm-slim\n");

        const plan = planSandboxImage({
            projectDir: project,
            homeDir: NO_RECIPE_HOME(),
            stateDir: "/s",
            env: { PI_SANDBOX_BASE_IMAGE: "node:20-bookworm-slim" },
        });

        expect(plan.kind).toBe("recipe");

        if (plan.kind === "recipe") {
            expect(plan.effectiveText).toContain(
                "FROM node:20-bookworm-slim AS pi-dispatcher-node",
            );
        }
    });

    it("refuses a musl base before podman is ever invoked", () => {
        const project = tempDir();
        writeRecipe(project, "FROM alpine:3.20\n");

        const plan = planSandboxImage({
            projectDir: project,
            homeDir: NO_RECIPE_HOME(),
            stateDir: "/s",
            env: {},
        });

        expect(plan.kind).toBe("unsupported");

        if (plan.kind === "unsupported") {
            expect(plan.reason).toContain("musl");
            expect(plan.reason).toContain(RECIPE_RELATIVE_PATH);
        }
    });
});
