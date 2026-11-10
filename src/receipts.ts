// Receipts: one line per attempt (what was bought, from whom, at what price, did it pass the check).

import type { Plan, ReceiptLine, Token } from "./types.js";

const money = (n: number | null, t: Token) => (n === null ? "-" : `${n} ${t}`);

export function receiptsMarkdown(runId: string, plan: Plan, lines: ReceiptLine[], spent: number, rail: string): string {
  const t = plan.token;
  const rows = lines.map((l) =>
    `| ${l.subtask} | ${l.from} | ${money(l.quoted, t)} | ${money(l.countered, t)} | ${money(l.agreed, t)} | ${money(l.paid, t)} | ${l.checkPassed === null ? "-" : l.checkPassed ? "PASS" : "FAIL"} | ${l.outcome.replace(/_/g, " ")} | ${l.explorerUrl ? `[tx](${l.explorerUrl})` : l.txHash ?? "-"} |`,
  );
  const details = lines.map((l, i) =>
    `### ${i + 1}. ${l.subtask} (${l.from})\n\n- What: ${l.what}\n- Payee: ${l.payee ?? "-"}\n- Outcome: ${l.outcome.replace(/_/g, " ")}\n- Check: ${l.checkNotes.join("; ") || "-"}\n${l.settlement ? `- Settlement: ${l.settlement}\n` : ""}${l.negotiation.length ? `- Negotiation:\n${l.negotiation.map((n) => `  - ${n}`).join("\n")}\n` : ""}- Time: ${l.at}\n`,
  );
  return `# Receipts for run ${runId}

**Task:** ${plan.task}
**Budget:** ${plan.budget} ${t} (contingency held back: ${plan.contingency} ${t})
**Spent:** ${spent} ${t}  |  **Left:** ${Math.round((plan.budget - spent) * 1e6) / 1e6} ${t}
**Payment rail:** ${rail}
**Planning prices from:** ${plan.priceSource}

| Part | From | Quoted | Countered | Agreed | Paid | Check | Outcome | Tx |
|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}

${details.join("\n")}`;
}
