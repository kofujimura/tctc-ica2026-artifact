// viem helpers shared by the deploy script and the benchmarks.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EXP_ROOT } from "./local-node.mjs";
export { EXP_ROOT };

// The evaluated code, pinned as git submodules under vendor/ (see README).
export const TCTC_MCP_DIR = `${EXP_ROOT}/vendor/tctc-mcp`;
export const STARTER_DIR = `${EXP_ROOT}/vendor/tctc-openai-starter`;
export const MCP_BIN = `${TCTC_MCP_DIR}/dist/index.js`;

export function artifact(name) {
  return JSON.parse(readFileSync(`${EXP_ROOT}/artifacts/contracts/${name}.sol/${name}.json`, "utf8"));
}

export function makeChain(id, url) {
  return defineChain({
    id, name: `chain-${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
}

export function clients(rpcUrl, chainId, privateKey) {
  const chain = makeChain(chainId, rpcUrl);
  const transport = http(rpcUrl);
  const pub = createPublicClient({ chain, transport });
  const wallet = privateKey
    ? createWalletClient({ account: privateKeyToAccount(privateKey), chain, transport })
    : undefined;
  return { pub, wallet, chain, address: wallet?.account.address };
}

export async function deploy({ pub, wallet }, name, args = []) {
  const a = artifact(name);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
  const rc = await pub.waitForTransactionReceipt({ hash });
  return { address: rc.contractAddress, gasUsed: Number(rc.gasUsed), blockNumber: Number(rc.blockNumber), abi: a.abi };
}

/** Send a write and wait for inclusion; returns timings for propagation experiments. */
export async function write({ pub, wallet }, address, abi, functionName, args, { pollingInterval } = {}) {
  const tSubmit = Date.now();
  const hash = await wallet.writeContract({ address, abi, functionName, args });
  const tSent = Date.now();
  const rc = await pub.waitForTransactionReceipt({ hash, ...(pollingInterval ? { pollingInterval } : {}) });
  const tReceipt = Date.now();
  const block = await pub.getBlock({ blockNumber: rc.blockNumber });
  return {
    hash, status: rc.status, gasUsed: Number(rc.gasUsed), blockNumber: Number(rc.blockNumber),
    blockTimestamp: Number(block.timestamp), tSubmit, tSent, tReceipt,
  };
}

/** Hide API keys embedded in RPC URLs before anything is written to logs. */
export function maskRpc(url) {
  return String(url ?? "").replace(/\/v2\/[A-Za-z0-9_-]+/, "/v2/***").replace(/([?&](api)?key=)[^&]+/i, "$1***");
}

export function runMeta(extra = {}) {
  if (extra.rpcUrl) extra = { ...extra, rpcUrl: maskRpc(extra.rpcUrl) };
  let commit = "unknown", harness = "unknown";
  let dirty = [];
  try {
    commit = execSync("git rev-parse HEAD", { cwd: TCTC_MCP_DIR, encoding: "utf8" }).trim();
    dirty = execSync("git status --porcelain -- gate core src", { cwd: TCTC_MCP_DIR, encoding: "utf8" }).trim().split("\n").filter(Boolean);
    harness = execSync("git rev-parse HEAD", { cwd: EXP_ROOT, encoding: "utf8" }).trim();
  } catch { /* ignore */ }
  return { ts: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`, tctcMcpCommit: commit,
    tctcMcpUncommitted: dirty, harnessCommit: harness, ...extra };
}

export function parseArgs(argv, defaults) {
  const out = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[k] = v;
    }
  }
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const GATE_BIN = `${TCTC_MCP_DIR}/gate/dist/index.js`;
export const COUNTING_SERVER = `${EXP_ROOT}/lib/counting-server.mjs`;
export const META_NS = "io.github.kofujimura/tctc-gate";
