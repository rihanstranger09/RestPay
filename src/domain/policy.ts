import { formatMoney } from "./money.js";
import type {
  Evaluation,
  Policy,
  PolicyReason,
  PolicyRule,
  Purchase,
  SpendingContext,
} from "./types.js";

function passed(rule: PolicyRule, title: string, detail: string): PolicyReason {
  return { ruleId: rule.id, ruleType: rule.type, title, detail, outcome: "passed" };
}

function violated(rule: PolicyRule, title: string, detail: string): PolicyReason {
  return { ruleId: rule.id, ruleType: rule.type, title, detail, outcome: "violated" };
}

/**
 * Deterministic, side-effect-free policy evaluation.
 * Blocking rules always win over approval and allowance rules.
 */
export function evaluatePolicy(
  policy: Policy,
  purchase: Purchase,
  spending: SpendingContext,
): Evaluation {
  if (policy.rules.length === 0) {
    return {
      decision: "blocked",
      summary: "Blocked because no active spending mandate exists.",
      reasons: [
        {
          ruleId: "mandate",
          ruleType: "mandate",
          title: "No active mandate",
          detail: "RestPay fails closed: add at least one explicit rule before delegating purchases.",
          outcome: "violated",
        },
      ],
    };
  }

  const reasons: PolicyReason[] = [];

  for (const rule of policy.rules) {
    switch (rule.type) {
      case "allowed_categories": {
        const allowed = rule.categories.includes(purchase.category);
        reasons.push(
          allowed
            ? passed(
                rule,
                "Category permitted",
                `${purchase.category} is in your ${rule.categories.join(", ")} allowlist.`,
              )
            : violated(
                rule,
                "Category not permitted",
                `${purchase.category} is not in your allowlist (${rule.categories.join(", ")}).`,
              ),
        );
        break;
      }
      case "subscription_block": {
        reasons.push(
          purchase.recurring
            ? violated(
                rule,
                "Recurring charge blocked",
                "This purchase starts a subscription, and your mandate prohibits new subscriptions.",
              )
            : passed(rule, "One-time purchase", "This purchase does not create a recurring charge."),
        );
        break;
      }
      case "per_item_limit": {
        const withinLimit = purchase.amountCents <= rule.amountCents;
        reasons.push(
          withinLimit
            ? passed(
                rule,
                "Within per-item limit",
                `${formatMoney(purchase.amountCents)} is at or below your ${formatMoney(rule.amountCents)} per-item limit.`,
              )
            : violated(
                rule,
                "Per-item limit exceeded",
                `${formatMoney(purchase.amountCents)} exceeds your ${formatMoney(rule.amountCents)} per-item limit.`,
              ),
        );
        break;
      }
      case "monthly_budget": {
        const sameScope = !rule.category || rule.category === purchase.category;
        if (!sameScope) {
          reasons.push(
            passed(
              rule,
              "Budget not applicable",
              `This ${formatMoney(rule.amountCents)} budget applies only to ${rule.category}.`,
            ),
          );
          break;
        }
        const spent = rule.category ? spending.categorySpentCents : spending.spentCents;
        const reserved = rule.category ? spending.categoryReservedCents : spending.reservedCents;
        const projected = spent + reserved + purchase.amountCents;
        const withinBudget = projected <= rule.amountCents;
        const scope = rule.category ? `${rule.category} ` : "monthly ";
        reasons.push(
          withinBudget
            ? passed(
                rule,
                "Within monthly budget",
                `${formatMoney(projected)} projected against your ${formatMoney(rule.amountCents)} ${scope}budget, including active reservations.`,
              )
            : violated(
                rule,
                "Monthly budget exceeded",
                `${formatMoney(projected)} projected would exceed your ${formatMoney(rule.amountCents)} ${scope}budget by ${formatMoney(projected - rule.amountCents)}.`,
              ),
        );
        break;
      }
      case "approval_threshold": {
        const needsApproval = purchase.amountCents > rule.amountCents;
        reasons.push({
          ruleId: rule.id,
          ruleType: rule.type,
          title: needsApproval ? "Human approval required" : "Below approval threshold",
          detail: needsApproval
            ? `${formatMoney(purchase.amountCents)} is over your ${formatMoney(rule.amountCents)} approval threshold.`
            : `${formatMoney(purchase.amountCents)} is not over your ${formatMoney(rule.amountCents)} approval threshold.`,
          outcome: needsApproval ? "approval" : "passed",
        });
        break;
      }
    }
  }

  const violations = reasons.filter((reason) => reason.outcome === "violated");
  if (violations.length > 0) {
    return {
      decision: "blocked",
      summary: violations[0]?.detail ?? "Blocked by your spending mandate.",
      reasons,
    };
  }

  if (reasons.some((reason) => reason.outcome === "approval")) {
    return {
      decision: "needs_approval",
      summary: "Paused. Your explicit approval is required before a PayPal order can be created.",
      reasons,
    };
  }

  return {
    decision: "allowed",
    summary: `All ${policy.rules.length} policy checks passed. The purchase may proceed to PayPal.`,
    reasons,
  };
}
