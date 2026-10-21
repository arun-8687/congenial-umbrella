import type { IncomingMessage, ServerResponse } from "node:http";
import { randomToken, sha256, type Sealer } from "../crypto.js";
import type { Authenticator, User } from "../identity.js";
import type { ApiScope, Repo } from "../runtime/repo.js";

/** Prefix of platform API tokens, so they are recognizable (and scannable) in logs and repos. */
export const API_TOKEN_PREFIX = "cbp_";

export const SESSION_COOKIE = "cb_session";
const STATE_COOKIE = "cb_oauth_state";
const SESSION_TTL_MS = 7 * 24 * 3600_000;

export interface OAuthConfig {
    clientId: string;
    clientSecret: string;
    /** https://github.com, or your GitHub Enterprise Server URL. */
    webUrl: string;
    scope: string;
}

export interface AuthOptions {
    authenticator: Authenticator;
    repo: Repo;
    sealer: Sealer;
    oauth?: OAuthConfig;
    /** Local demos only: sign in as any login without GitHub. */
    devLogin: boolean;
    secureCookies: boolean;
    /** Called for every successful sign-in, so background work can later run as the user. */
    onSignIn: (user: User) => void;
}

/**
 * Browser sessions (an opaque cookie whose hash maps to the user's sealed GitHub token) and bearer
 * tokens for API clients. Either way the request runs as a real GitHub user.
 */
export class WebAuth {
    constructor(private readonly o: AuthOptions) {}

    get oauthEnabled(): boolean {
        return Boolean(this.o.oauth);
    }

    get devLoginEnabled(): boolean {
        return this.o.devLogin;
    }

    /**
     * Resolves the request's user, whether it came from a cookie (cookie requests need CSRF checks),
     * and for platform API tokens the scopes the token was given.
     */
    async userFor(req: IncomingMessage): Promise<{ user: User; viaCookie: boolean; scopes?: ApiScope[]; tokenId?: string } | null> {
        const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim();
        if (bearer?.startsWith(API_TOKEN_PREFIX)) {
            const t = this.o.repo.apiTokenByHash(sha256(bearer));
            const stored = t && this.o.repo.user(t.owner);
            if (!t || !stored) return null;
            // The token acts as its owner, so the owner's GitHub sign-in must still be valid.
            const token = this.o.sealer.open(stored.tokenCiphertext);
            const user =
                this.o.devLogin && token.startsWith("dev-token-")
                    ? { login: stored.login, id: stored.githubId, orgs: stored.orgs, githubToken: token }
                    : await this.o.authenticator.authenticate(token);
            if (!user || user.login !== t.owner) return null;
            this.o.repo.touchApiToken(t.id);
            return { user, viaCookie: false, scopes: t.scopes, tokenId: t.id };
        }
        if (bearer) {
            const user = await this.o.authenticator.authenticate(bearer);
            if (user) this.o.onSignIn(user);
            return user && { user, viaCookie: false };
        }
        const sid = cookies(req)[SESSION_COOKIE];
        if (!sid) return null;
        const s = this.o.repo.webSession(sha256(sid));
        if (!s) return null;
        const stored = this.o.repo.user(s.login);
        if (!stored) return null;
        const token = this.o.sealer.open(s.tokenCiphertext);
        if (this.o.devLogin && token.startsWith("dev-token-")) {
            return { user: { login: stored.login, id: stored.githubId, orgs: stored.orgs, githubToken: token }, viaCookie: true };
        }
        // Re-check the token (cached by the authenticator) so revoked tokens and org removals take
        // effect within minutes rather than when the cookie expires.
        const fresh = await this.o.authenticator.authenticate(token);
        if (!fresh) {
            this.o.repo.deleteWebSession(sha256(sid));
            return null;
        }
        this.o.onSignIn(fresh);
        return { user: fresh, viaCookie: true };
    }

    /** Signs in with a GitHub token pasted by the user (PAT or OAuth token). */
    async signInWithToken(res: ServerResponse, token: string): Promise<User | null> {
        const user = await this.o.authenticator.authenticate(token);
        if (!user) return null;
        this.startSession(res, user);
        return user;
    }

    signInDev(res: ServerResponse, login: string): User {
        if (!this.o.devLogin) throw new Error("dev login is disabled");
        const user: User = { login, id: 0, orgs: ["demo"], githubToken: `dev-token-${login}` };
        this.startSession(res, user);
        return user;
    }

    signOut(req: IncomingMessage, res: ServerResponse): void {
        const sid = cookies(req)[SESSION_COOKIE];
        if (sid) this.o.repo.deleteWebSession(sha256(sid));
        res.setHeader("Set-Cookie", this.cookie(SESSION_COOKIE, "", 0));
    }

    /** Redirect to GitHub's authorize page with a CSRF state cookie. */
    beginOAuth(res: ServerResponse, redirectUri: string): void {
        const o = this.o.oauth;
        if (!o) throw new Error("GitHub OAuth is not configured");
        const state = randomToken(16);
        const url = new URL("/login/oauth/authorize", o.webUrl);
        url.searchParams.set("client_id", o.clientId);
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("scope", o.scope);
        url.searchParams.set("state", state);
        res.writeHead(302, { Location: url.toString(), "Set-Cookie": this.cookie(STATE_COOKIE, state, 600) }).end();
    }

    async completeOAuth(req: IncomingMessage, res: ServerResponse, url: URL, redirectUri: string, fetchImpl: typeof fetch = fetch): Promise<User> {
        const o = this.o.oauth;
        if (!o) throw new Error("GitHub OAuth is not configured");
        const state = url.searchParams.get("state");
        if (!state || state !== cookies(req)[STATE_COOKIE]) throw new Error("OAuth state mismatch; try signing in again");
        const code = url.searchParams.get("code");
        if (!code) throw new Error("GitHub did not return a code");
        const r = await fetchImpl(new URL("/login/oauth/access_token", o.webUrl), {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: o.clientId, client_secret: o.clientSecret, code, redirect_uri: redirectUri }),
        });
        const body = (await r.json()) as { access_token?: string; error_description?: string };
        if (!body.access_token) throw new Error(body.error_description ?? "GitHub did not return a token");
        const user = await this.o.authenticator.authenticate(body.access_token);
        if (!user) throw new Error("GitHub rejected the new token");
        this.startSession(res, user, [this.cookie(STATE_COOKIE, "", 0)]);
        return user;
    }

    private startSession(res: ServerResponse, user: User, extraCookies: string[] = []): void {
        this.o.onSignIn(user);
        const sid = randomToken();
        this.o.repo.createWebSession(sha256(sid), user.login, this.o.sealer.seal(user.githubToken), SESSION_TTL_MS);
        res.setHeader("Set-Cookie", [this.cookie(SESSION_COOKIE, sid, SESSION_TTL_MS / 1000), ...extraCookies]);
    }

    private cookie(name: string, value: string, maxAgeS: number): string {
        return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeS)}${this.o.secureCookies ? "; Secure" : ""}`;
    }
}

export function cookies(req: IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of (req.headers.cookie ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}
