import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentEngine, PlatformTool, TurnRequest, TurnResult } from "./types.js";

/**
 * A scripted stand-in for the model, for demos and end-to-end UI tests without a Copilot seat.
 * It never claims to be a real model: every reply says it is demo output. It exercises the same
 * platform paths a real turn does: streaming, tool calls, approvals, memory, hand-offs, routines.
 *
 * Trigger words in the user's message: "delegate" (assign_task), "ask" (ask_bot), "remember",
 * "routine"/"every", "run"/"file" (shell approval on a computer bot), "@id" hand-offs in groups.
 */
export class DemoEngine implements AgentEngine {
    constructor(private readonly delayMs = 25) {}

    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    async deleteSession(): Promise<void> {}

    async turn(req: TurnRequest): Promise<TurnResult> {
        if (req.prompt.startsWith("Turn the procedure followed")) return this.stream(req, demoSkill(req.prompt));
        const latest = latestEntry(req.prompt);
        // Only a person's words trigger actions; text from bots or the platform is just acknowledged.
        const lastUser = latest.fromHuman ? latest.text.toLowerCase() : "";
        const notes: string[] = [];
        const tool = (name: string) => req.tools.find((t) => t.name === name);
        const call = async (t: PlatformTool, args: unknown) => {
            req.onEvent?.({ type: "tool.start", tool: t.name, args });
            await this.sleep(this.delayMs * 4);
            let out: string;
            try {
                out = await t.handler(t.parameters.parse(args));
            } catch (err) {
                out = `Error: ${(err as Error).message}`;
            }
            req.onEvent?.({ type: "tool.complete", tool: t.name, success: !/^(Refused|Error)/.test(out) });
            return out;
        };

        if (req.bot.reasoningEffort) {
            for (const w of "Working out what is being asked and which tools fit.".split(" ")) {
                req.onEvent?.({ type: "reasoning", text: w + " " });
                await this.sleep(this.delayMs);
            }
        }

        if (req.bot.builtinTools.includes("web_search") && /\?|search|find|research|latest/.test(lastUser)) {
            req.onEvent?.({ type: "tool.start", tool: "web_search", args: { query: lastUser.slice(0, 80) } });
            await this.sleep(this.delayMs * 6);
            req.onEvent?.({ type: "tool.complete", tool: "web_search", success: true });
            notes.push("I would search the web here; demo mode makes no network calls, so there are no real sources.");
        }

        const remember = tool("remember");
        if (remember && /remember/.test(lastUser)) {
            const fact = (lastUser.replace(/.*remember( that)?/, "").trim() || "the user asked me to remember this").slice(0, 400);
            notes.push(await call(remember, { text: fact, scope: "user" }));
        }

        const list = tool("list_bots");
        const assign = tool("assign_task");
        const ask = tool("ask_bot");
        if (list && (assign || ask) && /delegate|hand off|ask /.test(lastUser)) {
            const roster = await call(list, {});
            const target = /^- ([a-z][a-z0-9-]+):/m.exec(roster)?.[1];
            if (target && assign && /delegate|hand off/.test(lastUser)) {
                notes.push(await call(assign, { bot: target, title: titleFrom(latest.text), details: `From @${req.user.login}: ${latest.text}` }));
            } else if (target && ask) {
                const answer = await call(ask, { bot: target, message: lastUser });
                notes.push(`@${target} said:\n\n> ${answer.split("\n").join("\n> ")}`);
            } else {
                notes.push(roster);
            }
        }

        const routine = tool("save_routine");
        if (routine && /routine|every (day|morning|week|monday)/.test(lastUser)) {
            notes.push(await call(routine, { name: titleFrom(latest.text), prompt: latest.text, schedule: "0 9 * * 1-5" }));
        }

        if (req.bot.computer && req.computerShell && req.computerDir && /\brun\b|script/.test(lastUser)) {
            const verdict = await req.decidePermission({ kind: "shell", detail: "$ ls -la && echo hello > hello.txt" });
            if (verdict.decision === "approve") {
                req.onEvent?.({ type: "tool.start", tool: "bash", args: { command: "ls -la && echo hello > hello.txt" } });
                await writeFile(path.join(req.computerDir, "hello.txt"), `hello from ${req.bot.name}\n`);
                req.onEvent?.({ type: "tool.complete", tool: "bash", success: true });
                notes.push("Ran the command and wrote `hello.txt` to the shared computer.");
            } else {
                notes.push(`Skipped the shell command: ${verdict.feedback}`);
            }
        }

        let handoff = "";
        const group = /in "([^"]+)" since your last turn/.exec(req.prompt);
        const mention = /@([a-z][a-z0-9-]+) \(/g;
        if (group && /handoff|hand it|team/.test(lastUser)) {
            const others = [...(req.systemExtra ?? "").matchAll(mention)].map((m) => m[1]!).filter((id) => id !== req.bot.id);
            if (others[0] && !req.prompt.includes(`@${req.bot.id} (bot)`)) handoff = `\n\n@${others[0]}, can you take the next step?`;
        }

        const reply = [
            `**${req.bot.name}** here${req.bot.title ? `, ${req.bot.title}` : ""}. _(Demo mode: scripted reply, no model was called.)_`,
            "",
            latest.task
                ? `Done with “${latest.task}”. In a real run I'd do the work with my tools and report the result here.`
                : latest.fromHuman
                  ? `You said: “${latest.text.slice(0, 300)}”`
                  : `Picking this up from ${latest.author}. In a real run I'd continue the work here.`,
            ...(notes.length ? ["", ...notes.map((n) => `- ${n.replace(/\n/g, "\n  ")}`)] : []),
            req.attachments?.length ? `\nI received ${req.attachments.length} image(s).` : "",
        ]
            .join("\n")
            .trim() + handoff;

        return this.stream(req, reply);
    }

    private async stream(req: TurnRequest, reply: string): Promise<TurnResult> {
        // Plausible metering, so usage views have something to show in demos.
        req.onEvent?.({ type: "usage", model: req.bot.model ?? "demo", inputTokens: 600 + req.prompt.length, outputTokens: Math.ceil(reply.length / 4), premiumRequests: 1, durationMs: 400 });
        let out = "";
        for (const chunk of reply.match(/\S+\s*/g) ?? []) {
            if (req.signal?.aborted) return { text: out, aborted: true };
            out += chunk;
            req.onEvent?.({ type: "delta", text: chunk });
            await this.sleep(this.delayMs);
        }
        return { text: reply };
    }

    private sleep(ms: number): Promise<void> {
        return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
    }
}

