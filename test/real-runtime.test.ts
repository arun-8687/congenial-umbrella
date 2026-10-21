/**
 * End-to-end tests against the real GitHub Copilot runtime (the SDK's bundled binary). The model is a
 * scripted OpenAI-compatible server behind a BYOK provider; everything else is real: session config,
 * tool exposure, the runtime's own permission requests, built-in tools touching the filesystem,
 * shell and network, MCP servers, skills, streaming, and the platform runtime around them.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Approval } from "../src/runtime/repo.js";
import { alice, bot, skillMd, texts } from "./helpers.js";
import { realRuntime } from "./support/real-runtime.js";

const T = 60_000;
type Real = Awaited<ReturnType<typeof realRuntime>>;
let rt: Real | undefined;
afterEach(async () => {
    await rt?.close();
    rt = undefined;
    delete process.env.SECRET_KEY;
    delete process.env.TICKETS_TEST_TOKEN;
});

/** Decides approvals as they appear, recording what was asked. */
function approver(r: Real, decide: (a: Approval) => boolean) {
    const seen: Approval[] = [];
    const timer = setInterval(() => {
        for (const a of r.repo.approvals("alice", "pending")) {
            seen.push(a);
            r.runtime.decideApproval(alice, a.id, decide(a));
        }
    }, 20);
    return { seen, stop: () => clearInterval(timer) };
}

/** Runs a fixed list of tool calls, then reports every tool result as the final message. */
function sequence(steps: { name: string; args: unknown }[]) {
    let i = 0;
    return (_req: unknown, h: { toolResults: { name: string; content: string }[] }) =>
        i < steps.length ? { toolCalls: [steps[i++]!] } : { text: h.toolResults.map((r) => `[${r.name}] ${r.content}`).join("\n") };
}

async function dm(r: Real, botId: string, text: string, timeout = 45_000) {
    const t = r.runtime.directThread(alice, botId);
    r.runtime.postUserMessage(alice, t.id, text);
    await r.runtime.idle(timeout);
    return { thread: t, last: r.repo.messages(t.id).at(-1)! };
}

