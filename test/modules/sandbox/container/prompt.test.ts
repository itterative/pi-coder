import { describe, expect, it, vi } from "vitest";

import {
    askAboutSandboxImage,
    canPromptForSandboxImage,
} from "../../../../src/modules/sandbox/container/prompt";
import { select } from "../../../../src/tui/select";

/**
 * The prompt is the only place the container backend interrupts the user, so what it offers is worth pinning:
 * exactly two answers, with dismissal meaning "ask again after the recipe changes". A third "ask me later"
 * item would make Escape redundant and turn a one-time question into a menu.
 */

vi.mock("../../../../src/tui/select", () => ({ select: vi.fn() }));

const question = {
    image: "localhost/pi-coder-sandbox:abc123",
    recipePath: "/repo/.pi/Containerfile",
};

const ctx = { hasUI: true, mode: "tui" as const, ui: {} as never };

describe("sandbox image prompt", () => {
    it("is offered only where a dialog can render", () => {
        expect(canPromptForSandboxImage({ hasUI: true, mode: "tui" })).toBe(true);
        expect(canPromptForSandboxImage({ hasUI: false, mode: "print" })).toBe(false);
        expect(canPromptForSandboxImage({ hasUI: true, mode: "rpc" })).toBe(false);
    });

    it("offers a build and a remembered opt-out, nothing else", async () => {
        vi.mocked(select).mockResolvedValueOnce(undefined);

        await askAboutSandboxImage(question, ctx);

        const [options] = vi.mocked(select).mock.calls[0] ?? [];
        expect(options?.items.map((item) => item.value)).toEqual(["build", "bwrap"]);
    });

    it("passes a chosen answer through", async () => {
        vi.mocked(select).mockResolvedValueOnce("build");
        expect(await askAboutSandboxImage(question, ctx)).toBe("build");

        vi.mocked(select).mockResolvedValueOnce("bwrap");
        expect(await askAboutSandboxImage(question, ctx)).toBe("bwrap");
    });

    it("treats a dismissed dialog as 'ask again later' rather than as a decision", async () => {
        vi.mocked(select).mockResolvedValueOnce(undefined);
        expect(await askAboutSandboxImage(question, ctx)).toBe("later");
    });
});
