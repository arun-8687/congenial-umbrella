import type { z } from "zod";
import type { Catalog } from "../catalog/catalog.js";
import type { BotSpec, PermissionKind } from "../catalog/schema.js";
import type { User } from "../identity.js";

/** A host-side tool the platform injects into a bot's session (e.g. the bus tools). */
export interface PlatformTool<S extends z.ZodType = z.ZodType> {
    name: string;
    description: string;
    parameters: S;
    handler: (args: z.infer<S>) => Promise<string>;
}

export type EngineEvent =
    | { type: "delta"; text: string }
    | { type: "tool.start"; tool: string; args?: unknown }
    | { type: "tool.complete"; tool: string; success: boolean }
    | { type: "permission"; kind: PermissionKind | string; decision: "approve" | "reject"; detail?: string };

export interface TurnRequest {
    /** Copilot session id. Created on first use, resumed afterwards. */
    sessionId: string;
    /** Resume an existing session rather than creating it. */
    resume: boolean;
    /** Delete the session once the turn finishes (used for bot-to-bot calls). */
    ephemeral?: boolean;
    bot: BotSpec;
    catalog: Catalog;
    user: User;
    tools: PlatformTool[];
    prompt: string;
    /** Provenance of the message; `agent-<botId>` when another bot is asking. */
    source?: `agent-${string}`;
    onEvent?: (event: EngineEvent) => void;
    timeoutMs?: number;
}

export interface TurnResult {
    text: string;
}

/** The model runtime. The Copilot SDK implements it in production; tests use a fake. */
export interface AgentEngine {
    start(): Promise<void>;
    stop(): Promise<void>;
    turn(request: TurnRequest): Promise<TurnResult>;
    deleteSession(sessionId: string): Promise<void>;
}

/** Builds a tool with its handler typed from the zod schema. */
export function platformTool<S extends z.ZodType>(tool: PlatformTool<S>): PlatformTool {
    return tool as unknown as PlatformTool;
}
