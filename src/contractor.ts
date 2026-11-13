// The general contractor agent: the task loop.
//
//   1. plan      split the task, decide do-vs-buy, set planned spend + acceptance checks
//   2. source    ask every worker with the right skill for a quote, cheapest first
//   3. negotiate accept if within plan, otherwise counter once, then accept or walk away
//   4. commit    the spend guard reserves the agreed price (refuses if it breaks a rule)
//   5. hire      send the brief, get the delivery
//   6. check     run the acceptance check; one revision allowed if it fails
//   7. pay       only work that passed gets paid, through the guard
//   8. receipt   one line per attempt, then the final deliverable and a spend summary

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { runCheck, type DataOutput } from "./checks.js";
import { GuardError, SpendGuard } from "./guard.js";
import { negotiate } from "./negotiate.js";
import type { PaymentRail } from "./payments.js";
import { assetFromTask, canDoInHouse, makePlan } from "./planner.js";
import { counterMessage, doGeneralWork, judgeGeneral } from "./brain.js";
import { receiptsMarkdown } from "./receipts.js";
import { writeBrief } from "./skills.js";
import type { Plan, ReceiptLine, Subtask, Token, WorkerInfo } from "./types.js";
import { hire, requestQuote, sendCounter } from "./workers/client.js";

export interface RunResult {
  runId: string;
  plan: Plan;
  receipts: ReceiptLine[];
  spent: number;
  outDir: string;
}

type Log = (msg: string) => void;

/** Structured events for the dashboard. The CLI ignores them. */
export type AgentEvent =
  | { type: "plan"; plan: Plan }
  | { type: "part"; id: string; status: "active" | "paid" | "in_house" | "skipped" | "failed" }
  | { type: "quotes"; id: string; quotes: { handle: string; price: number }[] }
  | { type: "msg"; id: string; from: string; text: string; kind: "quote" | "counter" | "reply" | "decision"; price?: number; by?: string }
  | { type: "check"; id: string; who: string; passed: boolean; reasons: string[]; revision: boolean }
  | { type: "paid"; id: string; handle: string; payee: string; amount: number; txHash: string; explorerUrl: string | null; settlement: string | null }
  | { type: "receipt"; line: ReceiptLine }
  | { type: "budget"; budget: number; spent: number; committed: number; available: number }
  | { type: "done"; runId: string; spent: number; report: string; chartSvg: string | null; receipts: ReceiptLine[] };

