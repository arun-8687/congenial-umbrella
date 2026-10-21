import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null | { type: string; text?: string }[];
    tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    tool_call_id?: string;
}

export interface ModelRequest {
    model: string;
    messages: ChatMessage[];
    tools?: { type: string; name?: string; function?: { name: string; description?: string } }[];
    stream?: boolean;
}

export type ModelReply = { text: string } | { toolCalls: { name: string; args: unknown }[] };

export type ModelScript = (req: ModelRequest, helpers: ScriptHelpers) => ModelReply;

export interface ScriptHelpers {
    /** Text of the latest user message (the platform's prompt). */
    lastUser: string;
    /** Results of tool calls since the latest user message, oldest first. */
    toolResults: { name: string; content: string }[];
    /** Names of the tools the runtime offered the model on this request. */
    tools: string[];
    system: string;
}

/**
 * A scripted, OpenAI-compatible chat-completions server. Pointing the real Copilot runtime at it (as a
 * BYOK provider) runs genuine turns, with real tool execution, permission requests, MCP servers and
 * streaming, while every model decision is deterministic. It also records exactly what the runtime
 * sends the model, so tests can assert on tool exposure and prompts.
 */
export class FakeModel {
    readonly requests: ModelRequest[] = [];
    script: ModelScript = () => ({ text: "ok" });
    private server: Server | undefined;
    private callId = 0;

    async start(): Promise<string> {
        this.server = createServer(async (req, res) => {
            let body = "";
            for await (const chunk of req) body += chunk;
            if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
                res.writeHead(404).end();
                return;
            }
            const request = JSON.parse(body) as ModelRequest;
            this.requests.push(request);
            let reply: ModelReply;
            try {
                reply = this.script(request, helpersFor(request));
            } catch (err) {
                reply = { text: `script error: ${(err as Error).message}` };
            }
            this.respond(request, reply, res);
        });
        await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
        return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/v1`;
    }

    async stop(): Promise<void> {
        await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
    }

    private respond(request: ModelRequest, reply: ModelReply, res: import("node:http").ServerResponse): void {
        const toolCalls =
            "toolCalls" in reply
                ? reply.toolCalls.map((c) => ({ id: `call_${++this.callId}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }))
                : undefined;
        const message = toolCalls ? { role: "assistant", content: null, tool_calls: toolCalls } : { role: "assistant", content: (reply as { text: string }).text };
        const finish = toolCalls ? "tool_calls" : "stop";
        const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
        const base = { id: "chatcmpl-fake", created: Math.floor(Date.now() / 1000), model: request.model };
        if (!request.stream) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: finish }], usage }));
            return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const chunk = (delta: unknown, finish_reason: string | null, extra = {}) =>
            res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`);
        if (toolCalls) {
            chunk({ role: "assistant", tool_calls: toolCalls.map((c, index) => ({ index, ...c })) }, null);
        } else {
            // Stream word by word so streaming paths are exercised.
            for (const piece of (message.content as string).match(/\S+\s*/g) ?? [""]) chunk({ role: "assistant", content: piece }, null);
        }
        chunk({}, finish, { usage });
        res.end("data: [DONE]\n\n");
    }
}

function textOf(content: ChatMessage["content"]): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((p) => p.text ?? "").join("");
    return "";
}

function helpersFor(req: ModelRequest): ScriptHelpers {
    const lastUserIndex = req.messages.map((m) => m.role).lastIndexOf("user");
    const names = new Map<string, string>();
    for (const m of req.messages) for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name);
    const toolResults = req.messages
        .slice(lastUserIndex + 1)
        .filter((m) => m.role === "tool")
        .map((m) => ({ name: names.get(m.tool_call_id ?? "") ?? "?", content: textOf(m.content) }));
    return {
        lastUser: lastUserIndex >= 0 ? textOf(req.messages[lastUserIndex]!.content) : "",
        toolResults,
        tools: (req.tools ?? []).map((t) => t.function?.name ?? t.name ?? t.type),
        system: req.messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n"),
    };
}
