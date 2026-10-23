#!/usr/bin/env node
// RQ1, issuer–target separation (local node only). Every other run deploys all
// fixtures from one account, so the issuer and the targets share an
// administrator. Here each organization signs with its own key:
//   I1, I2  two unrelated issuers, each owning one control-token contract;
//   T1      an organization whose contract action is the protected resource;
//   T2      an organization that runs an MCP server behind tctc-gate;
//   T3      an organization that runs a SIWE-authenticated web API;
//   S, S2   subjects (S holds I1's token, S2 holds I2's); X an outsider.
// I1 and I2 issue before any target exists. Each target then deploys its own
// BindableTarget, names its own local role and binds it with transactions of
// its own, T3 to both issuers. The run logs the signer of every transaction,
// so who administered what is read from the log; it then probes the
// authority boundaries an attacker would try (minting, burning, rebinding,
// counterfeiting, transferring, replaying) and ends with each issuer's burn.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toHex, encodeFunctionData } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { parseArgs, runMeta, clients, deploy, artifact, META_NS, EXP_ROOT } from "../lib/chain.mjs";
import { loadFixtures } from "../lib/fixtures.mjs";
import { gateConfig, startGate } from "../lib/gate.mjs";
import { jsonlWriter, stamp } from "../lib/jsonl.mjs";

const a = parseArgs(process.argv.slice(2), { fixtures: "out/fixtures.local.json", label: undefined, rpc: undefined, out: undefined });
const f = loadFixtures(a.fixtures, a.rpc);
if (f.chainId !== 31337) throw new Error("separation run uses Hardhat's deterministic accounts and runs on the local node only");
const label = a.label ?? f.meta.label;
const out = a.out ?? `out/separation.${label}.${stamp()}.jsonl`;
const w = jsonlWriter(out);
w({ type: "meta", kind: "separation", label, ...runMeta({ fixtures: a.fixtures, rpcUrl: f.rpcUrl, chainId: f.chainId }) });
console.log(`issuer–target separation → ${out}`);

// Hardhat accounts 3..10 (0..2 are the shared fixtures' issuer and subjects).
const MNEMONIC = "test test test test test test test test test test test junk";
const keyAt = (i) => toHex(mnemonicToAccount(MNEMONIC, { addressIndex: i }).getHdKey().privateKey);
const ORGS = ["I1", "I2", "T1", "T2", "T3", "S", "S2", "X"];
const acct = Object.fromEntries(ORGS.map((n, k) => [n, clients(f.rpcUrl, f.chainId, keyAt(3 + k))]));
for (const n of ORGS) w({ type: "account", name: n, address: acct[n].address });
const ctAbi = artifact("AgentControlTokens").abi, etAbi = artifact("ExpiringControlTokens").abi, btAbi = artifact("BindableTarget").abi;
const MCP_BIN = join(EXP_ROOT, "..", "dist", "index.js");

let phase = "issue";
const revertReason = (e) => {
  const r = e?.walk?.((x) => x?.name === "ContractFunctionRevertedError");
  return r?.reason ?? r?.data?.errorName ?? e?.details ?? e?.shortMessage ?? String(e?.message ?? e).slice(0, 160);
};
async function send(who, address, abi, functionName, args = []) {
  const c = acct[who];
  try {
    const hash = await c.wallet.writeContract({ address, abi, functionName, args });
    const rc = await c.pub.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    const row = { type: "tx", phase, signer: who, to: address, fn: functionName, status: rc.status, block: Number(rc.blockNumber) };
    w(row); return row;
  } catch (e) {
    // Refused when the node executes the call: the contract reverts, no transaction is included.
    const row = { type: "tx", phase, signer: who, to: address, fn: functionName, status: "refused", reason: revertReason(e) };
    w(row); return row;
  }
}
async function deployAs(who, name, args) {
  const d = await deploy(acct[who], name, args);
  w({ type: "tx", phase, signer: who, to: null, fn: `deploy ${name}`, status: "success", block: d.blockNumber, contract: d.address });
  return d.address;
}
const read = (address, abi, functionName, args = []) => acct.X.pub.readContract({ address, abi, functionName, args });
let failures = 0;
const check = (pep, subject, expected, observed, extra = {}) => {
  const pass = observed === expected;
  if (!pass) failures++;
  w({ type: "check", phase, pep, subject, expected, observed, pass, ...extra });
  console.log(`  ${pass ? "✅" : "❌"} [${phase}] ${pep.padEnd(20)} ${subject.padEnd(3)} expected ${expected}, observed ${observed}`);
};
const attack = (scenario, expected, observed, stateUnchanged, extra = {}) => {
  const pass = observed === expected && stateUnchanged;
  if (!pass) failures++;
  w({ type: "attack", scenario, expected, observed, stateUnchanged, pass, ...extra });
  console.log(`  ${pass ? "✅" : "❌"} attack ${scenario.padEnd(38)} expected ${expected}, observed ${observed}${stateUnchanged ? "" : " STATE CHANGED"}`);
};

