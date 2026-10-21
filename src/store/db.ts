import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * SQLite persistence (node:sqlite, no native deps). One file per deployment; every write is a
 * single statement or an explicit transaction, so a crash never leaves half-written rows.
 */
export class Db {
    readonly sql: DatabaseSync;

    constructor(file: string) {
        if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
        this.sql = new DatabaseSync(file);
        this.sql.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
        this.migrate();
    }

    all<T>(query: string, ...params: SQLInputValue[]): T[] {
        return this.sql.prepare(query).all(...params) as T[];
    }

    get<T>(query: string, ...params: SQLInputValue[]): T | undefined {
        return this.sql.prepare(query).get(...params) as T | undefined;
    }

    run(query: string, ...params: SQLInputValue[]): { changes: number } {
        const r = this.sql.prepare(query).run(...params);
        return { changes: Number(r.changes) };
    }

    tx<T>(fn: () => T): T {
        this.sql.exec("BEGIN IMMEDIATE");
        try {
            const out = fn();
            this.sql.exec("COMMIT");
            return out;
        } catch (err) {
            this.sql.exec("ROLLBACK");
            throw err;
        }
    }

    close(): void {
        this.sql.close();
    }

    private migrate(): void {
        const version = (this.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0);
        const steps = [SCHEMA_V1, SCHEMA_V2];
        for (let v = version; v < steps.length; v++) {
            this.tx(() => {
                this.sql.exec(steps[v]!);
                this.sql.exec(`PRAGMA user_version = ${v + 1}`);
            });
        }
    }
}

export const newId = (): string => randomUUID();
export const now = (): string => new Date().toISOString();

const SCHEMA_V1 = `
CREATE TABLE users (
    login TEXT PRIMARY KEY,
    github_id INTEGER NOT NULL,
    orgs TEXT NOT NULL DEFAULT '[]',
    token_ciphertext TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE personal_bots (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    spec TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX personal_bots_owner ON personal_bots(owner);

CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('dm', 'group', 'task', 'routine')),
    title TEXT NOT NULL,
    bot_ids TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    read_seq INTEGER NOT NULL DEFAULT 0,
    last_seq INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX threads_owner ON threads(owner, updated_at);

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    author_type TEXT NOT NULL CHECK (author_type IN ('user', 'bot', 'system')),
    author_id TEXT NOT NULL,
    text TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    UNIQUE (thread_id, seq)
);

CREATE TABLE bot_sessions (
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    turns INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (thread_id, bot_id)
);

CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX jobs_status ON jobs(status, created_at);

CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    title TEXT NOT NULL,
    details TEXT NOT NULL,
    assignee TEXT NOT NULL,
    created_by TEXT NOT NULL,
    source_thread_id TEXT,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'waiting', 'done', 'failed', 'cancelled')),
    result TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX tasks_owner ON tasks(owner, updated_at);

CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule TEXT,
    timezone TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    thread_id TEXT NOT NULL,
    last_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX routines_owner ON routines(owner);

CREATE TABLE routine_runs (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
    output TEXT,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE INDEX routine_runs_routine ON routine_runs(routine_id, started_at);

CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    thread_id TEXT,
    kind TEXT NOT NULL,
    detail TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
    created_at TEXT NOT NULL,
    decided_at TEXT
);
CREATE INDEX approvals_owner ON approvals(owner, status);

CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    bot_id TEXT,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX memories_owner ON memories(owner, bot_id);

CREATE TABLE credentials (
    owner TEXT NOT NULL,
    connector_id TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'expired')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner, connector_id)
);

CREATE TABLE user_skills (
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    markdown TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner, name)
);

CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    thread_id TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX notifications_owner ON notifications(owner, read, created_at);

CREATE TABLE web_sessions (
    id_hash TEXT PRIMARY KEY,
    login TEXT NOT NULL,
    token_ciphertext TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE share_links (
    token TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
);
`;

/** v2: per-user sidebar organization (sections, hidden bots). */
const SCHEMA_V2 = `
CREATE TABLE bot_prefs (
    owner TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    section TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner, bot_id)
);
`;
