import { h, clear, icon, iconButton, get, post, api, avatar, userAvatar, toast, errorText, markdown, clock } from "./lib.js";
import { renderThread } from "./thread.js";
import { renderInbox, renderTasks, renderRoutines, renderSkills, renderConnectors, renderComputer, renderSettings, renderAdmin, renderHome } from "./pages.js";
import { openNewBot, openNewGroup, openPalette } from "./modals.js";

/** App-wide state. Views read it and re-render on `emit`. */
export const S = {
    me: null,
    bots: [],
    threads: [],
    approvals: [],
    notifications: [],
    statuses: {},
    templates: [],
    route: { name: "home", params: [] },
    profileBotId: null,
    navOpen: false,
};

const listeners = new Set();
/** Subscribe to live events; returns an unsubscribe function. Views subscribe while mounted. */
export function on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
function emit(event) {
    for (const fn of [...listeners]) fn(event);
}

export const bot = (id) => S.bots.find((b) => b.id === id);
export const botName = (id) => bot(id)?.name ?? id;
export function statusOf(id) {
    return S.statuses[id]?.status ?? bot(id)?.status ?? "idle";
}

export function navigate(hash, replace = false) {
    if (replace) history.replaceState(null, "", hash);
    else if (location.hash !== hash) history.pushState(null, "", hash);
    route();
}

// ------------------------------------------------------------------ data loading
export async function refreshBots() {
    S.bots = (await get("/api/bots")).bots;
    renderSidebar();
}
export async function refreshThreads() {
    S.threads = (await get("/api/threads?kind=dm,group")).threads;
    renderSidebar();
}
async function refreshInbox() {
    const [a, n] = await Promise.all([get("/api/approvals?status=pending"), get("/api/notifications")]);
    S.approvals = a.approvals;
    S.notifications = n.notifications;
    renderSidebar();
}

// ------------------------------------------------------------------ live events
let source;
function connectEvents() {
    source?.close();
    source = new EventSource("/api/events");
    source.addEventListener("hello", (e) => {
        S.statuses = JSON.parse(e.data).statuses ?? {};
        renderSidebar();
    });
    const types = [
        "thread.updated", "thread.deleted", "message.created", "message.delta", "message.tool", "bot.status",
        "approval.created", "approval.decided", "task.updated", "routine.run", "notification", "bots.changed",
    ];
    for (const t of types) source.addEventListener(t, (e) => handleEvent(JSON.parse(e.data)));
    let lost = false;
    source.onerror = () => {
        lost = true; // EventSource reconnects by itself
    };
    source.onopen = () => {
        if (!lost) return;
        lost = false;
        // Events sent while we were disconnected are gone: refresh lists and let open views catch up.
        void Promise.all([refreshBots(), refreshThreads(), refreshInbox()]).catch(() => {});
        emit({ type: "reconnected" });
    };
}

function handleEvent(e) {
    switch (e.type) {
        case "thread.updated": {
            if (e.thread.kind === "dm" || e.thread.kind === "group") {
                const i = S.threads.findIndex((t) => t.id === e.thread.id);
                const view = { ...e.thread, unread: Math.max(0, e.thread.lastSeq - e.thread.readSeq) };
                if (e.thread.archived) {
                    if (i >= 0) S.threads.splice(i, 1);
                } else if (i >= 0) S.threads[i] = view;
                else S.threads.unshift(view);
                S.threads.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
                renderSidebar();
            }
            break;
        }
        case "thread.deleted":
            S.threads = S.threads.filter((t) => t.id !== e.threadId);
            renderSidebar();
            break;
        case "bot.status":
            S.statuses[e.botId] = { status: e.status, threadId: e.threadId };
            renderSidebar();
            break;
        case "approval.created":
            S.approvals.unshift(e.approval);
            renderSidebar();
            break;
        case "approval.decided":
            S.approvals = S.approvals.filter((a) => a.id !== e.approval.id);
            renderSidebar();
            break;
        case "notification":
            S.notifications.unshift(e.notification);
            renderSidebar();
            notifyUser(e.notification);
            break;
        case "bots.changed":
            void refreshBots();
            break;
    }
    emit(e);
}

