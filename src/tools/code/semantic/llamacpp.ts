import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

import type { ArtifactSpec } from "./artifacts";

/**
 * The pinned llama.cpp runtime.
 *
 * A release tarball rather than a build step or an npm dependency, for the same reason the ORT artifacts were pinned
 * downloads: the bytes are executed, so they are hash-verified, and nothing has to be compiled on the user's machine.
 * The release's executables carry `RUNPATH=$ORIGIN`, so `llama-server` finds the ~60 libraries beside it with no
 * environment to set up.
 *
 * Two bundles, one device decision. The Vulkan build reaches an AMD/NVIDIA/Intel GPU through the driver that is
 * already installed (Mesa's RADV on Linux needs no ROCm userspace), which measured ~11-20x a CPU build; the CPU build
 * is universal and is what a machine without a usable device gets. `resolveDevice` probes once per process, and the
 * device is chosen per role: builds take the GPU when there is one, queries stay on the CPU.
 */
export const LLAMA_TAG = "b12360";

const RELEASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}`;

export type LlamaDevice = "vulkan" | "cpu";

export interface LlamaBundle {
    device: LlamaDevice;
    /** Release asset flavour: `llama-<tag>-bin-<flavour>.tar.gz`. */
    flavour: string;
    sha256: string;
    bytes: number;
}

/**
 * The bundles, GPU first, because ordering is the preference.
 *
 * Sizes and digests are of the published assets. The CPU bundle is the smaller of the two and the only one that works
 * everywhere, so it is also the one whose absence is fatal.
 */
export const LLAMA_BUNDLES: readonly LlamaBundle[] = [
    {
        device: "vulkan",
        flavour: "ubuntu-vulkan-x64",
        sha256: "2133682fba36e101ec1059ee646287bd1768916d3d0479fa4d6135f40f02e309",
        bytes: 36_152_335,
    },
    {
        device: "cpu",
        flavour: "ubuntu-x64",
        sha256: "b60dc211e4ba206bb04bbc9eb06294364c43d0aab8fc308c44a361477466ba4c",
        bytes: 23_310_281,
    },
];

/** Platforms with a measured release asset. An unmeasured platform gets no bundle, not a guess. */
const LLAMA_PLATFORMS: ReadonlyArray<{ platform: NodeJS.Platform; arch: string }> = [
    { platform: "linux", arch: "x64" },
];

export function llamaSupported(
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): boolean {
    return LLAMA_PLATFORMS.some((entry) => entry.platform === platform && entry.arch === arch);
}

/** The archives this platform downloads, as ordinary artifact specs (a tarball is still a file with a digest). */
export function llamaArtifacts(
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): ArtifactSpec[] {
    if (!llamaSupported(platform, arch)) {
        return [];
    }

    return LLAMA_BUNDLES.map((bundle) => ({
        path: path.posix.join("llama", LLAMA_TAG, `${bundle.flavour}.tar.gz`),
        url: `${RELEASE}/llama-${LLAMA_TAG}-bin-${bundle.flavour}.tar.gz`,
        sha256: bundle.sha256,
        bytes: bundle.bytes,
    }));
}

/** Directory a bundle unpacks into, and where its `llama-server` lives. */
export function llamaBundleDir(modelDir: string, device: LlamaDevice): string {
    const bundle = LLAMA_BUNDLES.find((entry) => entry.device === device);

    if (bundle === undefined) {
        throw new Error(`semantic: no ${device} bundle for this platform`);
    }

    return path.join(modelDir, "llama", LLAMA_TAG, bundle.flavour);
}

export function llamaBinary(modelDir: string, device: LlamaDevice): string {
    return path.join(llamaBundleDir(modelDir, device), "llama-server");
}

/**
 * Unpack a bundle if its `llama-server` is not already there, and return the binary path.
 *
 * The archive itself stays on disk: it is 23 MB, it is what `artifactsPresent` checks by size, and keeping it means a
 * clobbered bundle can be restored without a download. Extraction goes to a temporary directory and is renamed into
 * place, so a killed build cannot leave a half-unpacked runtime that looks installed.
 */
export function ensureLlamaBundle(modelDir: string, device: LlamaDevice): string {
    const binary = llamaBinary(modelDir, device);
    const dir = llamaBundleDir(modelDir, device);

    if (isExecutable(binary)) {
        return binary;
    }

    const bundle = LLAMA_BUNDLES.find((entry) => entry.device === device);
    const archive = path.join(modelDir, "llama", LLAMA_TAG, `${bundle?.flavour ?? ""}.tar.gz`);

    if (!fs.existsSync(archive)) {
        throw new Error(
            `semantic: llama.cpp ${device} runtime is not downloaded (${path.relative(modelDir, archive)}); /outline on fetches it`,
        );
    }

    const staging = `${dir}.tmp.${process.pid}`;
    fs.rmSync(staging, { recursive: true, force: true });
    extractTarGz(archive, staging, 1);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.renameSync(staging, dir);

    if (!isExecutable(binary)) {
        throw new Error(`semantic: llama.cpp ${device} bundle unpacked without llama-server`);
    }

    return binary;
}

function isExecutable(file: string): boolean {
    try {
        fs.accessSync(file, fs.constants.X_OK);

        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

/** Device names Mesa uses for its software rasteriser, which is a GPU only in the loosest sense. */
const SOFTWARE_DEVICES = ["llvmpipe", "swiftshader", "softpipe", "lavapipe"];

/** One row of `llama-server --list-devices`. */
export interface VulkanDevice {
    /** The backend's own name, e.g. `Vulkan0`; this is what `--device` takes. */
    id: string;
    /** Human description, e.g. `AMD Radeon Graphics (RADV GFX1201)`. */
    name: string;
    /** Free VRAM in MiB, or `Infinity` when the listing did not report it. */
    freeMiB: number;
}

/**
 * Parse `--list-devices` output.
 *
 * The shape is `  Vulkan0: AMD Radeon Graphics (RADV GFX1201) (16304 MiB, 3471 MiB free)`, one line per device below
 * `Available devices:`. Free memory is parsed because it is what breaks a tie on a multi-GPU machine, where the first
 * device in the list is usually the integrated one.
 */
export function parseVulkanDevices(text: string): VulkanDevice[] {
    const from = text.indexOf("Available devices:");

    if (from < 0) {
        return [];
    }

    const devices: VulkanDevice[] = [];

    for (const line of text.slice(from).split("\n").slice(1)) {
        const match = /^\s*([A-Za-z]+\d+):\s*(.+?)\s*$/.exec(line);

        if (match === null) {
            continue;
        }

        const id = match[1] ?? "";
        const description = match[2] ?? "";

        if (
            id.length === 0 ||
            SOFTWARE_DEVICES.some((soft) => description.toLowerCase().includes(soft))
        ) {
            continue;
        }

        const free = /([\d.]+)\s*MiB free/i.exec(description)?.[1];

        devices.push({
            id,
            name: description.replace(/\s*\([^()]*\)\s*$/, ""),
            freeMiB: free === undefined ? Number.POSITIVE_INFINITY : Number(free),
        });
    }

    return devices;
}

/** Ask a Vulkan binary what it can see. Empty for a missing binary, a broken driver, or a software-only list. */
export async function listVulkanDevices(binary: string): Promise<VulkanDevice[]> {
    const run = promisify(execFile);

    try {
        const { stdout, stderr } = await run(binary, ["--list-devices"], {
            timeout: 30_000,
            maxBuffer: 1 << 20,
        });

        return parseVulkanDevices(`${stdout}\n${stderr}`);
    } catch {
        return [];
    }
}

/**
 * Whether the Vulkan bundle can see a hardware device.
 *
 * `--list-devices` loads no model, so this costs a process start (~120 ms) rather than a load, and it answers the
 * question the log would: an llvmpipe-only machine "supports" Vulkan and runs embeddings on the CPU with more
 * overhead than the CPU bundle — strictly worse, and silently so.
 */
export async function hasVulkanDevice(binary: string): Promise<boolean> {
    return (await listVulkanDevices(binary)).length > 0;
}

/**
 * Which device to pin.
 *
 * `PI_CODER_OUTLINE_VULKAN_DEVICE` names one (`Vulkan1`), and otherwise the device with the most free VRAM wins: on a
 * machine with two GPUs the first in the list is usually the integrated one, and the model would land on it while the
 * discrete card sat idle.
 */
export function pickVulkanDevice(
    devices: readonly VulkanDevice[],
    override?: string,
): VulkanDevice | undefined {
    const wanted = (override ?? "").trim().toLowerCase();

    if (wanted.length > 0) {
        const named = devices.find((device) => device.id.toLowerCase() === wanted);

        if (named !== undefined) {
            return named;
        }
    }

    return devices.reduce<VulkanDevice | undefined>(
        (best, device) => (best === undefined || device.freeMiB > best.freeMiB ? device : best),
        undefined,
    );
}

/** What a caller will accept, before the probe decides whether the GPU is real. */
export type DevicePreference = "auto" | "cpu" | "vulkan";

export interface DeviceChoice {
    device: LlamaDevice;
    binary: string;
    /**
     * The one Vulkan device to pin, e.g. `Vulkan0`.
     *
     * Present only for a GPU choice, and it is never absent by accident: `-ngl` on its own offloads to every visible
     * device and splits the model's layers across them, which on a two-GPU machine pipelines a 640 MB model over PCIe
     * and is slower than one card.
     */
    deviceId?: string;
    /** Why this device, for `/outline status` to say something better than "cpu". */
    reason: string;
}

/** Cached probe result; a broken driver makes `--list-devices` slow enough to notice being repeated. */
let vulkanProbe: { devices: readonly VulkanDevice[]; chosen: VulkanDevice | undefined } | undefined;

/** What the probe found, or `undefined` while no runtime has needed a device yet. */
export function vulkanStatus(): boolean | undefined {
    return vulkanProbe === undefined ? undefined : vulkanProbe.chosen !== undefined;
}

/** The device a build would pin, once the probe has run. */
export function vulkanDevice(): VulkanDevice | undefined {
    return vulkanProbe?.chosen;
}

/**
 * What a role should use, before the probe runs.
 *
 * Queries default to the CPU and builds to "auto", and the asymmetry is deliberate. A query is one short text, where a
 * GPU buys ~40 ms; a batch import is thousands, where it is 20x. Keeping queries on the CPU is also what lets the
 * build server be transient: a GPU is held only while a build runs, never at query time, so a user doing their own GPU
 * work does not have to reserve VRAM for a search tool.
 *
 * `PI_CODER_OUTLINE_QUERY_DEVICE` / `PI_CODER_OUTLINE_BUILD_DEVICE` set one role, and `PI_CODER_OUTLINE_DEVICE` sets
 * both at once; a role variable wins over the blunt one.
 */
export function devicePreference(
    role: "query" | "build",
    env: NodeJS.ProcessEnv = process.env,
): DevicePreference {
    const parse = (raw: string | undefined): DevicePreference | undefined => {
        const value = (raw ?? "").trim().toLowerCase();

        return value === "cpu" || value === "vulkan" || value === "auto" ? value : undefined;
    };

    let preference = parse(
        role === "query" ? env.PI_CODER_OUTLINE_QUERY_DEVICE : env.PI_CODER_OUTLINE_BUILD_DEVICE,
    );
    preference = preference ?? parse(env.PI_CODER_OUTLINE_DEVICE);
    preference = preference ?? (role === "query" ? "cpu" : "auto");

    return preference;
}

/**
 * Resolve a preference into a device and a binary.
 *
 * `PI_CODER_OUTLINE_LLAMA_SERVER` replaces the binary while keeping the requested device, which is how tests drive both
 * paths with a double. A "vulkan" request that cannot be satisfied throws here; the runtime catches it and falls back,
 * because a machine whose VRAM is already taken is a normal state rather than an error.
 */
export async function resolveDevice(
    modelDir: string,
    preference: DevicePreference = "auto",
    env: NodeJS.ProcessEnv = process.env,
): Promise<DeviceChoice> {
    const override = (env.PI_CODER_OUTLINE_LLAMA_SERVER ?? "").trim();
    const binaryFor = (device: LlamaDevice): string =>
        override.length > 0 ? path.resolve(override) : ensureLlamaBundle(modelDir, device);
    const requestedId = (env.PI_CODER_OUTLINE_VULKAN_DEVICE ?? "").trim();

    if (preference === "cpu") {
        return { device: "cpu", binary: binaryFor("cpu"), reason: "cpu requested" };
    }

    let probeBinary: string | undefined;

    try {
        probeBinary = binaryFor("vulkan");
    } catch (error) {
        // "auto" must not fail on a machine that simply never downloaded the GPU bundle.
        if (preference === "vulkan") {
            throw error;
        }

        return { device: "cpu", binary: binaryFor("cpu"), reason: "Vulkan bundle not installed" };
    }

    // A test double stands in for the binary, so it has no device list to offer and the override names the device.
    const devices = override.length > 0 ? [] : await listVulkanDevices(probeBinary);
    const chosen =
        override.length > 0
            ? {
                  id: requestedId.length > 0 ? requestedId : "Vulkan0",
                  name: override,
                  freeMiB: Number.POSITIVE_INFINITY,
              }
            : pickVulkanDevice(devices, requestedId);

    vulkanProbe = { devices, chosen };

    if (chosen !== undefined) {
        return {
            device: "vulkan",
            binary: probeBinary,
            deviceId: chosen.id,
            reason:
                chosen.freeMiB === Number.POSITIVE_INFINITY
                    ? `hardware Vulkan device ${chosen.id}`
                    : `hardware Vulkan device ${chosen.id} (${(chosen.freeMiB / 1024).toFixed(1)} GiB free)`,
        };
    }

    if (preference === "vulkan") {
        throw new Error("semantic: no hardware Vulkan device found");
    }

    return {
        device: "cpu",
        binary: binaryFor("cpu"),
        reason: "no hardware Vulkan device (software rasteriser only)",
    };
}

/** The configured build device, resolved. Kept for callers (status, tests) that want a single answer. */
export async function selectLlamaDevice(
    modelDir: string,
    env: NodeJS.ProcessEnv = process.env,
): Promise<DeviceChoice> {
    return resolveDevice(modelDir, devicePreference("build", env), env);
}

/** Test seam: forget the probe result. */
export function resetLlamaDevice(): void {
    vulkanProbe = undefined;
}

/**
 * Unpack a `.tar.gz` into `dest`, without a tar binary or a dependency.
 *
 * `stripComponents` matches tar's flag of the same name. The archive is a downloaded artifact, so every name is treated as
 * hostile: absolute paths, `..` segments, and
 * device nodes are dropped. Only regular files, directories, symlinks (the release uses them for the versioned
 * library names), and hardlinks are created.
 */
export function extractTarGz(archive: string, dest: string, stripComponents = 0): void {
    const blob = zlib.gunzipSync(fs.readFileSync(archive));
    fs.mkdirSync(dest, { recursive: true });

    let offset = 0;
    let pendingName: string | undefined;

    while (offset + 512 <= blob.length) {
        const header = blob.subarray(offset, offset + 512);

        if (header.every((byte) => byte === 0)) {
            // Two zero blocks end the archive; one is enough to stop reading.
            break;
        }

        const rawName = readString(header, 0, 100);
        const mode = Number.parseInt(readString(header, 100, 8).trim() || "644", 8);
        const size = Number.parseInt(readString(header, 124, 12).trim() || "0", 8);
        const type = String.fromCharCode(header[156] ?? 0);
        const linkName = readString(header, 157, 100);
        const prefix = readString(header, 345, 155);
        const name = pendingName ?? (prefix.length > 0 ? `${prefix}/${rawName}` : rawName);
        pendingName = undefined;

        const body = blob.subarray(offset + 512, offset + 512 + size);

        if (type === "L") {
            // GNU long name: the real name is this entry's body, and applies to the next header.
            pendingName = body.toString("utf8").replace(/\0+$/, "");

            offset += 512 + Math.ceil(size / 512) * 512;
            continue;
        }

        if (type === "x" || type === "g") {
            // pax extended headers carry names longer than 100 bytes; the release has none, and skipping is safer
            // than misparsing one into a path.
            offset += 512 + Math.ceil(size / 512) * 512;
            continue;
        }

        // Release archives wrap everything in one directory whose name does not match the asset name
        // (`llama-b12360/` inside `...-bin-ubuntu-x64.tar.gz`), so this strips leading components like tar's flag.
        const relative = strip(name, stripComponents);
        const target = relative.length === 0 ? undefined : safeJoin(dest, relative);

        if (target !== undefined) {
            if (type === "5") {
                fs.mkdirSync(target, { recursive: true });
            } else if (type === "0" || type === "\0" || type === "7") {
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, body);
                fs.chmodSync(target, mode & 0o777);
            } else if (type === "2") {
                // A symlink's target is a relative path *inside* the archive, not a member name, so it is never
                // stripped — the release uses these for its versioned library names.
                fs.rmSync(target, { force: true });
                fs.symlinkSync(linkName, target);
            } else if (type === "1") {
                const source = safeJoin(dest, strip(linkName, stripComponents));

                if (source !== undefined && fs.existsSync(source)) {
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                    fs.linkSync(source, target);
                }
            }
        }

        offset += 512 + Math.ceil(size / 512) * 512;
    }
}

/** `tar --strip-components=N`: drop the first N path segments, so a wrapped archive lands flat. */
function strip(name: string, components: number): string {
    const parts = name.split("/").filter((part) => part.length > 0);

    return parts.slice(components).join("/");
}

function readString(header: Buffer, start: number, length: number): string {
    const slice = header.subarray(start, start + length);
    const end = slice.indexOf(0);

    return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function safeJoin(root: string, relative: string): string | undefined {
    const normalized = path.normalize(relative);

    if (normalized.startsWith("..") || path.isAbsolute(normalized) || normalized === ".") {
        return undefined;
    }

    return path.join(root, normalized);
}
