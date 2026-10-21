import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { redact } from "./secrets.js";

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * One auditable fact. `type` is a dotted name such as `message.user`, `tool.start`, `permission`,
 * `bus.ask`, `bus.refused`, `task.assigned`, `approval.decided`, `routine.run`, `memory.saved`.
 */
export interface AuditEvent {
    type: string;
    [field: string]: unknown;
}

export interface AuditRecord {
    ts: string;
    traceId?: string;
    actor?: string;
    event: AuditEvent;
}

export interface AuditSink {
    write(record: AuditRecord): void;
}

export const GENESIS_HASH = "0".repeat(64);

/**
 * Append-only JSONL audit log, one file per UTC day, hash-chained for tamper evidence: every line
 * carries `prev` (the previous line's hash, continuing across days) and `hash` over its own content.
 * Editing, deleting or reordering lines breaks the chain; check it with `copilot-bots verify-audit`.
 * Writes are serialized so lines never interleave; call `flush()` before exit.
 */
export class JsonlAuditSink implements AuditSink {
    private chain: Promise<void> = Promise.resolve();
    private lastHash: string | undefined;

    constructor(private readonly dir: string) {}

    write(record: AuditRecord): void {
        const file = path.join(this.dir, `audit-${record.ts.slice(0, 10)}.jsonl`);
        this.chain = this.chain
            .then(async () => {
                await mkdir(this.dir, { recursive: true, mode: 0o700 });
                const prev = this.lastHash ?? (await this.seed());
                const body = JSON.stringify(record);
                const hash = sha256Hex(`${prev}\n${body}`);
                await appendFile(file, `${body.slice(0, -1)},"prev":"${prev}","hash":"${hash}"}\n`, { encoding: "utf8", mode: 0o600 });
                this.lastHash = hash;
            })
            .catch((err) => console.error("audit write failed:", err));
    }

    flush(): Promise<void> {
        return this.chain;
    }

    /** Continues the chain from the newest existing file's last line. */
    private async seed(): Promise<string> {
        const files = (await readdir(this.dir)).filter((f) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
        for (const f of files.reverse()) {
            const lines = (await readFile(path.join(this.dir, f), "utf8")).trimEnd().split("\n").filter(Boolean);
            const last = lines.at(-1);
            if (last) return (JSON.parse(last) as { hash?: string }).hash ?? GENESIS_HASH;
        }
        return GENESIS_HASH;
    }
}

export type ChainResult = { ok: true; records: number; lastHash: string } | { ok: false; line: number; reason: string };

/** Verifies one file's chain, starting from `prev` (the previous file's last hash, or genesis). */
export function verifyAuditChain(text: string, prev?: string): ChainResult {
    const lines = text.split("\n").filter(Boolean);
    let expectedPrev = prev;
    for (let i = 0; i < lines.length; i++) {
        let obj: Record<string, unknown>;
        try {
            obj = JSON.parse(lines[i]!) as Record<string, unknown>;
        } catch {
            return { ok: false, line: i + 1, reason: "not JSON" };
        }
        const { prev: p, hash, ...rest } = obj;
        if (typeof p !== "string" || typeof hash !== "string") return { ok: false, line: i + 1, reason: "missing chain fields" };
        if (expectedPrev !== undefined && p !== expectedPrev) return { ok: false, line: i + 1, reason: "chain broken (a line was removed, inserted or reordered)" };
        if (sha256Hex(`${p}\n${JSON.stringify(rest)}`) !== hash) return { ok: false, line: i + 1, reason: "content does not match its hash (edited)" };
        expectedPrev = hash;
    }
    return { ok: true, records: lines.length, lastHash: expectedPrev ?? prev ?? GENESIS_HASH };
}

export class MemoryAuditSink implements AuditSink {
    readonly records: AuditRecord[] = [];
    write(record: AuditRecord): void {
        this.records.push(record);
    }
    events(type: string): AuditEvent[] {
        return this.records.map((r) => r.event).filter((e) => e.type === type);
    }
}

/**
 * Writes audit records, scrubbing every secret it has been told about (user tokens seen at
 * authentication, environment values referenced by connectors).
 */
export class Auditor {
    private readonly secrets = new Set<string>();

    constructor(
        private readonly sink: AuditSink,
        private readonly maxTrackedSecrets = 10_000,
    ) {}

    trackSecret(secret: string): void {
        if (secret.length < 6 || this.secrets.has(secret)) return;
        if (this.secrets.size >= this.maxTrackedSecrets) {
            const oldest = this.secrets.values().next().value;
            if (oldest !== undefined) this.secrets.delete(oldest);
        }
        this.secrets.add(secret);
    }

    /** Scrubs every known secret from free text (for console logs and error messages). */
    redactText(text: string): string {
        return redact(text, this.secrets);
    }

    log(event: AuditEvent, meta: { traceId?: string; actor?: string } = {}): void {
        const record: AuditRecord = { ts: new Date().toISOString(), ...meta, event };
        const json = redact(JSON.stringify(record), this.secrets);
        this.sink.write(JSON.parse(json) as AuditRecord);
    }
}
