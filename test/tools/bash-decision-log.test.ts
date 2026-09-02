import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import registerBashToolHook from "../../src/tools/bash/index";
import type { BashDecisionRecord } from "../../src/modules/sandbox/decision-log";
import {
    createPiStub,
    handlerView,
    stubContext,
    stubSessionManager,
    stubUi,
} from "../helpers/pi-stub";

/**
 * The parent bash gate must leave exactly one durable record per command, with
 * enough structure to mine later: what the resolver decided, whether a human was
 * asked, and what was finally applied.
 */

const temporaryDirectories: string[] = [];
let workspace: string;
let logPath: string;

function readRecords(): BashDecisionRecord[] {
    if (!fs.existsSync(logPath)) {
        return [];
    }

    return fs
        .readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as BashDecisionRecord);
}

async function runHookCommand(
    command: string,
    ui = stubUi(),
): Promise<{ block: boolean; reason?: string; records: BashDecisionRecord[] }> {
    const stub = createPiStub();
    registerBashToolHook(stub.pi);
    const handlers = handlerView(stub, "session_start", "tool_call");
    const ctx = stubContext({
        cwd: workspace,
        hasUI: false,
        ui,
        sessionManager: stubSessionManager(),
    });

    await handlers.session_start[0]({}, ctx);
    const result = (await handlers.tool_call[0](
        { toolCallId: "call-1", toolName: "bash", input: { command } },
        ctx,
    )) as { block?: boolean; reason?: string };

    return { block: result.block === true, reason: result.reason, records: readRecords() };
}

beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-decision-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-decision-home-"));
    temporaryDirectories.push(workspace, home);
    logPath = path.join(home, "decisions.jsonl");
    // The suite default disables logging; this file re-enables it at a temporary path.
    vi.stubEnv("SANDBOX_DECISION_LOG", "1");
    fs.mkdirSync(path.join(workspace, ".pi"), { recursive: true });
    fs.writeFileSync(
        path.join(workspace, ".pi", "bash-sandbox-config.json"),
        JSON.stringify({
            sandbox: { enabled: true },
            permissions: { "echo *": "allow" },
            decisionLog: { enabled: true, path: logPath },
        }),
    );
    fs.writeFileSync(path.join(workspace, "README.md"), "# fixture\n");
});

afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("bash permission decision log", () => {
    it("records an automatic heuristic grant without a prompt", async () => {
        const { records } = await runHookCommand("cat README.md");

        expect(records).toHaveLength(1);
        const [record] = records;
        expect(record?.surface).toBe("parent");
        expect(record?.command).toBe("cat README.md");
        expect(record?.cwd).toBe(workspace);
        expect(record?.prompt).toBeUndefined();
        expect(record?.resolution.source).toBe("heuristic");
        expect(record?.resolution.permission).toBe("allow:sandbox");
        expect(record?.resolution.segments).toEqual([
            {
                tokens: ["cat", "README.md"],
                source: "heuristic",
                permission: "allow:sandbox",
                pattern: null,
                coveredBy: null,
            },
        ]);
        expect(record?.decision).toBe("allow:sandbox");
    });

    it("records a configured rule match", async () => {
        const { block, records } = await runHookCommand("echo hello");

        expect(block).toBe(false);
        expect(records).toHaveLength(1);
        expect(records[0]?.resolution).toMatchObject({ source: "policy", pattern: "echo *" });
        expect(records[0]?.decision).toBe("allow");
        expect(records[0]?.sandboxed).toBe(false);
        expect(records[0]?.blocked).toBe(false);
    });

    it("records a dismissal as a denial with the uncovered segment", async () => {
        const { block, reason, records } = await runHookCommand("kindly-untagged-tool --now");

        expect(block).toBe(true);
        expect(reason).toContain("blocked by user");
        expect(records).toHaveLength(1);

        const [record] = records;
        expect(record?.resolution.source).toBe("unresolved");
        expect(record?.resolution.segments[0]?.tokens).toEqual(["kindly-untagged-tool", "--now"]);
        expect(record?.prompt).toEqual({ outcome: "dismissed" });
        expect(record?.decision).toBe("deny");
        expect(record?.blocked).toBe(true);
    });

    it("keeps one record per command across calls", async () => {
        await runHookCommand("echo one");
        await runHookCommand("echo two");

        expect(readRecords().map((record) => record.command)).toEqual(["echo one", "echo two"]);
    });
});
