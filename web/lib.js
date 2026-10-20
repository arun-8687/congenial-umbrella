import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";

/** Tiny hyperscript: h("div.cls#id", {attrs, on*}, ...children). Strings become text nodes (never HTML). */
export function h(tag, attrs, ...children) {
    const [name, ...rest] = tag.split(/(?=[.#])/);
    const el = document.createElement(name || "div");
    for (const r of rest) {
        if (r[0] === ".") el.classList.add(r.slice(1));
        else el.id = r.slice(1);
    }
    if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) {
        children.unshift(attrs);
        attrs = null;
    }
    for (const [k, v] of Object.entries(attrs ?? {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "class") el.className += (el.className ? " " : "") + v;
        else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
        else if (k === "dataset") Object.assign(el.dataset, v);
        else if (k in el && typeof v !== "string") el[k] = v;
        else el.setAttribute(k, v === true ? "" : String(v));
    }
    append(el, children);
    return el;
}

function append(el, children) {
    for (const c of children.flat(Infinity)) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
}

export function clear(el, ...children) {
    el.replaceChildren();
    append(el, children);
    return el;
}

// ------------------------------------------------------------------ icons (inline SVG, stroke-based)
const PATHS = {
    plus: "M12 5v14M5 12h14",
    search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.35-4.35",
    inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
    tasks: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
    clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
    book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z",
    plug: "M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0V8zM12 18v4",
    monitor: "M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 21h8M12 16v5",
    settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
    shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
    send: "M5 12h14M13 6l6 6-6 6",
    stop: "M7 7h10v10H7z",
    clip: "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48",
    mic: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3",
    share: "M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13",
    download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
    panel: "M3 4h18v16H3zM15 4v16",
    copy: "M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
    speaker: "M11 5 6 9H2v6h4l5 4V5zM15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14",
    tool: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
    brain: "M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24A2.5 2.5 0 0 1 9.5 2zM14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24A2.5 2.5 0 0 0 14.5 2z",
    menu: "M3 6h18M3 12h18M3 18h18",
    x: "M18 6 6 18M6 6l12 12",
    sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42",
    moon: "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z",
    logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
    users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
    folder: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
    file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
    play: "M6 4l14 8-14 8z",
    trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
    edit: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z",
    sparkle: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z",
    pin: "M12 17v5M5 17h14l-2-4V5H7v8z",
    archive: "M21 8v13H3V8M1 3h22v5H1zM10 12h4",
    check: "M20 6 9 17l-5-5",
    audit: "M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2M9 14l2 2 4-4",
    refresh: "M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15",
};

export function icon(name, extra = {}) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", extra.width ?? "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", PATHS[name] ?? "");
    svg.append(p);
    return svg;
}

export function iconButton(name, label, onClick, extra = {}) {
    return h("button.icon-btn", { type: "button", title: label, "aria-label": label, onClick, ...extra }, icon(name));
}

// ------------------------------------------------------------------ API client
export class ApiError extends Error {
    constructor(status, body) {
        super(body?.error ?? `HTTP ${status}`);
        this.status = status;
        this.body = body;
    }
}

export async function api(method, path, body, opts = {}) {
    const headers = { "X-CSRF": "1" };
    let payload = body;
    if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(body);
    }
    Object.assign(headers, opts.headers ?? {});
    const res = await fetch(path, { method, headers, body: payload, credentials: "same-origin" });
    if (res.status === 204) return null;
    const ct = res.headers.get("content-type") ?? "";
    const data = ct.includes("application/json") ? await res.json() : await res.text();
    if (!res.ok) {
        const err = new ApiError(res.status, typeof data === "object" ? data : { error: data });
        if (res.status === 401 && !opts.allow401) window.dispatchEvent(new CustomEvent("signed-out"));
        throw err;
    }
    return data;
}

export const get = (p, o) => api("GET", p, undefined, o);
export const post = (p, b, o) => api("POST", p, b ?? {}, o);
export const put = (p, b) => api("PUT", p, b);
export const patch = (p, b) => api("PATCH", p, b);
export const del = (p) => api("DELETE", p);

export function errorText(err) {
    if (err?.body?.details && Array.isArray(err.body.details)) {
        const d = err.body.details.map((x) => (typeof x === "string" ? x : `${(x.path ?? []).join(".")}: ${x.message}`)).join("; ");
        return `${err.message}: ${d}`;
    }
    return err?.message ?? String(err);
}

// ------------------------------------------------------------------ markdown
marked.setOptions({ gfm: true, breaks: true });

/** Renders untrusted Markdown to sanitized DOM, highlights @mentions, and adds copy buttons to code. */
export function markdown(text, opts = {}) {
    const html = DOMPurify.sanitize(marked.parse(text ?? ""), { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input"], FORBID_ATTR: ["style"] });
    const el = h("div.md");
    el.innerHTML = html;
    for (const a of el.querySelectorAll("a")) {
        a.target = "_blank";
        a.rel = "noopener noreferrer nofollow";
    }
    for (const pre of el.querySelectorAll("pre")) {
        const btn = h("button.copy", { type: "button" }, "Copy");
        btn.addEventListener("click", async () => {
            await navigator.clipboard?.writeText(pre.querySelector("code")?.textContent ?? pre.textContent ?? "");
            btn.textContent = "Copied";
            setTimeout(() => (btn.textContent = "Copy"), 1200);
        });
        pre.append(btn);
    }
    if (opts.mentions) highlightMentions(el, opts.mentions);
    return el;
}

function highlightMentions(root, known) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement?.closest("code,pre,a") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    while (walker.nextNode()) if (/@[A-Za-z0-9-]/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
    for (const node of nodes) {
        const parts = node.nodeValue.split(/(@[A-Za-z0-9][A-Za-z0-9-]*)/g);
        const frag = document.createDocumentFragment();
        for (const part of parts) {
            if (part.startsWith("@") && known(part.slice(1))) frag.append(h("span.mention", part));
            else frag.append(part);
        }
        node.replaceWith(frag);
    }
}

// ------------------------------------------------------------------ misc
export function timeAgo(iso) {
    const d = new Date(iso);
    const s = (Date.now() - d.getTime()) / 1000;
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
    return d.toLocaleDateString();
}

export function clock(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function dayLabel(iso) {
    const d = new Date(iso);
    const today = new Date();
    const y = new Date(Date.now() - 86400_000);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

export function bytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function plain(md) {
    return String(md ?? "").replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>]+/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
}

export function toast(title, body = "", opts = {}) {
    body = plain(body);
    title = plain(title);
    const el = h(`div.toast${opts.error ? ".error" : ""}${opts.onClick ? ".click" : ""}`, { role: "status" }, h("b", title), body ? h("div.muted.small", body) : null);
    if (opts.onClick) el.addEventListener("click", () => {
        opts.onClick();
        el.remove();
    });
    document.getElementById("toasts").append(el);
    setTimeout(() => el.remove(), opts.ms ?? 5000);
}

export function avatar(bot, size = "", status) {
    if (!bot) return h(`div.avatar${size ? "." + size : ""}`, "?");
    const el = h(`div.avatar${size ? "." + size : ""}`, { style: { background: bot.color ?? "#3f3f46" }, title: bot.name }, bot.avatar ?? initials(bot.name));
    if (status) el.append(h(`span.status-dot.${status}`, { title: status }));
    return el;
}

export function userAvatar(login, size = "") {
    return h(`div.avatar.user${size ? "." + size : ""}`, { title: `@${login}` }, initials(login));
}

export function initials(name = "?") {
    const parts = name.trim().split(/[\s-]+/);
    return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function modal(title, body, foot, opts = {}) {
    const close = () => {
        overlay.remove();
        document.removeEventListener("keydown", onKey);
        opts.onClose?.();
    };
    const onKey = (e) => e.key === "Escape" && close();
    const overlay = h(
        "div.overlay",
        { onMousedown: (e) => e.target === overlay && close() },
        h(
            `div.modal${opts.wide ? ".wide" : ""}`,
            { role: "dialog", "aria-modal": "true", "aria-label": title },
            h("div.modal-head", h("h2", title), iconButton("x", "Close", close)),
            h("div.modal-body", body),
            foot ? h("div.modal-foot", foot) : null,
        ),
    );
    document.addEventListener("keydown", onKey);
    document.body.append(overlay);
    overlay.querySelector("input,textarea,select")?.focus();
    return { close, el: overlay };
}

export function confirmDialog(title, text, okLabel = "Confirm", danger = false) {
    return new Promise((resolve) => {
        let done = false;
        const m = modal(title, h("p", text), [
            h("button.btn.ghost", { type: "button", onClick: () => m.close() }, "Cancel"),
            h(`button.btn${danger ? ".danger" : ".primary"}`, { type: "button", onClick: () => { done = true; m.close(); } }, okLabel),
        ], { onClose: () => resolve(done) });
    });
}

export function switchInput(checked, onChange, label) {
    const input = h("input", { type: "checkbox", checked, "aria-label": label, onChange: (e) => onChange(e.target.checked) });
    return h("label.switch", input, h("span"));
}
