import "dotenv/config";
import type { Transaction } from "../src/domain/types.js";

const baseUrl = (process.env.DEMO_BASE_URL ?? process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

async function post(route: string, body: Record<string, unknown> = {}): Promise<{ transaction: Transaction }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await response.json().catch(() => ({}))) as { transaction?: Transaction; error?: string };
  if (!response.ok || !data.transaction) {
    throw new Error(data.error ?? `RestPay returned HTTP ${response.status}.`);
  }
  return { transaction: data.transaction };
}

try {
  console.log(`\nRestPay sample purchase → ${baseUrl}`);
  const { transaction } = await post("/api/agent/run", {
    requestText: "Buy my weekly grocery basket",
    productId: "weekly-groceries",
  });

  console.log(`\n${transaction.purchase.item} · $${(transaction.purchase.amountCents / 100).toFixed(2)}`);
  console.log(`Decision: ${transaction.decision}; status: ${transaction.status}`);
  for (const reason of transaction.evaluation.reasons) {
    const symbol = reason.outcome === "violated" ? "✗" : reason.outcome === "approval" ? "!" : "✓";
    console.log(`  ${symbol} ${reason.title}: ${reason.detail}`);
  }

  if (transaction.status === "awaiting_payment" && transaction.paymentMode === "simulation") {
    const { transaction: completed } = await post(`/api/transactions/${transaction.id}/simulate`);
    console.log(`\nSample purchase completed: ${completed.status}`);
    console.log(`Receipt: ${completed.reference}`);
    console.log(`Simulated capture: ${completed.paypalCaptureId}`);
    console.log("Open the dashboard audit trail to inspect or download the full receipt.\n");
  } else if (transaction.status === "awaiting_payment") {
    console.log("\nPayPal sandbox order created. Open this hosted approval URL:");
    console.log(transaction.paypalApprovalUrl);
    console.log(`After approving, open transaction ${transaction.reference} in the dashboard and select “I've approved — capture”.\n`);
  } else {
    console.log("\nThe sample did not reach checkout. Run npm run seed while the server is stopped, restart, and try again.\n");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`\nSample purchase failed: ${error instanceof Error ? error.message : "unknown error"}`);
  console.error(`Ensure npm run dev is running at ${baseUrl}, then retry.\n`);
  process.exitCode = 1;
}
