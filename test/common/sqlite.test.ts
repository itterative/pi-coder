import { describe, expect, it } from "vitest";

import { loadSqlite, migrateSqliteDatabase } from "../../src/common/sqlite";

describe("migrateSqliteDatabase", () => {
    it("applies each migration once and records the schema version", async () => {
        const { DatabaseSync } = await loadSqlite();
        const database = new DatabaseSync(":memory:");
        let applied = 0;
        const migrations = [
            { version: 1, apply: (db: DatabaseSync) => { applied++; db.exec("CREATE TABLE one (value TEXT)"); } },
            { version: 2, apply: (db: DatabaseSync) => { applied++; db.exec("ALTER TABLE one ADD COLUMN second TEXT"); } },
        ];

        migrateSqliteDatabase(database, migrations);
        migrateSqliteDatabase(database, migrations);

        expect(applied).toBe(2);
        expect((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
        database.close();
    });

    it("rolls back a failed migration", async () => {
        const { DatabaseSync } = await loadSqlite();
        const database = new DatabaseSync(":memory:");
        expect(() => migrateSqliteDatabase(database, [{
            version: 1,
            apply(db) {
                db.exec("CREATE TABLE temporary (value TEXT)");
                throw new Error("migration failed");
            },
        }])).toThrow("migration failed");

        expect((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(0);
        expect(() => database.prepare("SELECT * FROM temporary").all()).toThrow();
        database.close();
    });
});
