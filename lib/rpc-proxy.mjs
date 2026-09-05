// Counting JSON-RPC proxy: sits between the gate and the real RPC endpoint,
// counts requests per method (RPC/call metric) and injects faults on demand:
//   mode "down"       → connection destroyed (RPC unavailable)
//   mode "wrongchain" → eth_chainId answers 0x1 regardless of upstream
//   delayMs           → added latency before forwarding (cancellation tests)
import http from "node:http";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startRpcProxy(upstream, { port = 0 } = {}) {
  const counts = new Map();
  let total = 0, mode = null, delayMs = 0;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }
    const msgs = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    for (const m of msgs) { total++; counts.set(m.method, (counts.get(m.method) ?? 0) + 1); }
    if (mode === "down") { req.socket.destroy(); return; }
    if (delayMs > 0) await sleep(delayMs);
    let status = 200, text;
    try {
      const r = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body });
      status = r.status;
      text = await r.text();
    } catch (e) {
      res.writeHead(502); res.end(String(e)); return;
    }
    if (mode === "wrongchain") {
      try {
        const j = JSON.parse(text);
        const fix = (m, req) => (req?.method === "eth_chainId" ? { ...m, result: "0x1" } : m);
        text = JSON.stringify(Array.isArray(j) ? j.map((m, i) => fix(m, msgs[i])) : fix(j, msgs[0]));
      } catch { /* leave as is */ }
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(text);
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    total: () => total,
    counts: () => Object.fromEntries(counts),
    reset() { total = 0; counts.clear(); },
    setMode(m) { mode = m; },
    setDelay(ms) { delayMs = ms; },
    close: () => new Promise((r) => server.close(r)),
  };
}
