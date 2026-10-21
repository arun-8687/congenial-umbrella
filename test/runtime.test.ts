import { afterEach, describe, expect, it } from "vitest";
import { NotFoundError, type Runtime } from "../src/runtime/runtime.js";
import { alice, bob, bot, makeRuntime, texts, type Script } from "./helpers.js";

let current: Runtime | undefined;
afterEach(async () => {
    await current?.stop();
    current = undefined;
});
async function setup(...args: Parameters<typeof makeRuntime>) {
    const ctx = await makeRuntime(...args);
    current = ctx.runtime;
    return ctx;
}

describe("direct messages", () => {
    it("wakes the bot, streams, stores the reply, and resumes the session on later turns", async () => {
        const { runtime, repo, engine, events } = await setup({ bots: [bot("helper")] });
        const t = runtime.directThread(alice, "helper");
        expect(runtime.directThread(alice, "helper").id).toBe(t.id);

        runtime.postUserMessage(alice, t.id, "hello");
        await runtime.idle();
        runtime.postUserMessage(alice, t.id, "again");
        await runtime.idle();

        expect(texts(repo, t.id)).toEqual(["user:alice: hello", "bot:helper: helper saw: hello", "user:alice: again", "bot:helper: helper saw: again"]);
        expect(engine.turns.map((x) => [x.sessionId, x.resume])).toEqual([
            [engine.turns[0]!.sessionId, false],
            [engine.turns[0]!.sessionId, true],
        ]);
        expect(engine.turns[0]!.systemExtra).toContain("You are working for @alice.");
        expect(events.some((e) => e.type === "message.delta")).toBe(true);
        expect(events.filter((e) => e.type === "bot.status").map((e) => (e as { status: string }).status)).toEqual(["working", "idle", "working", "idle"]);
    });

    it("isolates users from each other's threads and private bots", async () => {
        const { runtime } = await setup({ bots: [bot("helper"), bot("acme-only", { access: { users: [], orgs: ["acme"] } })] });
        const t = runtime.directThread(alice, "helper");
        expect(() => runtime.postUserMessage(bob, t.id, "hi")).toThrow(NotFoundError);
        expect(() => runtime.directThread(bob, "acme-only")).toThrow(NotFoundError);
        expect(runtime.directory.bots(bob).map((e) => e.bot.id)).toEqual(["helper"]);

        const mine = runtime.directory.savePersonalBot(alice, { name: "Nova", description: "d", instructions: "i" }, { maxBotsAndGroups: 50 });
        expect(runtime.directory.bots(alice).map((e) => e.bot.id)).toContain(mine.id);
        expect(runtime.directory.bots(bob).map((e) => e.bot.id)).not.toContain(mine.id);
        expect(() => runtime.directory.savePersonalBot(bob, { id: mine.id, name: "x", description: "d", instructions: "i" }, { maxBotsAndGroups: 50 })).toThrow(/not found/);
    });

    it("serializes turns per bot per thread and coalesces queued wakes", async () => {
        let active = 0;
        let max = 0;
        const { runtime, repo, engine } = await setup(
            { bots: [bot("slow")] },
            {
                slow: async (req) => {
                    max = Math.max(max, ++active);
                    await new Promise((r) => setTimeout(r, 20));
                    active--;
                    return `read ${req.prompt.split("\n\n").length} block(s)`;
                },
            },
        );
        const t = runtime.directThread(alice, "slow");
        runtime.postUserMessage(alice, t.id, "a");
        while (active === 0) await new Promise((r) => setTimeout(r, 1));
        runtime.postUserMessage(alice, t.id, "b");
        runtime.postUserMessage(alice, t.id, "c");
        await runtime.idle();
        expect(max).toBe(1);
        // The first turn read "a"; "b" and "c" arrived while it ran and were read together by one more turn.
        expect(engine.turns).toHaveLength(2);
        expect(engine.turns[1]!.prompt).toMatch(/@alice: b\n\n@alice: c/);
        expect(texts(repo, t.id).filter((x) => x.startsWith("bot"))).toHaveLength(2);
    });
});

