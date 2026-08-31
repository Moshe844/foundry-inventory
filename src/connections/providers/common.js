'use strict';

const crypto = require('node:crypto');
const { ValidationError, AuthenticationError } = require('../../domain/errors');

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function hmacBase64(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64');
}

function requireVerified(valid, message = 'The provider signature is invalid.') {
  if (!valid) throw new AuthenticationError(message);
}

function normalizeStoreUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new ValidationError('Enter a valid store URL.'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new ValidationError('The store URL must use HTTP or HTTPS.');
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = ''; url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function jsonRequest(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(20_000) });
  } catch (cause) {
    const error = new Error('Foundry could not reach the external service from this computer. Check its internet or security-software access; Foundry will retry safely.');
    error.code = 'PROVIDER_UNREACHABLE';
    error.transient = true;
    error.cause = cause;
    throw error;
  }
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error(body?.message || body?.error_description || body?.errors?.[0]?.detail || `Provider returned HTTP ${response.status}.`);
    error.status = response.status; error.providerBody = body;
    throw error;
  }
  return { body, headers: response.headers, status: response.status };
}

module.exports = { safeEqual, hmacBase64, requireVerified, normalizeStoreUrl, jsonRequest };
