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
        name: z.string().trim().min(1).max(80),
        /** Job title shown in the roster, e.g. "Release Manager". */
        title: z.string().min(1).max(60).optional(),
        /** Emoji or 1-2 characters shown as the avatar. */
        avatar: z.string().min(1).max(8).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        description: z.string().min(1).max(500),
        instructions: z.string().min(1).max(20_000),
        model: z.string().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/).optional(),
        reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
        builtinTools: z.array(BuiltinTool).default([]),
        /**
         * Domains web_fetch may reach (e.g. `docs.github.com`, `*.example.com`). Omit for any domain.
         * Limits where a prompt-injected bot can send data.
         */
        allowedDomains: z.array(z.string().max(253).regex(/^(\*\.)?[a-z0-9.-]+$/i)).max(50).optional(),
        skills: z.array(Id).max(50).default([]),
        connectors: z.array(Id).max(20).default([]),
        /** Bot ids this bot may message or hand tasks to; `"*"` means any bot the user can use. */
        canMessage: z.array(z.union([Id, z.literal("*")])).max(50).default([]),
        access: AccessSpec.default({ users: [], orgs: [] }),
        /**
         * A per-user workspace (files, and shell commands when allowed) shared by all of that user's
         * bots, like a shared cloud computer. File reads are allowed; writes and shell ask first.
         */
        computer: z.boolean().default(false),
        /** Remember facts across threads with the remember/forget tools. */
        memory: z.boolean().default(true),
        permissions: z
            .object({
                /** Permission kinds approved automatically. Derived from the bot's tools when omitted. */
                allow: z.array(PermissionKind).optional(),
                /** Permission kinds that wait for the user's approval. Derived when omitted. */
                ask: z.array(PermissionKind).optional(),
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
    name: z.string().min(1).max(80).optional(),
    description: z.string().min(1).max(500),
    /**
     * A per-user credential (API key, personal token) the user enters once under Connectors.
     * Reference it as `${user.credential}` in headers, env or args.
     */
    auth: z
        .object({
            type: z.literal("secret"),
            label: z.string().min(1).max(80),
            help: z.string().max(500).optional(),
        })
        .strict()
        .optional(),
    /** MCP tool names to expose; omit or `["*"]` for all. */
    tools: z.array(z.string().min(1)).optional(),
    timeoutMs: z.number().int().positive().optional(),
    /**
     * Who may put this connector on their personal bots. Org bots that list it can always use it.
     * Defaults to everyone, except connectors that embed org secrets (`${env:...}`), which default
     * to nobody so a shared credential is never handed to arbitrary users.
     */
    access: AccessSpec.optional(),
    /**
     * When a tool call waits for the user's approval: `writes` (default) asks for every tool the
     * server does not mark read-only; `always` asks for every call; `never` asks for none.
     */
    requireApproval: z.enum(["writes", "always", "never"]).default("writes"),
    /** Tool names (or `prefix*` patterns) that never need approval, e.g. `["search_*", "get_*"]`. */
    allowTools: z.array(z.string().min(1)).default([]),
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

/** True when the connector carries an org secret from the server environment. */
export function usesOrgSecrets(c: ConnectorSpec): boolean {
    return JSON.stringify(c).includes("${env:");
}

/** Matches `name` against exact names and `prefix*` patterns. */
export function matchesToolPattern(name: string, patterns: string[]): boolean {
    return patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : p === name));
}

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
    /** Absolute path of the skill folder, for supporting files (workspace skills only). */
    directory?: string;
}

export interface PermissionPolicy {
    allow: PermissionKind[];
    ask: PermissionKind[];
}

/** What a bot may do without asking, and what needs the user's approval. Everything else is denied. */
export function derivedPermissions(bot: BotSpec): PermissionPolicy {
    const allow = new Set<PermissionKind>(["custom-tool"]);
    const ask = new Set<PermissionKind>();
    if (bot.builtinTools.length > 0) allow.add("url");
    if (bot.connectors.length > 0) allow.add("mcp");
    if (bot.computer) {
        allow.add("read");
        ask.add("write");
        ask.add("shell");
    }
    const explicitAllow = bot.permissions.allow;
    const explicitAsk = bot.permissions.ask;
    const finalAllow = explicitAllow ?? [...allow];
    const finalAsk = (explicitAsk ?? [...ask]).filter((k) => !finalAllow.includes(k));
    return { allow: finalAllow, ask: finalAsk };
}
