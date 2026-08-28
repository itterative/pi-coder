/** Return whether an unknown value is a standard abort error. */
export function isAbortError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) {
        return false;
    }
    if ("name" in error && error.name === "AbortError") {
        return true;
    }
    return "code" in error && error.code === "ABORT_ERR";
}
