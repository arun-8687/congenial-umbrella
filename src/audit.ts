import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { redact } from "./secrets.js";

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

/**
 * Append-only JSONL audit log, one file per UTC day. Writes are chained so lines never interleave;
 * call `flush()` before exit.
 */
export class JsonlAuditSink implements AuditSink {
    private chain: Promise<void> = Promise.resolve();

    constructor(private readonly dir: string) {}

    write(record: AuditRecord): void {
        const file = path.join(this.dir, `audit-${record.ts.slice(0, 10)}.jsonl`);
        const line = JSON.stringify(record) + "\n";
        this.chain = this.chain
            .then(() => mkdir(this.dir, { recursive: true }))
            .then(() => appendFile(file, line, "utf8"))
            .catch((err) => console.error("audit write failed:", err));
    }

    flush(): Promise<void> {
        return this.chain;
    }
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

    log(event: AuditEvent, meta: { traceId?: string; actor?: string } = {}): void {
        const record: AuditRecord = { ts: new Date().toISOString(), ...meta, event };
        const json = redact(JSON.stringify(record), this.secrets);
        this.sink.write(JSON.parse(json) as AuditRecord);
    }
}
