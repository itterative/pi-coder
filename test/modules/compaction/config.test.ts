import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    DEFAULT_COMPACTION_CONFIG,
    loadCompactionConfig,
} from "../../../src/modules/compaction/config";

/**
 * A field is only configurable once `readConfigFile()` names it, and the failure is silent: the loader falls back
 * to the default, so the setting looks ignored rather than missing. That has already dropped knobs in this module,
 * which is why every retention and retry field gets pinned here as it is added.
 */
describe("compaction config resolution", () => {
    let root = "";
    let project = "";
    let global = "";

    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), "pi-coder-compaction-config-"));
        project = path.join(root, "project.json");
        global = path.join(root, "global.json");
        vi.stubEnv("COMPACTION_CONFIG_PATH", project);
        vi.stubEnv("COMPACTION_CONFIG_PATH_GLOBAL", global);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
    });

    function write(file: string, values: Record<string, unknown>): void {
        writeFileSync(file, JSON.stringify(values));
    }

    it("reads the trace retention knobs from the file", () => {
        write(project, { traceGenerations: 3, chainTraceEnabled: false, traceMaxBytes: 4096 });

        const config = loadCompactionConfig(root);
        expect(config.traceGenerations).toBe(3);
        expect(config.chainTraceEnabled).toBe(false);
        expect(config.traceMaxBytes).toBe(4096);
    });

    it("keeps zero as zero instead of falling back to the default", () => {
        // `positiveNumberField` treats 0 as absent, which is right for some knobs and wrong for a retention
        // budget where 0 means "keep nothing but the live file".
        write(project, { traceGenerations: 0 });

        expect(loadCompactionConfig(root).traceGenerations).toBe(0);
    });

    it("applies defaults when the file says nothing", () => {
        write(project, {});

        const config = loadCompactionConfig(root);
        expect(config.traceGenerations).toBe(DEFAULT_COMPACTION_CONFIG.traceGenerations);
        expect(config.chainTraceEnabled).toBe(DEFAULT_COMPACTION_CONFIG.chainTraceEnabled);
    });

    it("lets the project file win over the global one, field by field", () => {
        write(global, { traceGenerations: 2, chainTraceEnabled: false });
        write(project, { traceGenerations: 9 });

        const config = loadCompactionConfig(root);
        expect(config.traceGenerations).toBe(9);
        expect(config.chainTraceEnabled).toBe(false);
    });

    it("ignores a malformed file rather than failing compaction", () => {
        writeFileSync(project, "{ not json");

        expect(loadCompactionConfig(root).traceGenerations).toBe(
            DEFAULT_COMPACTION_CONFIG.traceGenerations,
        );
    });
});
