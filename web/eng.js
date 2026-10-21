// Engineering integrations: routine webhooks and delivery, API tokens, usage.
import { h, clear, icon, iconButton, get, post, put, del, timeAgo, toast, errorText, modal, confirmDialog, switchInput } from "./lib.js";
import { botName } from "./app.js";

const copyButton = (text, label = "Copy") =>
    h("button.btn.sm", { type: "button", onClick: async () => { try { await navigator.clipboard.writeText(typeof text === "function" ? text() : text); toast("Copied"); } catch { toast("Copy failed", "Select the text and copy it manually.", { error: true }); } } }, icon("copy"), label);

const readonlyField = (value) => h("input.input.mono", { value, readOnly: true, onFocus: (e) => e.target.select() });

/** Shown once, right after a secret or token is created. */
function secretBox(title, value, note) {
    return h("div.secret-box", h("div.small", h("strong", title), " · ", note), h("div.secret-row", readonlyField(value), copyButton(value)));
}

// ====================================================================== routine webhook + delivery
const EVENT_PRESETS = [
    ["PR opened", "pull_request.opened"],
    ["PR ready / updated", "pull_request.ready_for_review\npull_request.synchronize"],
    ["Review requested", "pull_request.review_requested"],
    ["CI failed", "workflow_run.completed?workflow_run.conclusion=failure|timed_out"],
    ["Issue labeled bug", "issues.labeled?label.name=bug"],
    ["Push to main", "push?ref=refs/heads/main"],
    ["Release published", "release.published"],
];

export function openRoutineIntegrations(routine, after) {
    let r = routine;
    let secret = null;
    const body = h("div.form");
    const m = modal(`Triggers & delivery · ${r.name}`, body, [h("button.btn.primary", { type: "button", onClick: () => m.close() }, "Done")], { wide: true, onClose: () => void after() });

    const draw = () => {
        const events = h("textarea.input.mono", { rows: 4, value: r.hookEvents.join("\n"), placeholder: "One per line, e.g. pull_request.opened — blank accepts every event" });
        const type = h("select.input", ["slack", "teams", "webhook"].map((t) => h("option", { value: t, selected: r.delivery?.type === t }, { slack: "Slack incoming webhook", teams: "Microsoft Teams workflow", webhook: "Any JSON endpoint" }[t])));
        const url = h("input.input", { placeholder: r.delivery ? `Saved for ${r.delivery.label} · paste a new URL to replace it` : "https://hooks.slack.com/services/…", type: "url" });
        clear(
            body,
            h("h3", icon("webhook"), " Start from a webhook"),
            h("p.small.muted", "GitHub, CI or alerting can start this routine. The event's payload reaches the bot as data; approvals still apply to anything it does."),
            h("div.list-row", h("span.grow", r.hookUrl ? "Webhook is on" : "Webhook is off"), switchInput(Boolean(r.hookUrl), async (on) => {
                try {
                    if (on) {
                        const res = await post(`/api/routines/${r.id}/hook`);
                        secret = res.secret;
                        r = { ...r, hookUrl: res.url };
                    } else {
                        await del(`/api/routines/${r.id}/hook`);
                        secret = null;
                        r = { ...r, hookUrl: null };
                    }
                    draw();
                } catch (err) { toast("Could not change the webhook", errorText(err), { error: true }); }
            }, "Webhook")),
            r.hookUrl
                ? [
                      h("label.field", "Payload URL", h("div.secret-row", readonlyField(r.hookUrl), copyButton(r.hookUrl))),
                      secret
                          ? secretBox("Secret", secret, "copy it now; it won't be shown again")
                          : h("div.small.muted", "The secret was shown when the webhook was turned on. ", h("button.linklike", { type: "button", onClick: async () => {
                                if (!(await confirmDialog("Rotate the secret?", "Senders using the old secret stop working until you update them.", "Rotate"))) return;
                                const res = await post(`/api/routines/${r.id}/hook`);
                                secret = res.secret;
                                r = { ...r, hookUrl: res.url };
                                draw();
                            } }, "Rotate secret")),
                      h("details.help-block", h("summary", "How to connect GitHub, CI and other senders"),
                          h("ul.small",
                              h("li", "GitHub: repository or org ", h("em", "Settings → Webhooks → Add webhook"), ". Payload URL above, content type ", h("code", "application/json"), ", the secret above, then pick the events."),
                              h("li", "Senders that can't sign requests: send the secret as ", h("code", "Authorization: Bearer <secret>"), " and name the event with an ", h("code", "X-Event-Type"), " header."),
                              h("li", "Redeliveries with the same delivery id run once. GitHub's ping event is answered without running the routine."),
                          ),
                      ),
                      h("label.field", "Events", h("span.help", "Leave blank for every event. ", h("code", "name.action"), ", ", h("code", "name.*"), ", and payload conditions like ", h("code", "?workflow_run.conclusion=failure|timed_out"), "."), events),
                      h("div.chips", { style: { justifyContent: "flex-start" } }, EVENT_PRESETS.map(([label, value]) => h("button.chip", { type: "button", onClick: () => { events.value = [...new Set([...events.value.split("\n").filter(Boolean), ...value.split("\n")])].join("\n"); } }, label))),
                      h("div", h("button.btn.sm", { type: "button", onClick: async () => {
                          try {
                              const saved = await put(`/api/routines/${r.id}/hook/events`, { events: events.value.split("\n").map((x) => x.trim()).filter(Boolean) });
                              r = { ...r, ...saved };
                              toast("Event filters saved");
                          } catch (err) { toast("Could not save filters", errorText(err), { error: true }); }
                      } }, "Save filters")),
                  ]
                : null,
            h("h3", { style: { marginTop: "18px" } }, icon("send"), " Post results"),
            h("p.small.muted", "After each run, post the bot's result (or the failure) to a channel. The URL is stored encrypted; bot output can't mention @channel or @here."),
            h("div.row", h("label.field", "Destination", type), h("label.field", "Webhook URL", url)),
            h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
                h("button.btn.sm", { type: "button", onClick: async () => {
                    if (!url.value.trim()) return toast("Paste the webhook URL first", "", { error: true });
                    try {
                        r = { ...r, ...(await put(`/api/routines/${r.id}/delivery`, { type: type.value, url: url.value.trim() })) };
                        toast("Delivery saved", r.delivery.label);
                        draw();
                    } catch (err) { toast("Could not save delivery", errorText(err), { error: true }); }
                } }, "Save"),
                r.delivery ? h("button.btn.sm.ghost", { type: "button", onClick: async () => { r = { ...r, ...(await del(`/api/routines/${r.id}/delivery`)) }; draw(); } }, "Stop posting") : null,
                h("span.small.muted", r.delivery ? `Posting to ${r.delivery.label}` : "Not posting anywhere"),
            ),
        );
    };
    draw();
}

