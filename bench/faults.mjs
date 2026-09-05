#!/usr/bin/env node
// RQ4 fault injection. Primary safety metric: number of denied calls that
// reached the upstream server (must be 0). Also records the code returned to
// the client and whether the RPC endpoint leaked into any client-visible text.
import { parseArgs, runMeta, write, sleep, META_NS, artifact } from "../lib/chain.mjs";
import { loadFixtures } from "../lib/fixtures.mjs";
import { startRpcProxy } from "../lib/rpc-proxy.mjs";
import { gateConfig, startGate } from "../lib/gate.mjs";
import { jsonlWriter, readJsonl, stamp } from "../lib/jsonl.mjs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { join } from "node:path";

const a = parseArgs(process.argv.slice(2), { fixtures: "out/fixtures.local.json", label: undefined, rpc: undefined, out: undefined, concurrent: "40", "deny-seconds": undefined });
const f = loadFixtures(a.fixtures, a.rpc);
const label = a.label ?? f.meta.label;
const out = a.out ?? `out/faults.${label}.${stamp()}.jsonl`;
const w = jsonlWriter(out);
const proxy = await startRpcProxy(f.rpcUrl);
w({ type: "meta", kind: "faults", label, ...runMeta({ fixtures: a.fixtures, rpcUrl: f.rpcUrl, chainId: f.chainId }) });
console.log(`fault injection → ${out}`);

const ctAbi = artifact("AgentControlTokens").abi;
const ct0 = f.controlTokens[0];
const held = f.subject.address;
const nobody = privateKeyToAccount(generatePrivateKey()).address;
const pollingInterval = f.chainId === 31337 ? 50 : 1000;
const code = (r) => r?.result?._meta?.[META_NS]?.code ?? (r?.result?.isError ? "isError" : r?.result ? "allow" : r?.error ? `rpc-error:${r.error.code}` : "none");
const leaks = (r) => JSON.stringify(r).includes(proxy.url) || JSON.stringify(r).includes(f.rpcUrl);
function record(scenario, expected, observed, upstreamCalls, extra = {}) {
  const pass = observed === expected && upstreamCalls === (extra.expectedUpstream ?? 0) && !extra.leaked;
  // upstreamCalls counts every call the wrapped server received, including the
  // legitimate baseline calls a scenario makes before the fault; the safety
  // metric is the number of denied calls that were forwarded.
  const deniedForwarded = upstreamCalls - (extra.expectedUpstream ?? 0);
  w({ type: "fault", label, scenario, expected, observed, upstreamCalls, deniedForwarded, pass, ...extra });
  console.log(`  ${pass ? "✅" : "❌"} ${scenario.padEnd(24)} expected ${expected}, observed ${observed}, upstream calls ${upstreamCalls}${extra.leaked ? " LEAK" : ""}`);
}
const cfg = (subject, tools, extra = {}) => gateConfig({ rpcUrl: proxy.url, chainId: f.chainId, target: f.targets.bindings1, subject, tools, allowSeconds: 0, denySeconds: 0, ...extra });

