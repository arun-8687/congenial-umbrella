import { h, clear, icon, get, post, put, avatar, modal, toast, errorText, timeAgo } from "./lib.js";
import { S, navigate, refreshBots, refreshThreads, bot } from "./app.js";

const COLORS = ["#6366f1", "#0ea5e9", "#22c55e", "#f97316", "#ef4444", "#a855f7", "#14b8a6", "#eab308", "#ec4899", "#64748b"];
const EMOJI = ["🤖", "🧭", "🔎", "🚀", "🧐", "🐞", "🚨", "✍️", "📊", "🛠️", "📣", "🧪", "🗂️", "💡"];

// ====================================================================== New / edit bot
export function openNewBot() {
    const blank = { name: "", title: "", avatar: "🤖", color: COLORS[0], description: "", instructions: "", builtinTools: [], skills: [], connectors: [], canMessage: ["*"], computer: false, memory: true };
    botForm("New bot", blank, async (spec) => {
        const b = await post("/api/bots", spec);
        await refreshBots();
        toast(`${b.name} joined your team`);
        navigate(`#/bot/${b.id}`);
    }, true);
}

export function openEditBot(b) {
    botForm(`Edit ${b.name}`, b, async (spec) => {
        await put(`/api/bots/${b.id}`, { ...spec, permissions: b.permissions ?? {} });
        await refreshBots();
        toast("Saved");
    }, false);
}

