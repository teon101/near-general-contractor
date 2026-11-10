// Live dashboard: run the contractor from a browser and watch it plan, negotiate, check and pay.
//   npm run dashboard   ->  http://localhost:3000
// Binds to 127.0.0.1 only. In Codespaces the forwarded port is private to you by default; keep it that way,
// because anyone who can open this page can start a run that spends from the contractor wallet.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { runContractor } from "../contractor.js";
import { llmEnabled } from "../llm.js";
import { makeRail } from "../payments.js";
import type { Token } from "../types.js";
import { startAllWorkers } from "../workers/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_PORT ?? 3000);
const MAX_BUDGET = Number(process.env.DASHBOARD_MAX_BUDGET ?? 2);
const token: Token = config.rail === "near" ? "NEAR" : "USDC";

const { workers } = await startAllWorkers();
let running = false;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(readFileSync(join(here, "page.html"), "utf8"));
  }

  if (url.pathname === "/api/info") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({
      rail: config.rail, network: config.network, account: config.contractorAccountId, token,
      brain: llmEnabled() ? "NEAR AI Cloud" : "built-in rules", maxBudget: MAX_BUDGET,
      workers: workers.map((w) => ({ handle: w.handle, skill: w.skill, payee: w.payee })),
    }));
  }

  if (url.pathname === "/api/run") {
    const task = (url.searchParams.get("task") ?? "").trim().slice(0, 500);
    const budget = Number(url.searchParams.get("budget"));
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    if (!task) { send({ type: "error", message: "Give the agent a task." }); return res.end(); }
    if (!(budget > 0 && budget <= MAX_BUDGET)) { send({ type: "error", message: `Budget must be between 0 and ${MAX_BUDGET} ${token}.` }); return res.end(); }
    if (running) { send({ type: "error", message: "A run is already in progress." }); return res.end(); }
    running = true;
    try {
      send({ type: "start", task, budget, token, rail: config.rail, network: config.network, account: config.contractorAccountId });
      await runContractor({ task, budget, token, workers, rail: makeRail(token, budget), log: (m) => send({ type: "log", text: m }), emit: send });
    } catch (e) {
      send({ type: "error", message: (e as Error).message });
    } finally {
      running = false;
      send({ type: "end" });
      res.end();
    }
    return;
  }

  res.writeHead(404).end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`dashboard: http://localhost:${PORT}`);
  console.log(`rail: ${config.rail}${config.rail === "simulate" ? "" : ` on ${config.network} from ${config.contractorAccountId}`}`);
});