// 1 missing role
{
  const g = await startGate(cfg(nobody, { echo: ["BENCH_ROLE"] }));
  const r = await g.client.callTool("echo", { text: "x" });
  record("missing-role", "TCTC_ROLE_DENIED", code(r), g.upstreamCalls(), { leaked: leaks(r) });
  // 2 unmapped tool (same session)
  const r2 = await g.client.callTool("shout", { text: "x" });
  record("unmapped-tool", "TCTC_TOOL_UNMAPPED", code(r2), g.upstreamCalls(), { leaked: leaks(r2) });
  await g.client.close();
}
// 7 prompt-injected out-of-class call (subject holds BENCH_ROLE, not ADMIN_ROLE)
{
  const g = await startGate(cfg(held, { echo: ["BENCH_ROLE"], "delete_*": ["ADMIN_ROLE"] }));
  const ok = await g.client.callTool("echo", { text: "x" });
  const r = await g.client.callTool("delete_all", {});
  record("injected-out-of-class", "TCTC_ROLE_DENIED", code(r), g.upstreamCalls(), { expectedUpstream: 1, leaked: leaks(r), allowedBaseline: code(ok) });
  await g.client.close();
}
// 3 RPC unavailable (mid-session) and recovery
{
  const g = await startGate(cfg(held, { echo: ["BENCH_ROLE"] }));
  const ok = await g.client.callTool("echo", { text: "x" });
  proxy.setMode("down");
  const r = await g.client.callTool("echo", { text: "x" });
  record("rpc-unavailable", "TCTC_CHECK_FAILED", code(r), g.upstreamCalls(), { expectedUpstream: 1, leaked: leaks(r), allowedBaseline: code(ok) });
  proxy.setMode(null);
  const back = await g.client.callTool("echo", { text: "x" });
  w({ type: "note", scenario: "rpc-unavailable", recoveredCode: code(back), upstreamCallsAfterRecovery: g.upstreamCalls() });
  await g.client.close();
}
// 4 wrong-chain RPC at startup → refuse to serve
{
  proxy.setMode("wrongchain");
  const g = await startGate(cfg(held, { echo: ["BENCH_ROLE"] }));
  const observed = g.startupRefused ? `exit ${g.startupRefused.code}` : code(await g.client.callTool("echo", { text: "x" }));
  record("wrong-chain-rpc", "exit 1", observed, g.upstreamCalls(), { leaked: (g.stderr ?? "").includes(proxy.url), stderr: (g.stderr ?? "").trim().slice(0, 200) });
  proxy.setMode(null);
  await g.client.close();
}
// 5 cancellation during the role check → nothing forwarded, nothing answered
{
  const g = await startGate(cfg(held, { echo: ["BENCH_ROLE"] }));
  await g.client.callTool("echo", { text: "x" }); // baseline forward (1 upstream call)
  proxy.setDelay(800);
  const { id, done } = g.client.requestNoWait("tools/call", { name: "echo", arguments: { text: "cancel-me" } });
  await sleep(50);
  g.client.notify("notifications/cancelled", { requestId: id, reason: "user cancelled" });
  const res = await Promise.race([done, sleep(2500).then(() => "no-response")]);
  proxy.setDelay(0);
  record("cancel-during-check", "no-response", res === "no-response" ? "no-response" : code(res), g.upstreamCalls(), { expectedUpstream: 1 });
  await g.client.close();
}
// 8 stale deny cache: a cached deny may delay a fresh grant but never yields a
// false allow. The cache must outlive block inclusion or the window cannot be
// constructed at all (on a 12 s chain a 5 s cache expires before the mint lands).
{
  const denySeconds = Number(a["deny-seconds"] ?? (f.chainId === 31337 ? 5 : 40));
  const g = await startGate(cfg(nobody, { echo: ["BENCH_ROLE"] }, { denySeconds }));
  const d1 = await g.client.callTool("echo", { text: "x" });
  const tDeny = Date.now();
  await write(f.issuer, ct0, ctAbi, "mint", [nobody, 1n, 1n], { pollingInterval });
  const d2 = await g.client.callTool("echo", { text: "x" });
  const cached = d2.result?._meta?.[META_NS]?.cacheHit === true;
  const windowLeft = denySeconds * 1000 - (Date.now() - tDeny);
  if (windowLeft > 0) await sleep(windowLeft + 500);
  const d3 = await g.client.callTool("echo", { text: "x" });
  const observed = cached && code(d2) === "TCTC_ROLE_DENIED" ? "deny while cached, then allow" : `cache window missed (${code(d2)})`;
  record("stale-deny-cache", "deny while cached, then allow", code(d3) === "allow" ? observed : `final ${code(d3)}`,
    g.upstreamCalls(), { expectedUpstream: 1, denySeconds, firstDeny: code(d1), duringCache: code(d2), duringCacheHit: cached, finalVerdict: code(d3) });
  await write(f.issuer, ct0, ctAbi, "burnByIssuer", [nobody, 1n, 1n], { pollingInterval });
  await g.client.close();
}
// 6 revocation racing concurrent calls: no allow may be observed at a block ≥ the burn block
{
  const n = Number(a.concurrent);
  const g = await startGate({ ...cfg(held, { echo: ["BENCH_ROLE"] }), audit: undefined });
  const auditPath = join(g.dir, "audit.jsonl");
  await g.client.close();
  const g2 = await startGate({ ...cfg(held, { echo: ["BENCH_ROLE"] }), audit: auditPath });
  await g2.client.callTool("echo", { text: "x" });
  const before = g2.upstreamCalls();
  const results = [];
  const burnP = (async () => { await sleep(5); return write(f.issuer, ct0, ctAbi, "burnByIssuer", [held, 1n, 1n], { pollingInterval }); })();
  for (let i = 0; i < n; i++) { results.push(g2.client.callTool("echo", { text: `c${i}` })); await sleep(2); }
  const rs = await Promise.all(results);
  const burn = await burnP;
  await sleep(300);
  const tail = await g2.client.callTool("echo", { text: "after" });
  const audit = readJsonl(auditPath).filter((e) => e.tool === "echo" && e.verdict === "allow");
  const allowsAtOrAfterBurn = audit.filter((e) => Number(e.observedBlockNumber) >= burn.blockNumber).length;
  const allows = rs.filter((r) => code(r) === "allow").length, denies = rs.filter((r) => code(r) === "TCTC_ROLE_DENIED").length;
  const upstreamDelta = g2.upstreamCalls() - before;
  w({ type: "fault", label, scenario: "revoke-vs-concurrent", expected: "0 allows at/after burn block", observed: `${allowsAtOrAfterBurn} allows at/after burn block`,
    upstreamCalls: upstreamDelta, deniedForwarded: upstreamDelta - allows, allows, denies, burnBlock: burn.blockNumber, tailCode: code(tail), upstreamEqualsAllows: upstreamDelta === allows,
    pass: allowsAtOrAfterBurn === 0 && upstreamDelta === allows && code(tail) === "TCTC_ROLE_DENIED" });
  console.log(`  ${allowsAtOrAfterBurn === 0 && upstreamDelta === allows ? "✅" : "❌"} revoke-vs-concurrent      ${allows} allowed / ${denies} denied of ${n}; ` +
    `allows observed at/after burn block: ${allowsAtOrAfterBurn}; upstream calls ${upstreamDelta}; after: ${code(tail)}`);
  await write(f.issuer, ct0, ctAbi, "mint", [held, 1n, 1n], { pollingInterval }); // restore
  await g2.client.close();
}
await proxy.close();
console.log("done");