describe("real Copilot runtime", () => {
    it(
        "runs a chat turn with our persona, only the tools we grant, and streaming",
        async () => {
            rt = await realRuntime({ bots: [bot("helper", { title: "Helpdesk", instructions: "Answer IT questions for Acme." })] });
            rt.repo.addMemory("alice", null, "Prefers short answers");
            rt.model.script = () => ({ text: "Hello there, happy to help." });
            const { last } = await dm(rt, "helper", "hi");

            expect(last).toMatchObject({ authorType: "bot", authorId: "helper", text: "Hello there, happy to help." });
            expect(rt.events.some((e) => e.type === "message.delta")).toBe(true);

            const req = rt.model.requests[0]!;
            const tools = (req.tools ?? []).map((t) => t.function?.name ?? t.type).sort();
            expect(tools).toEqual(["forget", "remember", "save_routine"]); // no shell, files, web or agents
            const system = req.messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
            expect(system).toContain("You are Helper, the Helpdesk, an AI teammate");
            expect(system).toContain("Answer IT questions for Acme.");
            expect(system).toContain("Prefers short answers");
            expect(system).toContain("<prohibited_actions>"); // the runtime's safety section stays
            for (const coding of ["command-line interface", "interactive tool that helps users with software engineering", "gh_cli_preference", "Bias to action", "<editing_constraints>"]) {
                expect(system).not.toContain(coding);
            }
        },
        T,
    );

    it(
        "runs platform tools: ask_bot nests a real turn for another bot as the same user",
        async () => {
            rt = await realRuntime({ bots: [bot("front", { canMessage: ["expert"] }), bot("expert")] });
            rt.model.script = (_req, h) => {
                if (h.lastUser.includes("Question from @front")) return { text: "The answer is 42." };
                if (!h.toolResults.length) return { toolCalls: [{ name: "ask_bot", args: { bot: "expert", message: "What is the answer?" } }] };
                return { text: `Expert says: ${h.toolResults[0]!.content}` };
            };
            const { last } = await dm(rt, "front", "ask the expert");
            expect(last.text).toBe("Expert says: The answer is 42.");
            expect(last.meta.tools).toEqual([{ tool: "ask_bot", detail: "expert", success: true }]);
            expect(rt.sink.events("bus.ask")).toMatchObject([{ from: "front", to: "expert", chain: ["front", "expert"] }]);
        },
        T,
    );

    it(
        "confines file tools to the user's workspace and asks before writing",
        async () => {
            rt = await realRuntime({ bots: [bot("ops", { computer: true, model: "gpt-5" })] }, { computerAccess: "files" });
            const ws = rt.runtime.computerDir("alice");
            writeFileSync(path.join(ws, "notes.txt"), "workspace note");
            const secret = path.join(rt.state, "secret.txt");
            writeFileSync(secret, "TOP SECRET");
            rt.model.script = sequence([
                { name: "view", args: { path: secret } },
                { name: "view", args: { path: path.join(ws, "notes.txt") } },
                { name: "create", args: { path: path.join(ws, "report.md"), file_text: "# Report" } },
                { name: "create", args: { path: path.join(rt.state, "planted.txt"), file_text: "x" } },
            ]);
            const approvals = approver(rt, () => true);
            const { last } = await dm(rt, "ops", "do the file work");
            approvals.stop();

            expect(last.text).not.toContain("TOP SECRET");
            expect(last.text).toContain("workspace note");
            expect(readFileSync(path.join(ws, "report.md"), "utf8")).toBe("# Report");
            expect(existsSync(path.join(rt.state, "planted.txt"))).toBe(false);
            // Only the in-workspace write needed a person; the outside write never reached one.
            expect(approvals.seen.map((a) => a.kind)).toEqual(["write"]);
            const decisions = rt.sink.events("permission").map((e) => `${e.kind}:${e.decision}`);
            expect(decisions).toEqual(["read:reject", "read:approve", "write:approve", "write:reject"]);
            // Files mode never offers the shell.
            const tools = (rt.model.requests[0]!.tools ?? []).map((t) => t.function?.name);
            expect(tools).toContain("view");
            expect(tools.some((t) => t?.includes("bash"))).toBe(false);
        },
        T,
    );

    it(
        "keeps platform secrets out of shell commands, and every command needs approval",
        async () => {
            process.env.SECRET_KEY = "CANARY-PLATFORM-SECRET";
            rt = await realRuntime({ bots: [bot("ops", { computer: true })] }, { computerAccess: "shell" });
            rt.model.script = sequence([
                { name: "bash", args: { command: "env", description: "list environment" } },
                { name: "bash", args: { command: "echo second", description: "second command" } },
            ]);
            let n = 0;
            const approvals = approver(rt, () => n++ === 0); // approve the first command, deny the second
            const { last } = await dm(rt, "ops", "inspect");
            approvals.stop();

            expect(approvals.seen.map((a) => a.detail)).toEqual(["$ env", "$ echo second"]);
            expect(last.text).toMatch(/\[bash\] .*PATH=/s);
            expect(last.text).not.toContain("CANARY-PLATFORM-SECRET");
            expect(last.text).toContain("did not approve this shell request");
        },
        T,
    );

    it(
        "blocks web_fetch to internal addresses in two independent layers",
        async () => {
            const internal = createServer((_q, res) => res.end("INTERNAL ADMIN PAGE")).listen(0, "127.0.0.1");
            await new Promise((r) => internal.once("listening", r));
            const url = `http://127.0.0.1:${(internal.address() as AddressInfo).port}/`;
            try {
                rt = await realRuntime({ bots: [bot("web", { builtinTools: ["web_fetch"] })] });
                rt.model.script = sequence([{ name: "web_fetch", args: { url } }]);
                // Layer 1: the platform's guard refuses at the permission request (and audits it).
                const blocked = await dm(rt, "web", "fetch it");
                expect(blocked.last.text).toContain("private or internal address");
                expect(blocked.last.text).not.toContain("INTERNAL ADMIN PAGE");
                expect(rt.sink.events("permission.blocked")).toHaveLength(1);
                await rt.close();

                // Layer 2: with the platform guard off, the Copilot runtime still refuses at fetch time
                // (it resolves the address when it connects, which also defeats DNS rebinding).
                rt = await realRuntime({ bots: [bot("web", { builtinTools: ["web_fetch"] })] }, { allowPrivateNetwork: true });
                rt.model.script = sequence([{ name: "web_fetch", args: { url } }]);
                const second = await dm(rt, "web", "fetch it");
                expect(second.last.text).toMatch(/blocked address 127\.0\.0\.1/);
                expect(second.last.text).not.toContain("INTERNAL ADMIN PAGE");
            } finally {
                internal.close();
            }
        },
        T,
    );

    it(
        "runs real MCP connectors: read-only tools run, write tools wait for approval, secrets reach only their server",
        async () => {
            process.env.TICKETS_TEST_TOKEN = "tickets-token-123";
            process.env.SECRET_KEY = "CANARY-PLATFORM-SECRET";
            rt = await realRuntime({
                bots: [bot("support", { connectors: ["tickets"] })],
                connectors: [
                    {
                        id: "tickets",
                        description: "Ticket system",
                        type: "stdio",
                        command: process.execPath,
                        args: [path.join(import.meta.dirname, "support", "fake-mcp.mjs")],
                        env: { TICKETS_TOKEN: "${env:TICKETS_TEST_TOKEN}" },
                    },
                ],
            });
            rt.model.script = sequence([
                { name: "tickets-get_ticket", args: { id: "T-1" } },
                { name: "tickets-close_ticket", args: { id: "T-1" } },
                { name: "tickets-whoami", args: {} },
            ]);
            const approvals = approver(rt, () => true);
            const { last } = await dm(rt, "support", "handle T-1");
            approvals.stop();

            expect(last.text).toContain("[tickets-get_ticket] Ticket T-1: printer on fire");
            expect(last.text).toContain("[tickets-close_ticket] Closed ticket T-1");
            expect(last.text).toContain("token=tickets-token-123 secret_key=none");
            expect(approvals.seen.map((a) => [a.kind, a.detail?.split(" ")[0]])).toEqual([["mcp", "tickets"]]);
            expect(approvals.seen[0]!.detail).toContain("close_ticket");
        },
        T,
    );

    it(
        "loads granted skills through the runtime's skill tool",
        async () => {
            rt = await realRuntime({
                bots: [bot("writer", { skills: ["release-notes"] })],
                skills: { "release-notes": skillMd("release-notes", "Writes release notes").replace("# release-notes", "Group changes under New, Improved, Fixed.") },
            });
            rt.model.script = (_req, h) => (h.lastUser.includes("<skill-context") ? { text: "drafted" } : { toolCalls: [{ name: "skill", args: { skill: "release-notes" } }] });
            const { last } = await dm(rt, "writer", "write release notes");
            expect(last.text).toBe("drafted");
            // The runtime delivers the skill body to the model as context after the tool call.
            const after = rt.model.requests.at(-1)!.messages.map((m) => JSON.stringify(m.content)).join("\n");
            expect(after).toContain("Group changes under New, Improved, Fixed.");
            const tools = (rt.model.requests[0]!.tools ?? []).map((t) => t.function?.name).sort();
            expect(tools).toEqual(["forget", "remember", "save_routine", "skill"]);
        },
        T,
    );

    it(
        "runs routines and hand-offs end to end",
        async () => {
            rt = await realRuntime({ bots: [bot("boss", { canMessage: ["worker"] }), bot("worker")] });
            rt.model.script = (_req, h) => {
                if (h.lastUser.includes("Routine: Nightly")) return { text: "nightly done" };
                if (h.lastUser.includes("task thread")) return { text: "worker result: 7" };
                if (h.lastUser.includes("Finished task")) return { text: "boss wrap-up" };
                if (!h.toolResults.length) return { toolCalls: [{ name: "assign_task", args: { bot: "worker", title: "Count", details: "count to 7" } }] };
                return { text: "handed off" };
            };
            const { thread } = await dm(rt, "boss", "delegate it");
            await rt.runtime.idle(45_000);
            expect(texts(rt.repo, thread.id)).toEqual([
                "user:alice: delegate it",
                "bot:boss: handed off",
                "bot:worker: **Finished task: Count**\n\nworker result: 7",
                "bot:boss: boss wrap-up",
            ]);
            const r = rt.runtime.createRoutine(alice, { botId: "boss", name: "Nightly", prompt: "summarize", schedule: null, timezone: null });
            rt.runtime.runRoutine("alice", r.id, "manual");
            await rt.runtime.idle(45_000);
            expect(rt.repo.runs(r.id)).toMatchObject([{ status: "done", output: "nightly done" }]);
        },
        T,
    );

    it(
        "resumes the same Copilot session across turns, so the model sees the history",
        async () => {
            rt = await realRuntime({ bots: [bot("pal")] });
            rt.model.script = (_req, h) => ({ text: `echo: ${h.lastUser.split("\n").at(-1)}` });
            const { thread } = await dm(rt, "pal", "my favourite colour is teal");
            rt.runtime.postUserMessage(alice, thread.id, "what did I say?");
            await rt.runtime.idle(45_000);
            const second = rt.model.requests.at(-1)!.messages.map((m) => JSON.stringify(m.content)).join("\n");
            expect(second).toContain("my favourite colour is teal");
            expect(second).toContain("echo: my favourite colour is teal");
        },
        T,
    );

    it(
        "stopping a thread ends a real turn that is waiting for approval",
        async () => {
            rt = await realRuntime({ bots: [bot("ops", { computer: true })] }, { computerAccess: "shell" });
            rt.model.script = sequence([{ name: "bash", args: { command: "sleep 1", description: "wait" } }]);
            const t = rt.runtime.directThread(alice, "ops");
            rt.runtime.postUserMessage(alice, t.id, "go");
            const end = Date.now() + 20_000;
            while (!rt.repo.approvals("alice", "pending").length && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
            expect(rt.runtime.stopThread(alice, t.id)).toBe(true);
            await rt.runtime.idle(20_000);
            expect(rt.repo.approvals("alice")[0]!.status).toBe("expired");
            expect(rt.runtime.status("alice").ops).toBeUndefined();
        },
        T,
    );

    it(
        "sends image attachments to the model",
        async () => {
            rt = await realRuntime({ bots: [bot("vision")] });
            const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
            const id = rt.repo.addUpload("alice", "pixel.png", "image/png", png.length);
            writeFileSync(rt.runtime.uploadPath(id), png);
            rt.model.script = () => ({ text: "I see a pixel." });
            const t = rt.runtime.directThread(alice, "vision");
            rt.runtime.postUserMessage(alice, t.id, "what is this?", [id]);
            await rt.runtime.idle(45_000);
            const sent = JSON.stringify(rt.model.requests.at(-1)!.messages);
            expect(sent).toMatch(/data:image\/png;base64,iVBORw0KGgo/);
            expect(rt.repo.messages(t.id).at(-1)!.text).toBe("I see a pixel.");
        },
        T,
    );

    it(
        "meters real model calls and runs bot evals through the real runtime",
        async () => {
            rt = await realRuntime({ bots: [bot("helper", { canMessage: ["*"] })] });
            rt.model.script = (_req, h) => (h.lastUser.includes("who else") && !h.toolResults.length ? { toolCalls: [{ name: "list_bots", args: {} }] } : { text: "The answer is 144." });
            await dm(rt, "helper", "what is 12 times 12?");
            // BYOK models report tokens but no Copilot premium requests.
            expect(rt.runtime.usageToday("alice").used).toMatchObject({ turns: 1, calls: 1, inputTokens: 100, outputTokens: 10, premiumRequests: 0 });

            const { Catalog } = await import("../src/catalog/catalog.js");
            const { runEvals } = await import("../src/evals.js");
            const { writeWorkspace } = await import("./helpers.js");
            const catalog = await Catalog.load(await writeWorkspace({ bots: [bot("helper", { canMessage: ["*"] })] }));
            const suites = [{ file: "evals/helper.yaml", spec: { bot: "helper", cases: [
                { name: "math", prompt: "what is 12 times 12?", approve: false, expect: { contains: ["144"], notContains: [], matches: [], tools: [], noTools: ["list_bots"] } },
                { name: "roster", prompt: "who else is on the team?", approve: false, expect: { contains: [], notContains: [], matches: [], tools: ["list_bots"], noTools: [] } },
            ] } }];
            const results = await runEvals({ catalog, engine: rt.engine, suites, user: alice, turnTimeoutMs: 45_000 });
            expect(results[0]!.cases.map((c) => [c.name, c.ok, c.failures])).toEqual([["math", true, []], ["roster", true, []]]);
        },
        T,
    );
});