async function botForm(title, initial, onSave, withTemplates) {
    const { org, mine } = await get("/api/skills").catch(() => ({ org: [], mine: [] }));
    const { connectors } = await get("/api/connectors").catch(() => ({ connectors: [] }));
    const skills = [...org.map((s) => s.name), ...mine.filter((s) => s.status === "published").map((s) => s.name)];

    const f = {
        name: h("input.input", { placeholder: "Atlas", required: true, maxLength: 80 }),
        title: h("input.input", { placeholder: "Chief of Staff", maxLength: 60 }),
        avatar: h("input.input", { maxLength: 8, style: { width: "70px", textAlign: "center", fontSize: "18px" } }),
        color: h("input", { type: "color", style: { width: "44px", height: "36px", border: "0", background: "none" } }),
        description: h("textarea.input", { rows: 2, placeholder: "One line on what this bot does (shown to you and to other bots)", maxLength: 500 }),
        instructions: h("textarea.input", { rows: 6, placeholder: "How it should work: goals, style, what to always or never do" }),
        model: h("input.input", { placeholder: "Platform default" }),
        effort: h("select.input", ["", "low", "medium", "high", "xhigh"].map((v) => h("option", { value: v }, v || "Default"))),
        domains: h("input.input", { placeholder: "Any domain (e.g. docs.github.com, *.acme.com)" }),
    };
    const check = (value, label) => h("label", h("input", { type: "checkbox", value }), label);
    const computerLabel = S.me.computerAccess === "shell" ? "Computer (files & shell)" : "Computer (files)";
    const caps = h(
        "div.checks",
        check("web_search", "Web search"),
        check("web_fetch", "Read web pages"),
        S.me.computerAccess !== "off" || initial.computer ? check("computer", computerLabel) : null,
        check("memory", "Memory"),
    );
    const skillChecks = h("div.checks", skills.length ? skills.map((s) => check(s, s)) : h("span.small.muted", "No skills yet"));
    const connChecks = h("div.checks", connectors.length ? connectors.map((c) => check(c.id, c.name)) : h("span.small.muted", "No connectors configured"));
    const others = S.bots.filter((b) => b.id !== initial.id);
    const worksAll = h("input", { type: "radio", name: "works", value: "all" });
    const worksSome = h("input", { type: "radio", name: "works", value: "some" });
    const worksNone = h("input", { type: "radio", name: "works", value: "none" });
    const teamChecks = h("div.checks", { style: { marginLeft: "22px" } }, others.map((b) => check(b.id, b.name)));
    const preview = h("div");

    const set = (spec) => {
        f.name.value = spec.name ?? "";
        f.title.value = spec.title ?? "";
        f.avatar.value = spec.avatar ?? "🤖";
        f.color.value = spec.color ?? COLORS[0];
        f.description.value = spec.description ?? "";
        f.instructions.value = spec.instructions ?? "";
        f.model.value = spec.model ?? "";
        f.effort.value = spec.reasoningEffort ?? "";
        f.domains.value = (spec.allowedDomains ?? []).join(", ");
        const capsOn = new Set([...(spec.builtinTools ?? []), spec.computer ? "computer" : null, spec.memory !== false ? "memory" : null]);
        for (const i of caps.querySelectorAll("input")) i.checked = capsOn.has(i.value);
        for (const i of skillChecks.querySelectorAll("input")) i.checked = (spec.skills ?? []).includes(i.value);
        for (const i of connChecks.querySelectorAll("input")) i.checked = (spec.connectors ?? []).includes(i.value);
        const cm = spec.canMessage ?? [];
        worksAll.checked = cm.includes("*");
        worksNone.checked = cm.length === 0;
        worksSome.checked = !worksAll.checked && !worksNone.checked;
        for (const i of teamChecks.querySelectorAll("input")) i.checked = cm.includes(i.value);
        drawPreview();
    };
    const read = () => {
        const capsOn = new Set([...caps.querySelectorAll("input:checked")].map((i) => i.value));
        const spec = {
            name: f.name.value.trim(),
            ...(f.title.value.trim() ? { title: f.title.value.trim() } : {}),
            ...(f.avatar.value.trim() ? { avatar: f.avatar.value.trim() } : {}),
            color: f.color.value,
            description: f.description.value.trim(),
            instructions: f.instructions.value.trim() || f.description.value.trim(),
            ...(f.model.value.trim() ? { model: f.model.value.trim() } : {}),
            ...(f.effort.value ? { reasoningEffort: f.effort.value } : {}),
            ...(f.domains.value.trim() ? { allowedDomains: f.domains.value.split(/[\s,]+/).filter(Boolean) } : {}),
            builtinTools: ["web_search", "web_fetch"].filter((t) => capsOn.has(t)),
            computer: capsOn.has("computer"),
            memory: capsOn.has("memory"),
            skills: [...skillChecks.querySelectorAll("input:checked")].map((i) => i.value),
            connectors: [...connChecks.querySelectorAll("input:checked")].map((i) => i.value),
            canMessage: worksAll.checked ? ["*"] : worksNone.checked ? [] : [...teamChecks.querySelectorAll("input:checked")].map((i) => i.value),
        };
        return spec;
    };
    function drawPreview() {
        const s = { name: f.name.value || "New bot", avatar: f.avatar.value, color: f.color.value };
        clear(preview, h("div", { style: { display: "flex", gap: "12px", alignItems: "center" } }, avatar(s, "lg"), h("div", h("div", { style: { fontWeight: 650, fontSize: "17px" } }, s.name), h("div.muted", f.title.value || "Job title"))));
    }
    for (const el of [f.name, f.title, f.avatar, f.color]) el.addEventListener("input", drawPreview);

    const strip = withTemplates
        ? h(
              "div.template-strip",
              { role: "tablist", "aria-label": "Start from a role" },
              h("button.chip.on", { type: "button", onClick: (e) => { pick(e.target); set(initial); } }, "Blank"),
              S.templates.map((t) => h("button.chip", { type: "button", onClick: (e) => { pick(e.target); set({ ...initial, ...t.bot }); } }, t.label)),
          )
        : null;
    function pick(btn) {
        for (const c of strip.querySelectorAll(".chip")) c.classList.toggle("on", c === btn);
    }

    const body = h(
        "div.form",
        strip,
        preview,
        h("div.row", h("label.field", "Name", f.name), h("label.field", "Job title", f.title)),
        h("div", { style: { display: "flex", gap: "12px", alignItems: "end" } }, h("label.field", "Avatar", f.avatar), h("label.field", "Color", f.color), h("div.chips", { style: { justifyContent: "flex-start" } }, EMOJI.map((e) => h("button.chip", { type: "button", onClick: () => { f.avatar.value = e; drawPreview(); } }, e)))),
        h("label.field", "What it does", f.description),
        h("label.field", "How it works", h("span.help", "Instructions the bot follows. Write them like a brief for a new teammate."), f.instructions),
        h("div.field", h("div.small", { style: { fontWeight: 540 } }, "Capabilities"), caps),
        h("div.field", h("div.small", { style: { fontWeight: 540 } }, "Skills"), skillChecks),
        h("div.field", h("div.small", { style: { fontWeight: 540 } }, "Connectors"), connChecks),
        h(
            "div.field",
            h("div.small", { style: { fontWeight: 540 } }, "Works with"),
            h("div.checks", h("label", worksAll, "All my bots"), h("label", worksSome, "Only these"), h("label", worksNone, "Works alone")),
            teamChecks,
        ),
        h(
            "details",
            h("summary.small.muted", "Advanced: model and web access"),
            h("div.row", { style: { marginTop: "10px" } }, h("label.field", "Model", f.model), h("label.field", "Reasoning effort", f.effort)),
            h("label.field", { style: { marginTop: "10px" } }, "Allowed web domains", h("span.help", "Limits which sites the bot can read, so a malicious page can't make it send your data elsewhere."), f.domains),
        ),
    );
    const saveBtn = h("button.btn.primary", { type: "submit" }, withTemplates ? "Create bot" : "Save");
    const m = modal(title, body, [h("button.btn.ghost", { type: "button", onClick: () => m.close() }, "Cancel"), saveBtn], { wide: true });
    saveBtn.addEventListener("click", async () => {
        const spec = read();
        if (!spec.name || !spec.description) return toast("Name and “what it does” are required", "", { error: true });
        saveBtn.disabled = true;
        try {
            await onSave(spec);
            m.close();
        } catch (err) {
            toast("Could not save bot", errorText(err), { error: true });
            saveBtn.disabled = false;
        }
    });
    set(initial);
}

