import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    RECIPE_NODE_PATH,
    RECIPE_RELATIVE_PATH,
    effectiveContainerfile,
    findRecipe,
    findUnsupportedBase,
    recipeHash,
    sandboxImageTag,
    type SandboxRecipe,
} from "../../../../src/modules/sandbox/container/recipe";

const dirs: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-recipe-"));
    dirs.push(dir);

    return dir;
}

function writeRecipe(root: string, text: string): string {
    const target = path.join(root, RECIPE_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, "utf8");

    return target;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe("findRecipe", () => {
    it("prefers the project recipe over the global one", () => {
        const project = tempDir();
        const home = tempDir();
        writeRecipe(project, "FROM debian:bookworm-slim\n");
        writeRecipe(home, "FROM ubuntu:24.04\n");

        const recipe = findRecipe(project, home);

        expect(recipe?.source).toBe("project");
        expect(recipe?.text).toBe("FROM debian:bookworm-slim\n");
        expect(recipe?.contextDir).toBe(path.join(project, path.dirname(RECIPE_RELATIVE_PATH)));
    });

    it("falls back to the global recipe", () => {
        const project = tempDir();
        const home = tempDir();
        writeRecipe(home, "FROM ubuntu:24.04\n");

        expect(findRecipe(project, home)?.source).toBe("global");
    });

    it("returns undefined when neither exists, so the default image keeps working", () => {
        expect(findRecipe(tempDir(), tempDir())).toBeUndefined();
    });

    it("normalizes a missing trailing newline so an editor cannot change the hash", () => {
        const project = tempDir();
        writeRecipe(project, "FROM debian:bookworm-slim");

        expect(findRecipe(project, tempDir())?.text).toBe("FROM debian:bookworm-slim\n");
    });
});

describe("effectiveContainerfile", () => {
    const recipe: SandboxRecipe = {
        path: "/project/.pi/Containerfile",
        contextDir: "/project/.pi",
        text: "FROM debian:bookworm-slim\nRUN apt-get update && apt-get install -y git\n",
        source: "project",
    };

    const text = effectiveContainerfile(recipe, "node:24-trixie-slim");
    const lines = text.split("\n");

    it("starts with the stage the runtime is copied from", () => {
        expect(lines[2]).toBe("FROM node:24-trixie-slim AS pi-dispatcher-node");
    });

    it("keeps the recipe verbatim between the prologue and the injection", () => {
        expect(text).toContain(
            "FROM debian:bookworm-slim\nRUN apt-get update && apt-get install -y git",
        );
    });

    it("injects the runtime after the recipe, so the recipe cannot remove it", () => {
        const copy = lines.findIndex((line) => line.startsWith("COPY --from=pi-dispatcher-node"));
        const lastRecipeLine = lines.findIndex((line) => line.includes("apt-get install -y git"));

        expect(copy).toBeGreaterThan(lastRecipeLine);
        expect(lines[copy]).toBe(
            `COPY --from=pi-dispatcher-node /usr/local/bin/node ${RECIPE_NODE_PATH}`,
        );
    });

    it("verifies the runtime at build time, so a musl base fails the build instead of the session", () => {
        expect(lines).toContain(`RUN ${RECIPE_NODE_PATH} --version`);
    });

    it("registers the runtime as `node` when the base has none, so skills can call it", () => {
        const register = lines.findIndex((line) => line.startsWith("RUN if ! command -v node"));

        expect(register).toBeGreaterThan(-1);
        expect(text).toContain(
            `update-alternatives --install /usr/local/bin/node node ${RECIPE_NODE_PATH}`,
        );
        expect(text).toContain(`alternatives --install /usr/local/bin/node node`);
        expect(text).toContain(`ln -sf ${RECIPE_NODE_PATH} /usr/local/bin/node`);
    });

    it("registers `node` only after the runtime it links to was verified", () => {
        const verify = lines.indexOf(`RUN ${RECIPE_NODE_PATH} --version`);
        const register = lines.findIndex((line) => line.startsWith("RUN if ! command -v node"));

        expect(register).toBeGreaterThan(verify);
    });
});

describe("findUnsupportedBase", () => {
    it("rejects a musl base with an explanation rather than podman's error", () => {
        const reason = findUnsupportedBase("FROM alpine:3.20\n");

        expect(reason).toContain("glibc");
        expect(reason).toContain("alpine:3.20");
    });

    it("accepts glibc bases", () => {
        expect(
            findUnsupportedBase("FROM debian:bookworm-slim\nFROM node:22-bookworm AS build\n"),
        ).toBeUndefined();
    });

    it("ignores a comment that mentions alpine", () => {
        expect(
            findUnsupportedBase(
                "# unlike alpine, this base has glibc\nFROM debian:bookworm-slim\n",
            ),
        ).toBeUndefined();
    });
});

describe("recipeHash", () => {
    it("is stable for the same text and base", () => {
        expect(recipeHash("text", "base")).toBe(recipeHash("text", "base"));
    });

    it("changes when the recipe changes", () => {
        expect(recipeHash("text", "base")).not.toBe(recipeHash("text ", "base"));
    });

    it("changes when the base image changes, because the runtime differs", () => {
        expect(recipeHash("text", "base")).not.toBe(recipeHash("text", "other"));
    });

    it("is short enough to read in podman images", () => {
        expect(recipeHash("text", "base")).toMatch(/^[0-9a-f]{12}$/);
    });
});

describe("sandboxImageTag", () => {
    it("qualifies the name so podman never resolves it against a registry", () => {
        expect(sandboxImageTag("abc123")).toBe("localhost/pi-coder-sandbox:abc123");
    });
});
