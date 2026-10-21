import type { z } from "zod";
import type { BotSpec, ConnectorSpec, SkillSpec } from "../catalog/schema.js";
import type { User } from "../identity.js";

/** A host-side tool the platform injects into a bot's session (bus, tasks, memory). */
export interface PlatformTool<S extends z.ZodType = z.ZodType> {
    name: string;
    description: string;
    parameters: S;
    handler: (args: z.infer<S>) => Promise<string>;
}

/** Builds a tool with its handler typed from the zod schema. */
export function platformTool<S extends z.ZodType>(tool: PlatformTool<S>): PlatformTool {
    return tool as unknown as PlatformTool;
}

export type EngineEvent =
    | { type: "delta"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "tool.start"; tool: string; args?: unknown }
    | { type: "tool.complete"; tool: string; success: boolean }
    | { type: "permission"; kind: string; decision: "approve" | "reject"; detail?: string };

export interface PermissionAsk {
    kind: string;
    /** Short human-readable description (URL, command, file, tool). */
    detail?: string;
    /** read/write: the file the tool wants, as resolved by the runtime when it provides that. */
    path?: string;
    /** url: the address being fetched. */
    url?: string;
    /** mcp: the connector (server) and tool, and whether the server marks the tool read-only. */
    server?: string;
    tool?: string;
    readOnly?: boolean;
}

export type PermissionVerdict = { decision: "approve" } | { decision: "reject"; feedback: string };

/** A connector granted to the bot, with the requesting user's credential when it needs one. */
export interface GrantedConnector {
    spec: ConnectorSpec;
    credential?: string;
}

export interface Attachment {
    type: "blob";
    data: string;
    mimeType: string;
    displayName?: string;
}

export interface TurnRequest {
    /** Copilot session id. Created on first use, resumed afterwards. */
    sessionId: string;
    /** Resume an existing session rather than creating it. */
    resume: boolean;
    /** Delete the session once the turn finishes (one-shot calls). */
    ephemeral?: boolean;
    bot: BotSpec;
    user: User;
    skills: SkillSpec[];
    connectors: GrantedConnector[];
    /**
     * The user's shared workspace. Bots with `computer: true` work in it; connectors may reference it
     * as `${user.computerDir}` (e.g. a persistent browser profile).
     */
    computerDir?: string;
    /** Offer the shell on the computer (deployment setting `COMPUTER_ACCESS=shell`). */
    computerShell?: boolean;
    tools: PlatformTool[];
    prompt: string;
    attachments?: Attachment[];
    /** Per-turn context appended to the bot's instructions (memory, thread roster, notices). */
    systemExtra?: string;
    /** Provenance of the message; `agent-<botId>` when another bot is asking. */
    source?: `agent-${string}`;
    /** Decides each permission request; may wait for a human. */
    decidePermission: (ask: PermissionAsk) => Promise<PermissionVerdict>;
    onEvent?: (event: EngineEvent) => void;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface TurnResult {
    text: string;
    aborted?: boolean;
}

/** The model runtime. The Copilot SDK implements it in production; tests and demos use fakes. */
export interface AgentEngine {
    start(): Promise<void>;
    stop(): Promise<void>;
    turn(request: TurnRequest): Promise<TurnResult>;
    deleteSession(sessionId: string): Promise<void>;
}
