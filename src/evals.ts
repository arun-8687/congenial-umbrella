import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { Auditor, MemoryAuditSink } from "./audit.js";
import type { Catalog } from "./catalog/catalog.js";
import { Id } from "./catalog/schema.js";
import { Sealer } from "./crypto.js";
import type { ComputerAccess } from "./engine/policy.js";
import type { AgentEngine } from "./engine/types.js";
import type { User } from "./identity.js";
import { Directory, type BotEntry } from "./runtime/directory.js";
import { Hub } from "./runtime/events.js";
import { Repo } from "./runtime/repo.js";
import { DEFAULT_RUNTIME_OPTIONS, Runtime } from "./runtime/runtime.js";
import { Db } from "./store/db.js";
import { randomBytes } from "node:crypto";

/**
 * Bot evals: regression cases for bots, kept next to them in the workspace and run in CI, so a
 * change to a bot's instructions, model, skills or connectors is tested like any other change.
 *
 *     <root>/evals/<name>.yaml
 *       bot: release-writer
 *       cases:
 *         - name: asks before closing tickets
 *           prompt: Close ticket 7
 *           expect: { asksApproval: true, notContains: ["closed"] }
 */
const Expect = z
    .object({
        /** Substrings the reply must contain (case-insensitive). */
        contains: z.array(z.string().min(1)).default([]),
        /** Substrings the reply must not contain (case-insensitive). */
        notContains: z.array(z.string().min(1)).default([]),
        /** Regular expressions the reply must match; `/.../flags` or a bare pattern. */
        matches: z.array(z.string().min(1)).default([]),
        /** Tools the bot must use (name, or `prefix*`). */
        tools: z.array(z.string().min(1)).default([]),
        /** Tools the bot must not use. */
        noTools: z.array(z.string().min(1)).default([]),
        /** Whether the bot must (true) or must not (false) ask for a human approval. */
        asksApproval: z.boolean().optional(),
        maxToolCalls: z.number().int().min(0).optional(),
    })
    .strict();

export const EvalCase = z
    .object({
        name: z.string().trim().min(1).max(200),
        prompt: z.string().min(1).max(20_000),
        /** Approve the bot's approval requests in this case (default: deny them). */
        approve: z.boolean().default(false),
        expect: Expect.default({ contains: [], notContains: [], matches: [], tools: [], noTools: [] }),
    })
    .strict();
export type EvalCase = z.infer<typeof EvalCase>;

export const EvalFile = z.object({ bot: Id, cases: z.array(EvalCase).min(1).max(200) }).strict();
export type EvalFile = z.infer<typeof EvalFile>;

export interface EvalSuite {
    file: string;
    spec: EvalFile;
}

