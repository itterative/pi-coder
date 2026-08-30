import { AsyncLocalStorage } from "node:async_hooks";

import sqlite3 from "sqlite3";
import { Database as SqliteDriverDatabase, ISqlite, open as openSqlite } from "sqlite";

export type SqliteRunResult = ISqlite.RunResult;
export type SqliteRow = Record<string, unknown>;
export type SqliteTransactionMode = "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE";

export class SqliteDatabaseClosedError extends Error {
    constructor() {
        super("SQLite database is closed.");
        this.name = "SqliteDatabaseClosedError";
    }
}

export class SqliteTransactionCompletedError extends Error {
    constructor() {
        super("SQLite transaction callback has already completed.");
        this.name = "SqliteTransactionCompletedError";
    }
}

export class SqliteInactiveTransactionViewError extends Error {
    constructor() {
        super("SQLite transaction view is not the active innermost transaction; use the database passed to the current transaction callback.");
        this.name = "SqliteInactiveTransactionViewError";
    }
}

const SQLITE_BUSY_RETRY_ATTEMPTS = 40;
const SQLITE_BUSY_RETRY_DELAY_MS = 25;

function isSqliteBusyError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const candidate = error as { code?: unknown; message?: unknown };
    const code = typeof candidate.code === "string" ? candidate.code : "";
    const message = typeof candidate.message === "string" ? candidate.message : "";
    return code === "SQLITE_BUSY"
        || code === "SQLITE_LOCKED"
        || /database is locked|database table is locked/i.test(message);
}

async function retrySqliteBusy<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            if (!isSqliteBusyError(error) || attempt >= SQLITE_BUSY_RETRY_ATTEMPTS) {
                throw error;
            }
            await new Promise<void>((resolve) => {
                setTimeout(resolve, Math.min(100, SQLITE_BUSY_RETRY_DELAY_MS * (attempt + 1)));
            });
        }
    }
}

export interface SqliteMigration {
    version: number;
    apply(database: SqliteDatabase): Promise<void>;
}

interface TransactionScope {
    active: boolean;
    pending: Set<Promise<unknown>>;
    operationTail: Promise<void>;
}

interface TransactionContext {
    database: SqliteDatabase;
    active: boolean;
    scope: TransactionScope;
}

function trackTransactionOperation<T>(
    scope: TransactionScope,
    operation: () => Promise<T>,
    retainRejection = true,
): Promise<T> {
    const operationResult = scope.operationTail.then(operation);
    scope.operationTail = operationResult.then(
        () => undefined,
        () => undefined,
    );
    const tracked = retainRejection
        ? operationResult
        : operationResult.then(
            () => undefined,
            () => undefined,
        );
    scope.pending.add(tracked);
    void tracked.then(
        () => scope.pending.delete(tracked),
        () => {},
    );
    return operationResult;
}

async function drainTransactionScope(scope: TransactionScope): Promise<void> {
    while (scope.pending.size > 0) {
        const results = await Promise.allSettled([...scope.pending]);
        const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure) throw failure.reason;
    }
}

/**
 * Promise-based SQLite database with task-local nested transactions.
 *
 * One wrapper owns one already-open sqlite3 connection. Database operations
 * are serialized so an outer transaction cannot be interleaved with another
 * task using the same connection. Nested transactions use savepoints.
 * Transaction callbacks receive a scoped view of the wrapper; work created
 * after a callback returns cannot accidentally use the completed transaction.
 */
export class SqliteDatabase {
    private static readonly transactions = new AsyncLocalStorage<TransactionContext>();

    private operationTail: Promise<void> = Promise.resolve();
    private closed = false;
    private closing = false;
    private closePromise?: Promise<void>;
    private readonly database: SqliteDriverDatabase;
    private readonly transactionScope?: TransactionScope;
    private readonly root: SqliteDatabase;

    private constructor(
        database: SqliteDriverDatabase,
        transactionScope?: TransactionScope,
        root?: SqliteDatabase,
    ) {
        this.database = database;
        this.transactionScope = transactionScope;
        this.root = root ?? this;
    }

    static async open(filename: string): Promise<SqliteDatabase> {
        const database = await openSqlite({
            filename,
            driver: sqlite3.Database,
        });
        const wrapper = new SqliteDatabase(database);
        try {
            wrapper.database.configure("busyTimeout", 5000);
            await retrySqliteBusy(() => wrapper.exec("PRAGMA journal_mode = WAL"));
            await wrapper.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
            return wrapper;
        } catch (error) {
            await wrapper.close();
            throw error;
        }
    }

    run(sql: string, ...params: unknown[]): Promise<SqliteRunResult> {
        return this.execute(() => this.database.run(sql, ...params));
    }

    get<T extends SqliteRow = SqliteRow>(sql: string, ...params: unknown[]): Promise<T | undefined> {
        return this.execute(() => this.database.get<T>(sql, ...params));
    }

    all<T extends SqliteRow = SqliteRow>(sql: string, ...params: unknown[]): Promise<T[]> {
        return this.execute(() => this.database.all<T[]>(sql, ...params));
    }

    exec(sql: string): Promise<void> {
        return this.execute(() => this.database.exec(sql));
    }

