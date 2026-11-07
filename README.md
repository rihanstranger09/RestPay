# RestPay

**Your agent. Your rules. Every payment explained.**

RestPay is a policy-enforced AI purchasing agent with PayPal sandbox checkout. It turns a plain-language spending mandate into structured rules, checks every proposed purchase deterministically, pauses for human approval when needed, and creates an explainable receipt for every decision.

> The core trust boundary is simple: **AI can propose a purchase, but it cannot authorize money movement.** Only deterministic policy code and the account owner can do that.

## Why this demo works

- **A visible “no”**: ask for headphones under a groceries-and-books mandate. RestPay blocks the purchase before a PayPal order exists.
- **A real human-in-the-loop**: the $58 cookbook collection pauses at the default $50 approval threshold. Deny it or approve it and continue to checkout.
- **A complete happy path**: delegate the $42.80 grocery basket, approve in the checkout simulator or PayPal sandbox, and inspect the capture receipt.
- **A second memorable block**: the specialty coffee subscription violates the no-new-subscriptions rule.
- **Receipts, not vibes**: every row in the audit trail includes the complete policy snapshot and each passed, failed, or approval-triggering rule.

## Quick start

Requires Node.js 20 or later.

```bash
npm install
npm run seed
npm run dev
```

Open **http://localhost:3000**. No credentials are required for the simulator demo. The app starts with a default mandate and three seeded sandbox receipts.

`npm run seed` creates the gitignored `data/restpay.json` ledger. The app also auto-seeds when that file is absent. To reset a used demo, **stop the server**, run `npm run seed`, then restart; this replaces the ledger with the original three receipts.

### Run one sample purchase from the command line

With the server running, open a second terminal:

```bash
npm run demo:purchase
```

This command asks the running app for the $42.80 weekly grocery basket and prints every policy check. In simulator mode it also completes the simulated PayPal approval/capture and prints the receipt and capture IDs. With real sandbox credentials it creates a PayPal order and prints the hosted buyer-approval URL. Set `DEMO_BASE_URL` if the server is not at `http://localhost:3000`.

```bash
npm run check   # TypeScript validation + 18 automated tests
npm start       # Run without the file watcher
```

## Key demo scenarios

Use the default mandate for all three required paths:

| Scenario | Request to run | Expected result |
| --- | --- | --- |
| **Within the limit** | `Buy my weekly grocery basket` | **Allowed.** The $42.80 purchase passes all five checks and proceeds to PayPal. The sample CLI completes it automatically in simulator mode. |
| **Over the approval threshold** | `Buy the modern cookbook collection` | **Needs approval.** The $58 book crosses the $50 threshold and waits in **Waiting on you**. No PayPal order exists until a human approves. |
| **Policy rejects the purchase** | `Buy the studio wireless headphones` | **Blocked.** Electronics are outside the groceries-and-books allowlist. No PayPal order is created, and the receipt identifies the violated rule. |

Optional fourth scenario: `Start my specialty coffee subscription` is blocked by the no-new-subscriptions rule.

## Connect real PayPal sandbox checkout

RestPay uses PayPal's **Orders v2 API**, OAuth 2.0 client credentials, hosted buyer approval, capture, idempotency keys, and optional verified webhooks. It is deliberately hardcoded to `api-m.sandbox.paypal.com`; there is no live-money mode in this prototype.

### 1. Create sandbox credentials

1. Sign in to the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/).
2. Create a sandbox app under **Apps & Credentials**.
3. Copy its sandbox **Client ID** and **Secret**.
4. Create or locate a sandbox **buyer** account for checkout. Do not use your real PayPal password or card in the app.

### 2. Configure RestPay

```bash
cp .env.example .env
```

Fill in:

```dotenv
PAYPAL_CLIENT_ID=your_sandbox_client_id
PAYPAL_CLIENT_SECRET=your_sandbox_secret
PAYPAL_ENVIRONMENT=sandbox
APP_BASE_URL=http://localhost:3000
```

Set these values in the hosting provider's environment-variable settings or in the local `.env` file loaded by `dotenv`. `.env` and `.env.local` are gitignored; only the blank `.env.example` template is committed. Never put real credentials in source files, screenshots, demo recordings, or Git history.

If you are using a hosted preview, set `APP_BASE_URL` to that preview's public HTTPS origin instead, with no trailing slash. PayPal must be able to send the buyer back to `/paypal/return` and `/paypal/cancel` on that same origin.

Restart `npm run dev`. The environment badge changes from **Sandbox Simulator** to **PayPal Sandbox**.

### 3. Make the first sandbox order

1. Keep the default mandate and run **“Buy my weekly grocery basket.”**
2. The policy receipt should show all five checks.
3. Click **Continue to PayPal**. RestPay creates the order only now, after the policy pass.
4. Sign in with the **sandbox buyer** account on PayPal's hosted page and approve.
5. PayPal returns to RestPay. RestPay re-checks the mandate and budget, verifies that the PayPal order amount and reference match, and only then calls capture.
6. The completed receipt displays the PayPal order and capture IDs.

