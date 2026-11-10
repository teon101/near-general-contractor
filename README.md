# NEAR General Contractor

Built at NEAR HACKATHON (Nov 2026). Tracks: **07 Agent Economy**, **04 Autonomous Business**, **05 AI Swarms**.

You give the agent a task and a budget. It splits the task into parts, decides which parts to do itself and which to buy, gets quotes from other agents, counters once when a quote is over plan, checks the work, pays only for work that passes, and gives you a receipt for every purchase. It can never spend more than the budget.

## Run it (60 seconds, no wallet needed)

Requires Node.js 20 or newer.

```bash
npm install
npm run demo
```

This starts four worker agents locally and runs the contractor against them in **simulated payment mode** (fake transaction hashes, no real money). Output goes to `out/<run-id>/`:

- `report.md` the finished deliverable (brief + chart)
- `chart.svg`, `data.json` the bought parts
- `receipts.md` / `receipts.json` one line per attempt: what, from whom, quoted, countered, agreed, paid, check result, tx hash
- `plan.json` the plan made before any quotes came in

Custom task and budget:

```bash
npm start -- --task "Make me a 7-day market brief on NEAR with a price chart" --budget 1 --token USDC
```

Tests (spend guard, negotiation, checks, and an end-to-end budget test):

```bash
npm test
```

## Live dashboard

```bash
npm run dashboard
```

Open http://localhost:3000 (in Codespaces, open the forwarded port 3000). Type a task and budget, hit **Run agent**, and watch the plan, every quote, counter-offer and reply as a chat, each check (PASS/FAIL), each payment with its explorer link, a live budget meter (spent / committed / left), the receipts table, and the finished deliverable. It uses the same `.env` as the CLI, so with `PAYMENT_RAIL=near` the payments are real testnet transactions. Add `?pace=300` to the URL to speed up the playback (default 650 ms per step). The server only listens on localhost and caps budgets at `DASHBOARD_MAX_BUDGET` (default 2), because anyone who can open the page can start a run that spends from the contractor wallet.

## What one demo run shows

The planned spend for each part comes from live Agent Market pricing, so exact numbers move from run to run. The branches don't:

| Part | What happens |
|---|---|
| Price data | Cheapest worker (@quickdata, 0.08) is accepted, delivers bad data, fails the check, gets one revision, fails again, **is not paid**. Next worker (@datafeed, 0.18) passes and is paid. |
| Chart | @chartsmith quotes 0.45, above plan. Contractor **counters once at the planned price with its reasoning**. If the worker's answer is under the walk-away ceiling (plan x 1.2) it accepts and pays after the check passes. |
| Write-up | @penpal quotes 0.90, far above plan. Counter is refused with a final price of 0.70, above the ceiling, so the contractor **walks away** and writes it in-house. |

Example run with live market prices (10 Nov 2026): plan was data 0.26, chart 0.40, write-up 0.24. Chart counter at 0.397 was accepted. Spent 0.577 of a 1.00 budget. With the offline fallback weights, the chart worker rejects the counter and settles at 0.34, and the run spends 0.52.

## The AI brain (NEAR AI Cloud)

With `LLM_API_KEY` set (from cloud.near.ai), the agent uses NEAR AI Cloud's TEE-backed inference for its judgment calls:

- **Planning:** splits any task into parts, picks the asset, and writes the acceptance check for open-ended parts. Example: "brief on NEAR with a chart, plus a 5-tweet thread" becomes data (buy), chart (buy), brief (buy), thread (in-house).
- **Counter-offers:** writes the counter message to the worker.
- **In-house work:** does `general` parts nobody is hired for (threads, outlines, plans, copy).
- **Checking:** judges general work against its acceptance check.

The AI is advisory, and code has the final say on anything involving money or acceptance:

- The plan is validated: only known skills, at most 6 parts, data before anything that needs it. Bad plans are sent back once, then the agent falls back to built-in rules.
- **Prices are never set by the AI.** Planned spend comes from market prices, and the counter price comes from the negotiation policy. The AI only explains the counter, and its message is thrown out if it doesn't state the exact counter price.
- Data, chart and brief are checked by deterministic code. Only open-ended general work uses the AI judge.
- The AI never sees a key and has no way to call the payment rail.

The model is picked from the live NEAR AI Cloud catalog unless `LLM_MODEL` is set. Without a key everything still runs, using rules and templates.

## The task loop

1. **Plan.** The AI brain (or the built-in rules) splits the task into parts. For each part decide do vs. buy, set a planned spend, and write the acceptance check. 10% of the budget is held back as contingency. Planned spend is split using reference prices from market.near.ai (see below).
2. **Source.** Ask every worker with the right skill for a quote. Try the cheapest first.
3. **Negotiate.** Quote at or under plan: accept. Over plan: counter once at the planned price and say why. If the worker's answer is at or under `min(planned x 1.2, money left)`, accept. Otherwise walk away and try the next worker.
4. **Commit.** The spend guard reserves the agreed price. It refuses if the payee isn't allowlisted, the amount is over the single-payment cap, or it would break the budget.
5. **Hire.** Send the brief, receive the delivery.
6. **Check.** Run the acceptance check fixed at planning time. One revision is allowed.
7. **Pay.** Only work that passed is paid, and only through the guard.
8. **Receipt.** One line per attempt, plus the final deliverable and a spend summary.

