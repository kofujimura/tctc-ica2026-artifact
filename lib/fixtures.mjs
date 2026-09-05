import { readFileSync } from "node:fs";
import { clients } from "./chain.mjs";

export function loadFixtures(path, rpcOverride) {
  const f = JSON.parse(readFileSync(path, "utf8"));
  const rpcUrl = rpcOverride ?? process.env.RPC ?? f.meta.rpcUrl;
  if (/\*\*\*/.test(rpcUrl)) throw new Error("fixtures store a masked RPC URL; pass --rpc or set RPC in the environment");
  const keys = f.keys ?? {
    issuer: process.env.ISSUER_PRIVATE_KEY, subject: process.env.SUBJECT_PRIVATE_KEY, subject2: process.env.SUBJECT2_PRIVATE_KEY,
  };
  if (!keys.issuer) throw new Error("ISSUER_PRIVATE_KEY required for non-local fixtures");
  const chainId = f.meta.chainId;
  return {
    ...f, rpcUrl, chainId, keys,
    issuer: clients(rpcUrl, chainId, keys.issuer),
    subject: clients(rpcUrl, chainId, keys.subject),
    subject2: keys.subject2 ? clients(rpcUrl, chainId, keys.subject2) : undefined,
  };
}
