#!/usr/bin/env node
// Deploy the evaluation fixtures and write their addresses to a JSON file.
//   node scripts/deploy.mjs --rpc http://127.0.0.1:8545 --chain-id 31337 --out out/fixtures.local.json
//   ISSUER_PRIVATE_KEY=0x… SUBJECT_PRIVATE_KEY=0x… SUBJECT2_PRIVATE_KEY=0x… \
//     node scripts/deploy.mjs --rpc $SEPOLIA_RPC --chain-id 11155111 --label testnet --out out/fixtures.testnet.json
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { toFunctionSelector } from "viem";
import { clients, deploy, write, runMeta, parseArgs, maskRpc } from "../lib/chain.mjs";
import { HARDHAT_KEYS } from "../lib/local-node.mjs";

const a = parseArgs(process.argv.slice(2), {
  rpc: "http://127.0.0.1:8545", "chain-id": "31337", out: "out/fixtures.local.json", label: "local",
});
const chainId = Number(a["chain-id"]);
const local = a.label === "local";
const keys = {
  issuer: process.env.ISSUER_PRIVATE_KEY ?? (local ? HARDHAT_KEYS[0] : undefined),
  subject: process.env.SUBJECT_PRIVATE_KEY ?? (local ? HARDHAT_KEYS[1] : undefined),
  subject2: process.env.SUBJECT2_PRIVATE_KEY ?? (local ? HARDHAT_KEYS[2] : undefined),
};
for (const [k, v] of Object.entries(keys)) if (!v) throw new Error(`missing ${k.toUpperCase()}_PRIVATE_KEY`);

const issuer = clients(a.rpc, chainId, keys.issuer);
const subject = clients(a.rpc, chainId, keys.subject);
const subject2 = clients(a.rpc, chainId, keys.subject2);
console.log(`deploying to ${maskRpc(a.rpc)} (chainId ${chainId}) as issuer ${issuer.address}`);

const gas = {};
const cts = [];
for (let i = 0; i < 4; i++) {
  const c = await deploy(issuer, "AgentControlTokens", [`Bench Credential ${i}`]);
  cts.push(c); gas[`deploy.AgentControlTokens${i}`] = c.gasUsed;
  console.log(`  control token ${i}: ${c.address}`);
}
const targets = {};
for (const k of [1, 2, 4]) {
  const t = await deploy(issuer, "BenchTarget", [cts.slice(0, k).map((c) => c.address), cts.slice(0, k).map(() => 1n)]);
  targets[`bindings${k}`] = t.address; gas[`deploy.BenchTarget${k}`] = t.gasUsed;
  console.log(`  BenchTarget (${k} bindings): ${t.address}`);
}
const expiring = await deploy(issuer, "ExpiringControlTokens", ["Bench Expiring Credential"]);
const benchExp = await deploy(issuer, "BenchTarget", [[expiring.address], [1n]]);
targets.expiring = benchExp.address;
gas["deploy.ExpiringControlTokens"] = expiring.gasUsed;
console.log(`  expiring control token: ${expiring.address}\n  BenchTarget (expiring): ${benchExp.address}`);
const recordT = await deploy(issuer, "RecordTarget", [cts[0].address, 1n]);
targets.record = recordT.address; gas["deploy.RecordTarget"] = recordT.gasUsed;
const recordX = await deploy(issuer, "RecordTarget", [expiring.address, 1n]);
targets.recordExpiring = recordX.address;
console.log(`  RecordTarget (case study, on-chain PEP): ${recordT.address}; bound to expiring credential: ${recordX.address}`);
const rbac = await deploy(issuer, "RbacTarget", []);
gas["deploy.RbacTarget"] = rbac.gasUsed;
console.log(`  RbacTarget (per-target AccessControl baseline): ${rbac.address}`);

// Shared-registry baseline: one AccessManager holds the memberships and the
// selector-to-role bindings for every target that names it as its authority.
const REGISTRY_ROLE_ID = 42n;
const manager = await deploy(issuer, "BenchAccessManager", [issuer.address]);
const managed = await deploy(issuer, "ManagedTarget", [manager.address]);
gas["deploy.BenchAccessManager"] = manager.gasUsed;
gas["deploy.ManagedTarget"] = managed.gasUsed;
const bind = await write(issuer, manager.address, manager.abi, "setTargetFunctionRole",
  [managed.address, [toFunctionSelector("act()")], REGISTRY_ROLE_ID]);
gas["registry.setTargetFunctionRole"] = bind.gasUsed;
console.log(`  BenchAccessManager (shared-registry baseline): ${manager.address}\n  ManagedTarget: ${managed.address}`);

// subject holds credential 0 (satisfies every bench target);
// subject2 holds only credential 3 (worst case for the 4-binding target).
const g1 = await write(issuer, cts[0].address, cts[0].abi, "mint", [subject.address, 1n, 1n]);
const g2 = await write(issuer, cts[3].address, cts[3].abi, "mint", [subject2.address, 1n, 1n]);
gas["mint.first"] = g1.gasUsed; gas["mint.first.subject2"] = g2.gasUsed;

const fixtures = {
  meta: runMeta({ label: a.label, rpcUrl: a.rpc, chainId }),
  issuer: issuer.address, subject: subject.address, subject2: subject2.address,
  controlTokens: cts.map((c) => c.address),
  expiringControlToken: expiring.address,
  targets, rbacTarget: rbac.address,
  accessManager: manager.address, managedTarget: managed.address, registryRoleId: Number(REGISTRY_ROLE_ID),
  gas,
  ...(local ? { keys } : { keysFromEnv: true }),
};
mkdirSync(dirname(a.out), { recursive: true });
writeFileSync(a.out, JSON.stringify(fixtures, null, 2));
console.log(`fixtures written to ${a.out}`);
