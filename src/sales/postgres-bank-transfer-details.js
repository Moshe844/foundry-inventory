'use strict';

/*
 * The bank details a business gives customers who pay by transfer.
 *
 * Read on the order page so "Bank transfer" shows where the money should go,
 * and saved from there. Display only: nothing here initiates, matches or
 * reconciles a transfer.
 */

const { nowIso, trimOrNull } = require('../lib/util');
const { ValidationError } = require('../domain/errors');

async function get(database, workspaceId) {
  return (await database.query(`SELECT bank_name,account_name,routing_number,account_number,note
    FROM workspace_bank_transfer_details WHERE workspace_id=$1`, [workspaceId])).rows[0] || null;
}

function field(value, label, max, required) {
  const text = trimOrNull(value);
  if (required && !text) throw new ValidationError(`${label} is required.`);
  if (text && text.length > max) throw new ValidationError(`${label} is too long.`);
  return text;
}

async function save(database, ctx, input) {
  const row = {
    bankName: field(input.bankName, 'Bank name', 120, false),
    accountName: field(input.accountName, 'Account name', 160, true),
    routingNumber: field(input.routingNumber, 'Routing number', 40, false),
    accountNumber: field(input.accountNumber, 'Account number', 40, true),
    note: field(input.note, 'Note', 300, false),
  };
  await database.query(`INSERT INTO workspace_bank_transfer_details
      (workspace_id,bank_name,account_name,routing_number,account_number,note,updated_by_user_id,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (workspace_id) DO UPDATE SET bank_name=EXCLUDED.bank_name,account_name=EXCLUDED.account_name,
      routing_number=EXCLUDED.routing_number,account_number=EXCLUDED.account_number,note=EXCLUDED.note,
      updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=EXCLUDED.updated_at`,
  [ctx.workspaceId, row.bankName, row.accountName, row.routingNumber, row.accountNumber, row.note, ctx.actorId, nowIso()]);
  return row;
}

module.exports = { get, save };
