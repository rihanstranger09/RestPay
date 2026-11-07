import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

test("agent, approval, and simulated PayPal capture journey", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "restpay-test-"));
  const previous = {
    data: process.env.DATA_FILE,
    client: process.env.PAYPAL_CLIENT_ID,
    secret: process.env.PAYPAL_CLIENT_SECRET,
    ai: process.env.AI_API_KEY,
  };
  process.env.DATA_FILE = path.join(directory, "state.json");
  delete process.env.PAYPAL_CLIENT_ID;
  delete process.env.PAYPAL_CLIENT_SECRET;
  delete process.env.AI_API_KEY;
  const { createApp } = await import("../src/app.js");
  const app = await createApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
    if (previous.data) process.env.DATA_FILE = previous.data; else delete process.env.DATA_FILE;
    if (previous.client) process.env.PAYPAL_CLIENT_ID = previous.client;
    if (previous.secret) process.env.PAYPAL_CLIENT_SECRET = previous.secret;
    if (previous.ai) process.env.AI_API_KEY = previous.ai;
  });
  const post = async (route: string, body: Record<string, unknown> = {}) => {
    const response = await fetch(`${base}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  };

  const blocked = await post("/api/agent/run", { requestText: "Buy studio wireless headphones" });
  assert.equal(blocked.transaction.status, "blocked");
  assert.equal(blocked.transaction.decision, "blocked");
  assert.equal(blocked.transaction.paypalOrderId, undefined);
  assert.ok(blocked.transaction.evaluation.reasons.some((reason: { outcome: string }) => reason.outcome === "violated"));

  const allowed = await post("/api/agent/run", { requestText: "Buy weekly groceries" });
  assert.equal(allowed.transaction.status, "awaiting_payment");
  assert.equal(allowed.transaction.decision, "allowed");
  assert.match(allowed.transaction.paypalOrderId, /^SIM-/);
  const paid = await post(`/api/transactions/${allowed.transaction.id}/simulate`);
  assert.equal(paid.transaction.status, "completed");
  assert.match(paid.transaction.paypalCaptureId, /^SIM-CAPTURE-/);

  const approval = await post("/api/agent/run", { requestText: "Buy the modern cookbook collection" });
  assert.equal(approval.transaction.status, "pending_approval");
  assert.equal(approval.transaction.paypalOrderId, undefined);
  const approved = await post(`/api/transactions/${approval.transaction.id}/approve`);
  assert.equal(approved.transaction.status, "awaiting_payment");
  assert.ok(approved.transaction.approvedAt);
  const deniedCandidate = await post("/api/agent/run", { requestText: "Buy the modern cookbook collection" });
  const denied = await post(`/api/transactions/${deniedCandidate.transaction.id}/deny`);
  assert.equal(denied.transaction.status, "denied");
  assert.equal(denied.transaction.paypalOrderId, undefined);

  const subscription = await post("/api/agent/run", { requestText: "Start my coffee subscription" });
  assert.equal(subscription.transaction.status, "blocked");
  assert.ok(subscription.transaction.evaluation.reasons.some((reason: { ruleType: string }) => reason.ruleType === "subscription_block"));

  const bootstrap = await fetch(`${base}/api/bootstrap`).then((response) => response.json());
  assert.equal(bootstrap.config.paypalMode, "simulation");
  assert.ok(bootstrap.transactions.length >= 8);
});
