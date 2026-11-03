import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    applyDevEnvFile,
    applyDevEnvFromExtension,
    devEnvFilePath,
    parseEnvFile,
} from "../../src/common/dev-env";
import { PI_CODER_EXTENSION_DIR } from "../../src/common/extension-dir";

/**
 * A checkout's `.env` is how a development copy pins its own state root, logs, or config without changing what
 * an installed copy does. Everything here runs against temporary files and an explicit env object: the loader
 * mutates whatever environment it is handed, and a suite must never touch the developer's real `.env` or
 * `process.env`. `test/setup.ts` disables the extension-level lookup for exactly that reason.
 */
const tempDirs: string[] = [];

afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function envFile(contents: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dev-env-"));
    tempDirs.push(directory);

    const file = path.join(directory, ".env");
    fs.writeFileSync(file, contents, "utf-8");

    return file;
}

describe("parseEnvFile", () => {
    it("reads the parts a hand-written development file uses", () => {
        const values = parseEnvFile(
            [
                "# a comment",
                "",
                "PLAIN=value",
                "export EXPORTED = spaced ",
                'DOUBLE="two words"',
                "SINGLE='single quoted'",
                "TRAILING=value # note",
                "FRAGMENT=path#not-a-comment",
                "NO_EQUALS",
                "=missing-key",
                "1BAD=identifier",
                "DUPLICATE=first",
                "DUPLICATE=second",
            ].join("\n"),
        );

        expect(values).toEqual({
            PLAIN: "value",
            EXPORTED: "spaced",
            DOUBLE: "two words",
            SINGLE: "single quoted",
            TRAILING: "value",
            FRAGMENT: "path#not-a-comment",
            DUPLICATE: "second",
        });
    });
});

describe("applyDevEnvFile", () => {
    it("applies only pi-coder's own prefixes", () => {
        const env: NodeJS.ProcessEnv = { PATH: "/bin" };
        const file = envFile(
            [
                "PI_CODER_STATE_DIR=.state",
                "PI_SANDBOX_BACKEND=bwrap",
                "PI_MEMORY_SESSION_CACHE=false",
                "SANDBOX_DECISION_LOG=0",
                "COMPACTION_TRACE=0",
                "DECISION_MODEL_CONFIG_PATH=/tmp/cfg.json",
                "AGENT_CONFIG_PATH=/tmp/agents.json",
                "HOME=/elsewhere",
                "PATH=/other",
                "PI_TELEMETRY=off",
                "PI_CODING_AGENT_DIR=/tmp/agent",
            ].join("\n"),
        );

        expect(applyDevEnvFile(env, file)).toEqual([
            "PI_CODER_STATE_DIR",
            "PI_SANDBOX_BACKEND",
            "PI_MEMORY_SESSION_CACHE",
            "SANDBOX_DECISION_LOG",
            "COMPACTION_TRACE",
            "DECISION_MODEL_CONFIG_PATH",
            "AGENT_CONFIG_PATH",
        ]);
        expect(env.PI_CODER_STATE_DIR).toBe(path.join(PI_CODER_EXTENSION_DIR, ".state"));
        expect(env.SANDBOX_DECISION_LOG).toBe("0");
        expect(env.HOME).toBeUndefined();
        expect(env.PATH).toBe("/bin");
        expect(env.PI_TELEMETRY).toBeUndefined();
        expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
    });

    it("lets an explicitly set variable win, and treats a blank one as unset", () => {
        const env: NodeJS.ProcessEnv = {
            PI_CODER_STATE_DIR: "/from/launch",
            COMPACTION_TRACE_PATH: "   ",
        };
        const file = envFile("PI_CODER_STATE_DIR=.state\nCOMPACTION_TRACE_PATH=.state/trace.jsonl");

        expect(applyDevEnvFile(env, file)).toEqual(["COMPACTION_TRACE_PATH"]);
        expect(env.PI_CODER_STATE_DIR).toBe("/from/launch");
        expect(env.COMPACTION_TRACE_PATH).toBe(".state/trace.jsonl");
    });

    it("ignores a missing file instead of failing the run", () => {
        const env: NodeJS.ProcessEnv = {};
        const missing = path.join(os.tmpdir(), "pi-dev-env-does-not-exist", ".env");

        expect(applyDevEnvFile(env, missing)).toEqual([]);
        expect(env).toEqual({});
    });
});

describe("devEnvFilePath", () => {
    it("defaults to the extension checkout's .env", () => {
        expect(devEnvFilePath({})).toBe(path.join(PI_CODER_EXTENSION_DIR, ".env"));
        expect(devEnvFilePath({ PI_CODER_ENV_FILE: "  " })).toBe(
            path.join(PI_CODER_EXTENSION_DIR, ".env"),
        );
    });

    it("is disabled by the usual off values and accepts an alternate file", () => {
        for (const value of ["0", "false", "no", "off", "OFF"]) {
            expect(devEnvFilePath({ PI_CODER_ENV_FILE: value })).toBeUndefined();
        }

        expect(devEnvFilePath({ PI_CODER_ENV_FILE: "/tmp/alternative.env" })).toBe(
            "/tmp/alternative.env",
        );
    });
});

describe("applyDevEnvFromExtension", () => {
    it("reads the file the environment names", () => {
        const file = envFile("PI_CODER_STATE_DIR=.state");
        const env: NodeJS.ProcessEnv = { PI_CODER_ENV_FILE: file };

        expect(applyDevEnvFromExtension(env)).toEqual(["PI_CODER_STATE_DIR"]);
        expect(env.PI_CODER_STATE_DIR).toBe(path.join(PI_CODER_EXTENSION_DIR, ".state"));
    });

    it("does nothing when the switch is off", () => {
        const env: NodeJS.ProcessEnv = { PI_CODER_ENV_FILE: "0" };

        expect(applyDevEnvFromExtension(env)).toEqual([]);
        expect(env).toEqual({ PI_CODER_ENV_FILE: "0" });
    });
});
