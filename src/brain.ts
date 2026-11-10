// The AI brain's other jobs, besides planning:
//   - write the counter-offer message (the PRICE is set by code; the AI only explains it)
//   - do "general" parts in-house
//   - judge general work against its acceptance criterion
// Every function has a non-AI fallback so the agent still runs without a key.

import { chat, chatJson, llmEnabled, model } from "./llm.js";
import type { CheckResult, Subtask } from "./types.js";

export interface CounterFacts {
  quote: number;
  planned: number;
  counter: number;
  token: string;
  marketNote: string;
  partTitle: string;
  budgetLeft: number;
  fallback: string;
}

/** Counter-offer wording. Rejected (falls back) if the AI's text doesn't state the exact counter price. */
export async function counterMessage(f: CounterFacts): Promise<{ text: string; by: string }> {
  if (!llmEnabled()) return { text: f.fallback, by: "template" };
  try {
    const text = await chat(
      [
        {
          role: "system",
          content:
            "You negotiate on behalf of a contractor agent. Write ONE short counter-offer message (2-3 sentences, plain, polite, firm). " +
            "State the counter price exactly as given, explain the reasoning from the facts, and say payment is released when the work passes the check. " +
            "Do not offer any other price. No greeting, no sign-off.",
        },
        {
          role: "user",
          content: `Part: ${f.partTitle}\nTheir quote: ${f.quote} ${f.token}\nOur plan for this part: ${f.planned} ${f.token}\nPlan based on: ${f.marketNote}\nBudget left for the whole job: ${f.budgetLeft} ${f.token}\nOur counter (exact): ${f.counter} ${f.token}`,
        },
      ],
      { temperature: 0.4, maxTokens: 200 },
    );
    if (!text.includes(String(f.counter))) return { text: f.fallback, by: "template (AI text didn't state the counter)" };
    return { text: text.replace(/\s+/g, " ").trim(), by: `AI (${await model()})` };
  } catch {
    return { text: f.fallback, by: "template (AI call failed)" };
  }
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Do a general part in-house. `context` is what earlier parts produced. */
export async function doGeneralWork(task: string, part: Subtask, context: string): Promise<{ markdown: string; by: string }> {
  if (!llmEnabled()) {
    return {
      markdown: `## ${part.title}\n\n_No AI key is set, so the contractor can't do general work in-house. Set LLM_API_KEY to enable it._\n`,
      by: "none (no LLM_API_KEY)",
    };
  }
  const md = await chat(
    [
      { role: "system", content: "You are a careful contractor doing one part of a larger job. Produce the deliverable for this part only, in markdown, starting with a '## ' heading. Be concrete and usable. No preamble." },
      { role: "user", content: `Overall task: ${task}\nThis part: ${part.title}\nIt must satisfy: ${part.acceptance}\n${context ? `\nWhat earlier parts produced:\n${context.slice(0, 4000)}` : ""}` },
    ],
    { temperature: 0.5, maxTokens: 1800 },
  );
  return { markdown: md, by: `AI (${await model()})` };
}

/** Check general work: a word-count floor in code, then an AI judge against the acceptance criterion. */
export async function judgeGeneral(part: Subtask, markdown: string): Promise<CheckResult> {
  const n = words(markdown);
  if (n < 60) return { passed: false, reasons: [`only ${n} words (need 60)`] };
  if (!llmEnabled()) return { passed: false, reasons: ["no AI judge available (LLM_API_KEY not set)"] };
  try {
    const verdict = await chatJson(
      [
        { role: "system", content: 'You are a strict reviewer. Decide if the deliverable meets the acceptance criterion. Reply with ONLY JSON: {"pass": boolean, "reasons": [short strings]}' },
        { role: "user", content: `Part: ${part.title}\nAcceptance criterion: ${part.acceptance}\n\nDeliverable:\n${markdown.slice(0, 6000)}` },
      ],
      (x) => {
        const o = x as any;
        if (typeof o?.pass !== "boolean") throw new Error("pass must be boolean");
        return { passed: o.pass as boolean, reasons: (Array.isArray(o.reasons) ? o.reasons : []).map(String).slice(0, 4) };
      },
      { maxTokens: 300 },
    );
    return { passed: verdict.passed, reasons: [`${n} words`, `AI judge: ${verdict.reasons.join("; ") || (verdict.passed ? "meets criterion" : "does not meet criterion")}`] };
  } catch (e) {
    return { passed: false, reasons: [`AI judge failed: ${(e as Error).message.slice(0, 120)}`] };
  }
}
