import { describe, expect, it } from "vitest";
import { Auditor, MemoryAuditSink } from "../src/audit.js";
import { BotSpec, derivedPermissions } from "../src/catalog/schema.js";
import { decidePermission } from "../src/engine/policy.js";
import { canUseBot, GitHubAuthenticator } from "../src/identity.js";
import { resolvePlaceholders } from "../src/secrets.js";
import { alice, bob, bot } from "./helpers.js";

const spec = (extra: Parameters<typeof bot>[1] = {}) => BotSpec.parse(bot("xy", extra));

describe("permissions", () => {
    it("derives the minimum from what the bot uses", () => {
        expect(derivedPermissions(spec())).toEqual(["custom-tool"]);
        expect(derivedPermissions(spec({ builtinTools: ["web_fetch"], connectors: ["gh"] }))).toEqual(["custom-tool", "url", "mcp"]);
        expect(derivedPermissions(spec({ permissions: { allow: ["read"] } }))).toEqual(["read"]);
    });

    it("denies by default, including kinds the runtime adds later", () => {
        const b = spec({ builtinTools: ["web_fetch"] });
        expect(decidePermission(b, { kind: "url" }).decision).toBe("approve");
        for (const kind of ["shell", "write", "read", "mcp", "memory", "something-new"]) {
            expect(decidePermission(b, { kind }).decision).toBe("reject");
        }
    });
});

describe("access", () => {
    it("matches users, wildcard and orgs case-insensitively", () => {
        expect(canUseBot(alice, spec({ access: { users: ["*"] } }))).toBe(true);
        expect(canUseBot(alice, spec({ access: { users: ["ALICE"] } }))).toBe(true);
        expect(canUseBot(bob, spec({ access: { users: ["alice"] } }))).toBe(false);
        expect(canUseBot(alice, spec({ access: { users: [], orgs: ["Acme"] } }))).toBe(true);
        expect(canUseBot(bob, spec({ access: { users: [], orgs: ["acme"] } }))).toBe(false);
        expect(canUseBot(alice, spec({ access: { users: [], orgs: [] } }))).toBe(false);
    });
});

describe("GitHubAuthenticator", () => {
    it("resolves identity and orgs from the GitHub API, and caches", async () => {
        const calls: string[] = [];
        const fake = (async (url: string) => {
            calls.push(url);
            if (url.endsWith("/user")) return Response.json({ login: "Alice", id: 7 });
            return Response.json([{ login: "Acme" }]);
        }) as typeof fetch;
        const auth = new GitHubAuthenticator("https://gh.example/api/v3", 60_000, fake);
        expect(await auth.authenticate("t1")).toEqual({ login: "Alice", id: 7, orgs: ["acme"], githubToken: "t1" });
        await auth.authenticate("t1");
        expect(calls).toEqual(["https://gh.example/api/v3/user", "https://gh.example/api/v3/user/orgs?per_page=100"]);
    });

    it("returns null for rejected tokens and treats missing org scope as no orgs", async () => {
        const rejected = new GitHubAuthenticator("https://x", 0, (async () => new Response("", { status: 401 })) as typeof fetch);
        expect(await rejected.authenticate("bad")).toBeNull();

        const noScope = new GitHubAuthenticator("https://x", 0, (async (url: string) =>
            url.endsWith("/user") ? Response.json({ login: "a", id: 1 }) : new Response("", { status: 403 })) as typeof fetch);
        expect((await noScope.authenticate("t"))?.orgs).toEqual([]);
    });
});

describe("secrets", () => {
    it("resolves placeholders per user and fails on missing env", () => {
        expect(resolvePlaceholders("Bearer ${user.githubToken}", alice)).toBe(`Bearer ${alice.githubToken}`);
        expect(resolvePlaceholders("${env:FOO}-${user.login}", alice, { FOO: "bar" })).toBe("bar-alice");
        expect(() => resolvePlaceholders("${env:NOPE}", alice, {})).toThrow(/NOPE is not set/);
        expect(resolvePlaceholders("${unknown}", alice)).toBe("${unknown}");
    });

    it("audit records never contain tracked secrets", () => {
        const sink = new MemoryAuditSink();
        const audit = new Auditor(sink);
        audit.trackSecret(alice.githubToken);
        audit.log({ type: "message.user", conversationId: "c", botId: "b", text: `my token is ${alice.githubToken}` });
        expect(JSON.stringify(sink.records)).not.toContain(alice.githubToken);
        expect(sink.events("message.user")[0]?.text).toBe("my token is [REDACTED]");
    });
});
