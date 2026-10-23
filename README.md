# Evaluation harness

Reproducible measurements for the paper *Grant Once, Revoke Everywhere:
Cross-Application AI Agent Authorization via On-Chain Credentials*.

Everything runs against the `tctc-gate` and `tctc-mcp` builds in this
repository, driven through a real stdio MCP client. One command starts a
local chain, deploys the fixtures, runs the benchmarks and regenerates every
table in the paper from the raw logs.

## What it measures

| Script | Question | Output |
|---|---|---|
| `bench/rq1.mjs`, `bench/rq1-web.mjs` | Does one token type serve heterogeneous enforcement points? | grant / use / revoke / expiry against a contract, three unmodified npm MCP servers behind the gateway, and a SIWE-authenticated web route |
| `bench/separation.mjs` | Does it hold when issuer and targets are different organizations? | two issuers and three target organizations on separate keys: who signed what, eleven authority-boundary attacks, and each issuer's burn (local only) |
| `bench/admin-cost.mjs` | What does administration cost? | operation counts and gas for per-target RBAC (`AccessControl`), a shared registry (`AccessManager`) and externalized tokens |
| `bench/admin-ops.mjs` | Do the operation counts hold when executed? | every grant, revoke and onboarding issued on chain, with membership records counted from events and every target's decision read back, including a registry per administrative domain (local only) |
| `bench/latency.mjs` | What does live authorization cost per call? | p50/p95/p99 and RPC requests per admission, by binding count and allow-cache lifetime |
| `bench/revocation.mjs` | How fast does a burn or an expiry propagate? | block inclusion and first-denial times, reported separately |
| `bench/faults.mjs` | Does the gateway fail closed? | eight injected faults; the metric is denied calls that reached the wrapped server |
| `bench/case-study.mjs` | What does an agent experience? | a headless coding agent across all four kinds of enforcement point under five delegation conditions |

## Running it

Requires Node.js 20+ and **Hardhat 2** — installing `hardhat` without a
version pulls in 3.x, which does not read `hardhat.config.cjs`.

```sh
# from the repository root
npm ci && npm run build && (cd gate && npm run build)
cd experiments && npm install && npm run compile

node run-all.mjs            # local chain, ~10-15 min
node summarize.mjs          # regenerate out/summary.md, latency.csv, tables.tex
```

Against a public testnet, put funded keys in `experiments/.env.local`
(`ISSUER_PRIVATE_KEY`, `SUBJECT_PRIVATE_KEY`, `SUBJECT2_PRIVATE_KEY`, and
optionally `ALCHEMY_API_KEY` or `RPC`) and run `node run-testnet.mjs`. The
fixtures are deployed once and reused; keys never enter a fixture file and
RPC URLs are masked before they reach any log.

The agent case study spends LLM credits and therefore runs only when asked
for by name: `node run-all.mjs --only case-study`.

## Reproducing the paper's numbers

`out/paper-runs.json` pins the exact run that each table and sentence cites,
so `summarize.mjs` reads those files rather than the newest ones. To check a
draft against them:

```sh
node verify-paper.mjs path/to/main.tex
```

It re-derives every figure quoted in the evaluation section from the pinned
JSONL and fails on any mismatch. `summarize.mjs` also writes `out/stats.json`:
order-statistic 95% intervals for latency and propagation quantiles and
Clopper–Pearson intervals for the proportions (`lib/ci.mjs`). `node make-anon-artifact.mjs` builds a
supplementary package with user names, home paths, e-mail addresses and RPC
keys removed.

## Layout

```
bench/       one script per research question
lib/         stdio MCP client, counting RPC proxy with fault injection,
             local node, chain helpers, SIWE web API, agent-side MCP tools
contracts/   fixtures: ERC-7303 targets, control tokens, and the
             AccessControl and AccessManager baselines
scripts/     deployment
out/         raw JSONL logs, regenerated summaries, pinned-run manifest
```
