// Minimal newline-delimited JSON-RPC client over a child process's stdio —
// the same shape a real MCP stdio client uses, without an SDK dependency so
// that timing reflects the gate and the upstream only.
import { spawn } from "node:child_process";

export class StdioClient {
  constructor(command, args, { env = process.env, onStderr, cwd } = {}) {
    this.child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", onStderr ? "pipe" : "inherit"] });
    if (onStderr) this.child.stderr.on("data", (d) => onStderr(d.toString()));
    this.nextId = 0;
    this.pending = new Map();
    this.buf = "";
    this.stderr = "";
    if (onStderr) this.child.stderr.on("data", (d) => (this.stderr += d.toString()));
    this.exited = new Promise((resolve) => this.child.on("exit", (code, signal) => resolve({ code, signal })));
    this.child.on("error", (e) => { for (const p of this.pending.values()) p.reject(e); });
    this.child.stdout.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg);
        }
      }
    });
  }

  send(msg) { this.child.stdin.write(JSON.stringify(msg) + "\n"); }

  request(method, params = {}, timeoutMs = 60_000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout: ${method} (id ${id})`)); }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Send a request and return its id immediately (for cancellation tests). */
  requestNoWait(method, params = {}) {
    const id = ++this.nextId;
    let settle;
    const done = new Promise((resolve) => (settle = resolve));
    this.pending.set(id, { resolve: (m) => settle(m), reject: () => settle(undefined), timer: undefined });
    this.send({ jsonrpc: "2.0", id, method, params });
    return { id, done };
  }

  notify(method, params = {}) { this.send({ jsonrpc: "2.0", method, params }); }

  async initialize() {
    const r = await this.request("initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench", version: "0" },
    });
    this.notify("notifications/initialized", {});
    return r;
  }

  callTool(name, args = {}, timeoutMs) { return this.request("tools/call", { name, arguments: args }, timeoutMs); }

  async close() {
    this.child.stdin.end();
    this.child.kill();
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 2000))]);
  }
}
