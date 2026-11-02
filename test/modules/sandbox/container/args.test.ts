import { describe, expect, it } from "vitest";

import {
    CONTAINER_LABEL,
    CONTAINER_SESSION_LABEL,
    buildPodmanArgs,
    containerNameFor,
    type ContainerLaunchSpec,
} from "../../../../src/modules/sandbox/container/args";

const SPEC: ContainerLaunchSpec = {
    image: "node:24-trixie-slim",
    containerName: "pi-coder-sandbox-abc",
    sessionId: "abc",
    cwd: "/home/user/project",
    dispatcherPath: "/home/user/extensions/pi-coder/dispatch.mjs",
    mounts: [
        { source: "/home/user/project", mode: "rw" },
        { source: "/tmp/pi-coder-scratchpad", mode: "rw" },
        { source: "/home/user/.pi/agent/memory", mode: "ro" },
    ],
};

describe("buildPodmanArgs", () => {
    const args = buildPodmanArgs(SPEC);

    it("leaves the network alone unless the posture asks for none", () => {
        expect(args).not.toContain("--network=none");
        expect(buildPodmanArgs({ ...SPEC, network: "egress" })).not.toContain("--network=none");
        expect(buildPodmanArgs({ ...SPEC, network: "none" })).toContain("--network=none");
    });

    it("joins the host network only when the plan says so", () => {
        expect(buildPodmanArgs({ ...SPEC, network: "host" })).toContain("--network=host");
        expect(args).not.toContain("--network=host");
    });

    it("publishes the ports the posture resolved", () => {
        const published = buildPodmanArgs({
            ...SPEC,
            network: "egress",
            publish: ["127.0.0.1:3000:3000", "127.0.0.1:8080:80"],
        });

        expect(published).toContain("--publish");
        expect(published).toContain("127.0.0.1:3000:3000");
        expect(published).toContain("127.0.0.1:8080:80");
    });

    it("refuses a port mapping on a network that cannot publish, instead of failing at start", () => {
        expect(() =>
            buildPodmanArgs({ ...SPEC, network: "none", publish: ["127.0.0.1:3000:3000"] }),
        ).toThrow(/cannot publish/);
        expect(() =>
            buildPodmanArgs({ ...SPEC, network: "host", publish: ["127.0.0.1:3000:3000"] }),
        ).toThrow(/cannot publish/);
    });

    it("passes devices through and keeps the user's groups so rootless can open them", () => {
        const devices = buildPodmanArgs({
            ...SPEC,
            devices: ["/dev/dri", "/dev/kfd"],
            keepGroups: true,
        });

        expect(devices).toContain("--device");
        expect(devices).toContain("/dev/dri");
        expect(devices).toContain("/dev/kfd");
        expect(devices.join(" ")).toContain("--group-add keep-groups");

        expect(args.join(" ")).not.toContain("--device");
        expect(args.join(" ")).not.toContain("keep-groups");
    });

    it("runs the dispatcher non-interactively as the container's main process", () => {
        expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
        expect(args).toContain("--interactive");
        expect(args.at(-2)).toBe("node");
        expect(args.at(-1)).toBe("/run/pi/dispatch.mjs");
    });

    it("disables SELinux relabeling and signal proxying", () => {
        expect(args.join(" ")).toContain("--security-opt label=disable");
        expect(args).toContain("--sig-proxy=false");
    });

    it("includes an init process so backgrounded grandchildren are reaped", () => {
        expect(args).toContain("--init");
    });

    it("labels the container with the session so it can be found without bookkeeping", () => {
        expect(args).toContain(`${CONTAINER_LABEL}=1`);
        expect(args).toContain(`${CONTAINER_SESSION_LABEL}=abc`);
        expect(args).toContain("pi-coder-sandbox-abc");
    });

    it("mounts the checkout at its real path, writable", () => {
        expect(args).toContain("/home/user/project:/home/user/project:rw");
    });

    it("mounts the dispatcher file read-only, at the path the container runs", () => {
        expect(args).toContain(
            "/home/user/extensions/pi-coder/dispatch.mjs:/run/pi/dispatch.mjs:ro",
        );
    });

    it("mounts extra roots with their configured mode", () => {
        expect(args).toContain("/tmp/pi-coder-scratchpad:/tmp/pi-coder-scratchpad:rw");
        expect(args).toContain("/home/user/.pi/agent/memory:/home/user/.pi/agent/memory:ro");
    });

    it("works from the checkout's real path and gives /tmp a throwaway filesystem", () => {
        expect(args[args.indexOf("--workdir") + 1]).toBe("/home/user/project");
        expect(args[args.indexOf("--tmpfs") + 1]).toBe("/tmp");
    });

    it("runs as the host user, so nothing inside holds privilege over the image", () => {
        expect(args).toContain("--userns=keep-id");
    });

    it("mounts a writable home at the real home path, so ~ means the same inside as outside", () => {
        const withHome = buildPodmanArgs({
            ...SPEC,
            home: { source: "/state/abc/home", target: "/home/user" },
        });

        expect(withHome).toContain("/state/abc/home:/home/user:rw");
        expect(withHome).toContain("HOME=/home/user");
    });

    it("mounts the home before paths nested inside it, so it cannot shadow them", () => {
        const withHome = buildPodmanArgs({
            ...SPEC,
            home: { source: "/state/abc/home", target: "/home/user" },
            mounts: [
                { source: "/home/user/project", mode: "rw" },
                { source: "/home/user/.pi/agent/memory", mode: "ro" },
            ],
        });

        const homeIndex = withHome.indexOf("/state/abc/home:/home/user:rw");
        const memoryIndex = withHome.indexOf(
            "/home/user/.pi/agent/memory:/home/user/.pi/agent/memory:ro",
        );

        expect(homeIndex).toBeGreaterThan(-1);
        expect(homeIndex).toBeLessThan(memoryIndex);
    });

    it("omits the home mount when no home was supplied, as in a dispatcher-only launch", () => {
        expect(args.join(" ")).not.toContain("HOME=");
    });

    it("runs the image's own node unless a recipe image names the one its prologue installed", () => {
        expect(args.at(-2)).toBe("node");
        expect(buildPodmanArgs({ ...SPEC, nodePath: "/opt/pi/node" }).at(-2)).toBe("/opt/pi/node");
    });

    it("passes an explicit shell only when one was configured", () => {
        expect(buildPodmanArgs(SPEC).join(" ")).not.toContain("PI_SANDBOX_SHELL");
        expect(buildPodmanArgs({ ...SPEC, shell: "/bin/bash" })).toContain(
            "PI_SANDBOX_SHELL=/bin/bash",
        );
    });
});

describe("containerNameFor", () => {
    it("prefixes the session id", () => {
        expect(containerNameFor("01a1836f")).toBe("pi-coder-sandbox-01a1836f");
    });

    it("sanitizes characters podman would reject", () => {
        expect(containerNameFor("a:b/c d")).toBe("pi-coder-sandbox-a-b-c-d");
    });
});
