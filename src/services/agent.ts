import { z } from "zod";
import { CATALOG, getProduct } from "../data/catalog.js";
import type { AgentPlan, Product } from "../domain/types.js";

const planSchema = z.object({ productId: z.string(), rationale: z.string().max(300) });

function localPlan(requestText: string): AgentPlan {
  const request = requestText.toLowerCase();
  const scored = CATALOG.map((product) => {
    let score = 0;
    for (const alias of [product.name, product.category, product.merchant, ...product.aliases]) {
      const term = alias.toLowerCase();
      if (request.includes(term)) score += term.includes(" ") ? 8 : 4;
      for (const token of term.split(/\s+/)) {
        if (token.length > 3 && request.includes(token)) score += 1;
      }
    }
    return { product, score };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score === 0) {
    throw new Error("I couldn't match that to the demo catalog. Try groceries, cookbooks, headphones, coffee, or a design book.");
  }
  return {
    product: best.product,
    source: "local",
    rationale: `Matched your request to ${best.product.name} at ${best.product.merchant} using catalog keywords. Price and merchant come from the server-side catalog.`,
  };
}

async function aiPlan(requestText: string): Promise<AgentPlan> {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) throw new Error("AI is not configured.");
  const baseUrl = (process.env.AI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.AI_MODEL ?? "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are the shopping planner inside RestPay. Select exactly one item from this catalog: ${JSON.stringify(CATALOG.map(({ id, name, description, merchant, category, amountCents, recurring }) => ({ id, name, description, merchant, category, amountCents, recurring })))}. Return {"productId":"catalog-id","rationale":"one short sentence"}. Never invent products, prices, merchants, or policy decisions. You cannot make payments.`,
        },
        { role: "user", content: requestText },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`AI provider returned HTTP ${response.status}.`);
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI provider returned no plan.");
  const parsed = planSchema.parse(JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, "")));
  const product = getProduct(parsed.productId);
  if (!product) throw new Error("AI selected an unknown catalog item.");
  return { product, source: "ai", rationale: parsed.rationale };
}

export async function planPurchase(requestText: string): Promise<AgentPlan> {
  if (!process.env.AI_API_KEY) return localPlan(requestText);
  try {
    return await aiPlan(requestText);
  } catch {
    return localPlan(requestText);
  }
}

export function planKnownProduct(product: Product): AgentPlan {
  return {
    product,
    source: "local",
    rationale: `Selected directly from the verified demo catalog. The ${product.merchant} price is fixed server-side.`,
  };
}
