#!/usr/bin/env node
// RQ3 latency: end-to-end tool-call latency through a real stdio client for
//   ungated | gate with 1/2/4 bindings (allow cache 0) | gate with allow cache 1/5/10 s
// Every call is one JSONL line; RPC requests are counted by a proxy in front
// of the endpoint so "RPC per admission" is measured, not estimated.
import { parseArgs, runMeta, sleep } from "../lib/chain.mjs";
import { loadFixtures } from "../lib/fixtures.mjs";
import { startRpcProxy } from "../lib/rpc-proxy.mjs";
import { gateConfig, startGate, startUngated } from "../lib/gate.mjs";
import { jsonlWriter, stats, stamp } from "../lib/jsonl.mjs";

const a = parseArgs(process.argv.slice(2), {
  fixtures: "out/fixtures.local.json", calls: "1000", warmup: "50", bindings: "1,2,4", allow: "1,5,10",
  label: undefined, rpc: undefined, out: undefined,
});
const f = loadFixtures(a.fixtures, a.rpc);
const label = a.label ?? f.meta.label;
const calls = Number(a.calls), warmup = Number(a.warmup);
const out = a.out ?? `out/latency.${label}.${stamp()}.jsonl`;
const w = jsonlWriter(out);
const proxy = await startRpcProxy(f.rpcUrl);
w({ type: "meta", kind: "latency", label, ...runMeta({ fixtures: a.fixtures, rpcUrl: f.rpcUrl, chainId: f.chainId, calls, warmup }) });
console.log(`latency run → ${out}`);

async function measure(condition, extra, client) {
  for (let i = 0; i < warmup; i++) await client.callTool("echo", { text: "w" });
  proxy.reset();
  const t0 = Date.now();
  const ms = [];
  let failures = 0;
  for (let i = 0; i < calls; i++) {
    const before = proxy.total();
    const s = process.hrtime.bigint();
    const r = await client.callTool("echo", { text: "x" });
    const dt = Number(process.hrtime.bigint() - s) / 1e6;
    const ok = r.result && r.result.isError !== true && r.result.content?.[0]?.text === "x";
    if (!ok) failures++;
    ms.push(dt);
    w({ type: "call", label, condition, ...extra, i, ms: dt, ok, rpcCalls: proxy.total() - before });
  }
  const wall = (Date.now() - t0) / 1000;
  const s = stats(ms);
  const summary = { type: "summary", label, condition, ...extra, calls, failures, wallSeconds: wall,
    throughput: calls / wall, rpcPerCall: proxy.total() / calls, rpcByMethod: proxy.counts(), ...s };
  w(summary);
  console.log(`  ${condition.padEnd(22)} p50 ${s.p50.toFixed(2)}  p95 ${s.p95.toFixed(2)}  p99 ${s.p99.toFixed(2)} ms  ` +
    `rpc/call ${(proxy.total() / calls).toFixed(2)}  ${(calls / wall).toFixed(1)} call/s  fail ${failures}`);
}

// (a) ungated baseline
{
  const u = await startUngated();
  await measure("ungated", { bindings: 0, allowSeconds: 0 }, u.client);
  await u.client.close();
}
// (b) bindings sweep, live allow
for (const k of a.bindings.split(",").map(Number)) {
  const g = await startGate(gateConfig({ rpcUrl: proxy.url, chainId: f.chainId, target: f.targets[`bindings${k}`],
    subject: f.subject.address, tools: { echo: ["BENCH_ROLE"] }, allowSeconds: 0, denySeconds: 0 }));
  if (g.startupRefused) throw new Error(`gate refused to start: ${g.stderr}`);
  await measure(`gate-${k}b-allow0`, { bindings: k, allowSeconds: 0 }, g.client);
  await g.client.close();
  await sleep(200);
}
// (c) allow-cache sweep, 1 binding
for (const sec of a.allow.split(",").map(Number).filter((x) => x > 0)) {
  const g = await startGate(gateConfig({ rpcUrl: proxy.url, chainId: f.chainId, target: f.targets.bindings1,
    subject: f.subject.address, tools: { echo: ["BENCH_ROLE"] }, allowSeconds: sec, denySeconds: 0 }));
  await measure(`gate-1b-allow${sec}`, { bindings: 1, allowSeconds: sec }, g.client);
  await g.client.close();
  await sleep(200);
}
await proxy.close();
console.log("done");
