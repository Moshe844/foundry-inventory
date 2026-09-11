'use strict';

const config = require('../config');
const credentials = require('../connections/credentials');

function unseal(payload) {
  if (!payload || !payload.sealed) return payload || {};
  const sealed = payload.sealed;
  return credentials.decrypt({
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    auth_tag: sealed.authTag || sealed.auth_tag,
  });
}

async function sendResend(message, options = {}) {
  const apiKey = options.apiKey || config.email.apiKey;
  const from = options.from || config.email.from;
  if (!apiKey || !from) {
    const error = new Error('Production email delivery is not configured.');
    error.code = 'email_not_configured';
    error.retryable = false;
    throw error;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    }),
    signal: options.signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `Email provider returned ${response.status}.`);
    error.code = 'email_delivery_failed';
    error.status = response.status;
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  return { provider: 'resend', externalId: body.id || null };
}

function dispatcher(options = {}) {
  return async (outboxMessage) => {
    const payload = unseal(outboxMessage.payload);
    const result = await sendResend(payload, options);
    if (options.db && outboxMessage.messageType === 'password_reset') {
      require('./checkpoints').record(options.db, 'password_recovery.delivery', 'PASS', {
        provider: result.provider, externalId: result.externalId,
      });
    }
    return result;
  };
}

module.exports = { unseal, sendResend, dispatcher };
