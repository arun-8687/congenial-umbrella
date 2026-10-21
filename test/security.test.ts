import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotSpec, ConnectorSpec } from "../src/catalog/schema.js";
import { decide, insideDir, type PolicyContext } from "../src/engine/policy.js";
import { canUseConnector } from "../src/identity.js";
import type { Runtime } from "../src/runtime/runtime.js";
import { alice, bob, bot, makeRuntime } from "./helpers.js";

const spec = (extra: Parameters<typeof bot>[1] = {}) => BotSpec.parse(bot("xy", extra));
const connector = (extra: Record<string, unknown> = {}) =>
    ConnectorSpec.parse({ id: "gh", description: "d", type: "http", url: "https://example.com/mcp", ...extra });

async function workspace() {
    const dir = await mkdtemp(path.join(tmpdir(), "computer-"));
    const outside = await mkdtemp(path.join(tmpdir(), "outside-"));
    await writeFile(path.join(outside, "secret.key"), "s3cret");
    await mkdir(path.join(dir, "sub"));
    await symlink(path.join(outside, "secret.key"), path.join(dir, "sub", "link.txt"));
    return { dir, outside };
}

describe("computer policy", () => {
    it("confines file access to the user's workspace, including through symlinks", async () => {
        const { dir, outside } = await workspace();
        const b = spec({ computer: true });
        const ctx: PolicyContext = { computerAccess: "files", computerDir: dir, connector: () => undefined };
        expect(decide(b, { kind: "read", path: path.join(dir, "notes.md") }, ctx)).toEqual({ decision: "allow" });
        expect(decide(b, { kind: "read", path: "notes.md" }, ctx)).toEqual({ decision: "allow" });
        expect(decide(b, { kind: "write", path: path.join(dir, "out.txt") }, ctx)).toEqual({ decision: "ask" });
        for (const p of [path.join(outside, "secret.key"), "../secret.key", "/etc/passwd", path.join(dir, "sub", "link.txt")]) {
            expect(decide(b, { kind: "read", path: p }, ctx).decision).toBe("deny");
        }
        expect(decide(b, { kind: "read" }, ctx).decision).toBe("deny");
        expect(insideDir(dir, path.join(dir, "new", "deep", "file.txt"))).toBe(true);
    });

    it("only offers the shell when the deployment allows it", async () => {
        const { dir } = await workspace();
        const b = spec({ computer: true });
        const files: PolicyContext = { computerAccess: "files", computerDir: dir, connector: () => undefined };
        expect(decide(b, { kind: "shell", detail: "$ ls" }, files)).toMatchObject({ decision: "deny" });
        expect(decide(b, { kind: "shell", detail: "$ ls" }, { ...files, computerAccess: "shell" })).toEqual({ decision: "ask" });
        expect(decide(b, { kind: "read", path: "a" }, { ...files, computerAccess: "off" })).toMatchObject({ decision: "deny" });
        // A bot cannot grant itself a computer through its permission lists.
        expect(decide(spec({ permissions: { allow: ["read", "shell"] } }), { kind: "shell" }, { ...files, computerAccess: "shell" })).toMatchObject({ decision: "deny" });
    });

    it("limits web_fetch to the bot's allowed domains", () => {
        const b = spec({ builtinTools: ["web_fetch"], allowedDomains: ["docs.github.com", "*.example.com"] });
        const ctx: PolicyContext = { computerAccess: "off", connector: () => undefined };
        expect(decide(b, { kind: "url", url: "https://docs.github.com/en" }, ctx).decision).toBe("allow");
        expect(decide(b, { kind: "url", url: "https://api.example.com/x" }, ctx).decision).toBe("allow");
        expect(decide(b, { kind: "url", url: "https://evil.test/?q=secret" }, ctx).decision).toBe("deny");
        expect(decide(b, { kind: "url", url: "https://docs.github.com.evil.test/" }, ctx).decision).toBe("deny");
        expect(decide(spec({ builtinTools: ["web_fetch"] }), { kind: "url", url: "https://anything.test" }, ctx).decision).toBe("allow");
    });
});

