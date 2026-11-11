import { beforeEach, describe, expect, it } from "vitest";

import type { ContainerSession } from "../../../src/modules/sandbox/container/client";
import { ContainerSessionError } from "../../../src/modules/sandbox/container/client";
import registerCodeTool from "../../../src/tools/code";
import { clearCodeCache } from "../../../src/tools/code/load";
import { createPiStub, stubContext } from "../../helpers/pi-stub";

beforeEach(() => {
    clearCodeCache();
});

async function run(action: "digest" | "search", path: string) {
    const stub = createPiStub();

    registerCodeTool(stub.pi);

    const tool = stub.requireTool("outline");
    const result = await tool.execute(
        "call-1",
        { action, path, query: action === "search" ? "anything" : undefined },
        undefined,
        undefined,
        stubContext({ cwd: "/project" }),
    );

    return result.content[0]?.type === "text" ? result.content[0].text : "";
}

describe("outline on a path that does not exist", () => {
    it("answers in the tool's own words instead of a Node error", async () => {
        const text = await run("digest", "does/not/exist");

        expect(text).toContain("# no such path: does/not/exist");
        expect(text).not.toContain("ENOENT");
        expect(text).not.toContain("failed");
    });

    it("recognizes the container's shape, which carries the code in the message only", async () => {
        const session = {
            fs: async () => {
                throw new ContainerSessionError(
                    "stat /project/nope: ENOENT: no such file or directory, stat '/project/nope'",
                    "fs-failed",
                );
            },
        } as unknown as ContainerSession;
        const stub = createPiStub();

        registerCodeTool(stub.pi, { active: true, sessionFor: async () => session });

        const result = await stub
            .requireTool("outline")
            .execute(
                "call-1",
                { action: "digest", path: "nope" },
                undefined,
                undefined,
                stubContext({ cwd: "/project" }),
            );
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";

        expect(text).toContain("# no such path: nope");
        expect(text).not.toContain("failed");
    });

    it("does the same for search", async () => {
        const text = await run("search", "does/not/exist");

        expect(text).toContain("# no such path: does/not/exist");
        expect(text).not.toContain("ENOENT");
    });
});
