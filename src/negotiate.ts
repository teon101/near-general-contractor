// Negotiation policy: one counter, with reasoning, then accept or walk away.
//
//   quote <= planned                      -> accept the quote
//   quote  > planned                      -> counter ONCE at the planned price, explaining why
//   worker's answer <= ceiling            -> accept (ceiling = min(planned * 1.2, money left))
//   worker's answer  > ceiling            -> walk away
//
// The policy is plain code, so the agent can't talk itself into a bad deal.

import type { CounterResponse, NegotiationOutcome, Quote } from "./types.js";

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export interface NegotiationInput {
  quote: Quote;
  planned: number;
  available: number;
  walkAwayMultiplier: number;
  token: string;
  marketNote: string;
  /** Sends the counter to the worker and returns its answer. Called at most once. */
  sendCounter: (price: number, reasoning: string) => Promise<CounterResponse>;
  /** Optional: AI wording for the counter. Gets the price already decided by code. */
  writeReasoning?: (counter: number, fallback: string) => Promise<{ text: string; by: string }>;
}

export function counterReasoning(i: NegotiationInput, counter: number) {
  const over = Math.round(((i.quote.price - i.planned) / i.planned) * 100);
  return (
    `Your quote of ${i.quote.price} ${i.token} is ${over}% over what I budgeted for this part. ` +
    `I planned ${i.planned} ${i.token} based on ${i.marketNote}, and the rest of the budget is ` +
    `committed to other parts of the job. I can do ${counter} ${i.token}, paid in full as soon as the work passes my check.`
  );
}

export async function negotiate(i: NegotiationInput): Promise<NegotiationOutcome> {
  const log: string[] = [`quote: ${i.quote.price} ${i.token} from @${i.quote.handle} (planned ${i.planned})`];
  const ceiling = r4(Math.min(i.planned * i.walkAwayMultiplier, i.available));

  if (i.quote.price <= i.planned && i.quote.price <= i.available) {
    log.push("quote is within plan: accepted without countering");
    return { kind: "accepted", price: i.quote.price, log };
  }

  const counter = r4(Math.min(i.planned, i.available));
  const fallback = counterReasoning(i, counter);
  const written = i.writeReasoning ? await i.writeReasoning(counter, fallback) : { text: fallback, by: "template" };
  const reasoning = written.text;
  log.push(`counter: ${counter} ${i.token} (message by ${written.by}). "${reasoning}"`);
  const resp = await i.sendCounter(counter, reasoning);
  log.push(`reply: ${resp.accepted ? "accepted counter" : `final price ${resp.finalPrice}`}. "${resp.message}"`);

  const final = resp.accepted ? counter : resp.finalPrice;
  if (final <= ceiling) {
    log.push(`accepted at ${final} ${i.token} (walk-away ceiling was ${ceiling})`);
    return { kind: "accepted", price: final, log };
  }
  log.push(`walked away: ${final} is above the ceiling of ${ceiling} ${i.token}`);
  return { kind: "walked_away", lastPrice: final, log };
}
