// Entry point.
//   npm run demo
//   npm start -- --task "Make me a 7-day market brief on NEAR with a price chart" --budget 1 --token USDC

import { config } from "./config.js";
import { runContractor } from "./contractor.js";
import { makeRail } from "./payments.js";
import type { Token } from "./types.js";
import { startAllWorkers } from "./workers/server.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const task = arg("task") ?? "Make me a 7-day market brief on NEAR with a price chart";
const budget = Number(arg("budget") ?? "1");
const token = (arg("token") ?? (config.rail === "near" ? "NEAR" : "USDC")).toUpperCase() as Token;

if (!Number.isFinite(budget) || budget <= 0) {
  console.error("--budget must be a positive number");
  process.exit(1);
}
if ((config.rail === "near" && token !== "NEAR") || (config.rail === "usdc" && token !== "USDC")) {
  console.error(`PAYMENT_RAIL=${config.rail} pays in ${config.rail === "near" ? "NEAR" : "USDC"}, but --token is ${token}`);
  process.exit(1);
}

console.log("NEAR GENERAL CONTRACTOR");
console.log(`task:   ${task}`);
console.log(`budget: ${budget} ${token}`);
console.log(`rail:   ${config.rail}${config.rail === "simulate" ? " (no real money moves; set PAYMENT_RAIL=near or usdc for testnet)" : ` on ${config.network} from ${config.contractorAccountId}`}`);

const { workers, stop } = await startAllWorkers();
console.log(`\nworkers online: ${workers.map((w) => `@${w.handle} (${w.skill})`).join(", ")}`);

try {
  await runContractor({ task, budget, token, workers, rail: makeRail(token, budget) });
} catch (e) {
  console.error(`\nERROR: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  stop();
}
