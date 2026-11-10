// Tests the AI brain path against a fake OpenAI-compatible server, so it runs offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { config } from "../src/config.js";
import { validateAiPlan } from "../src/planner.js";
import { runContractor } from "../src/contractor.js";
import { SimulatedRail } from "../src/payments.js";
import { startAllWorkers } from "../src/workers/server.js";

test("AI plan validation rejects bad plans", () => {
  assert.throws(() => validateAiPlan({ parts: [{ skill: "chart", title: "chart" }] }), /need a data part/);
  assert.throws(() => validateAiPlan({ parts: [{ skill: "hack", title: "hack it" }] }), /unknown skill/);
  assert.throws(() => validateAiPlan({ asset: null, parts: [{ skill: "data", title: "data" }] }), /needs an asset/);
  assert.throws(() => validateAiPlan({ asset: "near", parts: [{ skill: "chart", title: "chart" }, { skill: "data", title: "data" }] }), /before/);
  const ok = validateAiPlan({ asset: "near", parts: [{ skill: "data", title: "data" }, { skill: "general", title: "Thread", acceptance: "5 tweets under 280 chars each" }] });
  assert.equal(ok.parts[1].acceptance, "5 tweets under 280 chars each");
});

function fakeLlm(port: number) {
  const general = "## Launch thread\n\n" + Array.from({ length: 5 }, (_, i) => `${i + 1}/ NEAR moved this week and here is a specific, usable point number ${i + 1} about price action and what to watch next.`).join("\n\n");
  return new Promise<() => void>((resolve) => {
    const srv = createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/models") return res.end(JSON.stringify({ data: [{ id: "z-ai/glm-5.2" }] }));
      const msgs = JSON.parse(body).messages as { content: string }[];
      const sys = msgs[0].content;
      const user = msgs[msgs.length - 1].content;
      let content = "";
      if (sys.includes("planning brain")) {
        content = JSON.stringify({ asset: "near", parts: [
          { skill: "data", title: "Get NEAR prices", why: "everything else needs the numbers" },
          { skill: "chart", title: "Chart", why: "the user asked for a chart" },
          { skill: "writeup", title: "Brief", why: "the user asked for a brief" },
          { skill: "general", title: "Write a 5-tweet launch thread", acceptance: "5 numbered tweets, each under 280 characters", why: "the user asked for a thread" },
        ] });
      } else if (sys.includes("negotiate")) {
        const counter = user.match(/Our counter \(exact\): ([0-9.]+)/)![1];
        content = `I can offer ${counter} because that is what similar work costs on the Agent Market. Payment is released when the work passes my check.`;
      } else if (sys.includes("strict reviewer")) {
        content = '```json\n{"pass": true, "reasons": ["5 numbered tweets, all short"]}\n```';
      } else if (sys.includes("market briefs")) {
        const last = user.match(/Latest price: \$([0-9.]+)/)![1];
        content = `# NEAR weekly brief\n\nNEAR ended the week at $${last}. ` + "This brief covers the price action over the last seven days in plain terms. ".repeat(12);
      } else {
        content = general;
      }
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
    srv.listen(port, "127.0.0.1", () => resolve(() => srv.close()));
  });
}

test("end to end with the AI brain: plans a general part, AI counters, AI judge passes it", async () => {
  const stopLlm = await fakeLlm(4399);
  const saved = { ...config };
  Object.assign(config, { llmApiKey: "test", llmBaseUrl: "http://127.0.0.1:4399", useLiveMarket: false, outDir: "/tmp/gc-brain-test" });
  const { workers, stop } = await startAllWorkers(4380);
  try {
    const logs: string[] = [];
    const res = await runContractor({
      task: "NEAR brief with a price chart and a launch thread", budget: 1, token: "USDC", workers,
      rail: new SimulatedRail("USDC", 1), log: (m) => logs.push(m),
    });
    assert.match(res.plan.brain, /NEAR AI Cloud \(z-ai\/glm-5.2\)/);
    assert.equal(res.plan.subtasks.length, 4);
    assert.equal(res.plan.subtasks[3].mode, "self");
    const general = res.receipts.find((r) => r.subtaskId === "t4")!;
    assert.equal(general.outcome, "done_in_house");
    assert.equal(general.checkPassed, true);
    assert.ok(logs.some((l) => l.includes("message by AI")), "counter message should come from the AI");
    assert.ok(res.spent <= 1);
  } finally {
    stop();
    stopLlm();
    Object.assign(config, saved);
  }
});
