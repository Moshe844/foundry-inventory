'use strict';

const { ValidationError } = require('../domain/errors');
const { assertSafePack, round } = require('./paid-model-budget');

async function qualify(database, product) {
  if (product.id !== 'agent-monthly-credits') return null;
  const review = product.ai_usage_review;
  const credits = Number(review?.measuredCredits);
  const cost = Number(review?.providerCostMinor);
  if (!review?.providerInvoiceReference || !review?.usageLedgerReference ||
      !Number.isSafeInteger(credits) || credits <= 0 || !Number.isFinite(cost) || cost <= 0) {
    throw new ValidationError('The AI credit add-on is awaiting a review of actual usage costs.');
  }
  const reference = (await database.query(`SELECT * FROM commercial_usage_packs
    WHERE id='ai-2500-v4' AND status='APPROVED'`)).rows[0];
  if (!reference) throw new ValidationError('The approved AI funding policy is unavailable.');
  const units = Number(product.units_per_pack);
  const amount = Number(product.monthly_amount_minor);
  const perCredit = cost / credits * 1.10;
  const budget = Math.floor(amount * Number(reference.max_provider_cost_share));
  if (!Number.isSafeInteger(budget) || budget <= 0 || units * perCredit > budget) {
    throw new ValidationError('Measured usage exceeds the approved AI funding margin.');
  }
  const pack = { ...reference, units, amount_minor: amount, conservative_cost_per_credit_minor: perCredit,
    provider_cost_budget_minor: budget, cost_budget_source: JSON.stringify(review) };
  await assertSafePack(database, pack);
  return { budget, source: pack.cost_budget_source, model: pack.cost_model_key,
    ceilings: pack.approved_model_rate_ceiling };
}

async function fundInvoice(client, order, invoiceId) {
  const funding = order.ai_funding;
  if (!funding) throw new ValidationError('This credit order has no approved provider budget.');
  const budget = round(funding.budget * Number(order.quantity));
  const result = await client.query(`INSERT INTO commercial_model_grant_budgets
    (grant_id,capacity_invoice_id,account_id,budget_minor,pack_units,purchase_amount_minor,cost_model_key,source,approved_model_rate_ceiling)
    SELECT id,$1,$2,$3,$4,$5,$6,$7,$8::jsonb FROM commercial_usage_grants
    WHERE capacity_invoice_id=$1 AND account_id=$2 AND units=$4 AND category='ai_work_credits'
    ON CONFLICT (capacity_invoice_id) DO NOTHING RETURNING grant_id`,
    [invoiceId, order.account_id, budget, order.units, order.amount_minor, funding.model, funding.source, JSON.stringify(funding.ceilings)]);
  if (result.rowCount) return;
  const existing = (await client.query(`SELECT budget_minor,account_id FROM commercial_model_grant_budgets
    WHERE capacity_invoice_id=$1`, [invoiceId])).rows[0];
  if (existing?.account_id !== order.account_id || Number(existing?.budget_minor) !== budget) {
    throw new ValidationError('This invoice conflicts with the original AI grant.');
  }
}

module.exports = { qualify, fundInvoice };
