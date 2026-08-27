import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import config from "../../../src/common/config";
import sandbox, { type SandboxOptions } from "../../../src/modules/sandbox/bubblewrap";

describe("bubblewrap", () => {
    let tempDir: string;
    let projectDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-test-"));
        projectDir = path.join(tempDir, "project");
        fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function writeProjectConfig(cfg: object): ReturnType<typeof config.load> {
        fs.writeFileSync(
            path.join(projectDir, ".pi", "bash-sandbox-config.json"),
            JSON.stringify(cfg)
        );
        return config.load(projectDir);
    }

    it("binds runtime-managed additional roots", () => {
        const scratchpad = path.join(tempDir, "scratchpad");
        fs.mkdirSync(scratchpad);

        const result = sandbox("bwrap", "cat notes.txt", {
            cwd: projectDir,
            additionalRoots: [scratchpad],
            config: {
                sandbox: { mounts: {} },
                permissions: {},
            },
        });

        expect(result).toContain(`--bind '${scratchpad}' '${scratchpad}'`);
        expect(result.indexOf(`--bind '${scratchpad}' '${scratchpad}'`))
            .toBeGreaterThan(result.indexOf("--bind '/tmp' '/tmp'"));
    });

    describe("buildEnvCmd - default environment variables", () => {
        it("should set HOME from env.HOME when available", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).toContain("--setenv HOME '/home/testuser'");
        });

        it("should NOT set HOME when env.HOME is undefined", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { PATH: "/usr/bin", USER: "testuser" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).not.toMatch(/--setenv HOME '/);
        });

        it("should set USER from env.USER when available", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).toContain("--setenv USER 'testuser'");
        });

        it("should NOT set USER when env.USER is undefined", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).not.toMatch(/--setenv USER '/);
        });

        it("should set PATH from env.PATH when available", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/local/bin:/usr/bin", USER: "testuser" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).toContain("--setenv PATH '/usr/local/bin:/usr/bin'");
        });

        it("should NOT set PATH when env.PATH is undefined", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", USER: "testuser" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).not.toMatch(/--setenv PATH '/);
        });

        it("should set PWD from env.PWD when available", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser", PWD: "/custom/pwd" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).toContain("--setenv PWD '/custom/pwd'");
        });

        it("should set SHELL from env.SHELL when available", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser", SHELL: "/bin/zsh" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).toContain("--setenv SHELL '/bin/zsh'");
        });

        it("should allow config env to override env vars", () => {
            const testConfig = writeProjectConfig({
                sandbox: {
                    mounts: {},
                    env: {
                        HOME: "/home/custom",
                    },
                },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/original", PATH: "/usr/bin", USER: "testuser" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            // Config env should take precedence
            expect(result).toContain("--setenv HOME '/home/custom'");
            expect(result).not.toContain("--setenv HOME '/home/original'");
        });
    });

    describe("clearenv behavior", () => {
        it("should include --clearenv when inheritEnv is defined", () => {
            const testConfig = writeProjectConfig({
                sandbox: {
                    mounts: {},
                    inheritEnv: {},
                },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).toContain("--clearenv");
        });

        it("should NOT include --clearenv when inheritEnv is not defined", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).not.toContain("--clearenv");
        });
    });

    describe("inheritEnv behavior", () => {
        it("should inherit env vars marked as 'allow' in inheritEnv config", () => {
            const testConfig = writeProjectConfig({
                sandbox: {
                    mounts: {},
                    inheritEnv: {
                        CUSTOM_VAR: "allow",
                        SECRET_VAR: "deny",
                    },
                },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: {
                    HOME: "/home/testuser",
                    PATH: "/usr/bin",
                    USER: "testuser",
                    CUSTOM_VAR: "custom_value",
                    SECRET_VAR: "secret",
                },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).toContain("--setenv CUSTOM_VAR 'custom_value'");
            expect(result).not.toContain("--setenv SECRET_VAR 'secret'");
        });

        it("should not process inheritEnv when it is empty", () => {
            const testConfig = writeProjectConfig({
                sandbox: {
                    mounts: {},
                    inheritEnv: {},
                },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: {
                    HOME: "/home/testuser",
                    PATH: "/usr/bin",
                    USER: "testuser",
                    CUSTOM_VAR: "custom_value",
                },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            // Default env vars should still be set
            expect(result).toContain("--setenv HOME '/home/testuser'");
            expect(result).toContain("--setenv USER 'testuser'");
            expect(result).toContain("--setenv PATH '/usr/bin'");
            // But CUSTOM_VAR should NOT be set (empty inheritEnv means no inheritance)
            expect(result).not.toContain("--setenv CUSTOM_VAR");
        });
    });

    describe("git worktree support", () => {
        it("should auto-mount worktree git dir and main repo .git when cwd is a worktree", () => {
            // Simulate a git worktree structure
            const mainRepo = path.join(tempDir, "main-repo");
            const worktree = path.join(tempDir, "worktree");
            const worktreeGitDir = path.join(mainRepo, ".git", "worktrees", "feature");

            fs.mkdirSync(worktreeGitDir, { recursive: true });
            fs.mkdirSync(worktree, { recursive: true });
            fs.mkdirSync(path.join(mainRepo, ".git"), { recursive: true });

            // Create .git file in worktree pointing to worktree git dir
            fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}`);

            // Create commondir pointing to main repo .git
            fs.writeFileSync(path.join(worktreeGitDir, "commondir"), mainRepo + "/.git");

            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser" },
                cwd: worktree,
                config: testConfig,
            };

            const result = sandbox("bwrap", "git status", options);

            // Should mount the main repo .git dir
            expect(result).toContain(`--bind-try '${mainRepo}/.git' '${mainRepo}/.git'`);
            // Should mount the worktree git dir (read-write, mounted after to override)
            expect(result).toContain(`--bind-try '${worktreeGitDir}' '${worktreeGitDir}'`);
        });

        it("should handle relative commondir path", () => {
            const mainRepo = path.join(tempDir, "main-repo");
            const worktree = path.join(tempDir, "worktree");
            const worktreeGitDir = path.join(mainRepo, ".git", "worktrees", "feature");

            fs.mkdirSync(worktreeGitDir, { recursive: true });
            fs.mkdirSync(worktree, { recursive: true });
            fs.mkdirSync(path.join(mainRepo, ".git"), { recursive: true });

            fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}`);

            // Relative commondir (relative to worktreeGitDir)
            fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../../");

            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser" },
                cwd: worktree,
                config: testConfig,
            };

            const result = sandbox("bwrap", "git status", options);

            // Should resolve relative commondir and mount main repo .git
            const expectedMainGit = path.resolve(worktreeGitDir, "../../");
            expect(result).toContain(`--bind-try '${expectedMainGit}' '${expectedMainGit}'`);
        });

        it("should NOT mount worktree dirs when cwd has a regular .git directory", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            // projectDir already has .pi/ but no .git file (it's a normal dir)
            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "git status", options);

            // Should NOT contain any bind-try for worktree paths
            expect(result).not.toMatch(/--bind-try '.*worktrees/);
        });

        it("should NOT mount worktree dirs when gitWorktreeSupport is false", () => {
            const mainRepo = path.join(tempDir, "main-repo");
            const worktree = path.join(tempDir, "worktree");
            const worktreeGitDir = path.join(mainRepo, ".git", "worktrees", "feature");

            fs.mkdirSync(worktreeGitDir, { recursive: true });
            fs.mkdirSync(worktree, { recursive: true });
            fs.mkdirSync(path.join(mainRepo, ".git"), { recursive: true });

            fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}`);
            fs.writeFileSync(path.join(worktreeGitDir, "commondir"), mainRepo + "/.git");

            const testConfig = writeProjectConfig({
                sandbox: {
                    mounts: {},
                    gitWorktreeSupport: false,
                },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser" },
                cwd: worktree,
                config: testConfig,
            };

            const result = sandbox("bwrap", "git status", options);

            expect(result).not.toContain(`--bind-try '${worktreeGitDir}'`);
            expect(result).not.toContain(`--bind-try '${mainRepo}/.git'`);
        });

        it("should handle worktree with missing commondir gracefully", () => {
            const mainRepo = path.join(tempDir, "main-repo");
            const worktree = path.join(tempDir, "worktree");
            const worktreeGitDir = path.join(mainRepo, ".git", "worktrees", "feature");

            fs.mkdirSync(worktreeGitDir, { recursive: true });
            fs.mkdirSync(worktree, { recursive: true });

            fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}`);
            // No commondir file

            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser" },
                cwd: worktree,
                config: testConfig,
            };

            const result = sandbox("bwrap", "git status", options);

            // Should still mount the worktree git dir
            expect(result).toContain(`--bind-try '${worktreeGitDir}' '${worktreeGitDir}'`);
            // But should not crash
            expect(result).toContain("--die-with-parent");
        });
    });

    describe("shell behavior", () => {
        it("should use SHELL env var when available", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser", SHELL: "/bin/zsh" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).toContain("-- /bin/zsh -c 'echo hello'");
        });

        it("should fallback to sh when SHELL is not set", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).toContain("-- sh -c 'echo hello'");
        });
    });
});