function notifyUser(n) {
    const viewing = S.route.name === "thread" && S.route.params[0] === n.threadId;
    if (viewing && document.visibilityState === "visible") return;
    const open = () => n.threadId && navigate(`#/t/${n.threadId}`);
    toast(n.title, n.body.slice(0, 140), { onClick: n.threadId ? open : undefined, ms: 7000 });
    if (document.visibilityState === "hidden" && "Notification" in window && Notification.permission === "granted") {
        const notif = new Notification(n.title, { body: n.body.slice(0, 200), tag: n.id });
        notif.onclick = () => {
            window.focus();
            open();
        };
    }
}

// ------------------------------------------------------------------ shell
let layout, sidebarEl, mainEl, profileEl;

function renderShell() {
    sidebarEl = h("aside.sidebar", { "aria-label": "Navigation" });
    mainEl = h("main.main");
    profileEl = h("aside.profile", { "aria-label": "Bot profile" });
    layout = h("div.layout", sidebarEl, mainEl);
    clear(document.getElementById("app"), layout);
    document.getElementById("app").className = "";
    renderSidebar();
}

export function setProfile(botId) {
    S.profileBotId = botId;
    if (!layout) return;
    if (botId) {
        layout.classList.add("with-profile");
        if (!profileEl.isConnected) layout.append(profileEl);
        import("./pages.js").then((m) => m.renderProfile(profileEl, botId));
    } else {
        layout.classList.remove("with-profile");
        profileEl.remove();
    }
}

export function toggleNav(open = !S.navOpen) {
    S.navOpen = open;
    layout?.classList.toggle("nav-open", open);
}

export function renderSidebar() {
    if (!sidebarEl) return;
    const r = S.route;
    const unreadNotes = S.notifications.filter((n) => !n.read).length;
    const pending = S.approvals.length;
    const navItem = (hash, ic, label, badge, badgeClass = "") =>
        h(
            "button.nav-item",
            { type: "button", class: r.hash === hash ? "active" : "", onClick: () => { navigate(hash); toggleNav(false); } },
            icon(ic),
            h("span.label", label),
            badge ? h(`span.badge${badgeClass}`, String(badge)) : null,
        );

    const dmByBot = new Map(S.threads.filter((t) => t.kind === "dm").map((t) => [t.botIds[0], t]));
    const rosterItem = (b) => {
        const t = b.dmThreadId ? S.threads.find((x) => x.id === b.dmThreadId) : dmByBot.get(b.id);
        const active = r.name === "thread" && t && r.params[0] === t.id;
        return h(
            "button.roster-item",
            { type: "button", class: active ? "active" : "", onClick: () => { navigate(`#/bot/${b.id}`); toggleNav(false); }, "data-bot": b.id },
            avatar(b, "", statusOf(b.id)),
            h("span.who", h("span.name", b.name), h("span.title", statusOf(b.id) === "working" ? "Working…" : statusOf(b.id) === "waiting" ? "Waiting for you" : b.title ?? b.description)),
            t?.unread && !active ? h("span.badge", String(t.unread)) : null,
        );
    };
    // Bots grouped into the user's own sidebar sections; hidden bots stay reachable from Home and search.
    const sections = new Map([["", []]]);
    for (const b of S.bots.filter((x) => !x.hidden)) {
        const key = b.section ?? "";
        if (!sections.has(key)) sections.set(key, []);
        sections.get(key).push(b);
    }
    const named = [...sections.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b));
    const hiddenCount = S.bots.filter((x) => x.hidden).length;
    const groups = S.threads.filter((t) => t.kind === "group").map((t) => {
        const active = r.name === "thread" && r.params[0] === t.id;
        return h(
            "button.roster-item",
            { type: "button", class: active ? "active" : "", onClick: () => { navigate(`#/t/${t.id}`); toggleNav(false); } },
            h("div.stack", t.botIds.slice(0, 3).map((id) => avatar(bot(id), "sm"))),
            h("span.who", h("span.name", t.title), h("span.title", `${t.botIds.length} bots`)),
            t.unread && !active ? h("span.badge", String(t.unread)) : null,
        );
    });

    clear(
        sidebarEl,
        h("div.brand", h("img", { src: "/favicon.svg", alt: "" }), h("span.grow", "Copilot Bots"), iconButton("plus", "New bot", () => openNewBot())),
        h("button.search-btn", { type: "button", onClick: () => openPalette() }, icon("search"), "Search", h("kbd", "⌘K")),
        h(
            "nav.nav",
            navItem("#/", "users", "Home"),
            navItem("#/inbox", "inbox", "Inbox", pending || unreadNotes, pending ? ".warn" : ""),
            navItem("#/tasks", "tasks", "Tasks"),
            navItem("#/routines", "clock", "Routines"),
            navItem("#/skills", "book", "Skills"),
            navItem("#/connectors", "plug", "Connectors"),
            navItem("#/computer", "monitor", "Computer"),
            S.me?.admin ? navItem("#/admin", "audit", "Audit log") : null,
        ),
        h(
            "div.sidebar-scroll",
            h("div.section-head", h("span.grow", "Bots"), iconButton("plus", "New bot", () => openNewBot())),
            h("div.roster", sections.get("").length ? sections.get("").map(rosterItem) : named.length ? null : h("div.empty-hint", "No bots yet.")),
            named.map((name) => [h("div.section-head", h("span.grow", name)), h("div.roster", sections.get(name).map(rosterItem))]),
            hiddenCount ? h("button.empty-hint", { type: "button", style: { border: 0, background: "none", cursor: "pointer" }, onClick: () => navigate("#/") }, `${hiddenCount} hidden bot${hiddenCount === 1 ? "" : "s"} · show on Home`) : null,
            h("div.section-head", h("span.grow", "Group chats"), iconButton("plus", "New group chat", () => openNewGroup())),
            h("div.roster", groups.length ? groups : h("div.empty-hint", "Put 2–6 bots in one thread.")),
        ),
        h(
            "div.me",
            userAvatar(S.me?.login ?? "?"),
            h("span.who", `@${S.me?.login ?? ""}`),
            iconButton(document.documentElement.dataset.theme === "light" ? "moon" : "sun", "Toggle theme", toggleTheme),
            iconButton("settings", "Settings", () => navigate("#/settings")),
            iconButton("logout", "Sign out", signOut),
        ),
    );
}