/** Small badges for a routine card: trigger and delivery at a glance. */
export function routineBadges(r) {
    return [
        r.hookUrl ? h("span.tag", { title: r.hookEvents.length ? r.hookEvents.join(", ") : "every event" }, icon("webhook"), r.hookEvents.length ? `Webhook · ${r.hookEvents.length} event filter${r.hookEvents.length === 1 ? "" : "s"}` : "Webhook") : null,
        r.delivery ? h("span.tag", icon("send"), `→ ${r.delivery.type === "webhook" ? r.delivery.label : `${r.delivery.type[0].toUpperCase()}${r.delivery.type.slice(1)}`}`) : null,
    ];
}

// ====================================================================== API tokens
/** `shown` is a token created just now, displayed once; `redraw(shown)` re-renders the page. */
export async function apiTokensSection(redraw, shown = null) {
    const { tokens } = await get("/api/tokens");
    const name = h("input.input", { placeholder: "e.g. CI on api-gateway" });
    const scopes = { ask: true, read: false, write: false };
    const expiry = h("select.input", [["30", "30 days"], ["90", "90 days", true], ["365", "1 year"], ["", "No expiry"]].map(([v, l, sel]) => h("option", { value: v, selected: Boolean(sel) }, l)));
    const created = shown
        ? h("div", secretBox("New token", shown, "copy it now; it won't be shown again"), h("pre.pre.mono.small", `export COPILOT_BOTS_URL=${location.origin}\nexport COPILOT_BOTS_TOKEN=<the token above>\ngit diff origin/main | npx copilot-bots ask reviewer "Review this diff"`))
        : null;
    const scopeHelp = { ask: "ask bots and run routines, read the results", read: "read everything you can see", write: "post messages, create tasks and routines" };
    return [
        h("h3", { style: { marginTop: "28px" } }, "API tokens"),
        h("p.lede", "For scripts and CI: tokens act as you, within their scopes, and stop working if your GitHub sign-in does. They can't manage tokens, your account or admin settings."),
        h("div.card.form",
            h("div.row", h("label.field", "Name", name), h("label.field", "Expires", expiry)),
            h("div.field", h("div.small.muted", "Scopes"), h("div.scope-list", Object.keys(scopes).map((k) => h("label.check", h("input", { type: "checkbox", checked: scopes[k], onChange: (e) => (scopes[k] = e.target.checked) }), h("strong", k), h("span.small.muted", ` ${scopeHelp[k]}`))))),
            h("div", h("button.btn.primary.sm", { type: "button", onClick: async () => {
                try {
                    const t = await post("/api/tokens", { name: name.value.trim() || "token", scopes: Object.keys(scopes).filter((k) => scopes[k]), expiresInDays: expiry.value ? Number(expiry.value) : null });
                    await redraw(t.token);
                } catch (err) { toast("Could not create token", errorText(err), { error: true }); }
            } }, icon("key"), "Create token")),
            created,
        ),
        tokens.length
            ? h("div.card", tokens.map((t) => h("div.list-row",
                  icon("key"),
                  h("span.grow", h("strong", t.name), " ", t.scopes.map((s) => h("span.tag", s))),
                  h("span.small.muted", `${t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}` : "never used"} · ${t.expiresAt ? (new Date(t.expiresAt) < new Date() ? "expired" : `expires ${new Date(t.expiresAt).toLocaleDateString()}`) : "no expiry"}`),
                  iconButton("trash", "Revoke", async () => { if (await confirmDialog("Revoke token?", `“${t.name}” stops working immediately.`, "Revoke", true)) { await del(`/api/tokens/${t.id}`); await redraw(); } }),
              )))
            : null,
    ];
}

// ====================================================================== usage
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n * 100) / 100));

/** Fills missing days so the time axis is honest. */
function fillDays(rows, since) {
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const out = [];
    for (let d = new Date(`${since}T00:00:00Z`); d <= new Date(); d = new Date(d.getTime() + 86400_000)) {
        const key = d.toISOString().slice(0, 10);
        out.push(byKey.get(key) ?? { key, turns: 0, premiumRequests: 0, inputTokens: 0, outputTokens: 0, calls: 0, toolCalls: 0, failed: 0 });
    }
    return out;
}

/** A single-series column chart with a hover tooltip per day; the table below carries exact values. */
export function dayChart(rows, since, metric, label) {
    const days = fillDays(rows, since);
    const value = (r) => (metric === "tokens" ? r.inputTokens + r.outputTokens : r[metric]);
    const max = Math.max(1, ...days.map(value));
    const nice = niceMax(max);
    const tip = h("div.chart-tip", { hidden: true });
    const plot = h("div.chart-plot",
        [nice, nice / 2, 0].map((v, i) => h("div.chart-grid", { style: { bottom: `${(i === 0 ? 1 : i === 1 ? 0.5 : 0) * 100}%` } }, h("span", fmt(v)))),
        h("div.chart-cols", days.map((d) => {
            const v = value(d);
            const col = h("div.chart-col", {
                tabIndex: 0,
                "aria-label": `${d.key}: ${fmt(v)} ${label}`,
                onMouseenter: () => showTip(col, d, v),
                onFocus: () => showTip(col, d, v),
                onMouseleave: () => (tip.hidden = true),
                onBlur: () => (tip.hidden = true),
            }, h("div.chart-bar", { style: { height: `${(v / nice) * 100}%` }, class: v ? "" : "zero" }));
            return col;
        })),
        tip,
    );
    const showTip = (col, d, v) => {
        clear(tip, h("strong", new Date(`${d.key}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })), h("div", `${fmt(v)} ${label}`), h("div.muted", `${d.turns} turns${d.failed ? ` · ${d.failed} failed` : ""}`));
        tip.hidden = false;
        const p = plot.getBoundingClientRect();
        const c = col.getBoundingClientRect();
        tip.style.left = `${Math.min(Math.max(c.left - p.left + c.width / 2, 60), p.width - 60)}px`;
    };
    const first = days[0]?.key;
    const last = days.at(-1)?.key;
    return h("div.chart", plot, h("div.chart-axis", h("span", short(first)), h("span", short(last))));
}

