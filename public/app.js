const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}" /></svg>`;
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const money = (cents) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const shortDate = (date) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(date));

let state = { catalog: [], policy: null, transactions: [], config: {} };
let currentTransaction = null;
let activeFilter = "all";
let showAll = false;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function toast(message, error = false) {
  const element = document.createElement("div");
  element.className = `toast${error ? " error" : ""}`;
  element.innerHTML = `${icon(error ? "info" : "check")}<span>${esc(message)}</span>`;
  $("#toast-region").append(element);
  setTimeout(() => element.remove(), 4800);
}

function isCurrentMonth(date) {
  const value = new Date(date);
  const now = new Date();
  return value.getUTCFullYear() === now.getUTCFullYear() && value.getUTCMonth() === now.getUTCMonth();
}

function statusInfo(transaction) {
  const status = transaction.status;
  const map = {
    completed: ["Paid", "check"],
    blocked: ["Blocked", "lock"],
    pending_approval: ["Needs review", "clock"],
    awaiting_payment: [transaction.paymentMode === "simulation" ? "PayPal simulated" : "PayPal pending", "clock"],
    processing: ["Processing", "clock"],
    denied: ["Denied", "x"],
    cancelled: ["Cancelled", "x"],
    failed: ["Failed", "info"],
  };
  return map[status] || [status, "info"];
}

function renderStats() {
  if (!state.policy) return;
  const monthly = state.policy.rules.find((rule) => rule.type === "monthly_budget");
  const transactions = state.transactions.filter((transaction) => isCurrentMonth(transaction.createdAt));
  const inScope = (transaction) => !monthly?.category || transaction.purchase.category === monthly.category;
  const completed = transactions.filter((transaction) => transaction.status === "completed" && inScope(transaction));
  const reserved = transactions.filter((transaction) => ["pending_approval", "awaiting_payment", "processing"].includes(transaction.status) && inScope(transaction));
  const spent = completed.reduce((sum, transaction) => sum + transaction.purchase.amountCents, 0);
  const reservedTotal = reserved.reduce((sum, transaction) => sum + transaction.purchase.amountCents, 0);
  const pending = transactions.filter((transaction) => transaction.status === "pending_approval");
  const blocked = transactions.filter((transaction) => transaction.status === "blocked");
  const budget = monthly?.amountCents || Math.max(spent + reservedTotal, 1);
  const remaining = Math.max(0, budget - spent - reservedTotal);
  $("#spent-value").textContent = money(spent);
  $("#remaining-value").textContent = monthly ? money(remaining) : "Unlimited";
  $("#approval-value").textContent = String(pending.length).padStart(2, "0");
  $("#blocked-value").textContent = String(blocked.length).padStart(2, "0");
  $("#budget-progress").style.width = `${Math.min(100, ((spent + reservedTotal) / budget) * 100)}%`;
  $("#budget-progress").style.background = spent + reservedTotal > budget * .85 ? "#c68b42" : "#6b9255";
  $("#budget-caption").textContent = monthly ? `${money(budget)} ${monthly.category || "total"} budget · ${Math.round((spent / budget) * 100)}% captured` : "Add a monthly budget to track spending";
  $("#reserved-caption").textContent = reservedTotal ? `${money(reservedTotal)} reserved by active purchases` : "No active payment reservations";
  $("#approval-caption").textContent = pending.length ? `${money(pending.reduce((sum, item) => sum + item.purchase.amountCents, 0))} awaiting your decision` : "No action needed";
  const scopeLabel = $(".stat-primary .stat-label > span");
  scopeLabel.textContent = monthly?.category ? `${monthly.category[0].toUpperCase()}${monthly.category.slice(1)} this month` : "Spending this month";
}

