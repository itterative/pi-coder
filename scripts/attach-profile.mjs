/**
 * CPU-profile a *running* pi process, without restarting it.
 *
 * The question this answers is "is the main thread busy, and in whose code" — the difference between our
 * extension blocking the event loop (a stall a child can also cause, because children share the process) and
 * pi core spending time on a large session's rendering, transcript appends, or compaction.
 *
 * Attaching works by sending `SIGUSR1`, which makes Node open its inspector on 127.0.0.1:9229, then driving
 * `Profiler.*` over the DevTools protocol with the global WebSocket. No flags, no reload, no extension code.
 *
 * Usage:
 *   node scripts/attach-profile.mjs [seconds] [--pid <pid>]
 *
 * Run it on the host (a pi container cannot see the host's processes). While it profiles, reproduce the
 * stall in pi. The profile is written to `.state/perf/` so it is readable from a sandboxed session too, and
 * importing it into Chrome DevTools shows the full flame graph.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const INSPECTOR_PORT = 9229;
const DEFAULT_SECONDS = 20;
const SAMPLE_INTERVAL_US = 500;
const TOP_COUNT = 25;

function parseArgs(argv) {
    const seconds = [];
    let pid;

    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];

        if (value === "--pid") {
            index += 1;
            pid = Number(argv[index]);
        } else if (value.startsWith("--pid=")) {
            pid = Number(value.slice("--pid=".length));
        } else if (value === "--help" || value === "-h") {
            printHelp();
            process.exit(0);
        } else {
            seconds.push(Number(value));
        }
    }

    const duration = seconds.find((value) => Number.isFinite(value) && value > 0);

    return { durationSeconds: duration ?? DEFAULT_SECONDS, pid };
}

function printHelp() {
    process.stdout.write(
        [
            "Usage: node scripts/attach-profile.mjs [seconds] [--pid <pid>]",
            "",
            `  seconds   how long to profile (default ${DEFAULT_SECONDS})`,
            "  --pid     attach to this pid instead of auto-detecting a pi process",
            "",
            "Run on the host: a sandboxed pi session cannot see host processes.",
            "",
        ].join("\n"),
    );
}

/** Candidate pi processes on the host, newest first. The container's own dispatcher is excluded. */
function findPiPids() {
    const lines = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).split("\n");
    const candidates = [];

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === "") {
            continue;
        }

        const separator = trimmed.indexOf(" ");
        const pid = Number(trimmed.slice(0, separator));
        const args = trimmed.slice(separator + 1);

        if (!Number.isFinite(pid) || pid === process.pid) {
            continue;
        }

        if (!args.includes("node") || args.includes("attach-profile")) {
            continue;
        }

        const isPi = args.includes("pi-coding-agent") || /\/bin\/pi(\s|$)/.test(args);
        const isDispatcher = args.includes("dispatch.mjs");

        if (isPi && !isDispatcher) {
            candidates.push({ pid, args });
        }
    }

    return candidates;
}

function resolvePid(explicit) {
    if (explicit !== undefined) {
        return explicit;
    }

    const candidates = findPiPids();

    if (candidates.length === 0) {
        throw new Error(
            "no running pi process found; pass --pid <pid> (run this on the host, not inside a container)",
        );
    }

    if (candidates.length > 1) {
        process.stderr.write(
            `found ${candidates.length} candidates, attaching to the first:\n` +
                candidates.map((entry) => `  ${entry.pid}  ${entry.args.slice(0, 120)}\n`).join(""),
        );
    }

    return candidates[0].pid;
}

async function inspectorUrl(pid) {
    try {
        process.kill(pid, "SIGUSR1");
    } catch (error) {
        throw new Error(`cannot signal pid ${pid}: ${error.message}`, { cause: error });
    }

    for (let attempt = 0; attempt < 50; attempt += 1) {
        await delay(200);

        try {
            const response = await fetch(`http://127.0.0.1:${INSPECTOR_PORT}/json/list`);
            const targets = await response.json();
            const target = targets.find((entry) => typeof entry.webSocketDebuggerUrl === "string");

            if (target !== undefined) {
                return target.webSocketDebuggerUrl;
            }
        } catch {
            // The inspector is still starting up.
        }
    }

    throw new Error(
        `pid ${pid} did not open an inspector on ${INSPECTOR_PORT}; is it a Node process, and is the port free?`,
    );
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A minimal DevTools-protocol client: send numbered requests, resolve by id. */
class CdpClient {
    #socket;
    #nextId = 1;
    #pending = new Map();

    static async connect(url) {
        const client = new CdpClient();
        const socket = new WebSocket(url);

        await new Promise((resolve, reject) => {
            socket.addEventListener("open", resolve, { once: true });
            socket.addEventListener(
                "error",
                () => reject(new Error("inspector connection failed")),
                {
                    once: true,
                },
            );
        });

        client.#socket = socket;

        socket.addEventListener("message", (event) => {
            const message = JSON.parse(event.data);
            const pending = client.#pending.get(message.id);

            if (pending === undefined) {
                return;
            }

            client.#pending.delete(message.id);

            if (message.error === undefined) {
                pending.resolve(message.result);
            } else {
                pending.reject(new Error(message.error.message));
            }
        });

        return client;
    }

    send(method, params = {}) {
        const id = this.#nextId;

        this.#nextId += 1;

        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
            this.#socket.send(JSON.stringify({ id, method, params }));
        });
    }

    close() {
        this.#socket.close();
    }
}

