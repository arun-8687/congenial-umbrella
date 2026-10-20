import type { CopilotClient, MCPHTTPServerConfig, MCPStdioServerConfig, PermissionHandler, SkillProvider } from "@github/copilot-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Catalog } from "../src/catalog/catalog.js";
import { CopilotEngine } from "../src/engine/copilot.js";
import { platformTool } from "../src/engine/types.js";
import { alice, bot, skillMd, writeWorkspace } from "./helpers.js";

async function setup() {
    const catalog = await Catalog.load(
        await writeWorkspace({
            bots: [
                bot("full", {
                    model: "claude-sonnet-4.5",
                    builtinTools: ["web_fetch"],
                    skills: ["granted"],
                    connectors: ["github", "local"],
                }),
                bot("bare"),
            ],
            connectors: [
                { id: "github", description: "d", type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${user.githubToken}" } },
                { id: "local", description: "d", type: "stdio", command: "node", args: ["srv.js", "--user=${user.login}"], env: { KEY: "${env:LOCAL_KEY}" } },
            ],
            skills: { granted: skillMd("granted"), other: skillMd("other") },
        }),
    );
    // The client is never started; sessionConfig is a pure mapping.
    const engine = new CopilotEngine({ client: {} as CopilotClient, orgName: "Acme", env: { LOCAL_KEY: "k-123456" } });
    return { catalog, engine };
}

describe("CopilotEngine.sessionConfig", () => {
    it("maps a bot onto least-privilege Copilot session config", async () => {
        const { catalog, engine } = await setup();
        const tool = platformTool({ name: "ask_bot", description: "d", parameters: z.object({ bot: z.string() }), handler: async () => "x" });
        const config = engine.sessionConfig({ bot: catalog.bot("full")!, catalog, user: alice, tools: [tool] });

        expect(config.model).toBe("claude-sonnet-4.5");
        expect((config.availableTools as { toArray(): string[] }).toArray()).toEqual(["custom:*", "builtin:web_fetch", "builtin:skill", "mcp:*"]);
        expect(config.tools?.map((t) => [t.name, t.skipPermission])).toEqual([["ask_bot", true]]);
        expect(config.enableSkills).toBe(true);

        const gh = config.mcpServers?.github as MCPHTTPServerConfig;
        expect(gh.headers).toEqual({ Authorization: `Bearer ${alice.githubToken}` });
        const local = config.mcpServers?.local as MCPStdioServerConfig;
        expect(local.args).toEqual(["srv.js", "--user=alice"]);
        expect(local.env).toEqual({ KEY: "k-123456" });

        const token = await config.gitHubTokenProvider!({ host: "github.com", sessionId: "s", reason: "initial" } as never);
        expect(token).toMatchObject({ kind: "token", accessToken: alice.githubToken });
        expect((token as { expiresIn: number }).expiresIn).toBeGreaterThan(3600);

        const sys = config.systemMessage as { mode: string; sections: Record<string, { action: string; content?: string }>; content: string };
        expect(sys.mode).toBe("customize");
        expect(sys.sections.preamble?.content).toMatch(/^You are FULL, a bot on Acme's internal bot platform\./);
        expect(sys.sections.code_change_rules?.action).toBe("remove");
        expect(sys.sections.safety).toBeUndefined();
        expect(sys.content).toBe("You are full.");
    });

    it("serves only granted skills", async () => {
        const { catalog, engine } = await setup();
        const provider = engine.sessionConfig({ bot: catalog.bot("full")!, catalog, user: alice, tools: [] }).skillProvider as SkillProvider;
        const signal = new AbortController().signal;
        expect((await provider.listSkills({ signal })).map((s) => s.name)).toEqual(["granted"]);
        expect(await provider.readSkill("granted", { signal })).toContain("name: granted");
        expect(await provider.readSkill("other", { signal })).toBeNull();
    });

    it("gives a bare bot no built-ins, skills or connectors", async () => {
        const { catalog, engine } = await setup();
        const config = engine.sessionConfig({ bot: catalog.bot("bare")!, catalog, user: alice, tools: [] });
        expect((config.availableTools as { toArray(): string[] }).toArray()).toEqual(["custom:*"]);
        expect(config.mcpServers).toEqual({});
        expect(config.enableSkills).toBe(false);
        expect(config.skillProvider).toBeUndefined();
    });

    it("permission handler enforces the bot policy and reports decisions", async () => {
        const { catalog, engine } = await setup();
        const events: unknown[] = [];
        const config = engine.sessionConfig({ bot: catalog.bot("full")!, catalog, user: alice, tools: [], onEvent: (e) => events.push(e) });
        const decide = config.onPermissionRequest as PermissionHandler;
        const inv = { sessionId: "s" };
        expect(await decide({ kind: "url", url: "https://example.com" } as never, inv)).toEqual({ kind: "approve-once" });
        expect(await decide({ kind: "mcp", toolName: "x" } as never, inv)).toEqual({ kind: "approve-once" });
        expect(await decide({ kind: "shell", fullCommandText: "rm -rf /" } as never, inv)).toMatchObject({ kind: "reject" });
        expect(events).toContainEqual({ type: "permission", kind: "shell", decision: "reject", detail: "fullCommandText=rm -rf /" });
    });
});
