// How the contractor talks to worker agents over HTTP.

import type { CounterResponse, Delivery, Quote, WorkerInfo } from "../types.js";

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

export const requestQuote = (w: WorkerInfo, brief: string) => post<Quote>(`${w.url}/quote`, { brief });
export const sendCounter = (w: WorkerInfo, price: number, reasoning: string) =>
  post<CounterResponse>(`${w.url}/counter`, { price, reasoning });
export const hire = (w: WorkerInfo, brief: string, price: number, input: unknown) =>
  post<Delivery>(`${w.url}/jobs`, { brief, price, input });
