import { derivedPermissions, type BotSpec } from "../catalog/schema.js";

export type PolicyDecision = "allow" | "ask" | "deny";

/** Deny-by-default: granted kinds run, `ask` kinds wait for the user, everything else is refused. */
export function policyFor(bot: BotSpec, kind: string): PolicyDecision {
    const p = derivedPermissions(bot);
    if ((p.allow as string[]).includes(kind)) return "allow";
    if ((p.ask as string[]).includes(kind)) return "ask";
    return "deny";
}

export function denialFeedback(bot: BotSpec, kind: string): string {
    return `Bot '${bot.id}' is not permitted to perform '${kind}' operations. Do not retry; answer without it.`;
}

export function describeRequest(request: Record<string, unknown>): string | undefined {
    for (const key of ["fullCommandText", "url", "fileName", "path", "toolName", "serverName"]) {
        const v = request[key];
        if (typeof v === "string" && v.length > 0) return `${key === "fullCommandText" ? "$ " : ""}${v.slice(0, 300)}`;
    }
    return undefined;
}
