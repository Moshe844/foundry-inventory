'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { newId, nowIso } = require('../lib/util');

function encrypt(value, key = config.connectionEncryptionKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64') };
}

function decrypt(row, key = config.connectionEncryptionKey) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext);
}

function put(db, workspaceId, connectorId, kind, value, expiresAt = null) {
  const sealed = encrypt(value);
  const now = nowIso();
  db.prepare(`INSERT INTO connection_credentials
    (id, workspace_id, connector_id, credential_kind, ciphertext, iv, auth_tag, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, connector_id, credential_kind) DO UPDATE SET
      ciphertext = excluded.ciphertext, iv = excluded.iv, auth_tag = excluded.auth_tag,
      expires_at = excluded.expires_at, updated_at = excluded.updated_at`)
    .run(newId('ccred'), workspaceId, connectorId, kind, sealed.ciphertext, sealed.iv, sealed.authTag,
      expiresAt, now, now);
}

function get(db, workspaceId, connectorId, kind) {
  const row = db.prepare(`SELECT * FROM connection_credentials
    WHERE workspace_id = ? AND connector_id = ? AND credential_kind = ?`)
    .get(workspaceId, connectorId, kind);
  return row ? decrypt(row) : null;
}

function remove(db, workspaceId, connectorId) {
  db.prepare('DELETE FROM connection_credentials WHERE workspace_id = ? AND connector_id = ?')
    .run(workspaceId, connectorId);
}

module.exports = { encrypt, decrypt, put, get, remove };
