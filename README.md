# Evaluation harness (IEEE ICA 2026 paper)

Reproducible measurements for RQ2–RQ4 of the paper: administration cost,
admission latency, revocation/expiry propagation, and fault injection.
Everything is driven through a real stdio MCP client against the built
`tctc-gate` (`../gate/dist/index.js`) wrapping a counting upstream server.

## Setup

```sh
# from the tctc-mcp repository root
npm ci && npm run build && (cd gate && npm run build)
cd experiments && npm install && npm run compile
```

The harness uses **Hardhat 2** (`hardhat.config.cjs`); do not upgrade to
Hardhat 3 (`npm install hardhat` without a version bumps to 3.x, which does
not read `.cjs` configs and fails with `HHE3: No Hardhat config file found`).

## Local run (Hardhat node, chainId 31337, 1 s blocks)

```sh
node run-all.mjs                       # ~10–15 min with defaults
node run-all.mjs --calls 200 --cycles 5 --expiry-cycles 3   # smoke test
```

Raw logs are written to `out/*.jsonl`; `node summarize.mjs` regenerates
`out/summary.md`, `out/latency.csv`, and `out/tables.tex` from them.

## Public testnet run (Sepolia)

```sh
export ISSUER_PRIVATE_KEY=0x…  SUBJECT_PRIVATE_KEY=0x…  SUBJECT2_PRIVATE_KEY=0x…   # funded test keys
export RPC=https://ethereum-sepolia-rpc.publicnode.com
node scripts/deploy.mjs --rpc $RPC --chain-id 11155111 --label testnet --out out/fixtures.testnet.json
node bench/latency.mjs    --fixtures out/fixtures.testnet.json --calls 1000
node bench/revocation.mjs --fixtures out/fixtures.testnet.json --cycles 30 --expiry-cycles 10 --expiry-seconds 60 --poll-ms 250
node bench/faults.mjs     --fixtures out/fixtures.testnet.json
node bench/admin-cost.mjs --fixtures out/fixtures.testnet.json --repeat 3
node summarize.mjs
```

Keys are never written to fixture files for non-local labels.

## What is measured

| script | RQ | output |
|---|---|---|
| `bench/admin-cost.mjs` | RQ2 | gas of grantRole/revokeRole vs mint/burn, action gas vs bindings, analytic op counts |
| `bench/latency.mjs` | RQ3 | p50/p95/p99 per condition, RPC requests per admission (counted by a proxy) |
| `bench/revocation.mjs` | RQ3 | inclusion delay vs observation delay for grant, burn, and expiry |
| `bench/faults.mjs` | RQ4 | code returned, upstream calls reached, RPC leak check per injected fault |
| `bench/case-study.mjs` | case study | a headless Claude Code agent (built-in tools disabled) runs one task across two gated MCP servers, a SIWE web API (`lib/web-api.mjs`), and a contract, under five delegation conditions; per-trial transcripts and audit logs land in `out/case-study-runs/`. Spends LLM credits (~$0.10/trial with Sonnet), so it runs only with `node run-all.mjs --only case-study [--cs-trials N --cs-model sonnet\|haiku --cs-label L]` |

Each JSONL file starts with a `meta` line recording the tctc-mcp commit,
Node version, chain id, RPC URL, and parameters.

Notes on resolution: the expiry experiment measures "deny observed after the
first post-deadline block" against a 10 ms block-number watcher, so values
are accurate to about ±10 ms (small negative values mean the gate saw the
block before the watcher did). Chain time and wall-clock time drift apart on
a local node, which is why block timestamps are not used for that delay.
