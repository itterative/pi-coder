import type { DatabaseSync } from "node:sqlite";

export interface SqliteMigration {
    version: number;
    apply(database: DatabaseSync): void;
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
