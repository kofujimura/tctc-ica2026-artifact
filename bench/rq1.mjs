#!/usr/bin/env node
// RQ1: one credential type across heterogeneous enforcement points.
// For each target we run grant → use → revoke → use(denied) → timed grant →
// expiry(denied) with the SAME subject and the SAME credential collection,
// and record how much target-specific code/config was needed.
//   - smart-contract action: BenchTarget.act() (on-chain PEP)
//   - three independently packaged MCP servers wrapped by tctc-gate, unmodified
//     (@modelcontextprotocol/server-everything, server-memory, server-filesystem)
// The web-API starter (SIWE + role check) is exercised manually; its row is
// documented from source.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, runMeta, write, sleep, META_NS, artifact, GATE_BIN } from "../lib/chain.mjs";
import { loadFixtures } from "../lib/fixtures.mjs";
import { StdioClient } from "../lib/stdio-client.mjs";
import { jsonlWriter, stamp } from "../lib/jsonl.mjs";

const a = parseArgs(process.argv.slice(2), { fixtures: "out/fixtures.local.json", label: undefined, rpc: undefined, out: undefined, "expiry-seconds": "5" });
const f = loadFixtures(a.fixtures, a.rpc);
const label = a.label ?? f.meta.label;
const out = a.out ?? `out/rq1.${label}.${stamp()}.jsonl`;
const w = jsonlWriter(out);
w({ type: "meta", kind: "rq1", label, ...runMeta({ fixtures: a.fixtures, rpcUrl: f.rpcUrl, chainId: f.chainId }) });
console.log(`RQ1 → ${out}`);
const pollingInterval = f.chainId === 31337 ? 50 : 1000;
const expirySeconds = Number(a["expiry-seconds"]);
const ctAbi = artifact("AgentControlTokens").abi, expAbi = artifact("ExpiringControlTokens").abi, benchAbi = artifact("BenchTarget").abi;
const subject = f.subject.address;
const ct0 = f.controlTokens[0];

const grant = () => write(f.issuer, ct0, ctAbi, "mint", [subject, 1n, 1n], { pollingInterval });
const revoke = () => write(f.issuer, ct0, ctAbi, "burnByIssuer", [subject, 1n, 1n], { pollingInterval });
const held = async () => (await f.issuer.pub.readContract({ address: ct0, abi: ctAbi, functionName: "balanceOf", args: [subject, 1n] })) > 0n;
const timedGrant = async () => {
  const latest = await f.issuer.pub.getBlock();
  return write(f.issuer, f.expiringControlToken, expAbi, "mint", [subject, 1n, BigInt(Number(latest.timestamp) + expirySeconds)], { pollingInterval });
};
const expiredOnChain = async () =>
  (await f.issuer.pub.readContract({ address: f.expiringControlToken, abi: expAbi, functionName: "balanceOf", args: [subject, 1n] })) === 0n;
async function waitExpired() { const t0 = Date.now(); while (!(await expiredOnChain())) { if (Date.now() - t0 > (expirySeconds + 120) * 1000) throw new Error("expiry timeout"); await sleep(200); } }

const record = (target, r) => { w({ type: "rq1", label, target, ...r }); console.log(`  ${r.pass ? "✅" : "❌"} ${target.padEnd(28)} grant ${r.useAfterGrant} / revoke ${r.useAfterRevoke} / timed ${r.useAfterTimedGrant} / expiry ${r.useAfterExpiry}  config ${r.policyLines} lines, target code ${r.targetCode}`); };

