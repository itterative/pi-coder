import { describe, expect, it } from "vitest";

import { isAbortError } from "../../src/common/abort";

describe("abort helpers", () => {
    it("uses the platform abort error from AbortSignal", () => {
        const controller = new AbortController();
        controller.abort();

        let error: unknown;
        try {
            controller.signal.throwIfAborted();
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(DOMException);
        expect(error).toMatchObject({ name: "AbortError" });
        expect(isAbortError(error)).toBe(true);
    });

    it("recognizes only abort errors", () => {
        expect(isAbortError(new Error("not aborted"))).toBe(false);
    });
});
