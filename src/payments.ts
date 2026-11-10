// Payment rails. This is the ONLY file that reads a private key.
// The key comes from the environment (CONTRACTOR_PRIVATE_KEY), stays in memory here,
// and is never logged, returned, written to receipts, or shown to an LLM.

import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import type { PayOptions, PaymentResult, Token } from "./types.js";
import { executeOnMainnet, intentsEnabled, intentsExecute, quoteNearToUsdc } from "./intents.js";

export interface PaymentRail {
  name: string;
  token: Token;
  /** Spendable balance of the contractor wallet, in whole tokens. */
  balance(): Promise<number>;
  pay(payee: string, amount: number, memo: string, opts?: PayOptions): Promise<PaymentResult>;
}

/** No chain. Fake transaction hashes, balances kept in memory. Default so anyone can run the demo. */
export class SimulatedRail implements PaymentRail {
  name = "simulate";
  private bal: number;
  readonly paid: { payee: string; amount: number; memo: string; txHash: string }[] = [];
  constructor(readonly token: Token, startingBalance: number) {
    this.bal = startingBalance;
  }
  async balance() { return this.bal; }
  async pay(payee: string, amount: number, memo: string): Promise<PaymentResult> {
    if (amount > this.bal + 1e-9) throw new Error("simulated wallet: insufficient balance");
    this.bal = Math.round((this.bal - amount) * 1e6) / 1e6;
    const txHash = `sim_${randomBytes(16).toString("hex")}`;
    this.paid.push({ payee, amount, memo, txHash });
    return { txHash, rail: this.name };
  }
}

function explorer(txHash: string) {
  const base = config.network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
  return `${base}/txns/${txHash}`;
}

export async function loadAccount() {
  if (config.network === "mainnet" && !config.allowMainnet) {
    throw new Error("Refusing to use mainnet. Set ALLOW_MAINNET=1 if you really mean it.");
  }
  const key = process.env.CONTRACTOR_PRIVATE_KEY;
  if (!key || !process.env.CONTRACTOR_ACCOUNT_ID) {
    throw new Error("CONTRACTOR_ACCOUNT_ID and CONTRACTOR_PRIVATE_KEY must be set for on-chain rails (see .env.example)");
  }
  const { connect, keyStores, KeyPair } = await import("near-api-js");
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(config.network, config.contractorAccountId, KeyPair.fromString(key as `ed25519:${string}`));
  const near = await connect({ networkId: config.network, nodeUrl: config.nodeUrl, keyStore });
  return near.account(config.contractorAccountId);
}

/** Native NEAR transfers from the contractor's own sub-account. */
export class NearRail implements PaymentRail {
  name = "near";
  token: Token = "NEAR";
  private account: Awaited<ReturnType<typeof loadAccount>> | null = null;
  private async acct() { return (this.account ??= await loadAccount()); }

  async balance() {
    const { utils } = await import("near-api-js");
    const b = await (await this.acct()).getAccountBalance();
    return Number(utils.format.formatNearAmount(b.available, 6).replace(/,/g, ""));
  }

  async pay(payee: string, amount: number, _memo: string, opts?: PayOptions): Promise<PaymentResult> {
    const { utils } = await import("near-api-js");
    const yocto = utils.format.parseNearAmount(amount.toFixed(6));
    if (!yocto) throw new Error(`bad amount ${amount}`);

    if (opts?.settleIn === "USDC" && intentsEnabled()) {
      if (intentsExecute()) {
        // Mainnet: real swap. EXACT_INPUT, so exactly `amount` NEAR leaves the wallet.
        const q = await quoteNearToUsdc(amount, payee, config.contractorAccountId, false);
        const res = await executeOnMainnet(await this.acct(), q);
        if (res.status !== "SUCCESS") throw new Error(`NEAR Intents swap ${res.status} (deposit tx ${res.depositTx})`);
        return {
          txHash: res.depositTx, rail: "near+intents", explorerUrl: explorer(res.depositTx),
          settlement: `${amount} NEAR swapped to ${q.amountOutFormatted} USDC for ${payee} via NEAR Intents (1Click ${q.correlationId})`,
        };
      }
      // Testnet: NEAR Intents is mainnet-only. Get a live dry-run quote, then settle in NEAR on testnet.
      let settlement: string;
      try {
        const q = await quoteNearToUsdc(amount, "intents.near", "intents.near", true);
        settlement = `NEAR Intents live quote: ${q.amountInFormatted} NEAR -> ${q.amountOutFormatted} USDC ($${Number(q.amountOutUsd).toFixed(2)}). Dry run, because Intents is mainnet-only; paid in NEAR on testnet.`;
      } catch (e) {
        settlement = `NEAR Intents quote failed (${(e as Error).message.slice(0, 100)}); paid in NEAR on testnet.`;
      }
      const out = await (await this.acct()).sendMoney(payee, BigInt(yocto));
      const txHash = out.transaction_outcome.id;
      return { txHash, rail: this.name, explorerUrl: explorer(txHash), settlement };
    }

    const out = await (await this.acct()).sendMoney(payee, BigInt(yocto));
    const txHash = out.transaction_outcome.id;
    return { txHash, rail: this.name, explorerUrl: explorer(txHash) };
  }
}

/** USDC (NEP-141) transfers. Registers the payee for token storage first if needed. */
export class UsdcRail implements PaymentRail {
  name = "usdc";
  token: Token = "USDC";
  private account: Awaited<ReturnType<typeof loadAccount>> | null = null;
  private async acct() { return (this.account ??= await loadAccount()); }
  private units(amount: number) {
    return BigInt(Math.round(amount * 10 ** config.usdcDecimals)).toString();
  }

  async balance() {
    const raw: string = await (await this.acct()).viewFunction({
      contractId: config.usdcContract,
      methodName: "ft_balance_of",
      args: { account_id: config.contractorAccountId },
    });
    return Number(raw) / 10 ** config.usdcDecimals;
  }

  async pay(payee: string, amount: number, memo: string): Promise<PaymentResult> {
    const acct = await this.acct();
    const reg = await acct.viewFunction({
      contractId: config.usdcContract,
      methodName: "storage_balance_of",
      args: { account_id: payee },
    });
    if (!reg) {
      await acct.functionCall({
        contractId: config.usdcContract,
        methodName: "storage_deposit",
        args: { account_id: payee, registration_only: true },
        gas: 30_000_000_000_000n,
        attachedDeposit: 1_250_000_000_000_000_000_000n, // 0.00125 NEAR
      });
    }
    const out = await acct.functionCall({
      contractId: config.usdcContract,
      methodName: "ft_transfer",
      args: { receiver_id: payee, amount: this.units(amount), memo: memo.slice(0, 120) },
      gas: 30_000_000_000_000n,
      attachedDeposit: 1n, // NEP-141 requires exactly 1 yoctoNEAR
    });
    const txHash = out.transaction_outcome.id;
    return { txHash, rail: this.name, explorerUrl: explorer(txHash) };
  }
}

export function makeRail(token: Token, budget: number): PaymentRail {
  switch (config.rail) {
    case "near": return new NearRail();
    case "usdc": return new UsdcRail();
    default: return new SimulatedRail(token, budget);
  }
}
