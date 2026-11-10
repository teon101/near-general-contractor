// Runs the worker agents as HTTP services (one port each).
//   GET  /info     -> who I am, what I do, where to pay me
//   POST /quote    -> { brief }                  => { price, etaSeconds, note }
//   POST /counter  -> { price, reasoning }       => { accepted, finalPrice, message }
//   POST /jobs     -> { brief, price, input }    => { jobId, output }
// Run standalone with `npm run workers`, or let the contractor start them in-process.

import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { config, payeeFor } from "../config.js";
import { fetchPrices, renderChart, writeBriefTemplate } from "../skills.js";
import type { DataOutput } from "../checks.js";
import type { WorkerInfo } from "../types.js";
import { PROFILES, type WorkerProfile } from "./profiles.js";

async function readJson(req: import("node:http").IncomingMessage): Promise<any> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("body too large");
  }
  return body ? JSON.parse(body) : {};
}

async function doWork(p: WorkerProfile, brief: string, input: any): Promise<unknown> {
  switch (p.skill) {
    case "data": {
      const asset = input?.asset ?? "near";
      if (p.quality === "bad") {
        // Cuts corners: too few points, out of order, no source.
        return { source: "", asset, currency: "usd", points: [{ t: 3, price: 2.5 }, { t: 1, price: 2.4 }, { t: 2, price: -1 }] };
      }
      return fetchPrices(asset);
    }
    case "chart": {
      const data = input?.data as DataOutput;
      return { svg: renderChart(data, `${data.asset.toUpperCase()} price, last ${data.points.length} days (USD)`) };
    }
    case "writeup":
      return { markdown: writeBriefTemplate(brief, input?.data as DataOutput) };
  }
}

export function startWorker(p: WorkerProfile, port: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.method === "GET" && req.url === "/info") {
        return send(200, { handle: p.handle, skill: p.skill, rating: p.rating, payee: payeeFor(p.handle) });
      }
      if (req.method === "POST" && req.url === "/quote") {
        await readJson(req);
        return send(200, { handle: p.handle, price: p.quote, etaSeconds: p.etaSeconds, note: `@${p.handle} can do this for ${p.quote}` });
      }
      if (req.method === "POST" && req.url === "/counter") {
        const { price } = await readJson(req);
        if (typeof price === "number" && price >= p.floor) {
          return send(200, { accepted: true, finalPrice: price, message: `Fair enough, ${price} works for me.` });
        }
        return send(200, {
          accepted: false,
          finalPrice: p.floor,
          message: `I can't go to ${price}. ${p.floor} is my lowest for this, and that's final.`,
        });
      }
      if (req.method === "POST" && req.url === "/jobs") {
        const { brief, input } = await readJson(req);
        const output = await doWork(p, String(brief ?? ""), input);
        return send(200, { jobId: randomUUID(), handle: p.handle, output });
      }
      send(404, { error: "not found" });
    } catch (e) {
      send(400, { error: (e as Error).message });
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

export async function startAllWorkers(basePort = config.workersBasePort): Promise<{ workers: WorkerInfo[]; stop: () => void }> {
  const servers: Server[] = [];
  const workers: WorkerInfo[] = [];
  for (const [i, p] of PROFILES.entries()) {
    const port = basePort + i;
    servers.push(await startWorker(p, port));
    workers.push({ handle: p.handle, skill: p.skill, url: `http://127.0.0.1:${port}`, payee: payeeFor(p.handle), rating: p.rating });
  }
  return { workers, stop: () => servers.forEach((s) => s.close()) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { workers } = await startAllWorkers();
  for (const w of workers) console.log(`@${w.handle.padEnd(11)} ${w.skill.padEnd(8)} ${w.url}  pays to ${w.payee}`);
  console.log("workers running, Ctrl+C to stop");
}