function categorize(url) {
    if (url === "" || url === "(?)") {
        return "native/unknown";
    }
    if (url.startsWith("node:")) {
        return "node runtime";
    }
    if (url.includes("/node_modules/@earendil-works/")) {
        return "pi core";
    }
    if (url.includes("/pi-coder/")) {
        return "pi-coder";
    }
    if (url.includes("/node_modules/")) {
        return "dependencies";
    }
    // A bundled extension can lose its repository path: pi's loader may serve it from a temp bundle, in which
    // case even this misses and only the frame names identify it.
    if (url.includes("/pi-coder/")) {
        return "pi-coder";
    }

    return "other";
}

function shortUrl(url) {
    if (url === "" || url === "(?)") {
        return "(native)";
    }

    const marker = "/node_modules/";

    if (url.includes(marker)) {
        return `…/node_modules/${url.slice(url.indexOf(marker) + marker.length)}`;
    }

    const piCoder = "/pi-coder/";

    if (url.includes("/pi-coder/")) {
        return url.slice(url.indexOf(piCoder) + piCoder.length);
    }

    return url;
}

const IDLE_FRAMES = new Set(["(idle)", "(program)", "(root)"]);

/**
 * The longest stretch of consecutive non-idle samples.
 *
 * This is the shape of "the event loop stopped": one run of samples with no idle between them, and the frames
 * inside that run are what held it. A stall caused by waiting on a promise instead shows up as idle time with
 * no long run, which is why the two are reported apart rather than as one total.
 */
function longestBlock(profile, frameById) {
    const samples = profile.samples ?? [];
    const deltas = profile.timeDeltas ?? [];

    let best = { us: 0, frames: new Map() };
    let current = { us: 0, frames: new Map() };

    const flush = () => {
        if (current.us > best.us) {
            best = current;
        }

        current = { us: 0, frames: new Map() };
    };

    for (let index = 0; index < samples.length; index += 1) {
        const entry = frameById.get(samples[index]);
        const delta =
            typeof deltas[index] === "number" && deltas[index] > 0
                ? deltas[index]
                : SAMPLE_INTERVAL_US;

        if (entry === undefined || IDLE_FRAMES.has(entry.name)) {
            flush();
            continue;
        }

        current.us += delta;
        const key = `${shortUrl(entry.url)}:${entry.line} ${entry.name}`;
        const frame = current.frames.get(key) ?? { selfUs: 0 };
        frame.selfUs += delta;
        current.frames.set(key, frame);
    }

    flush();

    return {
        us: best.us,
        frames: [...best.frames.entries()]
            .toSorted((a, b) => b[1].selfUs - a[1].selfUs)
            .slice(0, 8)
            .map(([key, value]) => ({ key, selfUs: value.selfUs })),
    };
}

/** Self time per call frame, from the sampled deltas; `hitCount * interval` when deltas are absent. */
function aggregate(profile) {
    const frameById = new Map();

    for (const node of profile.nodes) {
        const frame = node.callFrame;

        frameById.set(node.id, {
            name: frame.functionName.length > 0 ? frame.functionName : "(anonymous)",
            url: frame.url,
            line: frame.lineNumber + 1,
            selfUs: 0,
            samples: 0,
        });
    }

    const samples = profile.samples ?? [];
    const deltas = profile.timeDeltas ?? [];

    for (let index = 0; index < samples.length; index += 1) {
        const entry = frameById.get(samples[index]);

        if (entry === undefined) {
            continue;
        }

        const delta = deltas[index];
        const weight = typeof delta === "number" && delta > 0 ? delta : SAMPLE_INTERVAL_US;

        entry.selfUs += weight;
        entry.samples += 1;
    }

    const rows = [...frameById.values()].filter((entry) => entry.selfUs > 0);
    const totalUs = rows.reduce((sum, entry) => sum + entry.selfUs, 0);

    return { rows: rows.toSorted((a, b) => b.selfUs - a.selfUs), totalUs, frameById };
}

