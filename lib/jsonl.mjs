import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function jsonlWriter(path) {
  mkdirSync(dirname(path), { recursive: true });
  return (obj) => appendFileSync(path, JSON.stringify(obj) + "\n");
}
export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
export function listJsonl(dir, prefix) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl")).sort().map((f) => join(dir, f));
}
export function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
export function stats(values) {
  const s = [...values].filter((v) => typeof v === "number" && !Number.isNaN(v)).sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { n: s.length, min: s[0], p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s[s.length - 1], mean };
}
export const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
