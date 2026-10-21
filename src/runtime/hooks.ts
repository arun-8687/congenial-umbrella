import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { DeliveryType } from "./repo.js";

/**
 * Inbound webhooks that start routines (GitHub, CI, alerting) and outbound delivery of routine
 * results (Slack, Teams, any JSON endpoint). Everything here is pure, so it is tested directly.
 */

export const MAX_HOOK_EVENTS = 20;
const EVENT_PATTERN = /^[A-Za-z0-9_*.-]{1,80}(\?[A-Za-z0-9_.]{1,80}=[^&]{0,120}(&[A-Za-z0-9_.]{1,80}=[^&]{0,120}){0,4})?$/;

/** Problems with a list of event filters, e.g. `pull_request.opened` or `workflow_run.completed?workflow_run.conclusion=failure`. */
export function eventFilterProblems(events: string[]): string[] {
    if (events.length > MAX_HOOK_EVENTS) return [`at most ${MAX_HOOK_EVENTS} event filters`];
    return events.filter((e) => !EVENT_PATTERN.test(e)).map((e) => `invalid event filter '${e.slice(0, 60)}'`);
}

/**
 * True when the event passes one of the filters (no filters: every event). A filter is an event
 * name (`push`), a name and action (`pull_request.opened`, `pull_request.*`), or `*`, optionally
 * followed by `?path=value` conditions on the payload; `|` separates accepted values.
 */
export function matchesEvent(filters: string[], event: string, payload: unknown): boolean {
    if (filters.length === 0) return true;
    return filters.some((f) => {
        const [name = "", query] = f.split("?", 2);
        const nameOk = name === "*" || name === event || (name.endsWith(".*") && event.split(".")[0] === name.slice(0, -2)) || (!name.includes(".") && event.split(".")[0] === name);
        if (!nameOk) return false;
        if (!query) return true;
        return query.split("&").every((cond) => {
            const [path = "", expected = ""] = cond.split("=", 2);
            const actual = path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), payload);
            return expected.split("|").includes(actual === undefined || actual === null ? "" : String(actual));
        });
    });
}

/** The event name: GitHub's `X-GitHub-Event` plus the payload's action, else `X-Event-Type`, else `webhook`. */
export function eventName(headers: IncomingHttpHeaders, payload: unknown): string {
    const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    const gh = header(headers, "x-github-event") ?? header(headers, "x-gitea-event");
    if (gh) return typeof p.action === "string" && p.action ? `${gh}.${p.action}` : gh;
    const named = header(headers, "x-event-type") ?? (typeof p.event === "string" ? p.event : undefined);
    return (named ?? "webhook").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "webhook";
}

/** An id the sender keeps across retries, used to ignore duplicate deliveries. */
export function deliveryId(headers: IncomingHttpHeaders): string | undefined {
    const id = header(headers, "x-github-delivery") ?? header(headers, "x-gitea-delivery") ?? header(headers, "idempotency-key") ?? header(headers, "x-request-id");
    return id?.slice(0, 200);
}

/**
 * Checks the request against the routine's secret: GitHub-style `X-Hub-Signature-256` (HMAC of
 * the raw body), or the secret itself as `Authorization: Bearer` / `X-Hook-Secret` for senders
 * that can't sign. Constant-time either way.
 */
export function verifyHook(headers: IncomingHttpHeaders, body: Buffer, secret: string): boolean {
    const signature = header(headers, "x-hub-signature-256");
    if (signature) {
        const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
        return safeEqual(signature, expected);
    }
    const bearer = /^Bearer\s+(.+)$/i.exec(header(headers, "authorization") ?? "")?.[1] ?? header(headers, "x-hook-secret");
    return bearer !== undefined && safeEqual(bearer, secret);
}

function safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
    const v = headers[name];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
}

const NOISE_KEY = /(^node_id$|_url$|^url$|^avatar|^gravatar_id$|^site_admin$|^user_view_type$|^performed_via_github_app$|^reactions$|^_links$|^permissions$|^license$|^topics$)/;
const KEEP_URL = new Set(["html_url", "target_url", "details_url", "logs_url", "web_url"]);
const ACTOR_KEYS = new Set(["sender", "user", "owner", "author", "committer", "assignee", "merged_by", "requested_reviewer", "pusher", "actor", "triggering_actor"]);

/**
 * A compact copy of a webhook payload for the bot to read: GitHub payloads are mostly API URLs and
 * nested repository objects, so those are dropped, people become their login, and long text and
 * lists are cut. The result stays under `maxChars`.
 */
