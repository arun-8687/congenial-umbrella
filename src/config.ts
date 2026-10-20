import path from "node:path";
import { z } from "zod";

const Env = z.object({
    PORT: z.coerce.number().int().positive().default(8080),
    HOST: z.string().default("127.0.0.1"),
    WORKSPACE_DIR: z.string().default("./workspace"),
    STATE_DIR: z.string().default("./state"),
    ADMINS: z.string().default(""),
    ORG_NAME: z.string().optional(),
    DEFAULT_MODEL: z.string().optional(),
    MAX_HOPS: z.coerce.number().int().min(0).default(3),
    MAX_BOT_CALLS: z.coerce.number().int().min(0).default(8),
    TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
    GITHUB_API_URL: z.string().url().default("https://api.github.com"),
    COPILOT_LOG_LEVEL: z.enum(["none", "error", "warning", "info", "debug", "all"]).default("warning"),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
    const e = Env.parse(env);
    const stateDir = path.resolve(e.STATE_DIR);
    return {
        port: e.PORT,
        host: e.HOST,
        workspaceDir: path.resolve(e.WORKSPACE_DIR),
        stateDir,
        conversationsDir: path.join(stateDir, "conversations"),
        auditDir: path.join(stateDir, "audit"),
        copilotHome: path.join(stateDir, "copilot"),
        admins: e.ADMINS.split(",").map((s) => s.trim()).filter(Boolean),
        orgName: e.ORG_NAME,
        defaultModel: e.DEFAULT_MODEL,
        maxHops: e.MAX_HOPS,
        maxBotCalls: e.MAX_BOT_CALLS,
        turnTimeoutMs: e.TURN_TIMEOUT_MS,
        githubApiUrl: e.GITHUB_API_URL,
        copilotLogLevel: e.COPILOT_LOG_LEVEL,
    };
}
