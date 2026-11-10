// The actual work: fetching prices, drawing a chart, writing a brief.
// Worker agents use these to produce deliveries; the contractor uses writeBrief for in-house work.

import { chat, llmEnabled, model } from "./llm.js";
import type { DataOutput } from "./checks.js";

export async function fetchPrices(asset: string): Promise<DataOutput> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(
      `https://api.coingecko.com/api/v3/coins/${asset}/market_chart?vs_currency=usd&days=7&interval=daily`,
      { signal: ctl.signal },
    );
    clearTimeout(t);
    if (!r.ok) throw new Error(String(r.status));
    const j: any = await r.json();
    const points = (j.prices as [number, number][]).map(([t, price]) => ({ t, price: Math.round(price * 1e4) / 1e4 }));
    // CoinGecko's last point is "now"; drop duplicates on the same timestamp just in case
    const dedup = points.filter((p, i) => i === 0 || p.t > points[i - 1].t);
    return { source: "CoinGecko /market_chart (7d, daily)", asset, currency: "usd", points: dedup };
  } catch {
    // Offline sample so the demo still runs without internet. Clearly labelled as such.
    const base = { near: 2.4, bitcoin: 95000, ethereum: 3400, solana: 160 }[asset] ?? 1;
    const day = 86_400_000;
    const start = Date.UTC(2026, 10, 3);
    const wiggle = [0, 0.031, -0.012, 0.044, 0.018, -0.026, 0.009, 0.037];
    const points = wiggle.map((w, i) => ({ t: start + i * day, price: Math.round(base * (1 + w) * 1e4) / 1e4 }));
    return { source: "offline sample data (CoinGecko unreachable)", asset, currency: "usd", points };
  }
}

export function renderChart(data: DataOutput, title: string): string {
  const W = 640, H = 320, P = 48;
  const prices = data.points.map((p) => p.price);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const span = hi - lo || 1;
  const x = (i: number) => P + (i * (W - 2 * P)) / Math.max(1, data.points.length - 1);
  const y = (v: number) => H - P - ((v - lo) / span) * (H - 2 * P);
  const pts = data.points.map((p, i) => `${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ");
  const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(3));
  const labels = data.points
    .map((p, i) => `<text x="${x(i).toFixed(1)}" y="${H - P + 18}" font-size="10" text-anchor="middle" fill="#666">${new Date(p.t).toISOString().slice(5, 10)}</text>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, sans-serif">
<title>${title}</title>
<rect width="${W}" height="${H}" fill="#fff"/>
<text x="${P}" y="28" font-size="16" font-weight="600" fill="#111">${title}</text>
<line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="#ccc"/>
<text x="${P - 6}" y="${y(hi) + 4}" font-size="10" text-anchor="end" fill="#666">${fmt(hi)}</text>
<text x="${P - 6}" y="${y(lo) + 4}" font-size="10" text-anchor="end" fill="#666">${fmt(lo)}</text>
<polyline fill="none" stroke="#2f6fde" stroke-width="2.5" points="${pts}"/>
${labels}
</svg>`;
}

function stats(data: DataOutput) {
  const first = data.points[0].price;
  const last = data.points[data.points.length - 1].price;
  const prices = data.points.map((p) => p.price);
  return {
    first, last,
    hi: Math.max(...prices), lo: Math.min(...prices),
    change: ((last - first) / first) * 100,
  };
}

export function writeBriefTemplate(task: string, data: DataOutput): string {
  const s = stats(data);
  const name = data.asset.toUpperCase();
  const dir = s.change >= 0 ? "up" : "down";
  return `# ${name} 7-day market brief

**Task:** ${task}

${name} closed the period at $${s.last.toFixed(4)}, ${dir} ${Math.abs(s.change).toFixed(2)}% from $${s.first.toFixed(4)} at the start of the window. Over the ${data.points.length} daily readings the price ranged from a low of $${s.lo.toFixed(4)} to a high of $${s.hi.toFixed(4)}, a spread of ${(((s.hi - s.lo) / s.lo) * 100).toFixed(2)}%.

## What the numbers say

The move over the week is ${Math.abs(s.change) < 3 ? "small, which points to a market that is ranging rather than trending" : Math.abs(s.change) < 8 ? "meaningful but not extreme, so momentum is worth watching before reading it as a new trend" : "large, so expect volatility to stay elevated in the short term"}. The gap between the weekly high and low is the better guide to risk here than the net change, because a narrow net move can hide sharp swings inside the week.

## Caveats

This brief covers seven days of daily closes only. It does not account for volume, on-chain activity, or news, and it is not investment advice. Data source: ${data.source}.
`;
}

/** In-house writing. Uses the AI brain (NEAR AI Cloud) if a key is set, otherwise the template. */
export async function writeBrief(task: string, data: DataOutput): Promise<{ markdown: string; by: string }> {
  if (!llmEnabled()) return { markdown: writeBriefTemplate(task, data), by: "template" };
  const s = stats(data);
  try {
    const md = await chat([
      { role: "system", content: "You write short, factual crypto market briefs in markdown. No hype, not investment advice. Start with a '# ' title. 150-250 words." },
      { role: "user", content: `Task: ${task}\nAsset: ${data.asset}\nDaily closes (usd): ${data.points.map((p) => p.price).join(", ")}\nLatest price: $${s.last.toFixed(4)} (quote this exact figure)\nSource: ${data.source}` },
    ], { maxTokens: 800 });
    if (md.length > 200) return { markdown: md, by: `AI (${await model()})` };
  } catch { /* fall through */ }
  return { markdown: writeBriefTemplate(task, data), by: "template (AI call failed)" };
}
