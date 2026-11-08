'use strict';

const { ValidationError } = require('../domain/errors');
const { assertSafePack, round } = require('./paid-model-budget');

async function qualify(database, product) {
  if (product.id !== 'agent-monthly-credits') return null;
  const review = product.ai_usage_review;
  const missingEvidence = 'The AI credit add-on is awaiting a review of actual usage costs.';
  const start=Date.parse(review?.start), end=Date.parse(review?.end);
  if (!review?.accountId || !(end>start) || end>Date.now()) throw new ValidationError(missingEvidence);
  // Imported provider statement allocations exclude directly metered calls.
  // Read both from the same closed period and use committed customer credits.
  const evidence=(await database.query(`WITH calls AS (
    SELECT provider,status,actual_minor,created_at FROM commercial_model_cost_holds
    WHERE account_id=$1 AND created_at>=$2 AND created_at<$3
  ), invoices AS (
    SELECT s.id,s.provider,s.currency,a.amount_minor,s.period_start,s.period_end
    FROM commercial_provider_cost_statements s JOIN commercial_provider_cost_allocations a ON a.statement_id=s.id
    WHERE a.account_id=$1 AND s.provider IN ('openai','anthropic') AND s.period_start<$3 AND s.period_end>$2
  )
  SELECT (SELECT sum(e.units) FROM commercial_usage_events e WHERE e.account_id=$1 AND e.meter='ai_work_credits'
    AND e.status='COMMITTED' AND e.detail#>>'{creditPolicy,fixedAgentCredits}'='true' AND e.occurred_at>=$2 AND e.occurred_at<$3) AS credits,
    (SELECT sum(actual_minor) FROM calls WHERE status='SETTLED') AS direct,
    (SELECT sum(amount_minor) FROM invoices) AS invoiced,
    (SELECT array_agg(id ORDER BY id) FROM invoices) AS statement_ids,
    EXISTS(SELECT 1 FROM calls c WHERE c.status IN ('RESERVED','UNKNOWN')
      OR (c.status='SETTLED' AND (c.actual_minor IS NULL OR NOT EXISTS (SELECT 1 FROM invoices i
        WHERE i.provider=c.provider AND c.created_at>=i.period_start AND c.created_at<i.period_end)))) AS incomplete_calls,
    EXISTS(SELECT 1 FROM invoices WHERE currency<>'USD' OR period_start<$2 OR period_end>$3) AS incomplete_invoices`,
  [review.accountId,new Date(start),new Date(end)])).rows[0];
  const credits=Number(evidence.credits), cost=Number(evidence.direct)+Number(evidence.invoiced);
  if (!Number.isSafeInteger(credits) || credits<=0 || !(Number(evidence.direct)>0) || !evidence.statement_ids?.length ||
      !Number.isFinite(cost) || evidence.incomplete_calls || evidence.incomplete_invoices)
    throw new ValidationError(missingEvidence);
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
    provider_cost_budget_minor: budget, cost_budget_source: JSON.stringify({ ...review, measuredCredits:credits, providerCostMinor:cost, statementIds:evidence.statement_ids }) };
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
