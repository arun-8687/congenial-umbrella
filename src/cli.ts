#!/usr/bin/env node
import { buildApp } from "./app.js";
import { Catalog, CatalogError } from "./catalog/catalog.js";
import { loadConfig } from "./config.js";

const USAGE = `Usage: copilot-bots <command>

  serve               Start the web app and API
  validate [dir]      Validate a workspace (bots, connectors, skills)
`;

async function main(argv: string[]): Promise<number> {
    const [command, arg] = argv;
    switch (command) {
        case "serve":
            return serve();
        case "validate":
            return validate(arg ?? loadConfig().workspaceDir);
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
