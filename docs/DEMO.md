# Demo day checklist

## Before judges arrive

- [ ] `npm run check` passes.
- [ ] `npm run dev` is running on port 3000.
- [ ] For real sandbox checkout, `.env` contains a sandbox client ID/secret and the public `APP_BASE_URL` is correct.
- [ ] A PayPal sandbox **buyer** account is available and you are logged out of any live PayPal account.
- [ ] Browser has the RestPay dashboard open at **Overview**.
- [ ] Default mandate is active.

## The narrative

**Opening (15 seconds)**  
“AI shopping agents don't have a capability problem; they have a delegation problem. RestPay lets me state an expense policy in plain English, then makes sure the model can never decide alone whether money moves.”

**Visible no (30 seconds)**  
Click **Breaks a rule**.  
“The agent found real headphones from the catalog, but the deterministic category check stopped it. Notice there is no PayPal order ID. This is enforcement before payment, not a warning after it.”

**Human approval (45 seconds)**  
Click **Needs approval**.  
“This cookbook is in an allowed category and fits the budget, but $58 crosses my $50 threshold. I can deny it with an audit event, or approve it. Approval creates the PayPal order—never before.”

**PayPal + final verification (45 seconds)**  
Run the weekly grocery basket. Continue to PayPal or use the labelled simulator.  
“PayPal handles buyer authentication. When I return, RestPay checks the rules and budget again, verifies the exact order amount and reference, and only then captures. The receipt includes order and capture IDs.”

**Close (15 seconds)**  
Open the audit trail.  
“Every decision—allowed, paused, denied, blocked, or paid—has a rule-by-rule explanation and policy snapshot. That's the trust layer agentic commerce needs.”

## Recovery

The app reserves pending purchases against budget, so repeated demos intentionally affect later outcomes. To restore the original seed data, stop the server, run `npm run seed`, and restart. Never do this during an active PayPal checkout.
