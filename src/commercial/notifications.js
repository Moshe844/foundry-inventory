'use strict';

const config = require('../config');
const credentials = require('../connections/credentials');
const jobs = require('../operations/postgres-job-queue');
const escapeHtml=value=>String(value||'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

function origin() {
  return String(config.connections.publicOrigin || '').replace(/\/$/, '');
}

async function queueAccountEmail(database, input) {
  const account = (await database.query('SELECT email,name FROM accounts WHERE id=$1', [input.accountId])).rows[0];
  if (!account?.email) return { created: false, skipped: 'account_email_missing' };
  const sealed = credentials.encrypt({
    to: account.email,
    subject: input.subject,
    text: input.text(account),
    html: input.html({...account,name:escapeHtml(account.name)}),
  });
  const durableDatabase = typeof database.transaction === 'function' ? database : {
    query: (statement, values = []) => database.query(statement, values),
    transaction: (operation) => operation(database),
  };
  return jobs.enqueue(durableDatabase, {
    kind: 'system.email-send',
    idempotencyKey: input.idempotencyKey,
    payload: { messageType: input.messageType, accountId:input.accountId, sealed },
    priority: 5,
    maxAttempts: 8,
    availableAt: Date.now(),
  });
}

function billingUrl() {
  return origin() ? `${origin()}/billing` : '/billing';
}

async function queuePaymentFailed(database, input) {
  const deadline = input.graceEnds ? new Date(input.graceEnds).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  }) : 'the end of the grace period';
  const url = billingUrl();
  return queueAccountEmail(database, {
    accountId: input.accountId,
    idempotencyKey: `billing-payment-failed:${input.eventId}`,
    messageType: 'billing_payment_failed',
    subject: 'Action required: update your StockChief payment method',
    text: (account) => `Hi ${account.name || 'there'},\n\nStockChief could not collect your subscription payment. Your operation remains available until ${deadline}. Update your payment method here: ${url}\n\nStockChief will become read-only if payment is not resolved by then.`,
    html: (account) => `<p>Hi ${account.name || 'there'},</p><p>StockChief could not collect your subscription payment. Your operation remains available until <strong>${deadline}</strong>.</p><p><a href="${url}">Update your payment method</a></p><p>StockChief will become read-only if payment is not resolved by then.</p>`,
  });
}

async function queueSubscriptionSuspended(database, input) {
  const url = billingUrl();
  return queueAccountEmail(database, {
    accountId: input.accountId,
    idempotencyKey: `billing-subscription-suspended:${input.accountId}:${input.expiredAt}`,
    messageType: 'billing_subscription_suspended',
    subject: 'StockChief is now read-only',
    text: (account) => `Hi ${account.name || 'there'},\n\nYour StockChief subscription is now read-only because the trial or payment grace period ended. Your business records remain available and unchanged. Restore operational access here: ${url}`,
    html: (account) => `<p>Hi ${account.name || 'there'},</p><p>Your StockChief subscription is now read-only because the trial or payment grace period ended.</p><p>Your business records remain available and unchanged.</p><p><a href="${url}">Restore operational access</a></p>`,
  });
}

async function queueUsageWarning(database,input){
  const url=billingUrl();const exhausted=input.threshold>=100;
  const policy=exhausted
    ?'Purchased usage is used next. An opted-in auto-top-up may buy your chosen pack within its spending cap. Costly optional processing pauses when no usage remains; business records remain available.'
    :'StockChief will warn you again before included usage is exhausted.';
  return queueAccountEmail(database,{
    accountId:input.accountId,idempotencyKey:`billing-usage-warning:${input.accountId}:${input.meter}:${input.periodStart}:${input.threshold}`,
    messageType:'billing_usage_warning',subject:`StockChief usage is at ${input.threshold}%`,
    text:(account)=>`Hi ${account.name||'there'},\n\nYou have used ${input.used} of ${input.included} included ${input.label.toLowerCase()} this billing period. ${policy}\n\nReview usage and billing: ${url}`,
    html:(account)=>`<p>Hi ${account.name||'there'},</p><p>You have used <strong>${input.used} of ${input.included}</strong> included ${input.label.toLowerCase()} this billing period.</p><p>${policy}</p><p><a href="${url}">Review usage and billing</a></p>`,
  });
}

module.exports = { queueAccountEmail, queuePaymentFailed, queueSubscriptionSuspended, queueUsageWarning };
