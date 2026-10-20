/**
 * Smoke test against the real Copilot runtime.
 *
 *   npm run smoke                     starts the bundled runtime and pings it
 *   GITHUB_TOKEN=... npm run smoke    also runs one real turn (and one bot-to-bot hop) as that user
 *
 * The token's user needs a Copilot seat; a user without one must be rejected by GitHub.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import { Auditor, MemoryAuditSink } from "../src/audit.js";
import { Catalog } from "../src/catalog/catalog.js";
import { Platform } from "../src/conversations/service.js";
import { MemoryConversationStore } from "../src/conversations/store.js";
import { CopilotEngine } from "../src/engine/copilot.js";
import { GitHubAuthenticator } from "../src/identity.js";

const home = await mkdtemp(path.join(tmpdir(), "copilot-smoke-"));
const client = new CopilotClient({ mode: "empty", useLoggedInUser: false, baseDirectory: home, logLevel: "error" });
await client.start();
console.log("runtime started; ping:", (await client.ping("smoke")).message);

const token = process.env.GITHUB_TOKEN;
if (!token) {
    console.log("GITHUB_TOKEN not set; skipping the live turn.");
    await client.stop();
    process.exit(0);
}

const user = await new GitHubAuthenticator(process.env.GITHUB_API_URL).authenticate(token);
if (!user) throw new Error("GitHub rejected GITHUB_TOKEN");

const catalog = await Catalog.load(path.join(import.meta.dirname, "..", "workspace"));
const sink = new MemoryAuditSink();
const audit = new Auditor(sink);
audit.trackSecret(token);
const engine = new CopilotEngine({ client, defaultModel: process.env.DEFAULT_MODEL });
const platform = new Platform(catalog, engine, new MemoryConversationStore(), audit, { maxHops: 2, maxCallsPerRequest: 3 });

const conversation = await platform.createConversation(user, "concierge");
const { reply } = await platform.send(
    user,
    conversation.id,
    "Ask the researcher bot what the latest stable Node.js LTS major version is, then tell me in one sentence.",
    (e) => e.type === "tool.start" && console.log(`  [${e.botId}] ${e.tool}`),
);
console.log("\nreply:", reply);
console.log("\naudit:", sink.records.map((r) => r.event.type).join(", "));
await client.stop();
