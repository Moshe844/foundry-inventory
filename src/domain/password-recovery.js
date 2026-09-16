'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const auth = require('./auth-service');
const credentials = require('../connections/credentials');
const outbox = require('../operations/outbox');
const { inTransaction } = require('../db');
const { newId, nowIso } = require('../lib/util');
const { ValidationError } = require('./errors');

const TTL_MS = 30 * 60 * 1000;
const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function request(db, emailInput, options = {}) {
  const email = String(emailInput || '').trim().toLowerCase();
  const account = db.prepare('SELECT id, email, name FROM accounts WHERE email = ? COLLATE NOCASE').get(email);
  // Identical result for an unknown address. Account enumeration is not a
  // password-recovery feature.
  if (!account) return { accepted: true, queued: false };

  const token = crypto.randomBytes(32).toString('base64url');
  const now = Number(options.now || Date.now());
  const expiresAt = now + Number(options.ttlMs || TTL_MS);
  const origin = options.origin || config.connections.publicOrigin;
  if (!origin) throw new ValidationError('Password recovery needs FOUNDRY_PUBLIC_URL configured.');

  inTransaction(db, () => {
    db.prepare(`UPDATE password_reset_tokens SET used_at = ?
      WHERE account_id = ? AND used_at IS NULL`).run(new Date(now).toISOString(), account.id);
    const id = newId('reset');
    db.prepare(`INSERT INTO password_reset_tokens
      (id, account_id, token_hash, requested_ip, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, account.id, hash(token), options.ip || null, expiresAt, new Date(now).toISOString());
    const link = `${origin.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
    const sealed = credentials.encrypt({
      to: account.email,
      subject: 'Reset your StockChief password',
      text: `Use this link within 30 minutes to reset your StockChief password:\n\n${link}\n\nIf you did not request this, you can ignore this email.`,
      html: `<p>Use the secure link below within 30 minutes to reset your StockChief password.</p>`
        + `<p><a href="${link}">Reset my password</a></p>`
        + '<p>If you did not request this, you can ignore this email.</p>',
    });
    outbox.enqueue(db, {
      destination: 'email', messageType: 'password_reset',
      idempotencyKey: id, payload: { sealed }, now,
    });
  });
  return { accepted: true, queued: true };
}

function inspect(db, token, options = {}) {
  const row = db.prepare(`SELECT prt.*, a.email FROM password_reset_tokens prt
    JOIN accounts a ON a.id = prt.account_id WHERE prt.token_hash = ?`).get(hash(token));
  const now = Number(options.now || Date.now());
  if (!row || row.used_at || row.expires_at <= now) return null;
  return row;
}

function consume(db, token, password, options = {}) {
  return inTransaction(db, () => {
    const row = inspect(db, token, options);
    if (!row) throw new ValidationError('That reset link is invalid or has expired.');
    const passwordHash = auth.hashPassword(auth.checkPasswordStrength(password));
    const used = options.nowIso || nowIso();
    db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(passwordHash, row.account_id);
    db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL')
      .run(used, row.id);
    // Every existing browser session is invalidated after a credential change.
    db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.accountId') = ?").run(row.account_id);
    return { accountId: row.account_id, email: row.email };
  });
}

module.exports = { TTL_MS, hash, request, inspect, consume };