function ruleCopy(rule) {
  switch (rule.type) {
    case "allowed_categories": return { title: `Only ${rule.categories.join(" & ")}`, detail: "Other categories are blocked", icon: "grid" };
    case "monthly_budget": return { title: `${money(rule.amountCents)} / month${rule.category ? ` · ${rule.category}` : ""}`, detail: "Captured + reserved spending counts", icon: "wallet" };
    case "approval_threshold": return { title: `Ask me over ${money(rule.amountCents)}`, detail: "Human approval before payment", icon: "clock" };
    case "per_item_limit": return { title: `${money(rule.amountCents)} per-item maximum`, detail: "No single purchase above this", icon: "sliders" };
    case "subscription_block": return { title: "No new subscriptions", detail: "Recurring charges are blocked", icon: "lock" };
    default: return { title: "Policy rule", detail: "Enforced deterministically", icon: "shield" };
  }
}

function renderPolicy() {
  if (!state.policy) return;
  if (document.activeElement !== $("#policy-input")) $("#policy-input").value = state.policy.sourceText;
  $("#rule-count").textContent = `${state.policy.rules.length} checks`;
  $("#compiler-source").innerHTML = `${icon(state.policy.parserSource === "ai" ? "sparkles" : "info")} ${state.policy.parserSource === "ai" ? "AI-compiled · schema validated" : "Transparent local compiler"}`;
  $("#rules-list").innerHTML = state.policy.rules.map((rule) => {
    const copy = ruleCopy(rule);
    return `<div class="rule-item"><span class="rule-icon">${icon(copy.icon)}</span><div><strong>${esc(copy.title)}</strong><p>${esc(copy.detail)}</p></div></div>`;
  }).join("");
}

function renderCatalog() {
  $("#catalog-grid").innerHTML = state.catalog.slice(0, 4).map((product) => `
    <article class="product-card">
      <div class="product-image" style="background:${esc(product.accent)}">
        <img src="${esc(product.image)}" alt="${esc(product.name)}" loading="lazy" />
        <span class="product-badge">${esc(product.badge)}</span>
      </div>
      <div class="product-body">
        <p class="product-merchant">${esc(product.merchant)}</p>
        <h3 class="product-name">${esc(product.name)}</h3>
        ${product.recurring ? '<p class="product-recurring">↻ Monthly recurring charge</p>' : ""}
        <div class="product-meta"><span class="product-price">${money(product.amountCents)}</span><button class="product-buy" data-product="${esc(product.id)}" data-name="${esc(product.name)}" aria-label="Delegate ${esc(product.name)}" title="Ask agent to buy">${icon("arrow")}</button></div>
      </div>
    </article>`).join("");
  $$("#catalog-grid img").forEach((image) => image.addEventListener("error", () => { image.style.display = "none"; }, { once: true }));
}

function renderApprovals() {
  const pending = state.transactions.filter((transaction) => transaction.status === "pending_approval");
  $("#approval-count").textContent = pending.length;
  $("#approvals-list").innerHTML = pending.length ? pending.map((transaction) => `
    <button class="approval-item" data-transaction="${esc(transaction.id)}"><span>${icon("clock")}</span><span><strong>${esc(transaction.purchase.item)}</strong><small>${money(transaction.purchase.amountCents)} · Review now</small></span>${icon("chevron")}</button>`).join("") : `
    <div class="empty-approvals"><span>${icon("check")}</span><div><strong>You're all caught up</strong><p>Nothing needs your approval.</p></div></div>`;
}

