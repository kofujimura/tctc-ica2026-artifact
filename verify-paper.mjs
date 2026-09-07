#!/usr/bin/env node
// Check that the numbers printed in the paper match the pinned runs
// (out/paper-runs.json). Exits non-zero on any mismatch.
//   node verify-paper.mjs ../../../Paper/main.tex
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonl, stats } from "./lib/jsonl.mjs";

const texPath = process.argv[2] ?? "../../../Paper/main.tex";
const tex = readFileSync(texPath, "utf8");
const runs = JSON.parse(readFileSync("out/paper-runs.json", "utf8")).runs;
const load = (kind, label) => readJsonl(join("out", runs[kind][label]));
let failures = 0, checks = 0;
const check = (name, paper, actual, tol = 0) => {
  checks++;
  const ok = typeof paper === "number" ? Math.abs(paper - actual) <= tol + 1e-9 : String(paper) === String(actual);
  if (!ok) { failures++; console.log(`✗ ${name}: paper says ${paper}, data says ${actual}`); } else console.log(`✓ ${name}: ${paper}`);
};
const num = (s) => Number(String(s).replace(/[^\d.]/g, ""));

// ---- Table III: latency ----
const condMap = { "ungated": "ungated", "gate, 1 binding": "gate-1b-allow0", "gate, 2 bindings": "gate-2b-allow0", "gate, 4 bindings": "gate-4b-allow0", "gate, cache 5\\,s": "gate-1b-allow5" };
for (const m of tex.matchAll(/^(local|testnet)\s*&\s*(.+?)\s*&\s*([\d.]+)\s*&\s*([\d.]+)\s*&\s*([\d.]+)\s*&\s*(.+?)\s*\\\\/gm)) {
  const [, label, cond, p50, p95, p99, rpc] = m;
  const key = condMap[cond.trim()]; if (!key) { console.log(`? unknown latency condition "${cond}"`); continue; }
  const s = load("latency", label).find((r) => r.type === "summary" && r.condition === key);
  const dec = label === "local" ? 2 : 0, tol = 0.5 * 10 ** -dec;
  check(`latency ${label} ${key} p50`, Number(p50), Number(s.p50.toFixed(dec)), tol);
  check(`latency ${label} ${key} p95`, Number(p95), Number(s.p95.toFixed(dec)), tol);
  check(`latency ${label} ${key} p99`, Number(p99), Number(s.p99.toFixed(dec)), tol);
  if (/^\d/.test(rpc)) check(`latency ${label} ${key} rpc/call`, Number(rpc), Number(s.rpcPerCall.toFixed(1)), 0.5);
}
// ---- Table II: gas (local admin-cost medians, in k) ----
const gasRows = load("admin-cost", "local").filter((r) => r.type === "gas");
const med = (scheme, op) => stats(gasRows.filter((r) => r.scheme === scheme && r.op.startsWith(op)).map((r) => r.gasUsed)).p50 / 1000;
const g = tex.match(/gas, grant \/ revoke & ([\d.]+)k \/ ([\d.]+)k & ([\d.]+)k \/ ([\d.]+)k & ([\d.]+)k \/ ([\d.]+)k/);
if (g) { check("gas rbac grant", Number(g[1]), med("rbac", "grantRole"), 0.05); check("gas rbac revoke", Number(g[2]), med("rbac", "revokeRole"), 0.05);
         check("gas registry grant", Number(g[3]), med("registry", "grantRole"), 0.05); check("gas registry revoke", Number(g[4]), med("registry", "revokeRole"), 0.05);
         check("gas mint", Number(g[5]), med("externalized", "mint"), 0.05); check("gas burn", Number(g[6]), med("externalized", "burnByIssuer"), 0.05); }
const ga = tex.match(/gas, protected action & ([\d.]+)k & ([\d.]+)k & ([\d.]+)k/);
if (ga) { check("gas rbac act", Number(ga[1]), med("rbac", "act"), 0.05); check("gas registry act", Number(ga[2]), med("registry", "act"), 0.05);
          check("gas act 1 binding", Number(ga[3]), med("externalized", "act, 1 binding"), 0.05); }
const g4 = tex.match(/four bindings cost ([\d.]+)k,\s*\n?and ([\d.]+)k when only the last/);
if (g4) { check("gas act 4 bindings first", Number(g4[1]), med("externalized", "act, 4 binding(s)"), 0.05);
          check("gas act 4 bindings last", Number(g4[2]), med("externalized", "act, 4 bindings, last"), 0.05); }
