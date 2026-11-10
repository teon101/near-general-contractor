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

export async function runContractor(opts: {
  task: string;
  budget: number;
  token: Token;
  workers: WorkerInfo[];
  rail: PaymentRail;
  log?: Log;
}): Promise<RunResult> {
  const log: Log = opts.log ?? ((m) => console.log(m));
  const { task, budget, token, workers, rail } = opts;
  const runId = new Date().toISOString().replace(/[:.]/g, "-");

  // 0. The wallet must actually hold the budget. The guard then makes sure we never spend past it.
  const walletBalance = await rail.balance();
  if (walletBalance + 1e-9 < budget) {
    throw new Error(`wallet holds ${walletBalance} ${token} but the budget is ${budget} ${token}. Top up the contractor wallet first.`);
  }
  const guard = new SpendGuard(budget, token, new Set(workers.map((w) => w.payee)), config.maxSinglePaymentShare);

  // 1. Plan
  const plan = await makePlan(task, budget, token, workers);
  log(`\nPLAN  budget ${budget} ${token}, holding back ${plan.contingency} as contingency`);
  log(`      planning prices from: ${plan.priceSource}`);
  for (const s of plan.subtasks) {
    log(`      ${s.id} ${s.title.padEnd(32)} ${s.mode === "buy" ? `BUY  planned ${s.plannedSpend} ${token}` : "SELF"}`);
    log(`         check: ${s.acceptance}`);
  }

  const receipts: ReceiptLine[] = [];
  const outputs: Partial<Record<Subtask["skill"], unknown>> = {};
  const asset = assetFromTask(task);
  const now = () => new Date().toISOString();

  const inputFor = (s: Subtask) => (s.skill === "data" ? { asset } : { data: outputs.data });
  const briefFor = (s: Subtask) => `${s.title} for: ${task}. Acceptance: ${s.acceptance}`;

  const doInHouse = async (s: Subtask, reason: string) => {
    const data = (outputs.data as DataOutput) ?? null;
    if (s.skill !== "writeup" || !data) {
      receipts.push(line(s, { what: s.title, from: "nobody", outcome: "skipped", checkNotes: [reason] }));
      log(`  -> skipped: ${reason}`);
      return;
    }
    const { markdown, by } = await writeBrief(task, data);
    const check = runCheck("writeup", { markdown }, data);
    if (check.passed) outputs.writeup = { markdown };
    receipts.push(line(s, { what: `${s.title} (in-house, ${by})`, from: "contractor (self)", outcome: "done_in_house", checkPassed: check.passed, checkNotes: [reason, ...check.reasons] }));
    log(`  -> did it in-house (${by}). check: ${check.passed ? "PASS" : "FAIL"} (${check.reasons.join("; ")})`);
  };

  const line = (s: Subtask, p: Partial<ReceiptLine>): ReceiptLine => ({
    subtaskId: s.id, subtask: s.title, what: s.title, from: "-", payee: null,
    quoted: null, countered: null, agreed: null, paid: 0, token,
    checkPassed: null, checkNotes: [], negotiation: [], outcome: "skipped",
    txHash: null, explorerUrl: null, at: now(), ...p,
  });

  for (const s of plan.subtasks) {
    log(`\n[${s.id}] ${s.title}`);
    if (s.skill !== "data" && !outputs.data) {
      receipts.push(line(s, { outcome: "skipped", checkNotes: ["no valid data to build on"] }));
      log("  -> skipped: no valid data to build on");
      continue;
    }
    if (s.mode === "self") { await doInHouse(s, "no worker offers this"); continue; }

    // 2. Source
    const candidates = workers.filter((w) => w.skill === s.skill);
    const quotes = (await Promise.all(candidates.map(async (w) => ({ w, q: await requestQuote(w, briefFor(s)) }))))
      .sort((a, b) => a.q.price - b.q.price || b.w.rating - a.w.rating);
    log(`  quotes: ${quotes.map(({ w, q }) => `@${w.handle} ${q.price}`).join(", ")}`);

    let done = false;
    for (const { w, q } of quotes) {
      // 3. Negotiate
      let countered: number | null = null;
      const outcome = await negotiate({
        quote: q, planned: s.plannedSpend, available: guard.available(), token,
        walkAwayMultiplier: config.walkAwayMultiplier,
        marketNote: plan.priceSource.startsWith("market") ? "current Agent Market prices for this kind of work" : "my price plan for this job",
        sendCounter: (price, reasoning) => { countered = price; return sendCounter(w, price, reasoning); },
      });
      outcome.log.forEach((m) => log(`  ${m}`));
      if (outcome.kind === "walked_away") {
        receipts.push(line(s, { from: `@${w.handle}`, payee: w.payee, quoted: q.price, countered, outcome: "walked_away", negotiation: outcome.log }));
        continue;
      }

      // 4. Commit
      let commitment;
      try {
        commitment = guard.commit(s.id, w.payee, outcome.price);
      } catch (e) {
        if (!(e instanceof GuardError)) throw e;
        log(`  guard refused: ${e.message}`);
        receipts.push(line(s, { from: `@${w.handle}`, payee: w.payee, quoted: q.price, countered, agreed: outcome.price, outcome: "skipped", checkNotes: [`spend guard: ${e.message}`], negotiation: outcome.log }));
        continue;
      }

      // 5 + 6. Hire and check, one revision allowed
      let delivery = await hire(w, briefFor(s), outcome.price, inputFor(s));
      let check = runCheck(s.skill, delivery.output, (outputs.data as DataOutput) ?? null);
      log(`  delivered by @${w.handle}. check: ${check.passed ? "PASS" : "FAIL"} (${check.reasons.join("; ")})`);
      const notes = [...check.reasons];
      if (!check.passed) {
        log("  asked for one revision");
        delivery = await hire(w, `${briefFor(s)}. REVISION: fix ${check.reasons.join("; ")}`, outcome.price, inputFor(s));
        check = runCheck(s.skill, delivery.output, (outputs.data as DataOutput) ?? null);
        log(`  revision check: ${check.passed ? "PASS" : "FAIL"} (${check.reasons.join("; ")})`);
        notes.push(`revision: ${check.reasons.join("; ")}`);
      }

      if (!check.passed) {
        guard.release(commitment.id);
        receipts.push(line(s, { from: `@${w.handle}`, payee: w.payee, quoted: q.price, countered, agreed: outcome.price, checkPassed: false, checkNotes: notes, outcome: "not_paid_failed_check", negotiation: outcome.log }));
        log(`  not paid. moving to the next worker`);
        continue;
      }

      // 7. Pay
      const pay = await guard.pay(commitment.id, outcome.price, rail, `${runId} ${s.id} ${s.title}`);
      outputs[s.skill] = delivery.output;
      receipts.push(line(s, {
        from: `@${w.handle}`, payee: w.payee, quoted: q.price, countered, agreed: outcome.price, paid: outcome.price,
        checkPassed: true, checkNotes: notes, outcome: "paid", negotiation: outcome.log,
        txHash: pay.txHash, explorerUrl: pay.explorerUrl ?? null,
      }));
      log(`  PAID ${outcome.price} ${token} to ${w.payee}  tx ${pay.txHash}`);
      done = true;
      break;
    }

    if (!done) {
      if (canDoInHouse(s.skill)) await doInHouse(s, "no worker delivered within budget");
      else {
        receipts.push(line(s, { outcome: "skipped", checkNotes: ["no worker delivered within budget"] }));
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
  if (outputs.data) writeFileSync(join(outDir, "data.json"), JSON.stringify(outputs.data, null, 2));
  writeFileSync(join(outDir, "report.md"), parts.join("\n") || "_No deliverable was completed._\n");
  writeFileSync(join(outDir, "plan.json"), JSON.stringify(plan, null, 2));
  writeFileSync(join(outDir, "receipts.json"), JSON.stringify({ runId, task, budget, token, spent: guard.spent, rail: rail.name, receipts }, null, 2));
  writeFileSync(join(outDir, "receipts.md"), receiptsMarkdown(runId, plan, receipts, guard.spent, rail.name));

  log(`\nDONE  spent ${guard.spent} of ${budget} ${token} (left ${Math.round((budget - guard.spent) * 1e6) / 1e6})`);
  log(`      deliverable: ${join(outDir, "report.md")}`);
  log(`      receipts:    ${join(outDir, "receipts.md")}`);
  return { runId, plan, receipts, spent: guard.spent, outDir };
}
