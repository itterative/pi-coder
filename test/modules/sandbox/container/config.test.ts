import { describe, expect, it } from "vitest";

import type { SandboxConfig } from "../../../../src/common/config";
import {
    containerBaseImage,
    containerImage,
    containerImageOverride,
    containerShell,
    hasFullIdentityMapping,
} from "../../../../src/modules/sandbox/container/config";
import {
    envEntriesToRecord,
    resolveContainerEnv,
    resolveSandboxEnv,
} from "../../../../src/modules/sandbox/env";
import { DEFAULT_CONTAINER_IMAGE } from "../../../../src/modules/sandbox/container/config";

const EMPTY: SandboxConfig = { sandbox: { mounts: {} }, permissions: {} };

function withSandbox(sandbox: Partial<SandboxConfig["sandbox"]>): SandboxConfig {
    return { ...EMPTY, sandbox: { ...EMPTY.sandbox, mounts: {}, ...sandbox } };
}

const HOST_ENV: NodeJS.ProcessEnv = {
    PATH: "/home/user/.nvm/versions/node/v24/bin:/usr/bin",
    HOME: "/home/user",
    TMPDIR: "/tmp/pi-user",
    SHELL: "/bin/bash",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TZ: "Europe/Vienna",
    PI_SESSION_ID: "01a1836f",
    PI_MODEL: "some-model",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    GITHUB_TOKEN: "ghp_secret",
    SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh",
    XDG_RUNTIME_DIR: "/run/user/1000",
};

describe("resolveSandboxEnv (bubblewrap policy)", () => {
    it("applies custom values, then the allowed environment, then defaults", () => {
        const entries = resolveSandboxEnv(
            withSandbox({
                env: { CUSTOM: "value", PATH: "/custom" },
                inheritEnv: { LANG: "allow" },
            }),
            HOST_ENV,
        );
        const record = envEntriesToRecord(entries);

        expect(record.CUSTOM).toBe("value");
        expect(record.PATH).toBe("/custom");
        expect(record.LANG).toBe("en_US.UTF-8");
        expect(record.TERM).toBe("xterm-256color");
    });

    it("keeps a host variable out when the config does not allow it", () => {
        const record = envEntriesToRecord(
            resolveSandboxEnv(withSandbox({ inheritEnv: { LANG: "allow" } }), HOST_ENV),
        );

        expect(record.ANTHROPIC_API_KEY).toBeUndefined();
        expect(record.LC_ALL).toBeUndefined();
    });

    it("sets each key at most once", () => {
        const entries = resolveSandboxEnv(withSandbox({ env: { TERM: "dumb" } }), HOST_ENV);

        expect(entries.filter(({ key }) => key === "TERM")).toHaveLength(1);
        expect(envEntriesToRecord(entries).TERM).toBe("dumb");
    });
});

describe("resolveContainerEnv (container policy)", () => {
    it("keeps the image's own PATH and HOME out of the command environment", () => {
        const record = envEntriesToRecord(resolveContainerEnv(EMPTY, HOST_ENV));

        expect(record.PATH).toBeUndefined();
        expect(record.HOME).toBeUndefined();
        expect(record.TMPDIR).toBeUndefined();
        expect(record.SHELL).toBeUndefined();
    });

    it("passes terminal, locale, and session metadata through", () => {
        const record = envEntriesToRecord(resolveContainerEnv(EMPTY, HOST_ENV));

        expect(record.TERM).toBe("xterm-256color");
        expect(record.LANG).toBe("en_US.UTF-8");
        expect(record.TZ).toBe("Europe/Vienna");
        expect(record.PI_SESSION_ID).toBe("01a1836f");
        expect(record.PI_MODEL).toBe("some-model");
    });

    it("does not leak credentials or host services implicitly", () => {
        const record = envEntriesToRecord(resolveContainerEnv(EMPTY, HOST_ENV));

        expect(record.ANTHROPIC_API_KEY).toBeUndefined();
        expect(record.GITHUB_TOKEN).toBeUndefined();
        expect(record.SSH_AUTH_SOCK).toBeUndefined();
        expect(record.XDG_RUNTIME_DIR).toBeUndefined();
    });

    it("honors an explicit allow, except for host path variables", () => {
        const record = envEntriesToRecord(
            resolveContainerEnv(
                withSandbox({
                    inheritEnv: { CARGO_HOME: "allow", NPM_TOKEN: "allow", PATH: "allow" },
                }),
                { ...HOST_ENV, CARGO_HOME: "/home/user/.cargo", NPM_TOKEN: "npm-secret" },
            ),
        );

        expect(record.CARGO_HOME).toBe("/home/user/.cargo");
        // An explicit allow is a decision the user made, so a credential-shaped name is not second-guessed.
        expect(record.NPM_TOKEN).toBe("npm-secret");
        expect(record.PATH).toBeUndefined();
    });

    it("honors custom values from the config even when they look path-like", () => {
        const record = envEntriesToRecord(
            resolveContainerEnv(withSandbox({ env: { PATH: "/opt/bin" } }), HOST_ENV),
        );

        expect(record.PATH).toBe("/opt/bin");
    });

    it("leaves the image environment alone when the host has nothing to add", () => {
        expect(resolveContainerEnv(EMPTY, {})).toEqual([]);
    });
});

describe("image defaults", () => {
    it("defaults the image to a Node image, because the dispatcher is a Node program", () => {
        expect(containerImage({})).toBe(DEFAULT_CONTAINER_IMAGE);
        expect(containerImage({ PI_SANDBOX_IMAGE: "alpine:3.20" })).toBe("alpine:3.20");
        expect(containerImage({ PI_SANDBOX_IMAGE: "   " })).toBe(DEFAULT_CONTAINER_IMAGE);
    });

    it("leaves the shell to the image unless one is configured", () => {
        expect(containerShell({})).toBeUndefined();
        expect(containerShell({ PI_SANDBOX_SHELL: "/bin/sh" })).toBe("/bin/sh");
    });

    it("separates an explicit image from the default, because only the override suppresses a recipe", () => {
        expect(containerImageOverride({})).toBeUndefined();
        expect(containerImageOverride({ PI_SANDBOX_IMAGE: "   " })).toBeUndefined();
        expect(containerImageOverride({ PI_SANDBOX_IMAGE: "custom:1" })).toBe("custom:1");
    });

    it("sources the dispatcher runtime from the base image, defaulting to the Node image", () => {
        expect(containerBaseImage({})).toBe(DEFAULT_CONTAINER_IMAGE);
        expect(containerBaseImage({ PI_SANDBOX_BASE_IMAGE: "node:20-bookworm-slim" })).toBe(
            "node:20-bookworm-slim",
        );
        expect(containerBaseImage({ PI_SANDBOX_BASE_IMAGE: "  " })).toBe(DEFAULT_CONTAINER_IMAGE);
    });
});

describe("hasFullIdentityMapping", () => {
    it("accepts the host user namespace", () => {
        expect(hasFullIdentityMapping("         0          0 4294967295\n")).toBe(true);
    });

    it("rejects the mapping a wrapping sandbox produces", () => {
        expect(hasFullIdentityMapping("1241 1241 1\n")).toBe(false);
        expect(hasFullIdentityMapping("0 100000 65536\n")).toBe(false);
    });

    it("rejects anything it cannot interpret", () => {
        expect(hasFullIdentityMapping("")).toBe(false);
        expect(hasFullIdentityMapping("garbage")).toBe(false);
    });
});
