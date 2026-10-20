import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { Auditor, MemoryAuditSink } from "../src/audit.js";
import { Catalog } from "../src/catalog/catalog.js";
import type { BotSpecInput } from "../src/catalog/schema.js";
import { Sealer } from "../src/crypto.js";
import type { AgentEngine, TurnRequest, TurnResult } from "../src/engine/types.js";
import type { User } from "../src/identity.js";
import { Directory } from "../src/runtime/directory.js";
import { Hub, type HubEvent } from "../src/runtime/events.js";
import { Repo } from "../src/runtime/repo.js";
import { DEFAULT_RUNTIME_OPTIONS, Runtime, type RuntimeOptions } from "../src/runtime/runtime.js";
import { Db } from "../src/store/db.js";

export const alice: User = { login: "alice", id: 1, orgs: ["acme"], githubToken: "gho_alice_secret_token" };
export const bob: User = { login: "bob", id: 2, orgs: [], githubToken: "gho_bob_secret_token" };

export function bot(id: string, extra: Partial<BotSpecInput> = {}): BotSpecInput {
    return {
        id,
        name: id.charAt(0).toUpperCase() + id.slice(1),
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
        const script = this.scripts[req.bot.id] ?? (async (r) => `${r.bot.id} saw: ${r.prompt}`);
        const text = await script(req, tool);
        req.onEvent?.({ type: "delta", text });
        if (req.ephemeral) this.deleted.push(req.sessionId);
        return { text };
    }
}

export async function makeRuntime(input: WorkspaceInput, scripts: Record<string, Script> = {}, opts: Partial<RuntimeOptions> = {}) {
    const catalog = await Catalog.load(await writeWorkspace(input));
    const dir = await mkdtemp(path.join(tmpdir(), "bots-state-"));
    const db = new Db(":memory:");
    const repo = new Repo(db);
    const engine = new FakeEngine(scripts);
    const sink = new MemoryAuditSink();
    const audit = new Auditor(sink);
    const hub = new Hub();
    const events: HubEvent[] = [];
    hub.subscribe("alice", (e) => events.push(e));
    const runtime = new Runtime(repo, new Directory(catalog, repo), engine, hub, audit, new Sealer(Buffer.alloc(32, 7)), {
        ...DEFAULT_RUNTIME_OPTIONS,
        computersDir: path.join(dir, "computers"),
        uploadsDir: path.join(dir, "uploads"),
        ...opts,
    });
    runtime.rememberUser(alice);
    runtime.rememberUser(bob);
    runtime.start();
    return { runtime, repo, engine, sink, events, catalog, db, dir };
}

export const texts = (repo: Repo, threadId: string) => repo.messages(threadId).map((m) => `${m.authorType}:${m.authorId}: ${m.text}`);
