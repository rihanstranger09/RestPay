import "dotenv/config";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { Store } from "../src/data/store.js";

const filePath = path.resolve(process.env.DATA_FILE ?? "data/restpay.json");

try {
  await unlink(filePath);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const store = await Store.open();
const policy = store.getPolicy();
console.log(`Seeded ${store.listTransactions().length} demo receipts and ${policy.rules.length} active policy rules.`);
console.log(`Data file: ${filePath}`);
console.log("Start the app with npm run dev. Re-running this command resets the demo ledger.");
