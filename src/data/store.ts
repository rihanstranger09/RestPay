import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluatePolicy } from "../domain/policy.js";
import { toPurchase } from "./catalog.js";
import { CATALOG } from "./catalog.js";
import { parseMandateLocally } from "../services/mandate.js";
import type { AppState, Policy, Purchase, SpendingContext, Transaction } from "../domain/types.js";

export const DEFAULT_MANDATE =
  "Only buy groceries and books. Groceries under $150 a month, no new subscriptions, ask me before anything over $50, and never spend more than $200 on one item.";

const ACTIVE_RESERVATIONS = new Set(["pending_approval", "awaiting_payment", "processing"]);

function isCurrentMonth(date: string, now = new Date()): boolean {
  const value = new Date(date);
  return value.getUTCFullYear() === now.getUTCFullYear() && value.getUTCMonth() === now.getUTCMonth();
}

function seedState(): AppState {
  const policy = parseMandateLocally(DEFAULT_MANDATE);
  const now = new Date();
  const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
  const receipt = (
    id: string,
    reference: string,
    productIndex: number,
    createdAt: string,
    amountCents?: number,
    itemName?: string,
  ): Transaction => {
    const product = CATALOG[productIndex];
    if (!product) throw new Error("Invalid seed catalog index.");
    const purchase = {
      ...toPurchase({ ...product, ...(amountCents ? { amountCents } : {}) }),
      ...(itemName ? { item: itemName } : {}),
    };
    return {
      id,
      reference,
      purchase,
      decision: "allowed",
      evaluation: evaluatePolicy(policy, purchase, {
        spentCents: 0,
        categorySpentCents: 0,
        reservedCents: 0,
        categoryReservedCents: 0,
      }),
      policySnapshot: policy,
      status: "completed",
      requestText: `Buy ${product.name}`,
      agentSource: "local",
      agentRationale: "Seeded demo receipt.",
      createdAt,
      updatedAt: createdAt,
      paypalOrderId: `DEMO-${reference}`,
      paypalCaptureId: `CAPTURE-${reference}`,
      paymentMode: "simulation",
    };
  };
  const first = receipt("demo-receipt-1", "RP-1048", 0, at(5), 4620);
  const second = receipt("demo-receipt-2", "RP-1051", 4, at(3));
  const third = receipt("demo-receipt-3", "RP-1054", 0, at(1), 2280, "Fresh produce top-up");
  return { policy, transactions: [third, second, first] };
}

export class Store {
  private constructor(
    private state: AppState,
    private readonly filePath: string,
  ) {}

  private writeChain: Promise<void> = Promise.resolve();

  static async open(): Promise<Store> {
    const filePath = path.resolve(process.env.DATA_FILE ?? "data/restpay.json");
    let state: AppState;
    try {
      state = JSON.parse(await readFile(filePath, "utf8")) as AppState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Could not read ${filePath}. Fix or remove the invalid data file.`, { cause: error });
      }
      state = seedState();
    }
    const store = new Store(state, filePath);
    await store.persist();
    return store;
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, this.filePath);
    });
    return this.writeChain;
  }

  getPolicy(): Policy {
    return structuredClone(this.state.policy);
  }

  async savePolicy(policy: Policy): Promise<void> {
    this.state.policy = structuredClone(policy);
    await this.persist();
  }

  listTransactions(): Transaction[] {
    return structuredClone(this.state.transactions).sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  }

  getTransaction(id: string): Transaction | undefined {
    const transaction = this.state.transactions.find((item) => item.id === id);
    return transaction ? structuredClone(transaction) : undefined;
  }

  getTransactionByPayPalOrder(orderId: string): Transaction | undefined {
    const transaction = this.state.transactions.find((item) => item.paypalOrderId === orderId);
    return transaction ? structuredClone(transaction) : undefined;
  }

  async addTransaction(transaction: Transaction): Promise<Transaction> {
    this.state.transactions.push(structuredClone(transaction));
    await this.persist();
    return structuredClone(transaction);
  }

  async updateTransaction(id: string, update: (transaction: Transaction) => void): Promise<Transaction> {
    const transaction = this.state.transactions.find((item) => item.id === id);
    if (!transaction) throw new Error("Transaction not found.");
    update(transaction);
    transaction.updatedAt = new Date().toISOString();
    await this.persist();
    return structuredClone(transaction);
  }

  getSpendingContext(purchase: Purchase, excludeTransactionId?: string): SpendingContext {
    const current = this.state.transactions.filter(
      (transaction) =>
        transaction.id !== excludeTransactionId && isCurrentMonth(transaction.createdAt),
    );
    const completed = current.filter((transaction) => transaction.status === "completed");
    const reserved = current.filter((transaction) => ACTIVE_RESERVATIONS.has(transaction.status));
    const sum = (transactions: Transaction[], categoryOnly: boolean) =>
      transactions
        .filter((transaction) => !categoryOnly || transaction.purchase.category === purchase.category)
        .reduce((total, transaction) => total + transaction.purchase.amountCents, 0);
    return {
      spentCents: sum(completed, false),
      categorySpentCents: sum(completed, true),
      reservedCents: sum(reserved, false),
      categoryReservedCents: sum(reserved, true),
    };
  }
}
