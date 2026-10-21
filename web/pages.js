import { h, clear, icon, iconButton, get, post, put, patch, del, api, avatar, markdown, timeAgo, toast, errorText, bytes, modal, confirmDialog, switchInput, ALWAYS_ALLOWABLE } from "./lib.js";
import { S, on, bot, botName, statusOf, navigate, setProfile, topbar, refreshBots } from "./app.js";
import { openNewBot, openEditBot, openNewGroup } from "./modals.js";

const page = (...children) => h("div.page", h("div.page-inner", ...children));

// ====================================================================== Home (team roster)
export async function renderHome(root) {
    const draw = () => {
        const pendingCount = S.approvals.length;
        clear(
            root,
            topbar("Home", `${S.bots.length} bots on your team`, h("button.btn.sm", { type: "button", onClick: () => openNewGroup() }, icon("users"), "New group"), h("button.btn.primary.sm", { type: "button", onClick: () => openNewBot() }, icon("plus"), "New bot")),
            page(
                h("h2", `Good ${greeting()}, @${S.me.login}`),
                h("p.lede", "Message a bot like a teammate. Bots keep working in the background, hand work to each other, and ask before doing anything risky."),
                pendingCount
                    ? h("div.card", { style: { marginBottom: "16px", display: "flex", gap: "10px", alignItems: "center" } }, h("span.badge.warn", String(pendingCount)), h("span.grow", `${pendingCount} approval${pendingCount === 1 ? "" : "s"} waiting for you`), h("button.btn.sm", { type: "button", onClick: () => navigate("#/inbox") }, "Review"))
                    : null,
                h(
                    "div.grid-cards",
                    S.bots.map((b) =>
                        h(
                            "div.card",
                            h("div.card-head", avatar(b, "", statusOf(b.id)), h("div.grow", h("h3", b.name), h("div.meta.ellipsis", b.title ?? (b.scope === "org" ? "Org bot" : "My bot")))),
                            h("p.small", { style: { color: "var(--text-2)", minHeight: "3em" } }, b.description),
                            h(
                                "div.tags",
                                b.scope === "org" ? h("span.tag", "Org") : h("span.tag", "Mine"),
                                b.hidden ? h("span.tag.warn", "Hidden from sidebar") : null,
                                (b.builtinTools ?? []).includes("web_search") ? h("span.tag", "Web") : null,
                                b.computer ? h("span.tag", "Computer") : null,
                                (b.skills ?? []).length ? h("span.tag", `${b.skills.length} skills`) : null,
                                (b.connectors ?? []).length ? h("span.tag", b.connectors.join(", ")) : null,
                            ),
                            h("div", { style: { display: "flex", gap: "8px", marginTop: "12px" } }, h("button.btn.sm.primary", { type: "button", onClick: () => navigate(`#/bot/${b.id}`) }, "Message"), h("button.btn.sm", { type: "button", onClick: () => setProfile(b.id) }, "Profile"), b.hidden ? h("button.btn.sm.ghost", { type: "button", onClick: async () => { await put(`/api/bots/${b.id}/prefs`, { hidden: false }); await refreshBots(); draw(); } }, "Show in sidebar") : null),
                        ),
                    ),
                    h("button.card", { type: "button", onClick: () => openNewBot(), style: { display: "grid", placeItems: "center", minHeight: "180px", color: "var(--muted)", borderStyle: "dashed", cursor: "pointer" } }, h("div", { style: { textAlign: "center" } }, icon("plus", { width: "1.5" }), h("div", "Create a bot"))),
                ),
            ),
        );
    };
    draw();
    return on((e) => (e.type === "bot.status" || e.type === "bots.changed" || e.type.startsWith("approval")) && setTimeout(draw, 50));
}

function greeting() {
    const hr = new Date().getHours();
    return hr < 12 ? "morning" : hr < 18 ? "afternoon" : "evening";
}

