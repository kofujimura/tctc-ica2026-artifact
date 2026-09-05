#!/usr/bin/env node
// Public-testnet run: deploy once (skipped when the fixtures file exists),
// then RQ2–RQ4 and RQ1 against that deployment. Keys and RPC come from the
// environment (see README); nothing secret is written to out/.
//   node run-testnet.mjs [--calls 1000] [--cycles 30] [--expiry-cycles 10] [--expiry-seconds 60] [--only x,y] [--skip x,y]
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs, maskRpc } from "./lib/chain.mjs";
import { EXP_ROOT } from "./lib/local-node.mjs";

const a = parseArgs(process.argv.slice(2), { calls: "1000", cycles: "30", "expiry-cycles": "10", "expiry-seconds": "60", "poll-ms": "250",
  "chain-id": "11155111", label: "testnet", fixtures: "out/fixtures.testnet.json", only: "", skip: "" });
const rpc = process.env.RPC ?? (process.env.ALCHEMY_API_KEY ? `https://eth-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : "https://ethereum-sepolia-rpc.publicnode.com");
const only = a.only ? a.only.split(",") : null, skip = a.skip ? a.skip.split(",") : [];
const want = (step) => (only ? only.includes(step) : true) && !skip.includes(step);
const run = (script, args = []) => {
  console.log(`\n=== ${script} ${args.map(maskRpc).join(" ")} ===`);
  const r = spawnSync(process.execPath, [script, ...args], { cwd: EXP_ROOT, stdio: "inherit", env: { ...process.env, RPC: rpc } });
  if (r.status !== 0) throw new Error(`${script} failed with status ${r.status}`);
};
console.log(`testnet run via ${maskRpc(rpc)} (chainId ${a["chain-id"]})`);
if (!existsSync(a.fixtures)) run("scripts/deploy.mjs", ["--rpc", rpc, "--chain-id", a["chain-id"], "--label", a.label, "--out", a.fixtures]);
else console.log(`reusing ${a.fixtures}`);
const fx = ["--fixtures", a.fixtures, "--rpc", rpc];
if (want("admin-cost")) run("bench/admin-cost.mjs", [...fx, "--repeat", "3"]);
if (want("latency")) run("bench/latency.mjs", [...fx, "--calls", a.calls]);
if (want("revocation")) run("bench/revocation.mjs", [...fx, "--cycles", a.cycles, "--expiry-cycles", a["expiry-cycles"], "--expiry-seconds", a["expiry-seconds"], "--poll-ms", a["poll-ms"]]);
if (want("faults")) run("bench/faults.mjs", fx);
if (want("rq1")) run("bench/rq1.mjs", [...fx, "--expiry-seconds", a["expiry-seconds"]]);
if (want("rq1-web")) run("bench/rq1-web.mjs", [...fx, "--expiry-seconds", a["expiry-seconds"]]);
run("summarize.mjs");