// ---- issue: two unrelated issuers issue before any target exists ----
const ct1 = await deployAs("I1", "AgentControlTokens", ["Issuer 1 qualification"]);
const et1 = await deployAs("I1", "ExpiringControlTokens", ["Issuer 1 timed qualification"]);
const ct2 = await deployAs("I2", "AgentControlTokens", ["Issuer 2 qualification"]);
await send("I1", ct1, ctAbi, "mint", [acct.S.address, 1n, 1n]);
const now = Number((await acct.I1.pub.getBlock()).timestamp);
await send("I1", et1, etAbi, "mint", [acct.S.address, 1n, BigInt(now + 3600)]);
await send("I2", ct2, ctAbi, "mint", [acct.S2.address, 1n, 1n]);

// ---- onboard: each target organization adopts the issuers on its own ----
phase = "onboard";
const t1 = await deployAs("T1", "BindableTarget", ["OPERATOR"]);
await send("T1", t1, btAbi, "bindERC1155", [ct1, 1n]);
const t2 = await deployAs("T2", "BindableTarget", ["FS_READER"]);
await send("T2", t2, btAbi, "bindERC1155", [ct1, 1n]);
const t3 = await deployAs("T3", "BindableTarget", ["SUMMARIZER"]);
await send("T3", t3, btAbi, "bindERC1155", [ct1, 1n]);
await send("T3", t3, btAbi, "bindERC1155", [ct2, 1n]);
const tokens = { [ct1]: "I1", [et1]: "I1", [ct2]: "I2" }, targets = { [t1]: "T1", [t2]: "T2", [t3]: "T3" };
for (const [addr, org] of Object.entries(tokens)) w({ type: "authority", contract: addr, kind: "token", org, owner: await read(addr, ctAbi, "owner") });
for (const [addr, org] of Object.entries(targets)) w({ type: "authority", contract: addr, kind: "target", org, owner: await read(addr, btAbi, "owner"),
  role: await read(addr, btAbi, "ROLE"), bindings: (await read(addr, btAbi, "getERC1155ControlTokens", [await read(addr, btAbi, "ROLE")]))[0] });

// ---- enforcement points ----
const act = async (who, target) => { const r = await send(who, target, btAbi, "act"); return r.status === "success" ? "allow" : "deny"; };
const gates = {};
for (const who of ["S", "S2", "X"]) {
  gates[who] = await startGate(gateConfig({ rpcUrl: f.rpcUrl, chainId: f.chainId, target: t2, subject: acct[who].address, tools: { echo: ["FS_READER"] } }));
}
const gateCall = async (who) => {
  const r = await gates[who].client.callTool("echo", { text: "x" });
  return r?.result && r.result.isError !== true ? "allow" : r?.result?._meta?.[META_NS]?.code ?? "error";
};
const upstream = () => Object.values(gates).reduce((n, g) => n + g.upstreamCalls(), 0);
let gateAllows = 0;
const gateCheck = async (who, expected) => { const v = await gateCall(who); if (v === "allow") gateAllows++; check("MCP gate (T2)", who, expected, v); };

const webDir = mkdtempSync(join(tmpdir(), "tctc-separation-"));
const webProc = spawn(process.execPath, [join(EXP_ROOT, "lib", "web-api.mjs")], {
  env: { ...process.env, WEB_API_PORT: "0", RPC: f.rpcUrl, CHAIN_ID: String(f.chainId), TARGET: t3, ROLE: "SUMMARIZER", LOG_FILE: join(webDir, "web-api.jsonl"), TCTC_MCP_BIN: MCP_BIN },
  stdio: ["ignore", "pipe", "inherit"] });
