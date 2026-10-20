import type { Server } from "node:http";
import { Auditor, JsonlAuditSink, type AuditSink } from "./audit.js";
import { Catalog } from "./catalog/catalog.js";
import type { Config } from "./config.js";
import { Sealer } from "./crypto.js";
import { CopilotEngine } from "./engine/copilot.js";
import { DemoEngine } from "./engine/demo.js";
import type { AgentEngine } from "./engine/types.js";
import { WebAuth } from "./http/auth.js";
import { createAppServer } from "./http/server.js";
import { GitHubAuthenticator, type Authenticator } from "./identity.js";
import { Directory } from "./runtime/directory.js";
import { Hub } from "./runtime/events.js";
import { Repo } from "./runtime/repo.js";
import { DEFAULT_RUNTIME_OPTIONS, Runtime } from "./runtime/runtime.js";
import { Db } from "./store/db.js";

export interface App {
    server: Server;
    runtime: Runtime;
    shutdown: () => Promise<void>;
}

export interface AppOverrides {
    engine?: AgentEngine;
    authenticator?: Authenticator;
    auditSink?: AuditSink;
    secureCookies?: boolean;
}

/** Wires catalog, store, engine, runtime and HTTP server together. */
export async function buildApp(config: Config, overrides: AppOverrides = {}): Promise<App> {
    const catalog = await Catalog.load(config.workspaceDir);
    const db = new Db(config.dbFile);
    const repo = new Repo(db);
    const sealer = Sealer.fromEnvOrFile(config.secretKey, config.stateDir);
    const sink = overrides.auditSink ?? new JsonlAuditSink(config.auditDir);
    const audit = new Auditor(sink);
    for (const value of connectorEnvSecrets(catalog)) audit.trackSecret(value);

    const engine =
        overrides.engine ??
        (config.engine === "demo"
            ? new DemoEngine()
            : new CopilotEngine({ baseDirectory: config.copilotHome, defaultModel: config.defaultModel, orgName: config.orgName, logLevel: config.copilotLogLevel }));
    await engine.start();

    const runtime = new Runtime(repo, new Directory(catalog, repo), engine, new Hub(), audit, sealer, {
        ...DEFAULT_RUNTIME_OPTIONS,
        maxHops: config.maxHops,
        maxBotCalls: config.maxBotCalls,
        concurrency: config.concurrency,
        turnTimeoutMs: config.turnTimeoutMs,
        approvalTimeoutMs: config.approvalTimeoutMs,
        computersDir: config.computersDir,
        uploadsDir: config.uploadsDir,
    });
    runtime.start();

    const auth = new WebAuth({
        authenticator: overrides.authenticator ?? new GitHubAuthenticator(config.githubApiUrl),
        repo,
        sealer,
        oauth: config.oauth,
        devLogin: config.devLogin,
        secureCookies: overrides.secureCookies ?? Boolean(config.publicUrl?.startsWith("https://")),
        onSignIn: (user) => runtime.rememberUser(user),
    });
    const server = createAppServer({ runtime, auth, sealer, admins: config.admins, webDir: config.webDir, auditDir: config.auditDir, publicUrl: config.publicUrl });

    return {
        server,
        runtime,
        shutdown: async () => {
            await new Promise<void>((r) => server.close(() => r()));
            await runtime.stop();
            await engine.stop();
            if (sink instanceof JsonlAuditSink) await sink.flush();
            db.close();
        },
    };
}

function* connectorEnvSecrets(catalog: Catalog): Generator<string> {
    const ref = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
    for (const c of catalog.connectors.values()) {
        for (const m of JSON.stringify(c).matchAll(ref)) {
            const v = process.env[m[1]!];
            if (v) yield v;
        }
    }
}
