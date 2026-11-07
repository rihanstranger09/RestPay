import { moneyToPayPal } from "../domain/money.js";
import type { Purchase, Transaction } from "../domain/types.js";

interface PayPalLink {
  rel?: string;
  href?: string;
}

interface PayPalOrder {
  id?: string;
  status?: string;
  links?: PayPalLink[];
  purchase_units?: Array<{
    reference_id?: string;
    amount?: { currency_code?: string; value?: string };
    payments?: { captures?: Array<{ id?: string; status?: string }> };
  }>;
}

export class PayPalError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "PayPalError";
  }
}

export class PayPalService {
  private accessToken?: { value: string; expiresAt: number };

  get configured(): boolean {
    return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
  }

  get environment(): "sandbox" {
    return "sandbox";
  }

  private get baseUrl(): string {
    return "https://api-m.sandbox.paypal.com";
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 30_000) {
      return this.accessToken.value;
    }
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new PayPalError("PayPal sandbox credentials are not configured.", 503);
    const response = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new PayPalError(`PayPal authentication failed (HTTP ${response.status}). Check sandbox credentials.`);
    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) throw new PayPalError("PayPal authentication returned no access token.");
    this.accessToken = {
      value: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 300) * 1000,
    };
    return payload.access_token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(25_000),
    });
    const payload = (await response.json().catch(() => ({}))) as T & {
      name?: string;
      message?: string;
      debug_id?: string;
    };
    if (!response.ok) {
      const detail = payload.message ? `: ${payload.message}` : "";
      const debug = payload.debug_id ? ` (debug ID ${payload.debug_id})` : "";
      throw new PayPalError(`PayPal API ${response.status}${detail}${debug}`);
    }
    return payload;
  }

  async createOrder(transaction: Transaction, baseUrl: string): Promise<{
    orderId: string;
    approvalUrl: string;
  }> {
    const purchase: Purchase = transaction.purchase;
    const order = await this.request<PayPalOrder>("/v2/checkout/orders", {
      method: "POST",
      headers: {
        "PayPal-Request-Id": `restpay-create-${transaction.id}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: transaction.reference,
            custom_id: transaction.id,
            description: purchase.item.slice(0, 127),
            soft_descriptor: "RESTPAY",
            amount: { currency_code: "USD", value: moneyToPayPal(purchase.amountCents) },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: "RESTPAY",
              locale: "en-US",
              landing_page: "LOGIN",
              shipping_preference: "NO_SHIPPING",
              user_action: "PAY_NOW",
              return_url: `${baseUrl}/paypal/return?transaction=${encodeURIComponent(transaction.id)}`,
              cancel_url: `${baseUrl}/paypal/cancel?transaction=${encodeURIComponent(transaction.id)}`,
            },
          },
        },
      }),
    });
    const approvalUrl = order.links?.find((link) => link.rel === "payer-action" || link.rel === "approve")?.href;
    if (!order.id || !approvalUrl) throw new PayPalError("PayPal created an incomplete order response.");
    return { orderId: order.id, approvalUrl };
  }

  async getOrder(orderId: string): Promise<PayPalOrder> {
    return this.request<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  async captureOrder(orderId: string, transaction: Transaction): Promise<{ captureId: string }> {
    const existing = await this.getOrder(orderId);
    if (existing.status !== "APPROVED" && existing.status !== "COMPLETED") {
      throw new PayPalError(`PayPal order is ${existing.status ?? "unknown"}, not APPROVED. Complete PayPal buyer approval first.`, 409);
    }
    const expectedAmount = moneyToPayPal(transaction.purchase.amountCents);
    const actualAmount = existing.purchase_units?.[0]?.amount?.value;
    const reference = existing.purchase_units?.[0]?.reference_id;
    if (actualAmount !== expectedAmount || reference !== transaction.reference) {
      throw new PayPalError("PayPal order amount or reference does not match the approved transaction. Capture refused.", 409);
    }
    if (existing.status === "COMPLETED") {
      const captureId = existing.purchase_units?.[0]?.payments?.captures?.[0]?.id;
      if (!captureId) throw new PayPalError("Completed PayPal order has no capture ID.");
      return { captureId };
    }
    const captured = await this.request<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: "POST",
      headers: { "PayPal-Request-Id": `restpay-capture-${transaction.id}`, Prefer: "return=representation" },
      body: "{}",
    });
    const capture = captured.purchase_units?.[0]?.payments?.captures?.[0];
    if (!capture || capture.status !== "COMPLETED" || !capture.id) {
      throw new PayPalError(`PayPal capture did not complete${capture?.status ? ` (status ${capture.status})` : ""}.`, 409);
    }
    return { captureId: capture.id };
  }

  async verifyWebhook(body: unknown, headers: Record<string, string | string[] | undefined>): Promise<boolean> {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    if (!webhookId || !this.configured) return false;
    const value = (name: string) => {
      const header = headers[name];
      return Array.isArray(header) ? header[0] : header;
    };
    const result = await this.request<{ verification_status?: string }>("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: JSON.stringify({
        transmission_id: value("paypal-transmission-id"),
        transmission_time: value("paypal-transmission-time"),
        cert_url: value("paypal-cert-url"),
        auth_algo: value("paypal-auth-algo"),
        transmission_sig: value("paypal-transmission-sig"),
        webhook_id: webhookId,
        webhook_event: body,
      }),
    });
    return result.verification_status === "SUCCESS";
  }
}
