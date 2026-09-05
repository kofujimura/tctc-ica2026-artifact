#!/usr/bin/env node
// Upstream MCP fixture: minimal stdio server that appends one JSON line per
// tools/call it receives to $COUNT_FILE. "Upstream calls" in the fault
// experiments is the number of lines in that file.
import { appendFileSync } from "node:fs";
import { stdin, stdout, env } from "node:process";

const TOOLS = [
  { name: "echo", description: "echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "add", description: "add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
  { name: "shout", description: "uppercase text", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "delete_all", description: "destructive tool (must never be reached without ADMIN_ROLE)", inputSchema: { type: "object" } },
];

let buf = "";
stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) { try { handle(JSON.parse(line)); } catch { /* ignore */ } }
  }
});
const send = (m) => stdout.write(JSON.stringify(m) + "\n");
const text = (id, t) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: t }] } });

function handle({ id, method, params }) {
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } }, serverInfo: { name: "counting-server", version: "1.0.0" } } });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    const name = params?.name, args = params?.arguments ?? {};
    if (env.COUNT_FILE) appendFileSync(env.COUNT_FILE, JSON.stringify({ ts: Date.now(), id, name }) + "\n");
    if (name === "echo") return text(id, String(args.text ?? ""));
    if (name === "add") return text(id, String(Number(args.a) + Number(args.b)));
    if (name === "shout") return text(id, String(args.text ?? "").toUpperCase());
    if (name === "delete_all") return text(id, "deleted everything");
    return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${name}` } });
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
}