// ====================================================================== New group chat
export function openNewGroup() {
    if (S.bots.length < 2) return toast("You need at least two bots for a group chat");
    const name = h("input.input", { placeholder: "Launch plan" });
    const checks = S.bots.map((b) => h("label", h("input", { type: "checkbox", value: b.id }), `${b.avatar ?? "🤖"} ${b.name}`));
    const m = modal("New group chat", h("div.form", h("label.field", "Name", name), h("div.field", h("div.small.muted", "Pick 2 to 6 bots. The first one leads when nobody is @mentioned."), h("div.checks", checks))), [
        h("button.btn.ghost", { type: "button", onClick: () => m.close() }, "Cancel"),
        h("button.btn.primary", { type: "button", onClick: async () => {
            const botIds = checks.map((c) => c.querySelector("input")).filter((i) => i.checked).map((i) => i.value);
            if (botIds.length < 2) return toast("Pick at least two bots");
            try {
                const t = await post("/api/threads", { botIds, title: name.value.trim() || undefined });
                await refreshThreads();
                m.close();
                navigate(`#/t/${t.id}`);
            } catch (err) {
                toast("Could not create group", errorText(err), { error: true });
            }
        } }, "Create"),
    ]);
}

// ====================================================================== ⌘K palette
export function openPalette() {
    if (document.querySelector(".palette")) return;
    const input = h("input", { placeholder: "Search bots, threads and messages, or jump to a page…", "aria-label": "Search" });
    const results = h("div.results", { role: "listbox" });
    let items = [];
    let sel = 0;
    let timer;
    const pages = [
        ["Home", "#/"], ["Inbox", "#/inbox"], ["Tasks", "#/tasks"], ["Routines", "#/routines"], ["Skills", "#/skills"],
        ["Connectors", "#/connectors"], ["Computer", "#/computer"], ["Settings", "#/settings"],
    ];
    const go = (it) => {
        m.close();
        it.run();
    };
    const draw = () => {
        clear(results, items.length ? items.map((it, i) => h("button.result", { type: "button", role: "option", class: i === sel ? "sel" : "", onClick: () => go(it) }, it.icon, h("div.grow", h("div.ellipsis", it.title), it.sub ? h("div.small.muted.ellipsis", it.sub) : null))) : h("div.empty-hint", { style: { padding: "14px" } }, "No matches"));
    };
    const local = (q) => {
        const ql = q.toLowerCase();
        return [
            ...S.bots.filter((b) => !q || b.name.toLowerCase().includes(ql) || (b.title ?? "").toLowerCase().includes(ql)).map((b) => ({ title: b.name, sub: b.title ?? b.description, icon: avatar(b, "sm"), run: () => navigate(`#/bot/${b.id}`) })),
            ...S.threads.filter((t) => t.kind === "group" && (!q || t.title.toLowerCase().includes(ql))).map((t) => ({ title: t.title, sub: "Group chat", icon: icon("users"), run: () => navigate(`#/t/${t.id}`) })),
            ...pages.filter(([l]) => !q || l.toLowerCase().includes(ql)).map(([l, hash]) => ({ title: l, sub: "Go to page", icon: icon("send"), run: () => navigate(hash) })),
            ...(!q || "new bot".includes(ql) ? [{ title: "Create a bot", sub: "Action", icon: icon("plus"), run: () => openNewBot() }] : []),
        ];
    };
    const search = async () => {
        const q = input.value.trim();
        items = local(q);
        sel = 0;
        draw();
        if (q.length < 2) return;
        clearTimeout(timer);
        timer = setTimeout(async () => {
            const { results: found } = await get(`/api/search?q=${encodeURIComponent(q)}`).catch(() => ({ results: [] }));
            items = [
                ...local(q),
                ...found.map((r) => ({
                    title: r.thread.title,
                    sub: r.snippet || `${r.thread.kind} · ${timeAgo(r.thread.updatedAt)}`,
                    icon: r.thread.kind === "group" ? icon("users") : avatar(bot(r.thread.botIds[0]), "sm"),
                    run: () => navigate(`#/t/${r.thread.id}`),
                })),
            ];
            draw();
        }, 180);
    };
    input.addEventListener("input", search);
    input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length);
            draw();
        } else if (e.key === "Enter" && items[sel]) {
            e.preventDefault();
            go(items[sel]);
        }
    });
    const m = modal("Search", h("div.palette", input, results));
    m.el.querySelector(".modal-head").remove();
    m.el.querySelector(".modal-body").style.padding = "0";
    input.focus();
    void search();
}