function niceMax(v) {
    const p = 10 ** Math.floor(Math.log10(v));
    return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v) ?? v;
}
const short = (key) => (key ? new Date(`${key}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) : "");

function tile(label, value, sub) {
    return h("div.stat", h("div.stat-label", label), h("div.stat-value", value), sub ? h("div.stat-sub", sub) : null);
}

function totals(rows) {
    return rows.reduce((a, r) => ({ turns: a.turns + r.turns, premiumRequests: a.premiumRequests + r.premiumRequests, tokens: a.tokens + r.inputTokens + r.outputTokens, failed: a.failed + r.failed, toolCalls: a.toolCalls + r.toolCalls }), { turns: 0, premiumRequests: 0, tokens: 0, failed: 0, toolCalls: 0 });
}

function usageTable(title, rows, name = (k) => k) {
    if (!rows.length) return null;
    return h("div.card",
        h("h3", { style: { marginBottom: "8px" } }, title),
        h("table.data",
            h("thead", h("tr", h("th", ""), h("th.num", "Turns"), h("th.num", "Premium req."), h("th.num", "Tokens"), h("th.num", "Tool calls"), h("th.num", "Failed"))),
            h("tbody", rows.map((r) => h("tr", h("td", name(r.key)), h("td.num", fmt(r.turns)), h("td.num", fmt(r.premiumRequests)), h("td.num", fmt(r.inputTokens + r.outputTokens)), h("td.num", fmt(r.toolCalls)), h("td.num", r.failed ? fmt(r.failed) : "—")))),
        ),
    );
}

const meter = (used, limit, label) =>
    limit
        ? h("div.meter", { role: "meter", "aria-valuemin": 0, "aria-valuemax": limit, "aria-valuenow": used, "aria-label": label }, h("div.meter-fill", { style: { width: `${Math.min(100, (used / limit) * 100)}%` }, class: used >= limit ? "full" : "" }))
        : null;

/** The signed-in person's own usage, for Settings. */
export async function myUsageSection() {
    const u = await get("/api/usage?days=30");
    const t = totals(u.byDay);
    const tokensToday = u.used.inputTokens + u.used.outputTokens;
    return [
        h("h3", { style: { marginTop: "28px" } }, "Usage"),
        h("p.lede", "What your bots used. Premium requests are Copilot's billing unit; limits reset at 00:00 UTC."),
        h("div.stats",
            tile("Premium requests today", fmt(u.used.premiumRequests), u.limits.premiumRequests ? `of ${fmt(u.limits.premiumRequests)}` : "no daily limit"),
            tile("Tokens today", fmt(tokensToday), u.limits.tokens ? `of ${fmt(u.limits.tokens)}` : "no daily limit"),
            tile("Turns, 30 days", fmt(t.turns), `${fmt(t.premiumRequests)} premium requests`),
        ),
        meter(u.used.premiumRequests, u.limits.premiumRequests, "Premium requests used today"),
        meter(tokensToday, u.limits.tokens, "Tokens used today"),
        h("div.card", h("h3", "Premium requests per day"), dayChart(u.byDay, u.since, "premiumRequests", "premium requests")),
        usageTable("By bot, 30 days", u.byBot, botName),
    ];
}

/** Org-wide usage for admins. */
export async function adminUsage(root, days, setDays) {
    const u = await get(`/api/admin/usage?days=${days}`);
    const t = totals(u.byDay);
    const [metric, metricLabel] = t.premiumRequests > 0 ? ["premiumRequests", "premium requests"] : ["tokens", "tokens"];
    clear(
        root,
        h("div.toolbar", h("div.seg", [7, 30, 90].map((d) => h("button", { type: "button", class: d === days ? "on" : "", onClick: () => setDays(d) }, `${d} days`))),
            h("span.grow"),
            h("span.small.muted", `Daily limits per person: ${u.limits.premiumRequests ? `${u.limits.premiumRequests} premium requests` : "no premium-request limit"}, ${u.limits.tokens ? `${fmt(u.limits.tokens)} tokens` : "no token limit"}`)),
        h("div.stats",
            tile("Premium requests", fmt(t.premiumRequests)),
            tile("Tokens", fmt(t.tokens)),
            tile("Turns", fmt(t.turns), `${fmt(t.toolCalls)} tool calls`),
            tile("Active people", String(u.byUser.length)),
            tile("Failed turns", fmt(t.failed), t.turns ? `${((t.failed / t.turns) * 100).toFixed(1)}%` : undefined),
        ),
        h("div.card", h("h3", `${metricLabel[0].toUpperCase()}${metricLabel.slice(1)} per day`), dayChart(u.byDay, u.since, metric, metricLabel)),
        h("div.grid-2",
            usageTable("By person", u.byUser, (k) => (k.startsWith("(") ? k : `@${k}`)),
            usageTable("By bot", u.byBot, botName),
            usageTable("By model", u.byModel),
            usageTable("By source", u.bySource, (k) => ({ chat: "Chat", task: "Tasks", routine: "Routines", api: "API / CI", bot: "Bot-to-bot", eval: "Evals" })[k] ?? k),
        ),
        u.byDay.length ? null : h("div.empty", "No usage recorded in this period."),
    );
}

