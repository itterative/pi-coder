import path from "node:path";

/** Mirrors pi's cwd encoding for extension-local per-project state directories. */
export function normalizeCwdForSessionDirectory(cwd: string): string {
    const resolvedCwd = path.resolve(cwd);
    return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Creates a stable, filesystem-safe label for a user-visible state directory. */
export function slugifyPathComponent(value: string, fallback = "workspace"): string {
    const slug = value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
    return slug || fallback;
}
