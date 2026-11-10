// Top up the contractor wallet from the root testnet account created by setup:testnet.
//   npm run topup            -> sends 2 NEAR
//   npm run topup -- 3.5     -> sends 3.5 NEAR
// Testnet only. Uses the root key saved in .testnet-keys.json.

import { existsSync, readFileSync } from "node:fs";
import { connect, keyStores, KeyPair, utils } from "near-api-js";

if (existsSync(".env")) process.loadEnvFile(".env");
const amount = Number(process.argv[2] ?? "2");
if (!(amount > 0)) throw new Error("amount must be a positive number");
if ((process.env.NEAR_NETWORK ?? "testnet") !== "testnet") throw new Error("topup is testnet only");
if (!existsSync(".testnet-keys.json")) throw new Error("no .testnet-keys.json; run npm run setup:testnet first");

const keys = JSON.parse(readFileSync(".testnet-keys.json", "utf8"));
const root = keys.root;
const contractorId = process.env.CONTRACTOR_ACCOUNT_ID;
if (!root?.accountId || !root?.privateKey) throw new Error("no root key in .testnet-keys.json (setup used your own account; top up from your wallet instead)");
if (!contractorId) throw new Error("CONTRACTOR_ACCOUNT_ID not set in .env");

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey("testnet", root.accountId, KeyPair.fromString(root.privateKey));
const near = await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org", keyStore });
const acct = await near.account(root.accountId);

const fmt = (y: string) => Number(utils.format.formatNearAmount(y, 4).replace(/,/g, ""));
const rootBal = fmt((await acct.getAccountBalance()).available);
if (rootBal - 0.1 < amount) throw new Error(`root ${root.accountId} only has ${rootBal} NEAR available`);

await acct.sendMoney(contractorId, BigInt(utils.format.parseNearAmount(amount.toFixed(4))!));
const after = fmt((await (await near.account(contractorId)).getAccountBalance()).available);
console.log(`sent ${amount} NEAR from ${root.accountId} to ${contractorId}`);
console.log(`contractor wallet now holds ${after} NEAR (root has ${Math.round((rootBal - amount) * 1e4) / 1e4} left)`);