function toggleTheme() {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
        localStorage.setItem("theme", next);
    } catch {}
    renderSidebar();
}

async function signOut() {
    await post("/auth/logout").catch(() => {});
    location.href = "/";
}

// ------------------------------------------------------------------ routing
let unmount = () => {};

async function route() {
    const hash = location.hash || "#/";
    const [, name = "", ...params] = hash.slice(1).split("/");
    S.route = { name: name || "home", params, hash };
    unmount();
    unmount = () => {};
    if (!mainEl) return;
    // Each route renders into a fresh container, so a stale async draw from the previous page
    // writes into a detached node instead of over the current one.
    const view = h("div.view");
    clear(mainEl, view);
    try {
        switch (S.route.name) {
            case "bot": {
                const b = bot(params[0]);
                const t = await post(`/api/bots/${encodeURIComponent(params[0])}/dm`);
                if (!S.threads.some((x) => x.id === t.id)) S.threads.unshift(t);
                if (b) b.dmThreadId = t.id;
                return navigate(`#/t/${t.id}`, true);
            }
            case "t":
                S.route.name = "thread";
                unmount = await renderThread(view, params[0]);
                break;
            case "inbox":
                unmount = await renderInbox(view);
                break;
            case "tasks":
                unmount = await renderTasks(view);
                break;
            case "routines":
                unmount = await renderRoutines(view);
                break;
            case "skills":
                unmount = await renderSkills(view);
                break;
            case "connectors":
                unmount = await renderConnectors(view);
                break;
            case "computer":
                unmount = await renderComputer(view);
                break;
            case "settings":
                unmount = await renderSettings(view);
                break;
            case "admin":
                unmount = await renderAdmin(view);
                break;
            default:
                unmount = await renderHome(view);
        }
    } catch (err) {
        clear(view, h("div.page", h("div.page-inner", h("div.empty", errorText(err)))));
    }
    renderSidebar();
}

export function topbar(title, sub, ...actions) {
    return h(
        "header.topbar",
        iconButton("menu", "Menu", () => toggleNav(), { class: "menu-btn" }),
        h("div.grow", h("h1", title), sub ? h("div.sub", sub) : null),
        ...actions,
    );
}

