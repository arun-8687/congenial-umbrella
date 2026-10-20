import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type App } from "../src/app.js";
import { MemoryAuditSink } from "../src/audit.js";
import { loadConfig } from "../src/config.js";
import type { Authenticator } from "../src/identity.js";
import { alice, bob, bot, FakeEngine, writeWorkspace } from "./helpers.js";

const auth: Authenticator = {
    authenticate: async (t) => (t === "alice-token" ? { ...alice, githubToken: t } : t === "bob-token" ? { ...bob, githubToken: t } : null),
};

let app: App | undefined;
afterEach(async () => {
    await app?.shutdown();
    app = undefined;
});

async function start(env: Record<string, string> = {}) {
    const workspace = await writeWorkspace({ bots: [bot("helper"), bot("ops", { computer: true })] });
    const state = await mkdtemp(path.join(tmpdir(), "bots-http-"));
    const sink = new MemoryAuditSink();
    const engine = new FakeEngine({
        ops: async (req) => ((await req.decidePermission({ kind: "shell", detail: "$ ls" })).decision === "approve" ? "listed" : "skipped"),
    });
    app = await buildApp(loadConfig({ WORKSPACE_DIR: workspace, STATE_DIR: state, ADMINS: "alice", ENGINE: "demo", ...env }), { engine, authenticator: auth, auditSink: sink });
    await new Promise<void>((r) => app!.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const bearer = (token: string) => (p: string, init: RequestInit = {}) =>
        fetch(base + p, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers } });
    return { base, as: bearer("alice-token"), asBob: bearer("bob-token"), sink, engine, state };
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

describe("auth", () => {
    it("requires sign-in and supports bearer tokens", async () => {
        const { base, as } = await start();
        expect((await fetch(`${base}/healthz`)).status).toBe(200);
        expect((await fetch(`${base}/api/bots`)).status).toBe(401);
        expect(await (await fetch(`${base}/auth/session`)).json()).toEqual({ login: null });
        expect((await as("/api/me")).status).toBe(200);
    });

    it("token sign-in sets a session cookie; cookie writes need X-CSRF", async () => {
        const { base } = await start();
        expect((await fetch(`${base}/auth/token`, { method: "POST", body: JSON.stringify({ token: "alice-token" }), headers: { "Content-Type": "application/json" } })).status).toBe(404);
        const bad = await fetch(`${base}/auth/token`, { method: "POST", body: JSON.stringify({ token: "nope-nope-nope" }), headers: { "X-CSRF": "1" } });
        expect(bad.status).toBe(401);

        const res = await fetch(`${base}/auth/token`, { method: "POST", body: JSON.stringify({ token: "alice-token" }), headers: { "X-CSRF": "1" } });
        const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
        expect(res.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax/);
        expect(await (await fetch(`${base}/auth/session`, { headers: { cookie } })).json()).toEqual({ login: "alice" });

        expect((await fetch(`${base}/api/bots/helper/dm`, { method: "POST", headers: { cookie } })).status).toBe(403);
        expect((await fetch(`${base}/api/bots/helper/dm`, { method: "POST", headers: { cookie, "X-CSRF": "1" } })).status).toBe(200);

        await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie, "X-CSRF": "1" } });
        expect((await fetch(`${base}/api/me`, { headers: { cookie } })).status).toBe(401);
    });

    it("dev login only exists in demo mode with DEV_LOGIN", async () => {
        expect(() => loadConfig({ DEV_LOGIN: "1", ENGINE: "copilot" })).toThrow(/only allowed with ENGINE=demo/);
        const { base } = await start();
        expect((await fetch(`${base}/auth/dev`, { method: "POST", body: JSON.stringify({ login: "x" }), headers: { "X-CSRF": "1" } })).status).toBe(404);
    });
});

