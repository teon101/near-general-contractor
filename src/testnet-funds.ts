// Keeps the testnet contractor wallet funded, so testnet runs never stop on "top up the wallet first".
//   1. send from the root account created by `npm run setup:testnet`
//   2. if root is low too, create a throwaway account through the public testnet faucet and delete it
//      with the contractor as beneficiary, which moves its whole faucet balance to the contractor.
// TESTNET ONLY. Test NEAR has no value. Never runs on mainnet.

import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";

const FAUCETS = ["https://helper.nearprotocol.com/account", "https://helper.testnet.near.org/account"];

export async function ensureTestnetFunds(contractorId: string, needed: number, log: (m: string) => void = () => {}): Promise<number> {
  if (config.network !== "testnet") throw new Error("auto top-up is testnet only");
  const { connect, keyStores, KeyPair, utils } = await import("near-api-js");
  const keyStore = new keyStores.InMemoryKeyStore();
  const near = await connect({ networkId: "testnet", nodeUrl: config.nodeUrl, keyStore });
  const fmt = (y: string) => Number(utils.format.formatNearAmount(y, 4).replace(/,/g, ""));
  const yocto = (n: number) => BigInt(utils.format.parseNearAmount(n.toFixed(4))!);
  const balanceOf = async (id: string) => fmt((await (await near.account(id)).getAccountBalance()).available);

  let have = await balanceOf(contractorId);
  if (have >= needed) return have;
  const want = Math.ceil((needed - have + 1) * 100) / 100; // a little extra so the next run is fine too

  // 1. root account from setup:testnet
  if (existsSync(".testnet-keys.json")) {
    const root = JSON.parse(readFileSync(".testnet-keys.json", "utf8")).root;
    if (root?.accountId && root?.privateKey) {
      await keyStore.setKey("testnet", root.accountId, KeyPair.fromString(root.privateKey));
      const rootBal = await balanceOf(root.accountId);
      if (rootBal - 0.2 >= want) {
        await (await near.account(root.accountId)).sendMoney(contractorId, yocto(want));
        log(`auto top-up: sent ${want} test NEAR from ${root.accountId}`);
        return balanceOf(contractorId);
      }
    }
  }

  // 2. faucet: create throwaway accounts and sweep them into the contractor until there's enough
  for (let round = 0; round < 3 && have < needed; round++) {
    const id = `gc-tmp-${randomBytes(5).toString("hex")}.testnet`;
    const kp = KeyPair.fromRandom("ed25519");
    let ok = false;
    for (const url of FAUCETS) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }) });
        if (r.ok) { ok = true; break; }
      } catch { /* try next faucet */ }
    }
    if (!ok) throw new Error("testnet faucet unavailable; run `npm run topup` or fund the contractor wallet by hand");
    await keyStore.setKey("testnet", id, kp);
    for (let i = 0; i < 20; i++) { try { await balanceOf(id); break; } catch { await new Promise((r) => setTimeout(r, 1500)); } }
    await (await near.account(id)).deleteAccount(contractorId);
    have = await balanceOf(contractorId);
    log(`auto top-up: swept a faucet account into ${contractorId}, wallet now ${have} test NEAR`);
  }
  return have;
}
