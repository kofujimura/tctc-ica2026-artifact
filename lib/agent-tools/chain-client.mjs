#!/usr/bin/env node
// Agent-side MCP tool for the on-chain enforcement point: `record_summary(text)`
// hashes the text and calls RecordTarget.record(hash) from the agent's wallet.
// Not gated itself: the contract's ERC-7303 modifier enforces the role.
//   env: RPC, CHAIN_ID, RECORD_TARGET, AGENT_PRIVATE_KEY, LOG_FILE
import { stdin, stdout, env } from "node:process";
import { appendFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, defineChain, keccak256, stringToHex, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const chain = defineChain({ id: Number(env.CHAIN_ID), name: "c", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [env.RPC] } } });
const account = privateKeyToAccount(env.AGENT_PRIVATE_KEY);
const pub = createPublicClient({ chain, transport: http(env.RPC), cacheTime: 0 });
const wallet = createWalletClient({ account, chain, transport: http(env.RPC) });
const abi = parseAbi(["function record(bytes32 hash)"]);
const log = (o) => env.LOG_FILE && appendFileSync(env.LOG_FILE, JSON.stringify({ ts: Date.now(), ...o }) + "\n");

async function record(text) {
  const hash = keccak256(stringToHex(text));
  try {
    const txHash = await wallet.writeContract({ address: env.RECORD_TARGET, abi, functionName: "record", args: [hash] });
    const rc = await pub.waitForTransactionReceipt({ hash: txHash, pollingInterval: Number(env.CHAIN_ID) === 31337 ? 50 : 1000 });
    log({ tool: "record_summary", status: rc.status, block: Number(rc.blockNumber) });
    return { content: [{ type: "text", text: `recorded ${hash} in block ${rc.blockNumber} (tx ${txHash})` }] };
  } catch (e) {
    const reason = /ERC7303: not has a required token/.test(String(e.message)) ? "reverted: ERC7303: not has a required token (the agent's wallet does not hold BENCH_ROLE on the record contract; ask your principal to grant it)" : `failed: ${String(e.shortMessage ?? e.message).slice(0, 200)}`;
    log({ tool: "record_summary", status: "reverted", reason });
    return { isError: true, content: [{ type: "text", text: reason }] };
  }
}
const TOOLS = [{ name: "record_summary", description: "Record the keccak256 hash of a text on-chain from the agent's wallet (requires BENCH_ROLE on the record contract).",
  inputSchema: { type: "object", properties: { text: { type: "string", description: "Text whose hash is recorded" } }, required: ["text"] } }];
let buf = "";
const send = (m) => stdout.write(JSON.stringify(m) + "\n");
stdin.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) handle(JSON.parse(l)); } });
async function handle({ id, method, params }) {
  if (method === "initialize") return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "release-note-chain", version: "1.0.0" } } });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") return send({ jsonrpc: "2.0", id, result: await record(String(params?.arguments?.text ?? "")) });
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
}
