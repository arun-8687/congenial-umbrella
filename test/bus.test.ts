import { describe, expect, it } from "vitest";
import { NotFoundError } from "../src/conversations/service.js";
import { alice, bob, bot, makePlatform, type Script } from "./helpers.js";

/** A bot that forwards every prompt to `target` and returns what it got back. */
const forwardTo =
    (target: string): Script =>
    async (req, tool) =>
        `${req.bot.id} relayed: ${await tool("ask_bot", { bot: target, message: `${req.prompt} (via ${req.bot.id})` })}`;

describe("inter-bot messaging", () => {
    it("delegates to another bot in an ephemeral session as the same user, with agent provenance", async () => {
        const { platform, engine, sink } = await makePlatform(
            { bots: [bot("front", { canMessage: ["expert"] }), bot("expert")] },
            { front: forwardTo("expert") },
        );
        const c = await platform.createConversation(alice, "front");
        const { reply, traceId } = await platform.send(alice, c.id, "what is 2+2");

        expect(reply).toBe("front relayed: expert says: Request from bot 'FRONT' (front), acting for @alice:\n\nwhat is 2+2 (via front)");
        const hop = engine.turns[1]!;
        expect(hop).toMatchObject({ resume: false, ephemeral: true, source: "agent-front", user: alice });
        expect(hop.bot.id).toBe("expert");
        expect(engine.deleted).toEqual([hop.sessionId]);

        expect(sink.events("bus.ask")).toEqual([
            { type: "bus.ask", from: "front", to: "expert", chain: ["front", "expert"], message: "what is 2+2 (via front)" },
        ]);
        expect(sink.records.filter((r) => r.event.type.startsWith("bus.")).every((r) => r.traceId === traceId)).toBe(true);
    });

    it("offers no bus tools to bots that may not message anyone", async () => {
        const { platform, engine } = await makePlatform({ bots: [bot("solo")] });
        const c = await platform.createConversation(alice, "solo");
        await platform.send(alice, c.id, "hi");
        expect(engine.turns[0]!.tools).toEqual([]);
    });

    it("list_bots shows only allowed targets the user can access", async () => {
        let listing = "";
        const { platform } = await makePlatform(
            {
                bots: [
                    bot("front", { canMessage: ["open", "acme-only", "bob-only"] }),
                    bot("open"),
                    bot("acme-only", { access: { users: [], orgs: ["acme"] } }),
                    bot("bob-only", { access: { users: ["bob"] } }),
                    bot("unlisted"),
                ],
            },
            { front: async (_r, tool) => (listing = await tool("list_bots", {})) },
        );
        await platform.send(alice, (await platform.createConversation(alice, "front")).id, "who?");
        expect(listing).toBe("- open: OPEN. The open bot\n- acme-only: ACME-ONLY. The acme-only bot");
    });

    it("refuses targets outside canMessage, unknown bots, and bots the user cannot access", async () => {
        const answers: string[] = [];
        const { platform, engine, sink } = await makePlatform(
            { bots: [bot("front", { canMessage: ["private"] }), bot("private", { access: { users: ["bob"] } }), bot("other")] },
            {
                front: async (_r, tool) => {
                    for (const target of ["other", "nobody", "private"]) answers.push(await tool("ask_bot", { bot: target, message: "x" }));
                    return "done";
                },
            },
        );
        await platform.send(alice, (await platform.createConversation(alice, "front")).id, "go");
        expect(answers).toEqual([
            "Refused: 'front' is not allowed to message 'other'",
            "Refused: no bot named 'nobody'",
            "Refused: @alice does not have access to 'private'",
        ]);
        expect(engine.turns).toHaveLength(1);
        expect(sink.events("bus.refused")).toHaveLength(3);
    });

    it("breaks cycles even when canMessage allows them", async () => {
        const { platform, engine, sink } = await makePlatform(
            { bots: [bot("ping", { canMessage: ["pong"] }), bot("pong", { canMessage: ["ping"] })] },
            { ping: forwardTo("pong"), pong: forwardTo("ping") },
        );
        const { reply } = await platform.send(alice, (await platform.createConversation(alice, "ping")).id, "loop");
        expect(reply).toContain("Refused: 'ping' is already working on this request (cycle: ping -> pong -> ping)");
        expect(engine.turns.map((t) => t.bot.id)).toEqual(["ping", "pong"]);
        expect(sink.events("bus.refused")[0]?.chain).toEqual(["ping", "pong"]);
    });

    it("enforces the hop limit", async () => {
        const chain = ["one", "two", "three", "four"];
        const bots = chain.map((id, i) => bot(id, { canMessage: chain[i + 1] ? [chain[i + 1]!] : [] }));
        const scripts = Object.fromEntries(chain.slice(0, -1).map((id, i) => [id, forwardTo(chain[i + 1]!)]));
        const { platform, engine } = await makePlatform({ bots }, scripts, { maxHops: 2, maxCallsPerRequest: 10 });
        const { reply } = await platform.send(alice, (await platform.createConversation(alice, "one")).id, "deep");
        expect(reply).toContain("Refused: hop limit of 2 reached");
        expect(engine.turns.map((t) => t.bot.id)).toEqual(["one", "two", "three"]);
    });

    it("shares one call budget across the whole request", async () => {
        const answers: string[] = [];
        const { platform, engine } = await makePlatform(
            { bots: [bot("fan", { canMessage: ["leaf"] }), bot("leaf")] },
            {
                fan: async (_r, tool) => {
                    for (let i = 0; i < 4; i++) answers.push(await tool("ask_bot", { bot: "leaf", message: `q${i}` }));
                    return "ok";
                },
            },
            { maxHops: 3, maxCallsPerRequest: 2 },
        );
        const conv = await platform.createConversation(alice, "fan");
        await platform.send(alice, conv.id, "go");
        expect(answers.filter((a) => a.startsWith("Refused: bot-to-bot call budget"))).toHaveLength(2);
        expect(engine.turns).toHaveLength(3);

        // A new request gets a fresh budget.
        answers.length = 0;
        await platform.send(alice, conv.id, "again");
        expect(answers.filter((a) => a.startsWith("Refused"))).toHaveLength(2);
    });

    it("turns a failing target into an error string instead of failing the caller", async () => {
        const { platform, sink } = await makePlatform(
            { bots: [bot("front", { canMessage: ["flaky"] }), bot("flaky")] },
            { front: forwardTo("flaky"), flaky: async () => Promise.reject(new Error("model overloaded")) },
        );
        const { reply } = await platform.send(alice, (await platform.createConversation(alice, "front")).id, "x");
        expect(reply).toBe("front relayed: Error: 'flaky' failed to answer (model overloaded).");
        expect(sink.events("error")[0]?.where).toBe("bus front -> flaky");
    });
});