// ====================================================================== Inbox
export async function renderInbox(root) {
    const draw = async () => {
        const [{ approvals }, { notifications }] = await Promise.all([get("/api/approvals"), get("/api/notifications")]);
        const pending = approvals.filter((a) => a.status === "pending");
        const decide = async (a, approve, always = false) => {
            try {
                await post(`/api/approvals/${a.id}`, { approve, always });
                void draw();
            } catch (err) {
                toast("Could not record decision", errorText(err), { error: true });
            }
        };
        clear(
            root,
            topbar("Inbox", "Approvals and updates from your bots", notifications.some((n) => !n.read) ? h("button.btn.sm", { type: "button", onClick: async () => { await post("/api/notifications/read", {}); S.notifications.forEach((n) => (n.read = true)); void draw(); } }, "Mark all read") : null),
            page(
                h("h3", "Waiting for approval"),
                pending.length
                    ? pending.map((a) => {
                          const b = bot(a.botId);
                          return h(
                              "div.card.approval.pending",
                              h("div.card-head", avatar(b), h("div.grow", h("h3", `${b?.name ?? a.botId} wants to ${verb(a.kind)}`), h("div.meta", timeAgo(a.createdAt)))),
                              a.detail ? h("pre.pre", { style: { marginTop: "10px", fontFamily: "var(--mono)" } }, a.detail) : null,
                              h(
                                  "div.row",
                                  h("button.btn.primary.sm", { type: "button", onClick: () => decide(a, true) }, "Approve"),
                                  b?.editable && ALWAYS_ALLOWABLE.includes(a.kind) ? h("button.btn.sm", { type: "button", onClick: () => decide(a, true, true) }, `Always allow ${a.kind}`) : null,
                                  h("button.btn.sm.danger", { type: "button", onClick: () => decide(a, false) }, "Deny"),
                                  a.threadId ? h("button.btn.sm.ghost", { type: "button", onClick: () => navigate(`#/t/${a.threadId}`) }, "Open thread") : null,
                              ),
                          );
                      })
                    : h("div.empty", "Nothing needs your approval."),
                h("h3", { style: { marginTop: "28px" } }, "Updates"),
                notifications.length
                    ? h(
                          "div.card",
                          notifications.map((n) =>
                              h(
                                  "div.list-row",
                                  { style: { cursor: n.threadId ? "pointer" : "default", opacity: n.read ? 0.7 : 1 }, onClick: () => n.threadId && navigate(`#/t/${n.threadId}`) },
                                  h("span", { style: { width: "8px", height: "8px", borderRadius: "50%", background: n.read ? "transparent" : "var(--link)", flex: "none" } }),
                                  h("div.grow", h("div", { style: { fontWeight: 560 } }, n.title), n.body ? h("div.small.muted.ellipsis", n.body) : null),
                                  h("span.small.muted", timeAgo(n.createdAt)),
                              ),
                          ),
                      )
                    : h("div.empty", "No updates yet."),
                h("div.small.muted", { style: { marginTop: "16px" } }, "Approvals decided elsewhere or expired are kept in the audit log."),
                "Notification" in window && Notification.permission === "default"
                    ? h("button.btn.sm", { type: "button", style: { marginTop: "12px" }, onClick: () => Notification.requestPermission().then(() => void draw()) }, "Enable desktop notifications")
                    : null,
            ),
        );
    };
    await draw();
    return on((e) => (e.type.startsWith("approval") || e.type === "notification") && void draw());
}

function verb(kind) {
    return { shell: "run a shell command", write: "write a file", read: "read a file", url: "fetch a URL", mcp: "use a connector" }[kind] ?? `perform a ${kind} action`;
}

// ====================================================================== Tasks (board)
export async function renderTasks(root) {
    const draw = async () => {
        const { tasks } = await get("/api/tasks");
        const cols = [
            ["Working", (t) => t.status === "in_progress" || t.status === "open" || t.status === "waiting"],
            ["Done", (t) => t.status === "done"],
            ["Failed", (t) => t.status === "failed"],
            ["Cancelled", (t) => t.status === "cancelled"],
        ];
        clear(
            root,
            topbar("Tasks", "Work handed to bots, by you or by other bots", h("button.btn.primary.sm", { type: "button", onClick: () => newTask(draw) }, icon("plus"), "Assign task")),
            page(
                h(
                    "div.board",
                    cols.map(([label, pred]) => {
                        const items = tasks.filter(pred);
                        return h(
                            "div.column",
                            h("h4", label, h("span.tag", String(items.length))),
                            items.map((t) =>
                                h(
                                    "button.task-card",
                                    { type: "button", onClick: () => navigate(`#/t/${t.threadId}`) },
                                    h("div.t", t.title),
                                    h("div.m", avatar(bot(t.assignee), "sm", statusOf(t.assignee)), botName(t.assignee), h("span", "·"), timeAgo(t.updatedAt)),
                                    h("div.m", "from ", t.createdBy === S.me.login ? "you" : botName(t.createdBy)),
                                ),
                            ),
                        );
                    }),
                ),
            ),
        );
    };
    await draw();
    return on((e) => e.type === "task.updated" && void draw());
}

