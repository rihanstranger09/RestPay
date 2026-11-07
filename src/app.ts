import path from "node:path";
import express from "express";
import helmet from "helmet";
import { z } from "zod";
import { CATALOG } from "./data/catalog.js";
import { Store } from "./data/store.js";
import { CommerceService, HttpError } from "./services/commerce.js";
import { parseMandate } from "./services/mandate.js";
import { PayPalError, PayPalService } from "./services/paypal.js";

const requestTextSchema = z.string().trim().min(2).max(500);

export async function createApp() {
  const store = await Store.open();
  const paypal = new PayPalService();
  const commerce = new CommerceService(store, paypal);
  const app = express();
  app.disable("x-powered-by");
  app.use(
    helmet({
      xFrameOptions: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          frameAncestors: ["'self'", "https://*.e2b.app"],
          scriptSrc: ["'self'", "'unsafe-inline'", "https://www.paypal.com"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:", "https://images.unsplash.com", "https://www.paypalobjects.com"],
          connectSrc: ["'self'", "https://www.paypal.com", "https://www.sandbox.paypal.com"],
          frameSrc: ["'self'", "https://www.sandbox.paypal.com", "https://www.paypal.com"],
        },
      },
    }),
  );

  app.post("/api/webhooks/paypal", express.raw({ type: "application/json", limit: "100kb" }), async (req, res, next) => {
    try {
      const body = JSON.parse(req.body.toString("utf8")) as {
        event_type?: string;
        resource?: { id?: string };
      };
      const verified = await paypal.verifyWebhook(body, req.headers);
      if (!verified) return res.status(401).json({ error: "Webhook signature verification failed." });
      if (body.event_type === "CHECKOUT.ORDER.APPROVED" && body.resource?.id) {
        await commerce.captureByOrderId(body.resource.id);
      }
      return res.sendStatus(204);
    } catch (error) {
      return next(error);
    }
  });

  app.use(express.json({ limit: "100kb" }));
  app.use(express.static(path.resolve("public")));

  const asyncRoute = (handler: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      handler(req, res).catch(next);
    };

  const baseUrl = (req: express.Request) => {
    if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, "");
    const forwardedProtocol = req.headers["x-forwarded-proto"];
    const protocol = (Array.isArray(forwardedProtocol) ? forwardedProtocol[0] : forwardedProtocol)?.split(",")[0] ?? req.protocol;
    return `${protocol}://${req.get("host")}`;
  };

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "RestPay", paypal: paypal.configured ? "sandbox" : "simulation" });
  });

  app.get("/api/bootstrap", (_req, res) => {
    res.json({
      catalog: CATALOG,
      policy: store.getPolicy(),
      transactions: store.listTransactions(),
      config: {
        paypalMode: paypal.configured ? "sandbox" : "simulation",
        paypalEnvironment: paypal.environment,
        aiConfigured: Boolean(process.env.AI_API_KEY),
        paypalClientId: paypal.configured ? process.env.PAYPAL_CLIENT_ID : null,
      },
    });
  });

  app.post("/api/policy/parse", asyncRoute(async (req, res) => {
    const sourceText = requestTextSchema.parse(req.body?.sourceText);
    const result = await parseMandate(sourceText);
    await store.savePolicy(result.policy);
    res.json({ ...result, transactions: store.listTransactions() });
  }));

  app.post("/api/agent/run", asyncRoute(async (req, res) => {
    const body = z.object({
      requestText: requestTextSchema,
      productId: z.string().max(100).optional(),
    }).parse(req.body);
    const transaction = await commerce.runAgent(body.requestText, body.productId, baseUrl(req));
    res.status(201).json({ transaction, transactions: store.listTransactions() });
  }));

  app.post("/api/transactions/:id/approve", asyncRoute(async (req, res) => {
    const transaction = await commerce.approve(req.params.id as string, baseUrl(req));
    res.json({ transaction, transactions: store.listTransactions() });
  }));

  app.post("/api/transactions/:id/deny", asyncRoute(async (req, res) => {
    const transaction = await commerce.deny(req.params.id as string);
    res.json({ transaction, transactions: store.listTransactions() });
  }));

  app.post("/api/transactions/:id/simulate", asyncRoute(async (req, res) => {
    const transaction = await commerce.completeSimulatedPayment(req.params.id as string);
    res.json({ transaction, transactions: store.listTransactions() });
  }));

  app.post("/api/transactions/:id/capture", asyncRoute(async (req, res) => {
    const transaction = await commerce.capture(req.params.id as string);
    res.json({ transaction, transactions: store.listTransactions() });
  }));

  app.post("/api/transactions/:id/cancel", asyncRoute(async (req, res) => {
    const transaction = await commerce.cancel(req.params.id as string);
    res.json({ transaction, transactions: store.listTransactions() });
  }));

  app.get("/paypal/return", (req, res) => {
    const transactionId = String(req.query.transaction ?? "");
    const capturePath = JSON.stringify(`/api/transactions/${encodeURIComponent(transactionId)}/capture`).replace(/</g, "\\u003c");
    res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RestPay · Completing checkout</title><style>body{font-family:system-ui;background:#f5f5ef;color:#17261f;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:white;padding:40px;border-radius:24px;max-width:460px;box-shadow:0 20px 60px #17352218}h1{font-size:26px}p{line-height:1.6;color:#627168}button{background:#17261f;color:white;border:0;padding:14px 20px;border-radius:12px;font-weight:700}a{color:#256a48}</style></head><body><main class="card"><div id="state"><p>RESTPAY / PAYPAL RETURN</p><h1>Verifying before capture…</h1><p>PayPal approval is confirmed. RestPay is running its final policy and budget check before collecting funds.</p></div><script>fetch(${capturePath},{method:'POST'}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error||'Capture failed');const t=d.transaction;document.getElementById('state').innerHTML='<p>RESTPAY / RECEIPT</p><h1>'+(t.status==='completed'?'Payment complete.':'Payment not captured.')+'</h1><p>'+(t.status==='completed'?'The final policy check passed and PayPal confirmed the capture.':'RestPay stopped capture: '+t.evaluation.summary)+'</p><a href="/">Return to your RestPay dashboard →</a>'}).catch(e=>{document.getElementById('state').innerHTML='<p>RESTPAY / CHECKOUT</p><h1>Capture not completed</h1><p>'+String(e.message).replace(/[<>&]/g,'')+'</p><a href="/">Return to RestPay →</a>'})</script></main></body></html>`);
  });

  app.get("/paypal/cancel", asyncRoute(async (req, res) => {
    const transactionId = String(req.query.transaction ?? "");
    if (transactionId) await commerce.cancel(transactionId);
    res.redirect("/?checkout=cancelled");
  }));

  app.use((req, res) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "API route not found." });
    return res.sendFile(path.resolve("public/index.html"));
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues[0]?.message ?? "Invalid request.", issues: error.issues });
    }
    if (error instanceof HttpError || error instanceof PayPalError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(error);
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unexpected server error." });
  });

  return app;
}
