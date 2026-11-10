// The spend guard: plain code that sits between the agent's decisions and the wallet.
// The planner and negotiator can PROPOSE spending; only the guard can make a payment happen.
// Rules it enforces, no matter what the rest of the agent decides:
//   1. total paid + total committed can never exceed the budget
//   2. only allowlisted payees (registered worker agents) can be paid
//   3. no single payment above maxSinglePaymentShare of the budget
//   4. a payment must match a commitment made at agreement time, and can't exceed it
//   5. a commitment can only be paid once

import type { PaymentResult, Token } from "./types.js";
import type { PaymentRail } from "./payments.js";

const SCALE = 1_000_000; // work in micro-units so 0.1 + 0.2 never drifts

export const toMicro = (n: number) => Math.round(n * SCALE);
export const fromMicro = (m: number) => m / SCALE;

export class GuardError extends Error {}

export interface Commitment {
  id: string;
  subtaskId: string;
  payee: string;
  amountMicro: number;
  state: "open" | "paid" | "released";
}

export class SpendGuard {
  private readonly budgetMicro: number;
  private spentMicro = 0;
  private commitments = new Map<string, Commitment>();
  private seq = 0;

  constructor(
    budget: number,
    readonly token: Token,
    private readonly allowlist: Set<string>,
    private readonly maxSingleShare: number,
  ) {
    if (!(budget > 0)) throw new GuardError("budget must be greater than 0");
    this.budgetMicro = toMicro(budget);
  }

  get budget() { return fromMicro(this.budgetMicro); }
  get spent() { return fromMicro(this.spentMicro); }
  get committed() {
    let m = 0;
    for (const c of this.commitments.values()) if (c.state === "open") m += c.amountMicro;
    return fromMicro(m);
  }
  /** Money not yet paid and not promised to anyone. */
  available() { return fromMicro(this.budgetMicro - this.spentMicro - toMicro(this.committed)); }

  /** Can this amount be promised to this payee right now? Returns the reason if not. */
  check(payee: string, amount: number): string | null {
    const m = toMicro(amount);
    if (!(m > 0)) return "amount must be positive";
    if (!this.allowlist.has(payee)) return `payee ${payee} is not on the allowlist`;
    if (m > Math.floor(this.budgetMicro * this.maxSingleShare))
      return `amount ${amount} is above the single-payment cap (${fromMicro(Math.floor(this.budgetMicro * this.maxSingleShare))} ${this.token})`;
    if (m > toMicro(this.available())) return `amount ${amount} is above what's left (${this.available()} ${this.token})`;
    return null;
  }

  /** Reserve money for an agreed price before the work is delivered. */
  commit(subtaskId: string, payee: string, amount: number): Commitment {
    const why = this.check(payee, amount);
    if (why) throw new GuardError(why);
    const c: Commitment = { id: `c${++this.seq}`, subtaskId, payee, amountMicro: toMicro(amount), state: "open" };
    this.commitments.set(c.id, c);
    return c;
  }

  /** Give a reservation back (work failed the check, or the deal fell through). */
  release(commitmentId: string) {
    const c = this.commitments.get(commitmentId);
    if (!c || c.state !== "open") throw new GuardError(`no open commitment ${commitmentId}`);
    c.state = "released";
  }

  /** Pay a commitment. The only path to the payment rail in the whole codebase. */
  async pay(commitmentId: string, amount: number, rail: PaymentRail, memo: string): Promise<PaymentResult> {
    const c = this.commitments.get(commitmentId);
    if (!c || c.state !== "open") throw new GuardError(`no open commitment ${commitmentId}`);
    const m = toMicro(amount);
    if (m <= 0 || m > c.amountMicro) throw new GuardError(`payment ${amount} does not match commitment ${fromMicro(c.amountMicro)}`);
    if (this.spentMicro + m > this.budgetMicro) throw new GuardError("payment would exceed the budget");
    // Mark paid BEFORE sending so a retry can never double-pay. If the send fails we restore it.
    c.state = "paid";
    try {
      const res = await rail.pay(c.payee, fromMicro(m), memo);
      this.spentMicro += m;
      return res;
    } catch (e) {
      c.state = "open";
      throw e;
    }
  }
}