You can also use **“I've approved — capture”** after approving in another tab. If PayPal has not marked the order `APPROVED`, capture is refused.

### Optional webhook

Expose `POST /api/webhooks/paypal` over HTTPS, configure a PayPal sandbox webhook for `CHECKOUT.ORDER.APPROVED`, and set:

```dotenv
PAYPAL_WEBHOOK_ID=your_webhook_id
```

RestPay calls PayPal's `verify-webhook-signature` endpoint before acting. Invalid signatures receive `401`. A verified order-approved event enters the same final policy-check-and-capture path as the hosted return. For a local demo, the return URL flow is sufficient and requires no webhook tunnel.

## Enable AI mandate compilation and planning

Without an AI key, RestPay uses a transparent local keyword/rule compiler and clearly labels it in the UI. To enable the LLM path, configure any OpenAI-compatible chat-completions provider:

```dotenv
AI_API_KEY=your_provider_key
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
```

The AI performs two constrained tasks:

1. **Mandate compilation**: natural language → typed JSON rules. A strict runtime schema validates category names, positive integer-cent amounts, rule count, and rule shape before activation.
2. **Purchase planning**: request → one product ID from the fixed server-side catalog. The model never supplies the price, merchant, policy result, PayPal amount, or capture decision.

If the provider fails, mandate compilation falls back to the local parser and shows a warning. Shopping planning also falls back locally. There is no pretend “AI” badge in local mode.

## Three-minute judging script

1. **Set the boundary** — show the default mandate: groceries and books only, groceries under $150/month, no subscriptions, approval over $50, and a $200 per-item maximum. Edit it and click **Compile & activate rules**.
2. **Show the happy path** — run the weekly grocery basket. Point out the deterministic receipt, then complete sandbox approval and capture.
3. **Show the visible no** — run studio wireless headphones. The category rule turns red; no PayPal order ID exists.
4. **Show human control** — run the cookbook collection. It pauses because $58 is over $50. Deny it first to show a zero-money audit event, or approve and continue.
5. **Show the audit trail** — open any row and download its JSON receipt. Every transaction carries its policy snapshot and rule-by-rule explanation.

## Architecture

```text
Plain-language mandate ──► LLM or labelled local parser ──► schema-validated rules
                                                              │
Shopping request ──► constrained agent ──► verified catalog item
                                                              │
                                             ┌────────────────▼────────────────┐
                                             │ Deterministic policy engine    │
                                             │ integer cents · fail closed    │
                                             └───────────┬───────────┬────────┘
                                                         │           │
                                                   blocked      needs approval
                                                   (stop)          (owner decides)
                                                         │           │
                                                         └────► allowed
                                                                  │
                                                    create PayPal sandbox order
                                                                  │
                                                       hosted buyer authentication
                                                                  │
                                      final policy + amount/reference verification
                                                                  │
                                                           PayPal capture
                                                                  │
                                                        explainable JSON receipt
```

### Source map

```text
src/domain/policy.ts       Side-effect-free rule evaluation and precedence
src/domain/types.ts        Shared policy, catalog, transaction, and receipt types
src/services/mandate.ts    LLM compiler, schema validation, local fallback
src/services/agent.ts      Constrained catalog planner
src/services/paypal.ts     OAuth, Orders v2 create/get/capture, webhook verification
src/services/commerce.ts   Transaction state machine and repeated enforcement
src/data/store.ts          Atomic JSON persistence and spending reservations
src/app.ts                 Express API, hosted PayPal return/cancel, webhooks
public/                    Responsive dashboard and interactive receipts
tests/                     Unit and end-to-end API tests
```

## Safety properties

- **Blocking beats approval, which beats allowance.** A purchase that violates multiple rules is still simply blocked, with all reasons recorded.
- **Empty policies fail closed.** No mandate means no payment.
- **Money uses integer cents.** PayPal strings are produced only at the integration boundary.
- **Budgets include active reservations.** Pending approvals, created orders, and captures in progress count toward available budget.
- **Rules are re-evaluated at approval and capture.** A policy change or another completed purchase can stop a previously allowed order before money moves.
- **Server-owned prices.** The agent chooses a catalog ID; it cannot dictate a price or merchant.
- **PayPal idempotency.** Create and capture calls use stable transaction-based request IDs.
- **Capture verification.** RestPay confirms the PayPal order status, exact amount, and merchant reference before capture.
- **No card handling.** Buyer authentication stays on PayPal-hosted pages.
- **Atomic local persistence.** Writes use a temporary file and rename; the data file is gitignored and created with owner-only permissions.
- **Security defaults.** Helmet headers, JSON body limits, runtime input validation, and escaped frontend output are enabled.

## Prototype boundaries

This is a single-user hackathon MVP, not a production custody product. It has no login system, multi-tenant isolation, real merchant inventory, or live PayPal environment. The JSON ledger should be replaced by a transactional database before production. The default AI provider is optional and no model output is ever trusted as a payment decision.

## License

MIT — see [LICENSE](LICENSE).
