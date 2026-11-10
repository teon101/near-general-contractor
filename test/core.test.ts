import { test } from "node:test";
import assert from "node:assert/strict";
import { GuardError, SpendGuard } from "../src/guard.js";
import { SimulatedRail } from "../src/payments.js";
import { negotiate } from "../src/negotiate.js";
import { checkChart, checkData, checkWriteup } from "../src/checks.js";
import { renderChart, writeBriefTemplate } from "../src/skills.js";
import { runContractor } from "../src/contractor.js";
import { startAllWorkers } from "../src/workers/server.js";

const payees = new Set(["a.testnet", "b.testnet"]);

test("guard: never lets total spend pass the budget", async () => {
  const g = new SpendGuard(1, "USDC", payees, 1);
  const rail = new SimulatedRail("USDC", 10);
  const c1 = g.commit("t1", "a.testnet", 0.6);
  await g.pay(c1.id, 0.6, rail, "x");
  assert.throws(() => g.commit("t2", "b.testnet", 0.5), GuardError);
  const c2 = g.commit("t2", "b.testnet", 0.4);
  await g.pay(c2.id, 0.4, rail, "x");
  assert.equal(g.spent, 1);
  assert.equal(g.available(), 0);
});

test("guard: floats don't drift (0.1 + 0.2)", async () => {
  const g = new SpendGuard(0.3, "USDC", payees, 1);
  const rail = new SimulatedRail("USDC", 1);
  await g.pay(g.commit("t1", "a.testnet", 0.1).id, 0.1, rail, "x");
  await g.pay(g.commit("t2", "a.testnet", 0.2).id, 0.2, rail, "x");
  assert.equal(g.spent, 0.3);
});

test("guard: refuses unknown payees, oversize payments and double pays", async () => {
  const g = new SpendGuard(1, "USDC", payees, 0.5);
  const rail = new SimulatedRail("USDC", 10);
  assert.throws(() => g.commit("t1", "attacker.testnet", 0.1), /allowlist/);
  assert.throws(() => g.commit("t1", "a.testnet", 0.6), /single-payment cap/);
  const c = g.commit("t1", "a.testnet", 0.3);
  await assert.rejects(g.pay(c.id, 0.31, rail, "x"), /does not match/);
  await g.pay(c.id, 0.3, rail, "x");
  await assert.rejects(g.pay(c.id, 0.3, rail, "x"), /no open commitment/);
  assert.equal(rail.paid.length, 1);
});

test("guard: released commitments free the money", () => {
  const g = new SpendGuard(1, "USDC", payees, 1);
  const c = g.commit("t1", "a.testnet", 0.7);
  assert.equal(g.available(), 0.3);
  g.release(c.id);
  assert.equal(g.available(), 1);
});

const base = { available: 1, walkAwayMultiplier: 1.2, token: "USDC", marketNote: "test" };

test("negotiate: quote within plan is accepted without a counter", async () => {
  let countered = false;
  const r = await negotiate({ ...base, quote: { handle: "w", price: 0.2, etaSeconds: 1, note: "" }, planned: 0.3,
    sendCounter: async () => { countered = true; return { accepted: true, finalPrice: 0, message: "" }; } });
  assert.equal(r.kind, "accepted");
  assert.equal(countered, false);
});

test("negotiate: counters once, accepts a final price under the ceiling", async () => {
  let calls = 0;
  const r = await negotiate({ ...base, quote: { handle: "w", price: 0.45, etaSeconds: 1, note: "" }, planned: 0.3,
    sendCounter: async () => { calls++; return { accepted: false, finalPrice: 0.34, message: "" }; } });
  assert.deepEqual([r.kind, calls], ["accepted", 1]);
  assert.equal(r.kind === "accepted" && r.price, 0.34);
});

test("negotiate: walks away when the final price is above the ceiling", async () => {
  const r = await negotiate({ ...base, quote: { handle: "w", price: 0.9, etaSeconds: 1, note: "" }, planned: 0.4,
    sendCounter: async () => ({ accepted: false, finalPrice: 0.7, message: "" }) });
  assert.equal(r.kind, "walked_away");
});

test("negotiate: never agrees to more than the money left", async () => {
  const r = await negotiate({ ...base, available: 0.25, quote: { handle: "w", price: 0.3, etaSeconds: 1, note: "" }, planned: 0.3,
    sendCounter: async (p) => ({ accepted: true, finalPrice: p, message: "" }) });
  assert.equal(r.kind === "accepted" && r.price, 0.25);
});

const data = { source: "test", asset: "near", currency: "usd", points: [1, 2, 3, 4, 5, 6].map((i) => ({ t: i, price: 2 + i / 100 })) };

test("checks: good deliveries pass, bad ones fail", () => {
  assert.equal(checkData(data).passed, true);
  assert.equal(checkData({ source: "", points: [{ t: 2, price: 1 }, { t: 1, price: -1 }] }).passed, false);
  assert.equal(checkChart({ svg: renderChart(data, "t") }, data).passed, true);
  assert.equal(checkChart({ svg: renderChart({ ...data, points: data.points.slice(0, 5) }, "t") }, data).passed, false);
  assert.equal(checkWriteup({ markdown: writeBriefTemplate("task", data) }, data).passed, true);
  assert.equal(checkWriteup({ markdown: "# hi\nshort" }, data).passed, false);
});

test("end to end: stays within budget and writes a receipt line for every attempt", async () => {
  const { workers, stop } = await startAllWorkers(4300);
  try {
    for (const budget of [1, 0.6, 0.3]) {
      const rail = new SimulatedRail("USDC", budget);
      const res = await runContractor({ task: "NEAR brief with a price chart", budget, token: "USDC", workers, rail, log: () => {} });
      assert.ok(res.spent <= budget, `spent ${res.spent} > ${budget}`);
      const paidTotal = rail.paid.reduce((s, p) => s + p.amount, 0);
      assert.ok(Math.abs(paidTotal - res.spent) < 1e-9);
      assert.ok(res.receipts.length >= res.plan.subtasks.length);
      for (const r of res.receipts.filter((r) => r.outcome === "paid")) assert.equal(r.checkPassed, true);
    }
  } finally {
    stop();
  }
});
