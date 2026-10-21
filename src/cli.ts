#!/usr/bin/env node
import { buildApp } from "./app.js";
import { Catalog, CatalogError } from "./catalog/catalog.js";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { CopilotEngine } from "./engine/copilot.js";
import { DemoEngine } from "./engine/demo.js";
import { loadEvals, runEvals, toJUnit } from "./evals.js";
import { GitHubAuthenticator, type User } from "./identity.js";
import path from "node:path";
import { GENESIS_HASH, verifyAuditChain } from "./audit.js";
import { loadConfig } from "./config.js";
import { Sealer } from "./crypto.js";
import { Repo } from "./runtime/repo.js";
import { Db } from "./store/db.js";

const USAGE = `Usage: copilot-bots <command>

  serve               Start the web app and API
  validate [dir]      Validate a workspace (bots, connectors, skills, evals)
  eval [options]      Run the workspace's bot evals (evals/*.yaml)
      --bot <id>        only this bot's evals        --filter <text>  only matching cases
      --junit <file>    write JUnit XML for CI
  ask <bot> <prompt>  Ask a bot on a running server and print the answer; piped stdin is sent
                      as input. Needs COPILOT_BOTS_URL and COPILOT_BOTS_TOKEN (an API token).
      --title <text>  --timeout <seconds>  --no-wait  --json
  rotate-key          Re-seal stored secrets with SECRET_KEY (old key in SECRET_KEY_PREVIOUS)
  verify-audit [file] Check the audit log's hash chain for tampering
`;

async function main(argv: string[]): Promise<number> {
    const [command, arg] = argv;
    switch (command) {
        case "serve":
            return serve();
        case "eval":
            return runEvalCommand(argv.slice(1));
        case "ask":
            return ask(argv.slice(1));
        case "validate":
            return validate(arg ?? loadConfig().workspaceDir);
        case "rotate-key":
            return rotateKey();
        case "verify-audit":
            return verifyAudit(arg);
    }
    process.stderr.write(USAGE);
    return 2;
}

async function validate(dir: string): Promise<number> {
    try {
        const c = await Catalog.load(dir);
        const { suites, problems } = await loadEvals(dir, c);
        if (problems.length) {
            console.error(`Invalid evals:\n  - ${problems.join("\n  - ")}`);
            return 1;
        }
        const cases = suites.reduce((n, s) => n + s.spec.cases.length, 0);
        console.log(`ok: ${c.bots.size} bots, ${c.connectors.size} connectors, ${c.skills.size} skills, ${cases} eval cases`);
        return 0;
    } catch (err) {
        if (err instanceof CatalogError) {
            console.error(err.message);
            return 1;
        }
        throw err;
    }
}

function flags(args: string[], booleans: string[]): { positional: string[]; opts: Record<string, string | true> } {
    const positional: string[] = [];
    const opts: Record<string, string | true> = {};
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (!a.startsWith("--")) positional.push(a);
        else if (booleans.includes(a.slice(2))) opts[a.slice(2)] = true;
        else opts[a.slice(2)] = args[++i] ?? "";
    }
    return { positional, opts };
}

async function runEvalCommand(args: string[]): Promise<number> {
    const { opts } = flags(args, []);
    const config = loadConfig();
    const catalog = await Catalog.load(config.workspaceDir);
    const { suites, problems } = await loadEvals(config.workspaceDir, catalog);
    if (problems.length) {
        console.error(`Invalid evals:\n  - ${problems.join("\n  - ")}`);
        return 1;
    }
    const selected = suites.filter((s) => !opts.bot || s.spec.bot === opts.bot);
    if (!selected.length) {
        console.error(`No evals found in ${path.join(config.workspaceDir, "evals")}${opts.bot ? ` for bot ${String(opts.bot)}` : ""}.`);
        return 1;
    }
    const user = await evalUser(config);
    const engine =
        config.engine === "demo"
            ? new DemoEngine(0)
            : new CopilotEngine({ baseDirectory: path.join(config.stateDir, "eval-copilot"), defaultModel: config.defaultModel, orgName: config.orgName, logLevel: config.copilotLogLevel, provider: config.provider });
    await engine.start();
    let results;
    try {
        results = await runEvals({
            catalog,
            engine,
            suites: selected,
            user,
            computerAccess: config.computerAccess,
            turnTimeoutMs: config.turnTimeoutMs,
            filter: typeof opts.filter === "string" ? opts.filter : undefined,
            onCase: (s, r) => {
                console.log(`${r.ok ? "✓" : "✗"} ${s.bot} › ${r.name} (${(r.durationMs / 1000).toFixed(1)}s)`);
                for (const f of r.failures) console.log(`    ${f}`);
            },
        });
    } finally {
        await engine.stop();
    }
    if (typeof opts.junit === "string") {
        await mkdir(path.dirname(path.resolve(opts.junit)), { recursive: true });
        await writeFile(opts.junit, toJUnit(results));
    }
    const all = results.flatMap((s) => s.cases);
    const failed = all.filter((c) => !c.ok).length;
    console.log(`\n${all.length - failed} passed, ${failed} failed`);
    return failed ? 1 : 0;
}

