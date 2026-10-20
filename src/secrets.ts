import type { User } from "./identity.js";

const PLACEHOLDER = /\$\{(env:[A-Za-z_][A-Za-z0-9_]*|user\.githubToken|user\.login)\}/g;

export class SecretError extends Error {}

/**
 * Expands `${env:NAME}`, `${user.githubToken}` and `${user.login}` in a connector value.
 * Resolution happens per session, so the user's token flows only into that user's connectors.
 */
export function resolvePlaceholders(value: string, user: User, env: NodeJS.ProcessEnv = process.env): string {
    return value.replace(PLACEHOLDER, (_, ref: string) => {
        if (ref === "user.githubToken") return user.githubToken;
        if (ref === "user.login") return user.login;
        const name = ref.slice("env:".length);
        const v = env[name];
        if (v === undefined) throw new SecretError(`environment variable ${name} is not set`);
        return v;
    });
}

export function resolveRecord(
    record: Record<string, string>,
    user: User,
    env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, resolvePlaceholders(v, user, env)]));
}

/** Replaces every occurrence of the given secrets in `text`. */
export function redact(text: string, secrets: Iterable<string>): string {
    let out = text;
    for (const s of secrets) if (s.length >= 6) out = out.split(s).join("[REDACTED]");
    return out;
}
