// NEAR Intents (1Click API) settlement: pay a worker in USDC out of a NEAR budget.
//
// The guard commits and spends an exact NEAR amount (EXACT_INPUT swap), so budget accounting
// never depends on the swap rate. The worker receives whatever USDC that NEAR buys.
//
// NEAR Intents has no testnet deployment. So:
//   testnet  -> a LIVE dry-run quote from 1Click (real price, nothing moves), then the NEAR is paid on testnet.
//               The receipt records what Intents would have delivered.
//   mainnet  -> with ALLOW_MAINNET=1 and INTENTS_EXECUTE=1: wrap NEAR, send wNEAR to the 1Click deposit
//               address, submit the deposit, poll until SUCCESS. The worker receives USDC on NEAR.

import { config } from "./config.js";

const ONECLICK = process.env.ONECLICK_API ?? "https://1click.chaindefuser.com";
export const WNEAR = "nep141:wrap.near";
export const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export interface IntentsQuote {
  dry: boolean;
  amountIn: string;
  amountInFormatted: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  depositAddress?: string;
  correlationId: string;
}

async function call(path: string, init?: RequestInit): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30_000);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (process.env.ONECLICK_API_KEY) headers["X-API-Key"] = process.env.ONECLICK_API_KEY;
    const r = await fetch(`${ONECLICK}${path}`, { ...init, headers, signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`1Click ${path} -> ${r.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

/** Quote: exactly `nearAmount` NEAR in, USDC out to `recipient`. */
export async function quoteNearToUsdc(nearAmount: number, recipient: string, refundTo: string, dry: boolean): Promise<IntentsQuote> {
  const { utils } = await import("near-api-js");
  const amount = utils.format.parseNearAmount(nearAmount.toFixed(6));
  const res = await call("/v0/quote", {
    method: "POST",
    body: JSON.stringify({
      dry,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100, // 1%
      originAsset: WNEAR,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: USDC_NEAR,
      amount,
      refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + 15 * 60_000).toISOString(),
    }),
  });
  const q = res.quote;
  return {
    dry,
    amountIn: q.amountIn,
    amountInFormatted: q.amountInFormatted,
    amountOutFormatted: q.amountOutFormatted,
    amountOutUsd: q.amountOutUsd,
    minAmountOut: q.minAmountOut,
    depositAddress: q.depositAddress,
    correlationId: res.correlationId,
  };
}

export const intentsEnabled = () => config.rail === "near" && process.env.USE_INTENTS !== "0";
export const intentsExecute = () =>
  config.network === "mainnet" && config.allowMainnet && process.env.INTENTS_EXECUTE === "1";

/** Mainnet only: deposit wNEAR to the 1Click deposit address and wait for the swap to settle. */
export async function executeOnMainnet(account: any, quote: IntentsQuote): Promise<{ depositTx: string; status: string }> {
  if (!intentsExecute()) throw new Error("Intents execution needs NEAR_NETWORK=mainnet, ALLOW_MAINNET=1 and INTENTS_EXECUTE=1");
  if (!quote.depositAddress) throw new Error("live quote has no deposit address");
  const amount = BigInt(quote.amountIn);
  // 1. wrap NEAR -> wNEAR
  await account.functionCall({ contractId: "wrap.near", methodName: "near_deposit", args: {}, gas: 30_000_000_000_000n, attachedDeposit: amount });
  // 2. make sure the deposit address can hold wNEAR
  const reg = await account.viewFunction({ contractId: "wrap.near", methodName: "storage_balance_of", args: { account_id: quote.depositAddress } });
  if (!reg) {
    await account.functionCall({
      contractId: "wrap.near", methodName: "storage_deposit", args: { account_id: quote.depositAddress, registration_only: true },
      gas: 30_000_000_000_000n, attachedDeposit: 1_250_000_000_000_000_000_000n,
    });
  }
  // 3. send wNEAR to the deposit address
  const out = await account.functionCall({
    contractId: "wrap.near", methodName: "ft_transfer", args: { receiver_id: quote.depositAddress, amount: amount.toString() },
    gas: 30_000_000_000_000n, attachedDeposit: 1n,
  });
  const depositTx = out.transaction_outcome.id as string;
  // 4. tell 1Click, then poll
  await call("/v0/deposit/submit", { method: "POST", body: JSON.stringify({ txHash: depositTx, depositAddress: quote.depositAddress }) }).catch(() => {});
  for (let i = 0; i < 60; i++) {
    const s = await call(`/v0/status?depositAddress=${encodeURIComponent(quote.depositAddress)}`);
    if (["SUCCESS", "REFUNDED", "FAILED"].includes(s.status)) return { depositTx, status: s.status };
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { depositTx, status: "PENDING (timed out waiting)" };
}