export async function runContractor(opts: {
  task: string;
  budget: number;
  token: Token;
  workers: WorkerInfo[];
  rail: PaymentRail;
  log?: Log;
  emit?: (e: AgentEvent) => void;
}): Promise<RunResult> {
  const log: Log = opts.log ?? ((m) => console.log(m));
  const emit = opts.emit ?? (() => {});
  const { task, budget, token, workers, rail } = opts;
  const runId = new Date().toISOString().replace(/[:.]/g, "-");

  // 0. The wallet must actually hold the budget. The guard then makes sure we never spend past it.
  let walletBalance = await rail.balance();
  if (walletBalance + 1e-9 < budget && rail.ensureBalance) {
    log(`wallet holds ${walletBalance} ${token}, budget is ${budget}. Topping up testnet wallet...`);
    try { walletBalance = await rail.ensureBalance(budget, log); } catch (e) { log(`auto top-up failed: ${(e as Error).message}`); }
  }
  if (walletBalance + 1e-9 < budget) {
    throw new Error(`wallet holds ${walletBalance} ${token} but the budget is ${budget} ${token}. Top up the contractor wallet first.`);
  }
  const guard = new SpendGuard(budget, token, new Set(workers.map((w) => w.payee)), config.maxSinglePaymentShare);
  const budgetEvent = () => emit({ type: "budget", budget, spent: guard.spent, committed: guard.committed, available: guard.available() });

  // 1. Plan
  const plan = await makePlan(task, budget, token, workers, log);
  log(`\nPLAN  budget ${budget} ${token}, holding back ${plan.contingency} as contingency`);
  log(`      brain: ${plan.brain}`);
  log(`      planning prices from: ${plan.priceSource}`);
  for (const s of plan.subtasks) {
    log(`      ${s.id} ${s.title.slice(0, 40).padEnd(40)} ${s.mode === "buy" ? `BUY  planned ${s.plannedSpend} ${token}` : "SELF"}`);
    if (s.why) log(`         why:   ${s.why}`);
    log(`         check: ${s.acceptance}`);
  }
  emit({ type: "plan", plan });
  budgetEvent();

  const receipts: ReceiptLine[] = [];
  const pushReceipt = (l: ReceiptLine) => { receipts.push(l); emit({ type: "receipt", line: l }); };
  const outputs: Partial<Record<Subtask["skill"], unknown>> = {};
  const generalOut: { title: string; markdown: string }[] = [];
  const asset = plan.asset ?? assetFromTask(task);
  const contextSoFar = () => [
    outputs.data ? `Price data (${(outputs.data as DataOutput).asset}, usd): ${(outputs.data as DataOutput).points.map((p) => p.price).join(", ")}` : "",
    outputs.writeup ? (outputs.writeup as { markdown: string }).markdown : "",
    ...generalOut.map((g) => g.markdown),
  ].filter(Boolean).join("\n\n");
  const now = () => new Date().toISOString();

  const inputFor = (s: Subtask) => (s.skill === "data" ? { asset } : { data: outputs.data });
  const briefFor = (s: Subtask) => `${s.title} for: ${task}. Acceptance: ${s.acceptance}`;

  const doInHouse = async (s: Subtask, reason: string) => {
    if (s.skill === "general") {
      const { markdown, by } = await doGeneralWork(task, s, contextSoFar());
      const check = await judgeGeneral(s, markdown);
      emit({ type: "check", id: s.id, who: "contractor", passed: check.passed, reasons: check.reasons, revision: false });
      emit({ type: "part", id: s.id, status: check.passed ? "in_house" : "failed" });
      if (check.passed) generalOut.push({ title: s.title, markdown });
      pushReceipt(line(s, { what: `${s.title} (in-house, ${by})`, from: "contractor (self)", outcome: "done_in_house", checkPassed: check.passed, checkNotes: [reason, ...check.reasons] }));
      log(`  -> did it in-house (${by}). check: ${check.passed ? "PASS" : "FAIL"} (${check.reasons.join("; ")})`);
      return;
    }
    const data = (outputs.data as DataOutput) ?? null;
    if (s.skill !== "writeup" || !data) {
      emit({ type: "part", id: s.id, status: "skipped" });
      pushReceipt(line(s, { what: s.title, from: "nobody", outcome: "skipped", checkNotes: [reason] }));
      log(`  -> skipped: ${reason}`);
      return;
    }
    const { markdown, by } = await writeBrief(task, data);
    const check = runCheck("writeup", { markdown }, data);
    emit({ type: "check", id: s.id, who: "contractor", passed: check.passed, reasons: check.reasons, revision: false });
    emit({ type: "part", id: s.id, status: check.passed ? "in_house" : "failed" });
    if (check.passed) outputs.writeup = { markdown };
    pushReceipt(line(s, { what: `${s.title} (in-house, ${by})`, from: "contractor (self)", outcome: "done_in_house", checkPassed: check.passed, checkNotes: [reason, ...check.reasons] }));
    log(`  -> did it in-house (${by}). check: ${check.passed ? "PASS" : "FAIL"} (${check.reasons.join("; ")})`);
  };

  const line = (s: Subtask, p: Partial<ReceiptLine>): ReceiptLine => ({
    subtaskId: s.id, subtask: s.title, what: s.title, from: "-", payee: null,
    quoted: null, countered: null, agreed: null, paid: 0, token,
    checkPassed: null, checkNotes: [], negotiation: [], outcome: "skipped",
    txHash: null, explorerUrl: null, settlement: null, at: now(), ...p,
  });

  for (const s of plan.subtasks) {
    log(`\n[${s.id}] ${s.title}`);
    emit({ type: "part", id: s.id, status: "active" });
    if ((s.skill === "chart" || s.skill === "writeup") && !outputs.data) {
      emit({ type: "part", id: s.id, status: "skipped" });
      pushReceipt(line(s, { outcome: "skipped", checkNotes: ["no valid data to build on"] }));
      log("  -> skipped: no valid data to build on");
      continue;
    }
    if (s.mode === "self") { await doInHouse(s, "planned as in-house work"); continue; }

    // 2. Source
    const candidates = workers.filter((w) => w.skill === s.skill);
    const quotes = (await Promise.all(candidates.map(async (w) => ({ w, q: await requestQuote(w, briefFor(s)) }))))
      .sort((a, b) => a.q.price - b.q.price || b.w.rating - a.w.rating);
    log(`  quotes: ${quotes.map(({ w, q }) => `@${w.handle} ${q.price}${q.by === "AI" ? " (AI-priced)" : ""}`).join(", ")}`);
    emit({ type: "quotes", id: s.id, quotes: quotes.map(({ w, q }) => ({ handle: w.handle, price: q.price })) });

    let done = false;
    for (const { w, q } of quotes) {
      // 3. Negotiate
      let countered: number | null = null;
      emit({ type: "msg", id: s.id, from: `@${w.handle}`, kind: "quote", price: q.price, by: q.by, text: q.by === "AI" && q.note ? q.note : `I can do "${s.title}" for ${q.price} ${token}.` });
      const outcome = await negotiate({
        quote: q, planned: s.plannedSpend, available: guard.available(), token,
        walkAwayMultiplier: config.walkAwayMultiplier,
        marketNote: plan.priceSource.startsWith("market") ? "current Agent Market prices for this kind of work" : "my price plan for this job",
        sendCounter: async (price, reasoning, writtenBy) => {
          countered = price;
          emit({ type: "msg", id: s.id, from: "contractor", kind: "counter", price, text: reasoning, by: writtenBy.startsWith("AI") ? "AI" : undefined });
          const resp = await sendCounter(w, price, reasoning, q.price);
          emit({ type: "msg", id: s.id, from: `@${w.handle}`, kind: "reply", price: resp.accepted ? price : resp.finalPrice, text: resp.message, by: resp.by });
          return resp;
        },
        writeReasoning: (counter, fallback) => counterMessage({
          quote: q.price, planned: s.plannedSpend, counter, token, partTitle: s.title, budgetLeft: guard.available(), fallback,
          marketNote: plan.priceSource.startsWith("market") ? "current Agent Market prices for this kind of work" : "my price plan for this job",
        }),
      });
      outcome.log.forEach((m) => log(`  ${m}`));
      emit({ type: "msg", id: s.id, from: "contractor", kind: "decision",
        price: outcome.kind === "accepted" ? outcome.price : outcome.lastPrice,
        text: outcome.log[outcome.log.length - 1] });
      if (outcome.kind === "walked_away") {
        pushReceipt(line(s, { from: `@${w.handle}`, payee: w.payee, quoted: q.price, countered, outcome: "walked_away", negotiation: outcome.log }));
        continue;
      }

      // 4. Commit
      let commitment;
      try {
        commitment = guard.commit(s.id, w.payee, outcome.price);
        budgetEvent();
      } catch (e) {
        if (!(e instanceof GuardError)) throw e;
        log(`  guard refused: ${e.message}`);
        pushReceipt(line(s, { from: `@${w.handle}`, payee: w.payee, quoted: q.price, countered, agreed: outcome.price, outcome: "skipped", checkNotes: [`spend guard: ${e.message}`], negotiation: outcome.log }));
        continue;
      }

      // 5 + 6. Hire and check, one revision allowed
      let delivery = await hire(w, briefFor(s), outcome.price, inputFor(s));
      let check = runCheck(s.skill, delivery.output, (outputs.data as DataOutput) ?? null);
      log(`  delivered by @${w.handle}. check: ${check.passed ? "PASS" : "FAIL"} (${check.reasons.join("; ")})`);
      emit({ type: "check", id: s.id, who: `@${w.handle}`, passed: check.passed, reasons: check.reasons, revision: false });
      const notes = [...check.reasons];
      if (!check.passed) {
        log("  asked for one revision");
        delivery = await hire(w, `${briefFor(s)}. REVISION: fix ${check.reasons.join("; ")}`, outcome.price, inputFor(s));
        check = runCheck(s.skill, delivery.output, (outputs.data as DataOutput) ?? null);
        log(`  revision check: ${check.passed ? "PASS" : "FAIL"} (${check.reasons.join("; ")})`);
        emit({ type: "check", id: s.id, who: `@${w.handle}`, passed: check.passed, reasons: check.reasons, revision: true });
        notes.push(`revision: ${check.reasons.join("; ")}`);
      }

      if (!check.passed) {
        guard.release(commitment.id);
        budgetEvent();
        pushReceipt(line(s, { from: `@${w.handle}`, payee: w.payee, quoted: q.price, countered, agreed: outcome.price, checkPassed: false, checkNotes: notes, outcome: "not_paid_failed_check", negotiation: outcome.log }));
        log(`  not paid. moving to the next worker`);
        continue;
      }

      // 7. Pay
      const pay = await guard.pay(commitment.id, outcome.price, rail, `${runId} ${s.id} ${s.title}`, { settleIn: token === "USDC" ? undefined : w.payIn });
      outputs[s.skill] = delivery.output;
      pushReceipt(line(s, {
        from: `@${w.handle}`, payee: w.payee, quoted: q.price, countered, agreed: outcome.price, paid: outcome.price,
        checkPassed: true, checkNotes: notes, outcome: "paid", negotiation: outcome.log,
        txHash: pay.txHash, explorerUrl: pay.explorerUrl ?? null, settlement: pay.settlement ?? null,
      }));
      log(`  PAID ${outcome.price} ${token} to ${w.payee}  tx ${pay.txHash}`);
      if (pay.settlement) log(`  settlement: ${pay.settlement}`);
      emit({ type: "paid", id: s.id, handle: w.handle, payee: w.payee, amount: outcome.price, txHash: pay.txHash, explorerUrl: pay.explorerUrl ?? null, settlement: pay.settlement ?? null });
      emit({ type: "part", id: s.id, status: "paid" });
      budgetEvent();
      done = true;
      break;
    }

    if (!done) {
      if (canDoInHouse(s.skill)) await doInHouse(s, "no worker delivered within budget");
      else {
        emit({ type: "part", id: s.id, status: "skipped" });
        pushReceipt(line(s, { outcome: "skipped", checkNotes: ["no worker delivered within budget"] }));
        log("  -> skipped: no worker delivered within budget");
      }
    }
  }

  // 8. Deliverable + receipts
  const outDir = join(config.outDir, runId);
  mkdirSync(outDir, { recursive: true });
  const parts: string[] = [];
  if (outputs.writeup) parts.push((outputs.writeup as { markdown: string }).markdown);
  if (outputs.chart) {
    writeFileSync(join(outDir, "chart.svg"), (outputs.chart as { svg: string }).svg);
    parts.push("\n![price chart](chart.svg)\n");
  }
  for (const g of generalOut) parts.push(g.markdown);
  if (outputs.data) writeFileSync(join(outDir, "data.json"), JSON.stringify(outputs.data, null, 2));
  writeFileSync(join(outDir, "report.md"), parts.join("\n") || "_No deliverable was completed._\n");
  writeFileSync(join(outDir, "plan.json"), JSON.stringify(plan, null, 2));
  writeFileSync(join(outDir, "receipts.json"), JSON.stringify({ runId, task, budget, token, spent: guard.spent, rail: rail.name, receipts }, null, 2));
  writeFileSync(join(outDir, "receipts.md"), receiptsMarkdown(runId, plan, receipts, guard.spent, rail.name));

  const report = parts.join("\n") || "_No deliverable was completed._\n";
  emit({ type: "done", runId, spent: guard.spent, report, chartSvg: outputs.chart ? (outputs.chart as { svg: string }).svg : null, receipts });
  log(`\nDONE  spent ${guard.spent} of ${budget} ${token} (left ${Math.round((budget - guard.spent) * 1e6) / 1e6})`);
  log(`      deliverable: ${join(outDir, "report.md")}`);
  log(`      receipts:    ${join(outDir, "receipts.md")}`);
  return { runId, plan, receipts, spent: guard.spent, outDir };
}
