import type { SandboxConfig } from "../../../common/config";
import { resolveSandboxPosture } from "../posture";

/**
 * A human-readable view of the sandbox settings that will actually apply.
 *
 * It reads the same resolver the backends read, so `/sandbox status` cannot describe a mount set the session
 * does not have: a path that would be dropped, remapped, or refused is shown as it will be, and the reasons are
 * returned as warnings for the caller to report. `create: false` keeps a status query from creating the
 * directories a `create: true` mount would.
 */
export interface SandboxSettingsSummary {
    lines: string[];
    warnings: string[];
}

export function describeSandboxSettings(
    config: SandboxConfig | null | undefined,
    cwd: string,
    env: NodeJS.ProcessEnv = process.env,
): SandboxSettingsSummary {
    const posture = resolveSandboxPosture({ cwd, config, role: "write", env, create: false });
    const lines: string[] = [];
    // The checkout and the runtime's own roots are not what a user configured, so they stay out of the view.
    const configured = posture.entries.filter(
        (entry) => entry.source !== cwd || entry.target !== cwd,
    );

    if (configured.length === 0) {
        lines.push("mounts: (none)");
    } else {
        lines.push("mounts:");

        for (const entry of configured) {
            const target = entry.target === entry.source ? "" : ` → ${entry.target}`;

            lines.push(`  ${entry.source}${target} (${entry.mode})`);
        }
    }

    lines.push(`network: ${posture.network.mode}`);

    if (posture.network.publish.length > 0) {
        lines.push(`ports: ${posture.network.publish.join(", ")}`);
    }

    if (posture.devices.paths.length > 0) {
        lines.push(`devices: ${posture.devices.paths.join(", ")}`);
    }

    return { lines, warnings: [...posture.warnings] };
}
