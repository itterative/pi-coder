import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import config from "../../src/common/config";
import getPermission from "../../src/modules/sandbox/permissions";

describe("config merging", () => {
    let tempDir: string;
    let projectDir: string;
    let globalConfigPath: string;

    beforeEach(() => {
        // Create temp directories
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-test-"));
        projectDir = path.join(tempDir, "project");
        fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });

        // Create a temp global config path
        globalConfigPath = path.join(tempDir, "global-config.json");
    });

    afterEach(() => {
        // Clean up temp directories
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function writeProjectConfig(cfg: object) {
        fs.writeFileSync(
            path.join(projectDir, ".pi", "bash-sandbox-config.json"),
            JSON.stringify(cfg),
        );
    }

    function writeGlobalConfig(cfg: object) {
        fs.writeFileSync(globalConfigPath, JSON.stringify(cfg));
    }

    function clearConfigCache() {
        const cfg = config as unknown as { _config: unknown };
        cfg._config = null;
    }

    describe("permission merging with last-match-wins", () => {
        it("should merge project permissions after global permissions", () => {
            writeGlobalConfig({
                permissions: {
                    "npm *": "deny",
                    "rm *": "deny",
                },
            });
            writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {
                    "npm run *": "allow",
                },
            });

            const originalGlobal = process.env.SANDBOX_CONFIG_PATH_GLOBAL;
            process.env.SANDBOX_CONFIG_PATH_GLOBAL = globalConfigPath;

            try {
                clearConfigCache();
                const loaded = config.load(projectDir);

                expect(loaded.permissions["npm *"]).toBe("deny");
                expect(loaded.permissions["rm *"]).toBe("deny");
                expect(loaded.permissions["npm run *"]).toBe("allow");

                // Verify order: project permission should come last
                const keys = Object.keys(loaded.permissions);
                expect(keys).toEqual(["npm *", "rm *", "npm run *"]);
            } finally {
                process.env.SANDBOX_CONFIG_PATH_GLOBAL = originalGlobal;
            }
        });

        it("should allow project to override global permission", () => {
            writeGlobalConfig({
                permissions: {
                    "*": "deny",
                    "npm *": "deny",
                },
            });
            writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {
                    "npm *": "allow",
                },
            });

            const originalGlobal = process.env.SANDBOX_CONFIG_PATH_GLOBAL;
            process.env.SANDBOX_CONFIG_PATH_GLOBAL = globalConfigPath;

            try {
                clearConfigCache();
                const loaded = config.load(projectDir);

                // npm * should be overridden to allow
                expect(loaded.permissions["npm *"]).toBe("allow");

                // And it should come after the catch-all, so npm commands are allowed
                const keys = Object.keys(loaded.permissions);
                expect(keys).toEqual(["*", "npm *"]);

                // Verify last-match-wins works
                expect(getPermission("npm install", loaded.permissions)).toBe("allow");
                expect(getPermission("rm file", loaded.permissions)).toBe("deny");
            } finally {
                process.env.SANDBOX_CONFIG_PATH_GLOBAL = originalGlobal;
            }
        });

        it("should combine global catch-all with project-specific rules", () => {
            writeGlobalConfig({
                permissions: {
                    "*": "ask",
                },
            });
            writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {
                    "npm run build": "allow",
                    "npm test": "allow",
                    "git *": "allow",
                },
            });

            const originalGlobal = process.env.SANDBOX_CONFIG_PATH_GLOBAL;
            process.env.SANDBOX_CONFIG_PATH_GLOBAL = globalConfigPath;

            try {
                clearConfigCache();
                const loaded = config.load(projectDir);

                // Project rules should come after global
                const keys = Object.keys(loaded.permissions);
                expect(keys).toEqual(["*", "npm run build", "npm test", "git *"]);

                // Verify permissions work correctly
                expect(getPermission("npm run build", loaded.permissions)).toBe("allow");
                expect(getPermission("npm test", loaded.permissions)).toBe("allow");
                expect(getPermission("git status", loaded.permissions)).toBe("allow");
                expect(getPermission("ls", loaded.permissions)).toBe("ask");
            } finally {
                process.env.SANDBOX_CONFIG_PATH_GLOBAL = originalGlobal;
            }
        });

        it("should respect last-match-wins for commands matching multiple patterns", () => {
            writeGlobalConfig({
                permissions: {
                    "ls *": "allow",
                },
            });
            writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {
                    "ls -la": "deny",
                },
            });

            const originalGlobal = process.env.SANDBOX_CONFIG_PATH_GLOBAL;
            process.env.SANDBOX_CONFIG_PATH_GLOBAL = globalConfigPath;

            try {
                clearConfigCache();
                const loaded = config.load(projectDir);

                // ls -la should be denied (project rule comes last)
                expect(getPermission("ls -la", loaded.permissions)).toBe("deny");
                // Other ls commands should still be allowed
                expect(getPermission("ls -lh", loaded.permissions)).toBe("allow");
            } finally {
                process.env.SANDBOX_CONFIG_PATH_GLOBAL = originalGlobal;
            }
        });
    });

    describe("mount merging", () => {
        it("should merge global and project mounts", () => {
            writeGlobalConfig({
                sandbox: {
                    mounts: {
                        "/usr": "readonly",
                        "/home": "readonly",
                    },
                },
                permissions: {},
            });
            writeProjectConfig({
                sandbox: {
                    mounts: {
                        "/home/user/project": "readwrite",
                    },
                },
                permissions: {},
            });

            const originalGlobal = process.env.SANDBOX_CONFIG_PATH_GLOBAL;
            process.env.SANDBOX_CONFIG_PATH_GLOBAL = globalConfigPath;

            try {
                clearConfigCache();
                const loaded = config.load(projectDir);

                expect(loaded.sandbox.mounts["/usr"]).toBe("readonly");
                expect(loaded.sandbox.mounts["/home"]).toBe("readonly");
                expect(loaded.sandbox.mounts["/home/user/project"]).toBe("readwrite");
            } finally {
                process.env.SANDBOX_CONFIG_PATH_GLOBAL = originalGlobal;
            }
        });

        it("should allow project to override global mount", () => {
            writeGlobalConfig({
                sandbox: {
                    mounts: {
                        "/home": "readonly",
                    },
                },
                permissions: {},
            });
            writeProjectConfig({
                sandbox: {
                    mounts: {
                        "/home": "readwrite",
                    },
                },
                permissions: {},
            });

            const originalGlobal = process.env.SANDBOX_CONFIG_PATH_GLOBAL;
            process.env.SANDBOX_CONFIG_PATH_GLOBAL = globalConfigPath;

            try {
                clearConfigCache();
                const loaded = config.load(projectDir);

                // Project should override global mount
                expect(loaded.sandbox.mounts["/home"]).toBe("readwrite");
            } finally {
                process.env.SANDBOX_CONFIG_PATH_GLOBAL = originalGlobal;
            }
        });
    });

    describe("env merging", () => {
        it("should merge global and project env vars with project taking precedence", () => {
            writeGlobalConfig({
                sandbox: {
                    mounts: {},
                    env: {
                        NODE_ENV: "development",
                        API_URL: "https://api.example.com",
                    },
                },
                permissions: {},
            });
            writeProjectConfig({
                sandbox: {
                    mounts: {},
                    env: {
                        NODE_ENV: "test",
                        DEBUG: "true",
                    },
                },
                permissions: {},
            });

            const originalGlobal = process.env.SANDBOX_CONFIG_PATH_GLOBAL;
            process.env.SANDBOX_CONFIG_PATH_GLOBAL = globalConfigPath;

            try {
                clearConfigCache();
                const loaded = config.load(projectDir);

                expect(loaded.sandbox.env?.["NODE_ENV"]).toBe("test"); // Project overrides
                expect(loaded.sandbox.env?.["API_URL"]).toBe("https://api.example.com"); // Global preserved
                expect(loaded.sandbox.env?.["DEBUG"]).toBe("true"); // Project only
            } finally {
                process.env.SANDBOX_CONFIG_PATH_GLOBAL = originalGlobal;
            }
        });
    });

    describe("inheritEnv merging", () => {
        it("should merge global and project inheritEnv filters", () => {
            writeGlobalConfig({
                sandbox: {
                    mounts: {},
                    inheritEnv: {
                        HOME: "allow",
                        PATH: "allow",
                        SECRET: "deny",
                    },
                },
                permissions: {},
            });
            writeProjectConfig({
                sandbox: {
                    mounts: {},
                    inheritEnv: {
                        SECRET: "allow", // Project overrides to allow
                        DEBUG: "allow",
                    },
                },
                permissions: {},
            });

            const originalGlobal = process.env.SANDBOX_CONFIG_PATH_GLOBAL;
            process.env.SANDBOX_CONFIG_PATH_GLOBAL = globalConfigPath;

            try {
                clearConfigCache();
                const loaded = config.load(projectDir);

                expect(loaded.sandbox.inheritEnv?.["HOME"]).toBe("allow"); // Global
                expect(loaded.sandbox.inheritEnv?.["PATH"]).toBe("allow"); // Global
                expect(loaded.sandbox.inheritEnv?.["SECRET"]).toBe("allow"); // Project overrides
                expect(loaded.sandbox.inheritEnv?.["DEBUG"]).toBe("allow"); // Project only
            } finally {
                process.env.SANDBOX_CONFIG_PATH_GLOBAL = originalGlobal;
            }
        });
    });

    describe("config without global", () => {
        it("should load project config when no global exists", () => {
            // Don't write global config
            writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {
                    "npm *": "allow",
                },
            });

            const originalGlobal = process.env.SANDBOX_CONFIG_PATH_GLOBAL;
            process.env.SANDBOX_CONFIG_PATH_GLOBAL = path.join(tempDir, "nonexistent.json");

            try {
                clearConfigCache();
                const loaded = config.load(projectDir);

                expect(loaded.permissions["npm *"]).toBe("allow");
            } finally {
                process.env.SANDBOX_CONFIG_PATH_GLOBAL = originalGlobal;
            }
        });
    });

    describe("config without project", () => {
        it("should load global config when no project exists", () => {
            writeGlobalConfig({
                sandbox: { mounts: {} },
                permissions: {
                    "*": "ask",
                },
            });
            // Don't write project config

            const originalGlobal = process.env.SANDBOX_CONFIG_PATH_GLOBAL;
            process.env.SANDBOX_CONFIG_PATH_GLOBAL = globalConfigPath;

            // Use a directory without .pi config
            const emptyDir = path.join(tempDir, "empty-project");
            fs.mkdirSync(emptyDir);

            try {
                clearConfigCache();
                const loaded = config.load(emptyDir);

                expect(loaded.permissions["*"]).toBe("ask");
            } finally {
                process.env.SANDBOX_CONFIG_PATH_GLOBAL = originalGlobal;
            }
        });
    });

    describe("sandbox.enabled", () => {
        it("should default to undefined (enabled) when not set", () => {
            writeGlobalConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const originalGlobal = process.env.SANDBOX_CONFIG_PATH_GLOBAL;
            process.env.SANDBOX_CONFIG_PATH_GLOBAL = globalConfigPath;

            const emptyDir = path.join(tempDir, "empty-project");
            fs.mkdirSync(emptyDir);

            try {
                clearConfigCache();
                const loaded = config.load(emptyDir);

                expect(loaded.sandbox.enabled).toBeUndefined();
            } finally {
                process.env.SANDBOX_CONFIG_PATH_GLOBAL = originalGlobal;
            }
        });

        it("should parse enabled: false from project config", () => {
            writeProjectConfig({
                sandbox: { enabled: false, mounts: {} },
                permissions: {},
            });

            clearConfigCache();
            const loaded = config.load(projectDir);

            expect(loaded.sandbox.enabled).toBe(false);
        });

        it("should let project override global enabled value", () => {
            writeGlobalConfig({
                sandbox: { enabled: false, mounts: {} },
                permissions: {},
            });
            writeProjectConfig({
                sandbox: { enabled: true, mounts: {} },
                permissions: {},
            });

            const originalGlobal = process.env.SANDBOX_CONFIG_PATH_GLOBAL;
            process.env.SANDBOX_CONFIG_PATH_GLOBAL = globalConfigPath;

            try {
                clearConfigCache();
                const loaded = config.load(projectDir);

                expect(loaded.sandbox.enabled).toBe(true);
            } finally {
                process.env.SANDBOX_CONFIG_PATH_GLOBAL = originalGlobal;
            }
        });

        it("should inherit global enabled: false when project does not set it", () => {
            writeGlobalConfig({
                sandbox: { enabled: false, mounts: {} },
                permissions: {},
            });
            writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const originalGlobal = process.env.SANDBOX_CONFIG_PATH_GLOBAL;
            process.env.SANDBOX_CONFIG_PATH_GLOBAL = globalConfigPath;

            try {
                clearConfigCache();
                const loaded = config.load(projectDir);

                expect(loaded.sandbox.enabled).toBe(false);
            } finally {
                process.env.SANDBOX_CONFIG_PATH_GLOBAL = originalGlobal;
            }
        });
    });

    describe("heuristics merging", () => {
        it("should merge cwdConfinement fields with project precedence and concat denyPaths", () => {
            writeGlobalConfig({
                permissions: {},
                heuristics: {
                    cwdConfinement: {
                        enabled: false,
                        permission: "allow:sandbox",
                        commands: ["cat"],
                        denyPaths: ["*.secret"],
                        blockDotfiles: true,
                    },
                },
            });
            writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
                heuristics: {
                    cwdConfinement: {
                        permission: "allow",
                        denyPaths: ["*.db"],
                    },
                },
            });

            const originalGlobal = process.env.SANDBOX_CONFIG_PATH_GLOBAL;
            process.env.SANDBOX_CONFIG_PATH_GLOBAL = globalConfigPath;

            try {
                clearConfigCache();
                const loaded = config.load(projectDir);

                expect(loaded.heuristics?.cwdConfinement).toEqual({
                    enabled: false, // from global
                    permission: "allow", // project overrides
                    commands: ["cat"], // from global
                    denyPaths: ["*.secret", "*.db"], // concatenated
                    blockDotfiles: true, // from global
                });
            } finally {
                process.env.SANDBOX_CONFIG_PATH_GLOBAL = originalGlobal;
            }
        });

        it("should load and merge the glob expansion controls", () => {
            // tryLoad() whitelists each cwdConfinement field, so a key that is not listed there is
            // dropped silently and the heuristic keeps its default. This pins that both glob keys
            // survive the load and the merge, with the project winning on identical keys.
            writeGlobalConfig({
                permissions: {},
                heuristics: { cwdConfinement: { globExpansion: false, globMaxDepth: 3 } },
            });
            writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
                heuristics: { cwdConfinement: { globMaxDepth: 5 } },
            });

            const originalGlobal = process.env.SANDBOX_CONFIG_PATH_GLOBAL;
            process.env.SANDBOX_CONFIG_PATH_GLOBAL = globalConfigPath;

            try {
                clearConfigCache();
                const loaded = config.load(projectDir);

                expect(loaded.heuristics?.cwdConfinement?.globExpansion).toBe(false);
                expect(loaded.heuristics?.cwdConfinement?.globMaxDepth).toBe(5);
            } finally {
                process.env.SANDBOX_CONFIG_PATH_GLOBAL = originalGlobal;
            }
        });
    });
});
