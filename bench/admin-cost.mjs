#!/usr/bin/env node
// RQ2 on-chain cost: gas of grant/revoke under per-target RBAC (AccessControl
// grantRole/revokeRole) vs. externalized credentials (mint/burnByIssuer), and
// gas of the protected action under each enforcement scheme (1/2/4 bindings,
// best and worst binding position), plus the analytic operation counts.
import { parseArgs, runMeta, write, artifact } from "../lib/chain.mjs";
import { loadFixtures } from "../lib/fixtures.mjs";
import { jsonlWriter, stamp } from "../lib/jsonl.mjs";
import { keccak256, stringToHex } from "viem";

const a = parseArgs(process.argv.slice(2), { fixtures: "out/fixtures.local.json", label: undefined, rpc: undefined, out: undefined, repeat: "5" });
const f = loadFixtures(a.fixtures, a.rpc);
const label = a.label ?? f.meta.label;
const out = a.out ?? `out/admin-cost.${label}.${stamp()}.jsonl`;
const w = jsonlWriter(out);
w({ type: "meta", kind: "admin-cost", label, ...runMeta({ fixtures: a.fixtures, rpcUrl: f.rpcUrl, chainId: f.chainId }) });
console.log(`admin cost → ${out}`);
const repeat = Number(a.repeat);
const ROLE = keccak256(stringToHex("BENCH_ROLE"));
const rbacAbi = artifact("RbacTarget").abi, ctAbi = artifact("AgentControlTokens").abi, benchAbi = artifact("BenchTarget").abi;
const mgrAbi = artifact("BenchAccessManager").abi, managedAbi = artifact("ManagedTarget").abi;
const REGISTRY_ROLE = BigInt(f.registryRoleId ?? 42);
const pollingInterval = f.chainId === 31337 ? 50 : 1000;
const gas = async (who, addr, abi, fn, args) => (await write(who, addr, abi, fn, args, { pollingInterval })).gasUsed;
const rec = (scheme, op, g, extra = {}) => { w({ type: "gas", label, scheme, op, gasUsed: g, ...extra }); console.log(`  ${scheme.padEnd(12)} ${op.padEnd(28)} ${g}`); };

const s2 = f.subject2.address, s1 = f.subject.address;
for (let i = 0; i < repeat; i++) {
  rec("rbac", "grantRole", await gas(f.issuer, f.rbacTarget, rbacAbi, "grantRole", [ROLE, s2]), { i });
  if (i === 0) await gas(f.subject2, f.rbacTarget, rbacAbi, "act", []); // warm the counter slot
  rec("rbac", "act (local mapping)", await gas(f.subject2, f.rbacTarget, rbacAbi, "act", []), { i });
  rec("rbac", "revokeRole", await gas(f.issuer, f.rbacTarget, rbacAbi, "revokeRole", [ROLE, s2]), { i });
  rec("registry", "grantRole", await gas(f.issuer, f.accessManager, mgrAbi, "grantRole", [REGISTRY_ROLE, s2, 0]), { i });
  if (i === 0) await gas(f.subject2, f.managedTarget, managedAbi, "act", []); // warm the counter slot
  rec("registry", "act (shared registry)", await gas(f.subject2, f.managedTarget, managedAbi, "act", []), { i });
  rec("registry", "revokeRole", await gas(f.issuer, f.accessManager, mgrAbi, "revokeRole", [REGISTRY_ROLE, s2]), { i });
  rec("externalized", "mint (grant)", await gas(f.issuer, f.controlTokens[1], ctAbi, "mint", [s2, 1n, 1n]), { i });
  rec("externalized", "burnByIssuer (revoke)", await gas(f.issuer, f.controlTokens[1], ctAbi, "burnByIssuer", [s2, 1n, 1n]), { i });
}
// protected action gas (warm storage: the first call pays the zero→nonzero counter SSTORE, so measure the second call);
// subject holds credential 0 (first binding); subject2 holds only credential 3 (last of 4)
const warmGas = async (who, addr) => { await gas(who, addr, benchAbi, "act", []); return gas(who, addr, benchAbi, "act", []); };
for (const k of [1, 2, 4]) rec("externalized", `act, ${k} binding(s), first held`, await warmGas(f.subject, f.targets[`bindings${k}`]), { bindings: k, position: "first" });
rec("externalized", "act, 4 bindings, last held", await warmGas(f.subject2, f.targets.bindings4), { bindings: 4, position: "last" });

// analytic operation counts for a shared qualification
// A shared registry needs the same O(A+N) operations as the externalized scheme:
// one onboarding per target, one grant and one revoke per subject.
for (const A of [1, 4, 16]) for (const N of [10, 100]) {
  w({ type: "ops", label, A, N, rbac: { onboard: A, grants: A * N, revokes: A * N, interfaces: A },
    registry: { onboard: A, grants: N, revokes: N, interfaces: 1 }, externalized: { onboard: A, grants: N, revokes: N, interfaces: 1 },
    appSpecific: { rbac: 2 * A * N, externalized: 2 * A * N, note: "grant+revoke for application-specific roles, both schemes" } });
}
console.log("done");
