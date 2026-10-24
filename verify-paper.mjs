#!/usr/bin/env node
// Check that the numbers printed in the paper match the pinned runs
// (out/paper-runs.json). Exits non-zero on any mismatch.
//   node verify-paper.mjs path/to/main.tex
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonl, stats } from "./lib/jsonl.mjs";
import { quantileCI, clopperPearson } from "./lib/ci.mjs";

const texPath = process.argv[2] ?? "../../Paper/main.tex";
const tex = readFileSync(texPath, "utf8");
// Prose is matched with its line breaks collapsed, so rewrapping a sentence
// cannot hide it from a check; table rows are matched line by line in `tex`.
const flat = tex.replace(/\s+/g, " ");
const runs = JSON.parse(readFileSync("out/paper-runs.json", "utf8")).runs;
const load = (kind, label) => readJsonl(join("out", runs[kind][label]));
let failures = 0, checks = 0;
const check = (name, paper, actual, tol = 0) => {
  checks++;
  const ok = typeof paper === "number" ? Math.abs(paper - actual) <= tol + 1e-9 : String(paper) === String(actual);
  if (!ok) { failures++; console.log(`✗ ${name}: paper says ${paper}, data says ${actual}`); } else console.log(`✓ ${name}: ${paper}`);
};
// A sentence or row that a check expects but cannot find counts as a mismatch.
const found = (name, m) => { if (!m) check(`${name} (quoted)`, "present", "missing"); return m; };
const num = (s) => Number(String(s).replace(/[^\d.]/g, ""));

// ---- Table III: latency, local and testnet side by side ----
const condMap = { "ungated": "ungated", "gate, 1 binding": "gate-1b-allow0", "gate, 2 bindings": "gate-2b-allow0", "gate, 4 bindings": "gate-4b-allow0", "gate, cache 5\\,s": "gate-1b-allow5" };
const lat = tex.slice(tex.indexOf("\\label{tab:latency}"), tex.indexOf("\\end{tabular}", tex.indexOf("\\label{tab:latency}")));
let latRows = 0;
for (const m of lat.matchAll(/^(ungated|gate, [^&]+?)\s*&(.+?)\\\\/gm)) {
  const key = condMap[m[1].trim()]; if (!key) { console.log(`? unknown latency condition "${m[1]}"`); continue; }
  const cells = m[2].split("&").map((c) => c.trim());
  for (const [label, off] of [["local", 0], ["testnet", 4]]) {
    const [p50, p95, p99, rpc] = cells.slice(off, off + 4);
    if (p50 === "--") continue;
    latRows++;
    const s = load("latency", label).find((r) => r.type === "summary" && r.condition === key);
    const dec = label === "local" ? 2 : (Number(p50) < 1 ? 2 : 0), tol = 0.5 * 10 ** -dec;
    check(`latency ${label} ${key} p50`, Number(p50), Number(s.p50.toFixed(dec)), tol);
    check(`latency ${label} ${key} p95`, Number(p95), Number(s.p95.toFixed(dec)), tol);
    check(`latency ${label} ${key} p99`, Number(p99), Number(s.p99.toFixed(dec)), tol);
    if (/^\d/.test(rpc)) check(`latency ${label} ${key} rpc/call`, Number(rpc), Number(s.rpcPerCall.toFixed(1)), 0.5);
  }
}
check("latency table rows", 9, latRows);
// ---- Table II: gas (local admin-cost medians, in k) ----
const gasRows = load("admin-cost", "local").filter((r) => r.type === "gas");
const med = (scheme, op) => stats(gasRows.filter((r) => r.scheme === scheme && r.op.startsWith(op)).map((r) => r.gasUsed)).p50 / 1000;
const g = flat.match(/gas, grant \/ revoke & ([\d.]+)k \/ ([\d.]+)k & ([\d.]+)k \/ ([\d.]+)k & ([\d.]+)k \/ ([\d.]+)k/);
if (found("gas grant/revoke row", g)) { check("gas rbac grant", Number(g[1]), med("rbac", "grantRole"), 0.05); check("gas rbac revoke", Number(g[2]), med("rbac", "revokeRole"), 0.05);
         check("gas registry grant", Number(g[3]), med("registry", "grantRole"), 0.05); check("gas registry revoke", Number(g[4]), med("registry", "revokeRole"), 0.05);
         check("gas mint", Number(g[5]), med("externalized", "mint"), 0.05); check("gas burn", Number(g[6]), med("externalized", "burnByIssuer"), 0.05); }
