#!/usr/bin/env node
// RQ3 propagation: grant → first observed allow; burn → first observed deny;
// expiring credential → first observed deny after the deadline.
// Polling runs concurrently with the transaction so observation delay is
// measured from submission, and split at block inclusion.
import { parseArgs, runMeta, write, sleep, META_NS } from "../lib/chain.mjs";
import { loadFixtures } from "../lib/fixtures.mjs";
import { gateConfig, startGate } from "../lib/gate.mjs";
import { jsonlWriter, stamp } from "../lib/jsonl.mjs";
import { artifact } from "../lib/chain.mjs";

const a = parseArgs(process.argv.slice(2), {
  fixtures: "out/fixtures.local.json", cycles: "30", "expiry-cycles": undefined, "expiry-seconds": "5",
  "poll-ms": "25", label: undefined, rpc: undefined, out: undefined, "skip-expiry": "false",
});
const f = loadFixtures(a.fixtures, a.rpc);
const label = a.label ?? f.meta.label;
const cycles = Number(a.cycles), expiryCycles = Number(a["expiry-cycles"] ?? a.cycles), pollMs = Number(a["poll-ms"]);
const expirySeconds = Number(a["expiry-seconds"]);
const out = a.out ?? `out/revocation.${label}.${stamp()}.jsonl`;
const w = jsonlWriter(out);
w({ type: "meta", kind: "revocation", label, ...runMeta({ fixtures: a.fixtures, rpcUrl: f.rpcUrl, chainId: f.chainId, cycles, expiryCycles, expirySeconds, pollMs }) });
console.log(`revocation run → ${out}`);

const ctAbi = artifact("AgentControlTokens").abi;
const expAbi = artifact("ExpiringControlTokens").abi;
const ct0 = f.controlTokens[0];
const subject = f.subject.address;
const pollingInterval = f.chainId === 31337 ? 50 : 1000;

/** Poll `echo` until the verdict matches; returns first-observation time + block from deny meta. */
async function pollUntil(client, wantAllowed, timeoutMs = 180_000) {
  const t0 = Date.now();
  let polls = 0;
  while (Date.now() - t0 < timeoutMs) {
    polls++;
    const r = await client.callTool("echo", { text: "p" });
    const allowed = r.result && r.result.isError !== true;
    if (allowed === wantAllowed) {
      const meta = r.result?._meta?.[META_NS];
      return { t: Date.now(), polls, observedBlockNumber: meta?.observedBlockNumber ? Number(meta.observedBlockNumber) : undefined };
    }
    await sleep(pollMs);
  }
  throw new Error(`timeout waiting for ${wantAllowed ? "allow" : "deny"}`);
}

async function balance(ct, abi, id) {
  return f.issuer.pub.readContract({ address: ct, abi, functionName: "balanceOf", args: [subject, id] });
}

// ---------- grant / revoke cycles ----------
{
  const g = await startGate(gateConfig({ rpcUrl: f.rpcUrl, chainId: f.chainId, target: f.targets.bindings1,
    subject, tools: { echo: ["BENCH_ROLE"] }, allowSeconds: 0, denySeconds: 0 }));
  if (g.startupRefused) throw new Error(`gate refused: ${g.stderr}`);
  if ((await balance(ct0, ctAbi, 1n)) > 0n) await write(f.issuer, ct0, ctAbi, "burnByIssuer", [subject, 1n, 1n], { pollingInterval });
  await pollUntil(g.client, false);
  for (let c = 0; c < cycles; c++) {
    // grant
    const pg = pollUntil(g.client, true);
    const tx = await write(f.issuer, ct0, ctAbi, "mint", [subject, 1n, 1n], { pollingInterval });
    const ob = await pg;
    w({ type: "cycle", label, phase: "grant", cycle: c, tSubmit: tx.tSubmit, tReceipt: tx.tReceipt, blockNumber: tx.blockNumber,
      blockTimestamp: tx.blockTimestamp, tObserved: ob.t, inclusionMs: tx.tReceipt - tx.tSubmit, observeMs: ob.t - tx.tSubmit,
      afterInclusionMs: ob.t - tx.tReceipt, polls: ob.polls, gasUsed: tx.gasUsed });
    // revoke (kill switch)
    const pr = pollUntil(g.client, false);
    const rx = await write(f.issuer, ct0, ctAbi, "burnByIssuer", [subject, 1n, 1n], { pollingInterval });
    const od = await pr;
    w({ type: "cycle", label, phase: "revoke", cycle: c, tSubmit: rx.tSubmit, tReceipt: rx.tReceipt, blockNumber: rx.blockNumber,
      blockTimestamp: rx.blockTimestamp, tObserved: od.t, inclusionMs: rx.tReceipt - rx.tSubmit, observeMs: od.t - rx.tSubmit,
      afterInclusionMs: od.t - rx.tReceipt, polls: od.polls, gasUsed: rx.gasUsed,
      observedBlockNumber: od.observedBlockNumber, observedAtOrAfterInclusion: od.observedBlockNumber !== undefined ? od.observedBlockNumber >= rx.blockNumber : undefined });
    console.log(`  cycle ${c}: grant observed ${ob.t - tx.tSubmit} ms (incl ${tx.tReceipt - tx.tSubmit}); ` +
      `revoke observed ${od.t - rx.tSubmit} ms (incl ${rx.tReceipt - rx.tSubmit}), deny block ${od.observedBlockNumber} ≥ burn block ${rx.blockNumber}`);
  }
  // leave the subject holding the credential for later experiments
  await write(f.issuer, ct0, ctAbi, "mint", [subject, 1n, 1n], { pollingInterval });
  await g.client.close();
}

