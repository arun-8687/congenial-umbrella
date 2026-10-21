import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Catalog, CatalogError } from "../catalog/catalog.js";
import { derivedPermissions, type BotSpec } from "../catalog/schema.js";
import { randomToken, sha256 } from "../crypto.js";
import { canUseConnector, type User } from "../identity.js";
import { insideDir } from "../engine/policy.js";
import { DirectoryError, type BotEntry } from "../runtime/directory.js";
import type { Thread } from "../runtime/repo.js";
import { InvalidError, NotFoundError, type Runtime } from "../runtime/runtime.js";
import { BOT_TEMPLATES } from "../runtime/templates.js";
import type { Sealer } from "../crypto.js";
import type { WebAuth } from "./auth.js";

export interface ServerOptions {
    runtime: Runtime;
    auth: WebAuth;
    sealer: Sealer;
    /** GitHub logins allowed to use the admin endpoints. */
    admins: string[];
    /** Directory with the web UI (index.html, app.js, ...). */
    webDir: string;
    /** Directory with the daily audit JSONL files, for the admin audit view. */
    auditDir?: string;
    /** Public base URL (for OAuth redirects and share links); derived from the request when unset. */
    publicUrl?: string;
    maxUploadBytes?: number;
    /** Total upload storage per user. */
    maxStorageBytes?: number;
    shareTtlDays?: number;
    /** Emit HSTS (only when served over HTTPS). */
    hsts?: boolean;
}

export class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly details?: unknown,
    ) {
        super(message);
    }
}

interface Ctx {
    req: IncomingMessage;
    res: ServerResponse;
    url: URL;
    user: User;
    params: string[];
    body: () => Promise<unknown>;
}

type Handler = (ctx: Ctx) => Promise<unknown>;

const BotInput = z.record(z.string(), z.unknown());
const NewThread = z.object({ botIds: z.array(z.string()).min(1), title: z.string().max(200).optional() }).strict();
const PatchThread = z
    .object({ title: z.string().min(1).max(200).optional(), archived: z.boolean().optional(), pinned: z.boolean().optional(), botIds: z.array(z.string()).optional() })
    .strict();
const PostMessage = z.object({ text: z.string().min(1).max(64_000), attachments: z.array(z.string()).max(10).default([]) }).strict();
const NewTask = z.object({ botId: z.string(), title: z.string().min(1).max(120), details: z.string().min(1).max(20_000) }).strict();
const RoutineInput = z
    .object({
        botId: z.string().optional(),
        name: z.string().min(1).max(80).optional(),
        prompt: z.string().min(1).max(20_000).optional(),
        schedule: z.string().max(100).nullable().optional(),
        timezone: z.string().max(64).nullable().optional(),
        enabled: z.boolean().optional(),
    })
    .strict();
const Decide = z.object({ approve: z.boolean(), always: z.boolean().default(false) }).strict();
const MemoryInput = z.object({ text: z.string().min(1).max(500), botId: z.string().nullable().optional() }).strict();
const SkillInput = z.object({ description: z.string().min(1).max(1024), markdown: z.string().min(1).max(100_000), status: z.enum(["draft", "published"]) }).strict();

/**
 * HTTP server: the web UI, a JSON API under /api, a per-user event stream at /api/events, and
 * GitHub sign-in under /auth. Cookie-authenticated writes must send `X-CSRF: 1`, which a cross-site
 * form cannot do without a CORS preflight that this server never grants.
 */
