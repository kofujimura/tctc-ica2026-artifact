#!/usr/bin/env node
// Agent-side MCP tool for the web API: `summarize(text)`. Holds the agent's
// wallet key, performs Sign-In with Ethereum once per session, and posts the
// text to the protected route. Not gated itself: the web API enforces.
//   env: WEB_API_URL, AGENT_PRIVATE_KEY, CHAIN_ID
import { stdin, stdout, env } from "node:process";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

const account = privateKeyToAccount(env.AGENT_PRIVATE_KEY);
const API = env.WEB_API_URL;
let cookie;
async function login() {
  const { nonce } = await (await fetch(`${API}/api/auth/nonce`)).json();
  const message = createSiweMessage({ address: account.address, chainId: Number(env.CHAIN_ID), domain: "127.0.0.1", nonce, uri: API, version: "1",
    statement: "Sign in to the release-note service." });
  const signature = await account.signMessage({ message });
  const r = await fetch(`${API}/api/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature }) });
  if (!r.ok) throw new Error(`sign-in failed: ${r.status}`);
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
}
async function summarize(text) {
  if (!cookie) await login();
  const r = await fetch(`${API}/api/summarize`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ text }) });
  const j = await r.json();
  if (!r.ok) return { isError: true, content: [{ type: "text", text: `HTTP ${r.status}: ${j.error}` }] };
  return { content: [{ type: "text", text: j.output }] };
}
const TOOLS = [{ name: "summarize", description: "Summarize a text through the release-note web service (requires the agent's wallet to hold BENCH_ROLE).",
  inputSchema: { type: "object", properties: { text: { type: "string", description: "Text to summarize" } }, required: ["text"] } }];
let buf = "";
const send = (m) => stdout.write(JSON.stringify(m) + "\n");
stdin.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) handle(JSON.parse(l)); } });
async function handle({ id, method, params }) {
  if (method === "initialize") return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "release-note-api", version: "1.0.0" } } });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    try { return send({ jsonrpc: "2.0", id, result: await summarize(String(params?.arguments?.text ?? "")) }); }
    catch (e) { return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: String(e.message) }] } }); }
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
}
