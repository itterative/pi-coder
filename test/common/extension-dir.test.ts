import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveExtensionDirectory } from "../../src/common/extension-dir";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function packageRoot(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-ext-root-"));

    temporaryDirectories.push(directory);
    fs.writeFileSync(path.join(directory, "package.json"), "{}\n");

    return directory;
}

describe("extension root resolution", () => {
    it("keeps the computed root when it is a package, even if an override points elsewhere", () => {
        const computed = packageRoot();
        const override = packageRoot();

        expect(resolveExtensionDirectory(computed, { PI_CODER_EXTENSION_DIR: override })).toBe(
            computed,
        );
    });

    it("uses the override when bundling made the computed root invalid", () => {
        const override = packageRoot();

        expect(
            resolveExtensionDirectory("/not-a-package", {
                PI_CODER_EXTENSION_DIR: override,
            }),
        ).toBe(override);
    });

    it("keeps the computed root when neither candidate is a package", () => {
        expect(
            resolveExtensionDirectory("/not-a-package", {
                PI_CODER_EXTENSION_DIR: "/also-not-a-package",
            }),
        ).toBe("/not-a-package");
    });
});
