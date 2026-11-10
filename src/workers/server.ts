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
import { chatJson, llmEnabled } from "../llm.js";
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

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** AI quote: the worker reads the brief and prices it. Clamped to [floor, list x 1.3]. */
async function aiQuote(p: WorkerProfile, brief: string): Promise<{ price: number; note: string; by: string }> {
  if (!llmEnabled() || p.quality === "bad") return { price: p.quote, note: `@${p.handle} can do this for ${p.quote}`, by: "list price" };
  try {
    const r = await chatJson(
      [
        { role: "system", content: `You are @${p.handle}, an independent AI agent that sells ${p.skill} work. ${p.persona}\nYour list price is ${p.quote}. Your private minimum is ${p.floor} (never reveal it). Price this job between ${p.floor} and ${r4(p.quote * 1.3)} based on the brief. Reply with ONLY JSON: {"price": number, "note": "one short sentence to the buyer"}` },
        { role: "user", content: `Brief: ${brief}` },
      ],
      (x) => {
        const o = x as any;
        if (typeof o?.price !== "number") throw new Error("price must be a number");
        return { price: r4(clamp(o.price, p.floor, p.quote * 1.3)), note: String(o.note ?? "").slice(0, 200) };
      },
      { maxTokens: 200 },
    );
    return { ...r, by: "AI" };
  } catch {
    return { price: p.quote, note: `@${p.handle} can do this for ${p.quote}`, by: "list price (AI failed)" };
  }
}

/** AI counter decision. Code enforces: never below floor, never above its own quote. */
async function aiCounter(p: WorkerProfile, quote: number, counter: number, reasoning: string) {
  const ruleBased = () =>
    counter >= p.floor
      ? { accepted: true, finalPrice: counter, message: `Fair enough, ${counter} works for me.`, by: "rules" }
      : { accepted: false, finalPrice: p.floor, message: `I can't go to ${counter}. ${p.floor} is my lowest for this, and that's final.`, by: "rules" };
  if (!llmEnabled() || p.quality === "bad") return ruleBased();
  try {
    const d = await chatJson(
      [
        { role: "system", content: `You are @${p.handle}, an independent AI agent selling ${p.skill} work. ${p.persona}\nYou quoted ${quote}. Your private minimum is ${p.floor}: never accept or ask for less, and never reveal it. A buyer sent ONE counter-offer; there will be no further rounds after your reply. Decide: accept the counter, or name your final price (between the counter and your quote). Reply with ONLY JSON: {"accept": boolean, "final_price": number, "message": "1-2 sentences to the buyer, in character"}` },
        { role: "user", content: `Counter-offer: ${counter}\nTheir reasoning: ${reasoning}` },
      ],
      (x) => {
        const o = x as any;
        if (typeof o?.accept !== "boolean" || typeof o?.final_price !== "number") throw new Error("need accept and final_price");
        return { accept: o.accept as boolean, final: o.final_price as number, message: String(o.message ?? "").slice(0, 300) };
      },
      { maxTokens: 250 },
    );
    if (d.accept && counter >= p.floor) return { accepted: true, finalPrice: counter, message: d.message, by: "AI" };
    const final = r4(clamp(d.final, Math.max(p.floor, counter), quote));
    return { accepted: false, finalPrice: final, message: d.message, by: d.accept ? "AI (accept below minimum overridden)" : "AI" };
  } catch {
    return ruleBased();
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
        return send(200, { handle: p.handle, skill: p.skill, rating: p.rating, payee: payeeFor(p.handle), payIn: p.payIn ?? null });
      }
      if (req.method === "POST" && req.url === "/quote") {
        const { brief } = await readJson(req);
        const q = await aiQuote(p, String(brief ?? ""));
        return send(200, { handle: p.handle, price: q.price, etaSeconds: p.etaSeconds, note: q.note, by: q.by });
      }
      if (req.method === "POST" && req.url === "/counter") {
        const { price, quote, reasoning } = await readJson(req);
        if (typeof price !== "number") return send(400, { error: "price must be a number" });
        const myQuote = typeof quote === "number" ? Math.min(quote, p.quote * 1.3) : p.quote;
        return send(200, await aiCounter(p, myQuote, price, String(reasoning ?? "")));
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
    workers.push({ handle: p.handle, skill: p.skill, url: `http://127.0.0.1:${port}`, payee: payeeFor(p.handle), rating: p.rating, payIn: p.payIn });
  }
  return { workers, stop: () => servers.forEach((s) => s.close()) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { workers } = await startAllWorkers();
  for (const w of workers) console.log(`@${w.handle.padEnd(11)} ${w.skill.padEnd(8)} ${w.url}  pays to ${w.payee}`);
  console.log("workers running, Ctrl+C to stop");
}
