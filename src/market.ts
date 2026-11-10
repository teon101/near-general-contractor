// Read-only use of the NEAR AI Agent Market (market.near.ai, API v2).
//
// What we found in the public OpenAPI spec (Nov 2026): an agent can browse listed agents and
// their pricing plans, bid on jobs, message on bid threads and submit work. There is NO public
// endpoint for an agent to post a normal job, award a bid, or accept work and release escrow;
// the only spending endpoint (POST /v1/jobs/competition) is marked "Humans only: the call spends".
// So the contractor uses the market for real reference prices, and hires our own worker agents
// for execution. See README "Why not hire on market.near.ai directly?".

import { config } from "./config.js";

export interface PriceReference {
  /** median per-call price (USD-denominated on the market) for each category */
  medians: Record<string, number>;
  source: string;
  sampleSizes: Record<string, number>;
}

// Offline fallback. These are NOT live prices, only relative weights so the demo
// can split a budget when the market can't be reached.
const FALLBACK: PriceReference = {
  medians: { data: 2, creative: 3, research: 4 },
  source: "offline fallback weights (market.near.ai unreachable)",
  sampleSizes: { data: 0, creative: 0, research: 0 },
};

async function getJson(url: string, timeoutMs = 6000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export async function categoryPrices(categories: string[]): Promise<PriceReference> {
  if (!config.useLiveMarket) return FALLBACK;
  const medians: Record<string, number> = {};
  const sampleSizes: Record<string, number> = {};
  try {
    for (const cat of categories) {
      const res = await getJson(`${config.marketApi}/v1/agents?category=${cat}&limit=20`);
      const agents: any[] = res?.agents ?? [];
      const prices: number[] = [];
      for (const a of agents.slice(0, 10)) {
        try {
          const plans: any[] = await getJson(`${config.marketApi}/v1/agents/${a.agent_id}/pricing-plans`);
          const live = plans.filter((p) => p.listing_status === "live");
          const plan = live.find((p) => p.is_default) ?? live[0];
          const price = plan ? Number(plan.price_amount) : NaN;
          if (Number.isFinite(price) && price > 0) prices.push(price);
        } catch { /* skip agents whose plans can't be read */ }
      }
      sampleSizes[cat] = prices.length;
      if (prices.length) medians[cat] = median(prices);
    }
  } catch {
    return FALLBACK;
  }
  // Any category with no live data falls back to its weight, scaled to the live data we did get.
  const missing = categories.filter((c) => medians[c] === undefined);
  if (missing.length === categories.length) return FALLBACK;
  if (missing.length) {
    const known = categories.filter((c) => medians[c] !== undefined);
    const scale = known.reduce((s, c) => s + medians[c], 0) / known.reduce((s, c) => s + (FALLBACK.medians[c] ?? 1), 0);
    for (const c of missing) medians[c] = (FALLBACK.medians[c] ?? 1) * scale;
  }
  return { medians, sampleSizes, source: `market.near.ai live pricing plans${missing.length ? ` (fallback weights for: ${missing.join(", ")})` : ""}` };
}
