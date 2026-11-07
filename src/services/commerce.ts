import { randomUUID } from "node:crypto";
import { getProduct, toPurchase } from "../data/catalog.js";
import { Store } from "../data/store.js";
import { evaluatePolicy } from "../domain/policy.js";
import type { Transaction } from "../domain/types.js";
import { planKnownProduct, planPurchase } from "./agent.js";
import { PayPalService } from "./paypal.js";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function required(transaction: Transaction | undefined): Transaction {
  if (!transaction) throw new HttpError(404, "Transaction not found.");
  return transaction;
}

export class CommerceService {
  constructor(
    private readonly store: Store,
    private readonly paypal: PayPalService,
  ) {}

  async runAgent(requestText: string, productId: string | undefined, baseUrl: string): Promise<Transaction> {
    const plan = productId
      ? planKnownProduct(requiredProduct(productId))
      : await planPurchase(requestText);
    const purchase = toPurchase(plan.product);
    const policy = this.store.getPolicy();
    const evaluation = evaluatePolicy(policy, purchase, this.store.getSpendingContext(purchase));
    const now = new Date().toISOString();
    const transaction: Transaction = {
      id: randomUUID(),
      reference: `RP-${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`,
      purchase,
      decision: evaluation.decision,
      evaluation,
      policySnapshot: policy,
      status:
        evaluation.decision === "blocked"
          ? "blocked"
          : evaluation.decision === "needs_approval"
            ? "pending_approval"
            : "processing",
      requestText: requestText || `Buy ${purchase.item}`,
      agentSource: plan.source,
      agentRationale: plan.rationale,
      createdAt: now,
      updatedAt: now,
      paymentMode: this.paypal.configured ? "paypal_sandbox" : "simulation",
    };
    await this.store.addTransaction(transaction);
    if (evaluation.decision === "allowed") return this.startPayment(transaction.id, baseUrl, false);
    return required(this.store.getTransaction(transaction.id));
  }

  private async startPayment(id: string, baseUrl: string, approvalGranted: boolean): Promise<Transaction> {
    let transaction = required(this.store.getTransaction(id));
    if (!["processing", "pending_approval"].includes(transaction.status)) {
      throw new HttpError(409, `Cannot start payment for a ${transaction.status} transaction.`);
    }
    const evaluation = evaluatePolicy(
      this.store.getPolicy(),
      transaction.purchase,
      this.store.getSpendingContext(transaction.purchase, id),
    );
    if (evaluation.decision === "blocked") {
      return this.store.updateTransaction(id, (item) => {
        item.status = "blocked";
        item.decision = "blocked";
        item.evaluation = evaluation;
        item.policySnapshot = this.store.getPolicy();
        item.failureReason = "Policy re-check blocked payment before a PayPal order was created.";
      });
    }
    if (evaluation.decision === "needs_approval" && !approvalGranted) {
      return this.store.updateTransaction(id, (item) => {
        item.status = "pending_approval";
        item.decision = "needs_approval";
        item.evaluation = evaluation;
      });
    }

    await this.store.updateTransaction(id, (item) => {
      item.status = "processing";
      item.decision = evaluation.decision;
      item.evaluation = evaluation;
      item.policySnapshot = this.store.getPolicy();
      delete item.failureReason;
    });

    if (!this.paypal.configured) {
      return this.store.updateTransaction(id, (item) => {
        item.status = "awaiting_payment";
        item.paymentMode = "simulation";
        item.paypalOrderId = `SIM-${item.reference}`;
        delete item.paypalApprovalUrl;
      });
    }

    try {
      const order = await this.paypal.createOrder(transaction, baseUrl.replace(/\/$/, ""));
      return await this.store.updateTransaction(id, (item) => {
        item.status = "awaiting_payment";
        item.paymentMode = "paypal_sandbox";
        item.paypalOrderId = order.orderId;
        item.paypalApprovalUrl = order.approvalUrl;
      });
    } catch (error) {
      await this.store.updateTransaction(id, (item) => {
        item.status = "failed";
        item.failureReason = error instanceof Error ? error.message : "PayPal order creation failed.";
      });
      throw error;
    }
  }

