// Splits a task into parts, decides do-vs-buy, and sets a planned spend for each part
// BEFORE any quotes come in. The acceptance check for each part is also fixed here,
// so the agent can't lower the bar after seeing what a worker delivered.

import { config } from "./config.js";
import { categoryPrices } from "./market.js";
import type { Plan, Skill, Subtask, Token, WorkerInfo } from "./types.js";

const SKILLS: Record<Skill, { title: string; marketCategory: string; acceptance: string; selfCapable: boolean }> = {
  data: {
    title: "Collect 7 days of price data",
    marketCategory: "data",
    acceptance: "At least 5 points, numeric positive prices, timestamps strictly increasing, from a named source",
    selfCapable: false,
  },
  chart: {
    title: "Draw a price chart",
    marketCategory: "creative",
    acceptance: "Valid SVG with one plotted point per data point and a title",
    selfCapable: false,
  },
  writeup: {
    title: "Write the market brief",
    marketCategory: "research",
    acceptance: "Markdown with a title, at least 120 words, and the latest price quoted correctly from the data",
    selfCapable: true,
  },
};

export const canDoInHouse = (s: Skill) => SKILLS[s].selfCapable;

export const ASSETS: Record<string, string> = {
  near: "near", bitcoin: "bitcoin", btc: "bitcoin", ethereum: "ethereum", eth: "ethereum", solana: "solana", sol: "solana",
};

export function assetFromTask(task: string): string {
  const words = task.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const w of words) if (ASSETS[w]) return ASSETS[w];
  return "near";
}

export function skillsForTask(task: string): Skill[] {
  const t = task.toLowerCase();
  const wantsChart = /chart|graph|plot|visual/.test(t);
  const wantsWrite = /report|brief|write|summary|analysis|research|thread|post/.test(t);
  const wantsData = wantsChart || wantsWrite || /price|data|numbers|market/.test(t);
  const skills: Skill[] = [];
  if (wantsData) skills.push("data");
  if (wantsChart) skills.push("chart");
  if (wantsWrite) skills.push("writeup");
  return skills.length ? skills : ["data", "chart", "writeup"];
}

const round = (n: number) => Math.floor(n * 1e4) / 1e4;

export async function makePlan(task: string, budget: number, token: Token, workers: WorkerInfo[]): Promise<Plan> {
  const skills = skillsForTask(task);
  const contingency = round(budget * config.contingencyShare);
  const spendable = budget - contingency;

  const buy = skills.filter((s) => workers.some((w) => w.skill === s));
  const ref = await categoryPrices([...new Set(buy.map((s) => SKILLS[s].marketCategory))]);
  const weightSum = buy.reduce((sum, s) => sum + (ref.medians[SKILLS[s].marketCategory] ?? 1), 0);

  const subtasks: Subtask[] = skills.map((skill, i) => {
    const meta = SKILLS[skill];
    const isBuy = buy.includes(skill);
    const w = ref.medians[meta.marketCategory] ?? 1;
    return {
      id: `t${i + 1}`,
      skill,
      title: meta.title,
      mode: isBuy ? "buy" : "self",
      plannedSpend: isBuy ? round((spendable * w) / weightSum) : 0,
      acceptance: meta.acceptance,
      marketCategory: meta.marketCategory,
    };
  });

  return { task, token, budget, contingency, subtasks, priceSource: ref.source };
}
