// Start a Hardhat JSON-RPC node (chainId 31337, automine + 1 s interval
// mining so block timestamps advance for expiry experiments).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const EXP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Hardhat's default deterministic accounts (mnemonic "test test … junk").
export const HARDHAT_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];

export async function rpcReady(url, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) { const j = await r.json(); if (j.result) return parseInt(j.result, 16); }
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`RPC at ${url} not ready after ${timeoutMs} ms`);
}

export async function startLocalNode({ port = 8545, quiet = true } = {}) {
  const bin = join(EXP_ROOT, "node_modules", ".bin", "hardhat");
  const child = spawn(bin, ["node", "--port", String(port)], {
    cwd: EXP_ROOT, stdio: ["ignore", quiet ? "ignore" : "inherit", "inherit"],
  });
  const url = `http://127.0.0.1:${port}`;
  const chainId = await rpcReady(url);
  return { url, chainId, close: () => child.kill() };
}
