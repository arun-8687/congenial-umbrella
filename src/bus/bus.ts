import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Auditor } from "../audit.js";
import type { Catalog } from "../catalog/catalog.js";
import type { BotSpec } from "../catalog/schema.js";
import { canUseBot, type User } from "../identity.js";
import { platformTool, type AgentEngine, type EngineEvent, type PlatformTool } from "../engine/types.js";

/** Context carried through one user request as it fans out across bots. */
export interface Trace {
    traceId: string;
    user: User;
    /** Bot ids from the bot the user addressed down to the current one. */
    chain: string[];
    /** Bot-to-bot calls left for the whole request, shared by every hop. */
    budget: { remaining: number };
}

export interface BusOptions {
    /** Maximum bot-to-bot hops below the bot the user addressed. */
    maxHops: number;
    /** Bot-to-bot calls allowed per user request. */
    maxCallsPerRequest: number;
    timeoutMs?: number;
}

export function newTrace(user: User, rootBotId: string, options: Pick<BusOptions, "maxCallsPerRequest">): Trace {
    return { traceId: randomUUID(), user, chain: [rootBotId], budget: { remaining: options.maxCallsPerRequest } };
}

/**
 * Bot-to-bot messaging. A bot reaches another bot only through the `ask_bot` tool. Each call runs
 * the target in a fresh, throwaway Copilot session as the same user, and the message carries
 * `source: "agent-<caller>"` so the target knows it came from a bot.
 */
export class BotBus {
    constructor(
        private readonly deps: {
            catalog: () => Catalog;
            engine: AgentEngine;
            audit: Auditor;
            options: BusOptions;
            onEvent?: (botId: string, trace: Trace, event: EngineEvent) => void;
        },
    ) {}

    /** Tools injected into `bot`'s session for this trace. Empty when the bot may not message anyone. */
    toolsFor(bot: BotSpec, trace: Trace): PlatformTool[] {
        if (bot.canMessage.length === 0) return [];
        const listBots = platformTool({
            name: "list_bots",
            description: "List the bots you can ask for help with ask_bot, with what each one does.",
            parameters: z.object({}),
            handler: async () => {
                const catalog = this.deps.catalog();
                const reachable = bot.canMessage
                    .map((id) => catalog.bot(id))
                    .filter((b): b is BotSpec => b !== undefined && canUseBot(trace.user, b));
                if (reachable.length === 0) return "No bots are available to you.";
                return reachable.map((b) => `- ${b.id}: ${b.name}. ${b.description}`).join("\n");
            },
        });
        const askBot = platformTool({
            name: "ask_bot",
            description:
                "Send a message to another bot and wait for its reply. Use it to delegate a sub-task to a bot whose " +
                "specialty fits. The other bot cannot see this conversation, so include all the context it needs.",
            parameters: z.object({
                bot: z.string().describe("Id of the bot to ask, from list_bots"),
                message: z.string().min(1).describe("Self-contained request for that bot"),
            }),
            handler: async ({ bot: to, message }) => this.ask(bot, to, message, trace),
        });
        return [listBots, askBot];
    }

    /** Runs one hop. Refusals come back as text so the calling model can adapt instead of crashing. */
    async ask(from: BotSpec, toId: string, message: string, trace: Trace): Promise<string> {
        const { audit, options } = this.deps;
        const meta = { traceId: trace.traceId, actor: trace.user.login };
        const refuse = (reason: string) => {
            audit.log({ type: "bus.refused", from: from.id, to: toId, chain: trace.chain, reason }, meta);
            return `Refused: ${reason}`;
        };

        const target = this.deps.catalog().bot(toId);
        if (!target) return refuse(`no bot named '${toId}'`);
        if (!from.canMessage.includes(toId)) return refuse(`'${from.id}' is not allowed to message '${toId}'`);
        if (!canUseBot(trace.user, target)) return refuse(`@${trace.user.login} does not have access to '${toId}'`);
        if (trace.chain.includes(toId)) return refuse(`'${toId}' is already working on this request (cycle: ${[...trace.chain, toId].join(" -> ")})`);
        if (trace.chain.length > options.maxHops) return refuse(`hop limit of ${options.maxHops} reached`);
        if (trace.budget.remaining <= 0) return refuse("bot-to-bot call budget for this request is spent");
        trace.budget.remaining -= 1;

        const child: Trace = { ...trace, chain: [...trace.chain, toId] };
        audit.log({ type: "bus.ask", from: from.id, to: toId, chain: child.chain, message }, meta);
        try {
            const result = await this.deps.engine.turn({
                sessionId: `bus-${randomUUID()}`,
                resume: false,
                ephemeral: true,
                bot: target,
                catalog: this.deps.catalog(),
                user: trace.user,
                tools: this.toolsFor(target, child),
                prompt: `Request from bot '${from.name}' (${from.id}), acting for @${trace.user.login}:\n\n${message}`,
                source: `agent-${from.id}`,
                timeoutMs: options.timeoutMs,
                onEvent: this.deps.onEvent ? (e) => this.deps.onEvent!(target.id, child, e) : undefined,
            });
            audit.log({ type: "bus.reply", from: toId, to: from.id, chain: child.chain, text: result.text }, meta);
            return result.text || `'${toId}' returned an empty reply.`;
        } catch (err) {
            const msg = (err as Error).message;
            audit.log({ type: "error", where: `bus ${from.id} -> ${toId}`, message: msg }, meta);
            return `Error: '${toId}' failed to answer (${msg}).`;
        }
    }
}
