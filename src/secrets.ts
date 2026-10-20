import type { User } from "./identity.js";

const PLACEHOLDER = /\$\{(env:[A-Za-z_][A-Za-z0-9_]*|user\.githubToken|user\.login|user\.credential|user\.computerDir)\}/g;

export class SecretError extends Error {}

export interface PlaceholderContext {
    user: User;
    env?: NodeJS.ProcessEnv;
    /** The user's stored credential for the connector being resolved. */
    credential?: string;
    /** The user's shared computer directory. */
    computerDir?: string;
}

/**
 * Expands `${env:NAME}`, `${user.githubToken}`, `${user.login}`, `${user.credential}` and
 * `${user.computerDir}` in a connector value. Resolution happens per session, so a user's secrets
 * flow only into that user's connectors.
 */
export function resolvePlaceholders(value: string, ctx: PlaceholderContext): string {
    return value.replace(PLACEHOLDER, (_, ref: string) => {
        switch (ref) {
            case "user.githubToken":
                return ctx.user.githubToken;
            case "user.login":
                return ctx.user.login;
            case "user.credential":
                if (ctx.credential === undefined) throw new SecretError("connector credential is not connected");
                return ctx.credential;
            case "user.computerDir":
                if (ctx.computerDir === undefined) throw new SecretError("no computer directory for this user");
                return ctx.computerDir;
        }
        const name = ref.slice("env:".length);
        const v = (ctx.env ?? process.env)[name];
        if (v === undefined) throw new SecretError(`environment variable ${name} is not set`);
        return v;
    });
}

export function resolveRecord(record: Record<string, string>, ctx: PlaceholderContext): Record<string, string> {
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, resolvePlaceholders(v, ctx)]));
}

/** Replaces every occurrence of the given secrets in `text`. */
export function redact(text: string, secrets: Iterable<string>): string {
    let out = text;
    for (const s of secrets) if (s.length >= 6) out = out.split(s).join("[REDACTED]");
    return out;
}
