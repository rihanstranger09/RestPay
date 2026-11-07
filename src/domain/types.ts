export const CATEGORIES = [
  "groceries",
  "books",
  "electronics",
  "coffee",
  "fashion",
  "beauty",
  "home",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];
export type Decision = "allowed" | "needs_approval" | "blocked";
export type ParserSource = "ai" | "local";

interface BaseRule {
  id: string;
  source: string;
}

export interface AllowedCategoriesRule extends BaseRule {
  type: "allowed_categories";
  categories: Category[];
}

export interface PerItemLimitRule extends BaseRule {
  type: "per_item_limit";
  amountCents: number;
}

export interface MonthlyBudgetRule extends BaseRule {
  type: "monthly_budget";
  amountCents: number;
  category?: Category;
}

export interface ApprovalThresholdRule extends BaseRule {
  type: "approval_threshold";
  amountCents: number;
}

export interface SubscriptionBlockRule extends BaseRule {
  type: "subscription_block";
}

export type PolicyRule =
  | AllowedCategoriesRule
  | PerItemLimitRule
  | MonthlyBudgetRule
  | ApprovalThresholdRule
  | SubscriptionBlockRule;

export interface Policy {
  id: string;
  name: string;
  sourceText: string;
  rules: PolicyRule[];
  parserSource: ParserSource;
  createdAt: string;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  merchant: string;
  category: Category;
  amountCents: number;
  recurring: boolean;
  image: string;
  accent: string;
  badge: string;
  aliases: string[];
}

export interface Purchase {
  productId: string;
  item: string;
  merchant: string;
  category: Category;
  amountCents: number;
  recurring: boolean;
}

export interface PolicyReason {
  ruleId: string;
  ruleType: PolicyRule["type"] | "mandate";
  title: string;
  detail: string;
  outcome: "passed" | "violated" | "approval";
}

export interface Evaluation {
  decision: Decision;
  summary: string;
  reasons: PolicyReason[];
}

export type TransactionStatus =
  | "blocked"
  | "pending_approval"
  | "awaiting_payment"
  | "processing"
  | "completed"
  | "denied"
  | "cancelled"
  | "failed";

export interface Transaction {
  id: string;
  reference: string;
  purchase: Purchase;
  decision: Decision;
  evaluation: Evaluation;
  policySnapshot: Policy;
  status: TransactionStatus;
  requestText: string;
  agentSource: ParserSource;
  agentRationale: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  deniedAt?: string;
  paypalOrderId?: string;
  paypalCaptureId?: string;
  paypalApprovalUrl?: string;
  paymentMode: "paypal_sandbox" | "simulation";
  failureReason?: string;
}

export interface AgentPlan {
  product: Product;
  rationale: string;
  source: ParserSource;
}

export interface SpendingContext {
  spentCents: number;
  categorySpentCents: number;
  reservedCents: number;
  categoryReservedCents: number;
}

export interface AppState {
  policy: Policy;
  transactions: Transaction[];
}