function renderActivity() {
  const filtered = state.transactions.filter((transaction) => activeFilter === "all" || transaction.status === activeFilter);
  const visible = showAll ? filtered : filtered.slice(0, 5);
  $("#activity-body").innerHTML = visible.length ? visible.map((transaction) => {
    const [label, statusIcon] = statusInfo(transaction);
    const violation = transaction.evaluation.reasons.find((reason) => reason.outcome === "violated");
    const explanation = violation?.title || (transaction.status === "completed" ? "All policy checks passed" : transaction.evaluation.reasons.find((reason) => reason.outcome === "approval")?.title || transaction.evaluation.summary);
    return `<tr data-transaction="${esc(transaction.id)}">
      <td><div class="purchase-cell"><span class="merchant-icon">${esc(transaction.purchase.merchant.split(/\s/).map((word) => word[0]).join("").slice(0, 2))}</span><div><strong>${esc(transaction.purchase.item)}</strong><small>${esc(transaction.purchase.merchant)} · ${shortDate(transaction.createdAt)}</small></div></div></td>
      <td><span class="status-pill status-${esc(transaction.status)}">${icon(statusIcon)}${esc(label)}</span></td>
      <td class="explanation-cell"><span title="${esc(explanation)}">${esc(explanation)}</span></td>
      <td class="amount-cell">${money(transaction.purchase.amountCents)}</td>
      <td class="reference-cell">${esc(transaction.reference)}</td><td>${icon("chevron")}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="6" class="empty-table">No transactions match this view.</td></tr>`;
  $("#view-all").innerHTML = `${showAll ? "Show recent" : "View all activity"} ${icon(showAll ? "x" : "arrow")}`;
}

function renderConfig() {
  const live = state.config.paypalMode === "sandbox";
  $("#environment-label").textContent = live ? "PayPal Sandbox" : "Sandbox Simulator";
  $("#agent-model").textContent = state.config.aiConfigured ? "AI planner · policy gated" : "Local planner · policy gated";
}

function renderAll() {
  renderConfig();
  renderStats();
  renderPolicy();
  renderCatalog();
  renderApprovals();
  renderActivity();
}

function decisionCopy(transaction) {
  switch (transaction.status) {
    case "blocked": return { title: "This purchase crosses a line.", overline: "Blocked before PayPal", icon: "lock" };
    case "pending_approval": return { title: "Your call, Alex.", overline: "Human approval required", icon: "clock" };
    case "awaiting_payment": return { title: transaction.decision === "allowed" ? "Rules passed. Over to PayPal." : "Approved. Complete checkout.", overline: "Policy check passed", icon: "shield" };
    case "completed": return { title: "Purchase complete. Proof included.", overline: "Explainable receipt", icon: "check" };
    case "denied": return { title: "Purchase denied. Funds untouched.", overline: "Human decision recorded", icon: "x" };
    case "cancelled": return { title: "Checkout cancelled safely.", overline: "No funds collected", icon: "x" };
    case "failed": return { title: "Payment setup did not complete.", overline: "No funds collected", icon: "info" };
    default: return { title: "Checking your mandate…", overline: "RestPay protection", icon: "clock" };
  }
}

function safePayPalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "paypal.com" || url.hostname.endsWith(".paypal.com")) ? url.href : "#";
  } catch { return "#"; }
}