export function summarizePayload(payload: unknown, maxChars = 16_000): string {
    const walk = (v: unknown, key: string, depth: number): unknown => {
        if (v === null || typeof v !== "object") return typeof v === "string" && v.length > 4000 ? `${v.slice(0, 4000)}… [truncated]` : v;
        if (Array.isArray(v)) {
            const items = v.slice(0, 20).map((x) => walk(x, key, depth + 1));
            return v.length > 20 ? [...items, `… ${v.length - 20} more`] : items;
        }
        const o = v as Record<string, unknown>;
        if (ACTOR_KEYS.has(key) && typeof o.login === "string") return o.login;
        if (key === "repository" || key === "repo" || key === "head_repository") {
            return { full_name: o.full_name, html_url: o.html_url, default_branch: o.default_branch, private: o.private };
        }
        if (key === "organization" || key === "installation" || key === "enterprise") return typeof o.login === "string" ? o.login : undefined;
        if (depth >= 5) return "[…]";
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(o)) {
            if (NOISE_KEY.test(k) && !KEEP_URL.has(k)) continue;
            const w = walk(x, k, depth + 1);
            if (w !== undefined && w !== null && !(typeof w === "object" && !Array.isArray(w) && Object.keys(w).length === 0)) out[k] = w;
        }
        return out;
    };
    const text = JSON.stringify(walk(payload, "", 0), null, 1) ?? "null";
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n… [payload truncated]` : text;
}

/** A short label for the run list, e.g. `pull_request.opened octo/app#12`. */
export function triggerDetail(event: string, payload: unknown): string {
    const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, Record<string, unknown> | undefined>;
    const repo = typeof p.repository?.full_name === "string" ? p.repository.full_name : "";
    const num = p.pull_request?.number ?? p.issue?.number;
    const ref = typeof (p as Record<string, unknown>).ref === "string" ? ` ${(p as Record<string, unknown>).ref as string}` : "";
    return `${event}${repo ? ` ${repo}` : ""}${num !== undefined ? `#${String(num)}` : ""}${ref}`.slice(0, 200);
}

// ---------------------------------------------------------------------- outbound delivery

export interface DeliveryContent {
    routine: { id: string; name: string };
    bot: { id: string; name: string };
    run: { id: string; status: "done" | "failed"; trigger: string; triggerDetail: string | null; output: string | null; error: string | null; startedAt: string };
    /** Link to the routine's thread, when the deployment has a public URL. */
    threadUrl?: string;
}

/** Problems with a delivery URL: https only (http too for private endpoints when allowed). */
export function deliveryUrlProblem(raw: string, allowHttp: boolean): string | undefined {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return "not a valid URL";
    }
    if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) return "use an https:// URL";
    if (url.username || url.password) return "credentials in the URL are not allowed";
    return undefined;
}

/** Slack's mrkdwn treats `<...>` as links and mentions (`<!channel>`); bot output must not ping anyone. */
export function slackEscape(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The request body for each delivery type. */
export function deliveryBody(type: DeliveryType, c: DeliveryContent): unknown {
    const status = c.run.status === "done" ? "finished" : "failed";
    const title = `${c.routine.name} · ${c.bot.name} ${status}${c.run.triggerDetail ? ` (${c.run.triggerDetail})` : ""}`;
    const text = (c.run.status === "done" ? c.run.output : c.run.error) ?? "";
    switch (type) {
        case "slack":
            return {
                text: `*${slackEscape(title)}*\n${slackEscape(text.slice(0, 2900))}${text.length > 2900 ? "…" : ""}${c.threadUrl ? `\n<${c.threadUrl}|Open in Copilot Bots>` : ""}`,
                unfurl_links: false,
                unfurl_media: false,
            };
        case "teams":
            // Teams Workflows ("When a Teams webhook request is received") take an Adaptive Card.
            return {
                type: "message",
                attachments: [
                    {
                        contentType: "application/vnd.microsoft.card.adaptive",
                        content: {
                            $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                            type: "AdaptiveCard",
                            version: "1.4",
                            body: [
                                { type: "TextBlock", text: title, weight: "Bolder", wrap: true },
                                { type: "TextBlock", text: text.slice(0, 8000), wrap: true },
                            ],
                            actions: c.threadUrl ? [{ type: "Action.OpenUrl", title: "Open in Copilot Bots", url: c.threadUrl }] : [],
                        },
                    },
                ],
            };
        case "webhook":
            return { type: "routine.run", ...c };
    }
}