/** Evals run as a real GitHub user (EVAL_GITHUB_TOKEN or GITHUB_TOKEN) unless no Copilot seat is needed. */
async function evalUser(config: ReturnType<typeof loadConfig>): Promise<User> {
    const synthetic: User = { login: "eval-runner", id: 0, orgs: [], githubToken: "dev-token-eval-runner" };
    if (config.engine === "demo") return synthetic;
    // A BYOK model needs no Copilot seat; a token is still used when given, for connectors.
    const token = process.env.EVAL_GITHUB_TOKEN ?? (config.provider ? undefined : process.env.GITHUB_TOKEN);
    if (token) {
        const user = await new GitHubAuthenticator(config.githubApiUrl).authenticate(token);
        if (!user) throw new Error("GitHub rejected the token in EVAL_GITHUB_TOKEN / GITHUB_TOKEN");
        return user;
    }
    if (config.provider) return synthetic;
    throw new Error("Set EVAL_GITHUB_TOKEN (a token with Copilot access) to run evals against Copilot, or use MODEL_PROVIDER / ENGINE=demo.");
}

async function ask(args: string[]): Promise<number> {
    const { positional, opts } = flags(args, ["no-wait", "json"]);
    const [botId, ...words] = positional;
    const base = process.env.COPILOT_BOTS_URL;
    const token = process.env.COPILOT_BOTS_TOKEN;
    if (!botId || !words.length) {
        process.stderr.write(USAGE);
        return 2;
    }
    if (!base || !token) {
        console.error("Set COPILOT_BOTS_URL (e.g. https://bots.example.com) and COPILOT_BOTS_TOKEN (Settings → API tokens, scope: ask).");
        return 2;
    }
    let input: string | undefined;
    if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const c of process.stdin) chunks.push(c as Buffer);
        input = Buffer.concat(chunks).toString("utf8") || undefined;
    }
    const timeoutSec = Math.min(600, Number(opts.timeout ?? 300) || 300);
    const res = await fetch(`${base.replace(/\/$/, "")}/api/bots/${encodeURIComponent(botId)}/ask`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: words.join(" "), ...(input ? { input: input.slice(0, 400_000) } : {}), ...(typeof opts.title === "string" ? { title: opts.title } : {}), wait: !opts["no-wait"], timeoutSec }),
        signal: AbortSignal.timeout((timeoutSec + 30) * 1000),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; status?: string; result?: string | null; url?: string; pendingApprovals?: number };
    if (!res.ok) {
        console.error(`error ${res.status}: ${body.error ?? res.statusText}`);
        return 1;
    }
    if (opts.json) console.log(JSON.stringify(body, null, 2));
    else if (body.status === "done") console.log(body.result ?? "");
    else if (body.status === "failed" || body.status === "cancelled") console.error(`${body.status}: ${body.result ?? ""}`);
    else console.error(`still ${body.status}${body.pendingApprovals ? ` (waiting for ${body.pendingApprovals} approval(s))` : ""}: ${body.url}`);
    // 0 done, 1 failed, 3 not finished yet (timed out, or waiting for a person)
    return body.status === "done" ? 0 : body.status === "failed" || body.status === "cancelled" ? 1 : 3;
}

async function rotateKey(): Promise<number> {
    const config = loadConfig();
    if (!config.secretKey || !config.secretKeyPrevious) {
        console.error("Set SECRET_KEY to the new key and SECRET_KEY_PREVIOUS to the old one.");
        return 2;
    }
    const sealer = Sealer.fromEnvOrFile(config.secretKey, config.stateDir, config.secretKeyPrevious);
    const db = new Db(config.dbFile);
    const n = new Repo(db).resealAll((v) => sealer.reseal(v));
    db.close();
    console.log(`re-sealed ${n} secrets; SECRET_KEY_PREVIOUS can now be removed`);
    return 0;
}

async function verifyAudit(file?: string): Promise<number> {
    const config = loadConfig();
    const files = file ? [file] : (await readdir(config.auditDir)).filter((f) => f.endsWith(".jsonl")).sort().map((f) => path.join(config.auditDir, f));
    // Files chain into each other, so a deleted day shows up as a break at the start of the next one.
    let prev: string | undefined = file ? undefined : GENESIS_HASH;
    let bad = 0;
    for (const f of files) {
        const result = verifyAuditChain(await readFile(f, "utf8"), prev);
        console.log(`${path.basename(f)}: ${result.ok ? `ok (${result.records} records)` : `TAMPERED at line ${result.line}: ${result.reason}`}`);
        if (!result.ok) {
            bad++;
            prev = undefined;
        } else prev = result.lastHash;
    }
    return bad ? 1 : 0;
}

async function serve(): Promise<number> {
    const config = loadConfig();
    const app = await buildApp(config);
    app.server.listen(config.port, config.host, () => {
        const url = config.publicUrl ?? `http://${config.host}:${config.port}`;
        console.log(`copilot-bots on ${url} (engine: ${config.engine}${config.devLogin ? ", DEV LOGIN ENABLED" : ""})`);
        if (!config.oauth && !config.devLogin) console.log("GitHub OAuth is not configured: users sign in by pasting a GitHub token.");
    });
    await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
    });
    await app.shutdown();
    return 0;
}

main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
    },
);
