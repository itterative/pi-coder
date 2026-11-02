import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The two values a commit needs; everything else in the host config points somewhere the image does not have. */
export interface GitIdentity {
    name: string;
    email: string;
}

/**
 * The host's git identity, for seeding the sandbox's `$HOME`.
 *
 * Without it a command inside the sandbox cannot commit at all ("Committer identity unknown"), which is the
 * wrong kind of divergence: the checkout is shared, so the work a commit records is shared too. Only
 * `user.name` and `user.email` cross — the host file's credential helper, `hooksPath`, and LFS filters name
 * absolute paths and binaries the image does not have, and a warning on every git command would be worse than
 * the identity being absent.
 *
 * Missing git, a missing config, or a timeout all mean "no identity": the sandbox then behaves like a machine
 * where nobody configured one, which is exactly what a command would see on such a host.
 */
export async function readHostGitIdentity(): Promise<GitIdentity | undefined> {
    const [name, email] = await Promise.all([
        readGlobalConfig("user.name"),
        readGlobalConfig("user.email"),
    ]);

    if (name === undefined || email === undefined) {
        return undefined;
    }

    return { name, email };
}

/** The `$HOME/.gitconfig` the sandbox starts with: a comment explaining itself, then the identity. */
export function gitConfigFile(identity: GitIdentity): string {
    return [
        "# Written by pi-coder for the sandbox home: the host's git identity and nothing else.",
        "# The host file's credential helper, hooks, and LFS filters are deliberately left out:",
        "# they name absolute paths and binaries the image does not have.",
        "[user]",
        `\tname = ${quote(identity.name)}`,
        `\temail = ${quote(identity.email)}`,
        "",
    ].join("\n");
}

async function readGlobalConfig(key: string): Promise<string | undefined> {
    try {
        const { stdout } = await run("git", ["config", "--global", "--get", key], {
            timeout: 2_000,
        });
        const value = stdout.trim();

        return value.length > 0 ? value : undefined;
    } catch {
        return undefined;
    }
}

/** git's own value quoting rules: quote when the value carries syntax, and escape `\` and `"` inside. */
function quote(value: string): string {
    if (!/[\s"'#;\\]/.test(value)) {
        return value;
    }

    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
