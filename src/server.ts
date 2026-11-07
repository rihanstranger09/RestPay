import "dotenv/config";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const app = await createApp();
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`\n  RestPay is ready → http://localhost:${port}`);
  console.log(`  Payment mode: ${process.env.PAYPAL_CLIENT_ID ? "PayPal sandbox" : "checkout simulator"}`);
  console.log(`  Mandate compiler: ${process.env.AI_API_KEY ? "AI + local fallback" : "local parser"}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
