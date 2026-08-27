import { describe, expect, it } from "vitest";

import { isAbortError, throwIfAborted } from "../../src/common/abort";

describe("abort helpers", () => {
    it("uses the platform abort error from AbortSignal", () => {
        const controller = new AbortController();
        controller.abort();

        let error: unknown;
        try {
            throwIfAborted(controller.signal);
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(DOMException);
        expect(error).toMatchObject({ name: "AbortError" });
        expect(isAbortError(error)).toBe(true);
    });

    it("does not throw for an active or missing signal", () => {
        expect(() => throwIfAborted(undefined)).not.toThrow();
        expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
        expect(isAbortError(new Error("not aborted"))).toBe(false);
    });
});
