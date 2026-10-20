import { z } from "zod";

/** Lowercase slug used for bot, connector and skill identifiers. */
export const Id = z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,47}$/, "must be a lowercase slug (a-z, 0-9, '-'), 2-48 chars, starting with a letter");

/**
 * Permission kinds the Copilot runtime asks about before running a tool.
 * See `PermissionRequest.kind` in @github/copilot-sdk.
 */
export const PermissionKind = z.enum(["shell", "write", "read", "mcp", "custom-tool", "url", "memory", "hook"]);
export type PermissionKind = z.infer<typeof PermissionKind>;

/**
 * Built-in runtime tools a bot may opt into. Everything else the coding agent ships with
 * (bash, file edits, ...) stays off: the client runs in `mode: "empty"`.
 */
export const BuiltinTool = z.enum(["web_fetch", "web_search"]);
export type BuiltinTool = z.infer<typeof BuiltinTool>;

export const AccessSpec = z
    .object({
        /** GitHub logins allowed to use the bot; `"*"` means any authenticated user. */
        users: z.array(z.string().min(1)).default([]),
        /** GitHub orgs whose members may use the bot. */
        orgs: z.array(z.string().min(1)).default([]),
    })
    .strict();
export type AccessSpec = z.infer<typeof AccessSpec>;

export const BotSpec = z
    .object({
        id: Id,
        name: z.string().min(1).max(80),
        description: z.string().min(1).max(500),
        instructions: z.string().min(1),
        model: z.string().min(1).optional(),
        reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
        builtinTools: z.array(BuiltinTool).default([]),
        skills: z.array(Id).default([]),
        connectors: z.array(Id).default([]),
        /** Bot ids this bot may call through `ask_bot`. */
        canMessage: z.array(Id).default([]),
        access: AccessSpec.default({ users: [], orgs: [] }),
        permissions: z
            .object({
                /** Permission kinds approved automatically. Derived from the bot's tools when omitted. */
                allow: z.array(PermissionKind).optional(),
            })
            .strict()
            .default({}),
        /** Hide the bot from listings; it can still be reached by bots that list it in `canMessage`. */
        internal: z.boolean().default(false),
    })
    .strict();
export type BotSpec = z.infer<typeof BotSpec>;
/** Shape accepted on input, before defaults are applied. */
export type BotSpecInput = z.input<typeof BotSpec>;

const ConnectorBase = {
    id: Id,
    description: z.string().min(1).max(500),
    /** MCP tool names to expose; omit or `["*"]` for all. */
    tools: z.array(z.string().min(1)).optional(),
    timeoutMs: z.number().int().positive().optional(),
};

export const ConnectorSpec = z.discriminatedUnion("type", [
    z
        .object({
            ...ConnectorBase,
            type: z.literal("stdio"),
            command: z.string().min(1),
            args: z.array(z.string()).default([]),
            env: z.record(z.string(), z.string()).default({}),
            workingDirectory: z.string().optional(),
        })
        .strict(),
    z
        .object({
            ...ConnectorBase,
            type: z.enum(["http", "sse"]),
            url: z.string().url(),
            headers: z.record(z.string(), z.string()).default({}),
        })
        .strict(),
]);
export type ConnectorSpec = z.infer<typeof ConnectorSpec>;

export const SkillFrontmatter = z
    .object({
        name: Id,
        description: z.string().min(1).max(1024),
    })
    .passthrough();

export interface SkillSpec {
    name: string;
    description: string;
    /** Full SKILL.md text, frontmatter included. */
    markdown: string;
    /** Absolute path of the skill folder, for supporting files. */
    directory: string;
}

/** Permission kinds a bot gets when its spec does not list them explicitly. */
export function derivedPermissions(bot: BotSpec): PermissionKind[] {
    if (bot.permissions.allow) return bot.permissions.allow;
    const kinds = new Set<PermissionKind>(["custom-tool"]);
    if (bot.builtinTools.length > 0) kinds.add("url");
    if (bot.connectors.length > 0) kinds.add("mcp");
    return [...kinds];
}
