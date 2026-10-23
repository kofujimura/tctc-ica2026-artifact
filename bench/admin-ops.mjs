#!/usr/bin/env node
// RQ2, executed operation counts (local node only). admin-cost.mjs derives the
// operation counts of Table II; this run issues every one of them and counts
// from the chain: transactions sent, membership records written (from the
// events each scheme emits), and the stores those records live in. After the
// grants and again after the revocations it asks every target's own decision
// function about every subject. Schemes, for A targets and N subjects sharing
// one qualification:
//   rbac          per-target AccessControl: each target owner makes the
//                 qualification administrator Q an admin, Q grants per target
//   registry      one AccessManager administered by Q for all A targets
//   registry-dom  A administrative domains with no administrator in common:
//                 each target belongs to its own AccessManager, so the
//                 qualification is mirrored into every domain
//   token         one control-token contract owned by Q; each target owner
//                 binds its role to it once
// It also onboards one more target after the grants and counts what that
// target needs before all N existing holders are admitted there.
import { keccak256, stringToHex, toFunctionSelector, parseAbiItem, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import { parseArgs, runMeta, clients, deploy, artifact } from "../lib/chain.mjs";
import { loadFixtures } from "../lib/fixtures.mjs";
import { jsonlWriter, stamp } from "../lib/jsonl.mjs";

const a = parseArgs(process.argv.slice(2), { fixtures: "out/fixtures.local.json", label: undefined, rpc: undefined, out: undefined, points: "1x10,4x100,16x100" });
const f = loadFixtures(a.fixtures, a.rpc);
if (f.chainId !== 31337) throw new Error("admin-ops issues thousands of transactions and runs on the local node only");
const label = a.label ?? f.meta.label;
const out = a.out ?? `out/admin-ops.${label}.${stamp()}.jsonl`;
const w = jsonlWriter(out);
w({ type: "meta", kind: "admin-ops", label, points: a.points, ...runMeta({ fixtures: a.fixtures, rpcUrl: f.rpcUrl, chainId: f.chainId }) });
console.log(`executed operation counts → ${out}`);

// Hardhat accounts 11 (target owners) and 12 (qualification administrator Q).
const MNEMONIC = "test test test test test test test test test test test junk";
const keyAt = (i) => toHex(mnemonicToAccount(MNEMONIC, { addressIndex: i }).getHdKey().privateKey);
const O = clients(f.rpcUrl, f.chainId, keyAt(11)), Q = clients(f.rpcUrl, f.chainId, keyAt(12));
const pub = Q.pub;
const rbacAbi = artifact("RbacTarget").abi, mgrAbi = artifact("BenchAccessManager").abi, ctAbi = artifact("AgentControlTokens").abi, btAbi = artifact("BindableTarget").abi;
const BENCH_ROLE = keccak256(stringToHex("BENCH_ROLE")), DEFAULT_ADMIN = `0x${"00".repeat(32)}`, REGISTRY_ROLE = 42n, ACT = toFunctionSelector("act()");
const EV = {
  acGranted: parseAbiItem("event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)"),
  amGranted: parseAbiItem("event RoleGranted(uint64 indexed roleId, address indexed account, uint32 delay, uint48 since, bool newMember)"),
  transfer: parseAbiItem("event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)"),
  bound: parseAbiItem("event ERC1155ControlTokenAdded(bytes32 indexed role, address indexed contractId, uint256 typeId)"),
};

// One counted administrative transaction (deployments are not counted: every scheme deploys its targets).
let txCount = 0;
async function tx(who, address, abi, functionName, args) {
  const hash = await who.wallet.writeContract({ address, abi, functionName, args });
  const rc = await pub.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (rc.status !== "success") throw new Error(`${functionName} reverted`);
  txCount++;
  return rc;
}
const counted = async (fn) => { const before = txCount; await fn(); return txCount - before; };
const logsOf = async (event, address, fromBlock, args) => (await pub.getLogs({ address, event, args, fromBlock, toBlock: "latest" }));

async function decisions(check, targets, subjects) {
  let yes = 0;
  for (const t of targets) for (const u of subjects) if (await check(t, u)) yes++;
  return yes;
}

async function runRbac(A, subjects) {
  const from = await pub.getBlockNumber();
  const targets = [];
  for (let i = 0; i < A + 1; i++) targets.push((await deploy(O, "RbacTarget", [])).address);
  const extra = targets.pop();
  const check = async (t, u) => pub.readContract({ address: t, abi: rbacAbi, functionName: "hasRole", args: [BENCH_ROLE, u] });
  const onboard = await counted(async () => { for (const t of targets) await tx(O, t, rbacAbi, "grantRole", [DEFAULT_ADMIN, Q.address]); });
  const grants = await counted(async () => { for (const t of targets) for (const u of subjects) await tx(Q, t, rbacAbi, "grantRole", [BENCH_ROLE, u]); });
  const allowed = await decisions(check, targets, subjects);
  const addTarget = await counted(async () => {
    await tx(O, extra, rbacAbi, "grantRole", [DEFAULT_ADMIN, Q.address]);
    for (const u of subjects) await tx(Q, extra, rbacAbi, "grantRole", [BENCH_ROLE, u]);
  });
  const addAllowed = await decisions(check, [extra], subjects);
  const recs = (await logsOf(EV.acGranted, targets, from + 1n, { role: BENCH_ROLE }));
  const revokes = await counted(async () => { for (const t of targets) for (const u of subjects) await tx(Q, t, rbacAbi, "revokeRole", [BENCH_ROLE, u]); });
  const deniedAfter = targets.length * subjects.length - (await decisions(check, targets, subjects));
  return { onboard, grants, revokes, allowed, deniedAfter, records: recs.length, stores: new Set(recs.map((l) => l.address.toLowerCase())).size, addTarget, addAllowed };
}

async function runRegistry(A, subjects, perTarget) {
  const domains = perTarget ? A : 1;
  const from = await pub.getBlockNumber();
  const managers = [];
  for (let k = 0; k < domains; k++) managers.push((await deploy(O, "BenchAccessManager", [Q.address])).address);
  const targets = [];
  for (let i = 0; i < A; i++) targets.push({ t: (await deploy(O, "ManagedTarget", [managers[i % domains]])).address, m: managers[i % domains] });
  // the extra target joins the shared registry, or opens a domain of its own
  const extraMgr = perTarget ? (await deploy(O, "BenchAccessManager", [Q.address])).address : managers[0];
  const extra = { t: (await deploy(O, "ManagedTarget", [extraMgr])).address, m: extraMgr };
  const check = async ({ t, m }, u) => (await pub.readContract({ address: m, abi: mgrAbi, functionName: "canCall", args: [u, t, ACT] }))[0];
  const onboard = await counted(async () => { for (const { t, m } of targets) await tx(Q, m, mgrAbi, "setTargetFunctionRole", [t, [ACT], REGISTRY_ROLE]); });
  const grants = await counted(async () => { for (const m of managers) for (const u of subjects) await tx(Q, m, mgrAbi, "grantRole", [REGISTRY_ROLE, u, 0]); });
  const allowed = await decisions(check, targets, subjects);
  const addTarget = await counted(async () => {
    await tx(Q, extra.m, mgrAbi, "setTargetFunctionRole", [extra.t, [ACT], REGISTRY_ROLE]);
    if (perTarget) for (const u of subjects) await tx(Q, extra.m, mgrAbi, "grantRole", [REGISTRY_ROLE, u, 0]);
  });
  const addAllowed = await decisions(check, [extra], subjects);
  const recs = (await logsOf(EV.amGranted, managers, from + 1n, { roleId: REGISTRY_ROLE })).filter((l) => l.args.newMember);
  const revokes = await counted(async () => { for (const m of managers) for (const u of subjects) await tx(Q, m, mgrAbi, "revokeRole", [REGISTRY_ROLE, u]); });
  const deniedAfter = targets.length * subjects.length - (await decisions(check, targets, subjects));
  return { onboard, grants, revokes, allowed, deniedAfter, records: recs.length, stores: new Set(recs.map((l) => l.address.toLowerCase())).size, addTarget, addAllowed };
}

async function runToken(A, subjects) {
  const from = await pub.getBlockNumber();
  const ct = (await deploy(Q, "AgentControlTokens", ["Shared qualification"])).address;
  const targets = [];
  for (let i = 0; i < A + 1; i++) targets.push((await deploy(O, "BindableTarget", ["BENCH_ROLE"])).address);
  const extra = targets.pop();
  const check = async (t, u) => pub.readContract({ address: t, abi: btAbi, functionName: "hasRole", args: [BENCH_ROLE, u] });
  const onboard = await counted(async () => { for (const t of targets) await tx(O, t, btAbi, "bindERC1155", [ct, 1n]); });
  const grants = await counted(async () => { for (const u of subjects) await tx(Q, ct, ctAbi, "mint", [u, 1n, 1n]); });
  const allowed = await decisions(check, targets, subjects);
  const addTarget = await counted(async () => { await tx(O, extra, btAbi, "bindERC1155", [ct, 1n]); });
  const addAllowed = await decisions(check, [extra], subjects);
  const recs = (await logsOf(EV.transfer, ct, from + 1n, { from: "0x0000000000000000000000000000000000000000" }));
  const bindings = (await logsOf(EV.bound, targets, from + 1n)).length;
  const revokes = await counted(async () => { for (const u of subjects) await tx(Q, ct, ctAbi, "burnByIssuer", [u, 1n, 1n]); });
  const deniedAfter = targets.length * subjects.length - (await decisions(check, targets, subjects));
  return { onboard, grants, revokes, allowed, deniedAfter, records: recs.length, stores: new Set(recs.map((l) => l.address.toLowerCase())).size, bindings, addTarget, addAllowed };
}

// Expected counts for one shared qualification (the analytic rows of Table II).
const expected = (scheme, A, N) => ({
  rbac: { onboard: A, grants: A * N, revokes: A * N, records: A * N, stores: A, addTarget: 1 + N },
  registry: { onboard: A, grants: N, revokes: N, records: N, stores: 1, addTarget: 1 },
  "registry-dom": { onboard: A, grants: A * N, revokes: A * N, records: A * N, stores: A, addTarget: 1 + N },
  token: { onboard: A, grants: N, revokes: N, records: N, stores: 1, addTarget: 1 },
})[scheme];

let mismatches = 0;
for (const p of a.points.split(",")) {
  const [A, N] = p.split("x").map(Number);
  const subjects = Array.from({ length: N }, () => privateKeyToAccount(generatePrivateKey()).address);
  const runs = { rbac: () => runRbac(A, subjects), registry: () => runRegistry(A, subjects, false), "registry-dom": () => runRegistry(A, subjects, true), token: () => runToken(A, subjects) };
  for (const [scheme, run] of Object.entries(runs)) {
    const t0 = Date.now();
    const r = await run();
    const e = expected(scheme, A, N);
    const ok = Object.entries(e).every(([k, v]) => r[k] === v) && r.allowed === A * N && r.deniedAfter === A * N && r.addAllowed === N;
    if (!ok) mismatches++;
    w({ type: "ops-measured", label, A, N, scheme, ...r, expected: e, matchesExpected: ok, ms: Date.now() - t0 });
    console.log(`  ${ok ? "✅" : "❌"} (A,N)=(${A},${N}) ${scheme.padEnd(12)} onboard ${r.onboard} + grants ${r.grants} + revokes ${r.revokes}; records ${r.records} in ${r.stores} store(s); ` +
      `allowed ${r.allowed}/${A * N}, denied after revoke ${r.deniedAfter}/${A * N}; one more target: ${r.addTarget} op(s), admits ${r.addAllowed}/${N}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
}
console.log(mismatches ? `FAILED (${mismatches})` : "done");
process.exit(mismatches ? 1 : 0);
