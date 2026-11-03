import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
    stubContext,
    stubSessionManager,
    stubUi,
    type SessionManagerLike,
} from "../../helpers/pi-stub";

import registerScratchpadExtension, {
    getScratchpadPath,
    SCRATCHPAD_MARKER_TYPE,
} from "../../../src/modules/scratchpad";
import {
    DEFAULT_SCRATCHPAD_POLICY,
    pruneScratchpads,
    SCRATCHPAD_PREFIX,
    type ScratchpadPolicy,
} from "../../../src/modules/scratchpad/policy";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function temporaryRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scratchpad-store-"));
    temporaryDirectories.push(root);
    return root;
}

function testPolicy(overrides: Partial<ScratchpadPolicy> = {}): ScratchpadPolicy {
    return { ...DEFAULT_SCRATCHPAD_POLICY, measureIntervalMs: 0, ...overrides };
}

function scratchpadDirectory(root: string): string {
    return fs.mkdtempSync(path.join(root, SCRATCHPAD_PREFIX));
}

function writePayload(directory: string, bytes: number, ageMs = 0): void {
    fs.writeFileSync(path.join(directory, "payload.bin"), Buffer.alloc(bytes));
    const stamp = new Date(Date.now() - ageMs);
    fs.utimesSync(directory, stamp, stamp);
}

function harness(entries: unknown[] = []): {
    pi: ExtensionAPI;
    handler(name: string): Handler;
} {
    const handlers = new Map<string, Handler>();
    const pi = {
        on(name: string, callback: Handler) {
            handlers.set(name, callback);
        },
        appendEntry(customType: string, data: unknown) {
            entries.push({ type: "custom", customType, data });
        },
    } as unknown as ExtensionAPI;

    return {
        pi,
        handler(name) {
            const callback = handlers.get(name);
            if (!callback) throw new Error(`Missing handler: ${name}`);
            return callback;
        },
    };
}

function context(sessionManager: object, ui = stubUi()): ExtensionContext {
    return stubContext({
        cwd: process.cwd(),
        ui,
        sessionManager: stubSessionManager(sessionManager as Partial<SessionManagerLike>),
    });
}

describe("temporary scratchpad extension", () => {
    it("creates a private directory in the durable store and explains its lifetime", async () => {
        const root = temporaryRoot();
        const { pi, handler } = harness();
        const sessionManager = stubSessionManager();
        const runtimeContext = context(sessionManager);
        registerScratchpadExtension(pi, { root, policy: testPolicy() });

        await handler("session_start")({ reason: "startup" }, runtimeContext);

        const scratchpadPath = getScratchpadPath(sessionManager);
        expect(scratchpadPath).toBeDefined();
        expect(path.dirname(scratchpadPath!)).toBe(root);
        expect(path.basename(scratchpadPath!)).toMatch(new RegExp(`^${SCRATCHPAD_PREFIX}`));
        expect(fs.statSync(scratchpadPath!).mode & 0o777).toBe(0o700);

        const result = handler("before_agent_start")(
            {
                systemPrompt: "<project_context>\nProject\n</project_context>",
            },
            runtimeContext,
        ) as { systemPrompt: string };
        expect(result.systemPrompt).toContain("<scratchpad_system>");
        expect(result.systemPrompt).toContain(scratchpadPath!);
        expect(result.systemPrompt).toContain("idle for 7 days");
        expect(result.systemPrompt).toContain("256 MB");
    });

    it("reuses a marked directory when the runtime registry is recreated", async () => {
        const root = temporaryRoot();
        const entries: unknown[] = [];
        const sessionManager = {
            getBranch: () => entries as SessionEntry[],
        };
        const first = harness(entries);
        const runtimeContext = context(sessionManager);
        registerScratchpadExtension(first.pi, { root, policy: testPolicy() });
        await first.handler("session_start")({}, runtimeContext);
        const scratchpadPath = getScratchpadPath(sessionManager)!;
        await first.handler("session_shutdown")({}, runtimeContext);

        const second = harness(entries);
        registerScratchpadExtension(second.pi, { root, policy: testPolicy() });
        await second.handler("session_start")({}, runtimeContext);

        expect(getScratchpadPath(sessionManager)).toBe(scratchpadPath);
        expect(entries).toEqual([
            {
                type: "custom",
                customType: SCRATCHPAD_MARKER_TYPE,
                data: { version: 1, path: scratchpadPath },
            },
        ]);
    });

    it("keeps parent and child runtime scratchpads isolated", async () => {
        const root = temporaryRoot();
        const { pi, handler } = harness();
        const parentManager = {};
        const childManager = {};
        registerScratchpadExtension(pi, { root, policy: testPolicy() });

        await handler("session_start")({ reason: "startup" }, context(parentManager));
        const parentPath = getScratchpadPath(parentManager);
        await handler("session_start")({ reason: "startup" }, context(childManager));
        const childPath = getScratchpadPath(childManager);

        expect(parentPath).toBeDefined();
        expect(childPath).toBeDefined();
        expect(childPath).not.toBe(parentPath);
        expect(getScratchpadPath(parentManager)).toBe(parentPath);
    });

    it("releases only registry state at shutdown and leaves the directory on disk", async () => {
        const root = temporaryRoot();
        const { pi, handler } = harness();
        const sessionManager = stubSessionManager();
        const runtimeContext = context(sessionManager);
        registerScratchpadExtension(pi, { root, policy: testPolicy() });
        await handler("session_start")({ reason: "startup" }, runtimeContext);

        const scratchpadPath = getScratchpadPath(sessionManager)!;
        await handler("session_shutdown")({}, runtimeContext);

        expect(getScratchpadPath(sessionManager)).toBeUndefined();
        expect(fs.existsSync(scratchpadPath)).toBe(true);
    });

    it("reuses a legacy temp-dir marker instead of orphaning the running session", async () => {
        const root = temporaryRoot();
        const legacy = fs.mkdtempSync(path.join(os.tmpdir(), SCRATCHPAD_PREFIX));
        temporaryDirectories.push(legacy);
        const entries: unknown[] = [
            {
                type: "custom",
                customType: SCRATCHPAD_MARKER_TYPE,
                data: { version: 1, path: legacy },
            },
        ];
        const sessionManager = { getBranch: () => entries as SessionEntry[] };
        const { pi, handler } = harness(entries);
        registerScratchpadExtension(pi, { root, policy: testPolicy() });

        await handler("session_start")({}, context(sessionManager));

        expect(getScratchpadPath(sessionManager)).toBe(legacy);
    });

    it("prunes idle scratchpads on session start and keeps the active one", async () => {
        const root = temporaryRoot();
        const active = scratchpadDirectory(root);
        const expired = scratchpadDirectory(root);
        const stamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        fs.utimesSync(expired, stamp, stamp);
        const entries: unknown[] = [
            {
                type: "custom",
                customType: SCRATCHPAD_MARKER_TYPE,
                data: { version: 1, path: active },
            },
        ];
        const sessionManager = { getBranch: () => entries as SessionEntry[] };
        const { pi, handler } = harness(entries);
        registerScratchpadExtension(pi, { root, policy: testPolicy() });

        await handler("session_start")({}, context(sessionManager));

        expect(getScratchpadPath(sessionManager)).toBe(active);
        expect(fs.existsSync(active)).toBe(true);
        expect(fs.existsSync(expired)).toBe(false);
    });

    it("warns once when the active scratchpad passes its soft cap", async () => {
        const root = temporaryRoot();
        const notify = vi.fn();
        const sessionManager = stubSessionManager();
        const runtimeContext = context(sessionManager, stubUi({ notify }));
        const { pi, handler } = harness();
        registerScratchpadExtension(pi, {
            root,
            policy: testPolicy({ perScratchpadBytes: 16 }),
        });

        await handler("session_start")({}, runtimeContext);
        const scratchpadPath = getScratchpadPath(sessionManager)!;
        expect(notify).not.toHaveBeenCalled();

        fs.writeFileSync(path.join(scratchpadPath, "big.bin"), Buffer.alloc(64));
        await handler("agent_settled")({}, runtimeContext);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0]?.[0]).toContain("scratchpad is");

        await handler("agent_settled")({}, runtimeContext);
        expect(notify).toHaveBeenCalledTimes(1);
    });
});

