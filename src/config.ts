// Reads settings from the environment (.env is loaded if present).
// Private keys are read ONLY in payments.ts and never leave that module.

import { existsSync } from "node:fs";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

export type RailName = "simulate" | "near" | "usdc";

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}

export const config = {
  /** simulate = no chain, near = native NEAR transfers, usdc = NEP-141 USDC transfers. */
  rail: (process.env.PAYMENT_RAIL ?? "simulate") as RailName,
  network: process.env.NEAR_NETWORK ?? "testnet",
  nodeUrl: process.env.NEAR_RPC_URL ?? `https://rpc.${process.env.NEAR_NETWORK ?? "testnet"}.near.org`,
  allowMainnet: process.env.ALLOW_MAINNET === "1",

  contractorAccountId: process.env.CONTRACTOR_ACCOUNT_ID ?? "contractor.sim",
  usdcContract: process.env.USDC_CONTRACT ?? "usdc.fakes.testnet",
  usdcDecimals: num("USDC_DECIMALS", 6),

  /** Share of the budget held back and never planned (covers going a bit over plan). */
  contingencyShare: num("CONTINGENCY_SHARE", 0.1),
  /** After the one counter, accept a final price up to plannedSpend * this. */
  walkAwayMultiplier: num("WALK_AWAY_MULTIPLIER", 1.2),
  /** No single payment may exceed this share of the total budget. */
  maxSinglePaymentShare: num("MAX_SINGLE_PAYMENT_SHARE", 0.5),

  workersBasePort: num("WORKERS_BASE_PORT", 4100),
  marketApi: process.env.MARKET_API ?? "https://market.near.ai",
  useLiveMarket: process.env.USE_LIVE_MARKET !== "0",

  /** Optional: NEAR AI Cloud (OpenAI-compatible) for in-house writing and counter wording. */
  llmBaseUrl: process.env.LLM_BASE_URL ?? "https://cloud-api.near.ai/v1",
  llmApiKey: process.env.LLM_API_KEY ?? "",
  llmModel: process.env.LLM_MODEL ?? "deepseek-ai/DeepSeek-V3.1",

  outDir: process.env.OUT_DIR ?? "out",
};

export function payeeFor(handle: string): string {
  const key = `PAYEE_${handle.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  return process.env[key] ?? `${handle}.worker.sim`;
}
