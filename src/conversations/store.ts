import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export interface StoredMessage {
    role: "user" | "bot";
    text: string;
    at: string;
}

export interface Conversation {
    id: string;
    botId: string;
    owner: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    /** Completed turns; the Copilot session exists once this is > 0. */
    turns: number;
    messages: StoredMessage[];
}

export interface ConversationStore {
    get(id: string): Promise<Conversation | undefined>;
    put(conversation: Conversation): Promise<void>;
    delete(id: string): Promise<void>;
    listByOwner(owner: string): Promise<Conversation[]>;
}

const ID = /^[a-zA-Z0-9-]{8,64}$/;

/** One JSON file per conversation, written atomically. Fine for a single node; swap for a database to scale out. */
export class FileConversationStore implements ConversationStore {
    constructor(private readonly dir: string) {}

    async get(id: string): Promise<Conversation | undefined> {
        if (!ID.test(id)) return undefined;
        const file = this.file(id);
        if (!existsSync(file)) return undefined;
        return JSON.parse(await readFile(file, "utf8")) as Conversation;
    }

    async put(conversation: Conversation): Promise<void> {
        await mkdir(this.dir, { recursive: true });
        const file = this.file(conversation.id);
        const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
        await writeFile(tmp, JSON.stringify(conversation, null, 2), "utf8");
        await rename(tmp, file);
    }

    async delete(id: string): Promise<void> {
        if (ID.test(id)) await rm(this.file(id), { force: true });
    }

    async listByOwner(owner: string): Promise<Conversation[]> {
        if (!existsSync(this.dir)) return [];
        const out: Conversation[] = [];
        for (const f of await readdir(this.dir)) {
            if (!f.endsWith(".json")) continue;
            const c = JSON.parse(await readFile(path.join(this.dir, f), "utf8")) as Conversation;
            if (c.owner === owner) out.push(c);
        }
        return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    private file(id: string): string {
        return path.join(this.dir, `${id}.json`);
    }
}

export class MemoryConversationStore implements ConversationStore {
    private readonly items = new Map<string, Conversation>();
    async get(id: string) {
        const c = this.items.get(id);
        return c && structuredClone(c);
    }
    async put(c: Conversation) {
        this.items.set(c.id, structuredClone(c));
    }
    async delete(id: string) {
        this.items.delete(id);
    }
    async listByOwner(owner: string) {
        return [...this.items.values()].filter((c) => c.owner === owner).map((c) => structuredClone(c));
    }
}
