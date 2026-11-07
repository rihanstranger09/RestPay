import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dollarsToCents } from "../domain/money.js";
import { CATEGORIES } from "../domain/types.js";
import type { Category, ParserSource, Policy, PolicyRule } from "../domain/types.js";

const categorySchema = z.enum(CATEGORIES);
const ruleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("allowed_categories"),
    categories: z.array(categorySchema).min(1),
    source: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal("per_item_limit"),
    amountCents: z.number().int().positive().max(100_000_000),
    source: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal("monthly_budget"),
    amountCents: z.number().int().positive().max(100_000_000),
    category: categorySchema.optional(),
    source: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal("approval_threshold"),
    amountCents: z.number().int().nonnegative().max(100_000_000),
    source: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal("subscription_block"),
    source: z.string().max(500).optional(),
  }),
]);

const mandateSchema = z.object({ rules: z.array(ruleSchema).min(1).max(20) });

export interface ParsedMandate {
  policy: Policy;
  warning?: string;
}

function buildPolicy(sourceText: string, rules: PolicyRule[], parserSource: ParserSource): Policy {
  return {
    id: randomUUID(),
    name: "Personal spending mandate",
    sourceText,
    rules,
    parserSource,
    createdAt: new Date().toISOString(),
  };
}

function amount(value: string): number {
  return dollarsToCents(Number.parseFloat(value.replace(/,/g, "")));
}

function normalizeCategory(value: string): Category | undefined {
  const normalized = value.toLowerCase().replace(/[^a-z]/g, "");
  const aliases: Record<string, Category> = {
    grocery: "groceries",
    groceries: "groceries",
    food: "groceries",
    book: "books",
    books: "books",
    electronic: "electronics",
    electronics: "electronics",
    tech: "electronics",
    coffee: "coffee",
    fashion: "fashion",
    clothes: "fashion",
    clothing: "fashion",
    beauty: "beauty",
    skincare: "beauty",
    home: "home",
    household: "home",
    other: "other",
  };
  return aliases[normalized];
}

/** A transparent fallback for the demo, not presented as an LLM. */
export function parseMandateLocally(sourceText: string): Policy {
  const text = sourceText.trim();
  if (!text) throw new Error("Describe at least one spending rule.");
  const rules: PolicyRule[] = [];
  let index = 0;
  type RuleInput = PolicyRule extends infer Rule
    ? Rule extends PolicyRule
      ? Omit<Rule, "id" | "source"> & { source?: string }
      : never
    : never;
  const add = (rule: RuleInput) => {
    rules.push({ ...rule, id: `rule-${++index}`, source: rule.source ?? text } as PolicyRule);
  };

  const onlyMatch = text.match(/\bonly\s+(?:buy\s+|purchase\s+|allow\s+)?([^.\n;]+)/i);
  if (onlyMatch?.[1]) {
    const categories = [...new Set(
      onlyMatch[1]
        .split(/\s*(?:,|and|or|\/)\s*/i)
        .map(normalizeCategory)
        .filter((category): category is Category => Boolean(category)),
    )];
    if (categories.length > 0) add({ type: "allowed_categories", categories });
  }

  const monthlyPattern = /\b(?:(groceries|grocery|books|book|electronics|coffee|fashion|clothes|beauty|home|other)\s+)?(?:spending\s+)?(?:under|up\s+to|no\s+more\s+than|max(?:imum)?(?:\s+of)?)\s*\$?(\d[\d,]*(?:\.\d{1,2})?)\s*(?:a|per|each)\s+month\b/gi;
  for (const match of text.matchAll(monthlyPattern)) {
    const category = match[1] ? normalizeCategory(match[1]) : undefined;
    add({
      type: "monthly_budget",
      amountCents: amount(match[2] ?? "0"),
      ...(category ? { category } : {}),
    });
  }

  const approvalPattern = /\bask\s+me\s+(?:before|for|to\s+approve)\s*(?:anything|any\s+purchase|purchases|buying)?\s*(?:over|above|more\s+than|exceeding)\s*\$?(\d[\d,]*(?:\.\d{1,2})?)/i;
  const approvalMatch = text.match(approvalPattern);
  if (approvalMatch?.[1]) {
    add({ type: "approval_threshold", amountCents: amount(approvalMatch[1]) });
  }

  const itemPattern = /\b(?:never\s+spend\s+more\s+than|no\s+more\s+than|max(?:imum)?|cap(?:ped)?\s+at|under)\s*\$?(\d[\d,]*(?:\.\d{1,2})?)\s*(?:(?:on|for)\s*(?:one|a\s+single|each|any)\s*(?:item|purchase)|per\s*(?:item|purchase))/i;
  const itemMatch = text.match(itemPattern);
  if (itemMatch?.[1]) add({ type: "per_item_limit", amountCents: amount(itemMatch[1]) });

  if (/\b(?:no|block|prohibit|never\s+allow|don'?t\s+allow|do\s+not\s+allow)\s+(?:new\s+)?(?:subscriptions?|recurring\s+(?:charges?|payments?|purchases?))/i.test(text)) {
    add({ type: "subscription_block" });
  }

  if (rules.length === 0) {
    throw new Error(
      "No rules recognized. Try: ‘Only groceries and books. Groceries under $150 a month, no new subscriptions, ask me before anything over $50.’",
    );
  }

  return buildPolicy(text, rules, "local");
}

async function parseWithAI(sourceText: string): Promise<Policy> {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) throw new Error("AI is not configured.");
  const baseUrl = (process.env.AI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.AI_MODEL ?? "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Convert a user's spending mandate into JSON. Return only {"rules": [...]}. Rule shapes: {"type":"allowed_categories","categories":["groceries"]}; {"type":"monthly_budget","amountCents":15000,"category":"groceries"} (category optional); {"type":"per_item_limit","amountCents":20000}; {"type":"approval_threshold","amountCents":5000}; {"type":"subscription_block"}. Categories: ${CATEGORIES.join(", ")}. Convert dollars to integer cents. 'Over' means a strict threshold, not a block. Never invent rules or loosen limits. If uncertain, omit that rule.`,
        },
        { role: "user", content: sourceText },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`AI provider returned HTTP ${response.status}.`);
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI provider returned no mandate.");
  const cleaned = content.replace(/^```(?:json)?\s*|\s*```$/g, "");
  const parsed = mandateSchema.parse(JSON.parse(cleaned));
  const rules = parsed.rules.map((rule, index) => ({
    ...rule,
    id: `rule-${index + 1}`,
    source: rule.source ?? sourceText,
  })) as PolicyRule[];
  return buildPolicy(sourceText, rules, "ai");
}

export async function parseMandate(sourceText: string): Promise<ParsedMandate> {
  if (!process.env.AI_API_KEY) return { policy: parseMandateLocally(sourceText) };
  try {
    return { policy: await parseWithAI(sourceText) };
  } catch (error) {
    const policy = parseMandateLocally(sourceText);
    return {
      policy,
      warning: `AI compilation was unavailable, so the local parser was used (${error instanceof Error ? error.message : "unknown error"}).`,
    };
  }
}
