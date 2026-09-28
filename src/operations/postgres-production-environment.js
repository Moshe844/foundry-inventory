'use strict';

const config = require('../config');

function configuredOption(options, key, fallback) {
  return Object.prototype.hasOwnProperty.call(options, key) ? options[key] : fallback;
}

function validateProductionEnvironment(options = {}) {
  const env = options.env || config.env;
  if (env !== 'production') return;
  const publicOrigin = options.publicOrigin || config.connections.publicOrigin;
  const sessionSecret = options.sessionSecret || process.env.SESSION_SECRET;
  const encryptionKey = options.encryptionKey || process.env.FOUNDRY_CONNECTION_ENCRYPTION_KEY;
  const releaseRef = options.releaseRef || config.operations.releaseRef;
  const requirePaidWorkspace = options.requirePaidWorkspace === undefined
    ? (process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE === undefined
      ? env === 'production'
      : config.commercial.requirePaidWorkspace)
    : options.requirePaidWorkspace;
  const billingSecretKey = configuredOption(options, 'billingSecretKey', config.commercial.stripeSecretKey);
  const billingWebhookSecret = configuredOption(options, 'billingWebhookSecret', config.commercial.stripeWebhookSecret);
  const emailApiKey = configuredOption(options, 'emailApiKey', config.email.apiKey);
  const fromEmail = configuredOption(options, 'fromEmail', config.email.from);
  const supportEmail = configuredOption(options, 'supportEmail', config.supportEmail);
  if (!publicOrigin || !/^https:\/\/[^/]+/i.test(publicOrigin)) {
    throw new Error('Production StockChief requires an HTTPS FOUNDRY_PUBLIC_URL.');
  }
  if (options.requireSession !== false && String(sessionSecret || '').length < 32) {
    throw new Error('Production StockChief requires a stable SESSION_SECRET of at least 32 characters.');
  }
  if (String(encryptionKey || '').length < 32) {
    throw new Error('Production StockChief requires a stable FOUNDRY_CONNECTION_ENCRYPTION_KEY of at least 32 characters.');
  }
  if (!releaseRef || releaseRef === 'development') {
    throw new Error('Production StockChief requires an immutable FOUNDRY_RELEASE_REF or hosting commit identifier.');
  }
  if (requirePaidWorkspace && !billingSecretKey) {
    throw new Error('Production StockChief paid workspaces require STOCKCHIEF_BILLING_STRIPE_SECRET_KEY.');
  }
  if (requirePaidWorkspace && !billingWebhookSecret) {
    throw new Error('Production StockChief paid workspaces require STOCKCHIEF_BILLING_STRIPE_WEBHOOK_SECRET.');
  }
  if (!emailApiKey) {
    throw new Error('Production StockChief requires RESEND_API_KEY for account and billing notifications.');
  }
  if (!fromEmail) {
    throw new Error('Production StockChief requires a verified FOUNDRY_FROM_EMAIL sender.');
  }
  if (!supportEmail) {
    throw new Error('Production StockChief requires FOUNDRY_SUPPORT_EMAIL for customer support and recovery.');
  }
}

module.exports = { validateProductionEnvironment };
