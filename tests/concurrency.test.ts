import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../src/data/store.js";
import { CommerceService, HttpError } from "../src/services/commerce.js";
import { PayPalService } from "../src/services/paypal.js";

test("only one concurrent capture can claim a transaction", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "restpay-concurrency-"));
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
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    if (previous.data) process.env.DATA_FILE = previous.data; else delete process.env.DATA_FILE;
    if (previous.client) process.env.PAYPAL_CLIENT_ID = previous.client;
    if (previous.secret) process.env.PAYPAL_CLIENT_SECRET = previous.secret;
    if (previous.ai) process.env.AI_API_KEY = previous.ai;
  });

  const store = await Store.open();
  const commerce = new CommerceService(store, new PayPalService());
  const transaction = await commerce.runAgent("Buy the design book", undefined, "http://localhost:3000");
  assert.equal(transaction.status, "awaiting_payment");

  const results = await Promise.allSettled([
    commerce.capture(transaction.id),
    commerce.capture(transaction.id),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(fulfilled[0]?.value.status, "completed");
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]?.reason instanceof HttpError);
  assert.equal((rejected[0]?.reason as HttpError).status, 409);
  assert.equal(store.getTransaction(transaction.id)?.status, "completed");
});