  async approve(id: string, baseUrl: string): Promise<Transaction> {
    const transaction = required(this.store.getTransaction(id));
    if (transaction.status !== "pending_approval") {
      throw new HttpError(409, "Only transactions awaiting human approval can be approved.");
    }
    const evaluation = evaluatePolicy(
      this.store.getPolicy(),
      transaction.purchase,
      this.store.getSpendingContext(transaction.purchase, id),
    );
    if (evaluation.decision === "blocked") {
      return this.store.updateTransaction(id, (item) => {
        item.status = "blocked";
        item.decision = "blocked";
        item.evaluation = evaluation;
        item.failureReason = "Approval failed the latest deterministic policy check.";
      });
    }
    await this.store.updateTransaction(id, (item) => {
      item.approvedAt = new Date().toISOString();
      item.status = "processing";
      item.decision = evaluation.decision;
      item.evaluation = evaluation;
      item.policySnapshot = this.store.getPolicy();
    });
    return this.startPayment(id, baseUrl, true);
  }

  async deny(id: string): Promise<Transaction> {
    const transaction = required(this.store.getTransaction(id));
    if (transaction.status !== "pending_approval") {
      throw new HttpError(409, "Only transactions awaiting human approval can be denied.");
    }
    return this.store.updateTransaction(id, (item) => {
      item.status = "denied";
      item.deniedAt = new Date().toISOString();
      item.failureReason = "Denied by the account owner. No PayPal order was created.";
    });
  }

  async cancel(id: string): Promise<Transaction> {
    const transaction = required(this.store.getTransaction(id));
    if (transaction.status !== "awaiting_payment") {
      throw new HttpError(409, "Only an awaiting-payment transaction can be cancelled.");
    }
    return this.store.updateTransaction(id, (item) => {
      item.status = "cancelled";
      item.failureReason = "Buyer cancelled before capture. No funds were collected.";
    });
  }

  async completeSimulatedPayment(id: string): Promise<Transaction> {
    const transaction = required(this.store.getTransaction(id));
    if (transaction.paymentMode !== "simulation") {
      throw new HttpError(409, "This transaction uses PayPal sandbox, not the simulator.");
    }
    return this.capture(id);
  }

  async capture(id: string): Promise<Transaction> {
    const transaction = required(this.store.getTransaction(id));
    if (transaction.status !== "awaiting_payment") {
      throw new HttpError(409, `Cannot capture a ${transaction.status} transaction.`);
    }
    await this.store.updateTransaction(id, (item) => {
      item.status = "processing";
    });

    // Last line of defence: policy and budget are checked again before capture.
    const evaluation = evaluatePolicy(
      this.store.getPolicy(),
      transaction.purchase,
      this.store.getSpendingContext(transaction.purchase, id),
    );
    if (evaluation.decision === "blocked") {
      return this.store.updateTransaction(id, (item) => {
        item.status = "blocked";
        item.decision = "blocked";
        item.evaluation = evaluation;
        item.failureReason = "Final pre-capture policy check blocked the transaction.";
      });
    }
    if (evaluation.decision === "needs_approval" && !transaction.approvedAt) {
      return this.store.updateTransaction(id, (item) => {
        item.status = "pending_approval";
        item.decision = "needs_approval";
        item.evaluation = evaluation;
        item.failureReason = "A policy change now requires explicit approval before capture.";
      });
    }

    if (transaction.paymentMode === "simulation") {
      return this.store.updateTransaction(id, (item) => {
        item.status = "completed";
        item.paypalCaptureId = `SIM-CAPTURE-${item.reference}`;
        item.decision = evaluation.decision;
        item.evaluation = evaluation;
        item.policySnapshot = this.store.getPolicy();
        delete item.failureReason;
      });
    }

    try {
      if (!transaction.paypalOrderId) throw new HttpError(409, "Transaction has no PayPal order ID.");
      const result = await this.paypal.captureOrder(transaction.paypalOrderId, transaction);
      return await this.store.updateTransaction(id, (item) => {
        item.status = "completed";
        item.paypalCaptureId = result.captureId;
        item.decision = evaluation.decision;
        item.evaluation = evaluation;
        item.policySnapshot = this.store.getPolicy();
        delete item.failureReason;
      });
    } catch (error) {
      await this.store.updateTransaction(id, (item) => {
        item.status = "awaiting_payment";
        item.failureReason = error instanceof Error ? error.message : "PayPal capture failed.";
      });
      throw error;
    }
  }

  async captureByOrderId(orderId: string): Promise<Transaction> {
    const transaction = required(this.store.getTransactionByPayPalOrder(orderId));
    return this.capture(transaction.id);
  }
}

function requiredProduct(productId: string) {
  const product = getProduct(productId);
  if (!product) throw new HttpError(400, "Unknown catalog product.");
  return product;
}