function newTask(after) {
    const botSel = h("select.input", S.bots.map((b) => h("option", { value: b.id }, `${b.name}${b.title ? ` — ${b.title}` : ""}`)));
    const title = h("input.input", { placeholder: "Draft the Q3 release notes" });
    const details = h("textarea.input", { placeholder: "Goal, inputs, constraints, what to hand back" });
    const m = modal("Assign a task", h("div.form", h("label.field", "Bot", botSel), h("label.field", "Title", title), h("label.field", "Details", details)), [
        h("button.btn.ghost", { type: "button", onClick: () => m.close() }, "Cancel"),
        h("button.btn.primary", { type: "button", onClick: async () => {
            try {
                const t = await post("/api/tasks", { botId: botSel.value, title: title.value, details: details.value });
                m.close();
                toast("Task assigned", `${botName(t.assignee)} is on it.`);
                await after();
            } catch (err) {
                toast("Could not assign", errorText(err), { error: true });
            }
        } }, "Assign"),
    ]);
}

// ====================================================================== Routines
export async function renderRoutines(root) {
    const draw = async () => {
        const { routines } = await get("/api/routines");
        clear(
            root,
            topbar("Routines", "Saved workflows a bot runs on a schedule or on demand", h("button.btn.primary.sm", { type: "button", onClick: () => editRoutine(null, draw) }, icon("plus"), "New routine")),
            page(
                routines.length
                    ? routines.map((r) =>
                          h(
                              "div.card",
                              h(
                                  "div.card-head",
                                  avatar(bot(r.botId)),
                                  h("div.grow", h("h3", r.name, r.enabled ? null : h("span.tag.warn", { style: { marginLeft: "8px" } }, "Off · review and switch on")), h("div.meta", `${botName(r.botId)} · ${r.schedule ? describeCron(r.schedule) + (r.timezone ? ` (${r.timezone})` : "") : "On demand"}${r.nextRunAt && r.enabled ? ` · next ${new Date(r.nextRunAt).toLocaleString()}` : ""}`)),
                                  switchInput(r.enabled, async (v) => { await patch(`/api/routines/${r.id}`, { enabled: v }); void draw(); }, "Enabled"),
                                  h("button.btn.sm", { type: "button", onClick: async () => { await post(`/api/routines/${r.id}/run`); toast("Routine started", r.name); void draw(); } }, icon("play"), "Run now"),
                                  iconButton("edit", "Edit", () => editRoutine(r, draw)),
                                  iconButton("trash", "Delete", async () => { if (await confirmDialog("Delete routine?", r.name, "Delete", true)) { await del(`/api/routines/${r.id}`); void draw(); } }),
                              ),
                              h("p.small.muted", { style: { margin: "8px 0" } }, r.prompt.slice(0, 220)),
                              r.runs.length
                                  ? h(
                                        "div",
                                        r.runs.map((run) =>
                                            h(
                                                "div.list-row.small",
                                                h("span.tag", { class: run.status === "done" ? "ok" : run.status === "failed" ? "danger" : "warn" }, run.status),
                                                h("span.grow.ellipsis.muted", run.output?.slice(0, 140) ?? run.error ?? "Running…"),
                                                h("span.muted", `${run.trigger} · ${timeAgo(run.startedAt)}`),
                                            ),
                                        ),
                                        h("button.btn.sm.ghost", { type: "button", onClick: () => navigate(`#/t/${r.threadId}`) }, "Open run history"),
                                    )
                                  : h("div.small.muted", "No runs yet."),
                          ),
                      )
                    : h("div.empty", "No routines yet. Create one here, or ask a bot to “do this every weekday at 9am”."),
            ),
        );
    };
    await draw();
    return on((e) => e.type === "routine.run" && void draw());
}