describe("connector policy", () => {
    const ctxFor = (c: ConnectorSpec): PolicyContext => ({ computerAccess: "off", connector: (id) => (id === c.id ? c : undefined) });
    const b = spec({ connectors: ["gh"] });

    it("asks before write tools by default, allows read-only and allow-listed tools", () => {
        const c = connector({ allowTools: ["search_*"] });
        expect(decide(b, { kind: "mcp", server: "gh", tool: "get_issue", readOnly: true }, ctxFor(c)).decision).toBe("allow");
        expect(decide(b, { kind: "mcp", server: "gh", tool: "merge_pull_request", readOnly: false }, ctxFor(c)).decision).toBe("ask");
        expect(decide(b, { kind: "mcp", server: "gh", tool: "unannotated_tool" }, ctxFor(c)).decision).toBe("ask");
        expect(decide(b, { kind: "mcp", server: "gh", tool: "search_code", readOnly: false }, ctxFor(c)).decision).toBe("allow");
        expect(decide(b, { kind: "mcp", server: "other", tool: "x", readOnly: true }, ctxFor(c)).decision).toBe("deny");
    });

    it("honours always / never, and a bot that asks for every connector call", () => {
        expect(decide(b, { kind: "mcp", server: "gh", tool: "get", readOnly: true }, ctxFor(connector({ requireApproval: "always" }))).decision).toBe("ask");
        expect(decide(b, { kind: "mcp", server: "gh", tool: "delete", readOnly: false }, ctxFor(connector({ requireApproval: "never" }))).decision).toBe("allow");
        const cautious = spec({ connectors: ["gh"], permissions: { allow: ["custom-tool"], ask: ["mcp"] } });
        expect(decide(cautious, { kind: "mcp", server: "gh", tool: "get", readOnly: true }, ctxFor(connector({ requireApproval: "never" }))).decision).toBe("ask");
    });

    it("keeps connectors with org secrets away from personal bots unless access says otherwise", () => {
        const orgSecret = connector({ headers: { Authorization: "Bearer ${env:SHARED_TOKEN}" } });
        const ownToken = connector({ headers: { Authorization: "Bearer ${user.githubToken}" } });
        expect(canUseConnector(alice, ownToken)).toBe(true);
        expect(canUseConnector(alice, orgSecret)).toBe(false);
        const granted = connector({ headers: { Authorization: "Bearer ${env:SHARED_TOKEN}" }, access: { users: [], orgs: ["acme"] } });
        expect(canUseConnector(alice, granted)).toBe(true);
        expect(canUseConnector(bob, granted)).toBe(false);
    });
});

describe("enforced at runtime", () => {
    let rt: Runtime | undefined;
    afterEach(async () => rt?.stop());

    it("personal bots can't take org-secret connectors or a disabled computer", async () => {
        const ctx = await makeRuntime({
            bots: [bot("orgbot", { connectors: ["shared"] })],
            connectors: [{ id: "shared", description: "d", type: "http", url: "https://x.test/mcp", headers: { Authorization: "Bearer ${env:SHARED}" } }],
        });
        rt = ctx.runtime;
        const save = (input: Record<string, unknown>, computerAccess: "off" | "files" = "off") =>
            ctx.runtime.directory.savePersonalBot(alice, { name: "Mine", description: "d", instructions: "i", ...input }, { maxBotsAndGroups: 50, computerAccess });
        expect(() => save({ connectors: ["shared"] })).toThrow(/can't use connector 'shared'/);
        expect(() => save({ computer: true })).toThrow(/computer is turned off/);
        expect(save({ computer: true }, "files").computer).toBe(true);

        // The org bot, reviewed by admins, still gets it; a personal bot that already lists it
        // (saved before the connector's access changed) does not.
        const stale = BotSpec.parse({ ...bot("stale-bot"), connectors: ["shared"], access: { users: ["alice"] } });
        ctx.repo.savePersonalBot("alice", stale);
        expect(ctx.runtime.grantedConnectors(alice, ctx.catalog.bot("orgbot")!).map((g) => g.spec.id)).toEqual(["shared"]);
        expect(ctx.runtime.grantedConnectors(alice, stale)).toEqual([]);
    });

    it("strips the computer from bots when the deployment turns it off", async () => {
        const ctx = await makeRuntime({ bots: [bot("ops", { computer: true })] });
        rt = ctx.runtime;
        ctx.runtime.postUserMessage(alice, ctx.runtime.directThread(alice, "ops").id, "hi");
        await ctx.runtime.idle();
        expect(ctx.engine.turns[0]!.bot.computer).toBe(false);
        expect(ctx.engine.turns[0]!.computerShell).toBe(false);
    });
});