function renderDecision(transaction) {
  currentTransaction = transaction;
  const copy = decisionCopy(transaction);
  const heroClass = transaction.status === "awaiting_payment" && transaction.decision === "allowed" ? "allowed" : transaction.status;
  const reasons = transaction.evaluation.reasons.map((reason) => `
    <div class="decision-reason ${esc(reason.outcome)}">
      <span class="reason-icon">${icon(reason.outcome === "violated" ? "x" : reason.outcome === "approval" ? "clock" : "check")}</span>
      <div><strong>${esc(reason.title)}</strong><p>${esc(reason.detail)}</p></div>
    </div>`).join("");
  let actions = "";
  if (transaction.status === "pending_approval") {
    actions = `<div class="decision-actions"><button class="button button-danger" data-action="deny">Deny purchase</button><button class="button button-dark" data-action="approve">Approve & continue ${icon("arrow")}</button></div><p class="decision-footnote">${icon("lock")} No PayPal order exists until you approve</p>`;
  } else if (transaction.status === "awaiting_payment" && transaction.paymentMode === "simulation") {
    actions = `<div class="simulation-notice">${icon("info")}<span><strong>Checkout simulator</strong><br />No PayPal credentials are configured. This demonstrates the same create → buyer approval → capture flow without moving money.</span></div><div class="decision-actions"><button class="button button-paypal" data-action="simulate">Simulate PayPal approval ${icon("arrow")}</button></div><p class="decision-footnote">${icon("shield")} Final policy check runs before simulated capture</p>`;
  } else if (transaction.status === "awaiting_payment") {
    actions = `<div class="decision-actions"><a class="button button-paypal" href="${esc(safePayPalUrl(transaction.paypalApprovalUrl))}" target="_blank" rel="noopener">Continue to PayPal ${icon("arrow")}</a><button class="button button-dark" data-action="capture">I've approved — capture</button></div><p class="decision-footnote">${icon("lock")} Buyer authentication happens on PayPal</p>`;
  } else {
    actions = `<div class="decision-actions"><button class="button button-secondary" data-action="download">${icon("download")} Download receipt</button><button class="button button-dark" data-action="close">Done</button></div>`;
  }
  const proof = transaction.paypalOrderId ? `<div class="payment-proof"><div><span>${transaction.paymentMode === "simulation" ? "Simulated order" : "PayPal order"}</span><code>${esc(transaction.paypalOrderId)}</code></div>${transaction.paypalCaptureId ? `<div><span>Capture ID</span><code>${esc(transaction.paypalCaptureId)}</code></div>` : ""}<div><span>Receipt reference</span><code>${esc(transaction.reference)}</code></div></div>` : "";
  $("#decision-content").innerHTML = `
    <header class="decision-hero ${esc(heroClass)}"><span class="decision-symbol">${icon(copy.icon)}</span><p class="decision-overline">${esc(copy.overline)}</p><h2 id="decision-title">${esc(copy.title)}</h2><p>${esc(transaction.failureReason || transaction.evaluation.summary)}</p></header>
    <div class="decision-body">
      <div class="decision-product"><span class="merchant-icon">${esc(transaction.purchase.merchant.slice(0, 2).toUpperCase())}</span><div><strong>${esc(transaction.purchase.item)}</strong><small>${esc(transaction.purchase.merchant)} · ${esc(transaction.purchase.category)}${transaction.purchase.recurring ? " · recurring" : ""}</small></div><span class="decision-price">${money(transaction.purchase.amountCents)}</span></div>
      <div class="policy-check-heading"><strong>Deterministic policy receipt</strong><span>${transaction.evaluation.reasons.length} checks · ${transaction.agentSource === "ai" ? "AI plan" : "local plan"}</span></div>
      <div class="decision-reasons">${reasons}</div>
      <div class="agent-note">${icon("sparkles")}<p><strong>Agent rationale:</strong> ${esc(transaction.agentRationale)}</p></div>
      ${proof}${actions}
    </div>`;
  $("#decision-modal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal() {
  $("#decision-modal").hidden = true;
  document.body.style.overflow = "";
}

function openTransaction(id) {
  const transaction = state.transactions.find((item) => item.id === id);
  if (transaction) renderDecision(transaction);
}

function acceptResponse(data) {
  if (data.transactions) state.transactions = data.transactions;
  if (data.policy) state.policy = data.policy;
  if (data.transaction) {
    const index = state.transactions.findIndex((item) => item.id === data.transaction.id);
    if (index >= 0) state.transactions[index] = data.transaction;
    currentTransaction = data.transaction;
  }
  renderAll();
  if (currentTransaction && !$("#decision-modal").hidden) renderDecision(currentTransaction);
}

function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function runAgent(requestText, productId) {
  const button = $("#run-agent");
  button.disabled = true;
  button.innerHTML = `<span>Checking rules…</span>${icon("clock")}`;
  try {
    const data = await api("/api/agent/run", { method: "POST", body: JSON.stringify({ requestText, ...(productId ? { productId } : {}) }) });
    acceptResponse(data);
    renderDecision(data.transaction);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.innerHTML = `<span>Run agent</span>${icon("arrow")}`;
  }
}

$("#agent-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const requestText = $("#agent-input").value.trim();
  if (requestText.length < 2) return toast("Tell the agent what you want to buy.", true);
  runAgent(requestText);
});

