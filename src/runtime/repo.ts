import type { BotSpec } from "../catalog/schema.js";
import { newId, now, type Db } from "../store/db.js";

export type ThreadKind = "dm" | "group" | "task" | "routine";
export type AuthorType = "user" | "bot" | "system";
export type TaskStatus = "open" | "in_progress" | "waiting" | "done" | "failed" | "cancelled";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface Thread {
    id: string;
    owner: string;
    kind: ThreadKind;
    title: string;
    botIds: string[];
    archived: boolean;
    pinned: boolean;
    readSeq: number;
    lastSeq: number;
    createdAt: string;
    updatedAt: string;
}

export interface ToolActivity {
    tool: string;
    success?: boolean;
    detail?: string;
}

export interface MessageMeta {
    attachments?: { id: string; name: string; mimeType: string; size: number }[];
    tools?: ToolActivity[];
    reasoning?: string;
    approvalId?: string;
    taskId?: string;
    routineRunId?: string;
    traceId?: string;
    aborted?: boolean;
    error?: string;
}

export interface Message {
    id: string;
    threadId: string;
    seq: number;
    authorType: AuthorType;
    authorId: string;
    text: string;
    meta: MessageMeta;
    createdAt: string;
}

export interface Task {
    id: string;
    owner: string;
    title: string;
    details: string;
    assignee: string;
    createdBy: string;
    sourceThreadId: string | null;
    threadId: string;
    status: TaskStatus;
    result: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface Routine {
    id: string;
    owner: string;
    botId: string;
    name: string;
    prompt: string;
    schedule: string | null;
    timezone: string | null;
    enabled: boolean;
    threadId: string;
    lastRunAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface RoutineRun {
    id: string;
    routineId: string;
    trigger: "schedule" | "manual";
    status: "running" | "done" | "failed";
    output: string | null;
    error: string | null;
    startedAt: string;
    finishedAt: string | null;
}

export interface Approval {
    id: string;
    owner: string;
    botId: string;
    threadId: string | null;
    kind: string;
    detail: string | null;
    status: ApprovalStatus;
    createdAt: string;
    decidedAt: string | null;
}

export interface Memory {
    id: string;
    owner: string;
    botId: string | null;
    text: string;
    createdAt: string;
}

export interface Notification {
    id: string;
    owner: string;
    kind: string;
    title: string;
    body: string;
    threadId: string | null;
    read: boolean;
    createdAt: string;
}

export interface UserSkill {
    owner: string;
    name: string;
    description: string;
    markdown: string;
    status: "draft" | "published";
    createdAt: string;
    updatedAt: string;
}

export interface StoredUser {
    login: string;
    githubId: number;
    orgs: string[];
    tokenCiphertext: string;
    instructions: string;
}

export interface Job {
    id: string;
    owner: string;
    kind: string;
    payload: unknown;
    status: "queued" | "running" | "done" | "failed";
}

type Row = Record<string, unknown>;
const str = (v: unknown) => v as string;
const nstr = (v: unknown) => (v ?? null) as string | null;

const toThread = (r: Row): Thread => ({
    id: str(r.id),
    owner: str(r.owner),
    kind: r.kind as ThreadKind,
    title: str(r.title),
    botIds: JSON.parse(str(r.bot_ids)) as string[],
    archived: r.archived === 1,
    pinned: r.pinned === 1,
    readSeq: Number(r.read_seq),
    lastSeq: Number(r.last_seq),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
});

const toMessage = (r: Row): Message => ({
    id: str(r.id),
    threadId: str(r.thread_id),
    seq: Number(r.seq),
    authorType: r.author_type as AuthorType,
    authorId: str(r.author_id),
    text: str(r.text),
    meta: JSON.parse(str(r.meta)) as MessageMeta,
    createdAt: str(r.created_at),
});

const toTask = (r: Row): Task => ({
    id: str(r.id),
    owner: str(r.owner),
    title: str(r.title),
    details: str(r.details),
    assignee: str(r.assignee),
    createdBy: str(r.created_by),
    sourceThreadId: nstr(r.source_thread_id),
    threadId: str(r.thread_id),
    status: r.status as TaskStatus,
    result: nstr(r.result),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
});

const toRoutine = (r: Row): Routine => ({
    id: str(r.id),
    owner: str(r.owner),
    botId: str(r.bot_id),
    name: str(r.name),
    prompt: str(r.prompt),
    schedule: nstr(r.schedule),
    timezone: nstr(r.timezone),
    enabled: r.enabled === 1,
    threadId: str(r.thread_id),
    lastRunAt: nstr(r.last_run_at),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
});

const toRun = (r: Row): RoutineRun => ({
    id: str(r.id),
    routineId: str(r.routine_id),
    trigger: r.trigger as RoutineRun["trigger"],
    status: r.status as RoutineRun["status"],
    output: nstr(r.output),
    error: nstr(r.error),
    startedAt: str(r.started_at),
    finishedAt: nstr(r.finished_at),
});

const toApproval = (r: Row): Approval => ({
    id: str(r.id),
    owner: str(r.owner),
    botId: str(r.bot_id),
    threadId: nstr(r.thread_id),
    kind: str(r.kind),
    detail: nstr(r.detail),
    status: r.status as ApprovalStatus,
    createdAt: str(r.created_at),
    decidedAt: nstr(r.decided_at),
});

const toNotification = (r: Row): Notification => ({
    id: str(r.id),
    owner: str(r.owner),
    kind: str(r.kind),
    title: str(r.title),
    body: str(r.body),
    threadId: nstr(r.thread_id),
    read: r.read === 1,
    createdAt: str(r.created_at),
});

const toSkill = (r: Row): UserSkill => ({
    owner: str(r.owner),
    name: str(r.name),
    description: str(r.description),
    markdown: str(r.markdown),
    status: r.status as UserSkill["status"],
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
});

/** Typed queries over the SQLite schema. Every method is scoped by owner where data is per user. */
export class Repo {
    constructor(readonly db: Db) {}

    // ---- users
    upsertUser(u: StoredUser): void {
        const t = now();
        this.db.run(
            `INSERT INTO users (login, github_id, orgs, token_ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(login) DO UPDATE SET github_id = excluded.github_id, orgs = excluded.orgs,
               token_ciphertext = excluded.token_ciphertext, updated_at = excluded.updated_at`,
            u.login, u.githubId, JSON.stringify(u.orgs), u.tokenCiphertext, t, t,
        );
    }
    user(login: string): StoredUser | undefined {
        const r = this.db.get<Row>("SELECT * FROM users WHERE login = ?", login);
        return r && {
            login: str(r.login),
            githubId: Number(r.github_id),
            orgs: JSON.parse(str(r.orgs)) as string[],
            tokenCiphertext: str(r.token_ciphertext),
            instructions: str(r.instructions),
        };
    }
    setUserInstructions(login: string, instructions: string): void {
        this.db.run("UPDATE users SET instructions = ?, updated_at = ? WHERE login = ?", instructions, now(), login);
    }

    // ---- personal bots
    personalBots(owner: string): BotSpec[] {
        return this.db.all<Row>("SELECT spec FROM personal_bots WHERE owner = ? ORDER BY created_at", owner).map((r) => JSON.parse(str(r.spec)) as BotSpec);
    }
    personalBotOwner(id: string): string | undefined {
        return this.db.get<Row>("SELECT owner FROM personal_bots WHERE id = ?", id)?.owner as string | undefined;
    }
    savePersonalBot(owner: string, bot: BotSpec): void {
        const t = now();
        this.db.run(
            `INSERT INTO personal_bots (id, owner, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET spec = excluded.spec, updated_at = excluded.updated_at`,
            bot.id, owner, JSON.stringify(bot), t, t,
        );
    }
    deletePersonalBot(owner: string, id: string): boolean {
        return this.db.run("DELETE FROM personal_bots WHERE owner = ? AND id = ?", owner, id).changes > 0;
    }

    // ---- threads
    createThread(owner: string, kind: ThreadKind, title: string, botIds: string[]): Thread {
        const t = now();
        const id = newId();
        this.db.run(
            "INSERT INTO threads (id, owner, kind, title, bot_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            id, owner, kind, title, JSON.stringify(botIds), t, t,
        );
        return this.thread(id)!;
    }
    thread(id: string): Thread | undefined {
        const r = this.db.get<Row>("SELECT * FROM threads WHERE id = ?", id);
        return r && toThread(r);
    }
    threads(owner: string, opts: { kind?: ThreadKind[]; includeArchived?: boolean } = {}): Thread[] {
        const kinds = opts.kind ?? ["dm", "group", "task", "routine"];
        return this.db
            .all<Row>(
                `SELECT * FROM threads WHERE owner = ? AND kind IN (${kinds.map(() => "?").join(",")}) ${opts.includeArchived ? "" : "AND archived = 0"}
                 ORDER BY pinned DESC, updated_at DESC`,
                owner, ...kinds,
            )
            .map(toThread);
    }
    dmThread(owner: string, botId: string): Thread | undefined {
        const r = this.db.get<Row>("SELECT * FROM threads WHERE owner = ? AND kind = 'dm' AND bot_ids = ? AND archived = 0 ORDER BY created_at LIMIT 1", owner, JSON.stringify([botId]));
        return r && toThread(r);
    }
    updateThread(id: string, patch: { title?: string; archived?: boolean; pinned?: boolean; botIds?: string[] }): void {
        const t = this.thread(id);
        if (!t) return;
        this.db.run(
            "UPDATE threads SET title = ?, archived = ?, pinned = ?, bot_ids = ? WHERE id = ?",
            patch.title ?? t.title, (patch.archived ?? t.archived) ? 1 : 0, (patch.pinned ?? t.pinned) ? 1 : 0,
            JSON.stringify(patch.botIds ?? t.botIds), id,
        );
    }
    markRead(id: string, seq: number): void {
        this.db.run("UPDATE threads SET read_seq = MAX(read_seq, ?) WHERE id = ?", seq, id);
    }
    deleteThread(id: string): void {
        this.db.run("DELETE FROM threads WHERE id = ?", id);
    }
    searchThreads(owner: string, q: string): { thread: Thread; snippet: string }[] {
        const like = `%${q.replace(/[%_]/g, (c) => "\\" + c)}%`;
        return this.db
            .all<Row>(
                `SELECT t.*, (SELECT text FROM messages m WHERE m.thread_id = t.id AND m.text LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT 1) AS snippet
                 FROM threads t WHERE t.owner = ? AND (t.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.text LIKE ? ESCAPE '\\'))
                 ORDER BY t.updated_at DESC LIMIT 50`,
                like, owner, like, like,
            )
            .map((r) => ({ thread: toThread(r), snippet: (r.snippet as string | null)?.slice(0, 200) ?? "" }));
    }

    // ---- messages
    addMessage(threadId: string, authorType: AuthorType, authorId: string, text: string, meta: MessageMeta = {}): Message {
        return this.db.tx(() => {
            const seq = Number(this.db.get<Row>("SELECT last_seq FROM threads WHERE id = ?", threadId)?.last_seq ?? 0) + 1;
            const id = newId();
            const t = now();
            this.db.run(
                "INSERT INTO messages (id, thread_id, seq, author_type, author_id, text, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                id, threadId, seq, authorType, authorId, text, JSON.stringify(meta), t,
            );
            const readSeq = authorType === "user" ? seq : null;
            this.db.run(
                "UPDATE threads SET last_seq = ?, updated_at = ?, read_seq = COALESCE(?, read_seq) WHERE id = ?",
                seq, t, readSeq, threadId,
            );
            return { id, threadId, seq, authorType, authorId, text, meta, createdAt: t };
        });
    }
    messages(threadId: string, opts: { afterSeq?: number; limit?: number } = {}): Message[] {
        return this.db
            .all<Row>("SELECT * FROM messages WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?", threadId, opts.afterSeq ?? 0, opts.limit ?? 10_000)
            .map(toMessage);
    }
    /** The newest `limit` messages before `beforeSeq` (or the end), oldest first. */
    latestMessages(threadId: string, limit: number, beforeSeq?: number): Message[] {
        return this.db
            .all<Row>("SELECT * FROM messages WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?", threadId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit)
            .map(toMessage)
            .reverse();
    }
    message(id: string): Message | undefined {
        const r = this.db.get<Row>("SELECT * FROM messages WHERE id = ?", id);
        return r && toMessage(r);
    }
    updateMessageMeta(id: string, meta: MessageMeta): void {
        this.db.run("UPDATE messages SET meta = ? WHERE id = ?", JSON.stringify(meta), id);
    }

    // ---- per-bot session cursor in a thread
    botSession(threadId: string, botId: string): { sessionId: string; lastSeq: number; turns: number } {
        const r = this.db.get<Row>("SELECT * FROM bot_sessions WHERE thread_id = ? AND bot_id = ?", threadId, botId);
        if (r) return { sessionId: str(r.session_id), lastSeq: Number(r.last_seq), turns: Number(r.turns) };
        const sessionId = newId();
        this.db.run("INSERT INTO bot_sessions (thread_id, bot_id, session_id) VALUES (?, ?, ?)", threadId, botId, sessionId);
        return { sessionId, lastSeq: 0, turns: 0 };
    }
    advanceBotSession(threadId: string, botId: string, lastSeq: number): void {
        this.db.run("UPDATE bot_sessions SET last_seq = MAX(last_seq, ?), turns = turns + 1 WHERE thread_id = ? AND bot_id = ?", lastSeq, threadId, botId);
    }
    sessionIdsForThread(threadId: string): string[] {
        return this.db.all<Row>("SELECT session_id FROM bot_sessions WHERE thread_id = ?", threadId).map((r) => str(r.session_id));
    }

    // ---- jobs
    enqueue(owner: string, kind: string, payload: unknown): Job {
        const id = newId();
        const t = now();
        this.db.run("INSERT INTO jobs (id, owner, kind, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)", id, owner, kind, JSON.stringify(payload), t, t);
        return { id, owner, kind, payload, status: "queued" };
    }
    queuedJobs(limit: number): Job[] {
        return this.db
            .all<Row>("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT ?", limit)
            .map((r) => ({ id: str(r.id), owner: str(r.owner), kind: str(r.kind), payload: JSON.parse(str(r.payload)), status: "queued" }));
    }
    hasQueuedWake(threadId: string, botId: string): boolean {
        return Boolean(
            this.db.get<Row>(
                "SELECT 1 FROM jobs WHERE status = 'queued' AND kind = 'wake' AND json_extract(payload, '$.threadId') = ? AND json_extract(payload, '$.botId') = ?",
                threadId, botId,
            ),
        );
    }
    countQueued(owner: string): number {
        return Number(this.db.get<Row>("SELECT COUNT(*) AS n FROM jobs WHERE owner = ? AND status = 'queued'", owner)?.n ?? 0);
    }
    setJobStatus(id: string, status: Job["status"], error?: string): void {
        this.db.run("UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?", status, error ?? null, now(), id);
    }
    requeueRunningJobs(): number {
        return this.db.run("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'", now()).changes;
    }
    pruneJobs(olderThanIso: string): void {
        this.db.run("DELETE FROM jobs WHERE status IN ('done', 'failed') AND updated_at < ?", olderThanIso);
    }

    // ---- tasks
    createTask(t: Omit<Task, "id" | "createdAt" | "updatedAt" | "status" | "result">): Task {
        const id = newId();
        const ts = now();
        this.db.run(
            `INSERT INTO tasks (id, owner, title, details, assignee, created_by, source_thread_id, thread_id, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
            id, t.owner, t.title, t.details, t.assignee, t.createdBy, t.sourceThreadId, t.threadId, ts, ts,
        );
        return this.task(id)!;
    }
    task(id: string): Task | undefined {
        const r = this.db.get<Row>("SELECT * FROM tasks WHERE id = ?", id);
        return r && toTask(r);
    }
    taskByThread(threadId: string): Task | undefined {
        const r = this.db.get<Row>("SELECT * FROM tasks WHERE thread_id = ?", threadId);
        return r && toTask(r);
    }
    tasks(owner: string): Task[] {
        return this.db.all<Row>("SELECT * FROM tasks WHERE owner = ? ORDER BY updated_at DESC LIMIT 500", owner).map(toTask);
    }
    setTaskStatus(id: string, status: TaskStatus, result?: string | null): void {
        this.db.run("UPDATE tasks SET status = ?, result = COALESCE(?, result), updated_at = ? WHERE id = ?", status, result ?? null, now(), id);
    }

    // ---- routines
    createRoutine(r: Omit<Routine, "id" | "createdAt" | "updatedAt" | "lastRunAt">): Routine {
        const id = newId();
        const t = now();
        this.db.run(
            `INSERT INTO routines (id, owner, bot_id, name, prompt, schedule, timezone, enabled, thread_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id, r.owner, r.botId, r.name, r.prompt, r.schedule, r.timezone, r.enabled ? 1 : 0, r.threadId, t, t,
        );
        return this.routine(id)!;
    }
    routine(id: string): Routine | undefined {
        const r = this.db.get<Row>("SELECT * FROM routines WHERE id = ?", id);
        return r && toRoutine(r);
    }
    routines(owner?: string): Routine[] {
        return (owner
            ? this.db.all<Row>("SELECT * FROM routines WHERE owner = ? ORDER BY created_at", owner)
            : this.db.all<Row>("SELECT * FROM routines ORDER BY created_at")
        ).map(toRoutine);
    }
    countRoutines(owner: string, botId: string): number {
        return Number(this.db.get<Row>("SELECT COUNT(*) AS n FROM routines WHERE owner = ? AND bot_id = ?", owner, botId)?.n ?? 0);
    }
    updateRoutine(id: string, patch: Partial<Pick<Routine, "name" | "prompt" | "schedule" | "timezone" | "enabled">>): void {
        const r = this.routine(id);
        if (!r) return;
        this.db.run(
            "UPDATE routines SET name = ?, prompt = ?, schedule = ?, timezone = ?, enabled = ?, updated_at = ? WHERE id = ?",
            patch.name ?? r.name, patch.prompt ?? r.prompt,
            patch.schedule === undefined ? r.schedule : patch.schedule,
            patch.timezone === undefined ? r.timezone : patch.timezone,
            (patch.enabled ?? r.enabled) ? 1 : 0, now(), id,
        );
    }
    deleteRoutine(id: string): void {
        this.db.run("DELETE FROM routines WHERE id = ?", id);
    }
    startRun(routineId: string, trigger: RoutineRun["trigger"], keep: number): RoutineRun {
        const id = newId();
        const t = now();
        this.db.tx(() => {
            this.db.run("INSERT INTO routine_runs (id, routine_id, trigger, status, started_at) VALUES (?, ?, ?, 'running', ?)", id, routineId, trigger, t);
            this.db.run("UPDATE routines SET last_run_at = ? WHERE id = ?", t, routineId);
            this.db.run(
                `DELETE FROM routine_runs WHERE routine_id = ? AND id NOT IN
                 (SELECT id FROM routine_runs WHERE routine_id = ? ORDER BY started_at DESC LIMIT ?)`,
                routineId, routineId, keep,
            );
        });
        return { id, routineId, trigger, status: "running", output: null, error: null, startedAt: t, finishedAt: null };
    }
    finishRun(id: string, status: "done" | "failed", output: string | null, error: string | null): void {
        this.db.run("UPDATE routine_runs SET status = ?, output = ?, error = ?, finished_at = ? WHERE id = ?", status, output, error, now(), id);
    }
    runs(routineId: string): RoutineRun[] {
        return this.db.all<Row>("SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY started_at DESC", routineId).map(toRun);
    }
    run_(id: string): RoutineRun | undefined {
        const r = this.db.get<Row>("SELECT * FROM routine_runs WHERE id = ?", id);
        return r && toRun(r);
    }

    // ---- approvals
    createApproval(a: Pick<Approval, "owner" | "botId" | "threadId" | "kind" | "detail">): Approval {
        const id = newId();
        this.db.run(
            "INSERT INTO approvals (id, owner, bot_id, thread_id, kind, detail, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
            id, a.owner, a.botId, a.threadId, a.kind, a.detail, now(),
        );
        return this.approval(id)!;
    }
    approval(id: string): Approval | undefined {
        const r = this.db.get<Row>("SELECT * FROM approvals WHERE id = ?", id);
        return r && toApproval(r);
    }
    approvals(owner: string, status?: ApprovalStatus): Approval[] {
        return (status
            ? this.db.all<Row>("SELECT * FROM approvals WHERE owner = ? AND status = ? ORDER BY created_at DESC LIMIT 200", owner, status)
            : this.db.all<Row>("SELECT * FROM approvals WHERE owner = ? ORDER BY created_at DESC LIMIT 200", owner)
        ).map(toApproval);
    }
    decideApproval(id: string, status: Exclude<ApprovalStatus, "pending">): boolean {
        return this.db.run("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'", status, now(), id).changes > 0;
    }
    expirePendingApprovals(): number {
        return this.db.run("UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending'", now()).changes;
    }

    // ---- memory
    memories(owner: string, botId?: string): Memory[] {
        const rows = botId === undefined
            ? this.db.all<Row>("SELECT * FROM memories WHERE owner = ? ORDER BY created_at", owner)
            : this.db.all<Row>("SELECT * FROM memories WHERE owner = ? AND (bot_id IS NULL OR bot_id = ?) ORDER BY created_at", owner, botId);
        return rows.map((r) => ({ id: str(r.id), owner: str(r.owner), botId: nstr(r.bot_id), text: str(r.text), createdAt: str(r.created_at) }));
    }
    addMemory(owner: string, botId: string | null, text: string): Memory {
        const id = newId();
        const t = now();
        this.db.run("INSERT INTO memories (id, owner, bot_id, text, created_at) VALUES (?, ?, ?, ?, ?)", id, owner, botId, text, t);
        return { id, owner, botId, text, createdAt: t };
    }
    updateMemory(owner: string, id: string, text: string): boolean {
        return this.db.run("UPDATE memories SET text = ? WHERE owner = ? AND id = ?", text, owner, id).changes > 0;
    }
    deleteMemory(owner: string, id: string): boolean {
        return this.db.run("DELETE FROM memories WHERE owner = ? AND id = ?", owner, id).changes > 0;
    }

    // ---- connector credentials
    credential(owner: string, connectorId: string): { ciphertext: string; status: "connected" | "expired"; updatedAt: string } | undefined {
        const r = this.db.get<Row>("SELECT * FROM credentials WHERE owner = ? AND connector_id = ?", owner, connectorId);
        return r && { ciphertext: str(r.ciphertext), status: r.status as "connected" | "expired", updatedAt: str(r.updated_at) };
    }
    saveCredential(owner: string, connectorId: string, ciphertext: string): void {
        this.db.run(
            `INSERT INTO credentials (owner, connector_id, ciphertext, status, updated_at) VALUES (?, ?, ?, 'connected', ?)
             ON CONFLICT(owner, connector_id) DO UPDATE SET ciphertext = excluded.ciphertext, status = 'connected', updated_at = excluded.updated_at`,
            owner, connectorId, ciphertext, now(),
        );
    }
    markCredentialExpired(owner: string, connectorId: string): void {
        this.db.run("UPDATE credentials SET status = 'expired', updated_at = ? WHERE owner = ? AND connector_id = ?", now(), owner, connectorId);
    }
    deleteCredential(owner: string, connectorId: string): void {
        this.db.run("DELETE FROM credentials WHERE owner = ? AND connector_id = ?", owner, connectorId);
    }

    // ---- user skills
    userSkills(owner: string): UserSkill[] {
        return this.db.all<Row>("SELECT * FROM user_skills WHERE owner = ? ORDER BY name", owner).map(toSkill);
    }
    userSkill(owner: string, name: string): UserSkill | undefined {
        const r = this.db.get<Row>("SELECT * FROM user_skills WHERE owner = ? AND name = ?", owner, name);
        return r && toSkill(r);
    }
    saveUserSkill(s: Omit<UserSkill, "createdAt" | "updatedAt">): void {
        const t = now();
        this.db.run(
            `INSERT INTO user_skills (owner, name, description, markdown, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(owner, name) DO UPDATE SET description = excluded.description, markdown = excluded.markdown,
               status = excluded.status, updated_at = excluded.updated_at`,
            s.owner, s.name, s.description, s.markdown, s.status, t, t,
        );
    }
    deleteUserSkill(owner: string, name: string): boolean {
        return this.db.run("DELETE FROM user_skills WHERE owner = ? AND name = ?", owner, name).changes > 0;
    }

    // ---- notifications
    notify(owner: string, kind: string, title: string, body = "", threadId: string | null = null): Notification {
        const id = newId();
        const t = now();
        this.db.run("INSERT INTO notifications (id, owner, kind, title, body, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, owner, kind, title, body, threadId, t);
        return { id, owner, kind, title, body, threadId, read: false, createdAt: t };
    }
    notifications(owner: string): Notification[] {
        return this.db.all<Row>("SELECT * FROM notifications WHERE owner = ? ORDER BY created_at DESC LIMIT 100", owner).map(toNotification);
    }
    markNotificationsRead(owner: string, ids?: string[]): void {
        if (!ids) this.db.run("UPDATE notifications SET read = 1 WHERE owner = ?", owner);
        else for (const id of ids) this.db.run("UPDATE notifications SET read = 1 WHERE owner = ? AND id = ?", owner, id);
    }

    // ---- uploads
    addUpload(owner: string, name: string, mimeType: string, size: number): string {
        const id = newId();
        this.db.run("INSERT INTO uploads (id, owner, name, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, owner, name, mimeType, size, now());
        return id;
    }
    upload(owner: string, id: string): { id: string; name: string; mimeType: string; size: number } | undefined {
        const r = this.db.get<Row>("SELECT * FROM uploads WHERE owner = ? AND id = ?", owner, id);
        return r && { id: str(r.id), name: str(r.name), mimeType: str(r.mime_type), size: Number(r.size) };
    }

    // ---- share links
    createShare(owner: string, threadId: string, token: string): void {
        this.db.run("INSERT INTO share_links (token, owner, thread_id, created_at) VALUES (?, ?, ?, ?)", token, owner, threadId, now());
    }
    share(token: string): { owner: string; threadId: string } | undefined {
        const r = this.db.get<Row>("SELECT * FROM share_links WHERE token = ?", token);
        return r && { owner: str(r.owner), threadId: str(r.thread_id) };
    }
    deleteShares(owner: string, threadId: string): void {
        this.db.run("DELETE FROM share_links WHERE owner = ? AND thread_id = ?", owner, threadId);
    }

    // ---- web sessions
    createWebSession(idHash: string, login: string, tokenCiphertext: string, ttlMs: number): void {
        const t = new Date();
        this.db.run(
            "INSERT INTO web_sessions (id_hash, login, token_ciphertext, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
            idHash, login, tokenCiphertext, t.toISOString(), new Date(t.getTime() + ttlMs).toISOString(),
        );
    }
    webSession(idHash: string): { login: string; tokenCiphertext: string } | undefined {
        const r = this.db.get<Row>("SELECT * FROM web_sessions WHERE id_hash = ? AND expires_at > ?", idHash, now());
        return r && { login: str(r.login), tokenCiphertext: str(r.token_ciphertext) };
    }
    deleteWebSession(idHash: string): void {
        this.db.run("DELETE FROM web_sessions WHERE id_hash = ?", idHash);
    }

    // ---- sidebar preferences
    botPrefs(owner: string): Map<string, { section: string | null; hidden: boolean }> {
        return new Map(
            this.db.all<Row>("SELECT * FROM bot_prefs WHERE owner = ?", owner).map((r) => [str(r.bot_id), { section: nstr(r.section), hidden: r.hidden === 1 }]),
        );
    }
    setBotPrefs(owner: string, botId: string, prefs: { section: string | null; hidden: boolean }): void {
        this.db.run(
            `INSERT INTO bot_prefs (owner, bot_id, section, hidden) VALUES (?, ?, ?, ?)
             ON CONFLICT(owner, bot_id) DO UPDATE SET section = excluded.section, hidden = excluded.hidden`,
            owner, botId, prefs.section, prefs.hidden ? 1 : 0,
        );
    }

    /** Everything stored for one person, for "delete my data". Audit records are kept. */
    deleteUserData(owner: string): { uploads: string[]; sessions: string[] } {
        return this.db.tx(() => {
            const uploads = this.db.all<Row>("SELECT id FROM uploads WHERE owner = ?", owner).map((r) => str(r.id));
            const sessions = this.db
                .all<Row>("SELECT b.session_id FROM bot_sessions b JOIN threads t ON t.id = b.thread_id WHERE t.owner = ?", owner)
                .map((r) => str(r.session_id));
            for (const table of ["threads", "tasks", "routines", "approvals", "memories", "notifications", "jobs", "uploads", "share_links", "personal_bots"]) {
                this.db.run(`DELETE FROM ${table} WHERE owner = ?`, owner);
            }
            for (const table of ["credentials", "user_skills", "bot_prefs"]) this.db.run(`DELETE FROM ${table} WHERE owner = ?`, owner);
            this.db.run("DELETE FROM web_sessions WHERE login = ?", owner);
            this.db.run("DELETE FROM users WHERE login = ?", owner);
            return { uploads, sessions };
        });
    }

    countBotsAndGroups(owner: string): number {
        const bots = Number(this.db.get<Row>("SELECT COUNT(*) AS n FROM personal_bots WHERE owner = ?", owner)?.n ?? 0);
        const groups = Number(this.db.get<Row>("SELECT COUNT(*) AS n FROM threads WHERE owner = ? AND kind = 'group' AND archived = 0", owner)?.n ?? 0);
        return bots + groups;
    }
}
