#!/usr/bin/env node
// Minimal web API with the starter's enforcement path: Sign-In with Ethereum
// establishes the caller's address, and every protected request re-asks the
// MCP role service (tctc-mcp, check_role) before doing work. The model call
// of the starter is replaced by a deterministic summarizer so that the study
// needs no third-party model key; the authorization path is unchanged.
//   env: WEB_API_PORT, RPC, CHAIN_ID, TARGET, LOG_FILE, TCTC_MCP_BIN
import http from "node:http";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createPublicClient, http as viemHttp, defineChain } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { StdioClient } from "./stdio-client.mjs";

const PORT = Number(process.env.WEB_API_PORT ?? 0);
const RPC = process.env.RPC, CHAIN_ID = Number(process.env.CHAIN_ID), TARGET = process.env.TARGET, LOG = process.env.LOG_FILE;
const chain = defineChain({ id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: viemHttp(RPC), cacheTime: 0 });

// role service, exactly as the starter spawns it (read-only, target discovery, no cache)
const dir = mkdtempSync(join(tmpdir(), "tctc-webapi-"));
const cfgPath = join(dir, "tctc.json");
writeFileSync(cfgPath, JSON.stringify({ chains: { c: { chainId: CHAIN_ID, rpcUrl: RPC } }, defaultChain: "c",
  roles: { BENCH_ROLE: { description: "May call the protected route.", target: { address: TARGET } } } }));
const tctc = new StdioClient(process.execPath, [process.env.TCTC_MCP_BIN, "--config", cfgPath, "--no-cache"], { onStderr: () => {} });
await tctc.initialize();
async function hasRole(address) {
  const r = await tctc.callTool("check_role", { role: "BENCH_ROLE", subject: { address } }, 60_000);
  if (r.result?.isError) throw new Error("role service unavailable");
  return JSON.parse(r.result.content.find((c) => c.type === "text").text).hasRole === true;
}

const nonces = new Set(), sessions = new Map();
const log = (o) => LOG && appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...o }) + "\n");
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const summarize = (text) => text.split(/\n\s*\n/).map((p) => p.trim().split(/(?<=[.!?])\s/)[0]).filter(Boolean).slice(0, 6).join(" ");

const server = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const cookie = Object.fromEntries((req.headers.cookie ?? "").split(";").map((s) => s.trim().split("=")).filter((x) => x[0]));
  try {
    if (req.method === "GET" && req.url === "/api/auth/nonce") {
      const nonce = randomBytes(16).toString("hex"); nonces.add(nonce); return json(res, 200, { nonce });
    }
    if (req.method === "POST" && req.url === "/api/auth/verify") {
      const { message, signature } = JSON.parse(body);
      const fields = parseSiweMessage(message);
      if (!fields.nonce || !nonces.delete(fields.nonce)) return json(res, 401, { error: "bad nonce" });
      const ok = await pub.verifySiweMessage({ message, signature, nonce: fields.nonce });
      if (!ok) return json(res, 401, { error: "bad signature" });
      const token = randomBytes(24).toString("hex"); sessions.set(token, fields.address);
      res.setHeader("set-cookie", `session=${token}; HttpOnly`); return json(res, 200, { address: fields.address });
    }
    if (req.method === "POST" && req.url === "/api/summarize") {
      const address = sessions.get(cookie.session);
      if (!address) { log({ route: "summarize", status: 401 }); return json(res, 401, { error: "Verify wallet ownership before sending a prompt." }); }
      const { text } = JSON.parse(body);
      let held;
      try { held = await hasRole(address); } catch { log({ route: "summarize", status: 503, address }); return json(res, 503, { error: "authorization service unavailable" }); }
      if (!held) { log({ route: "summarize", status: 403, address }); return json(res, 403, { error: "This wallet does not hold the token required by the gate policy (BENCH_ROLE). Ask your principal to grant it." }); }
      log({ route: "summarize", status: 200, address });
      return json(res, 200, { output: summarize(String(text ?? "")) });
    }
    json(res, 404, { error: "not found" });
  } catch (e) { json(res, 500, { error: String(e.message) }); }
});
server.listen(PORT, "127.0.0.1", () => { process.stdout.write(`http://127.0.0.1:${server.address().port}\n`); });
process.on("SIGTERM", () => { tctc.close(); server.close(); process.exit(0); });
