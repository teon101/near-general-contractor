// Acceptance checks. Deterministic, so the same delivery always gets the same verdict
// and a worker can't argue its way past them.

import type { CheckResult, Skill } from "./types.js";

export interface PricePoint { t: number; price: number }
export interface DataOutput { source: string; asset: string; currency: string; points: PricePoint[] }

export function checkData(out: any): CheckResult {
  const reasons: string[] = [];
  if (!out || typeof out !== "object") return { passed: false, reasons: ["delivery is not an object"] };
  if (typeof out.source !== "string" || !out.source.trim()) reasons.push("no named source");
  const pts = Array.isArray(out.points) ? out.points : null;
  if (!pts) reasons.push("no points array");
  else {
    if (pts.length < 5) reasons.push(`only ${pts.length} points (need at least 5)`);
    let prev = -Infinity;
    pts.forEach((p: any, i: number) => {
      if (!p || typeof p.t !== "number" || typeof p.price !== "number" || !Number.isFinite(p.price))
        reasons.push(`point ${i} is not numeric`);
      else {
        if (p.price <= 0) reasons.push(`point ${i} has non-positive price`);
        if (p.t <= prev) reasons.push(`point ${i} timestamp is not after the previous one`);
        prev = p.t;
      }
    });
  }
  return { passed: reasons.length === 0, reasons: reasons.length ? reasons.slice(0, 5) : ["all data checks passed"] };
}

export function checkChart(out: any, data: DataOutput | null): CheckResult {
  const reasons: string[] = [];
  const svg: string = out?.svg;
  if (typeof svg !== "string" || !svg.trim().startsWith("<svg")) return { passed: false, reasons: ["not an SVG"] };
  if (!/<title>[^<]+<\/title>/.test(svg)) reasons.push("chart has no title");
  const m = svg.match(/<polyline[^>]*\spoints="([^"]+)"/);
  if (!m) reasons.push("no plotted line");
  else if (data) {
    const n = m[1].trim().split(/\s+/).length;
    if (n !== data.points.length) reasons.push(`plotted ${n} points but the data has ${data.points.length}`);
  }
  return { passed: reasons.length === 0, reasons: reasons.length ? reasons : ["all chart checks passed"] };
}

export function priceStrings(p: number) {
  return [p.toFixed(2), p.toFixed(3), p.toFixed(4)];
}

export function checkWriteup(out: any, data: DataOutput | null): CheckResult {
  const reasons: string[] = [];
  const md: string = out?.markdown;
  if (typeof md !== "string") return { passed: false, reasons: ["no markdown"] };
  if (!/^#\s+\S/m.test(md)) reasons.push("no title");
  const words = md.replace(/[#*_`>|-]/g, " ").split(/\s+/).filter(Boolean).length;
  if (words < 120) reasons.push(`only ${words} words (need 120)`);
  if (data && data.points.length) {
    const last = data.points[data.points.length - 1].price;
    if (!priceStrings(last).some((s) => md.includes(s))) reasons.push(`latest price ${last.toFixed(4)} is not quoted correctly`);
  }
  return { passed: reasons.length === 0, reasons: reasons.length ? reasons : [`${words} words, title present, latest price quoted correctly`] };
}

export function runCheck(skill: Skill, out: unknown, data: DataOutput | null): CheckResult {
  switch (skill) {
    case "data": return checkData(out);
    case "chart": return checkChart(out, data);
    case "writeup": return checkWriteup(out, data);
    case "general": return { passed: false, reasons: ["general work is checked by the AI judge (brain.ts)"] };
  }
}