// prose figures quoted in the RQ2 discussion
const gp = tex.match(/([\d.]+)k gas for\s*\n?the registry and ([\d.]+)k for a token with one binding, against ([\d.]+)k/);
if (gp) { check("prose registry act", Number(gp[1]), med("registry", "act"), 0.05); check("prose token act", Number(gp[2]), med("externalized", "act, 1 binding"), 0.05);
          check("prose rbac act", Number(gp[3]), med("rbac", "act"), 0.05); }
// ---- propagation prose ----
const rev = (label) => load("revocation", label).filter((r) => r.type === "cycle");
const lr = rev("local"), tr = rev("testnet");
const st = (rows, phase, k) => stats(rows.filter((r) => r.phase === phase).map((r) => r[k]));
const pm = (re) => { const m = tex.match(re); return m ? Number(m[1]) : undefined; };
check("local burn inclusion p50 (ms)", pm(/a burn was included within (\d+)\\,ms/), Math.round(st(lr, "revoke", "inclusionMs").p50), 0.5);
check("local revoke observed after inclusion p50", pm(/followed inclusion by (\d+)\\,ms median/), Math.round(st(lr, "revoke", "afterInclusionMs").p50), 0.5);
check("local revoke observed after inclusion max", pm(/median and (\d+)\\,ms maximum/), Math.round(st(lr, "revoke", "afterInclusionMs").max), 0.5);
check("local expiry deny after block p50", pm(/past the deadline, (\d+)\\,ms median/), Math.round(st(lr, "expiry", "denyObservedAfterFirstBlockMs").p50), 0.5);
check("testnet grant inclusion p50 (s)", pm(/inclusion took ([\d.]+)\\,s \(median\) for a grant/), Number((st(tr, "grant", "inclusionMs").p50 / 1000).toFixed(1)), 0.05);
check("testnet burn inclusion p50 (s)", pm(/and ([\d.]+)\\,s for a\s+burn/), Number((st(tr, "revoke", "inclusionMs").p50 / 1000).toFixed(1)), 0.05);
check("testnet expiry deny after block p50 (ms)", pm(/first\s+post-deadline block, (\d+)\\,ms median/), Math.round(st(tr, "expiry", "denyObservedAfterFirstBlockMs").p50), 0.5);
// ---- fail-closed count ----
const lt = load("latency", "testnet").filter((r) => r.type === "call" && r.bindings > 0 && r.allowSeconds === 0);
const fc = tex.match(/(\w+) of ([\d,]+) live testnet admissions \(([\d.]+)\\%\)/);
if (fc) { const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
  check("testnet fail-closed count", words[fc[1].toLowerCase()] ?? Number(fc[1]), lt.filter((r) => !r.ok).length); check("testnet live admissions", num(fc[2]), lt.length);
  check("testnet fail-closed %", Number(fc[3]), Number((100 * lt.filter((r) => !r.ok).length / lt.length).toFixed(1)), 0.05); }
// ---- Table V: case study ----
const cs = (label) => load("case-study", label).filter((r) => r.type === "trial" && !r.error);
const condName = { "granted": "granted", "no grant": "denied", "burn": "burn", "expiry": "expiry", "injection": "injection" };
for (const m of tex.matchAll(/^(granted|no grant|burn|expiry|injection|all five)\s*&\s*([AB])\s*&\s*(\d+)\/(\d+)\s*&\s*(?:\d+\s*&\s*)?([\d.]+)\s*&\s*(\d+)\/(\d+)\s*&\s*(\d+)\/(\d+)\s*&\s*(\d+)\/(\d+)/gm)) {
  const [, cond, model, done, n, calls, ga_, gd, w2, w4, co, cr] = m;
  const rows = cs(model === "A" ? "local" : "local-haiku").filter((r) => cond === "all five" || r.condition === condName[cond]);
  const sum = (k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
  const tag = `case ${cond} ${model}`;
  check(`${tag} n`, Number(n), rows.length); check(`${tag} done`, Number(done), rows.filter((r) => r.success).length);
  check(`${tag} calls`, Number(calls), Number((sum("toolCalls") / rows.length).toFixed(1)), 0.05);
  check(`${tag} gate`, `${ga_}/${gd}`, `${sum("gateAllows")}/${sum("gateDenies")}`); check(`${tag} web`, `${w2}/${w4}`, `${sum("web200")}/${sum("web403")}`); check(`${tag} chain`, `${co}/${cr}`, `${sum("chainRecorded")}/${sum("chainReverted")}`);
}
console.log(`\n${checks} checks, ${failures} mismatch(es)`);
process.exit(failures ? 1 : 0);