describe("group chats", () => {
    const relay =
        (to: string): Script =>
        async () =>
            `@${to} over to you`;

    it("wakes mentioned members, or the lead when nobody is mentioned", async () => {
        const ok: Script = async () => "ok";
        const { runtime, engine } = await setup({ bots: [bot("lead"), bot("second"), bot("third")] }, { lead: ok, second: ok, third: ok });
        const g = runtime.newThread(alice, ["lead", "second", "third"], "Squad");
        expect(g.kind).toBe("group");
        runtime.postUserMessage(alice, g.id, "hi all");
        await runtime.idle();
        runtime.postUserMessage(alice, g.id, "@third and @Second, please");
        await runtime.idle();
        expect(engine.turns.map((t) => t.bot.id)).toEqual(["lead", "second", "third"]);
        expect(engine.turns[1]!.prompt).toContain('New messages in "Squad" since your last turn');
        expect(engine.turns[1]!.systemExtra).toContain("group chat");
    });

    it("hands off by @mention but never bounces back to a bot already in the chain", async () => {
        const { runtime, engine } = await setup({ bots: [bot("ping"), bot("pong"), bot("pang")] }, { ping: relay("pong"), pong: relay("ping") });
        const g = runtime.newThread(alice, ["ping", "pong", "pang"]);
        runtime.postUserMessage(alice, g.id, "@ping start");
        await runtime.idle();
        expect(engine.turns.map((t) => t.bot.id)).toEqual(["ping", "pong"]);
    });

    it("stops hand-off chains at the hop limit", async () => {
        const ids = ["one", "two", "three", "four"];
        const scripts = Object.fromEntries(ids.slice(0, -1).map((id, i) => [id, relay(ids[i + 1]!)]));
        const { runtime, repo, engine } = await setup({ bots: ids.map((id) => bot(id)) }, scripts, { maxHops: 2 });
        const g = runtime.newThread(alice, ids);
        runtime.postUserMessage(alice, g.id, "@one go");
        await runtime.idle();
        expect(engine.turns.map((t) => t.bot.id)).toEqual(["one", "two", "three"]);
        expect(texts(repo, g.id).at(-1)).toContain("hop limit of 2 reached");
    });

    it("enforces group size and the per-user bot/group limit", async () => {
        const ids = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
        const { runtime } = await setup({ bots: ids.map((id) => bot(id)) }, {}, { maxBotsAndGroups: 1 });
        expect(() => runtime.newThread(alice, ids)).toThrow(/at most 6/);
        runtime.newThread(alice, ["a1", "a2"]);
        expect(() => runtime.newThread(alice, ["a1", "a3"])).toThrow(/limit of 1/);
    });
});

