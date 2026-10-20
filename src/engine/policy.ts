import { derivedPermissions, type BotSpec, type PermissionKind } from "../catalog/schema.js";

export interface PermissionCheck {
    kind: string;
    /** Short human-readable description for the audit log. */
    detail?: string;
}

export type PermissionVerdict = { decision: "approve" } | { decision: "reject"; feedback: string };

/** Deny-by-default: only kinds the bot is granted are approved. */
export function decidePermission(bot: BotSpec, request: PermissionCheck): PermissionVerdict {
    const allowed = derivedPermissions(bot) as string[];
    if (allowed.includes(request.kind)) return { decision: "approve" };
    return {
        decision: "reject",
        feedback: `Bot '${bot.id}' is not permitted to perform '${request.kind}' operations. Do not retry; answer without it.`,
    };
}

export function describeRequest(request: Record<string, unknown>): string | undefined {
    for (const key of ["url", "fullCommandText", "fileName", "path", "toolName", "serverName"]) {
        const v = request[key];
        if (typeof v === "string" && v.length > 0) return `${key}=${v.slice(0, 200)}`;
    }
    return undefined;
}

export type { PermissionKind };