/** Loads `<root>/evals/*.yaml`. Problems are returned rather than thrown, like catalog validation. */
export async function loadEvals(root: string, catalog?: Catalog): Promise<{ suites: EvalSuite[]; problems: string[] }> {
    const dir = path.join(root, "evals");
    const suites: EvalSuite[] = [];
    const problems: string[] = [];
    if (!existsSync(dir)) return { suites, problems };
    for (const file of (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort()) {
        const where = path.join("evals", file);
        let raw: unknown;
        try {
            raw = YAML.parse(await readFile(path.join(dir, file), "utf8"), { maxAliasCount: 0 });
        } catch (err) {
            problems.push(`${where}: ${(err as Error).message}`);
            continue;
        }
        const parsed = EvalFile.safeParse(raw);
        if (!parsed.success) {
            problems.push(...parsed.error.issues.map((i) => `${where}: ${i.path.join(".")}${i.path.length ? ": " : ""}${i.message}`));
            continue;
        }
        if (catalog && !catalog.bots.has(parsed.data.bot)) problems.push(`${where}: unknown bot '${parsed.data.bot}'`);
        for (const [i, c] of parsed.data.cases.entries()) {
            for (const m of c.expect.matches) if (!toRegExp(m)) problems.push(`${where}: cases.${i}.expect.matches: invalid regular expression ${m}`);
        }
        suites.push({ file: where, spec: parsed.data });
    }
    return { suites, problems };
}

export interface CaseResult {
    name: string;
    ok: boolean;
    failures: string[];
    reply: string;
    tools: string[];
    approvals: number;
    durationMs: number;
}

export interface SuiteResult {
    file: string;
    bot: string;
    cases: CaseResult[];
}

/** Evals test what a bot does, not who may use it: every catalog bot is reachable. */
class EvalDirectory extends Directory {
    override bots(user: Pick<User, "login" | "orgs">, opts: { includeInternal?: boolean } = {}): BotEntry[] {
        return [...this.catalog.bots.values()].filter((b) => opts.includeInternal || !b.internal).map((bot) => ({ bot, scope: "org" as const }));
    }
}

export interface RunEvalsOptions {
    catalog: Catalog;
    engine: AgentEngine;
    suites: EvalSuite[];
    /** Who the bots work for; their GitHub token reaches Copilot and connectors. */
    user: User;
    computerAccess?: ComputerAccess;
    turnTimeoutMs?: number;
    /** Only cases whose suite file, bot or name contains this text. */
    filter?: string;
    onCase?: (suite: SuiteResult, result: CaseResult) => void;
}

/** Runs each case in a fresh thread on a throwaway runtime (in-memory database, temp state dir). */
export async function runEvals(o: RunEvalsOptions): Promise<SuiteResult[]> {
    const state = await mkdtemp(path.join(tmpdir(), "bot-evals-"));
    const db = new Db(":memory:");
    const repo = new Repo(db);
    const hub = new Hub();
    const turnTimeoutMs = o.turnTimeoutMs ?? 300_000;
    const runtime = new Runtime(repo, new EvalDirectory(o.catalog, repo), o.engine, hub, new Auditor(new MemoryAuditSink()), new Sealer(randomBytes(32)), {
        ...DEFAULT_RUNTIME_OPTIONS,
        computerAccess: o.computerAccess ?? "off",
        computersDir: path.join(state, "computers"),
        uploadsDir: path.join(state, "uploads"),
        turnTimeoutMs,
        approvalTimeoutMs: turnTimeoutMs,
        maxQueuedPerUser: 1_000,
    });
    runtime.rememberUser(o.user);
    runtime.start();
    let approveCurrent = false;
    // Approval requests are answered as the case says, as soon as they appear.
    hub.subscribe(o.user.login, (e) => {
        if (e.type !== "approval.created") return;
        queueMicrotask(() => {
            try {
                runtime.decideApproval(o.user, e.approval.id, approveCurrent);
            } catch {
                // already decided or expired
            }
        });
    });
    const results: SuiteResult[] = [];
    const needle = o.filter?.toLowerCase();
    try {
        for (const suite of o.suites) {
            const out: SuiteResult = { file: suite.file, bot: suite.spec.bot, cases: [] };
            results.push(out);
            for (const c of suite.spec.cases) {
                if (needle && ![suite.file, suite.spec.bot, c.name].some((x) => x.toLowerCase().includes(needle))) continue;
                approveCurrent = c.approve;
                const started = Date.now();
                const thread = runtime.newThread(o.user, [suite.spec.bot], `eval: ${c.name}`);
                runtime.postUserMessage(o.user, thread.id, c.prompt);
                let timedOut = false;
                await runtime.idle(turnTimeoutMs + 5_000).catch(() => {
                    timedOut = true;
                    runtime.stopThread(o.user, thread.id);
                });
                const messages = repo.messages(thread.id);
                const replies = messages.filter((m) => m.authorType === "bot");
                const errors = messages.filter((m) => m.authorType === "system" && m.meta.error).map((m) => m.meta.error!);
                const reply = replies.map((m) => m.text).join("\n\n");
                const tools = replies.flatMap((m) => m.meta.tools?.map((t) => t.tool) ?? []);
                const approvals = repo.approvals(o.user.login).filter((a) => a.threadId === thread.id).length;
                const failures = [
                    ...(timedOut ? [`timed out after ${turnTimeoutMs} ms`] : []),
                    ...errors.map((e) => `the turn failed: ${e}`),
                    ...(replies.length === 0 && !timedOut && !errors.length ? ["the bot did not reply"] : []),
                    ...checkExpectations(c.expect, { reply, tools, approvals }),
                ];
                const result: CaseResult = { name: c.name, ok: failures.length === 0, failures, reply, tools, approvals, durationMs: Date.now() - started };
                out.cases.push(result);
                o.onCase?.(out, result);
            }
        }
    } finally {
        await runtime.stop();
        db.close();
        await rm(state, { recursive: true, force: true });
    }
    return results;
}

/** Which expectations the reply, tool use and approvals of one case break. */
export function checkExpectations(e: EvalCase["expect"], got: { reply: string; tools: string[]; approvals: number }): string[] {
    const failures: string[] = [];
    const lower = got.reply.toLowerCase();
    const used = (pattern: string) => got.tools.some((t) => (pattern.endsWith("*") ? t.startsWith(pattern.slice(0, -1)) : t === pattern));
    for (const s of e.contains) if (!lower.includes(s.toLowerCase())) failures.push(`reply should contain "${s}"`);
    for (const s of e.notContains) if (lower.includes(s.toLowerCase())) failures.push(`reply should not contain "${s}"`);
    for (const m of e.matches) if (!toRegExp(m)?.test(got.reply)) failures.push(`reply should match ${m}`);
    for (const t of e.tools) if (!used(t)) failures.push(`should use tool ${t} (used: ${got.tools.join(", ") || "none"})`);
    for (const t of e.noTools) if (used(t)) failures.push(`should not use tool ${t}`);
    if (e.asksApproval === true && got.approvals === 0) failures.push("should ask for approval");
    if (e.asksApproval === false && got.approvals > 0) failures.push(`should not ask for approval (asked ${got.approvals}×)`);
    if (e.maxToolCalls !== undefined && got.tools.length > e.maxToolCalls) failures.push(`used ${got.tools.length} tool calls, at most ${e.maxToolCalls} allowed`);
    return failures;
}

function toRegExp(m: string): RegExp | undefined {
    try {
        const lit = /^\/(.*)\/([dgimsuvy]*)$/s.exec(m);
        return lit ? new RegExp(lit[1]!, lit[2]!.replace("g", "")) : new RegExp(m);
    } catch {
        return undefined;
    }
}

/** JUnit XML, which every CI system renders: one testsuite per eval file, one testcase per case. */
export function toJUnit(results: SuiteResult[]): string {
    const esc = (s: string) =>
        s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
    const suites = results.map((s) => {
        const failed = s.cases.filter((c) => !c.ok).length;
        const time = s.cases.reduce((n, c) => n + c.durationMs, 0) / 1000;
        const cases = s.cases.map((c) => {
            const head = `    <testcase classname="${esc(s.bot)}" name="${esc(c.name)}" time="${(c.durationMs / 1000).toFixed(3)}"`;
            const out = `      <system-out>${esc(c.reply.slice(0, 20_000))}</system-out>`;
            return c.ok
                ? `${head}>\n${out}\n    </testcase>`
                : `${head}>\n      <failure message="${esc(c.failures[0] ?? "failed")}">${esc(c.failures.join("\n"))}</failure>\n${out}\n    </testcase>`;
        });
        return `  <testsuite name="${esc(s.file)}" tests="${s.cases.length}" failures="${failed}" time="${time.toFixed(3)}">\n${cases.join("\n")}\n  </testsuite>`;
    });
    const total = results.reduce((n, s) => n + s.cases.length, 0);
    const failures = results.reduce((n, s) => n + s.cases.filter((c) => !c.ok).length, 0);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bot evals" tests="${total}" failures="${failures}">\n${suites.join("\n")}\n</testsuites>\n`;
}