$$("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
  $("#agent-input").value = button.dataset.prompt;
  runAgent(button.dataset.prompt);
}));

$("#catalog-grid").addEventListener("click", (event) => {
  const button = event.target.closest("[data-product]");
  if (!button) return;
  const requestText = `Buy ${button.dataset.name}`;
  $("#agent-input").value = requestText;
  runAgent(requestText, button.dataset.product);
});

$("#policy-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#compile-policy");
  button.disabled = true;
  button.innerHTML = `${icon("clock")} Compiling & validating…`;
  try {
    const data = await api("/api/policy/parse", { method: "POST", body: JSON.stringify({ sourceText: $("#policy-input").value }) });
    acceptResponse(data);
    toast(`Mandate active: ${data.policy.rules.length} deterministic checks are now enforced.`);
    if (data.warning) toast(data.warning, true);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.innerHTML = `${icon("sparkles")} Compile & activate rules`;
  }
});

$("#approvals-list").addEventListener("click", (event) => {
  const item = event.target.closest("[data-transaction]");
  if (item) openTransaction(item.dataset.transaction);
});

$("#activity-body").addEventListener("click", (event) => {
  const row = event.target.closest("[data-transaction]");
  if (row) openTransaction(row.dataset.transaction);
});

$$("[data-filter]").forEach((button) => button.addEventListener("click", () => {
  activeFilter = button.dataset.filter;
  showAll = false;
  $$("[data-filter]").forEach((item) => item.classList.toggle("active", item === button));
  renderActivity();
}));

$("#view-all").addEventListener("click", () => { showAll = !showAll; renderActivity(); });
$("#modal-close").addEventListener("click", closeModal);
$("#decision-modal").addEventListener("click", (event) => { if (event.target === $("#decision-modal")) closeModal(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModal(); });

$("#decision-content").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || !currentTransaction) return;
  const action = button.dataset.action;
  if (action === "close") return closeModal();
  if (action === "download") return downloadJson(`restpay-${currentTransaction.reference}.json`, currentTransaction);
  button.disabled = true;
  const original = button.innerHTML;
  button.innerHTML = `${icon("clock")} Verifying…`;
  try {
    const data = await api(`/api/transactions/${currentTransaction.id}/${action}`, { method: "POST", body: "{}" });
    acceptResponse(data);
    renderDecision(data.transaction);
    if (data.transaction.status === "completed") toast("Payment captured after the final policy check. Receipt saved.");
    if (data.transaction.status === "denied") toast("Purchase denied. No PayPal order was created.");
    if (data.transaction.status === "blocked") toast("The latest policy check blocked payment.", true);
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
    button.innerHTML = original;
    try { await loadBootstrap(false); } catch { /* retain current view */ }
  }
});

function exportAudit() {
  downloadJson(`restpay-audit-${new Date().toISOString().slice(0, 10)}.json`, {
    exportedAt: new Date().toISOString(),
    environment: state.config.paypalMode,
    activePolicy: state.policy,
    transactions: state.transactions,
  });
  toast("Audit trail exported with policy snapshots and decision reasons.");
}
$("#export-button").addEventListener("click", exportAudit);
$("#activity-export").addEventListener("click", exportAudit);

async function loadBootstrap(notify = true) {
  const data = await api("/api/bootstrap");
  state = data;
  renderAll();
  if (currentTransaction) currentTransaction = state.transactions.find((item) => item.id === currentTransaction.id) || null;
}

loadBootstrap().catch((error) => {
  toast(`Could not load RestPay: ${error.message}`, true);
  $("#catalog-grid").innerHTML = '<div class="loading-state">Unable to load the workspace. Is the server running?</div>';
});

window.addEventListener("focus", () => { loadBootstrap(false).catch(() => undefined); });
