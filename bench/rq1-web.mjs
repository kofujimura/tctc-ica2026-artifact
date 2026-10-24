#!/usr/bin/env node
// RQ1, web-API enforcement point. The Next.js starter's protected route
// authenticates the wallet with Sign-In with Ethereum and then, on every
// request, asks the MCP role service whether that address holds the role;
// only then does it call the model API. This script drives exactly that
// authorization path — the same server binary, a starter-shaped config, the
// same `check_role` call — against the evaluation fixture, so the row is
// measured rather than asserted. Subject authentication (SIWE) and the
// downstream model call are outside the authorization decision and are not
// exercised here; the code they cost is recorded from source.
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, runMeta, write, sleep, artifact, MCP_BIN, STARTER_DIR } from "../lib/chain.mjs";
import { loadFixtures } from "../lib/fixtures.mjs";
import { StdioClient } from "../lib/stdio-client.mjs";
import { jsonlWriter, stamp } from "../lib/jsonl.mjs";

const a = parseArgs(process.argv.slice(2), { fixtures: "out/fixtures.local.json", label: undefined, rpc: undefined, out: undefined, "expiry-seconds": "5" });
const f = loadFixtures(a.fixtures, a.rpc);
const label = a.label ?? f.meta.label;
const out = a.out ?? `out/rq1-web.${label}.${stamp()}.jsonl`;
const w = jsonlWriter(out);
w({ type: "meta", kind: "rq1-web", label, ...runMeta({ fixtures: a.fixtures, rpcUrl: f.rpcUrl, chainId: f.chainId }) });
console.log(`RQ1 web API → ${out}`);

const ctAbi = artifact("AgentControlTokens").abi, expAbi = artifact("ExpiringControlTokens").abi;
const pollingInterval = f.chainId === 31337 ? 50 : 1000;
const expirySeconds = Number(a["expiry-seconds"]);
const subject = f.subject.address, ct0 = f.controlTokens[0];

const grant = () => write(f.issuer, ct0, ctAbi, "mint", [subject, 1n, 1n], { pollingInterval });
const revoke = () => write(f.issuer, ct0, ctAbi, "burnByIssuer", [subject, 1n, 1n], { pollingInterval });
const held = async () => (await f.issuer.pub.readContract({ address: ct0, abi: ctAbi, functionName: "balanceOf", args: [subject, 1n] })) > 0n;
const timedGrant = async () => {
  const b = await f.issuer.pub.getBlock();
  return write(f.issuer, f.expiringControlToken, expAbi, "mint", [subject, 1n, BigInt(Number(b.timestamp) + expirySeconds)], { pollingInterval });
};
const expiredOnChain = async () =>
  (await f.issuer.pub.readContract({ address: f.expiringControlToken, abi: expAbi, functionName: "balanceOf", args: [subject, 1n] })) === 0n;
async function waitExpired() { const t0 = Date.now(); while (!(await expiredOnChain())) { if (Date.now() - t0 > (expirySeconds + 180) * 1000) throw new Error("expiry timeout"); await sleep(500); } }

// Starter-shaped config (config/tctc.config.json in the web starter), with the
// role resolved from the target contract itself via IERC7303 discovery.
const dir = mkdtempSync(join(tmpdir(), "tctc-rq1web-"));
function configFor(target) {
  const cfg = {
    chains: { [`chain-${f.chainId}`]: { chainId: f.chainId, rpcUrl: f.rpcUrl } },
    defaultChain: `chain-${f.chainId}`,
    self: { address: subject },
    roles: { BENCH_ROLE: { description: "May call the protected API route.", target: { address: target } } },
  };
  const p = join(dir, `tctc-${target.slice(2, 8)}.json`);
  const text = JSON.stringify(cfg, null, 2);
  writeFileSync(p, text);
  return { path: p, lines: text.split("\n").length };
}
async function open(configPath) {
  const c = new StdioClient(process.execPath, [MCP_BIN, "--config", configPath, "--no-cache"], { onStderr: () => {} });
  await Promise.race([c.initialize(), c.exited.then((x) => { throw new Error(`tctc-mcp exited ${x.code}: ${c.stderr}`); })]);
  return c;
}
// What the route does: check_role(address) → 403 unless hasRole.
async function routeVerdict(client) {
  const r = await client.callTool("check_role", { role: "BENCH_ROLE", subject: { address: subject } }, 60_000);
  if (r.result?.isError) return "error";
  try {
    const payload = JSON.parse(r.result.content.find((c) => c.type === "text").text);
    return payload.hasRole ? "allow (200)" : "deny (403)";
  } catch { return "unparseable"; }
}

if (await held()) await revoke();
const c1cfg = configFor(f.targets.bindings1);
const c1 = await open(c1cfg.path);
const before = await routeVerdict(c1);
await grant(); const useAfterGrant = await routeVerdict(c1);
await revoke(); const useAfterRevoke = await routeVerdict(c1);
await c1.close();
const c2cfg = configFor(f.targets.expiring);
const c2 = await open(c2cfg.path);
await timedGrant(); const useAfterTimedGrant = await routeVerdict(c2);
await waitExpired(); const useAfterExpiry = await routeVerdict(c2);
await c2.close();
if (!(await held())) await grant(); // restore for other experiments

// Source-level cost of the starter, counted from the repository.
const starter = STARTER_DIR;
const countLines = (p) => { try { return readFileSync(join(starter, p), "utf8").split("\n").length; } catch { return null; } };
const authLines = (countLines("src/lib/auth.ts") ?? 0) + (countLines("src/lib/session.ts") ?? 0);
const row = {
  type: "rq1", label, target: "web API route (SIWE + MCP role service)",
  before, useAfterGrant, useAfterRevoke, useAfterTimedGrant, useAfterExpiry,
  targetCode: "8 lines in the protected route (check + 403)",
  policyLines: c1cfg.lines, adminCode: 0,
  subjectAuthLines: authLines, routeLines: countLines("src/app/api/chat/route.ts"),
  note: "SIWE authentication and the downstream model call are outside the authorization decision",
  pass: before === "deny (403)" && useAfterGrant === "allow (200)" && useAfterRevoke === "deny (403)" &&
        useAfterTimedGrant === "allow (200)" && useAfterExpiry === "deny (403)",
};
w(row);
console.log(`  ${row.pass ? "✅" : "❌"} web API route            before ${before} / grant ${useAfterGrant} / revoke ${useAfterRevoke} / timed ${useAfterTimedGrant} / expiry ${useAfterExpiry}`);
console.log(`     policy config ${c1cfg.lines} lines, enforcement 8 lines in the route, SIWE authentication ${authLines} lines, admin code 0`);
console.log("done");