// ---------- expiry cycles ----------
// Chain time and wall-clock time drift apart on a local node (blocks mined in
// bursts get strictly increasing timestamps), so observation delay after the
// first post-deadline block is measured against the wall-clock time at which
// that block number first became visible over RPC, not against its timestamp.
if (a["skip-expiry"] !== "true") {
  const exp = f.expiringControlToken;
  const seenAt = new Map();
  let watching = true;
  const watcher = (async () => {
    let last = -1;
    while (watching) {
      try {
        const n = Number(await f.issuer.pub.getBlockNumber({ cacheTime: 0 }));
        if (n > last) { const t = Date.now(); for (let b = last + 1; b <= n; b++) seenAt.set(b, t); last = n; }
      } catch { /* transient */ }
      await sleep(10);
    }
  })();
  const g = await startGate(gateConfig({ rpcUrl: f.rpcUrl, chainId: f.chainId, target: f.targets.expiring,
    subject, tools: { echo: ["BENCH_ROLE"] }, allowSeconds: 0, denySeconds: 0 }));
  if (g.startupRefused) throw new Error(`gate refused: ${g.stderr}`);
  for (let c = 0; c < expiryCycles; c++) {
    const latest = await f.issuer.pub.getBlock();
    const deadline = Number(latest.timestamp) + expirySeconds; // relative to chain time
    const pg = pollUntil(g.client, true);
    const tx = await write(f.issuer, exp, expAbi, "mint", [subject, 1n, BigInt(deadline)], { pollingInterval });
    const ob = await pg;
    const od = await pollUntil(g.client, false, (expirySeconds + 120) * 1000);
    // first block whose timestamp is at or after the deadline
    let firstBlock;
    for (let b = tx.blockNumber; b <= (od.observedBlockNumber ?? Number(await f.issuer.pub.getBlockNumber())); b++) {
      const blk = await f.issuer.pub.getBlock({ blockNumber: BigInt(b) });
      if (Number(blk.timestamp) >= deadline) { firstBlock = { number: b, timestamp: Number(blk.timestamp) }; break; }
    }
    w({ type: "cycle", label, phase: "expiry", cycle: c, deadline, mintBlock: tx.blockNumber, mintBlockTimestamp: tx.blockTimestamp,
      tAllowObserved: ob.t, tDenyObserved: od.t, observedBlockNumber: od.observedBlockNumber,
      firstBlockAtOrAfterDeadline: firstBlock?.number, firstBlockTimestamp: firstBlock?.timestamp,
      blockDelayS: firstBlock ? firstBlock.timestamp - deadline : undefined,
      firstBlockSeenAt: firstBlock ? seenAt.get(firstBlock.number) : undefined,
      denyObservedAfterFirstBlockMs: firstBlock && seenAt.has(firstBlock.number) ? od.t - seenAt.get(firstBlock.number) : undefined,
      denyBlockIsFirstBlock: firstBlock ? od.observedBlockNumber === firstBlock.number : undefined, polls: od.polls, gasUsed: tx.gasUsed });
    console.log(`  expiry ${c}: deadline ${deadline}, first block ≥ deadline #${firstBlock?.number} (+${firstBlock ? firstBlock.timestamp - deadline : "?"} s), ` +
      `deny observed at block ${od.observedBlockNumber}`);
  }
  watching = false;
  await watcher;
  await g.client.close();
}
console.log("done");
