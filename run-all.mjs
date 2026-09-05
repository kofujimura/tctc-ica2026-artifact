#!/usr/bin/env node
// One command for the whole local evaluation: start a local node, deploy
// fixtures, run RQ2–RQ4 benchmarks, and regenerate the tables.
//   node run-all.mjs [--calls 1000] [--cycles 30] [--expiry-cycles 30] [--expiry-seconds 5]
//   node run-all.mjs --only rq1            # deploy + one step;  --skip rq1 to omit a step
import { spawnSync } from "node:child_process";
import { startLocalNode, EXP_ROOT } from "./lib/local-node.mjs";
import { parseArgs } from "./lib/chain.mjs";

const a = parseArgs(process.argv.slice(2), { calls: "1000", cycles: "30", "expiry-cycles": "30", "expiry-seconds": "5", port: "8545", only: "", skip: "",
  "cs-trials": "10", "cs-conditions": "granted,denied,burn,expiry,injection", "cs-model": "sonnet", "cs-expiry-seconds": "12", "cs-label": "local" });
const only = a.only ? a.only.split(",") : null, skip = a.skip ? a.skip.split(",") : [];
const want = (step) => (only ? only.includes(step) : true) && !skip.includes(step);
const run = (script, args = []) => {
  console.log(`\n=== ${script} ${args.join(" ")} ===`);
  const r = spawnSync(process.execPath, [script, ...args], { cwd: EXP_ROOT, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${script} failed with status ${r.status}`);
};
const node = await startLocalNode({ port: Number(a.port) });
console.log(`local node at ${node.url} (chainId ${node.chainId})`);
try {
  run("scripts/deploy.mjs", ["--rpc", node.url, "--chain-id", String(node.chainId), "--out", "out/fixtures.local.json"]);
  if (want("admin-cost")) run("bench/admin-cost.mjs", ["--fixtures", "out/fixtures.local.json"]);
  if (want("latency")) run("bench/latency.mjs", ["--fixtures", "out/fixtures.local.json", "--calls", a.calls]);
  if (want("revocation")) run("bench/revocation.mjs", ["--fixtures", "out/fixtures.local.json", "--cycles", a.cycles, "--expiry-cycles", a["expiry-cycles"], "--expiry-seconds", a["expiry-seconds"]]);
  if (want("faults")) run("bench/faults.mjs", ["--fixtures", "out/fixtures.local.json"]);
  if (want("rq1")) run("bench/rq1.mjs", ["--fixtures", "out/fixtures.local.json", "--expiry-seconds", a["expiry-seconds"]]); // needs network (npx)
  if (want("rq1-web")) run("bench/rq1-web.mjs", ["--fixtures", "out/fixtures.local.json", "--expiry-seconds", a["expiry-seconds"]]);
  // The agent case study spends LLM credits, so it runs only when named explicitly: --only case-study
  if (only && only.includes("case-study")) run("bench/case-study.mjs", ["--fixtures", "out/fixtures.local.json", "--trials", a["cs-trials"], "--conditions", a["cs-conditions"], "--model", a["cs-model"], "--expiry-seconds", a["cs-expiry-seconds"], "--label", a["cs-label"]]);
  run("summarize.mjs");
} finally {
  node.close();
}
