// Splits a task into parts, decides do-vs-buy, and sets a planned spend for each part
// BEFORE any quotes come in. The acceptance check for each part is also fixed here,
// so the agent can't lower the bar after seeing what a worker delivered.
//
// With LLM_API_KEY set, the AI brain (NEAR AI Cloud) does the splitting and can plan any task.
// Its output is validated by code: only known skills, at most 6 parts, data before anything
// that needs it. Money decisions (planned spend) are always computed by code from market prices.

import { config } from "./config.js";
import { chatJson, llmEnabled, model } from "./llm.js";
import { categoryPrices } from "./market.js";
import type { Plan, Skill, Subtask, Token, WorkerInfo } from "./types.js";

export const SKILLS: Record<Skill, { title: string; marketCategory: string; acceptance: string; selfCapable: boolean; describe: string }> = {
  data: {
    title: "Collect 7 days of price data",
    marketCategory: "data",
    acceptance: "At least 5 points, numeric positive prices, timestamps strictly increasing, from a named source",
    selfCapable: false,
    describe: "fetch 7 days of daily price history for ONE crypto asset (needs a CoinGecko id)",
  },
  chart: {
    title: "Draw a price chart",
    marketCategory: "creative",
    acceptance: "Valid SVG with one plotted point per data point and a title",
    selfCapable: false,
    describe: "draw a line chart of the price data (requires a data part first)",
  },
  writeup: {
    title: "Write the market brief",
    marketCategory: "research",
    acceptance: "Markdown with a title, at least 120 words, and the latest price quoted correctly from the data",
    selfCapable: true,
    describe: "write a short market brief from the price data (requires a data part first)",
  },
  general: {
    title: "General work",
    marketCategory: "research",
    acceptance: "Does what the title says, specific and usable, at least 60 words",
    selfCapable: true,
    describe: "any other text work: research notes, outlines, copy, plans, checklists, code snippets. Done in-house by the contractor",
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

interface Draft { skill: Skill; title: string; acceptance: string; why: string }

function rulePlan(task: string): { asset: string | null; parts: Draft[] } {
  return {
    asset: assetFromTask(task),
    parts: skillsForTask(task).map((s) => ({ skill: s, title: SKILLS[s].title, acceptance: SKILLS[s].acceptance, why: "keyword rule" })),
  };
}

/** Validate whatever the LLM returned. Throws with a reason the LLM can fix. */
export function validateAiPlan(x: unknown): { asset: string | null; parts: Draft[] } {
  const o = x as any;
  if (!o || !Array.isArray(o.parts)) throw new Error("missing parts array");
  if (o.parts.length < 1 || o.parts.length > 6) throw new Error("need 1 to 6 parts");
  const asset = typeof o.asset === "string" && /^[a-z0-9-]{2,40}$/.test(o.asset) ? o.asset : null;
  const parts: Draft[] = o.parts.map((p: any, i: number) => {
    if (!p || !(p.skill in SKILLS)) throw new Error(`part ${i} has unknown skill "${p?.skill}"`);
    if (typeof p.title !== "string" || p.title.length < 3) throw new Error(`part ${i} needs a title`);
    const skill = p.skill as Skill;
    return {
      skill,
      title: skill === "general" ? p.title.slice(0, 120) : SKILLS[skill].title,
      // Fixed checks for skills we verify with code; the AI only writes the bar for general work.
      acceptance: skill === "general" && typeof p.acceptance === "string" && p.acceptance.length > 10 ? p.acceptance.slice(0, 300) : SKILLS[skill].acceptance,
      why: typeof p.why === "string" ? p.why.slice(0, 200) : "",
    };
  });
  const skills = parts.map((p) => p.skill);
  for (const s of ["data", "chart", "writeup"] as const) if (skills.filter((k) => k === s).length > 1) throw new Error(`only one ${s} part allowed`);
  const needsData = skills.includes("chart") || skills.includes("writeup");
  if (needsData && !skills.includes("data")) throw new Error("chart/writeup need a data part");
  if (needsData && skills.indexOf("data") > Math.min(...["chart", "writeup"].map((s) => skills.indexOf(s as Skill)).filter((i) => i >= 0)))
    throw new Error("data must come before chart/writeup");
  if (skills.includes("data") && !asset) throw new Error("data part needs an asset (CoinGecko id, e.g. near, bitcoin)");
  return { asset, parts };
}

async function aiPlan(task: string, budget: number, token: Token, workers: WorkerInfo[]) {
  const hirable = [...new Set(workers.map((w) => w.skill))];
  const catalogue = (Object.keys(SKILLS) as Skill[])
    .map((s) => `- ${s}: ${SKILLS[s].describe}${hirable.includes(s) ? " [workers available to hire]" : " [contractor does it itself]"}`)
    .join("\n");
  return chatJson(
    [
      {
        role: "system",
        content:
          "You are the planning brain of a general contractor agent. Split the user's task into the smallest set of parts " +
          "(1 to 6) using ONLY these skills:\n" + catalogue + "\n\n" +
          "Rules: data must come before chart or writeup. At most one each of data, chart, writeup. Use general for anything else. " +
          "If the task is about a crypto asset, set asset to its CoinGecko id (e.g. near, bitcoin, ethereum, solana), otherwise null. " +
          "For general parts write a concrete, checkable acceptance criterion. Give a one-line why for each part.\n" +
          'Reply with ONLY JSON: {"asset": string|null, "parts": [{"skill": "...", "title": "...", "acceptance": "...", "why": "..."}]}',
      },
      { role: "user", content: `Task: ${task}\nBudget: ${budget} ${token}` },
    ],
    validateAiPlan,
  );
}

const round = (n: number) => Math.floor(n * 1e4) / 1e4;

export async function makePlan(task: string, budget: number, token: Token, workers: WorkerInfo[], log: (m: string) => void = () => {}): Promise<Plan> {
  let drafted = rulePlan(task);
  let brain = "built-in rules (set LLM_API_KEY for the AI brain)";
  if (llmEnabled()) {
    try {
      drafted = await aiPlan(task, budget, token, workers);
      brain = `NEAR AI Cloud (${await model()})`;
    } catch (e) {
      brain = `built-in rules (AI brain unavailable: ${(e as Error).message.slice(0, 120)})`;
      log(`  AI planner failed, using rules: ${(e as Error).message}`);
    }
  }

  const contingency = round(budget * config.contingencyShare);
  const spendable = budget - contingency;
  const hirable = new Set(workers.map((w) => w.skill));
  const buySkills = drafted.parts.filter((p) => hirable.has(p.skill)).map((p) => p.skill);
  const ref = await categoryPrices([...new Set(buySkills.map((s) => SKILLS[s].marketCategory))]);
  const weightSum = buySkills.reduce((sum, s) => sum + (ref.medians[SKILLS[s].marketCategory] ?? 1), 0);

  const subtasks: Subtask[] = drafted.parts.map((p, i) => {
    const isBuy = hirable.has(p.skill);
    const w = ref.medians[SKILLS[p.skill].marketCategory] ?? 1;
    return {
      id: `t${i + 1}`,
      skill: p.skill,
      title: p.title,
      mode: isBuy ? "buy" : "self",
      plannedSpend: isBuy ? round((spendable * w) / weightSum) : 0,
      acceptance: p.acceptance,
      marketCategory: SKILLS[p.skill].marketCategory,
      why: p.why,
    };
  });

  return { task, token, budget, contingency, subtasks, priceSource: buySkills.length ? ref.source : "no parts to buy", brain, asset: drafted.asset };
}