describe("tasks and ask_bot", () => {
    it("assign_task runs in the background and reports back to the requesting bot", async () => {
        const { runtime, repo, engine, sink } = await setup(
            { bots: [bot("boss", { canMessage: ["worker"] }), bot("worker")] },
            {
                boss: async (req, tool) => {
                    if (req.prompt.includes("Finished task")) return "Thanks, wrapping up.";
                    return tool("assign_task", { bot: "worker", title: "Crunch numbers", details: "Sum 1..10" });
                },
                worker: async () => "55",
            },
        );
        const t = runtime.directThread(alice, "boss");
        runtime.postUserMessage(alice, t.id, "get it done");
        await runtime.idle();

        const [task] = repo.tasks("alice");
        expect(task).toMatchObject({ title: "Crunch numbers", assignee: "worker", createdBy: "boss", status: "done", result: "55", sourceThreadId: t.id });
        expect(texts(repo, task!.threadId)).toEqual([expect.stringMatching(/^bot:boss: \*\*Task: Crunch numbers\*\*/), "bot:worker: 55"]);
        expect(texts(repo, t.id)).toEqual([
            "user:alice: get it done",
            expect.stringMatching(/^bot:boss: Assigned task .* "Crunch numbers" to @worker/),
            "bot:worker: **Finished task: Crunch numbers**\n\n55",
            "bot:boss: Thanks, wrapping up.",
        ]);
        expect(engine.turns.find((x) => x.bot.id === "worker")!.prompt).toContain('New messages in your task thread "Crunch numbers"');
        expect(sink.events("task.assigned")).toHaveLength(1);
        expect(repo.notifications("alice").some((n) => n.title.startsWith("Worker finished"))).toBe(true);
    });

    it("ask_bot answers synchronously in a throwaway session with agent provenance", async () => {
        let answer = "";
        const { runtime, engine } = await setup(
            { bots: [bot("front", { canMessage: ["*"] }), bot("expert")] },
            { front: async (_r, tool) => (answer = await tool("ask_bot", { bot: "expert", message: "2+2?" })), expert: async () => "4" },
        );
        runtime.postUserMessage(alice, runtime.directThread(alice, "front").id, "q");
        await runtime.idle();
        expect(answer).toBe("4");
        const hop = engine.turns[1]!;
        expect(hop).toMatchObject({ ephemeral: true, resume: false, source: "agent-front" });
        expect(engine.deleted).toContain(hop.sessionId);
    });

    it("refuses unreachable bots, cycles and spent budgets, as text the model can read", async () => {
        const answers: string[] = [];
        const { runtime, sink } = await setup(
            { bots: [bot("front", { canMessage: ["helper"] }), bot("helper", { canMessage: ["front"] }), bot("stranger")] },
            {
                front: async (_r, tool) => {
                    answers.push(await tool("ask_bot", { bot: "stranger", message: "x" }));
                    answers.push(await tool("ask_bot", { bot: "nobody", message: "x" }));
                    answers.push(await tool("ask_bot", { bot: "helper", message: "x" }));
                    answers.push(await tool("ask_bot", { bot: "helper", message: "x" }));
                    return "done";
                },
                helper: async (_r, tool) => tool("ask_bot", { bot: "front", message: "back at you" }),
            },
            { maxBotCalls: 1 },
        );
        runtime.postUserMessage(alice, runtime.directThread(alice, "front").id, "go");
        await runtime.idle();
        expect(answers).toEqual([
            "Refused: 'front' is not allowed to message 'stranger'",
            "Refused: no bot named 'nobody'",
            "Refused: 'front' is already working on this request (cycle: front -> helper -> front)",
            "Refused: bot-to-bot call budget for this request is spent",
        ]);
        expect(sink.events("bus.refused")).toHaveLength(4);
    });
});