describe("API", () => {
    it("runs a DM end to end and streams events over SSE", async () => {
        const { base, as } = await start();
        const ctrl = new AbortController();
        const sse = await fetch(`${base}/api/events`, { headers: { Authorization: "Bearer alice-token" }, signal: ctrl.signal });
        const reader = sse.body!.getReader();
        let streamed = "";
        const reading = (async () => {
            for (;;) {
                const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
                if (done) break;
                streamed += new TextDecoder().decode(value);
                if (streamed.includes("event: message.created") && streamed.includes("helper saw")) break;
            }
        })();

        const t = await (await as("/api/bots/helper/dm", json({}))).json();
        expect((await as(`/api/threads/${t.id}/messages`, json({ text: "hi there" }))).status).toBe(201);
        await app!.runtime.idle();
        await Promise.race([reading, new Promise((r) => setTimeout(r, 2000))]);
        ctrl.abort();
        expect(streamed).toContain("event: hello");
        expect(streamed).toContain("event: message.delta");

        const thread = await (await as(`/api/threads/${t.id}`)).json();
        expect(thread.messages.map((m: { text: string }) => m.text)).toEqual(["hi there", "helper saw: hi there"]);
        expect((await (await as("/api/threads?kind=dm")).json()).threads[0].unread).toBe(1);
        expect((await (await as("/api/search?q=there")).json()).results).toHaveLength(1);
    });

    it("keeps users apart", async () => {
        const { as, asBob } = await start();
        const t = await (await as("/api/bots/helper/dm", json({}))).json();
        expect((await asBob(`/api/threads/${t.id}`)).status).toBe(404);
        const mine = await (await as("/api/bots", json({ name: "Nova", description: "Helps", instructions: "Help." }))).json();
        expect(mine.id).toMatch(/^nova-[0-9a-f]{4}$/);
        expect((await (await asBob("/api/bots")).json()).bots.map((b: { id: string }) => b.id)).not.toContain(mine.id);
        expect((await asBob(`/api/bots/${mine.id}`, { method: "PUT", body: JSON.stringify({ name: "x", description: "d", instructions: "i" }) })).status).toBe(422);
    });

    it("validates personal bots against the catalog", async () => {
        const { as } = await start();
        const r = await as("/api/bots", json({ name: "Bad", description: "d", instructions: "i", skills: ["ghost"], builtinTools: ["web_search"] }));
        expect(r.status).toBe(422);
        expect((await r.json()).error).toBe("unknown skill 'ghost'");
        expect((await as("/api/bots", json({ name: "Bad", description: "d", instructions: "i", builtinTools: ["bash"] }))).status).toBe(422);
    });

    it("decides approvals over the API", async () => {
        const { as } = await start();
        const t = await (await as("/api/bots/ops/dm", json({}))).json();
        await as(`/api/threads/${t.id}/messages`, json({ text: "go" }));
        let pending: { id: string }[] = [];
        for (let i = 0; i < 100 && !pending.length; i++) {
            pending = (await (await as("/api/approvals?status=pending")).json()).approvals;
            await new Promise((r) => setTimeout(r, 10));
        }
        expect(pending).toHaveLength(1);
        expect((await as(`/api/approvals/${pending[0]!.id}`, json({ approve: true }))).status).toBe(200);
        await app!.runtime.idle();
        const thread = await (await as(`/api/threads/${t.id}`)).json();
        expect(thread.messages.at(-1).text).toBe("listed");
        expect(thread.approvals[0].status).toBe("approved");
    });

    it("uploads stay private; the computer refuses paths outside the workspace", async () => {
        const { as, asBob } = await start();
        const up = await (await as("/api/uploads", { method: "POST", body: "hello", headers: { "Content-Type": "text/plain", "X-Filename": "note.txt" } })).json();
        expect((await (await as(`/api/uploads/${up.id}`)).text())).toBe("hello");
        expect((await asBob(`/api/uploads/${up.id}`)).status).toBe(404);

        expect((await as("/api/computer/upload", { method: "POST", body: "x", headers: { "X-Path": "../escape.txt" } })).status).toBe(400);
        expect((await as("/api/computer/upload", { method: "POST", body: "data", headers: { "X-Path": "dir/a.txt" } })).status).toBe(201);
        expect((await (await as("/api/computer/files?path=dir")).json()).entries.map((e: { name: string }) => e.name)).toEqual(["a.txt"]);
        expect((await as("/api/computer/file?path=../../etc/passwd")).status).toBe(400);
        expect((await (await asBob("/api/computer/files")).json()).entries).toEqual([]);
    });

    it("share links are public, read-only, revocable and hide approvals", async () => {
        const { base, as } = await start();
        const t = await (await as("/api/bots/ops/dm", json({}))).json();
        await as(`/api/threads/${t.id}/messages`, json({ text: "go" }));
        await new Promise((r) => setTimeout(r, 100));
        const { token } = await (await as(`/api/threads/${t.id}/share`, json({}))).json();
        const shared = await (await fetch(`${base}/api/share/${token}`)).json();
        expect(shared.messages.map((m: { text: string }) => m.text)).toEqual(["go"]);
        expect(shared.bots.ops.name).toBe("Ops");
        await as(`/api/threads/${t.id}/share`, { method: "DELETE" });
        expect((await fetch(`${base}/api/share/${token}`)).status).toBe(404);
    });

    it("admin endpoints are for admins only, and the audit log redacts tokens", async () => {
        const { as, asBob, sink } = await start();
        expect((await asBob("/api/admin/catalog")).status).toBe(403);
        expect((await as("/api/admin/catalog")).status).toBe(200);
        await as("/api/memory", json({ text: "my token is alice-token" }));
        const t = await (await as("/api/bots/helper/dm", json({}))).json();
        await as(`/api/threads/${t.id}/messages`, json({ text: "token alice-token" }));
        await app!.runtime.idle();
        expect(JSON.stringify(sink.records)).not.toContain("alice-token");
        expect(JSON.stringify(sink.records)).toContain("[REDACTED]");
    });

    it("serves the web app with a strict CSP and rejects path traversal", async () => {
        const { base } = await start();
        const res = await fetch(`${base}/`);
        expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
        expect(await res.text()).toContain('<script type="module" src="/app.js">');
        expect((await fetch(`${base}/vendor/marked.js`)).status).toBe(200);
        expect((await fetch(`${base}/..%2f..%2fpackage.json`)).status).toBeGreaterThanOrEqual(400);
    });
});