export function createAppServer(o: ServerOptions): Server {
    const { runtime: rt, auth } = o;
    const repo = rt.repo;
    const admins = new Set(o.admins.map((a) => a.toLowerCase()));
    const isAdmin = (u: User) => admins.has(u.login.toLowerCase());
    const requireAdmin = (u: User) => {
        if (!isAdmin(u)) throw new HttpError(403, "admin access required");
    };
    const maxUpload = o.maxUploadBytes ?? 20_000_000;
    const maxStorage = o.maxStorageBytes ?? 1024 * 1024 * 1024;
    const baseUrl = (req: IncomingMessage) => o.publicUrl ?? `http://${req.headers.host ?? "localhost"}`;
    const authLimiter = new RateLimiter(10, 60_000); // sign-in attempts per IP per minute
    const apiLimiter = new RateLimiter(600, 60_000); // API calls per user per minute
    const postLimiter = new RateLimiter(60, 60_000); // messages, tasks and runs per user per minute
    const streams = new Map<string, number>();
    const MAX_STREAMS_PER_USER = 8;
    const clientIp = (req: IncomingMessage) => req.socket.remoteAddress ?? "unknown";
    /** Same-origin check for browser writes, on top of the X-CSRF header. */
    const sameOrigin = (req: IncomingMessage) => {
        const origin = req.headers.origin;
        if (!origin) return true; // non-browser clients; CSRF is covered by X-CSRF + SameSite cookies
        return origin === new URL(baseUrl(req)).origin;
    };
    const logError = (err: unknown) => console.error(rt.audit.redactText(err instanceof Error ? (err.stack ?? err.message) : String(err)));

    const botView = (user: User, e: BotEntry, prefs = repo.botPrefs(user.login)) => {
        const s = rt.status(user.login)[e.bot.id];
        const pref = prefs.get(e.bot.id);
        return {
            section: pref?.section ?? null,
            hidden: pref?.hidden ?? false,
            ...e.bot,
            scope: e.scope,
            editable: e.scope === "personal",
            policy: derivedPermissions(e.bot),
            status: s?.status ?? "idle",
            statusThreadId: s?.threadId ?? null,
            dmThreadId: repo.dmThread(user.login, e.bot.id)?.id ?? null,
        };
    };
    const threadView = (t: Thread) => ({ ...t, unread: Math.max(0, t.lastSeq - t.readSeq) });

    const routes: [string, RegExp, Handler][] = [];
    const route = (method: string, pattern: string, handler: Handler) =>
        routes.push([method, new RegExp(`^${pattern.replace(/:[a-z]+/g, "([^/]+)")}$`), handler]);

    // ---------------------------------------------------------------- me
    route("GET", "/api/me", async ({ user }) => ({
        login: user.login,
        orgs: user.orgs,
        admin: isAdmin(user),
        instructions: repo.user(user.login)?.instructions ?? "",
        computerAccess: rt.options.computerAccess,
        limits: { botsAndGroups: rt.options.maxBotsAndGroups, groupSize: rt.options.maxGroupSize, routinesPerBot: rt.options.maxRoutinesPerBot },
    }));
    route("DELETE", "/api/me", async ({ user, req, res }) => {
        await rt.deleteUserData(user);
        o.auth.signOut(req, res);
        res.statusCode = 204;
    });
    route("PUT", "/api/me/instructions", async ({ user, body }) => {
        const { instructions } = parse(z.object({ instructions: z.string().max(4000) }).strict(), await body());
        repo.setUserInstructions(user.login, instructions);
        return { ok: true };
    });

    // ---------------------------------------------------------------- bots
    route("GET", "/api/bots", async ({ user }) => {
        const prefs = repo.botPrefs(user.login);
        return { bots: rt.directory.bots(user).map((e) => botView(user, e, prefs)) };
    });
    route("PUT", "/api/bots/:id/prefs", async ({ user, params, body }) => {
        const b = parse(z.object({ section: z.string().trim().max(40).nullable().optional(), hidden: z.boolean().optional() }).strict(), await body());
        const entry = rt.requireBot(user, params[0]!);
        const cur = repo.botPrefs(user.login).get(entry.bot.id) ?? { section: null, hidden: false };
        repo.setBotPrefs(user.login, entry.bot.id, { section: b.section === undefined ? cur.section : b.section || null, hidden: b.hidden ?? cur.hidden });
        return botView(user, entry);
    });
    route("GET", "/api/bot-templates", async () => {
        const c = rt.directory.catalog;
        return {
            templates: BOT_TEMPLATES.map((t) => ({
                ...t,
                bot: {
                    ...t.bot,
                    skills: (t.bot.skills ?? []).filter((s) => c.skills.has(s)),
                    connectors: (t.bot.connectors ?? []).filter((x) => c.connectors.has(x)),
                    computer: Boolean(t.bot.computer) && rt.options.computerAccess !== "off",
                },
            })),
        };
    });
    route("POST", "/api/bots", async ({ user, body, res }) => {
        const input = parse(BotInput, await body());
        delete input.id;
        const bot = rt.directory.savePersonalBot(user, input, { maxBotsAndGroups: rt.options.maxBotsAndGroups, computerAccess: rt.options.computerAccess });
        rt.audit.log({ type: "bot.created", botId: bot.id }, { actor: user.login });
        rt.hub.publish(user.login, { type: "bots.changed" });
        res.statusCode = 201;
        return botView(user, { bot, scope: "personal" });
    });
    route("PUT", "/api/bots/:id", async ({ user, params, body }) => {
        const input = parse(BotInput, await body());
        const bot = rt.directory.savePersonalBot(user, { ...input, id: params[0] }, { maxBotsAndGroups: rt.options.maxBotsAndGroups, computerAccess: rt.options.computerAccess });
        rt.audit.log({ type: "bot.updated", botId: bot.id }, { actor: user.login });
        rt.hub.publish(user.login, { type: "bots.changed" });
        return botView(user, { bot, scope: "personal" });
    });
    route("DELETE", "/api/bots/:id", async ({ user, params, res }) => {
        if (!rt.deletePersonalBot(user, params[0]!)) throw new HttpError(404, "bot not found");
        res.statusCode = 204;
    });
    route("POST", "/api/bots/:id/dm", async ({ user, params }) => threadView(rt.directThread(user, params[0]!)));

    // ---------------------------------------------------------------- threads
    route("GET", "/api/threads", async ({ user, url }) => {
        const kinds = url.searchParams.get("kind")?.split(",") as Thread["kind"][] | undefined;
        return { threads: repo.threads(user.login, { kind: kinds, includeArchived: url.searchParams.get("archived") === "1" }).map(threadView) };
    });
    route("POST", "/api/threads", async ({ user, body, res }) => {
        const b = parse(NewThread, await body());
        res.statusCode = 201;
        return threadView(rt.newThread(user, b.botIds, b.title));
    });
    route("GET", "/api/threads/:id", async ({ user, params, url }) => {
        const t = rt.thread(user, params[0]!);
        const after = url.searchParams.get("after");
        const before = url.searchParams.get("before");
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));
        // `after` catches up a live view (e.g. after a reconnect); otherwise the newest page, or the page before `before`.
        const messages = after !== null ? repo.messages(t.id, { afterSeq: Number(after), limit: 500 }) : repo.latestMessages(t.id, limit, before ? Number(before) : undefined);
        return {
            thread: threadView(t),
            messages,
            hasEarlier: messages.length > 0 && messages[0]!.seq > 1 && after === null,
            approvals: repo.approvals(user.login).filter((a) => a.threadId === t.id),
            task: t.kind === "task" ? repo.taskByThread(t.id) ?? null : null,
        };
    });
    route("PATCH", "/api/threads/:id", async ({ user, params, body }) => threadView(rt.updateThread(user, params[0]!, parse(PatchThread, await body()))));
    route("DELETE", "/api/threads/:id", async ({ user, params, res }) => {
        await rt.deleteThread(user, params[0]!);
        res.statusCode = 204;
    });
    route("POST", "/api/threads/:id/messages", async ({ user, params, body, res }) => {
        const b = parse(PostMessage, await body());
        res.statusCode = 201;
        return rt.postUserMessage(user, params[0]!, b.text, b.attachments);
    });
    route("POST", "/api/threads/:id/stop", async ({ user, params }) => ({ stopped: rt.stopThread(user, params[0]!) }));
    route("POST", "/api/threads/:id/read", async ({ user, params, body }) => {
        const { seq } = parse(z.object({ seq: z.number().int().min(0) }).strict(), await body());
        rt.markRead(user, params[0]!, seq);
        return { ok: true };
    });
    route("POST", "/api/threads/:id/share", async ({ user, params, req }) => {
        rt.thread(user, params[0]!);
        const token = randomToken(24);
        const expiresAt = new Date(Date.now() + (o.shareTtlDays ?? 30) * 86400_000).toISOString();
        repo.createShare(user.login, params[0]!, sha256(token), expiresAt);
        rt.audit.log({ type: "thread.shared", threadId: params[0], expiresAt }, { actor: user.login });
        return { token, url: `${baseUrl(req)}/s/${token}`, expiresAt };
    });
    route("DELETE", "/api/threads/:id/share", async ({ user, params, res }) => {
        rt.thread(user, params[0]!);
        repo.deleteShares(user.login, params[0]!);
        res.statusCode = 204;
    });
    route("POST", "/api/threads/:id/draft-skill", async ({ user, params, body }) => {
        const { botId } = parse(z.object({ botId: z.string() }).strict(), await body());
        return rt.draftSkill(user, params[0]!, botId);
    });
    route("GET", "/api/threads/:id/export", async ({ user, params, res }) => {
        const t = rt.thread(user, params[0]!);
        const lines = [`# ${t.title}`, ""];
        for (const m of repo.messages(t.id)) {
            const who = m.authorType === "user" ? `@${m.authorId}` : m.authorType === "bot" ? rt.directory.bot(user, m.authorId)?.bot.name ?? m.authorId : "Platform";
            lines.push(`**${who}** · ${m.createdAt}`, "", m.text, "");
        }
        res.writeHead(200, {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename="${t.title.replace(/[^\w.-]+/g, "_").slice(0, 60) || "thread"}.md"`,
            "Content-Security-Policy": "default-src 'none'; sandbox",
        }).end(lines.join("\n"));
    });
    route("GET", "/api/search", async ({ user, url }) => {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (q.length < 2) return { results: [] };
        return { results: repo.searchThreads(user.login, q).map((r) => ({ thread: threadView(r.thread), snippet: r.snippet })) };
    });

    // ---------------------------------------------------------------- tasks
    route("GET", "/api/tasks", async ({ user }) => ({ tasks: repo.tasks(user.login) }));
    route("POST", "/api/tasks", async ({ user, body, res }) => {
        const b = parse(NewTask, await body());
        res.statusCode = 201;
        const traceId = randomToken(12);
        return rt.assignTask(user, { from: null, to: b.botId, title: b.title, details: b.details, sourceThreadId: null, traceId, chain: [] });
    });
    route("POST", "/api/tasks/:id/cancel", async ({ user, params }) => {
        rt.cancelTask(user, params[0]!);
        return { ok: true };
    });

    // ---------------------------------------------------------------- routines
    const routineView = (r: ReturnType<Runtime["routine"]>) => ({ ...r, nextRunAt: rt.nextRun(r.id), runs: repo.runs(r.id).slice(0, 5) });
    route("GET", "/api/routines", async ({ user }) => ({ routines: repo.routines(user.login).map(routineView) }));
    route("POST", "/api/routines", async ({ user, body, res }) => {
        const b = parse(RoutineInput, await body());
        if (!b.botId || !b.name || !b.prompt) throw new HttpError(400, "botId, name and prompt are required");
        res.statusCode = 201;
        return routineView(rt.createRoutine(user, { botId: b.botId, name: b.name, prompt: b.prompt, schedule: b.schedule ?? null, timezone: b.timezone ?? null, enabled: b.enabled }));
    });
    route("PATCH", "/api/routines/:id", async ({ user, params, body }) => {
        const { botId: _ignored, ...patch } = parse(RoutineInput, await body());
        return routineView(rt.updateRoutine(user, params[0]!, patch));
    });
    route("DELETE", "/api/routines/:id", async ({ user, params, res }) => {
        rt.deleteRoutine(user, params[0]!);
        res.statusCode = 204;
    });
    route("POST", "/api/routines/:id/run", async ({ user, params }) => {
        rt.routine(user, params[0]!);
        return { runId: rt.runRoutine(user.login, params[0]!, "manual") };
    });
    route("GET", "/api/routines/:id/runs", async ({ user, params }) => {
        rt.routine(user, params[0]!);
        return { runs: repo.runs(params[0]!) };
    });

    // ---------------------------------------------------------------- approvals
    route("GET", "/api/approvals", async ({ user, url }) => {
        const status = url.searchParams.get("status") as "pending" | null;
        return { approvals: repo.approvals(user.login, status ?? undefined) };
    });
    route("POST", "/api/approvals/:id", async ({ user, params, body }) => {
        const b = parse(Decide, await body());
        rt.decideApproval(user, params[0]!, b.approve, b.always);
        return repo.approval(params[0]!);
    });

    // ---------------------------------------------------------------- memory
    route("GET", "/api/memory", async ({ user }) => ({ memories: repo.memories(user.login) }));
    route("POST", "/api/memory", async ({ user, body, res }) => {
        const b = parse(MemoryInput, await body());
        if (b.botId) rt.requireBot(user, b.botId);
        if (repo.countMemories(user.login) >= 500) throw new HttpError(422, "memory is full; delete something first");
        res.statusCode = 201;
        return repo.addMemory(user.login, b.botId ?? null, b.text.replace(/\s+/g, " ").trim(), "user");
    });
    route("PATCH", "/api/memory/:id", async ({ user, params, body }) => {
        const { text } = parse(z.object({ text: z.string().min(1).max(500) }).strict(), await body());
        if (!repo.updateMemory(user.login, params[0]!, text)) throw new HttpError(404, "memory not found");
        return { ok: true };
    });
    route("DELETE", "/api/memory/:id", async ({ user, params, res }) => {
        if (!repo.deleteMemory(user.login, params[0]!)) throw new HttpError(404, "memory not found");
        res.statusCode = 204;
    });

    // ---------------------------------------------------------------- skills
    route("GET", "/api/skills", async ({ user }) => ({
        org: [...rt.directory.catalog.skills.values()].map(({ name, description, markdown }) => ({ name, description, markdown })),
        mine: repo.userSkills(user.login),
    }));
    route("PUT", "/api/skills/:name", async ({ user, params, body }) => {
        const name = params[0]!;
        if (!/^[a-z][a-z0-9-]{1,47}$/.test(name)) throw new HttpError(400, "skill names are lowercase slugs");
        if (rt.directory.catalog.skills.has(name)) throw new HttpError(409, "an org skill already uses that name");
        const b = parse(SkillInput, await body());
        repo.saveUserSkill({ owner: user.login, name, ...b });
        rt.audit.log({ type: "skill.saved", name, status: b.status }, { actor: user.login });
        return repo.userSkill(user.login, name);
    });
    route("DELETE", "/api/skills/:name", async ({ user, params, res }) => {
        if (!repo.deleteUserSkill(user.login, params[0]!)) throw new HttpError(404, "skill not found");
        res.statusCode = 204;
    });

    // ---------------------------------------------------------------- connectors
    route("GET", "/api/connectors", async ({ user }) => ({
        connectors: [...rt.directory.catalog.connectors.values()].filter((c) => canUseConnector(user, c)).map((c) => {
            const cred = c.auth ? repo.credential(user.login, c.id) : undefined;
            return {
                id: c.id,
                name: c.name ?? c.id,
                description: c.description,
                type: c.type,
                auth: c.auth ?? null,
                status: c.auth ? (cred?.status ?? "not_connected") : "managed",
                updatedAt: cred?.updatedAt ?? null,
                requireApproval: c.requireApproval,
            };
        }),
    }));
    route("PUT", "/api/connectors/:id/credential", async ({ user, params, body }) => {
        const c = rt.directory.catalog.connectors.get(params[0]!);
        if (!c?.auth || !canUseConnector(user, c)) throw new HttpError(404, "connector does not take a credential");
        const { secret } = parse(z.object({ secret: z.string().min(1).max(10_000) }).strict(), await body());
        repo.saveCredential(user.login, c.id, o.sealer.seal(secret));
        rt.audit.trackSecret(secret);
        rt.audit.log({ type: "connector.connected", connectorId: c.id }, { actor: user.login });
        return { ok: true };
    });
    route("DELETE", "/api/connectors/:id/credential", async ({ user, params, res }) => {
        repo.deleteCredential(user.login, params[0]!);
        rt.audit.log({ type: "connector.disconnected", connectorId: params[0] }, { actor: user.login });
        res.statusCode = 204;
    });

    // ---------------------------------------------------------------- notifications
    route("GET", "/api/notifications", async ({ user }) => ({ notifications: repo.notifications(user.login) }));
    route("POST", "/api/notifications/read", async ({ user, body }) => {
        const { ids } = parse(z.object({ ids: z.array(z.string()).optional() }).strict(), await body());
        repo.markNotificationsRead(user.login, ids);
        return { ok: true };
    });

    // ---------------------------------------------------------------- uploads
    route("POST", "/api/uploads", async ({ user, req, res }) => {
        const name = decodeParam(String(req.headers["x-filename"] ?? "file"), "file name").replace(/[/\\\u0000-\u001f"]/g, "_").slice(0, 200) || "file";
        const rawType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        const mimeType = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(rawType) ? rawType : "application/octet-stream";
        if (repo.uploadBytes(user.login) >= maxStorage) throw new HttpError(413, "upload storage is full; delete old threads or ask an admin");
        const data = await readBody(req, maxUpload);
        const id = repo.addUpload(user.login, name, mimeType, data.length);
        await writeFile(rt.uploadPath(id), data);
        res.statusCode = 201;
        return { id, name, mimeType, size: data.length };
    });
    route("GET", "/api/uploads/:id", async ({ user, params, res }) => {
        const u = repo.upload(user.login, params[0]!);
        if (!u) throw new HttpError(404, "upload not found");
        // Only harmless types render inline; everything else downloads, so an uploaded HTML/SVG/PDF
        // can never run in (or be framed by) this origin.
        const inline = SAFE_INLINE_TYPES.has(u.mimeType);
        res.writeHead(200, {
            "Content-Type": inline ? u.mimeType : "application/octet-stream",
            "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(u.name)}`,
            "Content-Security-Policy": "default-src 'none'; sandbox",
        });
        createReadStream(rt.uploadPath(u.id)).pipe(res);
    });

    // ---------------------------------------------------------------- computer
    route("GET", "/api/computer/files", async ({ user, url }) => {
        const root = rt.computerDir(user.login);
        const dir = safeJoin(root, url.searchParams.get("path") ?? "");
        if (!existsSync(dir)) return { path: path.relative(root, dir), entries: [] };
        if (!insideDir(root, dir)) throw new HttpError(400, "path escapes the workspace");
        const entries = await Promise.all(
            (await readdir(dir, { withFileTypes: true })).slice(0, 500).map(async (e) => {
                const s = await stat(path.join(dir, e.name)).catch(() => undefined);
                return { name: e.name, dir: e.isDirectory(), size: s?.size ?? 0, modified: s?.mtime.toISOString() ?? null };
            }),
        );
        entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
        return { path: path.relative(root, dir), entries };
    });
    route("GET", "/api/computer/file", async ({ user, url, res }) => {
        const root = rt.computerDir(user.login);
        const file = safeJoin(root, url.searchParams.get("path") ?? "");
        // Bots can create symlinks with the shell; follow them before serving anything.
        if (!insideDir(root, file)) throw new HttpError(400, "path escapes the workspace");
        const s = await stat(file).catch(() => undefined);
        if (!s?.isFile()) throw new HttpError(404, "file not found");
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`, "Content-Security-Policy": "default-src 'none'; sandbox" });
        createReadStream(file).pipe(res);
    });
    route("POST", "/api/computer/upload", async ({ user, req, res }) => {
        const root = rt.computerDir(user.login);
        const rel = decodeParam(String(req.headers["x-path"] ?? ""), "path");
        const file = safeJoin(root, rel);
        if (file === root) throw new HttpError(400, "x-path is required");
        if (!insideDir(root, file)) throw new HttpError(400, "path escapes the workspace");
        await mkdir(path.dirname(file), { recursive: true });
        if ((await dirBytes(root)) >= maxStorage) throw new HttpError(413, "the computer's storage is full");
        await writeFile(file, await readBody(req, maxUpload), { mode: 0o600 });
        rt.audit.log({ type: "computer.upload", path: rel }, { actor: user.login });
        res.statusCode = 201;
        return { ok: true };
    });

    // ---------------------------------------------------------------- live events
    route("GET", "/api/events", async ({ user, req, res }) => {
        const open = streams.get(user.login) ?? 0;
        if (open >= MAX_STREAMS_PER_USER) throw new HttpError(429, "too many open event streams");
        streams.set(user.login, open + 1);
        req.on("close", () => {
            const n = (streams.get(user.login) ?? 1) - 1;
            if (n <= 0) streams.delete(user.login);
            else streams.set(user.login, n);
        });
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.write(`event: hello\ndata: ${JSON.stringify({ statuses: rt.status(user.login) })}\n\n`);
        const unsubscribe = rt.hub.subscribe(user.login, (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        await new Promise<void>((resolve) => req.on("close", resolve));
        clearInterval(ping);
        unsubscribe();
    });

    // ---------------------------------------------------------------- admin
    route("GET", "/api/admin/catalog", async ({ user }) => {
        requireAdmin(user);
        const c = rt.directory.catalog;
        return { bots: [...c.bots.values()], connectors: [...c.connectors.values()], skills: [...c.skills.values()].map(({ name, description }) => ({ name, description })) };
    });
    route("PUT", "/api/admin/bots/:id", async ({ user, params, body }) => {
        requireAdmin(user);
        const input = parse(BotInput, await body());
        if (input.id !== undefined && input.id !== params[0]) throw new HttpError(400, "body id does not match URL");
        const { catalog, bot } = await rt.directory.catalog.saveBot({ ...input, id: params[0] });
        setCatalog(catalog);
        rt.audit.log({ type: "bot.saved", botId: bot.id }, { actor: user.login });
        return bot;
    });
    route("POST", "/api/admin/reload", async ({ user }) => {
        requireAdmin(user);
        const c = await Catalog.load(rt.directory.catalog.root);
        setCatalog(c);
        return { bots: c.bots.size, connectors: c.connectors.size, skills: c.skills.size };
    });
    route("GET", "/api/admin/audit", async ({ user, url }) => {
        requireAdmin(user);
        if (!o.auditDir) return { records: [] };
        const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "bad date");
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const file = path.join(o.auditDir, `audit-${date}.jsonl`);
        const text = existsSync(file) ? await readFile(file, "utf8") : "";
        const records = text
            .split("\n")
            .filter((l) => l && (!q || l.toLowerCase().includes(q)))
            .slice(-1000)
            .reverse()
            .map((l) => JSON.parse(l) as unknown);
        return { date, records };
    });

    const setCatalog = (c: Catalog) => {
        rt.directory.setCatalog(c);
        rt.audit.log({ type: "catalog.reloaded", bots: c.bots.size, connectors: c.connectors.size, skills: c.skills.size });
    };

    // ---------------------------------------------------------------- request handling
    return createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        setSecurityHeaders(res, url.pathname, o.hsts ?? false);
        try {
            if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });

            // Public, unauthenticated routes
            if (url.pathname.startsWith("/auth/")) return await handleAuth(req, res, url);
            if (req.method === "GET" && url.pathname.startsWith("/api/share/")) return send(res, 200, sharedThread(url.pathname.slice("/api/share/".length)));
            if (req.method === "GET" && !url.pathname.startsWith("/api/")) return await serveStatic(res, url.pathname);

            const route_ = routes.find(([m, p]) => m === req.method && p.test(url.pathname));
            if (!route_) throw new HttpError(404, "not found");
            const who = await auth.userFor(req);
            if (!who) throw new HttpError(401, "sign in required");
            if (who.viaCookie && req.method !== "GET" && (req.headers["x-csrf"] !== "1" || !sameOrigin(req))) throw new HttpError(403, "cross-site request refused");
            if (!apiLimiter.take(who.user.login)) throw new HttpError(429, "too many requests; slow down");
            if (req.method === "POST" && /\/(messages|tasks|run|draft-skill)$/.test(url.pathname) && !postLimiter.take(who.user.login)) {
                throw new HttpError(429, "too many messages; slow down");
            }
            rt.audit.trackSecret(who.user.githubToken);

            let cached: Promise<unknown> | undefined;
            const params = route_[1].exec(url.pathname)!.slice(1).map((p) => decodeParam(p, "path"));
            const result = await route_[2]({ req, res, url, user: who.user, params, body: () => (cached ??= readJson(req)) });
            if (!res.headersSent && !res.writableEnded) send(res, res.statusCode, result);
        } catch (err) {
            if (res.headersSent) return void res.end();
            if (err instanceof HttpError) {
                if (err.status === 429) res.setHeader("Retry-After", "60");
                return send(res, err.status, { error: err.message, details: err.details });
            }
            if (err instanceof NotFoundError) return send(res, 404, { error: err.message });
            if (err instanceof InvalidError || err instanceof DirectoryError) return send(res, 422, { error: err.message });
            if (err instanceof CatalogError) return send(res, 422, { error: "invalid bot", details: err.problems });
            logError(err);
            send(res, 500, { error: "internal error" });
        }
    });

    async function handleAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
        const redirectUri = `${baseUrl(req)}/auth/github/callback`;
        if (req.method === "GET" && url.pathname === "/auth/config") {
            return send(res, 200, { github: auth.oauthEnabled, token: true, dev: auth.devLoginEnabled });
        }
        if (req.method === "GET" && url.pathname === "/auth/session") {
            const who = await auth.userFor(req).catch(() => null);
            return send(res, 200, { login: who?.user.login ?? null });
        }
        if (req.method === "GET" && url.pathname === "/auth/github/login") return auth.beginOAuth(res, redirectUri);
        if (req.method === "GET" && url.pathname === "/auth/github/callback") {
            try {
                await auth.completeOAuth(req, res, url, redirectUri);
                res.writeHead(302, { Location: "/" }).end();
            } catch (err) {
                // Never reflect free text into the page: log the detail, send a fixed code.
                logError(err);
                res.writeHead(302, { Location: "/?login_error=oauth" }).end();
            }
            return;
        }
        if (req.method !== "POST" || req.headers["x-csrf"] !== "1") throw new HttpError(404, "not found");
        if (!sameOrigin(req)) throw new HttpError(403, "cross-site request refused");
        if (url.pathname !== "/auth/logout" && !authLimiter.take(clientIp(req))) throw new HttpError(429, "too many sign-in attempts; wait a minute");
        if (url.pathname === "/auth/token") {
            const { token } = parse(z.object({ token: z.string().min(10).max(500) }).strict(), await readJson(req));
            const user = await auth.signInWithToken(res, token.trim());
            if (!user) throw new HttpError(401, "GitHub rejected that token");
            return send(res, 200, { login: user.login });
        }
        if (url.pathname === "/auth/dev") {
            if (!auth.devLoginEnabled) throw new HttpError(404, "not found");
            const { login } = parse(z.object({ login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/) }).strict(), await readJson(req));
            return send(res, 200, { login: auth.signInDev(res, login).login });
        }
        if (url.pathname === "/auth/logout") {
            auth.signOut(req, res);
            return send(res, 200, { ok: true });
        }
        throw new HttpError(404, "not found");
    }

    function sharedThread(token: string) {
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new HttpError(404, "this link is no longer shared");
        const s = repo.share(sha256(token));
        const t = s && repo.thread(s.threadId);
        if (!s || !t) throw new HttpError(404, "this link is no longer shared");
        const owner = { login: s.owner, orgs: repo.user(s.owner)?.orgs ?? [] };
        const bots = Object.fromEntries(
            t.botIds.map((id) => {
                const b = rt.directory.bot(owner, id)?.bot;
                return [id, b ? { name: b.name, title: b.title, avatar: b.avatar, color: b.color } : { name: id }];
            }),
        );
        // Only the conversation itself: no approvals, tool arguments (URLs, commands, paths), attachments or ids.
        const messages = repo
            .messages(t.id)
            .filter((m) => m.authorType !== "system")
            .map((m) => ({ seq: m.seq, authorType: m.authorType, authorId: m.authorId, text: m.text, createdAt: m.createdAt, meta: { tools: m.meta.tools?.map((x) => ({ tool: x.tool })) } }));
        return { thread: { title: t.title, kind: t.kind, owner: t.owner, createdAt: t.createdAt }, bots, messages };
    }

    async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
        const vendor: Record<string, string> = {
            "/vendor/marked.js": require_("marked/lib/marked.esm.js"),
            "/vendor/purify.js": require_("dompurify/dist/purify.es.mjs"),
        };
        let file = vendor[pathname];
        if (!file) {
            const rel = pathname === "/" || pathname.startsWith("/s/") || !path.extname(pathname) ? "index.html" : pathname.slice(1);
            file = safeJoin(o.webDir, rel);
        }
        const s = await stat(file).catch(() => undefined);
        if (!s?.isFile()) throw new HttpError(404, "not found");
        res.writeHead(200, {
            "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": APP_CSP,
        });
        createReadStream(file).pipe(res);
    }
}

/** Fixed-window counters, in memory (single node). Enough to blunt brute force and runaway clients. */
export class RateLimiter {
    private readonly windows = new Map<string, { count: number; reset: number }>();

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
    ) {}

    /** True when the call is allowed. */
    take(key: string, now = Date.now()): boolean {
        if (this.windows.size > 50_000) for (const [k, w] of this.windows) if (w.reset <= now) this.windows.delete(k);
        const w = this.windows.get(key);
        if (!w || w.reset <= now) {
            this.windows.set(key, { count: 1, reset: now + this.windowMs });
            return true;
        }
        w.count += 1;
        return w.count <= this.limit;
    }
}

/** The web app's CSP: no inline script or style, Trusted Types for the one HTML sink (sanitized Markdown). */
export const APP_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types dompurify",
].join("; ");

const SAFE_INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "text/plain"]);

function decodeParam(value: string, what: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        throw new HttpError(400, `malformed ${what}`);
    }
}

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json",
};

function require_(spec: string): string {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", spec);
}

/** Resolves `rel` under `root`, refusing anything that escapes it. */
export function safeJoin(root: string, rel: string): string {
    const full = path.resolve(root, "." + path.sep + rel.replace(/^[/\\]+/, ""));
    if (full !== root && !full.startsWith(root + path.sep)) throw new HttpError(400, "path escapes the workspace");
    return full;
}

/** Headers on every response; API responses also get a deny-all CSP and are never cached. */
function setSecurityHeaders(res: ServerResponse, pathname: string, hsts: boolean): void {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), geolocation=(), payment=(), usb=(), microphone=(self)");
    if (hsts) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (pathname.startsWith("/api/") || pathname.startsWith("/auth/")) {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; sandbox");
    }
}

/** Total bytes under `dir` (stops counting at 100k entries). */
async function dirBytes(dir: string): Promise<number> {
    let total = 0;
    let seen = 0;
    const walk = async (d: string): Promise<void> => {
        for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
            if (++seen > 100_000) return;
            const p = path.join(d, e.name);
            if (e.isDirectory()) await walk(p);
            else if (e.isFile()) total += (await stat(p).catch(() => undefined))?.size ?? 0;
        }
    };
    await walk(dir);
    return total;
}

function send(res: ServerResponse, status: number, body: unknown): void {
    if (body === undefined) {
        res.writeHead(status).end();
        return;
    }
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
    const r = schema.safeParse(body);
    if (!r.success) throw new HttpError(400, "invalid request body", r.error.issues);
    return r.data;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > limit) throw new HttpError(413, "request body too large");
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
    const buf = await readBody(req, 1_000_000);
    if (buf.length === 0) return {};
    try {
        return JSON.parse(buf.toString("utf8"));
    } catch {
        throw new HttpError(400, "body must be JSON");
    }
}

export type { BotSpec };
