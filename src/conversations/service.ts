import { randomUUID } from "node:crypto";
import type { Auditor } from "../audit.js";
import { BotBus, newTrace, type BusOptions, type Trace } from "../bus/bus.js";
import type { Catalog } from "../catalog/catalog.js";
import type { BotSpec } from "../catalog/schema.js";
import type { AgentEngine, EngineEvent } from "../engine/types.js";
import { canUseBot, type User } from "../identity.js";
import type { Conversation, ConversationStore } from "./store.js";

export class NotFoundError extends Error {}

/** Events streamed to a client while a turn runs. `botId` shows which bot in the chain produced it. */
export type TurnStreamEvent = EngineEvent & { botId: string; depth: number };

export interface PlatformOptions extends BusOptions {
    turnTimeoutMs?: number;
}

/**
 * The platform core: user-facing conversations with bots, backed by one Copilot session each,
 * with bot-to-bot delegation through the bus and everything recorded in the audit log.
 */
export class Platform {
    readonly bus: BotBus;
    private readonly locks = new Map<string, Promise<unknown>>();
    private readonly listeners = new Map<string, (e: TurnStreamEvent) => void>();

    constructor(
        private catalogRef: Catalog,
        private readonly engine: AgentEngine,
        private readonly store: ConversationStore,
        readonly audit: Auditor,
        private readonly options: PlatformOptions,
    ) {
        this.bus = new BotBus({
            catalog: () => this.catalogRef,
            engine,
            audit,
            options,
            onEvent: (botId, trace, event) => this.recordEvent(botId, trace, event),
        });
    }

    get catalog(): Catalog {
        return this.catalogRef;
    }

    setCatalog(catalog: Catalog): void {
        this.catalogRef = catalog;
        this.audit.log({
            type: "catalog.reloaded",
            bots: catalog.bots.size,
            connectors: catalog.connectors.size,
            skills: catalog.skills.size,
        });
    }

    /** Bots the user may talk to directly. */
    visibleBots(user: User): BotSpec[] {
        return [...this.catalogRef.bots.values()].filter((b) => !b.internal && canUseBot(user, b));
    }

    async createConversation(user: User, botId: string, title?: string): Promise<Conversation> {
        const bot = this.requireBot(user, botId);
        const now = new Date().toISOString();
        const conversation: Conversation = {
            id: randomUUID(),
            botId: bot.id,
            owner: user.login,
            title: title?.slice(0, 200) || `Chat with ${bot.name}`,
            createdAt: now,
            updatedAt: now,
            turns: 0,
            messages: [],
        };
        await this.store.put(conversation);
        this.audit.log({ type: "conversation.created", conversationId: conversation.id, botId: bot.id }, { actor: user.login });
        return conversation;
    }

    async getConversation(user: User, id: string): Promise<Conversation> {
        const c = await this.store.get(id);
        if (!c || c.owner !== user.login) throw new NotFoundError(`conversation ${id} not found`);
        return c;
    }

    listConversations(user: User): Promise<Conversation[]> {
        return this.store.listByOwner(user.login);
    }

    async deleteConversation(user: User, id: string): Promise<void> {
        const c = await this.getConversation(user, id);
        await this.withLock(id, async () => {
            if (c.turns > 0) await this.engine.deleteSession(c.id).catch(() => {});
            await this.store.delete(id);
        });
        this.audit.log({ type: "conversation.deleted", conversationId: id }, { actor: user.login });
    }

    /** Sends a user message and returns the bot's reply. Turns in one conversation run one at a time. */
    async send(
        user: User,
        conversationId: string,
        text: string,
        onEvent?: (e: TurnStreamEvent) => void,
    ): Promise<{ reply: string; traceId: string }> {
        const initial = await this.getConversation(user, conversationId);
        const bot = this.requireBot(user, initial.botId);

        return this.withLock(conversationId, async () => {
            const conversation = await this.getConversation(user, conversationId);
            const trace = newTrace(user, bot.id, this.options);
            const meta = { traceId: trace.traceId, actor: user.login };
            if (onEvent) this.listeners.set(trace.traceId, onEvent);

            this.audit.log({ type: "message.user", conversationId, botId: bot.id, text }, meta);
            try {
                const result = await this.engine.turn({
                    sessionId: conversation.id,
                    resume: conversation.turns > 0,
                    bot,
                    catalog: this.catalogRef,
                    user,
                    tools: this.bus.toolsFor(bot, trace),
                    prompt: text,
                    timeoutMs: this.options.turnTimeoutMs,
                    onEvent: (e) => this.recordEvent(bot.id, trace, e),
                });
                const now = new Date().toISOString();
                conversation.turns += 1;
                conversation.updatedAt = now;
                conversation.messages.push({ role: "user", text, at: now }, { role: "bot", text: result.text, at: now });
                await this.store.put(conversation);
                this.audit.log({ type: "message.bot", conversationId, botId: bot.id, text: result.text }, meta);
                return { reply: result.text, traceId: trace.traceId };
            } catch (err) {
                this.audit.log({ type: "error", where: `turn ${conversationId}`, message: (err as Error).message }, meta);
                throw err;
            } finally {
                this.listeners.delete(trace.traceId);
            }
        });
    }

    private recordEvent(botId: string, trace: Trace, event: EngineEvent): void {
        const meta = { traceId: trace.traceId, actor: trace.user.login };
        const sessionId = trace.chain.join(">");
        switch (event.type) {
            case "tool.start":
                this.audit.log({ type: "tool.start", botId, sessionId, tool: event.tool, args: event.args }, meta);
                break;
            case "tool.complete":
                this.audit.log({ type: "tool.complete", botId, sessionId, tool: event.tool, success: event.success }, meta);
                break;
            case "permission":
                this.audit.log(
                    { type: "permission", botId, sessionId, kind: event.kind, decision: event.decision, detail: event.detail },
                    meta,
                );
                break;
        }
        this.listeners.get(trace.traceId)?.({ ...event, botId, depth: trace.chain.length - 1 });
    }

    private requireBot(user: User, botId: string): BotSpec {
        const bot = this.catalogRef.bot(botId);
        // Same error for "missing" and "forbidden" so bot names don't leak to people who can't use them.
        if (!bot || bot.internal || !canUseBot(user, bot)) throw new NotFoundError(`bot ${botId} not found`);
        return bot;
    }

    private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.locks.get(key) ?? Promise.resolve();
        const run = prev.catch(() => {}).then(fn);
        this.locks.set(key, run);
        try {
            return await run;
        } finally {
            if (this.locks.get(key) === run) this.locks.delete(key);
        }
    }
}
