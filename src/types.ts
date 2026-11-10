// Shared types for the contractor, the workers and the receipts.

export type Skill = "data" | "chart" | "writeup" | "general";

export type Token = "NEAR" | "USDC";

/** One part of the task after the planner splits it. */
export interface Subtask {
  id: string;
  skill: Skill;
  title: string;
  /** "buy" = hire a worker agent, "self" = the contractor does it itself. */
  mode: "buy" | "self";
  /** What the contractor planned to spend on this part (0 for self). */
  plannedSpend: number;
  /** Written before anything is bought: what the work must satisfy to be paid. */
  acceptance: string;
  /** Market category used to look up reference prices. */
  marketCategory: string;
  /** Why the planner included this part (from the AI brain, or the rule that fired). */
  why: string;
}

export interface Plan {
  task: string;
  token: Token;
  budget: number;
  contingency: number;
  subtasks: Subtask[];
  priceSource: string;
  /** Which brain made the plan: an NEAR AI Cloud model, or the built-in rules. */
  brain: string;
  /** CoinGecko id of the asset the task is about, if any. */
  asset: string | null;
}

/** A worker agent the contractor can hire. */
export interface WorkerInfo {
  handle: string;
  skill: Skill;
  url: string;
  /** Where payments go. Only these accounts can ever be paid (payee allowlist). */
  payee: string;
  rating: number;
  /** Asset the worker wants to be paid in. Default: the budget token. */
  payIn?: "USDC";
}

export interface Quote {
  handle: string;
  price: number;
  etaSeconds: number;
  note: string;
  /** "AI" if the worker's AI priced it, otherwise its list price. */
  by?: string;
}

export interface CounterResponse {
  accepted: boolean;
  /** The price the worker will do it for after the counter. */
  finalPrice: number;
  message: string;
  /** "AI" if the worker's AI decided, otherwise "rules". */
  by?: string;
}

export interface Delivery {
  jobId: string;
  handle: string;
  output: unknown;
}

export interface CheckResult {
  passed: boolean;
  reasons: string[];
}

export type NegotiationOutcome =
  | { kind: "accepted"; price: number; log: string[] }
  | { kind: "walked_away"; lastPrice: number; log: string[] };

export interface PaymentResult {
  txHash: string;
  rail: string;
  explorerUrl?: string;
  /** How the payee was settled, if not plain transfer (e.g. NEAR Intents to USDC). */
  settlement?: string;
}

export interface PayOptions {
  /** The payee wants to receive this asset. With a NEAR budget, USDC is settled via NEAR Intents. */
  settleIn?: "USDC";
}

/** One line on the receipt: one attempt to get one part of the task done. */
export interface ReceiptLine {
  subtaskId: string;
  subtask: string;
  what: string;
  from: string;
  payee: string | null;
  quoted: number | null;
  countered: number | null;
  agreed: number | null;
  paid: number;
  token: Token;
  checkPassed: boolean | null;
  checkNotes: string[];
  negotiation: string[];
  outcome: "paid" | "not_paid_failed_check" | "walked_away" | "done_in_house" | "skipped";
  txHash: string | null;
  explorerUrl: string | null;
  settlement: string | null;
  at: string;
}
