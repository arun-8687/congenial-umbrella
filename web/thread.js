import { h, clear, icon, iconButton, get, post, patch, del, api, markdown, avatar, clock, dayLabel, toast, errorText, bytes, modal, confirmDialog } from "./lib.js";
import { S, on, bot, botName, statusOf, navigate, setProfile, topbar, refreshThreads } from "./app.js";
import { openSkillEditor } from "./pages.js";

const NEAR_BOTTOM = 160;

/** Renders one thread (DM, group, task or routine) and keeps it live. Returns an unmount function. */
export async function renderThread(root, threadId) {
    let data = await get(`/api/threads/${threadId}`);
    let thread = data.thread;
    const approvals = new Map(data.approvals.map((a) => [a.id, a]));
    const streams = new Map(); // streamId -> live bubble
    const pendingUploads = [];

    const members = () => thread.botIds.map((id) => bot(id)).filter(Boolean);
    const isMember = (id) => thread.botIds.includes(id);
    const lead = () => bot(thread.botIds[0]);

    // ---------------------------------------------------------------- layout
    const list = h("div.messages-inner", { role: "log", "aria-live": "polite" });
    const scroller = h("div.messages", list);
    const workingEl = h("div");
    const attachRow = h("div.attachments");
    const textarea = h("textarea", { rows: 1, placeholder: placeholder(), "aria-label": "Message" });
    const fileInput = h("input", { type: "file", multiple: true, hidden: true, onChange: () => addFiles([...fileInput.files]) });
    const sendBtn = h("button.send", { type: "button", "aria-label": "Send", title: "Send (Enter)" }, icon("send"));
    const micBtn = iconButton("mic", "Dictate", () => toggleDictation(), { class: "mic" });
    const menu = h("div.mention-menu", { hidden: true });
    const composer = h(
        "div.composer",
        menu,
        attachRow,
        textarea,
        h(
            "div.tools",
            iconButton("clip", "Attach files", () => fileInput.click()),
            micBtn,
            h("span.hint", thread.kind === "group" ? "@mention a bot to hand it the message" : ""),
            h("span.grow"),
            sendBtn,
            fileInput,
        ),
    );

    function placeholder() {
        if (thread.kind === "group") return `Message ${thread.title} — @mention to address a bot`;
        return `Message ${lead()?.name ?? "bot"}…`;
    }

    function header() {
        const working = thread.botIds.some((id) => statusOf(id) === "working" && S.statuses[id]?.threadId === thread.id);
        const sub =
            thread.kind === "group"
                ? members().map((b) => b.name).join(", ")
                : thread.kind === "task"
                  ? `Task · ${data.task?.status?.replace("_", " ") ?? ""}`
                  : thread.kind === "routine"
                    ? "Routine runs"
                    : lead()?.title ?? "";
        return topbar(
            thread.title,
            sub,
            h("div.stack", members().slice(0, 4).map((b) => avatar(b, "sm", statusOf(b.id)))),
            working ? h("button.btn.sm", { type: "button", onClick: stop }, icon("stop"), "Stop") : null,
            iconButton("sparkle", "Teach a skill from this thread", draftSkill),
            iconButton("share", "Share link", share),
            iconButton("download", "Export as Markdown", () => (location.href = `/api/threads/${thread.id}/export`)),
            thread.kind === "group" ? iconButton("edit", "Rename or change members", editGroup) : null,
            thread.kind === "group" || thread.kind === "task" ? iconButton("archive", "Archive", archive) : null,
            iconButton("panel", "Bot profile", () => setProfile(S.profileBotId ? null : (thread.botIds[0] ?? null))),
        );
    }

    const headerSlot = h("div", header());
    const banner = h("div");
    clear(root, headerSlot, banner, scroller, workingEl, h("div.composer-wrap", composer));
    renderBanner();
    if (S.profileBotId && !isMember(S.profileBotId)) setProfile(thread.botIds[0] ?? null);

    function renderBanner() {
        clear(banner);
        if (thread.kind === "task" && data.task) {
            const t = data.task;
            banner.append(
                h(
                    "div.card",
                    { style: { margin: "12px 20px 0", display: "flex", gap: "10px", alignItems: "center" } },
                    h("span.tag", { class: t.status === "done" ? "ok" : t.status === "failed" ? "danger" : "warn" }, t.status.replace("_", " ")),
                    h("span.grow.small.muted", `Assigned to ${botName(t.assignee)} by ${t.createdBy === S.me.login ? "you" : botName(t.createdBy)}`),
                    t.sourceThreadId ? h("button.btn.sm.ghost", { type: "button", onClick: () => navigate(`#/t/${t.sourceThreadId}`) }, "Open source thread") : null,
                    t.status === "in_progress" || t.status === "open" ? h("button.btn.sm", { type: "button", onClick: cancelTask }, "Cancel") : null,
                ),
            );
        }
    }

    // ---------------------------------------------------------------- messages
    let lastDay = "";
    function renderMessages(messages) {
        clear(list);
        lastDay = "";
        if (!messages.length) list.append(welcome());
        for (const m of messages) appendMessage(m, false);
        scrollToBottom(true);
    }

    function welcome() {
        const b = lead();
        if (!b) return h("div.welcome", h("p", "Say hello."));
        const starters = [];
        starters.push("What can you help me with?");
        if (b.builtinTools?.includes("web_search")) starters.push("Research the latest GitHub Copilot features and summarize them");
        if (b.canMessage?.length) starters.push("Delegate a quick competitive analysis to the right teammate");
        if (b.computer) starters.push("Run a script that lists the files on your computer");
        if (b.memory) starters.push("Remember that I prefer short bullet-point answers");
        starters.push("Set up a routine every weekday at 9am to send me a standup summary");
        if (thread.kind === "group") starters.splice(0, starters.length, `@${thread.botIds[0]} kick things off with a plan`, "Everyone: introduce yourselves and what you'd handle");
        return h(
            "div.welcome",
            thread.kind === "group" ? h("div.stack", members().map((x) => avatar(x, "lg"))) : avatar(b, "lg"),
            h("h2", thread.kind === "group" ? thread.title : b.name),
            h("p", thread.kind === "group" ? `A group chat with ${members().map((x) => x.name).join(", ")}.` : `${b.title ? b.title + " · " : ""}${b.description}`),
            h("div.chips", starters.map((s) => h("button.chip", { type: "button", onClick: () => { textarea.value = s; textarea.focus(); autosize(); } }, s))),
        );
    }

    function appendMessage(m, animate = true) {
        list.querySelector(".welcome")?.remove();
        const day = dayLabel(m.createdAt);
        if (day !== lastDay) {
            list.append(h("div.day-sep", day));
            lastDay = day;
        }
        const el = messageEl(m);
        if (animate) el.style.animation = "fade .15s ease-out";
        list.append(el);
        return el;
    }

    function messageEl(m) {
        if (m.authorType === "system") return systemEl(m);
        if (m.authorType === "user") {
            return h(
                "div.msg.user",
                { dataset: { id: m.id } },
                actions(m),
                h("div.body", markdown(m.text, { mentions: isMember }), attachmentsEl(m.meta.attachments)),
            );
        }
        const b = bot(m.authorId) ?? { name: m.authorId };
        return h(
            "div.msg.bot",
            { dataset: { id: m.id } },
            avatar(b),
            h(
                "div.body",
                h("div.head", h("span.author", b.name), b.title ? h("span.role", b.title) : null, h("span.time", clock(m.createdAt))),
                m.meta.reasoning ? reasoningEl(m.meta.reasoning) : null,
                m.meta.tools?.length ? toolsEl(m.meta.tools, false) : null,
                h(`div${m.meta.taskId ? ".task-result" : ""}`, markdown(m.text, { mentions: isMember })),
                actions(m),
            ),
        );
    }

    function systemEl(m) {
        if (m.meta.approvalId) {
            const a = approvals.get(m.meta.approvalId);
            return h("div.msg.system.notice", { dataset: { id: m.id, approval: m.meta.approvalId } }, h("div.body", approvalCard(m, a)));
        }
        const notice = m.authorId === "routine" || m.meta.error;
        return h(`div.msg.system${notice ? ".notice" : ""}`, { dataset: { id: m.id } }, h("div.body", markdown(m.text), m.meta.error ? h("div.row", { style: { marginTop: "8px" } }, h("button.btn.sm", { type: "button", onClick: retry }, icon("refresh"), "Retry")) : null));
    }

    function approvalCard(m, a) {
        const status = a?.status ?? "pending";
        const decide = async (approve, always = false) => {
            try {
                await post(`/api/approvals/${m.meta.approvalId}`, { approve, always });
            } catch (err) {
                toast("Could not record decision", errorText(err), { error: true });
            }
        };
        const b = a ? bot(a.botId) : null;
        return h(
            `div.approval.${status}`,
            markdown(m.text),
            status === "pending"
                ? h(
                      "div.row",
                      h("button.btn.primary.sm", { type: "button", onClick: () => decide(true) }, icon("check"), "Approve"),
                      b?.editable ? h("button.btn.sm", { type: "button", onClick: () => decide(true, true) }, `Always allow ${a.kind}`) : null,
                      h("button.btn.sm.danger", { type: "button", onClick: () => decide(false) }, "Deny"),
                  )
                : h("div.row", h("span.state", status === "approved" ? "✓ Approved" : status === "denied" ? "✕ Denied" : "Expired")),
        );
    }

    function reasoningEl(text, open = false) {
        return h("details.activity", { open }, h("summary", icon("brain"), "Thought process"), h("div.reasoning", text));
    }

    function toolsEl(tools, live) {
        const done = tools.filter((t) => t.success !== undefined).length;
        const label = live && done < tools.length ? `Working · ${tools.at(-1).tool}` : `Used ${tools.length} tool${tools.length === 1 ? "" : "s"}`;
        return h(
            "details.activity",
            { open: live },
            h("summary", live && done < tools.length ? h("span.spin") : icon("tool"), label),
            h(
                "div.items",
                tools.map((t) =>
                    h(
                        "div.tool-line",
                        h(`span.state${t.success === true ? ".ok" : t.success === false ? ".fail" : ""}`, t.success === undefined ? "…" : t.success ? "✓" : "✕"),
                        h("span.name", prettyTool(t.tool)),
                        t.detail ? h("span.detail", t.detail) : null,
                    ),
                ),
            ),
        );
    }

    function attachmentsEl(files) {
        if (!files?.length) return null;
        return h(
            "div.attachments",
            files.map((f) =>
                f.mimeType.startsWith("image/")
                    ? h("a.attachment.image", { href: `/api/uploads/${f.id}`, target: "_blank" }, h("img", { src: `/api/uploads/${f.id}`, alt: f.name }))
                    : h("a.attachment", { href: `/api/uploads/${f.id}`, target: "_blank" }, icon("file"), h("span.ellipsis", f.name), h("span.muted", bytes(f.size))),
            ),
        );
    }

    function actions(m) {
        const speak = () => {
            if (!("speechSynthesis" in window)) return toast("Read aloud isn't supported in this browser");
            speechSynthesis.cancel();
            speechSynthesis.speak(new SpeechSynthesisUtterance(m.text.replace(/[*_`#>]/g, "")));
        };
        return h(
            "div.msg-actions",
            iconButton("copy", "Copy", async () => {
                await navigator.clipboard?.writeText(m.text);
                toast("Copied");
            }),
            m.authorType === "bot" ? iconButton("speaker", "Read aloud", speak) : null,
        );
    }

    // ---------------------------------------------------------------- streaming
    function streamBubble(e) {
        let s = streams.get(e.streamId);
        if (s) return s;
        const b = bot(e.botId) ?? { name: e.botId };
        const textEl = h("div.cursor");
        const toolsSlot = h("div");
        const reasoningSlot = h("div");
        const el = h(
            "div.msg.bot",
            avatar(b, "", "working"),
            h("div.body", h("div.head", h("span.author", b.name), b.title ? h("span.role", b.title) : null), reasoningSlot, toolsSlot, textEl),
        );
        s = { el, textEl, toolsSlot, reasoningSlot, text: "", reasoning: "", tools: [], raf: 0 };
        streams.set(e.streamId, s);
        list.querySelector(".welcome")?.remove();
        list.append(el);
        renderWorking();
        return s;
    }

    function paintStream(s) {
        if (s.raf) return;
        s.raf = requestAnimationFrame(() => {
            s.raf = 0;
            const stick = nearBottom();
            const md = markdown(s.text, { mentions: isMember });
            md.classList.add("cursor");
            s.textEl.replaceWith(md);
            s.textEl = md;
            clear(s.reasoningSlot, s.reasoning ? reasoningEl(s.reasoning, !s.text) : null);
            clear(s.toolsSlot, s.tools.length ? toolsEl(s.tools, true) : null);
            if (stick) scrollToBottom();
        });
    }

    function renderWorking() {
        const busy = thread.botIds.filter((id) => statusOf(id) !== "idle" && S.statuses[id]?.threadId === thread.id);
        clear(
            workingEl,
            busy.length && streams.size === 0
                ? h(
                      "div.working-line",
                      { style: { maxWidth: "820px", margin: "0 auto", width: "100%" } },
                      h("span.spin"),
                      h("span.shimmer", busy.map((id) => `${botName(id)} is ${statusOf(id) === "waiting" ? "waiting for your approval" : "working"}`).join(" · ")),
                  )
                : null,
        );
        clear(headerSlot, header());
    }

    // ---------------------------------------------------------------- live events
    const off = on((e) => {
        switch (e.type) {
            case "message.delta": {
                if (e.threadId !== thread.id) return;
                const s = streamBubble(e);
                if (e.channel === "reasoning") s.reasoning += e.text;
                else s.text += e.text;
                paintStream(s);
                break;
            }
            case "message.tool": {
                if (e.threadId !== thread.id) return;
                const s = streamBubble(e);
                if (e.phase === "start") s.tools.push({ tool: e.tool, detail: e.detail });
                else {
                    const t = [...s.tools].reverse().find((x) => x.tool === e.tool && x.success === undefined);
                    if (t) t.success = e.success;
                }
                paintStream(s);
                break;
            }
            case "message.created": {
                const m = e.message;
                if (m.threadId !== thread.id) return;
                if (list.querySelector(`[data-id="${m.id}"]`)) return;
                const stick = nearBottom() || m.authorType === "user";
                const s = e.streamId && streams.get(e.streamId);
                if (s) {
                    cancelAnimationFrame(s.raf);
                    const el = messageEl(m);
                    s.el.replaceWith(el);
                    streams.delete(e.streamId);
                } else appendMessage(m);
                data.messages.push(m);
                markRead(m.seq);
                renderWorking();
                if (stick) scrollToBottom();
                break;
            }
            case "approval.created":
            case "approval.decided": {
                approvals.set(e.approval.id, e.approval);
                const holder = list.querySelector(`[data-approval="${e.approval.id}"] .body`);
                const m = data.messages.find((x) => x.meta.approvalId === e.approval.id);
                if (holder && m) clear(holder, approvalCard(m, e.approval));
                break;
            }
            case "bot.status":
                if (isMember(e.botId)) renderWorking();
                break;
            case "thread.updated":
                if (e.thread.id === thread.id) {
                    thread = { ...thread, ...e.thread };
                    clear(headerSlot, header());
                }
                break;
            case "thread.deleted":
                if (e.threadId === thread.id) navigate("#/", true);
                break;
            case "task.updated":
                if (e.task.threadId === thread.id) {
                    data.task = e.task;
                    renderBanner();
                    clear(headerSlot, header());
                }
                break;
            case "bots.changed":
                clear(headerSlot, header());
                break;
        }
    });

    let readTimer;
    function markRead(seq) {
        if (document.visibilityState !== "visible") return;
        clearTimeout(readTimer);
        readTimer = setTimeout(() => {
            post(`/api/threads/${thread.id}/read`, { seq }).catch(() => {});
            const t = S.threads.find((x) => x.id === thread.id);
            if (t) t.unread = 0;
        }, 300);
    }

    // ---------------------------------------------------------------- composer
    function autosize() {
        textarea.style.height = "auto";
        textarea.style.height = Math.min(textarea.scrollHeight, 240) + "px";
        sendBtn.disabled = !textarea.value.trim() && !pendingUploads.length;
    }

    async function send() {
        const text = textarea.value.trim();
        if (!text && !pendingUploads.length) return;
        if (pendingUploads.some((u) => !u.id)) return toast("Still uploading…");
        sendBtn.disabled = true;
        try {
            await post(`/api/threads/${thread.id}/messages`, { text: text || "(see attached)", attachments: pendingUploads.map((u) => u.id) });
            textarea.value = "";
            pendingUploads.length = 0;
            renderAttachRow();
            autosize();
        } catch (err) {
            toast("Message not sent", errorText(err), { error: true });
            sendBtn.disabled = false;
        }
    }

    async function addFiles(files) {
        for (const f of files) {
            const item = { name: f.name, size: f.size, mimeType: f.type || "application/octet-stream", id: null, preview: f.type.startsWith("image/") ? URL.createObjectURL(f) : null };
            pendingUploads.push(item);
            renderAttachRow();
            try {
                const r = await api("POST", "/api/uploads", f, { headers: { "Content-Type": item.mimeType, "X-Filename": encodeURIComponent(f.name) } });
                item.id = r.id;
            } catch (err) {
                pendingUploads.splice(pendingUploads.indexOf(item), 1);
                toast(`Upload failed: ${f.name}`, errorText(err), { error: true });
            }
            renderAttachRow();
            autosize();
        }
        fileInput.value = "";
    }

    function renderAttachRow() {
        clear(
            attachRow,
            pendingUploads.map((u) =>
                h(
                    `div.attachment${u.preview ? ".image" : ""}`,
                    u.preview ? h("img", { src: u.preview, alt: u.name, style: { maxHeight: "64px" } }) : [icon("file"), h("span.ellipsis", u.name)],
                    u.id ? null : h("span.spin"),
                    h("button.x", { type: "button", "aria-label": `Remove ${u.name}`, onClick: () => { pendingUploads.splice(pendingUploads.indexOf(u), 1); renderAttachRow(); autosize(); } }, "×"),
                ),
            ),
        );
    }

    // @mention autocomplete
    let menuItems = [];
    let menuSel = 0;
    function updateMentionMenu() {
        const before = textarea.value.slice(0, textarea.selectionStart);
        const m = /@([A-Za-z0-9-]*)$/.exec(before);
        const pool = thread.kind === "group" ? members() : [];
        if (!m || !pool.length) {
            menu.hidden = true;
            menuItems = [];
            return;
        }
        const q = m[1].toLowerCase();
        menuItems = pool.filter((b) => b.id.includes(q) || b.name.toLowerCase().includes(q)).slice(0, 6);
        menuSel = Math.min(menuSel, Math.max(0, menuItems.length - 1));
        menu.hidden = menuItems.length === 0;
        clear(
            menu,
            menuItems.map((b, i) =>
                h("button", { type: "button", class: i === menuSel ? "sel" : "", onMousedown: (e) => { e.preventDefault(); pickMention(b); } }, avatar(b, "sm"), h("span", b.name), h("span.muted.small", `@${b.id}`)),
            ),
        );
    }
    function pickMention(b) {
        const pos = textarea.selectionStart;
        const before = textarea.value.slice(0, pos).replace(/@([A-Za-z0-9-]*)$/, `@${b.id} `);
        textarea.value = before + textarea.value.slice(pos);
        textarea.selectionStart = textarea.selectionEnd = before.length;
        menu.hidden = true;
        textarea.focus();
        autosize();
    }

    textarea.addEventListener("input", () => {
        autosize();
        updateMentionMenu();
    });
    textarea.addEventListener("keydown", (e) => {
        if (!menu.hidden && menuItems.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                menuSel = (menuSel + (e.key === "ArrowDown" ? 1 : -1) + menuItems.length) % menuItems.length;
                updateMentionMenu();
                return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickMention(menuItems[menuSel]);
                return;
            }
            if (e.key === "Escape") {
                menu.hidden = true;
                return;
            }
        }
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            void send();
        }
    });
    textarea.addEventListener("paste", (e) => {
        const files = [...(e.clipboardData?.files ?? [])];
        if (files.length) {
            e.preventDefault();
            void addFiles(files);
        }
    });
    composer.addEventListener("dragover", (e) => {
        e.preventDefault();
        composer.classList.add("drag");
    });
    composer.addEventListener("dragleave", () => composer.classList.remove("drag"));
    composer.addEventListener("drop", (e) => {
        e.preventDefault();
        composer.classList.remove("drag");
        void addFiles([...(e.dataTransfer?.files ?? [])]);
    });
    sendBtn.addEventListener("click", () => void send());

    // voice dictation (Web Speech API, where the browser supports it)
    let recognition = null;
    function toggleDictation() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) return toast("Dictation isn't supported in this browser");
        if (recognition) {
            recognition.stop();
            return;
        }
        recognition = new SR();
        recognition.interimResults = true;
        recognition.continuous = true;
        const base = textarea.value ? textarea.value + " " : "";
        recognition.onresult = (ev) => {
            textarea.value = base + [...ev.results].map((r) => r[0].transcript).join("");
            autosize();
        };
        recognition.onend = () => {
            recognition = null;
            micBtn.classList.remove("on");
        };
        micBtn.classList.add("on");
        recognition.start();
    }

    // ---------------------------------------------------------------- actions
    async function stop() {
        await post(`/api/threads/${thread.id}/stop`).catch(() => {});
    }
    async function retry() {
        const lastUser = [...data.messages].reverse().find((m) => m.authorType === "user");
        if (!lastUser) return;
        await post(`/api/threads/${thread.id}/messages`, { text: lastUser.text, attachments: (lastUser.meta.attachments ?? []).map((a) => a.id) }).catch((err) => toast("Retry failed", errorText(err), { error: true }));
    }
    async function share() {
        try {
            const r = await post(`/api/threads/${thread.id}/share`);
            await navigator.clipboard?.writeText(r.url).catch(() => {});
            modal("Share link", [
                h("p.muted", "Anyone with this link can read this thread (approvals and tool details are hidden). Revoke it any time."),
                h("input.input", { value: r.url, readOnly: true, onFocus: (e) => e.target.select() }),
            ], [
                h("button.btn.danger", { type: "button", onClick: async (e) => { await del(`/api/threads/${thread.id}/share`); e.target.closest(".overlay").remove(); toast("Sharing turned off"); } }, "Revoke all links"),
                h("button.btn.primary", { type: "button", onClick: (e) => e.target.closest(".overlay").remove() }, "Done"),
            ]);
        } catch (err) {
            toast("Could not share", errorText(err), { error: true });
        }
    }
    async function draftSkill() {
        const candidates = members();
        if (!candidates.length) return;
        const pick = candidates.length === 1 ? candidates[0].id : await chooseBot(candidates, "Which bot should write the skill?");
        if (!pick) return;
        toast("Drafting a skill…", "The bot is turning this thread into reusable steps.");
        try {
            const draft = await post(`/api/threads/${thread.id}/draft-skill`, { botId: pick });
            openSkillEditor({ ...draft, status: "draft" }, true);
        } catch (err) {
            toast("Could not draft a skill", errorText(err), { error: true });
        }
    }
    async function editGroup() {
        const title = h("input.input", { value: thread.title });
        const checks = S.bots.map((b) => h("label", h("input", { type: "checkbox", value: b.id, checked: isMember(b.id) }), `${b.avatar ?? ""} ${b.name}`));
        const m = modal("Group chat", h("div.form", h("label.field", "Name", title), h("div.field", h("div.small.muted", "Members (2–6)"), h("div.checks", checks))), [
            h("button.btn.ghost", { type: "button", onClick: () => m.close() }, "Cancel"),
            h("button.btn.primary", { type: "button", onClick: async () => {
                try {
                    const botIds = checks.map((c) => c.querySelector("input")).filter((i) => i.checked).map((i) => i.value);
                    thread = await patch(`/api/threads/${thread.id}`, { title: title.value, botIds });
                    m.close();
                    clear(headerSlot, header());
                } catch (err) {
                    toast("Could not save", errorText(err), { error: true });
                }
            } }, "Save"),
        ]);
    }
    async function archive() {
        if (!(await confirmDialog("Archive thread?", "It disappears from the sidebar; search still finds it.", "Archive"))) return;
        await patch(`/api/threads/${thread.id}`, { archived: true });
        await refreshThreads();
        navigate("#/", true);
    }
    async function cancelTask() {
        await post(`/api/tasks/${data.task.id}/cancel`).catch((err) => toast("Could not cancel", errorText(err), { error: true }));
    }

    // ---------------------------------------------------------------- scrolling
    function nearBottom() {
        return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR_BOTTOM;
    }
    function scrollToBottom(instant = false) {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: instant ? "auto" : "smooth" });
    }

    renderMessages(data.messages);
    renderWorking();
    autosize();
    if (data.messages.length) markRead(data.messages.at(-1).seq);
    textarea.focus();

    return () => {
        off();
        recognition?.stop();
        clearTimeout(readTimer);
    };
}

function prettyTool(name) {
    const map = {
        web_search: "Searched the web",
        web_fetch: "Read a page",
        ask_bot: "Asked a teammate",
        assign_task: "Handed off a task",
        list_bots: "Checked teammates",
        remember: "Saved to memory",
        forget: "Removed a memory",
        save_routine: "Saved a routine",
        skill: "Loaded a skill",
        bash: "Ran a command",
        view: "Read a file",
        create: "Created a file",
        edit: "Edited a file",
        glob: "Listed files",
        grep: "Searched files",
    };
    return map[name] ?? name;
}

function chooseBot(bots, title) {
    return new Promise((resolve) => {
        let picked = null;
        const m = modal(title, h("div", bots.map((b) => h("button.palette-pick.roster-item", { type: "button", onClick: () => { picked = b.id; m.close(); } }, avatar(b), h("span.who", h("span.name", b.name), h("span.title", b.title ?? ""))))), null, { onClose: () => resolve(picked) });
    });
}

