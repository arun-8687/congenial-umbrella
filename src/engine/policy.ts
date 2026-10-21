import { realpathSync } from "node:fs";
import path from "node:path";
import { derivedPermissions, matchesToolPattern, type BotSpec, type ConnectorSpec } from "../catalog/schema.js";
import type { PermissionAsk } from "./types.js";

export type PolicyDecision = "allow" | "ask" | "deny";

/**
 * Deployment-wide setting for the shared computer. The Copilot runtime's file and shell tools run on
 * the platform host, so this is decided by whoever runs the platform, not by bot authors:
 * `off` (default) gives no bot a computer, `files` allows file tools confined to the user's
 * workspace, `shell` also allows shell commands (only safe when each user's runtime is isolated).
 */
export type ComputerAccess = "off" | "files" | "shell";

export interface PolicyContext {
    computerAccess: ComputerAccess;
    /** The requesting user's workspace; file access outside it is always refused. */
    computerDir?: string;
    /** Looks up a granted connector by its MCP server name (the connector id). */
    connector: (id: string) => ConnectorSpec | undefined;
}

export type Decision = { decision: "allow" } | { decision: "ask" } | { decision: "deny"; reason: string };

/** The bot's own allow/ask lists. Everything not listed is denied. */
export function policyFor(bot: BotSpec, kind: string): PolicyDecision {
    const p = derivedPermissions(bot);
    if ((p.allow as string[]).includes(kind)) return "allow";
    if ((p.ask as string[]).includes(kind)) return "ask";
    return "deny";
}

/**
 * The full decision for one permission request: the bot's policy, narrowed by deployment settings
 * and by what is being touched (path, domain, connector tool). Narrowing never widens: a request the
 * bot's policy denies stays denied.
 */
export function decide(bot: BotSpec, ask: PermissionAsk, ctx: PolicyContext): Decision {
    const base = policyFor(bot, ask.kind);
    const deny = (reason: string): Decision => ({ decision: "deny", reason });
    if (base === "deny") return deny(`'${ask.kind}' is not permitted for this bot`);

    switch (ask.kind) {
        case "read":
        case "write": {
            if (!bot.computer || ctx.computerAccess === "off" || !ctx.computerDir) return deny("this bot has no computer");
            if (!ask.path) return deny("the file path could not be determined");
            if (!insideDir(ctx.computerDir, ask.path)) return deny(`${ask.path} is outside the shared workspace`);
            break;
        }
        case "shell":
            if (!bot.computer || ctx.computerAccess !== "shell") return deny("shell commands are disabled on this platform");
            break;
        case "url": {
            if (bot.allowedDomains?.length) {
                const host = hostOf(ask.url);
                if (!host || !bot.allowedDomains.some((d) => domainMatches(host, d))) return deny(`${host ?? "that URL"} is not in this bot's allowed domains`);
            }
            break;
        }
        case "mcp": {
            const c = ask.server ? ctx.connector(ask.server) : undefined;
            if (!c) return deny(`connector ${ask.server ?? "(unknown)"} is not granted to this bot`);
            if (base === "ask") return { decision: "ask" };
            const allowListed = ask.tool !== undefined && matchesToolPattern(ask.tool, c.allowTools);
            if (c.requireApproval === "never" || allowListed) return { decision: "allow" };
            if (c.requireApproval === "always") return { decision: "ask" };
            return ask.readOnly ? { decision: "allow" } : { decision: "ask" };
        }
    }
    return { decision: base };
}

export function denialFeedback(reason: string): string {
    return `Not allowed: ${reason}. Do not retry; continue without it or explain what you would need.`;
}

export function describeRequest(request: Record<string, unknown>): string | undefined {
    if (request.kind === "mcp" && typeof request.toolName === "string") {
        return `${String(request.serverName ?? "")} · ${request.toolName}${request.args ? ` ${JSON.stringify(request.args).slice(0, 240)}` : ""}`;
    }
    for (const key of ["fullCommandText", "url", "resolvedPath", "path", "fileName", "toolName", "serverName"]) {
        const v = request[key];
        if (typeof v === "string" && v.length > 0) return `${key === "fullCommandText" ? "$ " : ""}${v.slice(0, 300)}`;
    }
    return undefined;
}

/** True when `target` (absolute, or relative to `dir`) stays inside `dir`, following symlinks that exist. */
export function insideDir(dir: string, target: string): boolean {
    const root = realOrSelf(path.resolve(dir));
    const full = path.resolve(root, target);
    const real = realOrSelf(full);
    const within = (p: string) => p === root || p.startsWith(root + path.sep);
    return within(full) && within(real);
}

/** realpath of the path, or of its deepest existing ancestor joined with the rest. */
function realOrSelf(p: string): string {
    let cur = p;
    const rest: string[] = [];
    for (;;) {
        try {
            return path.join(realpathSync(cur), ...rest.reverse());
        } catch {
            const parent = path.dirname(cur);
            if (parent === cur) return p;
            rest.push(path.basename(cur));
            cur = parent;
        }
    }
}

function hostOf(url?: string): string | undefined {
    try {
        return url ? new URL(url).hostname.toLowerCase() : undefined;
    } catch {
        return undefined;
    }
}

function domainMatches(host: string, pattern: string): boolean {
    const p = pattern.toLowerCase();
    if (p.startsWith("*.")) return host.endsWith(p.slice(1)) || host === p.slice(2);
    return host === p || host.endsWith(`.${p}`);
}
