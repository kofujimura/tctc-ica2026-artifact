# tctc-ica2026-artifact

Evaluation harness, pinned logs and check script for the IEEE ICA 2026 paper
*Grant Once, Revoke Everywhere: Cross-Application AI Agent Authorization via
On-Chain Credentials*.

The evaluated code is not part of this repository. It is pinned as git
submodules under `vendor/`:

| Submodule | Commit | What the harness uses |
|---|---|---|
| [`tctc-mcp`](https://github.com/kofujimura/tctc-mcp) | `f36c656` | the role service (`dist/`) and the gateway `tctc-gate` (`gate/dist/`) |
| [`tctc-openai-starter`](https://github.com/kofujimura/tctc-openai-starter) | `0c610dc` | source line counts for the web route (RQ1) |

Everything runs against those builds, driven through a real stdio MCP
client. One command starts a local chain, deploys the fixtures, runs the
benchmarks and regenerates every table in the paper from the raw logs. Each
log records the tctc-mcp commit it ran against (`tctcMcpCommit`).

The runtime code of that commit is also released on npm as `tctc-mcp`
0.3.4 and `tctc-gate` 0.1.1; the releases add tests, documentation and
version numbers only.

This repository is a frozen record of the evaluation; development of the
packages themselves continues in their own repositories.

## What it measures

| Script | Question | Output |
|---|---|---|
| `bench/rq1.mjs`, `bench/rq1-web.mjs` | Does one token type serve heterogeneous enforcement points? | grant / use / revoke / expiry against a contract, three unmodified npm MCP servers behind the gateway, and the web route's role decision (no HTTP or sign-in) |
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
git clone --recurse-submodules https://github.com/kofujimura/tctc-ica2026-artifact.git
cd tctc-ica2026-artifact
(cd vendor/tctc-mcp && npm ci && npm run build && npm run build:gate)
npm ci && npm run compile

node run-all.mjs            # local chain, ~10-15 min
node summarize.mjs          # regenerate out/summary.md, latency.csv, tables.tex
```

Against a public testnet, put funded keys in `.env.local`
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
Clopper–Pearson intervals for the proportions (`lib/ci.mjs`).

A sentence or table row that a check expects but cannot find counts as a
mismatch, so rewording the paper cannot silently drop a check.

## Setup details the paper leaves out

The six-page paper cites this repository for the following details of the
evaluation.

- **Chains.** The local node mines each transaction on arrival and seals an
  empty block every second, so that time advances for expiry. The public
  testnet is Sepolia, reached through a hosted JSON-RPC endpoint.
- **Gas (RQ2).** Measured on the local node with storage already warmed.
  Gas is deterministic for a given state: every grant, revoke and baseline
  action used identical gas in all five repetitions, and each protected
  action under token bindings was measured once.
- **Latency (RQ3).** Each condition runs 1,000 back-to-back calls after
  warm-up, so a cached condition measures the hit path with one refresh per
  cache lifetime. The 1 s and 10 s allow caches give the same 0.07 ms
  median as the 5 s cache in the table. A live admission makes 3, 4 or 6
  RPC requests for 1, 2 or 4 bindings; requests above those on the testnet
  are transport retries.
- **Propagation (RQ3).** `out/stats.json` holds the 95% intervals of every
  median, including those the paper no longer quotes: first denial after
  inclusion on the local node (26–26 ms) and first denial after the
  post-deadline block (3–17 ms local, 21–499 ms testnet).
- **Faults (RQ4).** The stale-deny-cache scenario needs a deny cache longer
  than block inclusion; with a 5 s cache on a 12 s chain the cached deny
  expires before the grant lands and the gateway simply re-reads. In the
  race, how many racing calls are admitted before the burn lands is a
  property of block time, not of the enforcement point.
- **Authority-boundary attacks (RQ4, `bench/separation.mjs`).** Mint and burn
  by anyone but the issuer, and rebinding a target's role by anyone but its
  owner, revert with `OwnableUnauthorizedAccount`. A counterfeit collection
  deployed under `I1`'s name and minted to the attacker is denied by all
  three targets, since a binding names a contract address. Transfers of a
  delegation token by its holder or an approved operator, and of a timed
  token, revert with `Soulbound`. A replayed sign-in gets 401 because the
  server consumed its nonce, and a rebroadcast signed transaction is
  rejected by the account nonce and executes once.
- **Issuer–target separation (RQ1).** Transactions signed by each
  organization, by phase (issue: token contracts deployed and tokens
  minted; onboard: target deployed and role bound):

  | Organization | Issue | Onboard | Revoke |
  |---|---|---|---|
  | Issuer I1 | 4 | 0 | 1 |
  | Issuer I2 | 2 | 0 | 1 |
  | T1, contract action | 0 | 2 | 0 |
  | T2, MCP gateway | 0 | 2 | 0 |
  | T3, web API | 0 | 3 | 0 |

  `I1`'s four issuing transactions include the timed token used by the
  attack scenarios.
- **Web route.** The eight lines of target code exclude subject
  authentication (Sign-In with Ethereum), which the web route needs and the
  other targets do not. `bench/rq1-web.mjs` takes the role service's answer
  under the route's configuration as the route's verdict, without HTTP or
  sign-in. The separation run and the case study send signed-in HTTP
  requests to `lib/web-api.mjs`, on the local node only; that server consumes
  each nonce on first use and replaces the model call with a deterministic
  summarizer. It checks the sign-in's
  signature and nonce only: unlike the starter's `src/lib/auth.ts`, it does
  not compare the signed domain, URI or chain, which no experiment relies on.
- **Case study (Table III).** "Done" counts trials that completed the task;
  every condition completed exactly as many as it should (10, 0, 0, 0, 10
  for model A, 10 of 25 for model B). Unauthorized effects are admissions
  pinned at or after the burn block, protected-route answers or on-chain
  records without the role, and files created.
- **Gateway.** Binding discovery is cached for 60 s, tools the principal
  declares public are forwarded unchecked, a call cancelled during its check
  is neither forwarded nor answered, and the gateway refuses to serve if the
  endpoint reports another chain. `docs/GATE_SPEC.md` in `tctc-mcp`
  specifies the admission procedure in full.

Git tags mark the states the paper went through: `ica-2026-abstract-submitted`
(abstract registration) and `cr-phase1-long` (camera-ready revision, before
it was fitted to six pages).

## Layout

```
bench/       one script per research question
lib/         stdio MCP client, counting RPC proxy with fault injection,
             local node, chain helpers, SIWE web API, agent-side MCP tools
contracts/   fixtures: ERC-7303 targets, control tokens, and the
             AccessControl and AccessManager baselines
scripts/     deployment
out/         raw JSONL logs, regenerated summaries, pinned-run manifest
vendor/      the evaluated code (git submodules)
```

## License

Copyright 2026 Ko Fujimura.

- Code (everything outside `out/`): [Apache License 2.0](LICENSE), except
  where a file's SPDX header names another license
  (`contracts/AgentControlTokens.sol` and `contracts/ExpiringControlTokens.sol`
  are MIT).
- Data (everything under `out/`: the raw logs, case-study transcripts and
  audit logs, fixtures and the summaries generated from them):
  [Creative Commons Attribution 4.0 International](LICENSE-DATA).
- The submodules under `vendor/` carry their own licenses.
