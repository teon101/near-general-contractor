// The worker agents in the demo. Each one is a separate HTTP service with its own pricing,
// its own price floor for negotiation, and its own payout account.
// With LLM_API_KEY set, each worker is an AI agent: it reads the brief to set its quote and reads the
// contractor's counter (and its reasoning) to decide whether to accept, meet halfway or hold firm.
// Code keeps it honest: a quote stays within [floor, list x 1.3], a final price within [floor, its quote].
// Without a key, workers use their list price and floor, which is set up so one run shows every branch:
//   quickdata  - cheapest, but delivers bad data  -> fails the check, not paid
//   datafeed   - fair price, good data            -> passes, paid
//   chartsmith - quotes over plan, floor near it  -> countered, accepts, paid
//   penpal     - quotes far over plan             -> countered, still too high, contractor walks away

import type { Skill } from "../types.js";

export interface WorkerProfile {
  handle: string;
  skill: Skill;
  quote: number;
  /** Lowest price it will take after a counter. */
  floor: number;
  rating: number;
  etaSeconds: number;
  quality: "good" | "bad";
  /** How the AI worker behaves in negotiation. Private to the worker. */
  persona: string;
  /** Wants to be paid in USDC. With a NEAR budget the contractor settles this through NEAR Intents. */
  payIn?: "USDC";
}

export const PROFILES: WorkerProfile[] = [
  { handle: "quickdata", skill: "data", quote: 0.08, floor: 0.08, rating: 3.1, etaSeconds: 30, quality: "bad",
    persona: "A bargain-bin data scraper. Always the cheapest, never negotiates, cuts corners." },
  { handle: "datafeed", skill: "data", quote: 0.18, floor: 0.15, rating: 4.6, etaSeconds: 60, quality: "good",
    persona: "A reliable data provider. Fair prices, will take a modest discount for a clear, well-reasoned offer from a buyer who pays on delivery." },
  { handle: "chartsmith", skill: "chart", quote: 0.45, floor: 0.34, rating: 4.8, etaSeconds: 90, quality: "good", payIn: "USDC",
    persona: "A skilled chart designer who wants repeat business. Responds well to reasoning based on market prices, but won't work at a loss." },
  { handle: "penpal", skill: "writeup", quote: 0.9, floor: 0.7, rating: 4.9, etaSeconds: 300, quality: "good", payIn: "USDC",
    persona: "A premium writer with a long waitlist. Proud of the work, rarely discounts, and says so politely." },
];
