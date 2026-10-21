#!/usr/bin/env node
import { buildApp } from "./app.js";
import { Catalog, CatalogError } from "./catalog/catalog.js";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { GENESIS_HASH, verifyAuditChain } from "./audit.js";
import { loadConfig } from "./config.js";
import { Sealer } from "./crypto.js";
import { Repo } from "./runtime/repo.js";
import { Db } from "./store/db.js";

const USAGE = `Usage: copilot-bots <command>

  serve               Start the web app and API
  validate [dir]      Validate a workspace (bots, connectors, skills)
  rotate-key          Re-seal stored secrets with SECRET_KEY (old key in SECRET_KEY_PREVIOUS)
  verify-audit [file] Check the audit log's hash chain for tampering
`;

async function main(argv: string[]): Promise<number> {
    const [command, arg] = argv;
    switch (command) {
        case "serve":
            return serve();
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
        console.log(`ok: ${c.bots.size} bots, ${c.connectors.size} connectors, ${c.skills.size} skills`);
        return 0;
    } catch (err) {
        if (err instanceof CatalogError) {
            console.error(err.message);
            return 1;
        }
        throw err;
    }
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