describe("conversations", () => {
    it("creates on the first turn and resumes on later ones", async () => {
        const { platform, engine } = await makePlatform({ bots: [bot("helper")] });
        const c = await platform.createConversation(alice, "helper");
        await platform.send(alice, c.id, "one");
        await platform.send(alice, c.id, "two");
        expect(engine.turns.map((t) => [t.sessionId, t.resume])).toEqual([
            [c.id, false],
            [c.id, true],
        ]);
        const stored = await platform.getConversation(alice, c.id);
        expect(stored.turns).toBe(2);
        expect(stored.messages.map((m) => m.role)).toEqual(["user", "bot", "user", "bot"]);
    });

    it("isolates conversations between users and hides bots users cannot access", async () => {
        const { platform } = await makePlatform({
            bots: [bot("helper"), bot("acme-bot", { access: { users: [], orgs: ["acme"] } }), bot("hidden", { internal: true })],
        });
        const c = await platform.createConversation(alice, "helper");
        await expect(platform.send(bob, c.id, "hi")).rejects.toBeInstanceOf(NotFoundError);
        await expect(platform.getConversation(bob, c.id)).rejects.toBeInstanceOf(NotFoundError);
        expect(await platform.listConversations(bob)).toEqual([]);

        expect(platform.visibleBots(alice).map((b) => b.id)).toEqual(["acme-bot", "helper"]);
        expect(platform.visibleBots(bob).map((b) => b.id)).toEqual(["helper"]);
        await expect(platform.createConversation(bob, "acme-bot")).rejects.toThrow("bot acme-bot not found");
        await expect(platform.createConversation(alice, "hidden")).rejects.toThrow("bot hidden not found");
    });

    it("serializes turns within a conversation", async () => {
        let active = 0;
        let maxActive = 0;
        const { platform } = await makePlatform(
            { bots: [bot("slow")] },
            {
                slow: async (req) => {
                    maxActive = Math.max(maxActive, ++active);
                    await new Promise((r) => setTimeout(r, 10));
                    active--;
                    return req.prompt;
                },
            },
        );
        const c = await platform.createConversation(alice, "slow");
        const replies = await Promise.all(["a", "b", "c"].map((t) => platform.send(alice, c.id, t)));
        expect(maxActive).toBe(1);
        expect(replies.map((r) => r.reply)).toEqual(["a", "b", "c"]);
        expect((await platform.getConversation(alice, c.id)).turns).toBe(3);
    });

    it("deletes the Copilot session with the conversation", async () => {
        const { platform, engine } = await makePlatform({ bots: [bot("helper")] });
        const c = await platform.createConversation(alice, "helper");
        await platform.send(alice, c.id, "hi");
        await platform.deleteConversation(alice, c.id);
        expect(engine.deleted).toEqual([c.id]);
        await expect(platform.getConversation(alice, c.id)).rejects.toBeInstanceOf(NotFoundError);
    });
});
