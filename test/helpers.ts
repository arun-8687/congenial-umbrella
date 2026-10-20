import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { Auditor, MemoryAuditSink } from "../src/audit.js";
import { Catalog } from "../src/catalog/catalog.js";
import type { BotSpecInput } from "../src/catalog/schema.js";
import { Platform } from "../src/conversations/service.js";
import { MemoryConversationStore } from "../src/conversations/store.js";
import type { AgentEngine, TurnRequest, TurnResult } from "../src/engine/types.js";
import type { User } from "../src/identity.js";

export const alice: User = { login: "alice", id: 1, orgs: ["acme"], githubToken: "gho_alice_secret_token" };
export const bob: User = { login: "bob", id: 2, orgs: [], githubToken: "gho_bob_secret_token" };

export function bot(id: string, extra: Partial<BotSpecInput> = {}): BotSpecInput {
    return {
        id,
        name: id.toUpperCase(),
        description: `The ${id} bot`,
        instructions: `You are ${id}.`,
        access: { users: ["*"], orgs: [] },
        ...extra,
    };
}

export interface WorkspaceInput {
    bots?: BotSpecInput[];
    connectors?: Record<string, unknown>[];
    skills?: Record<string, string>;
    raw?: Record<string, string>;
}

export async function writeWorkspace(input: WorkspaceInput): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "bots-ws-"));
    await mkdir(path.join(root, "bots"));
    await mkdir(path.join(root, "connectors"));
    await mkdir(path.join(root, "skills"));
    for (const b of input.bots ?? []) await writeFile(path.join(root, "bots", `${b.id}.yaml`), YAML.stringify(b));
    for (const c of input.connectors ?? []) await writeFile(path.join(root, "connectors", `${c.id}.yaml`), YAML.stringify(c));
    for (const [name, md] of Object.entries(input.skills ?? {})) {
        await mkdir(path.join(root, "skills", name));
        await writeFile(path.join(root, "skills", name, "SKILL.md"), md);
    }
    for (const [rel, content] of Object.entries(input.raw ?? {})) {
        await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await writeFile(path.join(root, rel), content);
    }
    return root;
}

export function skillMd(name: string, description = `Does ${name}`): string {
    return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

/** Scripted stand-in for the model: each bot gets a function deciding what to do with a turn. */
export type Script = (req: TurnRequest, tool: (name: string, args: unknown) => Promise<string>) => Promise<string>;

export class FakeEngine implements AgentEngine {
    readonly turns: TurnRequest[] = [];
    readonly deleted: string[] = [];

    constructor(private readonly scripts: Record<string, Script> = {}) {}

    async start() {}
    async stop() {}
    async deleteSession(id: string) {
        this.deleted.push(id);
    }

    async turn(req: TurnRequest): Promise<TurnResult> {
        this.turns.push(req);
        const tool = async (name: string, args: unknown) => {
            const t = req.tools.find((x) => x.name === name);
            if (!t) throw new Error(`tool ${name} not offered to ${req.bot.id}`);
            req.onEvent?.({ type: "tool.start", tool: name, args });
            const out = await t.handler(t.parameters.parse(args));
            req.onEvent?.({ type: "tool.complete", tool: name, success: true });
            return out;
        };
        const script = this.scripts[req.bot.id] ?? (async (r) => `${r.bot.id} says: ${r.prompt}`);
        const text = await script(req, tool);
        req.onEvent?.({ type: "delta", text });
        if (req.ephemeral) this.deleted.push(req.sessionId);
        return { text };
    }
}

export async function makePlatform(input: WorkspaceInput, scripts: Record<string, Script> = {}, opts = { maxHops: 3, maxCallsPerRequest: 8 }) {
    const catalog = await Catalog.load(await writeWorkspace(input));
    const engine = new FakeEngine(scripts);
    const sink = new MemoryAuditSink();
    const audit = new Auditor(sink);
    const store = new MemoryConversationStore();
    const platform = new Platform(catalog, engine, store, audit, opts);
    return { platform, engine, sink, audit, catalog, store };
}
