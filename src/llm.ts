// NEAR AI Cloud client (OpenAI-compatible, TEE-backed inference).
// The LLM only ever sees the task, prices and work products. It never sees keys,
// and it can't move money: everything it returns is validated by plain code first.

import { config } from "./config.js";

export type Msg = { role: "system" | "user" | "assistant"; content: string };

// Tried in order if LLM_MODEL isn't set or isn't available. The catalog changes over time.
const PREFERRED = ["deepseek-ai/DeepSeek-V4-Flash", "z-ai/glm-5.2", "deepseek-ai/DeepSeek-V3.1", "Qwen/Qwen3-30B-A3B-Instruct-2507"];

let resolvedModel: string | null = null;
/** Set when NEAR AI Cloud refuses the account (bad key, no credits). Stops further calls this run. */
let unavailable: string | null = null;

export const llmEnabled = () => Boolean(config.llmApiKey) && !unavailable;
export const llmUnavailableReason = () => unavailable;

function explain(status: number, text: string) {
  if (status === 401 || status === 403) return `NEAR AI Cloud rejected the API key (${status})`;
  if (status === 402) return `NEAR AI Cloud account has no credits or spending limit (402)`;
  return `NEAR AI Cloud error ${status}: ${text.slice(0, 160)}`;
}

async function req(path: string, init?: RequestInit, timeoutMs = 90_000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${config.llmBaseUrl}${path}`, {
      ...init,
      signal: ctl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${config.llmApiKey}`, ...(init?.headers ?? {}) },
    });
    const text = await r.text();
    if (!r.ok) {
      const msg = explain(r.status, text);
      if ([401, 402, 403].includes(r.status)) unavailable = msg;
      throw new Error(msg);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

export async function model(): Promise<string> {
  if (resolvedModel) return resolvedModel;
  let ids: string[] = [];
  try {
    const list = await req("/models", { method: "GET" }, 15_000);
    ids = (list?.data ?? []).map((m: any) => m.id as string);
  } catch { /* fall back to the configured name */ }
  const wanted = process.env.LLM_MODEL ? [process.env.LLM_MODEL, ...PREFERRED] : PREFERRED;
  resolvedModel = (ids.length ? wanted.find((w) => ids.includes(w)) ?? ids[0] : wanted[0]) ?? config.llmModel;
  return resolvedModel;
}

export async function chat(messages: Msg[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<string> {
  const j = await req("/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: await model(), messages, temperature: opts.temperature ?? 0.3, max_tokens: opts.maxTokens ?? 1500 }),
  });
  const content: string = j?.choices?.[0]?.message?.content ?? "";
  // Some reasoning models wrap thinking in <think> tags. Drop it.
  return content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** Ask for JSON, parse it, validate it. One retry with the error fed back. */
export async function chatJson<T>(messages: Msg[], validate: (x: unknown) => T, opts?: { maxTokens?: number }): Promise<T> {
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const msgs = attempt === 0 ? messages : [...messages, { role: "user" as const, content: `That was not valid: ${last}. Reply with ONLY the corrected JSON.` }];
    const raw = await chat(msgs, { temperature: 0.2, maxTokens: opts?.maxTokens });
    try {
      const body = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
      const start = body.indexOf("{");
      const end = body.lastIndexOf("}");
      return validate(JSON.parse(body.slice(start, end + 1)));
    } catch (e) {
      last = (e as Error).message;
    }
  }
  throw new Error(`LLM did not return valid JSON: ${last}`);
}
