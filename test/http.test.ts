import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/http/server.js";
import type { Authenticator } from "../src/identity.js";
import { alice, bob, bot, makePlatform } from "./helpers.js";

const auth: Authenticator = {
    authenticate: async (t) => (t === "alice-token" ? { ...alice, githubToken: t } : t === "bob-token" ? { ...bob, githubToken: t } : null),
};

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start() {
    const ctx = await makePlatform(
        { bots: [bot("front", { canMessage: ["expert"] }), bot("expert")] },
        { front: async (req, tool) => `front: ${await tool("ask_bot", { bot: "expert", message: req.prompt })}` },
    );
    const server = createApiServer({ platform: ctx.platform, auth, admins: ["alice"] });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    close = () => server.close();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const api = (path: string, init: RequestInit & { as?: string } = {}) =>
        fetch(base + path, {
            ...init,
            headers: { Authorization: `Bearer ${init.as ?? "alice-token"}`, "Content-Type": "application/json", ...init.headers },
        });
    return { ...ctx, api, base };
}

describe("HTTP API", () => {
    it("requires a valid bearer token", async () => {
        const { base, api } = await start();
        expect((await fetch(`${base}/healthz`)).status).toBe(200);
        expect((await fetch(`${base}/v1/bots`)).status).toBe(401);
        expect((await api("/v1/bots", { as: "nope" })).status).toBe(401);
    });

    it("runs a conversation end to end", async () => {
        const { api, sink } = await start();
        expect((await (await api("/v1/bots")).json()).bots.map((b: { id: string }) => b.id)).toEqual(["expert", "front"]);

        const created = await api("/v1/conversations", { method: "POST", body: JSON.stringify({ botId: "front" }) });
        expect(created.status).toBe(201);
        const { id } = await created.json();

        const sent = await api(`/v1/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ text: "hello" }) });
        const body = await sent.json();
        expect(body.reply).toMatch(/^front: expert says: Request from bot 'FRONT'/);
        expect(body.traceId).toMatch(/^[0-9a-f-]{36}$/);

        const list = await (await api("/v1/conversations")).json();
        expect(list.conversations).toMatchObject([{ id, botId: "front", turns: 1, messageCount: 2 }]);
        expect((await api(`/v1/conversations/${id}`, { as: "bob-token" })).status).toBe(404);

        expect((await api(`/v1/conversations/${id}`, { method: "DELETE" })).status).toBe(204);
        expect((await api(`/v1/conversations/${id}`)).status).toBe(404);
        expect(JSON.stringify(sink.records)).not.toContain("alice-token");
    });

    it("streams events, tagged with the bot that produced them", async () => {
        const { api } = await start();
        const { id } = await (await api("/v1/conversations", { method: "POST", body: JSON.stringify({ botId: "front" }) })).json();
        const res = await api(`/v1/conversations/${id}/messages`, {
            method: "POST",
            body: JSON.stringify({ text: "stream it" }),
            headers: { Accept: "text/event-stream" },
        });
        expect(res.headers.get("content-type")).toBe("text/event-stream");
        const events = (await res.text())
            .trim()
            .split("\n\n")
            .map((block) => {
                const [ev, data] = block.split("\n");
                return { event: ev!.slice(7), data: JSON.parse(data!.slice(6)) };
            });
        expect(events.map((e) => `${e.event}:${e.data.botId ?? ""}:${e.data.depth ?? ""}`)).toEqual([
            "tool.start:front:0",
            "delta:expert:1",
            "tool.complete:front:0",
            "delta:front:0",
            "done::",
        ]);
    });

    it("validates request bodies", async () => {
        const { api } = await start();
        expect((await api("/v1/conversations", { method: "POST", body: "{" })).status).toBe(400);
        expect((await api("/v1/conversations", { method: "POST", body: JSON.stringify({ botId: "front", extra: 1 }) })).status).toBe(400);
        expect((await api("/v1/conversations", { method: "POST", body: JSON.stringify({ botId: "ghost" }) })).status).toBe(404);
    });

    it("lets admins create bots and nobody else", async () => {
        const { api, platform } = await start();
        const spec = { name: "New", description: "A new bot", instructions: "Be new.", access: { users: ["*"] } };
        expect((await api("/v1/admin/bots/newbie", { method: "PUT", body: JSON.stringify(spec), as: "bob-token" })).status).toBe(403);

        const bad = await api("/v1/admin/bots/newbie", { method: "PUT", body: JSON.stringify({ ...spec, canMessage: ["ghost"] }) });
        expect(bad.status).toBe(422);
        expect((await bad.json()).details).toEqual(["bot 'newbie': canMessage references unknown bot 'ghost'"]);

        const ok = await api("/v1/admin/bots/newbie", { method: "PUT", body: JSON.stringify(spec) });
        expect(ok.status).toBe(200);
        expect(platform.catalog.bot("newbie")?.name).toBe("New");
        expect((await (await api("/v1/bots", { as: "bob-token" })).json()).bots.map((b: { id: string }) => b.id)).toContain("newbie");
    });
});
