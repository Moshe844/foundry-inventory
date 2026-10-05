'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { ValidationError, AuthorizationError } = require('../domain/errors');
const control = require('./control-service');

function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Provide a provider cost statement object.');
  const provider = String(input.provider || '').trim().toLowerCase();
  const externalLineId = String(input.externalLineId || '').trim();
  const resourceId = String(input.resourceId || '').trim();
  const evidenceReference = String(input.evidenceReference || '').trim();
  const evidenceSha256 = String(input.evidenceSha256 || '').toLowerCase();
  const allocationBasis = String(input.allocationBasis || '').trim();
  const amountMinor = Number(input.amountMinor);
  const currency = String(input.currency || '').toUpperCase();
  const start = new Date(input.periodStart); const end = new Date(input.periodEnd);
  if (!provider || !externalLineId || !resourceId || !evidenceReference || !allocationBasis
      || !/^[a-f0-9]{64}$/.test(evidenceSha256) || !/^[A-Z]{3}$/.test(currency)
      || typeof input.amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor < 0
      || !input.periodStart || !input.periodEnd || !(end > start)
      || input.excludesAlreadyMeteredDirectCosts !== true) {
    throw new ValidationError('A provider statement needs its actual amount, currency, period, resource, evidence hash and allocation basis.');
  }
  if (!Array.isArray(input.allocations) || !input.allocations.length || input.allocations.length > 10000) {
    throw new ValidationError('Provide the measured allocation weights for the statement.');
  }
  const seen = new Set();
  const allocations = input.allocations.map(row => {
    const accountId = String(row.accountId || ''); const weight = Number(row.weight);
    if (!accountId || seen.has(accountId) || !Number.isSafeInteger(weight) || weight <= 0) {
      throw new ValidationError('Each allocated account must appear once with a positive whole-number weight.');
    }
    seen.add(accountId); return { accountId, weight };
  }).sort((a, b) => a.accountId.localeCompare(b.accountId));
  return { provider, externalLineId, resourceId, amountMinor, currency, evidenceReference, evidenceSha256,
    allocationBasis, excludesAlreadyMeteredDirectCosts: true, periodStart: start.toISOString(), periodEnd: end.toISOString(), allocations };
}

function allocate(amountMinor, rows) {
  // Integer arithmetic and largest remainders preserve every billed cent.
  const total = rows.reduce((sum, row) => sum + BigInt(row.weight), 0n);
  const allocations = rows.map(row => {
    const numerator = BigInt(amountMinor) * BigInt(row.weight);
    return { ...row, amountMinor: Number(numerator / total), remainder: numerator % total };
  });
  let remainder = amountMinor - allocations.reduce((sum, row) => sum + row.amountMinor, 0);
  const ranked = [...allocations].sort((a, b) => a.remainder === b.remainder
    ? a.accountId.localeCompare(b.accountId) : a.remainder > b.remainder ? -1 : 1);
  for (const row of ranked) { if (remainder-- <= 0) break; row.amountMinor += 1; }
  return allocations.map(({ remainder: ignored, ...row }) => row);
}

async function ingest(database, input, actorAccountId) {
  const actor = (await database.query('SELECT email FROM accounts WHERE id=$1', [actorAccountId])).rows[0];
  const admin = config.commercial.adminEmails.includes(String(actor?.email || '').toLowerCase())
    || (await database.query('SELECT 1 FROM commercial_admin_accounts WHERE account_id=$1', [actorAccountId])).rows.length > 0;
  if (!actor || !admin) throw new AuthorizationError('Only a commercial administrator can attest provider costs.');
  const statement = normalize(input);
  const snapshot = JSON.stringify(statement);
  const id = `provider-statement:${crypto.createHash('sha256').update(`${statement.provider}:${statement.externalLineId}`).digest('hex')}`;
  const allocations = allocate(statement.amountMinor, statement.allocations);
  return database.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id]);
    const prior = (await client.query('SELECT * FROM commercial_provider_cost_statements WHERE id=$1', [id])).rows[0];
    if (prior) {
      if (JSON.stringify(normalize(prior.source_snapshot)) !== snapshot) throw new ValidationError('That provider statement was already imported with different evidence or allocations.');
      return { created: false, id };
    }
    for (const row of allocations) {
      if (!(await client.query('SELECT 1 FROM accounts WHERE id=$1', [row.accountId])).rows.length) {
        throw new ValidationError('A provider statement names an unknown allocated account.');
      }
    }
    await client.query(`INSERT INTO commercial_provider_cost_statements
      (id,provider,external_line_id,resource_id,period_start,period_end,amount_minor,currency,evidence_reference,
       evidence_sha256,attested_by_account_id,allocation_basis,source_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
    [id, statement.provider, statement.externalLineId, statement.resourceId, statement.periodStart, statement.periodEnd,
      statement.amountMinor, statement.currency, statement.evidenceReference, statement.evidenceSha256, actorAccountId,
      statement.allocationBasis, snapshot]);
    for (const row of allocations) {
      await client.query(`INSERT INTO commercial_provider_cost_allocations(statement_id,account_id,weight,amount_minor)
        VALUES($1,$2,$3,$4)`, [id, row.accountId, row.weight, row.amountMinor]);
      await control.recordCost(client, { accountId: row.accountId }, {
        provider: statement.provider, operation: 'billed_resource_allocation', unit: 'statement_share', quantity: 1,
        amountMinor: row.amountMinor, currency: statement.currency, idempotencyKey: `${id}:${row.accountId}`,
        occurredAt: statement.periodStart, providerVersion: 'provider-invoice-v1',
        detail: { statementId: id, resourceId: statement.resourceId, allocationBasis: statement.allocationBasis,
          periodStart: statement.periodStart, periodEnd: statement.periodEnd,
          evidenceReference: statement.evidenceReference, evidenceSha256: statement.evidenceSha256,
          basis: 'ADMIN_ATTESTED_PROVIDER_INVOICE', excludesAlreadyMeteredDirectCosts: true },
      });
    }
    await control.audit(client, { actorAccountId, subjectType: 'provider_cost_statement', subjectId: id,
      action: 'attested_and_allocated', afterState: { ...statement, allocations },
      reason: 'Actual provider invoice line; does not clear missing-rate or coverage warnings.' });
    return { created: true, id, allocations };
  }, { isolation: 'SERIALIZABLE', retrySafe: true });
}

module.exports = { normalize, allocate, ingest };
