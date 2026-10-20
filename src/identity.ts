import { createHash } from "node:crypto";
import type { BotSpec } from "./catalog/schema.js";

/** The person a request runs as. Every Copilot turn and connector call uses their token. */
export interface User {
    login: string;
    id: number;
    orgs: string[];
    githubToken: string;
}

export interface Authenticator {
    /** Resolves a bearer token to a user, or `null` when the token is not valid. */
    authenticate(token: string): Promise<User | null>;
}

/**
 * Authenticates GitHub tokens (OAuth app / GitHub App user tokens or PATs) with `GET /user`.
 * Org membership comes from `GET /user/orgs`, which needs the `read:org` scope; without it the
 * user simply has no orgs, so org-scoped bots stay hidden rather than failing open.
 */
export class GitHubAuthenticator implements Authenticator {
    private readonly cache = new Map<string, { user: User | null; expires: number }>();

    constructor(
        private readonly apiUrl = "https://api.github.com",
        private readonly ttlMs = 5 * 60_000,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {}

    async authenticate(token: string): Promise<User | null> {
        const key = createHash("sha256").update(token).digest("hex");
        const hit = this.cache.get(key);
        if (hit && hit.expires > Date.now()) return hit.user;

        const user = await this.lookup(token);
        if (this.cache.size >= 10_000) {
            const now = Date.now();
            for (const [k, v] of this.cache) if (v.expires <= now) this.cache.delete(k);
        }
        this.cache.set(key, { user, expires: Date.now() + this.ttlMs });
        return user;
    }

    private async lookup(token: string): Promise<User | null> {
        const headers = {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "copilot-bot-platform",
        };
        const res = await this.fetchImpl(`${this.apiUrl}/user`, { headers });
        if (res.status === 401 || res.status === 403) return null;
        if (!res.ok) throw new Error(`GitHub /user returned ${res.status}`);
        const body = (await res.json()) as { login: string; id: number };

        let orgs: string[] = [];
        const orgRes = await this.fetchImpl(`${this.apiUrl}/user/orgs?per_page=100`, { headers });
        if (orgRes.ok) orgs = ((await orgRes.json()) as { login: string }[]).map((o) => o.login.toLowerCase());

        return { login: body.login, id: body.id, orgs, githubToken: token };
    }
}

export function canUseBot(user: Pick<User, "login" | "orgs">, bot: BotSpec): boolean {
    const login = user.login.toLowerCase();
    if (bot.access.users.some((u) => u === "*" || u.toLowerCase() === login)) return true;
    const orgs = new Set(user.orgs.map((o) => o.toLowerCase()));
    return bot.access.orgs.some((o) => orgs.has(o.toLowerCase()));
}
