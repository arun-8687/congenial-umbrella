import { afterEach, describe, expect, it } from "vitest";
import type { Runtime } from "../src/runtime/runtime.js";
import { alice, bob, bot, makeRuntime, texts, type Script } from "./helpers.js";

let rt: Runtime | undefined;
afterEach(async () => {
    await rt?.stop();
    rt = undefined;
});
async function setup(...args: Parameters<typeof makeRuntime>) {
    const ctx = await makeRuntime(...args);
    rt = ctx.runtime;
    return ctx;
}

const asksShell: Script = async (req) => ((await req.decidePermission({ kind: "shell", detail: "$ ls" })).decision === "approve" ? "ran" : "skipped");
const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error("condition not met");
        await new Promise((r) => setTimeout(r, 5));
    }
};

describe("approvals and capacity", () => {
    it("a turn waiting for approval does not hold a worker slot", async () => {
        const { runtime, repo } = await setup({ bots: [bot("ops", { computer: true }), bot("chat")] }, { ops: asksShell }, { concurrency: 1, computerAccess: "shell" });
        runtime.postUserMessage(alice, runtime.directThread(alice, "ops").id, "do it");
        await until(() => repo.approvals("alice", "pending").length === 1);
        const chat = runtime.directThread(alice, "chat");
        runtime.postUserMessage(alice, chat.id, "still there?");
        await until(() => texts(repo, chat.id).length === 2);
        expect(texts(repo, chat.id)[1]).toBe("bot:chat: chat saw: still there?");
    });

    it("stopping a thread releases a pending approval", async () => {
        const { runtime, repo } = await setup({ bots: [bot("ops", { computer: true })] }, { ops: asksShell }, { computerAccess: "shell" });
        const t = runtime.directThread(alice, "ops");
        runtime.postUserMessage(alice, t.id, "do it");
        await until(() => repo.approvals("alice", "pending").length === 1);
        expect(runtime.stopThread(alice, t.id)).toBe(true);
        await runtime.idle(2000);
        expect(repo.approvals("alice")[0]!.status).toBe("expired");
        expect(texts(repo, t.id).at(-1)).toMatch(/^bot:ops: /);
    });

    it("one user's backlog doesn't starve another user", async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const slow: Script = async () => {
            await gate;
            return "done";
        };
        const { runtime, repo } = await setup({ bots: [bot("a1"), bot("a2"), bot("a3"), bot("quick")] }, { a1: slow, a2: slow, a3: slow }, { concurrency: 3, maxPerUser: 2 });
        for (const id of ["a1", "a2", "a3"]) runtime.postUserMessage(alice, runtime.directThread(alice, id).id, "go");
        const b = runtime.directThread(bob, "quick");
        runtime.postUserMessage(bob, b.id, "hi");
        await until(() => texts(repo, b.id).length === 2);
        release();
        await runtime.idle();
    });

    it("caps how much work one user can queue", async () => {
        const { runtime } = await setup({ bots: [bot("b1"), bot("b2"), bot("b3")] }, {}, { maxQueuedPerUser: 2 });
        await runtime.stop(); // keep everything queued
        runtime.postUserMessage(alice, runtime.directThread(alice, "b1").id, "1");
        runtime.postUserMessage(alice, runtime.directThread(alice, "b2").id, "2");
        expect(() => runtime.postUserMessage(alice, runtime.directThread(alice, "b3").id, "3")).toThrow(/too much queued work/);
    });
});

