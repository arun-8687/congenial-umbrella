#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Auditor, JsonlAuditSink } from "./audit.js";
import { Catalog, CatalogError } from "./catalog/catalog.js";
import { loadConfig, type Config } from "./config.js";
import { Platform } from "./conversations/service.js";
import { FileConversationStore } from "./conversations/store.js";
import { CopilotEngine } from "./engine/copilot.js";
import { createApiServer } from "./http/server.js";
import { GitHubAuthenticator } from "./identity.js";

const USAGE = `Usage: copilot-bots <command>

  serve               Start the HTTP API
  validate [dir]      Validate a workspace (bots, connectors, skills)
  chat <bot-id>       Chat with a bot in the terminal as yourself
                      (token from GITHUB_TOKEN, or \`gh auth token\`)
`;

async function main(argv: string[]): Promise<number> {
    const [command, arg] = argv;
    const config = loadConfig();
    switch (command) {
        case "serve":
            return serve(config);
        case "validate":
            return validate(arg ?? config.workspaceDir);
        case "chat":
            if (!arg) break;
            return chat(config, arg);
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

async function boot(config: Config) {
    const catalog = await Catalog.load(config.workspaceDir);
    const sink = new JsonlAuditSink(config.auditDir);
    const audit = new Auditor(sink);
    for (const value of connectorEnvSecrets(catalog)) audit.trackSecret(value);

    const engine = new CopilotEngine({
        baseDirectory: config.copilotHome,
        defaultModel: config.defaultModel,
        orgName: config.orgName,
        logLevel: config.copilotLogLevel,
    });
    await engine.start();
    const platform = new Platform(catalog, engine, new FileConversationStore(config.conversationsDir), audit, {
        maxHops: config.maxHops,
        maxCallsPerRequest: config.maxBotCalls,
        turnTimeoutMs: config.turnTimeoutMs,
        timeoutMs: config.turnTimeoutMs,
    });
    const shutdown = async () => {
        await engine.stop();
        await sink.flush();
    };
    return { platform, shutdown };
}

async function serve(config: Config): Promise<number> {
    const { platform, shutdown } = await boot(config);
    const server = createApiServer({
        platform,
        auth: new GitHubAuthenticator(config.githubApiUrl),
        admins: config.admins,
    });
    server.listen(config.port, config.host, () => {
        console.log(`copilot-bots listening on http://${config.host}:${config.port} (${platform.catalog.bots.size} bots)`);
    });
    await new Promise<void>((resolve) => {
        const stop = () => server.close(() => resolve());
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });
    await shutdown();
    return 0;
}

async function chat(config: Config, botId: string): Promise<number> {
    const token = process.env.GITHUB_TOKEN ?? ghToken();
    if (!token) {
        console.error("Set GITHUB_TOKEN or log in with `gh auth login`.");
        return 1;
    }
    const user = await new GitHubAuthenticator(config.githubApiUrl).authenticate(token);
    if (!user) {
        console.error("GitHub rejected the token.");
        return 1;
    }
    const { platform, shutdown } = await boot(config);
    platform.audit.trackSecret(token);
    try {
        const conversation = await platform.createConversation(user, botId);
        console.log(`${conversation.title} (as @${user.login}). Ctrl+D to exit.`);
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        for (;;) {
            let line: string;
            try {
                line = await rl.question("\nyou> ");
            } catch {
                break;
            }
            if (!line.trim()) continue;
            process.stdout.write("\nbot> ");
            await platform.send(user, conversation.id, line, (e) => {
                if (e.type === "delta" && e.depth === 0) process.stdout.write(e.text);
                else if (e.type === "tool.start") process.stdout.write(`\n  [${e.botId}] ${e.tool}…\n`);
            });
            process.stdout.write("\n");
        }
        rl.close();
    } finally {
        await shutdown();
    }
    return 0;
}

function ghToken(): string | undefined {
    try {
        return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim() || undefined;
    } catch {
        return undefined;
    }
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

main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
    },
);
