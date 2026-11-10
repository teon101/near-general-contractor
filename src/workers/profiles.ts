// The worker agents in the demo. Each one is a separate HTTP service with its own pricing,
// its own price floor for negotiation, and its own payout account.
// Their behaviour is set up so one run shows every branch of the contractor's loop:
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
}

export const PROFILES: WorkerProfile[] = [
  { handle: "quickdata", skill: "data", quote: 0.08, floor: 0.08, rating: 3.1, etaSeconds: 30, quality: "bad" },
  { handle: "datafeed", skill: "data", quote: 0.18, floor: 0.15, rating: 4.6, etaSeconds: 60, quality: "good" },
  { handle: "chartsmith", skill: "chart", quote: 0.45, floor: 0.34, rating: 4.8, etaSeconds: 90, quality: "good" },
  { handle: "penpal", skill: "writeup", quote: 0.9, floor: 0.7, rating: 4.9, etaSeconds: 300, quality: "good" },
];