// ---- 1. smart-contract PEP ----
{
  const actOk = async (who, target) => { try { await write(who, target, benchAbi, "act", [], { pollingInterval }); return "allow"; } catch { return "deny"; } };
  if (await held()) await revoke();
  const before = await actOk(f.subject, f.targets.bindings1);
  await grant(); const useAfterGrant = await actOk(f.subject, f.targets.bindings1);
  await revoke(); const useAfterRevoke = await actOk(f.subject, f.targets.bindings1);
  await timedGrant(); const useAfterTimedGrant = await actOk(f.subject, f.targets.expiring);
  await waitExpired(); const useAfterExpiry = await actOk(f.subject, f.targets.expiring);
  record("contract action (on-chain PEP)", { before, useAfterGrant, useAfterRevoke, useAfterTimedGrant, useAfterExpiry,
    targetCode: "1 modifier + 1 binding in constructor", policyLines: 0, adminCode: 0,
    pass: before === "deny" && useAfterGrant === "allow" && useAfterRevoke === "deny" && useAfterTimedGrant === "allow" && useAfterExpiry === "deny" });
}

// ---- 2. three unmodified MCP servers behind the gate ----
const servers = [
  { name: "server-everything", pkg: "@modelcontextprotocol/server-everything", args: [], tool: "echo", toolArgs: { message: "hi" } },
  { name: "server-memory", pkg: "@modelcontextprotocol/server-memory", args: [], tool: "read_graph", toolArgs: {} },
  { name: "server-filesystem", pkg: "@modelcontextprotocol/server-filesystem", args: [tmpdir()], tool: "list_allowed_directories", toolArgs: {} },
];
const verdict = (r) => (r?.result && r.result.isError !== true ? "allow" : r?.result?._meta?.[META_NS]?.code ?? (r?.error ? `error ${r.error.code}` : "isError"));
for (const s of servers) {
  const dir = mkdtempSync(join(tmpdir(), "tctc-rq1-"));
  const mk = (target) => {
    const cfg = {
      chain: { key: `chain-${f.chainId}`, chainId: f.chainId, rpcUrl: f.rpcUrl },
      target, subject: { mode: "configured", address: subject },
      gate: { tools: { [s.tool]: ["BENCH_ROLE"] } }, cache: { allowSeconds: 0, denySeconds: 0 },
      server: { command: "npx", args: ["-y", s.pkg, ...s.args], inherit: ["PATH", "HOME"] },
    };
    const path = join(dir, `gate-${target.slice(2, 8)}.json`);
    const text = JSON.stringify(cfg, null, 2);
    writeFileSync(path, text);
    return { path, lines: text.split("\n").length };
  };
  const open = async (cfgPath) => {
    const c = new StdioClient(process.execPath, [GATE_BIN, "--config", cfgPath], { onStderr: () => {} });
    await Promise.race([c.initialize(), c.exited.then((x) => { throw new Error(`gate exited ${x.code}: ${c.stderr}`); })]);
    return c;
  };
  try {
    if (await held()) await revoke();
    const g1 = mk(f.targets.bindings1);
    const c1 = await open(g1.path);
    const before = verdict(await c1.callTool(s.tool, s.toolArgs, 120_000));
    await grant(); const useAfterGrant = verdict(await c1.callTool(s.tool, s.toolArgs, 120_000));
    await revoke(); const useAfterRevoke = verdict(await c1.callTool(s.tool, s.toolArgs));
    await c1.close();
    const g2 = mk(f.targets.expiring);
    const c2 = await open(g2.path);
    await timedGrant(); const useAfterTimedGrant = verdict(await c2.callTool(s.tool, s.toolArgs, 120_000));
    await waitExpired(); const useAfterExpiry = verdict(await c2.callTool(s.tool, s.toolArgs));
    await c2.close();
    record(`MCP ${s.name} (gate)`, { before, useAfterGrant, useAfterRevoke, useAfterTimedGrant, useAfterExpiry, targetCode: "none (unmodified npm package)",
      policyLines: g1.lines, adminCode: 0, pkg: s.pkg,
      pass: before === "TCTC_ROLE_DENIED" && useAfterGrant === "allow" && useAfterRevoke === "TCTC_ROLE_DENIED" && useAfterTimedGrant === "allow" && useAfterExpiry === "TCTC_ROLE_DENIED" });
  } catch (e) {
    record(`MCP ${s.name} (gate)`, { error: String(e.message).slice(0, 200), pass: false, policyLines: "?", targetCode: "?" });
  }
}
if (!(await held())) await grant(); // restore for other experiments
console.log("done");
