/**
 * Smoke test against the real Copilot runtime.
 *
 *   npm run smoke                     boots the bundled runtime and pings it
 *   GITHUB_TOKEN=... npm run smoke    also runs a real DM turn and a real bot-to-bot hand-off as that user
 *
 * The token's user needs a Copilot seat; a user without one must be rejected by GitHub, not by us.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import { Auditor, MemoryAuditSink } from "../src/audit.js";
import { Catalog } from "../src/catalog/catalog.js";
import { Sealer } from "../src/crypto.js";
import { CopilotEngine } from "../src/engine/copilot.js";
import { GitHubAuthenticator } from "../src/identity.js";
import { Directory } from "../src/runtime/directory.js";
import { Hub } from "../src/runtime/events.js";
import { Repo } from "../src/runtime/repo.js";
import { DEFAULT_RUNTIME_OPTIONS, Runtime } from "../src/runtime/runtime.js";
import { Db } from "../src/store/db.js";

const state = await mkdtemp(path.join(tmpdir(), "copilot-smoke-"));
const client = new CopilotClient({ mode: "empty", useLoggedInUser: false, baseDirectory: path.join(state, "copilot"), logLevel: "error" });
await client.start();
console.log("runtime started; ping:", (await client.ping("smoke")).message);

const token = process.env.GITHUB_TOKEN;
const user = token ? await new GitHubAuthenticator(process.env.GITHUB_API_URL).authenticate(token) : null;
if (!user) {
    console.log(token ? "GitHub rejected GITHUB_TOKEN; skipping live turns." : "GITHUB_TOKEN not set; skipping live turns.");
    await client.stop();
    process.exit(0);
}

const catalog = await Catalog.load(path.join(import.meta.dirname, "..", "workspace"));
const repo = new Repo(new Db(":memory:"));
const sink = new MemoryAuditSink();
const hub = new Hub();
hub.subscribe(user.login, (e) => {
    if (e.type === "message.tool" && e.phase === "start") console.log(`  [${e.botId}] ${e.tool} ${e.detail ?? ""}`);
});
const runtime = new Runtime(repo, new Directory(catalog, repo), new CopilotEngine({ client, defaultModel: process.env.DEFAULT_MODEL }), hub, new Auditor(sink), new Sealer(Buffer.alloc(32, 1)), {
    ...DEFAULT_RUNTIME_OPTIONS,
    computersDir: path.join(state, "computers"),
    uploadsDir: path.join(state, "uploads"),
});
runtime.rememberUser(user);
runtime.start();

const t = runtime.directThread(user, "concierge");
runtime.postUserMessage(user, t.id, "Ask the researcher bot what the current Node.js LTS major version is, then answer me in one sentence.");
await runtime.idle(5 * 60_000);
for (const m of repo.messages(t.id)) console.log(`\n${m.authorType}:${m.authorId}> ${m.text}`);
console.log("\naudit:", [...new Set(sink.records.map((r) => r.event.type))].join(", "));
await runtime.stop();
await client.stop();