const webUrl = await new Promise((res, rej) => { webProc.stdout.once("data", (d) => res(d.toString().trim())); webProc.once("exit", (c) => rej(new Error(`web api exited ${c}`))); });
async function siweLogin(who) {
  const account = acct[who].wallet.account;
  const { nonce } = await (await fetch(`${webUrl}/api/auth/nonce`)).json();
  const message = createSiweMessage({ address: account.address, chainId: f.chainId, domain: "127.0.0.1", nonce, uri: webUrl, version: "1", statement: "Sign in to the summarizer." });
  const signature = await account.signMessage({ message });
  const r = await fetch(`${webUrl}/api/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature }) });
  return { status: r.status, cookie: (r.headers.get("set-cookie") ?? "").split(";")[0], message, signature };
}
const webCall = async (cookie) => String((await fetch(`${webUrl}/api/summarize`, { method: "POST",
  headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ text: "One. Two." }) })).status);

// ---- use: every target decides from the issuers' state, with no issuer transaction since issuing ----
phase = "use";
check("contract (T1)", "S", "allow", await act("S", t1));
check("contract (T1)", "S2", "deny", await act("S2", t1));
check("contract (T1)", "X", "deny", await act("X", t1));
await gateCheck("S", "allow");
await gateCheck("S2", "TCTC_ROLE_DENIED");
await gateCheck("X", "TCTC_ROLE_DENIED");
const login = { S: await siweLogin("S"), S2: await siweLogin("S2"), X: await siweLogin("X") };
check("web API (T3)", "S", "200", await webCall(login.S.cookie));
check("web API (T3)", "S2", "200", await webCall(login.S2.cookie));
check("web API (T3)", "X", "403", await webCall(login.X.cookie));

// ---- attack: the authority boundaries between organizations ----
phase = "attack";
const bal = (token, who, id = 1n) => read(token, ctAbi, "balanceOf", [acct[who].address, id]);
const bindingsOf = async (t) => (await read(t, btAbi, "getERC1155ControlTokens", [await read(t, btAbi, "ROLE")]))[0].join(",");
{
  const r = await send("T1", ct1, ctAbi, "mint", [acct.T1.address, 1n, 1n]);
  attack("target admin mints the issuer's token", "refused", r.status, (await bal(ct1, "T1")) === 0n, { reason: r.reason });
}
{
  const r = await send("T1", ct1, ctAbi, "burnByIssuer", [acct.S.address, 1n, 1n]);
  attack("target admin burns a holder's token", "refused", r.status, (await bal(ct1, "S")) === 1n, { reason: r.reason });
}
{
  const r = await send("X", ct1, ctAbi, "mint", [acct.X.address, 1n, 1n]);
  attack("outsider mints the issuer's token", "refused", r.status, (await bal(ct1, "X")) === 0n, { reason: r.reason });
}
{
  const before = await bindingsOf(t1);
  const r = await send("I1", t1, btAbi, "bindERC1155", [ct1, 2n]);
  attack("issuer rebinds a target's role", "refused", r.status, (await bindingsOf(t1)) === before, { reason: r.reason });
}
// a counterfeit collection with the issuer's name, minted by the outsider to itself
const cx = await deployAs("X", "AgentControlTokens", ["Issuer 1 qualification"]);
await send("X", cx, ctAbi, "mint", [acct.X.address, 1n, 1n]);
{
  const before = await bindingsOf(t2);
  const r = await send("X", t2, btAbi, "bindERC1155", [cx, 1n]);
  attack("outsider binds its own token at a target", "refused", r.status, (await bindingsOf(t2)) === before, { reason: r.reason });
}
{
  const sameName = (await read(cx, ctAbi, "name")) === (await read(ct1, ctAbi, "name"));
  const verdicts = [await act("X", t1), await gateCall("X"), await webCall(login.X.cookie)];
  attack("counterfeit collection with the issuer's name", "deny,TCTC_ROLE_DENIED,403", verdicts.join(","), sameName && (await bal(cx, "X")) === 1n, { sameName });
}
{
  const r = await send("S", ct1, ctAbi, "safeTransferFrom", [acct.S.address, acct.X.address, 1n, 1n, "0x"]);
  attack("holder transfers its token", "refused", r.status, (await bal(ct1, "S")) === 1n && (await bal(ct1, "X")) === 0n, { reason: r.reason });
}
{
  await send("S", ct1, ctAbi, "setApprovalForAll", [acct.X.address, true]);
  const r = await send("X", ct1, ctAbi, "safeTransferFrom", [acct.S.address, acct.X.address, 1n, 1n, "0x"]);
  await send("S", ct1, ctAbi, "setApprovalForAll", [acct.X.address, false]);
  attack("approved operator transfers the token", "refused", r.status, (await bal(ct1, "S")) === 1n && (await bal(ct1, "X")) === 0n, { reason: r.reason });
}
{
  const r = await send("S", et1, etAbi, "safeTransferFrom", [acct.S.address, acct.X.address, 1n, 1n, "0x"]);
  const ok = (await read(et1, etAbi, "balanceOf", [acct.S.address, 1n])) === 1n && (await read(et1, etAbi, "balanceOf", [acct.X.address, 1n])) === 0n;
  attack("holder transfers its timed token", "refused", r.status, ok, { reason: r.reason });
}
{
  // replay the subject's captured sign-in (message and signature) from another client
  const r = await fetch(`${webUrl}/api/auth/verify`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: login.S.message, signature: login.S.signature }) });
  attack("replayed SIWE sign-in", "401", String(r.status), !(r.headers.get("set-cookie") ?? "").includes("session="));
}
{
  // rebroadcast a signed protected-action transaction
  const before = await read(t1, btAbi, "actions");
  const req = await acct.S.wallet.prepareTransactionRequest({ to: t1, data: encodeFunctionData({ abi: btAbi, functionName: "act" }), gas: 100_000n });
  const raw = await acct.S.wallet.signTransaction(req);
  const h = await acct.S.pub.sendRawTransaction({ serializedTransaction: raw });
  await acct.S.pub.waitForTransactionReceipt({ hash: h, pollingInterval: 50 });
  w({ type: "tx", phase, signer: "S", to: t1, fn: "act (signed, first broadcast)", status: "success" });
  let observed = "accepted", reason;
  try { await acct.S.pub.sendRawTransaction({ serializedTransaction: raw }); } catch (e) { observed = "refused"; reason = revertReason(e); }
  attack("rebroadcast signed transaction", "refused", observed, (await read(t1, btAbi, "actions")) === before + 1n, { reason });
}
// A session cookie is a bearer artifact: until the next live check fails, a thief can use it.
const stolen = login.S.cookie;
check("web API (T3)", "X with S's session", "200", await webCall(stolen), { note: "stolen session before the burn" });

// ---- burn: one transaction by the issuer, nothing at any target ----
phase = "burn";
await send("I1", ct1, ctAbi, "burnByIssuer", [acct.S.address, 1n, 1n]);
check("contract (T1)", "S", "deny", await act("S", t1));
await gateCheck("S", "TCTC_ROLE_DENIED");
check("web API (T3)", "S", "403", await webCall(login.S.cookie));
check("web API (T3)", "X with S's session", "403", await webCall(stolen), { note: "stolen session after the burn" });
check("web API (T3)", "S2", "200", await webCall(login.S2.cookie), { note: "the other issuer's holder is unaffected" });
phase = "burn2";
await send("I2", ct2, ctAbi, "burnByIssuer", [acct.S2.address, 1n, 1n]);
check("web API (T3)", "S2", "403", await webCall(login.S2.cookie));

for (const g of Object.values(gates)) await g.client.close();
webProc.kill();

// ---- who administered what, from the transaction log ----
const rows = (await import("../lib/jsonl.mjs")).readJsonl(out);
const mined = rows.filter((r) => r.type === "tx" && r.status === "success");
const admin = mined.filter((r) => ["issue", "onboard", "burn", "burn2"].includes(r.phase));
const bySigner = {};
for (const r of admin) { bySigner[r.phase] ??= {}; bySigner[r.phase][r.signer] = (bySigner[r.phase][r.signer] ?? 0) + 1; }
const own = (signer, to) => to === null || (tokens[to] ?? targets[to]) === signer || (signer === "X" && to === cx);
const crossOrgAdminWrites = admin.filter((r) => !own(r.signer, r.to)).length;
const deniedForwarded = upstream() - gateAllows;
w({ type: "summary", adminTxBySigner: bySigner, crossOrgAdminWrites, deniedForwarded, failures,
  attacks: rows.filter((r) => r.type === "attack").length, checks: rows.filter((r) => r.type === "check").length });
console.log(`  administration transactions by signer: ${JSON.stringify(bySigner)}`);
console.log(`  administrative writes into another organization's contract: ${crossOrgAdminWrites}; denied gate calls forwarded: ${deniedForwarded}`);
console.log(failures ? `FAILED (${failures})` : "done");
process.exit(failures ? 1 : 0);