const ga = flat.match(/gas, protected action & ([\d.]+)k & ([\d.]+)k & ([\d.]+)k/);
if (found("gas protected-action row", ga)) { check("gas rbac act", Number(ga[1]), med("rbac", "act"), 0.05); check("gas registry act", Number(ga[2]), med("registry", "act"), 0.05);
          check("gas act 1 binding", Number(ga[3]), med("externalized", "act, 1 binding"), 0.05); }
const g4 = flat.match(/four bindings cost ([\d.]+)k,\s*\n?and ([\d.]+)k when only the last/);
if (found("gas four-binding sentence", g4)) { check("gas act 4 bindings first", Number(g4[1]), med("externalized", "act, 4 binding(s)"), 0.05);
          check("gas act 4 bindings last", Number(g4[2]), med("externalized", "act, 4 bindings, last"), 0.05); }
// prose figures quoted in the RQ2 discussion
const gp = flat.match(/([\d.]+)k gas for\s*\n?the registry and ([\d.]+)k for a token with one binding, against ([\d.]+)k/);
if (found("gas prose sentence", gp)) { check("prose registry act", Number(gp[1]), med("registry", "act"), 0.05); check("prose token act", Number(gp[2]), med("externalized", "act, 1 binding"), 0.05);
          check("prose rbac act", Number(gp[3]), med("rbac", "act"), 0.05); }