function editRoutine(r, after) {
    const botSel = h("select.input", { disabled: Boolean(r) }, S.bots.map((b) => h("option", { value: b.id, selected: r?.botId === b.id }, b.name)));
    const name = h("input.input", { value: r?.name ?? "", placeholder: "Morning standup summary" });
    const prompt = h("textarea.input", { value: r?.prompt ?? "", placeholder: "What to do each run, written as instructions to the bot" });
    const presets = [["On demand", ""], ["Weekdays 9:00", "0 9 * * 1-5"], ["Every hour", "0 * * * *"], ["Mondays 8:30", "30 8 * * 1"], ["Daily 18:00", "0 18 * * *"]];
    const schedule = h("input.input", { value: r?.schedule ?? "", placeholder: "cron, e.g. 0 9 * * 1-5 (blank = on demand)" });
    const tz = h("input.input", { value: r?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, placeholder: "Time zone" });
    const m = modal(r ? "Edit routine" : "New routine", h("div.form",
        h("label.field", "Bot", botSel),
        h("label.field", "Name", name),
        h("label.field", "Instructions", prompt),
        h("div.field", h("div.small.muted", "Schedule"), h("div.chips", { style: { justifyContent: "flex-start", marginTop: "4px" } }, presets.map(([l, c]) => h("button.chip", { type: "button", onClick: () => (schedule.value = c) }, l)))),
        h("div.row", h("label.field", "Cron", schedule), h("label.field", "Time zone", tz)),
    ), [
        h("button.btn.ghost", { type: "button", onClick: () => m.close() }, "Cancel"),
        h("button.btn.primary", { type: "button", onClick: async () => {
            const body = { name: name.value, prompt: prompt.value, schedule: schedule.value.trim() || null, timezone: tz.value.trim() || null };
            try {
                if (r) await patch(`/api/routines/${r.id}`, body);
                else await post("/api/routines", { ...body, botId: botSel.value });
                m.close();
                await after();
            } catch (err) {
                toast("Could not save routine", errorText(err), { error: true });
            }
        } }, "Save"),
    ]);
}

function describeCron(c) {
    const known = { "0 9 * * 1-5": "Weekdays at 9:00", "0 * * * *": "Every hour", "30 8 * * 1": "Mondays at 8:30", "0 18 * * *": "Daily at 18:00" };
    return known[c] ?? `cron ${c}`;
}

// ====================================================================== Skills
export async function renderSkills(root) {
    const draw = async () => {
        const { org, mine } = await get("/api/skills");
        clear(
            root,
            topbar("Skills", "Reusable instructions any bot with the skill can follow", h("button.btn.primary.sm", { type: "button", onClick: () => openSkillEditor(null, true, draw) }, icon("plus"), "New skill")),
            page(
                h("p.lede", "Teach a skill by doing the work once in a thread, then use ✨ Teach a skill in the thread header. You review the draft before it goes live."),
                h("h3", "My skills"),
                mine.length
                    ? h("div.grid-cards", mine.map((s) => skillCard(s, true, draw)))
                    : h("div.empty", "No skills yet."),
                h("h3", { style: { marginTop: "28px" } }, "Organization skills"),
                org.length ? h("div.grid-cards", org.map((s) => skillCard(s, false, draw))) : h("div.empty", "Your admins haven't published any."),
            ),
        );
    };
    await draw();
    return () => {};
}

function skillCard(s, editable, after) {
    return h(
        "div.card",
        h("div.card-head", h("div.grow", h("h3", s.name), h("div.meta", editable ? (s.status === "draft" ? "Draft" : "Published") : "Org"))),
        h("p.small", { style: { color: "var(--text-2)" } }, s.description),
        h(
            "div",
            { style: { display: "flex", gap: "8px" } },
            h("button.btn.sm", { type: "button", onClick: () => (editable ? openSkillEditor(s, false, after) : modal(s.name, markdown(s.markdown), null, { wide: true })) }, editable ? "Edit" : "View"),
            editable ? h("button.btn.sm.danger", { type: "button", onClick: async () => { if (await confirmDialog("Delete skill?", s.name, "Delete", true)) { await del(`/api/skills/${s.name}`); after?.(); } } }, "Delete") : null,
        ),
    );
}

export function openSkillEditor(skill, isNew, after) {
    const name = h("input.input", { value: skill?.name ?? "", disabled: Boolean(skill && !isNew), placeholder: "weekly-report" });
    const description = h("input.input", { value: skill?.description ?? "", placeholder: "What it does and when to use it" });
    const md = h("textarea.input.mono", { rows: 16, value: skill?.markdown ?? `---\nname: \ndescription: \n---\n\n# Steps\n\n1. \n` });
    const save = async (status) => {
        const n = name.value.trim();
        const text = md.value.replace(/^name:.*$/m, `name: ${n}`).replace(/^description:.*$/m, `description: ${description.value.trim()}`);
        try {
            await put(`/api/skills/${encodeURIComponent(n)}`, { description: description.value.trim(), markdown: text, status });
            m.close();
            toast(status === "published" ? "Skill published" : "Draft saved", `Add “${n}” to a bot under its profile to use it.`);
            after?.();
            if (location.hash !== "#/skills") navigate("#/skills");
        } catch (err) {
            toast("Could not save skill", errorText(err), { error: true });
        }
    };
    const m = modal(skill && isNew ? "Review drafted skill" : skill ? `Edit ${skill.name}` : "New skill", h("div.form",
        skill && isNew ? h("p.small.muted", "Check the steps, decision rules and approval points before publishing.") : null,
        h("div.row", h("label.field", "Name", name), h("label.field", "Description", description)),
        h("label.field", "SKILL.md", md),
    ), [
        h("button.btn.ghost", { type: "button", onClick: () => m.close() }, "Cancel"),
        h("button.btn", { type: "button", onClick: () => save("draft") }, "Save draft"),
        h("button.btn.primary", { type: "button", onClick: () => save("published") }, "Publish"),
    ], { wide: true });
}

