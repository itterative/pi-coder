import type { DatabaseSync } from "node:sqlite";

export interface SqliteMigration {
    version: number;
    apply(database: DatabaseSync): void;
}

let sqliteModulePromise: Promise<typeof import("node:sqlite")> | undefined;

/**
 * Loads node:sqlite while filtering only its known experimental warning.
 * The patch is restored immediately after module evaluation and all other
 * process warnings are forwarded unchanged.
 */
export function loadSqlite(): Promise<typeof import("node:sqlite")> {
    if (sqliteModulePromise) return sqliteModulePromise;

    const originalEmitWarning = process.emitWarning;
    const filteredEmitWarning = ((warning: string | Error, ...args: unknown[]) => {
        const name = typeof args[0] === "string"
            ? args[0]
            : typeof args[0] === "object" && args[0] !== null && "name" in args[0]
                ? (args[0] as { name?: unknown }).name
                : undefined;
        const message = warning instanceof Error ? warning.message : warning;
        if (name === "ExperimentalWarning" && message.includes("SQLite is an experimental feature")) return;
        return (originalEmitWarning as (...values: unknown[]) => void)(warning, ...args);
    }) as typeof process.emitWarning;
    process.emitWarning = filteredEmitWarning;

    sqliteModulePromise = import("node:sqlite").finally(() => {
        if (process.emitWarning === filteredEmitWarning) process.emitWarning = originalEmitWarning;
    });
    return sqliteModulePromise;
}

/** Applies ordered SQLite schema migrations atomically using PRAGMA user_version. */
export function migrateSqliteDatabase(
    database: DatabaseSync,
    migrations: readonly SqliteMigration[],
): void {
    const versions = migrations.map((migration) => migration.version);
    if (
        versions.some((version, index) => (
            !Number.isInteger(version)
            || version <= 0
            || (index > 0 && version <= versions[index - 1]!)
        ))
    ) {
        throw new Error("SQLite migrations must have strictly increasing positive integer versions.");
    }

    const row = database.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
    const currentVersion = typeof row?.user_version === "number" ? row.user_version : 0;
    const latestVersion = versions[versions.length - 1] ?? 0;
    if (currentVersion > latestVersion) {
        throw new Error(`SQLite database version ${currentVersion} is newer than supported version ${latestVersion}.`);
    }

    const pending = migrations.filter((migration) => migration.version > currentVersion);
    if (!pending.length) return;

    database.exec("BEGIN IMMEDIATE");
    try {
        for (const migration of pending) {
            migration.apply(database);
            database.exec(`PRAGMA user_version = ${migration.version}`);
        }
        database.exec("COMMIT");
    } catch (error) {
        try {
            database.exec("ROLLBACK");
        } catch {
            // Preserve the migration error if rollback itself fails.
        }
        throw error;
    }
}
