// Spawn tctc-gate wrapping the counting upstream with a generated config.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioClient } from "./stdio-client.mjs";
import { GATE_BIN, COUNTING_SERVER } from "./chain.mjs";

export function gateConfig({ rpcUrl, chainId, target, subject, tools, publicTools = [], allowSeconds = 0, denySeconds = 0, audit }) {
  return {
    chain: { key: `chain-${chainId}`, chainId, rpcUrl },
    target,
    subject: { mode: "configured", address: subject },
    gate: { public: publicTools, tools },
    cache: { allowSeconds, denySeconds },
    ...(audit ? { audit } : {}),
    server: { command: process.execPath, args: [COUNTING_SERVER], env: { COUNT_FILE: "${COUNT_FILE}" }, inherit: ["PATH", "HOME"] },
  };
}

/** Start a gated session. Returns the client plus helpers to read upstream-call counts. */
export async function startGate(cfg, { initialize = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tctc-bench-"));
  const countFile = join(dir, "upstream-calls.jsonl");
  const configPath = join(dir, "gate.json");
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  const client = new StdioClient(process.execPath, [GATE_BIN, "--config", configPath], {
    env: { ...process.env, COUNT_FILE: countFile }, onStderr: () => {},
  });
  const upstreamCalls = () => (existsSync(countFile) ? readFileSync(countFile, "utf8").split("\n").filter(Boolean).length : 0);
  if (initialize) {
    // Race initialize against gate exit (fail-closed startup refusals exit before serving).
    const init = await Promise.race([client.initialize(), client.exited.then((x) => ({ exited: x }))]);
    if (init?.exited) return { client, upstreamCalls, dir, startupRefused: init.exited, stderr: client.stderr };
  }
  return { client, upstreamCalls, dir, configPath, countFile };
}

/** Start the counting upstream directly (ungated baseline). */
export async function startUngated() {
  const dir = mkdtempSync(join(tmpdir(), "tctc-bench-ungated-"));
  const countFile = join(dir, "upstream-calls.jsonl");
  const client = new StdioClient(process.execPath, [COUNTING_SERVER], { env: { ...process.env, COUNT_FILE: countFile } });
  await client.initialize();
  return { client, dir, countFile };
}