describe("bookkeeping", () => {
    it("finishes every routine run even when wakes coalesce", async () => {
        const { runtime, repo } = await setup({ bots: [bot("cron")] }, { cron: async () => "report" });
        const r = runtime.createRoutine(alice, { botId: "cron", name: "R", prompt: "p", schedule: null, timezone: null });
        await runtime.stop();
        runtime.runRoutine("alice", r.id, "manual");
        runtime.runRoutine("alice", r.id, "manual"); // coalesces into the same queued wake
        runtime.start();
        await runtime.idle();
        expect(repo.runs(r.id).map((x) => x.status)).toEqual(["done", "done"]);
    });

    it("deleting a thread aborts the bot working in it", async () => {
        let aborted = false;
        const { runtime, repo } = await setup(
            { bots: [bot("slow")] },
            {
                slow: (req) =>
                    new Promise((resolve) => {
                        req.signal?.addEventListener("abort", () => {
                            aborted = true;
                            resolve("stopped");
                        });
                    }),
            },
        );
        const t = runtime.directThread(alice, "slow");
        runtime.postUserMessage(alice, t.id, "work");
        await until(() => runtime.status("alice").slow?.status === "working");
        await runtime.deleteThread(alice, t.id);
        await runtime.idle();
        expect(aborted).toBe(true);
        expect(repo.thread(t.id)).toBeUndefined();
    });

    it("reports a bot as working while any of its turns run", async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const { runtime } = await setup({ bots: [bot("multi")] }, { multi: async (req) => (req.prompt === "slow" ? (await gate, "ok") : "fast") });
        runtime.postUserMessage(alice, runtime.directThread(alice, "multi").id, "slow");
        const g = runtime.newThread(alice, ["multi"], "Second");
        await until(() => runtime.status("alice").multi?.status === "working");
        runtime.postUserMessage(alice, g.id, "quick");
        await until(() => runtime.repo.messages(g.id).length === 2);
        expect(runtime.status("alice").multi?.status).toBe("working");
        release();
        await runtime.idle();
        expect(runtime.status("alice").multi).toBeUndefined();
    });

    it("re-checks the user before background work and stops when GitHub rejects them", async () => {
        const { runtime, repo, engine } = await setup({ bots: [bot("cron")] }, {}, { verifyUser: async () => null });
        const r = runtime.createRoutine(alice, { botId: "cron", name: "Nightly", prompt: "p", schedule: null, timezone: null });
        runtime.runRoutine("alice", r.id, "schedule");
        await runtime.idle();
        expect(engine.turns).toHaveLength(0);
        expect(repo.runs(r.id)[0]).toMatchObject({ status: "failed" });
        expect(repo.notifications("alice")[0]!.title).toMatch(/no longer accepts @alice's sign-in/);
    });

    it("uses fresh org membership from verification", async () => {
        const { runtime, repo } = await setup(
            { bots: [bot("orgonly", { access: { users: [], orgs: ["acme"] } })] },
            {},
            { verifyUser: async (u) => ({ ...u, orgs: [] }) },
        );
        const t = runtime.directThread(alice, "orgonly");
        runtime.postUserMessage(alice, t.id, "hi");
        await runtime.idle();
        expect(texts(repo, t.id).at(-1)).toMatch(/@orgonly is no longer available/);
    });

    it("deleting a personal bot removes its routines", async () => {
        const { runtime, repo } = await setup({ bots: [] });
        const mine = runtime.directory.savePersonalBot(alice, { name: "Temp", description: "d", instructions: "i" }, { maxBotsAndGroups: 50 });
        runtime.createRoutine(alice, { botId: mine.id, name: "Daily", prompt: "p", schedule: "0 9 * * *", timezone: null });
        expect(runtime.deletePersonalBot(alice, mine.id)).toBe(true);
        expect(repo.routines("alice")).toEqual([]);
        expect(runtime.deletePersonalBot(bob, mine.id)).toBe(false);
    });

    it("only cancels tasks that are still active", async () => {
        const { runtime, repo } = await setup({ bots: [bot("worker")] });
        const task = runtime.assignTask(alice, { from: null, to: "worker", title: "T", details: "d", sourceThreadId: null, traceId: "t", chain: [] });
        await runtime.idle();
        expect(repo.task(task.id)!.status).toBe("done");
        expect(() => runtime.cancelTask(alice, task.id)).toThrow(/already done/);
    });
});

describe("web access", () => {
    it("refuses fetches to internal addresses before they reach the runtime", async () => {
        let verdict = "";
        const { runtime, sink } = await setup(
            { bots: [bot("web", { builtinTools: ["web_fetch"] })] },
            { web: async (req) => (verdict = JSON.stringify(await req.decidePermission({ kind: "url", url: "http://169.254.169.254/latest/meta-data" }))) },
        );
        runtime.postUserMessage(alice, runtime.directThread(alice, "web").id, "fetch it");
        await runtime.idle();
        expect(verdict).toMatch(/"decision":"reject".*private or internal/);
        expect(sink.events("permission.blocked")).toHaveLength(1);
    });
});
