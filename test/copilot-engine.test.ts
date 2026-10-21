import type { CopilotClient, MCPHTTPServerConfig, MCPStdioServerConfig, PermissionHandler, SkillProvider } from "@github/copilot-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Catalog } from "../src/catalog/catalog.js";
import { CopilotEngine } from "../src/engine/copilot.js";
import { platformTool, type TurnRequest } from "../src/engine/types.js";
import { alice, bot, skillMd, writeWorkspace } from "./helpers.js";

async function setup() {
    const catalog = await Catalog.load(
        await writeWorkspace({
            bots: [
                bot("full", { model: "claude-sonnet-4.5", title: "Analyst", builtinTools: ["web_fetch"], skills: ["granted"], connectors: ["github", "local", "jira"], computer: true }),
                bot("bare"),
            ],
            connectors: [
                { id: "github", description: "d", type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${user.githubToken}" } },
                { id: "local", description: "d", type: "stdio", command: "node", args: ["srv.js", "--user=${user.login}", "--dir=${user.computerDir}"], env: { KEY: "${env:LOCAL_KEY}" } },
                { id: "jira", description: "d", type: "http", url: "https://jira.example/mcp", headers: { Authorization: "Token ${user.credential}" }, auth: { type: "secret", label: "API token" } },
            ],
            skills: { granted: skillMd("granted"), other: skillMd("other") },
        }),
    );
    // The client is never started; sessionConfig is a pure mapping.
    const engine = new CopilotEngine({ client: {} as CopilotClient, orgName: "Acme", env: { LOCAL_KEY: "k-123456" } });
    const req = (botId: string, extra: Partial<TurnRequest> = {}) => {
        const b = catalog.bot(botId)!;
        return {
            bot: b,
            user: alice,
            skills: b.skills.map((s) => catalog.skills.get(s)!),
            connectors: b.connectors.map((c) => ({ spec: catalog.connectors.get(c)!, ...(c === "jira" ? { credential: "jira-cred-1" } : {}) })),
            computerDir: b.computer ? "/srv/computers/alice" : undefined,
            computerShell: b.computer,
            tools: [],
            decidePermission: async () => ({ decision: "approve" as const }),
            ...extra,
        };
    };
    return { catalog, engine, req };
}

describe("CopilotEngine.sessionConfig", () => {
    it("maps a bot onto least-privilege Copilot session config", async () => {
        const { engine, req } = await setup();
        const tool = platformTool({ name: "ask_bot", description: "d", parameters: z.object({ bot: z.string() }), handler: async () => "x" });
        const config = engine.sessionConfig(req("full", { tools: [tool], systemExtra: "Memory: likes tea" }));

        expect(config.model).toBe("claude-sonnet-4.5");
        expect(config.workingDirectory).toBe("/srv/computers/alice");
        const available = (config.availableTools as { toArray(): string[] }).toArray();
        expect(available.slice(0, 4)).toEqual(["custom:*", "builtin:web_fetch", "builtin:skill", "mcp:*"]);
        expect(available).toEqual(expect.arrayContaining(["builtin:bash", "builtin:view", "builtin:edit"]));
        const filesOnly = (engine.sessionConfig(req("full", { computerShell: false })).availableTools as { toArray(): string[] }).toArray();
        expect(filesOnly).toContain("builtin:view");
        expect(filesOnly.some((t) => t.includes("bash"))).toBe(false);
        expect(available.some((t) => t.includes("web_search"))).toBe(false);
        expect(config.tools?.map((t) => [t.name, t.skipPermission])).toEqual([["ask_bot", true]]);

        expect((config.mcpServers?.github as MCPHTTPServerConfig).headers).toEqual({ Authorization: `Bearer ${alice.githubToken}` });
        const local = config.mcpServers?.local as MCPStdioServerConfig;
        expect(local.args).toEqual(["srv.js", "--user=alice", "--dir=/srv/computers/alice"]);
        expect(local.env).toEqual({ KEY: "k-123456" });
        expect((config.mcpServers?.jira as MCPHTTPServerConfig).headers).toEqual({ Authorization: "Token jira-cred-1" });

        const token = await config.gitHubTokenProvider!({ host: "github.com", sessionId: "s", reason: "initial" } as never);
        expect(token).toMatchObject({ kind: "token", accessToken: alice.githubToken });
        expect((token as { expiresIn: number }).expiresIn).toBeGreaterThan(3600);

        const sys = config.systemMessage as { mode: string; sections: Record<string, { action: string; content?: string }>; content: string };
        expect(sys.mode).toBe("customize");
        expect(sys.sections.preamble?.content).toMatch(/^You are Full, the Analyst, an AI teammate on Acme's bot platform\./);
        expect(sys.sections.safety).toBeUndefined();
        expect(sys.content).toBe("You are full.\n\nMemory: likes tea");
    });

    it("serves only the skills it is given", async () => {
        const { engine, req } = await setup();
        const provider = engine.sessionConfig(req("full")).skillProvider as SkillProvider;
        const signal = new AbortController().signal;
        expect((await provider.listSkills({ signal })).map((s) => s.name)).toEqual(["granted"]);
        expect(await provider.readSkill("granted", { signal })).toContain("name: granted");
        expect(await provider.readSkill("other", { signal })).toBeNull();
    });

    it("gives a bare bot no built-ins, skills, connectors or computer, and strips coding sections", async () => {
        const { engine, req } = await setup();
        const config = engine.sessionConfig(req("bare"));
        expect((config.availableTools as { toArray(): string[] }).toArray()).toEqual(["custom:*"]);
        expect(config.mcpServers).toEqual({});
        expect(config.enableSkills).toBe(false);
        expect(config.workingDirectory).toBeUndefined();
        const sys = config.systemMessage as { sections: Record<string, { action: string }> };
        expect(sys.sections.code_change_rules?.action).toBe("remove");
    });

    it("routes every permission request through the platform's decision and reports it", async () => {
        const { engine, req } = await setup();
        const events: unknown[] = [];
        const asked: unknown[] = [];
        const config = engine.sessionConfig(
            req("full", {
                onEvent: (e) => events.push(e),
                decidePermission: async (ask) => {
                    asked.push(ask);
                    return ask.kind === "shell" ? { decision: "reject", feedback: "no" } : { decision: "approve" };
                },
            }),
        );
        const decide = config.onPermissionRequest as PermissionHandler;
        const inv = { sessionId: "s" };
        expect(await decide({ kind: "url", url: "https://example.com" } as never, inv)).toEqual({ kind: "approve-once" });
        expect(await decide({ kind: "shell", fullCommandText: "rm -rf /" } as never, inv)).toEqual({ kind: "reject", feedback: "no" });
        expect(asked).toEqual([
            expect.objectContaining({ kind: "url", detail: "https://example.com", url: "https://example.com" }),
            expect.objectContaining({ kind: "shell", detail: "$ rm -rf /" }),
        ]);
        await decide({ kind: "mcp", serverName: "github", toolName: "merge_pull_request", readOnly: false } as never, inv);
        await decide({ kind: "read", path: "notes.md", resolvedPath: "/srv/computers/alice/notes.md" } as never, inv);
        expect(asked.slice(2)).toEqual([
            expect.objectContaining({ kind: "mcp", server: "github", tool: "merge_pull_request", readOnly: false }),
            expect.objectContaining({ kind: "read", path: "/srv/computers/alice/notes.md" }),
        ]);
        expect(events).toContainEqual({ type: "permission", kind: "shell", decision: "reject", detail: "$ rm -rf /" });
    });
});
