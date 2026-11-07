import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MANDATE } from "../src/data/store.js";
import { parseMandateLocally } from "../src/services/mandate.js";
import { planPurchase } from "../src/services/agent.js";

test("compiles the default plain-English mandate into five structured rules", () => {
  const policy = parseMandateLocally(DEFAULT_MANDATE);
  assert.equal(policy.rules.length, 5);
  assert.deepEqual(policy.rules.map((rule) => rule.type), [
    "allowed_categories",
    "monthly_budget",
    "approval_threshold",
    "per_item_limit",
    "subscription_block",
  ]);
  const budget = policy.rules.find((rule) => rule.type === "monthly_budget");
  assert.equal(budget?.amountCents, 15000);
  assert.equal(budget?.category, "groceries");
});

test("parses decimal currency into exact cents", () => {
  const policy = parseMandateLocally("Ask me before anything over $25.50");
  assert.equal(policy.rules[0]?.type, "approval_threshold");
  assert.equal(policy.rules[0]?.amountCents, 2550);
});

test("rejects prose with no recognized rule instead of inventing one", () => {
  assert.throws(() => parseMandateLocally("Buy nice things whenever you want"), /No rules recognized/);
});

test("matches agent requests to verified catalog products", async () => {
  const headphones = await planPurchase("Please buy noise cancelling headphones");
  assert.equal(headphones.product.id, "wireless-headphones");
  assert.equal(headphones.product.amountCents, 8999);
  const coffee = await planPurchase("Start my monthly coffee subscription");
  assert.equal(coffee.product.id, "coffee-subscription");
  assert.equal(coffee.product.recurring, true);
});
