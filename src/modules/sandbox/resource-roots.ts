import fs from "node:fs";
import path from "node:path";

import {
    DefaultPackageManager,
    SettingsManager,
    getAgentDir,
} from "@earendil-works/pi-coding-agent";

import { PI_CODER_EXTENSION_DIR, getPiPackageDirectory } from "../../common/constants";
import { resolveHomeDirectory } from "../../common/home-directory";

/**
 * Read-only host roots that hold resources pi tells the agent to use.
 *
 * Skills and pi's own docs live outside the checkout, and neither backend mounted them: a container command
 * could not read `SKILL.md` or run a script the skill names, and bubblewrap asked for approval and then still
 * could not open the file. The install location is machine-specific, so it is derived rather than hardcoded:
 * this extension's package root (`PI_CODER_EXTENSION_DIR`), the running pi package, pi's managed package
 * stores, and the user-level skill directories.
 *
 * The standard roots are a superset that is cheap to compute and covers every managed install. They are
 * widened by {@link agentResourceRoots}, which asks pi's package manager for the exact resources it loaded so
 * a local package or an explicit `skills` path outside those stores is mounted too. Everything here is
 * read-only; nothing widens what a sandboxed command may write.
 */
export interface AgentResourceRootOptions {
    /** pi's agent directory. Defaults to pi's resolver, so `PI_CODING_AGENT_DIR` is honoured. */
    agentDir?: string;
    /** Environment used for `~` and `$HOME` expansion. */
    env?: NodeJS.ProcessEnv;
    /** This extension's package root. Injectable for tests; defaults to the running extension. */
    extensionDir?: string;
    /** `null` omits the running pi package; `undefined` resolves it. */
    piPackageDir?: string | null;
}

export interface AgentResourceRootsRequest extends AgentResourceRootOptions {
    /** Working directory pi resolves project-local skills and packages against. */
    cwd: string;
    /** Whether project settings and project packages are in play, as pi's own loader decides. */
    projectTrusted?: boolean;
}

/**
 * The roots that exist on this machine, in a stable order, deduplicated.
 *
 * A missing root is omitted rather than mounted: podman would silently create an empty directory for a
 * `--volume` source it cannot find, and bubblewrap would fail the whole command on a `--bind` of a missing
 * path.
 */
export function standardAgentResourceRoots(options: AgentResourceRootOptions = {}): string[] {
    const agentDir = options.agentDir ?? getAgentDir();
    const homeDir = resolveHomeDirectory(options.env);
    const piPackageDir =
        options.piPackageDir === null
            ? undefined
            : (options.piPackageDir ?? getPiPackageDirectory());

    const extensionDir = options.extensionDir ?? PI_CODER_EXTENSION_DIR;
    const candidates = [
        isPackageRoot(extensionDir) ? extensionDir : undefined,
        isPackageRoot(piPackageDir) ? piPackageDir : undefined,
        path.join(agentDir, "skills"),
        path.join(agentDir, "git"),
        path.join(agentDir, "npm"),
        path.join(agentDir, "tmp", "extensions"),
        path.join(homeDir, ".agents", "skills"),
    ];

    return dedupe(
        candidates.filter(
            (candidate): candidate is string => candidate !== undefined && isDirectory(candidate),
        ),
    );
}

/**
 * The standard roots plus the exact package and skill directories pi loaded.
 *
 * `DefaultPackageManager.resolve()` is pi's own resolver, so the mounted set follows the same settings,
 * filters, and install paths that produced the skill list in the system prompt. Missing packages are skipped
 * rather than installed: mounting is a read-only view operation and must not mutate the user's package store.
 *
 * A package resource resolves to its package root, so a skill that references a sibling file outside its own
 * directory still works. A top-level or auto-discovered skill resolves to the directory holding its
 * `SKILL.md`. Resolution is best-effort: a broken settings file or an unavailable package manager leaves the
 * standard roots in place, because failing a session over a prompt-side resource would be worse than the gap.
 */