describe("approvals", () => {
    const writer: Script = async (req) => {
        const v = await req.decidePermission({ kind: "write", path: `${req.computerDir}/report.md` });
        return v.decision === "approve" ? "wrote it" : `skipped: ${v.feedback}`;
    };
    const shelly: Script = async (req) => {
        const v = await req.decidePermission({ kind: "shell", detail: "$ rm -rf build" });
        return v.decision === "approve" ? "ran it" : `skipped: ${v.feedback}`;
    };

    it("pauses the bot until the user approves", async () => {
        const { runtime, repo, events } = await setup({ bots: [bot("ops", { computer: true })] }, { ops: shelly }, { computerAccess: "shell" });
        const t = runtime.directThread(alice, "ops");
        runtime.postUserMessage(alice, t.id, "clean up");
        await waitFor(() => repo.approvals("alice", "pending").length === 1);
        const [a] = repo.approvals("alice", "pending");
        expect(a).toMatchObject({ botId: "ops", kind: "shell", detail: "$ rm -rf build", threadId: t.id });
        expect(events.some((e) => e.type === "bot.status" && e.status === "waiting")).toBe(true);
        expect(repo.notifications("alice")[0]!.kind).toBe("approval");

        runtime.decideApproval(alice, a!.id, true);
        await runtime.idle();
        expect(texts(repo, t.id).at(-1)).toBe("bot:ops: ran it");
        expect(() => runtime.decideApproval(alice, a!.id, true)).toThrow(/no longer pending/);
    });

    it("reports denials and expiries back to the bot", async () => {
        const { runtime, repo } = await setup({ bots: [bot("ops", { computer: true })] }, { ops: shelly }, { approvalTimeoutMs: 50, computerAccess: "shell" });
        const t = runtime.directThread(alice, "ops");
        runtime.postUserMessage(alice, t.id, "first");
        await waitFor(() => repo.approvals("alice", "pending").length === 1);
        runtime.decideApproval(alice, repo.approvals("alice", "pending")[0]!.id, false);
        await runtime.idle();
        expect(texts(repo, t.id).at(-1)).toMatch(/skipped: @alice did not approve this shell request/);

        runtime.postUserMessage(alice, t.id, "second");
        await runtime.idle();
        expect(repo.approvals("alice").map((a) => a.status)).toEqual(expect.arrayContaining(["denied", "expired"]));
    });

    it("never asks for denied kinds, and only lets users always-allow their own bots", async () => {
        const { runtime, repo } = await setup({ bots: [bot("plain"), bot("orgops", { computer: true })] }, { plain: shelly, orgops: writer }, { computerAccess: "shell" });
        runtime.postUserMessage(alice, runtime.directThread(alice, "plain").id, "x");
        await runtime.idle();
        expect(repo.approvals("alice")).toEqual([]);

        runtime.postUserMessage(alice, runtime.directThread(alice, "orgops").id, "x");
        await waitFor(() => repo.approvals("alice", "pending").length === 1);
        const pending = repo.approvals("alice", "pending")[0]!;
        expect(() => runtime.decideApproval(alice, pending.id, true, true)).toThrow(/only your own bots/);
        // The refused upgrade recorded nothing; the request can still be decided normally.
        expect(repo.approval(pending.id)!.status).toBe("pending");
        runtime.decideApproval(alice, pending.id, true);
        await runtime.idle();
    });

    it("never lets shell commands be always-allowed", async () => {
        const { runtime, repo, engine } = await setup({ bots: [] }, {}, { computerAccess: "shell" });
        const mine = runtime.directory.savePersonalBot(alice, { name: "Box", description: "d", instructions: "i", computer: true }, { maxBotsAndGroups: 50, computerAccess: "shell" });
        (engine as unknown as { scripts: Record<string, Script> }).scripts[mine.id] = shelly;
        runtime.postUserMessage(alice, runtime.directThread(alice, mine.id).id, "x");
        await waitFor(() => repo.approvals("alice", "pending").length === 1);
        const pending = repo.approvals("alice", "pending")[0]!;
        expect(() => runtime.decideApproval(alice, pending.id, true, true)).toThrow(/can't be always-allowed/);
        expect(repo.approval(pending.id)!.status).toBe("pending");
        runtime.decideApproval(alice, pending.id, false);
        await runtime.idle();
    });

    it("always-allow updates a personal bot's policy", async () => {
        const { runtime, repo, engine } = await setup({ bots: [] }, {}, { computerAccess: "shell" });
        const mine = runtime.directory.savePersonalBot(alice, { name: "Box", description: "d", instructions: "i", computer: true }, { maxBotsAndGroups: 50, computerAccess: "shell" });
        (engine as unknown as { scripts: Record<string, Script> }).scripts[mine.id] = writer;
        const t = runtime.directThread(alice, mine.id);
        runtime.postUserMessage(alice, t.id, "x");
        await waitFor(() => repo.approvals("alice", "pending").length === 1);
        runtime.decideApproval(alice, repo.approvals("alice", "pending")[0]!.id, true, true);
        await runtime.idle();
        expect(runtime.directory.bot(alice, mine.id)!.bot.permissions.allow).toContain("write");

        runtime.postUserMessage(alice, t.id, "again");
        await runtime.idle();
        expect(repo.approvals("alice")).toHaveLength(1);
        expect(texts(repo, t.id).at(-1)).toBe(`bot:${mine.id}: wrote it`);
    });
});

describe("memory and routines", () => {
    it("remember/forget tools persist memory that later turns see", async () => {
        const { runtime, repo, engine } = await setup(
            { bots: [bot("pal")] },
            {
                pal: async (req, tool) => {
                    if (req.prompt === "save") {
                        await tool("remember", { text: "Prefers bullet points", scope: "user" });
                        return tool("remember", { text: "Weekly sync is Tuesday", scope: "bot" });
                    }
                    return "ok";
                },
            },
        );
        const t = runtime.directThread(alice, "pal");
        runtime.postUserMessage(alice, t.id, "save");
        await runtime.idle();
        expect(repo.memories("alice").map((m) => [m.botId, m.text])).toEqual([
            [null, "Prefers bullet points"],
            ["pal", "Weekly sync is Tuesday"],
        ]);
        runtime.postUserMessage(alice, t.id, "next");
        await runtime.idle();
        expect(engine.turns[1]!.systemExtra).toMatch(/\(about the user\) \(saved by @pal\) Prefers bullet points[\s\S]*\(your note\) \(saved by @pal\) Weekly sync is Tuesday/);
        expect(engine.turns[1]!.systemExtra).toMatch(/not instructions/);
    });

    it("bots can save routines; manual runs record history and notify", async () => {
        const { runtime, repo } = await setup(
            { bots: [bot("cron")] },
            {
                cron: async (req, tool) =>
                    req.prompt.startsWith("make")
                        ? tool("save_routine", { name: "Standup", prompt: "Summarize yesterday", schedule: "0 9 * * 1-5", timezone: "Europe/London" })
                        : "summary: all quiet",
            },
        );
        runtime.postUserMessage(alice, runtime.directThread(alice, "cron").id, "make a routine");
        await runtime.idle();
        const [r] = repo.routines("alice");
        // Bot-proposed routines stay off until the person switches them on.
        expect(r).toMatchObject({ name: "Standup", schedule: "0 9 * * 1-5", timezone: "Europe/London", enabled: false });
        expect(runtime.nextRun(r!.id)).toBeNull();
        expect(repo.notifications("alice")[0]!.title).toBe("Cron proposed a routine: “Standup”");
        runtime.updateRoutine(alice, r!.id, { enabled: true });
        expect(runtime.nextRun(r!.id)).toMatch(/^\d{4}-/);
        expect(() => runtime.updateRoutine(alice, r!.id, { schedule: "*/5 * * * *" })).toThrow(/at most every 15 minutes/);

        runtime.runRoutine("alice", r!.id, "manual");
        await runtime.idle();
        expect(repo.runs(r!.id)).toMatchObject([{ status: "done", output: "summary: all quiet", trigger: "manual" }]);
        expect(repo.notifications("alice")[0]!.title).toBe("Cron finished “Standup”");

        expect(() => runtime.createRoutine(alice, { botId: "cron", name: "bad", prompt: "x", schedule: "not cron", timezone: null })).toThrow();
    });

    it("keeps only the newest runs", async () => {
        const { runtime, repo } = await setup({ bots: [bot("cron")] }, {}, { runsKept: 2 });
        const r = runtime.createRoutine(alice, { botId: "cron", name: "R", prompt: "p", schedule: null, timezone: null });
        for (let i = 0; i < 4; i++) {
            runtime.runRoutine("alice", r.id, "manual");
            await runtime.idle();
        }
        expect(repo.runs(r.id)).toHaveLength(2);
    });
});

describe("recovery", () => {
    it("re-queues jobs that were running when the process died", async () => {
        const { runtime, repo, engine } = await setup({ bots: [bot("helper")] });
        await runtime.stop();
        const t = runtime.directThread(alice, "helper");
        repo.addMessage(t.id, "user", "alice", "before the crash");
        const job = repo.enqueue("alice", "wake", { threadId: t.id, botId: "helper", traceId: "x", chain: [] });
        repo.setJobStatus(job.id, "running");
        runtime.start();
        await runtime.idle();
        expect(engine.turns).toHaveLength(1);
        expect(texts(repo, t.id).at(-1)).toBe("bot:helper: helper saw: before the crash");
    });
});

async function waitFor(cond: () => boolean, timeoutMs = 3000) {
    const end = Date.now() + timeoutMs;
    while (!cond()) {
        if (Date.now() > end) throw new Error("condition not met");
        await new Promise((r) => setTimeout(r, 5));
    }
}
