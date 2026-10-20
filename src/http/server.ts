import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { Catalog, CatalogError } from "../catalog/catalog.js";
import type { BotSpec } from "../catalog/schema.js";
import { NotFoundError, type Platform } from "../conversations/service.js";
import type { Conversation } from "../conversations/store.js";
import type { Authenticator, User } from "../identity.js";

export interface ServerOptions {
    platform: Platform;
    auth: Authenticator;
    /** GitHub logins allowed to use the admin endpoints. */
    admins: string[];
    maxBodyBytes?: number;
}

class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly details?: unknown,
    ) {
        super(message);
    }
}

const CreateConversation = z.object({ botId: z.string().min(1), title: z.string().max(200).optional() }).strict();
const SendMessage = z.object({ text: z.string().min(1).max(32_000) }).strict();

type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; user: User; params: string[] }) => Promise<unknown>;

/**
 * REST API:
 *
 *     GET    /healthz
 *     GET    /v1/me
 *     GET    /v1/bots                          bots you can talk to
 *     GET    /v1/bots/:id
 *     POST   /v1/conversations                 { botId, title? }
 *     GET    /v1/conversations
 *     GET    /v1/conversations/:id
 *     DELETE /v1/conversations/:id
 *     POST   /v1/conversations/:id/messages    { text }   (Accept: text/event-stream to stream)
 *     GET    /v1/admin/catalog                 admins only
 *     PUT    /v1/admin/bots/:id                admins only, body is a bot spec
 *     POST   /v1/admin/reload                  admins only
 *
 * Every /v1 route needs `Authorization: Bearer <GitHub token>`; that token is also what the
 * Copilot runtime and the user's connectors authenticate with.
 */
export function createApiServer(options: ServerOptions): Server {
    const { platform, auth } = options;
    const admins = new Set(options.admins.map((a) => a.toLowerCase()));
    const maxBody = options.maxBodyBytes ?? 1_000_000;

    const requireAdmin = (user: User) => {
        if (!admins.has(user.login.toLowerCase())) throw new HttpError(403, "admin access required");
    };

    const routes: [method: string, pattern: RegExp, handler: Handler][] = [
        ["GET", /^\/v1\/me$/, async ({ user }) => ({ login: user.login, orgs: user.orgs, admin: admins.has(user.login.toLowerCase()) })],
        ["GET", /^\/v1\/bots$/, async ({ user }) => ({ bots: platform.visibleBots(user).map(publicBot) })],
        [
            "GET",
            /^\/v1\/bots\/([^/]+)$/,
            async ({ user, params }) => {
                const bot = platform.visibleBots(user).find((b) => b.id === params[0]);
                if (!bot) throw new HttpError(404, `bot ${params[0]} not found`);
                return publicBot(bot);
            },
        ],
        [
            "POST",
            /^\/v1\/conversations$/,
            async ({ req, res, user }) => {
                const body = parse(CreateConversation, await readJson(req, maxBody));
                res.statusCode = 201;
                return summary(await platform.createConversation(user, body.botId, body.title));
            },
        ],
        ["GET", /^\/v1\/conversations$/, async ({ user }) => ({ conversations: (await platform.listConversations(user)).map(summary) })],
        ["GET", /^\/v1\/conversations\/([^/]+)$/, async ({ user, params }) => platform.getConversation(user, params[0]!)],
        [
            "DELETE",
            /^\/v1\/conversations\/([^/]+)$/,
            async ({ res, user, params }) => {
                await platform.deleteConversation(user, params[0]!);
                res.statusCode = 204;
                return undefined;
            },
        ],
        [
            "POST",
            /^\/v1\/conversations\/([^/]+)\/messages$/,
            async ({ req, res, user, params }) => {
                const { text } = parse(SendMessage, await readJson(req, maxBody));
                const id = params[0]!;
                if (!(req.headers.accept ?? "").includes("text/event-stream")) {
                    return platform.send(user, id, text);
                }
                // Validate ownership before committing to a stream so errors still get proper status codes.
                await platform.getConversation(user, id);
                res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
                const sse = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                try {
                    const result = await platform.send(user, id, text, (e) => sse(e.type, e));
                    sse("done", result);
                } catch (err) {
                    sse("error", { message: (err as Error).message });
                }
                res.end();
                return undefined;
            },
        ],
        [
            "GET",
            /^\/v1\/admin\/catalog$/,
            async ({ user }) => {
                requireAdmin(user);
                const c = platform.catalog;
                return {
                    bots: [...c.bots.values()],
                    connectors: [...c.connectors.values()],
                    skills: [...c.skills.values()].map(({ name, description }) => ({ name, description })),
                };
            },
        ],
        [
            "PUT",
            /^\/v1\/admin\/bots\/([^/]+)$/,
            async ({ req, user, params }) => {
                requireAdmin(user);
                const body = (await readJson(req, maxBody)) as Record<string, unknown>;
                if (body.id !== undefined && body.id !== params[0]) throw new HttpError(400, "body id does not match URL");
                const { catalog, bot } = await platform.catalog.saveBot({ ...body, id: params[0] });
                platform.setCatalog(catalog);
                platform.audit.log({ type: "bot.saved", botId: bot.id }, { actor: user.login });
                return bot;
            },
        ],
        [
            "POST",
            /^\/v1\/admin\/reload$/,
            async ({ user }) => {
                requireAdmin(user);
                platform.setCatalog(await Catalog.load(platform.catalog.root));
                const c = platform.catalog;
                return { bots: c.bots.size, connectors: c.connectors.size, skills: c.skills.size };
            },
        ],
    ];

    return createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? "/", "http://localhost");
            if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });

            const route = routes.find(([m, p]) => m === req.method && p.test(url.pathname));
            if (!route) throw new HttpError(404, "not found");

            const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
            if (!token) throw new HttpError(401, "missing bearer token");
            const user = await auth.authenticate(token);
            if (!user) throw new HttpError(401, "invalid token");
            platform.audit.trackSecret(user.githubToken);

            const params = route[1].exec(url.pathname)!.slice(1).map(decodeURIComponent);
            const result = await route[2]({ req, res, user, params });
            if (!res.headersSent) send(res, res.statusCode, result);
        } catch (err) {
            if (res.headersSent) return void res.end();
            if (err instanceof HttpError) return send(res, err.status, { error: err.message, details: err.details });
            if (err instanceof NotFoundError) return send(res, 404, { error: err.message });
            if (err instanceof CatalogError) return send(res, 422, { error: "invalid bot", details: err.problems });
            console.error(err);
            send(res, 500, { error: "internal error" });
        }
    });
}

function publicBot(bot: BotSpec) {
    return {
        id: bot.id,
        name: bot.name,
        description: bot.description,
        model: bot.model,
        skills: bot.skills,
        connectors: bot.connectors,
        canMessage: bot.canMessage,
    };
}

function summary(c: Conversation) {
    const { messages, ...rest } = c;
    return { ...rest, messageCount: messages.length };
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

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > limit) throw new HttpError(413, "request body too large");
        chunks.push(chunk as Buffer);
    }
    if (size === 0) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new HttpError(400, "body must be JSON");
    }
}