function report(profile, durationSeconds) {
    const { rows, totalUs, frameById } = aggregate(profile);
    const idle = rows.filter((row) => ["(idle)", "(program)", "(root)"].includes(row.name));
    const idleUs = idle.reduce((sum, row) => sum + row.selfUs, 0);
    const wallMs = (profile.endTime - profile.startTime) / 1000;
    const busyMs = Number.isFinite(wallMs) ? wallMs - idleUs / 1000 : totalUs / 1000;

    const byCategory = new Map();

    for (const row of rows) {
        const category = categorize(row.url);
        byCategory.set(category, (byCategory.get(category) ?? 0) + row.selfUs);
    }

    const lines = [];
    const pct = (us) => `${((us / Math.max(totalUs, 1)) * 100).toFixed(1)}%`.padStart(6);

    lines.push(
        `profiled ${durationSeconds}s, ${rows.length} distinct frames, ${(totalUs / 1e6).toFixed(2)}s of samples`,
    );
    lines.push(
        `main thread busy ~${(Math.max(busyMs, 0) / 1000).toFixed(2)}s (${(
            (Math.max(busyMs, 0) / Math.max(durationSeconds * 1000, 1)) *
            100
        ).toFixed(0)}% of the window), idle ~${(idleUs / 1e6).toFixed(2)}s`,
    );
    lines.push("");
    lines.push("self time by owner:");
    for (const [category, us] of [...byCategory.entries()].toSorted((a, b) => b[1] - a[1])) {
        lines.push(`  ${pct(us)}  ${(us / 1e3).toFixed(0).padStart(7)}ms  ${category}`);
    }
    lines.push("");
    lines.push("top frames by self time:");
    for (const row of rows.slice(0, TOP_COUNT)) {
        lines.push(`  ${pct(row.selfUs)}  ${shortUrl(row.url)}:${row.line}  ${row.name}`);
    }

    const block = longestBlock(profile, frameById);

    lines.push("");
    lines.push(`longest uninterrupted main-thread block: ${(block.us / 1000).toFixed(0)}ms`);
    for (const frame of block.frames) {
        lines.push(`  ${(frame.selfUs / 1000).toFixed(0).padStart(6)}ms  ${frame.key}`);
    }

    const ours = rows.filter((row) => categorize(row.url) === "pi-coder").slice(0, 15);

    lines.push("");
    lines.push("top pi-coder frames:");
    if (ours.length === 0) {
        lines.push("  (none sampled)");
    }
    for (const row of ours) {
        lines.push(`  ${pct(row.selfUs)}  ${shortUrl(row.url)}:${row.line}  ${row.name}`);
    }

    return lines.join("\n");
}

function profilePath(durationSeconds) {
    // Anchored to the script, not the caller's cwd: the profile has to land in the repository this session can
    // see, or it is written somewhere nobody reads.
    const directory = path.join(import.meta.dirname, "..", ".state", "perf");
    fs.mkdirSync(directory, { recursive: true });

    const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\..*$/, "");
    return path.join(directory, `pi-${stamp}-${durationSeconds}s.cpuprofile`);
}

async function main() {
    const { durationSeconds, pid } = parseArgs(process.argv.slice(2));
    const target = resolvePid(pid);

    process.stdout.write(`attaching to pid ${target}…\n`);

    const url = await inspectorUrl(target);
    const client = await CdpClient.connect(url);

    await client.send("Profiler.enable");
    await client.send("Profiler.setSamplingInterval", { interval: SAMPLE_INTERVAL_US });
    await client.send("Profiler.start");

    process.stdout.write(`profiling for ${durationSeconds}s — reproduce the stall now\n`);

    await delay(durationSeconds * 1000);

    const { profile } = await client.send("Profiler.stop");
    client.close();

    const output = profilePath(durationSeconds);

    fs.writeFileSync(output, JSON.stringify(profile));

    process.stdout.write(`\n${report(profile, durationSeconds)}\n`);
    process.stdout.write(`\nprofile written to ${output}\n`);
    process.stdout.write(
        "the inspector stays open on 127.0.0.1:9229 until pi restarts; restart it to close the port\n",
    );
}

main().catch((error) => {
    process.stderr.write(`attach-profile: ${error.message}\n`);
    process.exit(1);
});
