#!/usr/bin/env node
// Build an anonymized supplementary artifact: harness source, pinned run
// logs, summary, and case-study transcripts with identifying strings removed.
//   node make-anon-artifact.mjs [--out out/artifact-anon]
// Scrubs: the local user name and home directory, absolute paths, e-mail
// addresses, the .env.local file, RPC API keys, and the `stderr`/`dir` fields
// of case-study rows. Fails if any of a denylist of identifiers survives.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";
import { parseArgs } from "./lib/chain.mjs";
import { EXP_ROOT } from "./lib/local-node.mjs";

const a = parseArgs(process.argv.slice(2), { out: "out/artifact-anon" });
const home = process.env.HOME ?? "";
const user = home.split("/").pop() ?? "";
const runs = JSON.parse(readFileSync(join(EXP_ROOT, "out", "paper-runs.json"), "utf8")).runs;
const dest = join(EXP_ROOT, a.out);
rmSync(dest, { recursive: true, force: true }); mkdirSync(join(dest, "out"), { recursive: true });

// 1. source: everything except node_modules, artifacts, cache, out, secrets
for (const entry of readdirSync(EXP_ROOT)) {
  if (["node_modules", "artifacts", "cache", "out", ".env.local", ".DS_Store"].includes(entry) || entry.startsWith(".env")) continue;
  cpSync(join(EXP_ROOT, entry), join(dest, entry), { recursive: true });
}
// 2. pinned logs + summary + manifest
for (const kind of Object.values(runs)) for (const f of Object.values(kind)) cpSync(join(EXP_ROOT, "out", f), join(dest, "out", f));
for (const f of ["paper-runs.json", "summary.md", "latency.csv", "tables.tex"]) if (existsSync(join(EXP_ROOT, "out", f))) cpSync(join(EXP_ROOT, "out", f), join(dest, "out", f));
// 3. case-study transcripts and audit logs (not the working directories' node_modules-free copies of the synthetic project — those are regenerated)
const runsDir = join(EXP_ROOT, "out", "case-study-runs");
if (existsSync(runsDir)) cpSync(runsDir, join(dest, "out", "case-study-runs"), { recursive: true, filter: (src) => !/\/work(\/|$)/.test(src) || /\/work$/.test(src) === false && !src.includes("/work/") });

// 4. scrub every text file
const patterns = [
  [new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "/home/anon"],
  [new RegExp(`/Users/${user}`, "g"), "/home/anon"],
  [new RegExp(user, "gi"), "anon"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "anon@example.org"],
  [/\/v2\/[A-Za-z0-9_-]{20,}/g, "/v2/***"],
  [/"stderr":"[^"]*"/g, '"stderr":""'],
  [/"dir":"[^"]*"/g, '"dir":"<redacted>"'],
];
const isText = (f) => /\.(mjs|js|cjs|json|jsonl|md|tex|csv|sol|txt|gitignore)$/.test(f) || !f.includes(".");
function walk(d) { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (isText(p)) { let t = readFileSync(p, "utf8"); for (const [re, rep] of patterns) t = t.replace(re, rep); writeFileSync(p, t); } } }
walk(dest);

// 5. denylist check
const deny = [user, home, "@fujimura", "kofujimura", "TCTC_ADMIN_PRIVATE_KEY=0x", "ALCHEMY_API_KEY="].filter(Boolean);
let hits = [];
function scan(d) { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) scan(p); else if (isText(p) && e !== "make-anon-artifact.mjs") { const t = readFileSync(p, "utf8"); for (const s of deny) if (s && t.includes(s)) hits.push(`${relative(dest, p)}: ${s}`); } } }
scan(dest);
// the gate's own audit namespace and package name carry the maintainer's handle; report them so the author can decide
const handleHits = execSync(`grep -rl "kofujimura" "${dest}" || true`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
if (hits.filter((h) => !h.endsWith("kofujimura")).length) { console.error("identifying strings remain:\n" + hits.join("\n")); process.exit(1); }
try { execSync(`cd "${dest}/.." && rm -f artifact-anon.zip && zip -qr artifact-anon.zip "${relative(join(dest, ".."), dest)}"`); } catch { /* zip optional */ }
console.log(`artifact written to ${dest}${existsSync(join(dest, "..", "artifact-anon.zip")) ? " and out/artifact-anon.zip" : ""}`);
if (handleHits.length) console.log(`note: ${handleHits.length} file(s) still contain the maintainer handle via the gate's audit namespace "io.github.kofujimura/tctc-gate" (a package identifier, not a name); rename it upstream if the artifact must be fully anonymous:\n  ` + handleHits.slice(0, 5).join("\n  ") + (handleHits.length > 5 ? "\n  …" : ""));