    transaction<T>(
        callback: (database: SqliteDatabase) => Promise<T>,
        mode: SqliteTransactionMode = "DEFERRED",
    ): Promise<T> {
        if (this.transactionScope && !this.transactionScope.active) {
            return Promise.reject(new SqliteTransactionCompletedError());
        }

        const active = SqliteDatabase.transactions.getStore();
        if (
            this.transactionScope
            && active?.database === this.root
            && active.active
            && active.scope !== this.transactionScope
        ) {
            return Promise.reject(new SqliteInactiveTransactionViewError());
        }
        if (active?.database === this.root && active.active) {
            const savepoint = `pi_coder_savepoint_${this.root.savepointCounter++}`;
            // Nested savepoints are independently recoverable: the outer
            // transaction waits for the savepoint to finish, but its failure
            // rolls back only the savepoint to preserve existing semantics.
            return trackTransactionOperation(
                active.scope,
                () => this.runSavepoint(callback, savepoint),
                false,
            );
        }

        if (this.root.closed || this.root.closing) {
            return Promise.reject(new SqliteDatabaseClosedError());
        }

        return this.root.enqueue(async () => {
            await retrySqliteBusy(() => this.execDirect(`BEGIN${mode === "DEFERRED" ? "" : ` ${mode}`}`));
            const scope: TransactionScope = {
                active: true,
                pending: new Set(),
                operationTail: Promise.resolve(),
            };
            const context: TransactionContext = { database: this.root, active: true, scope };
            return SqliteDatabase.transactions.run(context, async () => {
                try {
                    const result = await callback(new SqliteDatabase(this.database, scope, this.root));
                    scope.active = false;
                    context.active = false;
                    await drainTransactionScope(scope);
                    await retrySqliteBusy(() => this.execDirect("COMMIT"));
                    return result;
                } catch (error) {
                    scope.active = false;
                    context.active = false;
                    try {
                        await drainTransactionScope(scope);
                    } catch {
                        // Preserve the transaction callback error.
                    }
                    try {
                        await retrySqliteBusy(() => this.execDirect("ROLLBACK"));
                    } catch {
                        // Preserve the transaction callback error.
                    }
                    throw error;
                }
            });
        });
    }

    async close(): Promise<void> {
        if (this !== this.root) {
            return this.root.close();
        }
        if (this.closePromise) return this.closePromise;
        if (this.closed) return;
        this.closing = true;
        this.closePromise = this.enqueue(async () => {
            this.closed = true;
            await this.database.close();
        });
        return this.closePromise;
    }

    private savepointCounter = 0;

    private execute<T>(operation: () => Promise<T>): Promise<T> {
        const active = SqliteDatabase.transactions.getStore();
        if (this.transactionScope) {
            if (!this.transactionScope.active) {
                return Promise.reject(new SqliteTransactionCompletedError());
            }
            if (
                active?.database === this.root
                && active.active
                && active.scope !== this.transactionScope
            ) {
                return Promise.reject(new SqliteInactiveTransactionViewError());
            }
            return trackTransactionOperation(this.transactionScope, () => retrySqliteBusy(operation));
        }

        if (this.root.closed) return Promise.reject(new SqliteDatabaseClosedError());
        if (active?.database === this.root && active.active) {
            return Promise.reject(new Error("Use the transaction callback database for operations inside a transaction."));
        }
        if (this.root.closing) return Promise.reject(new SqliteDatabaseClosedError());
        return this.root.enqueue(async () => {
            if (this.root.closed) throw new SqliteDatabaseClosedError();
            return retrySqliteBusy(operation);
        });
    }

    private async runSavepoint<T>(
        callback: (database: SqliteDatabase) => Promise<T>,
        savepoint: string,
    ): Promise<T> {
        await retrySqliteBusy(() => this.root.execDirect(`SAVEPOINT ${savepoint}`));
        const scope: TransactionScope = {
            active: true,
            pending: new Set(),
            operationTail: Promise.resolve(),
        };
        const context: TransactionContext = { database: this.root, active: true, scope };
        return SqliteDatabase.transactions.run(context, async () => {
            try {
                const result = await callback(new SqliteDatabase(this.database, scope, this.root));
                scope.active = false;
                context.active = false;
                await drainTransactionScope(scope);
                await retrySqliteBusy(() => this.root.execDirect(`RELEASE SAVEPOINT ${savepoint}`));
                return result;
            } catch (error) {
                scope.active = false;
                context.active = false;
                try {
                    await drainTransactionScope(scope);
                } catch {
                    // Preserve the callback error if a detached operation failed.
                }
                try {
                    await retrySqliteBusy(() => this.root.execDirect(`ROLLBACK TO SAVEPOINT ${savepoint}`));
                    await retrySqliteBusy(() => this.root.execDirect(`RELEASE SAVEPOINT ${savepoint}`));
                } catch {
                    // Preserve the callback error if savepoint cleanup fails.
                }
                throw error;
            }
        });
    }

    private async execDirect(sql: string): Promise<void> {
        await this.database.exec(sql);
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.operationTail;
        let release!: () => void;
        this.operationTail = new Promise<void>((resolve) => {
            release = resolve;
        });
        return previous.then(operation).finally(release);
    }
}

/** Applies ordered SQLite schema migrations atomically using PRAGMA user_version. */
export async function migrateSqliteDatabase(
    database: SqliteDatabase,
    migrations: readonly SqliteMigration[],
): Promise<void> {
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

    const latestVersion = versions[versions.length - 1] ?? 0;
    await database.transaction(async (transaction) => {
        // Read the version only after acquiring the write lock. Otherwise
        // concurrent first-openers can all observe the same old version and
        // apply the same ALTER TABLE migration.
        const row = await transaction.get<{ user_version?: unknown }>("PRAGMA user_version");
        const currentVersion = typeof row?.user_version === "number" ? row.user_version : 0;
        if (currentVersion > latestVersion) {
            throw new Error(`SQLite database version ${currentVersion} is newer than supported version ${latestVersion}.`);
        }

        for (const migration of migrations.filter((candidate) => candidate.version > currentVersion)) {
            await migration.apply(transaction);
            await transaction.exec(`PRAGMA user_version = ${migration.version}`);
        }
    }, "IMMEDIATE");
}
