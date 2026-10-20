import { Cron } from "croner";
import { z } from "zod";
import { platformTool, type PlatformTool } from "../engine/types.js";
import type { Runtime, TurnContext } from "./runtime.js";

/**
 * Host tools a bot gets for one turn. Every handler re-checks policy itself (reachability, hop
 * limit, cycles, budget), so a model can't talk its way past a limit, and refusals come back as
 * text the model can adapt to.
 */
export function botTools(rt: Runtime, ctx: TurnContext): PlatformTool[] {
    const { user, bot, thread, traceId, chain } = ctx;
    const audit = (event: Record<string, unknown> & { type: string }) => rt.audit.log(event, { actor: user.login, traceId });
    const tools: PlatformTool[] = [];

    const reachable = () =>
        rt.directory.bots(user, { includeInternal: true }).filter((e) => rt.directory.canReach(user, bot, e.bot.id));

    const refuseHop = (to: string): string | undefined => {
        const fullChain = [...chain, bot.id];
        let reason: string | undefined;
        if (!rt.directory.bot(user, to)) reason = `no bot named '${to}'`;
        else if (!rt.directory.canReach(user, bot, to)) reason = `'${bot.id}' is not allowed to message '${to}'`;
        else if (fullChain.includes(to)) reason = `'${to}' is already working on this request (cycle: ${[...fullChain, to].join(" -> ")})`;
        else if (chain.length >= rt.options.maxHops) reason = `hop limit of ${rt.options.maxHops} reached`;
        else if (!rt.spend(traceId)) reason = "bot-to-bot call budget for this request is spent";
        if (reason) audit({ type: "bus.refused", from: bot.id, to, chain: fullChain, reason });
        return reason && `Refused: ${reason}`;
    };

    if (bot.canMessage.length > 0) {
        tools.push(
            platformTool({
                name: "list_bots",
                description: "List the teammates (other bots) you can ask questions or hand tasks to, with what each one does.",
                parameters: z.object({}),
                handler: async () => {
                    const list = reachable();
                    if (!list.length) return "No other bots are available to you.";
                    return list.map(({ bot: b }) => `- ${b.id}: ${b.name}${b.title ? ` (${b.title})` : ""}. ${b.description}`).join("\n");
                },
            }),
            platformTool({
                name: "ask_bot",
                description:
                    "Ask another bot a quick question and wait for its answer (it cannot see this thread, so include the context it needs). " +
                    "For longer work, use assign_task instead.",
                parameters: z.object({
                    bot: z.string().describe("Id of the bot, from list_bots"),
                    message: z.string().min(1).describe("Self-contained question"),
                }),
                handler: async ({ bot: to, message }) => {
                    const refused = refuseHop(to);
                    if (refused) return refused;
                    const target = rt.directory.bot(user, to)!.bot;
                    const fullChain = [...chain, bot.id];
                    audit({ type: "bus.ask", from: bot.id, to, chain: [...fullChain, to], message });
                    try {
                        const reply = await rt.askOnce(user, target, thread, `Question from @${bot.id} (${bot.name}), working for @${user.login}:\n\n${message}`, {
                            traceId, chain: fullChain, source: `agent-${bot.id}`,
                        });
                        audit({ type: "bus.reply", from: to, to: bot.id, chain: [...fullChain, to], text: reply });
                        return reply || `'${to}' returned an empty reply.`;
                    } catch (err) {
                        return `Error: '${to}' failed to answer (${(err as Error).message}).`;
                    }
                },
            }),
            platformTool({
                name: "assign_task",
                description:
                    "Hand a piece of work to another bot. It runs in the background in its own task thread, and its result " +
                    "is posted back into this thread when done (you will be woken to continue). Returns immediately.",
                parameters: z.object({
                    bot: z.string().describe("Id of the bot, from list_bots"),
                    title: z.string().min(1).max(120).describe("Short task title"),
                    details: z.string().min(1).describe("Everything the bot needs: goal, inputs, constraints, expected output"),
                }),
                handler: async ({ bot: to, title, details }) => {
                    const refused = refuseHop(to);
                    if (refused) return refused;
                    const task = rt.assignTask(user, { from: bot, to, title, details, sourceThreadId: thread.id, traceId, chain });
                    return `Assigned task ${task.id.slice(0, 8)} "${title}" to @${to}. Its result will be posted in this thread when it is done; tell the user you've handed it off.`;
                },
            }),
        );
    }

    if (bot.memory) {
        tools.push(
            platformTool({
                name: "remember",
                description:
                    "Save a durable fact or preference for future conversations. scope 'user' = about the user, visible to all their bots; " +
                    "scope 'bot' = your own working notes. Don't store secrets.",
                parameters: z.object({
                    text: z.string().min(1).max(500),
                    scope: z.enum(["user", "bot"]).default("bot"),
                }),
                handler: async ({ text, scope }) => {
                    const m = rt.repo.addMemory(user.login, scope === "user" ? null : bot.id, text);
                    audit({ type: "memory.saved", botId: bot.id, memoryId: m.id, scope });
                    return `Saved memory ${m.id.slice(0, 8)}.`;
                },
            }),
            platformTool({
                name: "forget",
                description: "Delete a saved memory by the id shown in your memory list (first 8 characters are enough).",
                parameters: z.object({ id: z.string().min(4) }),
                handler: async ({ id }) => {
                    const m = rt.repo.memories(user.login, bot.id).find((x) => x.id.startsWith(id));
                    if (!m) return `No memory ${id}.`;
                    rt.repo.deleteMemory(user.login, m.id);
                    audit({ type: "memory.deleted", botId: bot.id, memoryId: m.id });
                    return `Forgot ${m.id.slice(0, 8)}.`;
                },
            }),
        );
    }

    tools.push(
        platformTool({
            name: "save_routine",
            description:
                "Save a repeatable routine for yourself: a prompt you will run on a schedule (cron, e.g. '0 9 * * 1-5' for 9:00 on weekdays) " +
                "or on demand. Use it when the user asks you to do something regularly or wants to reuse a workflow.",
            parameters: z.object({
                name: z.string().min(1).max(80),
                prompt: z.string().min(1).describe("Complete instructions for each run, written to your future self"),
                schedule: z.string().optional().describe("5-field cron expression; omit for on-demand"),
                timezone: z.string().optional().describe("IANA time zone, e.g. Europe/London"),
            }),
            handler: async ({ name, prompt, schedule, timezone }) => {
                try {
                    const r = rt.createRoutine(user, { botId: bot.id, name, prompt, schedule: schedule ?? null, timezone: timezone ?? null });
                    return `Saved routine "${r.name}"${r.schedule ? ` (${r.schedule}${r.timezone ? ` ${r.timezone}` : ""})` : " (on demand)"}. The user can edit it under Routines.`;
                } catch (err) {
                    return `Could not save the routine: ${(err as Error).message}`;
                }
            },
        }),
    );

    return tools;
}

/** Throws when `schedule` is not a valid cron expression. */
export function validateSchedule(schedule: string, timezone?: string | null): void {
    const c = new Cron(schedule, { paused: true, ...(timezone ? { timezone } : {}) });
    c.stop();
}

