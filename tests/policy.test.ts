import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePolicy } from "../src/domain/policy.js";
import { moneyToPayPal } from "../src/domain/money.js";
import type { Policy, Purchase, SpendingContext } from "../src/domain/types.js";

const purchase: Purchase = {
  productId: "test",
  item: "Groceries",
  merchant: "Test Market",
  category: "groceries",
  amountCents: 3000,
  recurring: false,
};
const spending: SpendingContext = { spentCents: 0, categorySpentCents: 0, reservedCents: 0, categoryReservedCents: 0 };
const makePolicy = (rules: Policy["rules"]): Policy => ({
  id: "policy",
  name: "Test mandate",
  sourceText: "Test",
  rules,
  parserSource: "local",
  createdAt: new Date().toISOString(),
});
const rule = (type: string, id = type) => ({ id, type, source: "Test" });

test("allows a purchase that passes every rule", () => {
  const policy = makePolicy([
    { ...rule("allowed_categories"), type: "allowed_categories", categories: ["groceries", "books"] },
    { ...rule("approval_threshold"), type: "approval_threshold", amountCents: 5000 },
    { ...rule("monthly_budget"), type: "monthly_budget", amountCents: 15000, category: "groceries" },
  ]);
  const result = evaluatePolicy(policy, purchase, spending);
  assert.equal(result.decision, "allowed");
  assert.ok(result.reasons.every((reason) => reason.outcome === "passed"));
});

test("pauses instead of blocking when only the approval threshold is crossed", () => {
  const policy = makePolicy([{ ...rule("approval_threshold"), type: "approval_threshold", amountCents: 5000 }]);
  const result = evaluatePolicy(policy, { ...purchase, amountCents: 8000 }, spending);
  assert.equal(result.decision, "needs_approval");
  assert.equal(result.reasons[0]?.outcome, "approval");
});

test("an exact approval threshold does not require approval", () => {
  const policy = makePolicy([{ ...rule("approval_threshold"), type: "approval_threshold", amountCents: 5000 }]);
  assert.equal(evaluatePolicy(policy, { ...purchase, amountCents: 5000 }, spending).decision, "allowed");
});

test("blocks a category outside the allowlist", () => {
  const policy = makePolicy([{ ...rule("allowed_categories"), type: "allowed_categories", categories: ["groceries"] }]);
  const result = evaluatePolicy(policy, { ...purchase, category: "electronics" }, spending);
  assert.equal(result.decision, "blocked");
  assert.match(result.summary, /not in your allowlist/);
});

test("a blocking rule wins even when approval is also required", () => {
  const policy = makePolicy([
    { ...rule("allowed_categories"), type: "allowed_categories", categories: ["books"] },
    { ...rule("approval_threshold"), type: "approval_threshold", amountCents: 1000 },
  ]);
  const result = evaluatePolicy(policy, purchase, spending);
  assert.equal(result.decision, "blocked");
  assert.ok(result.reasons.some((reason) => reason.outcome === "approval"));
});

test("monthly budget blocks the purchase that crosses the limit", () => {
  const policy = makePolicy([{ ...rule("monthly_budget"), type: "monthly_budget", amountCents: 15000 }]);
  const result = evaluatePolicy(policy, purchase, { ...spending, spentCents: 14000 });
  assert.equal(result.decision, "blocked");
  assert.match(result.summary, /exceed/);
});

test("monthly budget includes active reservations", () => {
  const policy = makePolicy([{ ...rule("monthly_budget"), type: "monthly_budget", amountCents: 15000 }]);
  const result = evaluatePolicy(policy, purchase, { ...spending, spentCents: 9000, reservedCents: 4000 });
  assert.equal(result.decision, "blocked");
});

test("a category-scoped budget does not restrict another category", () => {
  const policy = makePolicy([{ ...rule("monthly_budget"), type: "monthly_budget", amountCents: 15000, category: "groceries" }]);
  const result = evaluatePolicy(policy, { ...purchase, category: "books" }, { ...spending, spentCents: 100000 });
  assert.equal(result.decision, "allowed");
});

test("blocks recurring charges and identifies the subscription rule", () => {
  const policy = makePolicy([{ ...rule("subscription_block"), type: "subscription_block" }]);
  const result = evaluatePolicy(policy, { ...purchase, recurring: true }, spending);
  assert.equal(result.decision, "blocked");
  assert.equal(result.reasons[0]?.ruleType, "subscription_block");
});

test("blocks per-item amounts above the maximum", () => {
  const policy = makePolicy([{ ...rule("per_item_limit"), type: "per_item_limit", amountCents: 20000 }]);
  assert.equal(evaluatePolicy(policy, { ...purchase, amountCents: 20001 }, spending).decision, "blocked");
  assert.equal(evaluatePolicy(policy, { ...purchase, amountCents: 20000 }, spending).decision, "allowed");
});

test("fails closed with an empty mandate", () => {
  const result = evaluatePolicy(makePolicy([]), purchase, spending);
  assert.equal(result.decision, "blocked");
  assert.match(result.summary, /no active spending mandate/i);
});

test("formats PayPal amounts without floating point artifacts", () => {
  assert.equal(moneyToPayPal(4280), "42.80");
  assert.equal(moneyToPayPal(1), "0.01");
  assert.throws(() => moneyToPayPal(0));
});