interface Entry {
    author: string;
    text: string;
    fromHuman: boolean;
    task?: string;
}

/** The newest message in a platform prompt (a DM is the raw text; other threads are a transcript). */
function latestEntry(prompt: string): Entry {
    const body = prompt.split("\n\nAttached files")[0]!;
    const isTranscript = /^New messages in /.test(body);
    if (!isTranscript) return { author: "user", text: body.trim(), fromHuman: true };
    const marks = [...body.matchAll(/^(@[A-Za-z0-9-]+(?: \(bot\))?|\[platform\]): /gm)];
    const last = marks.at(-1);
    if (!last) return { author: "unknown", text: body.trim(), fromHuman: false };
    const text = body.slice(last.index! + last[0].length).split(/\n\nReply as @/)[0]!.trim();
    const who = last[1]!;
    const task = /^\*\*Task: (.+?)\*\*/.exec(text)?.[1];
    return { author: who.replace(/^@| \(bot\)$/g, ""), text, fromHuman: !who.endsWith("(bot)") && who !== "[platform]", task };
}

function demoSkill(prompt: string): string {
    const asks = [...prompt.matchAll(/^@[A-Za-z0-9-]+: (.+)$/gm)].map((m) => m[1]!.slice(0, 120));
    return [
        "---",
        "name: delegate-and-track",
        "description: Breaks a request into tasks, hands each to the best-suited bot, and reports results. Use for multi-step requests.",
        "---",
        "",
        "# Delegate and track",
        "",
        "_Drafted in demo mode from this thread; edit before publishing._",
        "",
        "1. Restate the goal in one sentence and confirm the expected output.",
        "2. Call `list_bots` and pick the teammate whose specialty fits each part.",
        "3. Use `assign_task` with a self-contained brief: goal, inputs, constraints, format.",
        "4. When results come back, check them against the goal and summarize for the user.",
        "",
        "## Approval points",
        "- Ask the user before anything that sends messages, publishes, or changes production systems.",
        "",
        "## Seen in this thread",
        ...asks.map((a) => `- ${a}`),
    ].join("\n");
}

function titleFrom(text: string): string {
    const t = text.replace(/^(please |can you |could you )/, "").split(/[.!?\n]/)[0]!.trim();
    return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 80) || "Task";
}