## Keys and what the agent can't do without you

- **The LLM never sees a key.** The private key is read from the environment in `src/payments.ts` only, and is never logged or written to receipts.
- **The spend guard (`src/guard.ts`) is plain code**, and it is the only path to a payment. The planner and negotiator can only propose. The guard enforces: total spend within budget, payee allowlist (registered workers only), single-payment cap (50% of budget by default), payment must match an agreed commitment, no double payment. Amounts are handled in micro-units so rounding can't leak money.
- **Use a dedicated sub-account** (for example `contractor.yourname.testnet`) funded with only this run's budget. The agent checks that the wallet actually holds the budget before it starts.
- **Mainnet is refused** unless `ALLOW_MAINNET=1`.
- **Needs a human:** funding the wallet, raising a budget, adding a new payee to the allowlist.
- **Honest limit:** paying USDC (NEP-141) needs a 1 yoctoNEAR deposit, so a function-call access key can't do it and the sub-account uses a full-access key. The allowlist and caps are enforced by our code, not by the chain. The upgrade path is a TEE-backed policy wallet (for example OutLayer agent custody) so the same rules are enforced before signing.

## Real payments on NEAR testnet

One command creates everything (free test NEAR from the public testnet faucet):

```bash
npm run setup:testnet
npm start -- --budget 1 --token NEAR
```

`setup:testnet` creates a root testnet account, then `contractor.<root>` (the agent's wallet, funded with test NEAR) and one payout account per worker. It writes `.env` with `PAYMENT_RAIL=near` and the payee allowlist, and saves all keys to `.testnet-keys.json`. Both files are gitignored. To use an account you already have instead of the faucet:

```bash
ROOT_ACCOUNT_ID=you.testnet ROOT_PRIVATE_KEY=ed25519:... npm run setup:testnet
```

Receipts then include real transaction hashes with testnet explorer links. `PAYMENT_RAIL=usdc` pays with `ft_transfer` on the NEP-141 token set in `USDC_CONTRACT` and registers the payee's token storage first if needed (see `.env.example`).

## Why not hire on market.near.ai directly?

The brief asked us to check how jobs get posted and paid programmatically on the NEAR AI Agent Market, and to say so if there was no public way. We read the market's public OpenAPI spec (`agents-market API`, v2.0.0, 10 Nov 2026):

- An agent **can** browse listed agents (`GET /v1/agents`) and their pricing plans (`GET /v1/agents/{id}/pricing-plans`), bid on jobs, message on bid threads, and submit work. That's the worker side.
- An agent **can't** post a normal job, award a bid, or accept work and release escrow. There are no public endpoints for those. The only spending endpoint, `POST /v1/jobs/competition`, is marked "Humans only: the call spends". Hiring and paying happen in the web app with a signed-in person.

So the contractor uses the Agent Market **read-only, for reference prices** when it plans (`src/market.ts`), and hires our own worker agents, which expose a small quote / counter / job HTTP interface (`src/workers/`), paying them directly. If market.near.ai can't be reached, the planner falls back to fixed relative weights and says so on the receipt.

## Project layout

```
src/
  cli.ts            entry point (terminal)
  dashboard/        live web dashboard (server + single-page UI)
  contractor.ts     the task loop
  planner.ts        split task (AI or rules), do vs. buy, planned spend, acceptance checks
  brain.ts          AI counter wording, in-house general work, AI judge
  llm.ts            NEAR AI Cloud client
  negotiate.ts      one-counter policy
  guard.ts          spend guard (the only path to money)
  payments.ts       simulate / NEAR / USDC rails (only file that reads a key)
  market.ts         read-only Agent Market price reference
  checks.ts         acceptance checks
  skills.ts         price data, chart, write-up
  receipts.ts       receipt rendering
  workers/          the worker agents (HTTP), their profiles, the client
scripts/setup-testnet.ts   one-command testnet wallet setup
test/core.test.ts  guard, negotiation, checks, end-to-end budget
test/brain.test.ts AI path against a fake NEAR AI Cloud server
```

## Current status and limits

- Simulated mode is tested end to end (`npm test`).
- The NEAR rail is verified on testnet (10 Nov 2026, contractor `contractor.gc-1f89ed5d.testnet`): 0.18 NEAR to datafeed ([En7jAGFv...](https://testnet.nearblocks.io/txns/En7jAGFvtcGEekp7anWyEDS7bQa9JKJc4Ss9nQYK8cr2)) and 0.397 NEAR to chartsmith ([bABKo7dJ...](https://testnet.nearblocks.io/txns/bABKo7dJX6Sfr7n1swt3p7AYNL7PHV7jLuLVK68sJQj)). quickdata (failed check) and penpal (walked away) received nothing.
- The USDC (NEP-141) rail is implemented but has not been run against testnet yet.
- Hirable worker skills are data, chart and write-up. Any other part the AI plans is done in-house by the contractor (needs `LLM_API_KEY`), so a task outside crypto market work ends up mostly in-house.
- Payment is released after the check passes, directly from the contractor wallet. There is no on-chain escrow contract in this version.
- Price data comes from CoinGecko; offline runs use clearly labelled sample data.

## License

MIT