// ------------------------------------------------------------------ login & share pages
async function renderLogin(error) {
    const cfg = await get("/auth/config", { allow401: true }).catch(() => ({ github: false, token: true, dev: false }));
    const tokenInput = h("input.input", { type: "password", placeholder: "ghp_… or gho_…", autocomplete: "off", "aria-label": "GitHub token" });
    const devInput = h("input.input", { placeholder: "your-login", "aria-label": "Login", value: "alice" });
    const errEl = h("div.small", { style: { color: "var(--danger)" } }, error ?? "");
    const signIn = async (path, body) => {
        try {
            await api("POST", path, body, { allow401: true });
            location.href = "/";
        } catch (err) {
            errEl.textContent = errorText(err);
        }
    };
    clear(
        document.getElementById("app"),
        h(
            "div.login",
            h(
                "div.box",
                h("img", { src: "/favicon.svg", alt: "", width: 48, height: 48, style: { margin: "0 auto" } }),
                h("h1", "Copilot Bots"),
                h("p.muted", "AI teammates for your organization, running on GitHub Copilot as you."),
                cfg.github ? h("a.btn.primary", { href: "/auth/github/login", style: { justifyContent: "center" } }, "Sign in with GitHub") : null,
                cfg.github ? h("div.or", "or") : null,
                h(
                    "form",
                    { onSubmit: (e) => { e.preventDefault(); void signIn("/auth/token", { token: tokenInput.value }); } },
                    h("label.field", "GitHub token", h("span.help", "A token for an account with a Copilot seat. It's kept encrypted and used only to act as you."), tokenInput),
                    h("button.btn", { type: "submit", style: { justifyContent: "center" } }, "Continue with token"),
                ),
                cfg.dev
                    ? h(
                          "form",
                          { onSubmit: (e) => { e.preventDefault(); void signIn("/auth/dev", { login: devInput.value }); } },
                          h("label.field", "Demo sign-in", h("span.help", "Demo mode: no GitHub account needed, bots give scripted replies."), devInput),
                          h("button.btn", { type: "submit", style: { justifyContent: "center" } }, "Enter demo"),
                      )
                    : null,
                errEl,
            ),
        ),
    );
    document.getElementById("app").className = "";
}

async function renderShare(token) {
    const app = document.getElementById("app");
    app.className = "";
    try {
        const d = await get(`/api/share/${encodeURIComponent(token)}`, { allow401: true });
        const who = (m) => (m.authorType === "user" ? { name: `@${m.authorId}` } : d.bots[m.authorId] ?? { name: m.authorId });
        clear(
            app,
            h(
                "div.share-page",
                h("header", h("h1", { style: { margin: 0, fontSize: "22px" } }, d.thread.title), h("div.muted.small", `Shared by @${d.thread.owner} · read-only`)),
                d.messages.map((m) =>
                    h(
                        `div.msg.${m.authorType}`,
                        m.authorType === "bot" ? avatar(who(m)) : null,
                        h("div.body", m.authorType === "bot" ? h("div.head", h("span.author", who(m).name), h("span.time", clock(m.createdAt))) : null, markdown(m.text)),
                    ),
                ),
            ),
        );
    } catch (err) {
        clear(app, h("div.login", h("div.box", h("h1", "Not available"), h("p.muted", errorText(err)))));
    }
}

// ------------------------------------------------------------------ boot
async function boot() {
    try {
        const theme = localStorage.getItem("theme");
        if (theme) document.documentElement.dataset.theme = theme;
    } catch {}
    if (location.pathname.startsWith("/s/")) return renderShare(location.pathname.slice(3));

    // The server only ever sends a fixed code; never show text taken from the URL.
    const loginError = new URLSearchParams(location.search).get("login_error") ? "GitHub sign-in didn't complete. Please try again." : undefined;
    if (loginError) history.replaceState(null, "", "/");
    const session = await get("/auth/session", { allow401: true }).catch(() => ({ login: null }));
    if (!session.login) return renderLogin(loginError);
    S.me = await get("/api/me");
    window.addEventListener("signed-out", () => renderLogin("Your session ended. Please sign in again."));
    const [bots, threads, templates] = await Promise.all([get("/api/bots"), get("/api/threads?kind=dm,group"), get("/api/bot-templates")]);
    S.bots = bots.bots;
    S.threads = threads.threads;
    S.templates = templates.templates;
    await refreshInbox();
    renderShell();
    connectEvents();
    window.addEventListener("popstate", route);
    document.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
            e.preventDefault();
            openPalette();
        }
    });
    await route();
}

void boot();