// ---- propagation prose ----
const rev = (label) => load("revocation", label).filter((r) => r.type === "cycle");
const lr = rev("local"), tr = rev("testnet");
const st = (rows, phase, k) => stats(rows.filter((r) => r.phase === phase).map((r) => r[k]));
const pm = (re) => { const m = flat.match(re); return m ? Number(m[1]) : undefined; };
check("local burn inclusion p50 (ms)", pm(/a burn was included within (\d+)\\,ms/), Math.round(st(lr, "revoke", "inclusionMs").p50), 0.5);
check("local revoke observed after inclusion p50", pm(/followed inclusion by (\d+)\\,ms median/), Math.round(st(lr, "revoke", "afterInclusionMs").p50), 0.5);
check("local revoke observed after inclusion max", pm(/(\d+)\\,ms at most, and all 30 expiring/), Math.round(st(lr, "revoke", "afterInclusionMs").max), 0.5);
check("local expiry deny after block p50", pm(/past the deadline(?: \(95\\% CI\s+\d+--\d+\\%\))?,\s+(\d+)\\,ms median/), Math.round(st(lr, "expiry", "denyObservedAfterFirstBlockMs").p50), 0.5);
check("testnet grant inclusion p50 (s)", pm(/inclusion took ([\d.]+)\\,s \(median\) for a grant/), Number((st(tr, "grant", "inclusionMs").p50 / 1000).toFixed(1)), 0.05);
check("testnet burn inclusion p50 (s)", pm(/and ([\d.]+)\\,s for a\s+burn/), Number((st(tr, "revoke", "inclusionMs").p50 / 1000).toFixed(1)), 0.05);
check("testnet expiry deny after block p50 (ms)", pm(/first\s+post-deadline block(?: \(95\\% CI \d+--\d+\\%\))?,\s+(\d+)\\,ms median/), Math.round(st(tr, "expiry", "denyObservedAfterFirstBlockMs").p50), 0.5);
// ---- fail-closed count ----
const lt = load("latency", "testnet").filter((r) => r.type === "call" && r.bindings > 0 && r.allowSeconds === 0);
const fc = flat.match(/(\w+) of ([\d,]+) live testnet admissions \(([\d.]+)\\%(?:, 95\\% CI ([\d.]+)--([\d.]+)\\%)?\)/);
if (found("testnet fail-closed sentence", fc)) { const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
  check("testnet fail-closed count", words[fc[1].toLowerCase()] ?? Number(fc[1]), lt.filter((r) => !r.ok).length); check("testnet live admissions", num(fc[2]), lt.length);
  check("testnet fail-closed %", Number(fc[3]), Number((100 * lt.filter((r) => !r.ok).length / lt.length).toFixed(1)), 0.05);
  if (fc[4]) { const ci = clopperPearson(lt.filter((r) => !r.ok).length, lt.length);
    check("testnet fail-closed CI lo %", Number(fc[4]), Number((100 * ci.lo).toFixed(2)), 0.005); check("testnet fail-closed CI hi %", Number(fc[5]), Number((100 * ci.hi).toFixed(2)), 0.005); } }
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
// ---- 95% intervals quoted in the prose (lib/ci.mjs) ----
const callsOf = (label, cond) => load("latency", label).filter((r) => r.type === "call" && r.condition === cond).map((r) => r.ms);
const ciCheck = (name, re, values, p, dec) => {
  const m = flat.match(re); if (!m) { check(`${name} (quoted)`, "present", "missing"); return; }
  const ci = quantileCI(values, p), tol = 0.5 * 10 ** -dec;
  check(`${name} CI lo`, Number(m[1]), Number(ci.lo.toFixed(dec)), tol); check(`${name} CI hi`, Number(m[2]), Number(ci.hi.toFixed(dec)), tol);
};
ciCheck("local 1-binding median", /1\.47\\,ms median with one binding \(95\\% CI\s+([\d.]+)--([\d.]+)\\,ms\)/, callsOf("local", "gate-1b-allow0"), 0.5, 2);
ciCheck("testnet 1-binding median", /46\\,ms median \(95\\% CI\s+([\d.]+)--([\d.]+)\\,ms\)/, callsOf("testnet", "gate-1b-allow0"), 0.5, 0);
ciCheck("testnet 2-binding median", /spans\s+([\d.]+)--([\d.]+)\\,ms because/, callsOf("testnet", "gate-2b-allow0"), 0.5, 0);
const revRows = (label, phase, k) => rev(label).filter((r) => r.phase === phase).map((r) => r[k]);
const propCI = (name, re, rows) => {
  const m = flat.match(re); if (!m) { check(`${name} (quoted)`, "present", "missing"); return; }
  const k = rows.filter((r) => r.denyBlockIsFirstBlock).length, ci = clopperPearson(k, rows.length);
  check(`${name} lo %`, Number(m[1]), Math.round(100 * ci.lo), 0.5); check(`${name} hi %`, Number(m[2]), Math.round(100 * ci.hi), 0.5);
};
propCI("local expiries at first block", /past the deadline \(95\\% CI\s+(\d+)--(\d+)\\%\)/, rev("local").filter((r) => r.phase === "expiry"));
propCI("testnet expiries at first block", /post-deadline block \(95\\% CI (\d+)--(\d+)\\%\)/, rev("testnet").filter((r) => r.phase === "expiry"));
{
  const ai = [...revRows("testnet", "grant", "afterInclusionMs"), ...revRows("testnet", "revoke", "afterInclusionMs")];
  const m = flat.match(/observed at most ([\d.]+)\\,s after the\s+issuer's client learned of inclusion, in (\d+) of (\d+) cycles even before it/);
  if (m) { check("testnet latest observation after inclusion (s)", Number(m[1]), Number((Math.max(...ai) / 1000).toFixed(2)), 0.005);
    check("testnet observations before inclusion was learned", Number(m[2]), ai.filter((x) => x < 0).length); check("testnet cycles", Number(m[3]), ai.length); }
  else check("testnet observation sentence (quoted)", "present", "missing");
  const pollMs = load("revocation", "testnet").find((r) => r.type === "meta").pollMs;
  const pm2 = flat.match(/the gated client\s+every (\d+)\\,ms/); check("testnet gated-client poll (ms)", pm2 ? Number(pm2[1]) : "missing", pollMs);
}
// ---- gas determinism ----
{
  const groups = new Map(); for (const r of gasRows) { const k = `${r.scheme}|${r.op}`; groups.set(k, [...(groups.get(k) ?? []), r.gasUsed]); }
  const rep = [...groups.values()].filter((v) => v.length > 1);
  if (found("gas determinism sentence", /Gas, deterministic for a given state/.test(flat)))
    check("gas: repeated operations identical", rep.length, rep.filter((v) => new Set(v).size === 1).length);
}
// ---- case study proportions ----
{
  const all = [...cs("local"), ...cs("local-haiku")];
  const denied = all.filter((r) => r.firstDenialIndex >= 0);
  const m1 = flat.match(/\(0 of the (\d+)\s+trials that received a denial; 95\\% CI 0--(\d+)\\%\)/);
  if (m1) { check("case: trials that received a denial", Number(m1[1]), denied.length); check("case: retry CI hi %", Number(m1[2]), Math.round(100 * clopperPearson(0, denied.length).hi), 0.5); }
  else check("case retry sentence (quoted)", "present", "missing");
  const inj = all.filter((r) => r.condition === "injection");
  const m2 = flat.match(/followed in none\s+of (\d+) trials \(95\\% CI 0--(\d+)\\%/);
  if (found("case injection sentence", m2)) { check("case: injection trials", Number(m2[1]), inj.length); check("case: injection followed", 0, inj.filter((r) => r.injectedAttempts > 0 || r.approvedFileCreated).length);
    check("case: injection CI hi %", Number(m2[2]), Math.round(100 * clopperPearson(0, inj.length).hi), 0.5); }
  const m3 = flat.match(/0 of (\d+) trials had an unauthorized\s+effect \(95\\% CI 0--([\d.]+)\\%\)/);
  if (m3) { check("case: trials", Number(m3[1]), all.length); check("case: unauthorized CI hi %", Number(m3[2]), Number((100 * clopperPearson(0, all.length).hi).toFixed(1)), 0.05); }
  else check("case unauthorized sentence (quoted)", "present", "missing");
}
// ---- Table II: executed operation counts (admin-ops) ----
{
  const ops = load("admin-ops", "local").filter((r) => r.type === "ops-measured");
  const get = (scheme, A, N) => ops.find((r) => r.scheme === scheme && r.A === A && r.N === N);
  const cell = (r) => `${r.onboard}+${r.grants + r.revokes}`;
  const t2 = tex.slice(tex.indexOf("\\label{tab:rq2}"), tex.indexOf("\\end{tabular}", tex.indexOf("\\label{tab:rq2}")));
  const [shared, perDomain] = t2.split("one administrative domain per target");
  const rowsOf = (block) => [...block.matchAll(/^\$(?:\(A,N\)=)?\((\d+),(\d+)\)\$\s*&\s*\$(\d+)\+(\d+)\$\s*&\s*\$(\d+)\+(\d+)\$\s*&\s*\$(\d+)\+(\d+)\$/gm)];
  for (const m of rowsOf(shared)) { const [A, N] = [Number(m[1]), Number(m[2])];
    check(`ops (${A},${N}) rbac`, `${m[3]}+${m[4]}`, cell(get("rbac", A, N))); check(`ops (${A},${N}) registry`, `${m[5]}+${m[6]}`, cell(get("registry", A, N))); check(`ops (${A},${N}) token`, `${m[7]}+${m[8]}`, cell(get("token", A, N))); }
  for (const m of rowsOf(perDomain ?? "")) { const [A, N] = [Number(m[1]), Number(m[2])];
    check(`ops per-domain (${A},${N}) rbac`, `${m[3]}+${m[4]}`, cell(get("rbac", A, N))); check(`ops per-domain (${A},${N}) registry`, `${m[5]}+${m[6]}`, cell(get("registry-dom", A, N))); check(`ops per-domain (${A},${N}) token`, `${m[7]}+${m[8]}`, cell(get("token", A, N))); }
  const more = [...t2.matchAll(/^one more target & \$?([\d+]+)\$? & \$?([\d+]+)\$? & \$?([\d+]+)\$? \\\\/gm)];
  const ev = (x) => x.split("+").reduce((a, b) => a + Number(b), 0);
  const N100 = (scheme) => get(scheme, 16, 100).addTarget;
  if (found("one more target row", more[0])) { check("one more target rbac", ev(more[0][1]), N100("rbac")); check("one more target registry", ev(more[0][2]), N100("registry")); check("one more target token", ev(more[0][3]), N100("token")); }
  if (found("one more target row, new domain", more[1])) { check("one more target, new domain", ev(more[1][2]), N100("registry-dom")); }
  check("ops: every executed count equals the derived one", ops.length, ops.filter((r) => r.matchesExpected).length);
  const pr = flat.match(/counts return to those of per-target RBAC, \$(\d+)\+(\d+)\$ at \$\((\d+),(\d+)\)\$, while the\s+token scheme stays at \$(\d+)\+(\d+)\$/);
  if (found("per-domain prose sentence", pr)) { check("prose per-domain registry", `${pr[1]}+${pr[2]}`, cell(get("registry-dom", Number(pr[3]), Number(pr[4])))); check("prose token", `${pr[5]}+${pr[6]}`, cell(get("token", Number(pr[3]), Number(pr[4])))); }
}
// ---- issuer–target separation (RQ1 prose) ----
{
  const rows = load("separation", "local"), sum = rows.find((r) => r.type === "summary");
  const by = sum.adminTxBySigner, n = (ph, who) => by[ph]?.[who] ?? 0;
  const rev_ = (who) => n("burn", who) + n("burn2", who);
  const m = found("separation transaction sentence", flat.match(/\$I_1\$ signed (\d+) issuing transactions and (\d+) burn, \$I_2\$ (\d+) and (\d+), and \$T_1\$, \$T_2\$ and \$T_3\$ signed (\d+), (\d+) and (\d+) onboarding transactions and nothing else/));
  if (m) {
    check("separation I1 issue", Number(m[1]), n("issue", "I1")); check("separation I1 revoke", Number(m[2]), rev_("I1"));
    check("separation I2 issue", Number(m[3]), n("issue", "I2")); check("separation I2 revoke", Number(m[4]), rev_("I2"));
    for (const [i, who] of [[5, "T1"], [6, "T2"], [7, "T3"]]) {
      check(`separation ${who} onboard`, Number(m[i]), n("onboard", who));
      check(`separation ${who} nothing else`, 0, n("issue", who) + rev_(who));
    }
    check("separation issuers onboard nothing", 0, n("onboard", "I1") + n("onboard", "I2"));
  }
  check("separation: cross-organization administrative writes", 0, sum.crossOrgAdminWrites);
  check("separation: all checks and attacks pass", 0, sum.failures);
  const words = { eleven: 11, ten: 10, twelve: 12 };
  const ma = flat.match(/None of these (\w+)\s+attempts had an effect/);
  check("separation: attack count", ma ? words[ma[1]] : "missing", rows.filter((r) => r.type === "attack" && r.pass && r.stateUnchanged).length);
}
console.log(`\n${checks} checks, ${failures} mismatch(es)`);
process.exit(failures ? 1 : 0);
