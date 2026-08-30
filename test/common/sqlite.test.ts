import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
    migrateSqliteDatabase,
    SqliteDatabase,
    SqliteDatabaseClosedError,
    SqliteInactiveTransactionViewError,
    SqliteTransactionCompletedError,
} from "../../src/common/sqlite";

async function temporaryDatabase(): Promise<{ directory: string; database: SqliteDatabase }> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-sqlite-"));
    const database = await SqliteDatabase.open(path.join(directory, "database.sqlite"));
    return { directory, database };
}

describe("SqliteDatabase", () => {
    it("applies each migration once and records the schema version", async () => {
        const database = await SqliteDatabase.open(":memory:");
        try {
            let applied = 0;
            const migrations = [
                { version: 1, async apply(db: SqliteDatabase) { applied++; await db.exec("CREATE TABLE one (value TEXT)"); } },
                { version: 2, async apply(db: SqliteDatabase) { applied++; await db.exec("ALTER TABLE one ADD COLUMN second TEXT"); } },
            ];

            await migrateSqliteDatabase(database, migrations);
            await migrateSqliteDatabase(database, migrations);

            expect(applied).toBe(2);
            const version = await database.get<{ user_version: number }>("PRAGMA user_version");
            expect(version?.user_version).toBe(2);
        } finally {
            await database.close();
        }
    });

    it("rolls back a failed migration", async () => {
        const database = await SqliteDatabase.open(":memory:");
        try {
            await expect(migrateSqliteDatabase(database, [{
                version: 1,
                async apply(db) {
                    await db.exec("CREATE TABLE temporary (value TEXT)");
                    throw new Error("migration failed");
                },
            }])).rejects.toThrow("migration failed");

            const version = await database.get<{ user_version: number }>("PRAGMA user_version");
            expect(version?.user_version).toBe(0);
            await expect(database.get("SELECT * FROM temporary")).rejects.toThrow();
        } finally {
            await database.close();
        }
    });

    it("uses savepoints for nested transactions and lets the outer transaction continue", async () => {
        const database = await SqliteDatabase.open(":memory:");
        try {
            await database.exec("CREATE TABLE values_table (value TEXT NOT NULL)");
            let nestedDatabase: SqliteDatabase | undefined;

            await database.transaction(async (outer) => {
                await outer.run("INSERT INTO values_table (value) VALUES (?)", "outer-before");
                await expect(outer.transaction(async (inner) => {
                    nestedDatabase = inner;
                    await inner.run("INSERT INTO values_table (value) VALUES (?)", "inner");
                    throw new Error("nested failure");
                })).rejects.toThrow("nested failure");
                await outer.run("INSERT INTO values_table (value) VALUES (?)", "outer-after");
            });

            expect(nestedDatabase).not.toBe(database);
            const rows = await database.all<{ value: string }>("SELECT value FROM values_table ORDER BY rowid");
            expect(rows.map((row) => row.value)).toEqual(["outer-before", "outer-after"]);
        } finally {
            await database.close();
        }
    });

    it("supports awaited nested savepoints at arbitrary depth", async () => {
        const database = await SqliteDatabase.open(":memory:");
        try {
            await database.exec("CREATE TABLE values_table (value TEXT NOT NULL)");
            await database.transaction(async (outer) => {
                await outer.run("INSERT INTO values_table (value) VALUES (?)", "outer");
                await outer.transaction(async (inner) => {
                    await inner.run("INSERT INTO values_table (value) VALUES (?)", "inner");
                    await inner.transaction(async (deep) => {
                        await deep.run("INSERT INTO values_table (value) VALUES (?)", "deep");
                    });
                    await inner.run("INSERT INTO values_table (value) VALUES (?)", "inner-after");
                });
                await outer.run("INSERT INTO values_table (value) VALUES (?)", "outer-after");
            });
            expect(await database.all("SELECT value FROM values_table ORDER BY rowid")).toEqual([
                { value: "outer" },
                { value: "inner" },
                { value: "deep" },
                { value: "inner-after" },
                { value: "outer-after" },
            ]);
        } finally {
            await database.close();
        }
    });

    it("rejects captured parent transaction views inside nested callbacks", async () => {
        const database = await SqliteDatabase.open(":memory:");
        try {
            await database.exec("CREATE TABLE values_table (value TEXT NOT NULL)");
            await database.transaction(async (outer) => {
                await outer.run("INSERT INTO values_table (value) VALUES (?)", "outer-before");
                await outer.transaction(async (inner) => {
                    await expect(outer.run(
                        "INSERT INTO values_table (value) VALUES (?)",
                        "invalid-parent-write",
                    )).rejects.toBeInstanceOf(SqliteInactiveTransactionViewError);
                    await expect(outer.transaction(async () => {}))
                        .rejects.toBeInstanceOf(SqliteInactiveTransactionViewError);
                    await inner.run("INSERT INTO values_table (value) VALUES (?)", "inner");
                });
                await outer.run("INSERT INTO values_table (value) VALUES (?)", "outer-after");
            });
            expect(await database.all("SELECT value FROM values_table ORDER BY rowid")).toEqual([
                { value: "outer-before" },
                { value: "inner" },
                { value: "outer-after" },
            ]);
        } finally {
            await database.close();
        }
    });

    it("uses typed errors for completed transaction views and closed databases", async () => {
        const database = await SqliteDatabase.open(":memory:");
        let transactionView: SqliteDatabase | undefined;
        await database.transaction(async (transaction) => {
            transactionView = transaction;
        });

        await expect(transactionView!.get("SELECT 1"))
            .rejects.toBeInstanceOf(SqliteTransactionCompletedError);
        await database.close();
        await expect(database.get("SELECT 1"))
            .rejects.toBeInstanceOf(SqliteDatabaseClosedError);
    });

    it("does not let detached transaction views use a completed transaction", async () => {
        const database = await SqliteDatabase.open(":memory:");
        try {
            await database.exec("CREATE TABLE values_table (value TEXT NOT NULL)");
            let detached: Promise<unknown> | undefined;
            await expect(database.transaction(async (transaction) => {
                detached = transaction.run("INSERT INTO missing_table (value) VALUES (?)", "detached");
                void detached.catch(() => {});
                await new Promise<void>((resolve) => setTimeout(resolve, 25));
            })).rejects.toThrow("no such table");
            await expect(detached).rejects.toThrow("no such table");
            expect(await database.all("SELECT * FROM values_table")).toEqual([]);
        } finally {
            await database.close();
        }
    });

    it("waits for detached nested savepoints before committing the outer transaction", async () => {
        const database = await SqliteDatabase.open(":memory:");
        try {
            await database.exec("CREATE TABLE values_table (value TEXT NOT NULL)");
            let nested: Promise<unknown> | undefined;
            await database.transaction(async (outer) => {
                await outer.run("INSERT INTO values_table (value) VALUES (?)", "outer");
                nested = outer.transaction(async (inner) => {
                    await new Promise<void>((resolve) => setTimeout(resolve, 25));
                    await inner.run("INSERT INTO values_table (value) VALUES (?)", "nested");
                    throw new Error("nested failure");
                });
                void nested.catch(() => {});
            });
            await expect(nested).rejects.toThrow("nested failure");
            expect(await database.all("SELECT * FROM values_table")).toEqual([{ value: "outer" }]);
        } finally {
            await database.close();
        }
    });

    it("serializes outer operations after detached nested savepoints", async () => {
        const database = await SqliteDatabase.open(":memory:");
        try {
            await database.exec("CREATE TABLE values_table (value TEXT NOT NULL)");
            let nested: Promise<unknown> | undefined;
            await database.transaction(async (outer) => {
                await outer.run("INSERT INTO values_table (value) VALUES (?)", "outer-before");
                nested = outer.transaction(async (inner) => {
                    await new Promise<void>((resolve) => setTimeout(resolve, 25));
                    await inner.run("INSERT INTO values_table (value) VALUES (?)", "nested");
                    throw new Error("nested failure");
                });
                void nested.catch(() => {});
                await outer.run("INSERT INTO values_table (value) VALUES (?)", "outer-after");
            });
            await expect(nested).rejects.toThrow("nested failure");
            expect(await database.all("SELECT value FROM values_table ORDER BY rowid")).toEqual([
                { value: "outer-before" },
                { value: "outer-after" },
            ]);
        } finally {
            await database.close();
        }
    });

    it("keeps settled detached nested failures isolated from the outer transaction", async () => {
        const database = await SqliteDatabase.open(":memory:");
        try {
            await database.exec("CREATE TABLE values_table (value TEXT NOT NULL)");
            let nested: Promise<unknown> | undefined;
            await database.transaction(async (outer) => {
                await outer.run("INSERT INTO values_table (value) VALUES (?)", "outer");
                nested = outer.transaction(async (inner) => {
                    await inner.run("INSERT INTO values_table (value) VALUES (?)", "nested");
                    throw new Error("nested failure");
                });
                void nested.catch(() => {});
                await new Promise<void>((resolve) => setTimeout(resolve, 25));
            });
            await expect(nested).rejects.toThrow("nested failure");
            expect(await database.all("SELECT * FROM values_table")).toEqual([{ value: "outer" }]);
        } finally {
            await database.close();
        }
    });

    it("queues close behind an active transaction", async () => {
        const database = await SqliteDatabase.open(":memory:");
        let closePromise: Promise<void> | undefined;
        await database.transaction(async (transaction) => {
            closePromise = database.close();
            await transaction.run("CREATE TABLE values_table (value TEXT NOT NULL)");
        });
        await closePromise;
    });

    it("rolls back the entire outer transaction on failure", async () => {
        const database = await SqliteDatabase.open(":memory:");
        try {
            await database.exec("CREATE TABLE values_table (value TEXT NOT NULL)");
            await expect(database.transaction(async (transaction) => {
                await transaction.run("INSERT INTO values_table (value) VALUES (?)", "not-committed");
                throw new Error("outer failure");
            })).rejects.toThrow("outer failure");

            expect(await database.all("SELECT value FROM values_table")).toEqual([]);
        } finally {
            await database.close();
        }
    });

    it("enables WAL for file-backed databases", async () => {
        const { directory, database } = await temporaryDatabase();
        try {
            const journal = await database.get<{ journal_mode: string }>("PRAGMA journal_mode");
            expect(journal?.journal_mode.toLowerCase()).toBe("wal");
        } finally {
            await database.close();
            await fs.rm(directory, { recursive: true, force: true });
        }
    });
});
