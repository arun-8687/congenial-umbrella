import path from "node:path";
import { z } from "zod";

const flag = z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true");

const Env = z.object({
    PORT: z.coerce.number().int().positive().default(8080),
    HOST: z.string().default("127.0.0.1"),
    PUBLIC_URL: z.string().url().optional(),
    WORKSPACE_DIR: z.string().default("./workspace"),
    STATE_DIR: z.string().default("./state"),
    WEB_DIR: z.string().optional(),
    ADMINS: z.string().default(""),
    ORG_NAME: z.string().optional(),
    DEFAULT_MODEL: z.string().optional(),
    ENGINE: z.enum(["copilot", "demo"]).default("copilot"),
    MAX_HOPS: z.coerce.number().int().min(0).default(3),
    MAX_BOT_CALLS: z.coerce.number().int().min(0).default(12),
    CONCURRENCY: z.coerce.number().int().min(1).default(4),
    MAX_PER_USER: z.coerce.number().int().min(1).default(2),
    COMPUTER_ACCESS: z.enum(["off", "files", "shell"]).default("off"),
    ALLOW_PRIVATE_NETWORK: flag,
    COMPUTER_SHELL_ISOLATED: flag,
    SECRET_KEY_PREVIOUS: z.string().optional(),
    SHARE_TTL_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
    MAX_STORAGE_MB: z.coerce.number().int().min(1).default(1024),
    TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
    APPROVAL_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
    GITHUB_API_URL: z.string().url().default("https://api.github.com"),
    GITHUB_WEB_URL: z.string().url().default("https://github.com"),
    GITHUB_OAUTH_CLIENT_ID: z.string().optional(),
    GITHUB_OAUTH_CLIENT_SECRET: z.string().optional(),
    GITHUB_OAUTH_SCOPE: z.string().default("read:user read:org"),
    SECRET_KEY: z.string().optional(),
    DEV_LOGIN: flag,
    COPILOT_LOG_LEVEL: z.enum(["none", "error", "warning", "info", "debug", "all"]).default("warning"),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
    const e = Env.parse(env);
    const stateDir = path.resolve(e.STATE_DIR);
    if (e.DEV_LOGIN && e.ENGINE === "copilot") {
        throw new Error("DEV_LOGIN is only allowed with ENGINE=demo: dev users have no GitHub token for Copilot.");
    }
    if (e.DEV_LOGIN && !["127.0.0.1", "localhost", "::1"].includes(e.HOST)) {
        throw new Error("DEV_LOGIN lets anyone sign in as anyone; it only binds to localhost (HOST=127.0.0.1).");
    }
    if (e.COMPUTER_ACCESS === "shell" && e.ENGINE === "copilot" && !e.COMPUTER_SHELL_ISOLATED) {
        throw new Error(
            "COMPUTER_ACCESS=shell runs bot commands as the platform's own OS user, which can read its database and keys. " +
                "Only enable it when the Copilot runtime is isolated per user (separate container or sandbox), then set COMPUTER_SHELL_ISOLATED=1.",
        );
    }
    if (e.GITHUB_OAUTH_CLIENT_ID && !e.PUBLIC_URL) {
        throw new Error("GitHub OAuth needs PUBLIC_URL, so the callback URL never comes from a request's Host header.");
    }
    return {
        port: e.PORT,
        host: e.HOST,
        publicUrl: e.PUBLIC_URL,
        workspaceDir: path.resolve(e.WORKSPACE_DIR),
        stateDir,
        webDir: path.resolve(e.WEB_DIR ?? path.join(import.meta.dirname, "..", "web")),
        dbFile: path.join(stateDir, "platform.db"),
        auditDir: path.join(stateDir, "audit"),
        copilotHome: path.join(stateDir, "copilot"),
        computersDir: path.join(stateDir, "computers"),
        uploadsDir: path.join(stateDir, "uploads"),
        admins: e.ADMINS.split(",").map((s) => s.trim()).filter(Boolean),
        orgName: e.ORG_NAME,
        defaultModel: e.DEFAULT_MODEL,
        engine: e.ENGINE,
        maxHops: e.MAX_HOPS,
        maxBotCalls: e.MAX_BOT_CALLS,
        concurrency: e.CONCURRENCY,
        maxPerUser: e.MAX_PER_USER,
        computerAccess: e.COMPUTER_ACCESS,
        allowPrivateNetwork: e.ALLOW_PRIVATE_NETWORK,
        turnTimeoutMs: e.TURN_TIMEOUT_MS,
        approvalTimeoutMs: e.APPROVAL_TIMEOUT_MS,
        githubApiUrl: e.GITHUB_API_URL,
        oauth:
            e.GITHUB_OAUTH_CLIENT_ID && e.GITHUB_OAUTH_CLIENT_SECRET
                ? { clientId: e.GITHUB_OAUTH_CLIENT_ID, clientSecret: e.GITHUB_OAUTH_CLIENT_SECRET, webUrl: e.GITHUB_WEB_URL, scope: e.GITHUB_OAUTH_SCOPE }
                : undefined,
        secretKey: e.SECRET_KEY,
        secretKeyPrevious: e.SECRET_KEY_PREVIOUS,
        shareTtlDays: e.SHARE_TTL_DAYS,
        maxStorageBytes: e.MAX_STORAGE_MB * 1024 * 1024,
        devLogin: e.DEV_LOGIN,
        copilotLogLevel: e.COPILOT_LOG_LEVEL,
    };
}