export async function resolveAgentResourceRoots(
    request: AgentResourceRootsRequest,
): Promise<string[]> {
    const standard = standardAgentResourceRoots(request);
    let resolved: string[];

    try {
        resolved = await resolvedSkillRoots(request);
    } catch {
        resolved = [];
    }

    const roots = [...standard];

    for (const root of resolved) {
        if (!isDirectory(root) || roots.some((parent) => isWithin(root, parent))) {
            continue;
        }

        roots.push(root);
    }

    return roots;
}

/** One resolution per cwd/agent-dir/trust combination for the life of the process. */
const cache = new Map<string, Promise<string[]>>();

/**
 * {@link resolveAgentResourceRoots}, memoized.
 *
 * Both backends and the file gates ask for the same answer, often on the same command. The cache keeps that
 * from turning into a package-manager resolution per tool call; a package installed later in the process is
 * picked up on the next start, like every other resource pi loaded at startup.
 */
export function agentResourceRoots(request: AgentResourceRootsRequest): Promise<string[]> {
    const key = cacheKey(request);
    const cached = cache.get(key);

    if (cached !== undefined) {
        return cached;
    }

    const pending = resolveAgentResourceRoots(request);
    cache.set(key, pending);

    return pending;
}

/** Tests that change a temp agent dir or settings file must not inherit an earlier answer. */
export function clearAgentResourceRootsCache(): void {
    cache.clear();
}

async function resolvedSkillRoots(request: AgentResourceRootsRequest): Promise<string[]> {
    const agentDir = request.agentDir ?? getAgentDir();
    const settingsManager = SettingsManager.create(request.cwd, agentDir, {
        projectTrusted: request.projectTrusted === true,
    });
    const packageManager = new DefaultPackageManager({
        cwd: request.cwd,
        agentDir,
        settingsManager,
    });
    const resolved = await packageManager.resolve(async () => "skip");
    const roots: string[] = [];

    for (const skill of resolved.skills) {
        if (!skill.enabled) {
            continue;
        }

        // A package resource names the package, which is the unit whose sibling references are valid; a
        // top-level or auto-discovered skill only has its own directory.
        const root = skill.metadata.packageRoot ?? skillDirectory(skill.path);
        roots.push(root);
    }

    return roots;
}

/** `SKILL.md` resolves to its skill directory; an already-directory resource stays as it is. */
function skillDirectory(skillPath: string): string {
    if (isDirectory(skillPath)) {
        return skillPath;
    }

    return path.dirname(skillPath);
}

function isDirectory(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

/**
 * An extension package root, not whatever a bundled `import.meta.url` happened to resolve to.
 *
 * The scratch runner (and any bundled build) rewrites `import.meta.url`, which turns `PI_CODER_EXTENSION_DIR`
 * into the filesystem root. Mounting that read-only would hand the sandbox the whole host, so the package
 * manifest is the check that the path names the package rather than a bundler artefact.
 */
function isPackageRoot(candidate: string | undefined): candidate is string {
    return (
        candidate !== undefined &&
        isDirectory(candidate) &&
        fs.existsSync(path.join(candidate, "package.json"))
    );
}

/** A resolved package root already inside a standard root adds nothing but a second nested mount. */
function isWithin(candidate: string, parent: string): boolean {
    const relative = path.relative(parent, candidate);

    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function dedupe(values: readonly string[]): string[] {
    return [...new Set(values)];
}

function cacheKey(request: AgentResourceRootsRequest): string {
    return JSON.stringify([
        request.cwd,
        request.agentDir ?? getAgentDir(),
        resolveHomeDirectory(request.env),
        request.extensionDir ?? PI_CODER_EXTENSION_DIR,
        request.piPackageDir === undefined ? "<default>" : request.piPackageDir,
        request.projectTrusted === true,
    ]);
}