// ====================================================================== Connectors
export async function renderConnectors(root) {
    const draw = async () => {
        const { connectors } = await get("/api/connectors");
        clear(
            root,
            topbar("Connectors", "Apps your bots can use, signed in as you"),
            page(
                connectors.length
                    ? h(
                          "div.grid-cards",
                          connectors.map((c) =>
                              h(
                                  "div.card",
                                  h("div.card-head", h("div.avatar", { style: { background: "var(--surface-2)", color: "var(--text)" } }, icon("plug")), h("div.grow", h("h3", c.name), h("div.meta", c.type.toUpperCase()))),
                                  h("p.small", { style: { color: "var(--text-2)" } }, c.description),
                                  h("p.small.muted", { style: { margin: "0 0 8px" } }, c.requireApproval === "never" ? "Bots use it without asking." : c.requireApproval === "always" ? "Bots ask you before every call." : "Bots ask you before any action that changes something; reading is automatic."),
                                  c.status === "managed"
                                      ? h("span.tag.ok", "Ready — uses your GitHub sign-in or org credentials")
                                      : h(
                                            "div",
                                            { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
                                            h("span.tag", { class: c.status === "connected" ? "ok" : c.status === "expired" ? "warn" : "" }, c.status === "connected" ? "Connected" : c.status === "expired" ? "Expired" : "Not connected"),
                                            h("button.btn.sm", { type: "button", onClick: () => connect(c, draw) }, c.status === "not_connected" ? "Connect" : "Reconnect"),
                                            c.status !== "not_connected" ? h("button.btn.sm.ghost", { type: "button", onClick: async () => { await del(`/api/connectors/${c.id}/credential`); void draw(); } }, "Disconnect") : null,
                                        ),
                              ),
                          ),
                      )
                    : h("div.empty", "No connectors are configured. Admins add them as MCP servers in the workspace."),
            ),
        );
    };
    await draw();
    return () => {};
}

function connect(c, after) {
    const secret = h("input.input", { type: "password", autocomplete: "off", placeholder: c.auth.label });
    const m = modal(`Connect ${c.name}`, h("div.form", h("label.field", c.auth.label, c.auth.help ? h("span.help", c.auth.help) : null, secret), h("p.small.muted", "Stored encrypted and used only when your bots call this connector on your behalf.")), [
        h("button.btn.ghost", { type: "button", onClick: () => m.close() }, "Cancel"),
        h("button.btn.primary", { type: "button", onClick: async () => {
            try {
                await put(`/api/connectors/${c.id}/credential`, { secret: secret.value });
                m.close();
                toast(`${c.name} connected`);
                after();
            } catch (err) {
                toast("Could not connect", errorText(err), { error: true });
            }
        } }, "Connect"),
    ]);
}

// ====================================================================== Computer
export async function renderComputer(root) {
    let cwd = "";
    const draw = async () => {
        const { path: p, entries } = await get(`/api/computer/files?path=${encodeURIComponent(cwd)}`);
        const crumbs = ["~", ...p.split("/").filter(Boolean)];
        const up = h("input", { type: "file", hidden: true, multiple: true, onChange: async () => {
            for (const f of up.files) {
                await api("POST", "/api/computer/upload", f, { headers: { "Content-Type": "application/octet-stream", "X-Path": encodeURIComponent([cwd, f.name].filter(Boolean).join("/")) } }).catch((err) => toast("Upload failed", errorText(err), { error: true }));
            }
            void draw();
        } });
        clear(
            root,
            topbar("Computer", "The workspace your bots share: files they create, and yours", h("button.btn.sm", { type: "button", onClick: () => up.click() }, "Upload"), iconButton("refresh", "Refresh", () => void draw()), up),
            page(
                h("p.lede", "Bots with the Computer capability read and write here. Writes and shell commands ask you first unless you've allowed them."),
                h("div.toolbar", crumbs.map((c, i) => [i ? h("span.muted", "/") : null, h("button.btn.sm.ghost", { type: "button", onClick: () => { cwd = crumbs.slice(1, i + 1).join("/"); void draw(); } }, c)])),
                entries.length
                    ? h(
                          "div.card",
                          entries.map((e) =>
                              h(
                                  "div.list-row",
                                  icon(e.dir ? "folder" : "file"),
                                  h("div.grow.ellipsis", e.dir ? h("button.btn.ghost.sm", { type: "button", onClick: () => { cwd = [cwd, e.name].filter(Boolean).join("/"); void draw(); } }, e.name) : e.name),
                                  h("span.small.muted", e.dir ? "" : bytes(e.size)),
                                  h("span.small.muted", e.modified ? timeAgo(e.modified) : ""),
                                  e.dir ? null : h("a.icon-btn", { href: `/api/computer/file?path=${encodeURIComponent([cwd, e.name].filter(Boolean).join("/"))}`, title: "Download", "aria-label": `Download ${e.name}` }, icon("download")),
                              ),
                          ),
                      )
                    : h("div.empty", "Empty. Ask a computer-enabled bot to create something, or upload files."),
            ),
        );
    };
    await draw();
    return on((e) => e.type === "message.created" && e.message.authorType === "bot" && void draw().catch(() => {}));
}

// ====================================================================== Settings (instructions, memory)
export async function renderSettings(root) {
    const draw = async () => {
        const [{ memories }, me] = await Promise.all([get("/api/memory"), get("/api/me")]);
        const instructions = h("textarea.input", { rows: 5, value: me.instructions, placeholder: "How you like to work: tone, format, timezone, priorities…" });
        const newMem = h("input.input", { placeholder: "Add something every bot should know about you" });
        const groups = new Map([[null, []]]);
        for (const m of memories) {
            if (!groups.has(m.botId)) groups.set(m.botId, []);
            groups.get(m.botId).push(m);
        }
        clear(
            root,
            topbar("Settings", `@${me.login}${me.orgs.length ? ` · ${me.orgs.join(", ")}` : ""}`),
            page(
                h("h3", "Personalization"),
                h("div.card.form", h("label.field", "Custom instructions", h("span.help", "Every bot reads this before replying to you."), instructions), h("div", h("button.btn.primary.sm", { type: "button", onClick: async () => { await put("/api/me/instructions", { instructions: instructions.value }); toast("Saved"); } }, "Save"))),
                h("h3", { style: { marginTop: "28px" } }, "Memory"),
                h("p.lede", "What your bots remember between conversations. Edit or delete anything; bots verify memory before relying on it for important actions."),
                h("div.card", h("div", { style: { display: "flex", gap: "8px" } }, newMem, h("button.btn.sm", { type: "button", onClick: async () => { if (!newMem.value.trim()) return; await post("/api/memory", { text: newMem.value.trim() }); void draw(); } }, "Add"))),
                [...groups.entries()].map(([botId, items]) =>
                    items.length || botId === null
                        ? h(
                              "div.card",
                              h("div.card-head", botId ? avatar(bot(botId), "sm") : icon("users"), h("h3.grow", botId ? `${botName(botId)}'s notes` : "About you (shared by all bots)")),
                              items.length
                                  ? items.map((m) => {
                                        const text = h("span.grow", m.text, m.source && m.source !== "user" ? h("span.small.muted", ` · saved by ${botName(m.source)}`) : null);
                                        return h(
                                            "div.list-row",
                                            text,
                                            h("span.small.muted", timeAgo(m.createdAt)),
                                            iconButton("edit", "Edit", async () => {
                                                const v = prompt("Edit memory", m.text);
                                                if (v && v.trim()) {
                                                    await patch(`/api/memory/${m.id}`, { text: v.trim() });
                                                    void draw();
                                                }
                                            }),
                                            iconButton("trash", "Delete", async () => { await del(`/api/memory/${m.id}`); void draw(); }),
                                        );
                                    })
                                  : h("div.small.muted", { style: { paddingTop: "8px" } }, "Nothing yet."),
                          )
                        : null,
                ),
                h("h3", { style: { marginTop: "28px", color: "var(--danger)" } }, "Delete my data"),
                h(
                    "div.card",
                    h("p.small", { style: { marginTop: 0 } }, "Deletes your threads, personal bots, memory, routines, skills, connector sign-ins, uploads, computer files and your stored GitHub sign-in. Audit records are kept, as your organization requires."),
                    h("button.btn.danger", { type: "button", onClick: async () => {
                        if (!(await confirmDialog("Delete all your data?", "This can't be undone. You'll be signed out.", "Delete everything", true))) return;
                        await del("/api/me");
                        location.href = "/";
                    } }, "Delete all my data"),
                ),
            ),
        );
    };
    await draw();
    return () => {};
}

// ====================================================================== Admin audit log
export async function renderAdmin(root) {
    let date = new Date().toISOString().slice(0, 10);
    let q = "";
    const draw = async () => {
        const { records } = await get(`/api/admin/audit?date=${date}&q=${encodeURIComponent(q)}`);
        const dateIn = h("input.input", { type: "date", value: date, style: { width: "auto" }, onChange: (e) => { date = e.target.value; void draw(); } });
        const qIn = h("input.input", { value: q, placeholder: "Filter: login, bot, type, trace id…", onKeydown: (e) => { if (e.key === "Enter") { q = e.target.value; void draw(); } } });
        clear(
            root,
            topbar("Audit log", "Every message, tool call, approval and bot-to-bot hop", h("button.btn.sm", { type: "button", onClick: async () => { const r = await post("/api/admin/reload"); toast("Workspace reloaded", `${r.bots} bots, ${r.connectors} connectors, ${r.skills} skills`); await refreshBots(); } }, icon("refresh"), "Reload workspace")),
            page(
                h("div.toolbar", dateIn, h("div.grow", qIn)),
                records.length
                    ? h(
                          "div.card",
                          records.map((r) =>
                              h(
                                  "div.list-row.small",
                                  { style: { alignItems: "flex-start" } },
                                  h("span.muted", { style: { width: "72px", flex: "none" } }, new Date(r.ts).toLocaleTimeString()),
                                  h("span.tag", { style: { flex: "none" } }, r.event.type),
                                  h("span", { style: { flex: "none", width: "110px" }, class: "ellipsis" }, r.actor ? `@${r.actor}` : ""),
                                  h("code.grow", { style: { fontFamily: "var(--mono)", fontSize: "12px", whiteSpace: "pre-wrap", wordBreak: "break-word" } }, JSON.stringify(Object.fromEntries(Object.entries(r.event).filter(([k]) => k !== "type"))).slice(0, 400)),
                              ),
                          ),
                      )
                    : h("div.empty", "No records for this day."),
            ),
        );
    };
    await draw();
    return () => {};
}

function sidebarPrefs(b, redraw) {
    const sections = [...new Set(S.bots.map((x) => x.section).filter(Boolean))];
    const section = h("input.input", { value: b.section ?? "", placeholder: "Bots", list: "section-names", maxLength: 40 });
    const save = async (patchBody) => {
        try {
            const updated = await put(`/api/bots/${b.id}/prefs`, patchBody);
            Object.assign(b, { section: updated.section, hidden: updated.hidden });
            await refreshBots();
            void redraw();
        } catch (err) {
            toast("Could not save", errorText(err), { error: true });
        }
    };
    section.addEventListener("change", () => save({ section: section.value.trim() || null }));
    return h(
        "div.kv",
        h("span.k", "Sidebar"),
        h("label.field", h("span.help", "Section"), section, h("datalist#section-names", sections.map((x) => h("option", { value: x })))),
        h("label", { style: { display: "flex", gap: "10px", alignItems: "center", marginTop: "6px" } }, switchInput(Boolean(b.hidden), (v) => save({ hidden: v }), "Hide from sidebar"), h("span.small", "Hide from sidebar")),
    );
}

// ====================================================================== Bot profile panel
export async function renderProfile(el, botId) {
    const b = bot(botId);
    if (!b) return clear(el);
    let tab = "about";
    const draw = async () => {
        const tabs = [["about", "About"], ["memory", "Memory"], ["routines", "Routines"], ["access", "Access"]];
        const body = h("div.tab-body");
        clear(
            el,
            h("div", { style: { display: "flex", justifyContent: "flex-end", padding: "8px 8px 0" } }, iconButton("x", "Close profile", () => setProfile(null))),
            h(
                "div.hero",
                avatar(b, "lg", statusOf(b.id)),
                h("h3", b.name),
                b.title ? h("div.title", b.title) : null,
                h("div.desc", b.description),
                h(
                    "div",
                    { style: { display: "flex", gap: "8px", marginTop: "8px" } },
                    h("button.btn.sm.primary", { type: "button", onClick: () => navigate(`#/bot/${b.id}`) }, "Message"),
                    b.editable ? h("button.btn.sm", { type: "button", onClick: () => openEditBot(b) }, icon("edit"), "Edit") : h("span.tag", "Org bot · managed by admins"),
                ),
            ),
            h("div.tabs", { role: "tablist" }, tabs.map(([k, l]) => h("button", { type: "button", role: "tab", class: tab === k ? "on" : "", onClick: () => { tab = k; void draw(); } }, l))),
            body,
        );
        if (tab === "about") {
            body.append(
                h("div.kv", h("span.k", "Instructions"), h("div.pre", b.instructions)),
                h("div.kv", h("span.k", "Model"), h("div.small", b.model ?? "Platform default")),
                h("div.kv", h("span.k", "Capabilities"), h("div.tags", (b.builtinTools ?? []).map((t) => h("span.tag", t.replace("_", " "))), b.computer ? h("span.tag", "computer") : null, b.memory ? h("span.tag", "memory") : null)),
                h("div.kv", h("span.k", "Skills"), h("div.tags", (b.skills ?? []).length ? b.skills.map((s) => h("span.tag", s)) : h("span.small.muted", "None"))),
                h("div.kv", h("span.k", "Connectors"), h("div.tags", (b.connectors ?? []).length ? b.connectors.map((s) => h("span.tag", s)) : h("span.small.muted", "None"))),
                h("div.kv", h("span.k", "Works with"), h("div.tags", (b.canMessage ?? []).length ? b.canMessage.map((id) => h("span.tag", id === "*" ? "All my bots" : botName(id))) : h("span.small.muted", "Works alone"))),
                b.allowedDomains?.length ? h("div.kv", h("span.k", "Web access"), h("div.tags", b.allowedDomains.map((d) => h("span.tag", d)))) : null,
                sidebarPrefs(b, draw),
            );
        } else if (tab === "memory") {
            const { memories } = await get("/api/memory");
            const mine = memories.filter((m) => m.botId === b.id || m.botId === null);
            body.append(mine.length ? mine.map((m) => h("div.list-row.small", h("span.grow", m.botId ? m.text : `👤 ${m.text}`), iconButton("trash", "Delete", async () => { await del(`/api/memory/${m.id}`); void draw(); }))) : h("div.small.muted", "Nothing remembered yet."));
        } else if (tab === "routines") {
            const { routines } = await get("/api/routines");
            const mine = routines.filter((r) => r.botId === b.id);
            body.append(
                mine.length ? mine.map((r) => h("div.list-row.small", h("div.grow", h("div", r.name), h("div.muted", r.schedule ? describeCron(r.schedule) : "On demand")), h("button.btn.sm", { type: "button", onClick: async () => { await post(`/api/routines/${r.id}/run`); toast("Started", r.name); } }, "Run"))) : h("div.small.muted", "No routines."),
                h("button.btn.sm", { type: "button", onClick: () => navigate("#/routines") }, "Manage routines"),
            );
        } else {
            const p = b.policy ?? { allow: [], ask: [] };
            body.append(
                h("div.kv", h("span.k", "Runs without asking"), h("div.tags", p.allow.map((k) => h("span.tag.ok", k)))),
                h("div.kv", h("span.k", "Asks you first"), h("div.tags", p.ask.length ? p.ask.map((k) => h("span.tag.warn", k)) : h("span.small.muted", "Nothing"))),
                h("div.kv", h("span.k", "Never"), h("div.small.muted", "Everything else is denied.")),
                h("div.kv", h("span.k", "Who can use it"), h("div.small", b.scope === "personal" ? "Only you" : [...(b.access?.users ?? []).map((u) => (u === "*" ? "Everyone" : `@${u}`)), ...(b.access?.orgs ?? []).map((o) => `${o} members`)].join(", "))),
                b.editable ? h("button.btn.sm.danger", { type: "button", onClick: async () => { if (await confirmDialog(`Delete ${b.name}?`, "Threads stay readable; the bot stops working. Files and memory are kept.", "Delete", true)) { await del(`/api/bots/${b.id}`); setProfile(null); await refreshBots(); navigate("#/"); } } }, "Delete bot") : null,
            );
        }
    };
    await draw();
}
