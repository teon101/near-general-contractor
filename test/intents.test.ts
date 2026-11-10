// Checks the 1Click quote request we send and how we read the reply, against a fake 1Click server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

test("NEAR Intents quote: EXACT_INPUT wNEAR -> USDC with the exact NEAR amount", async () => {
  let got: any = null;
  const srv = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    got = { url: req.url, body: JSON.parse(body) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      correlationId: "abc-123", timestamp: "", signature: "", quoteRequest: got.body,
      quote: { amountIn: got.body.amount, amountInFormatted: "0.397", amountInUsd: "0.94", minAmountIn: got.body.amount,
        amountOut: "935000", amountOutFormatted: "0.935", amountOutUsd: "0.935", minAmountOut: "925650", timeEstimate: 10 },
    }));
  });
  await new Promise<void>((r) => srv.listen(4499, "127.0.0.1", () => r()));
  process.env.ONECLICK_API = "http://127.0.0.1:4499";
  try {
    const { quoteNearToUsdc, WNEAR, USDC_NEAR } = await import("../src/intents.js");
    const q = await quoteNearToUsdc(0.397, "chartsmith.near", "contractor.near", true);
    assert.equal(got.url, "/v0/quote");
    assert.equal(got.body.dry, true);
    assert.equal(got.body.swapType, "EXACT_INPUT");
    assert.equal(got.body.originAsset, WNEAR);
    assert.equal(got.body.destinationAsset, USDC_NEAR);
    assert.equal(got.body.amount, "397000000000000000000000"); // 0.397 NEAR in yocto
    assert.equal(got.body.recipient, "chartsmith.near");
    assert.equal(q.amountOutFormatted, "0.935");
    assert.equal(q.correlationId, "abc-123");
  } finally {
    srv.close();
  }
});
