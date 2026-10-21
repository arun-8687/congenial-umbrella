#!/usr/bin/env node
// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0) for tests: one read-only tool,
// one tool that changes something, and one that reports what credential it was started with.
import { createInterface } from "node:readline";

const tools = [
    { name: "get_ticket", description: "Read a ticket by id", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, annotations: { readOnlyHint: true } },
    { name: "close_ticket", description: "Close a ticket", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, annotations: { readOnlyHint: false, destructiveHint: true } },
    { name: "whoami", description: "Which credential this server received", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
    let req;
    try {
        req = JSON.parse(line);
    } catch {
        return;
    }
    if (req.id === undefined) return; // notifications
    const result = (r) => send({ jsonrpc: "2.0", id: req.id, result: r });
    switch (req.method) {
        case "initialize":
            return result({ protocolVersion: req.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-tickets", version: "1.0.0" } });
        case "tools/list":
            return result({ tools });
        case "tools/call": {
            const { name, arguments: args } = req.params;
            const text =
                name === "get_ticket" ? `Ticket ${args.id}: printer on fire (open)` :
                name === "close_ticket" ? `Closed ticket ${args.id}` :
                name === "whoami" ? `token=${process.env.TICKETS_TOKEN ?? "none"} secret_key=${process.env.SECRET_KEY ?? "none"}` : "unknown tool";
            return result({ content: [{ type: "text", text }] });
        }
        case "ping":
            return result({});
        default:
            return send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `no method ${req.method}` } });
    }
});