describe("scratchpad store pruning", () => {
    it("evicts the oldest idle scratchpad until the store fits its budget", async () => {
        const root = temporaryRoot();
        const oldest = scratchpadDirectory(root);
        const newer = scratchpadDirectory(root);
        writePayload(oldest, 8, 2 * 60 * 60 * 1000);
        writePayload(newer, 8, 60 * 60 * 1000);
        const policy = testPolicy({ totalBudgetBytes: 10, minimumEvictionAgeMs: 0 });

        const report = await pruneScratchpads(root, { policy });

        expect(report.removed).toEqual([oldest]);
        expect(report.retainedBytes).toBe(8);
        expect(report.overBudget).toBe(false);
        expect(fs.existsSync(oldest)).toBe(false);
        expect(fs.existsSync(newer)).toBe(true);
    });

    it("keeps a recent scratchpad even when the store is over budget", async () => {
        const root = temporaryRoot();
        const recent = scratchpadDirectory(root);
        writePayload(recent, 8);
        const policy = testPolicy({
            totalBudgetBytes: 1,
            minimumEvictionAgeMs: 24 * 60 * 60 * 1000,
        });

        const report = await pruneScratchpads(root, { policy });

        expect(report.removed).toEqual([]);
        expect(report.overBudget).toBe(true);
        expect(fs.existsSync(recent)).toBe(true);
    });

    it("never evicts on a truncated measurement", async () => {
        const root = temporaryRoot();
        const scratchpad = scratchpadDirectory(root);
        fs.writeFileSync(path.join(scratchpad, "first.bin"), Buffer.alloc(8));
        fs.writeFileSync(path.join(scratchpad, "second.bin"), Buffer.alloc(8));
        const policy = testPolicy({
            totalBudgetBytes: 1,
            minimumEvictionAgeMs: 0,
            maxEntries: 1,
        });

        const report = await pruneScratchpads(root, { policy });

        expect(report.removed).toEqual([]);
        expect(report.overBudget).toBe(false);
        expect(fs.existsSync(scratchpad)).toBe(true);
    });

    it("leaves entries outside the scratchpad naming scheme and symlinks alone", async () => {
        const root = temporaryRoot();
        const other = path.join(root, "not-a-scratchpad");
        fs.mkdirSync(other);
        const target = scratchpadDirectory(root);
        const link = path.join(root, `${SCRATCHPAD_PREFIX}link`);
        fs.symlinkSync(target, link);
        const stamp = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        fs.utimesSync(other, stamp, stamp);
        fs.lutimesSync(link, stamp, stamp);

        const report = await pruneScratchpads(root, { policy: testPolicy() });

        expect(report.removed).toEqual([]);
        expect(fs.existsSync(other)).toBe(true);
        expect(fs.existsSync(target)).toBe(true);
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    });
});
