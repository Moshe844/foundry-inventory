'use strict';

const crypto = require('node:crypto');
const { providerFetch } = require('../../lib/provider-http');

/** Which service a URL belongs to, for the record of calls. */
function providerNameFor(url) {
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (/shopify/.test(host)) return 'Shopify';
  if (/squareup/.test(host)) return 'Square';
  if (/clover/.test(host)) return 'Clover';
  if (/(^|\.)bigcommerce\.com$/.test(host)) return 'BigCommerce';
  if (/intuit|quickbooks/.test(host)) return 'QuickBooks';
  if (/xero/.test(host)) return 'Xero';
  if (/googleapis|google/.test(host)) return 'Gmail';
  if (/microsoft|graph\.microsoft/.test(host)) return 'Microsoft 365';
  return host || 'provider';
}
const { DomainError, ValidationError, AuthenticationError } = require('../../domain/errors');

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
  const url=require('./store-network').address(String(value||'').trim());
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = ''; url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function jsonRequest(url, options = {}) {
  const {selfHostedStore=false,...requestOptions}=options;
  let response;
  try {
    response = await providerFetch(url, requestOptions, { provider: options.provider || providerNameFor(url), timeoutMs: 20_000,
      ...(selfHostedStore?{fetch:require('./store-network').fetchStore}:{}) });
  } catch (cause) {
    if(cause instanceof DomainError)throw cause;
    if(cause.cause instanceof DomainError)throw cause.cause;
    // Kept as the code the sync runners already understand as transient.
    const write=!['GET','HEAD','OPTIONS'].includes(String(options.method||'GET').toUpperCase());
    const error = new Error(write?'The external service did not confirm this operation. Its outcome must be checked before it is repeated.':'The external service could not be reached. StockChief will retry this read safely.');
    error.code = 'PROVIDER_UNREACHABLE';
    error.transient = true;
    error.providerOutcomeUncertain=write;
    error.cause = cause;
    error.status = 503;
    throw error;
  }
  let text;
  try{text=await readResponseText(response);}catch(error){
    error.providerOutcomeUncertain=!['GET','HEAD','OPTIONS'].includes(String(options.method||'GET').toUpperCase());throw error;
  }
  if(response.status>=300&&response.status<400)throw new ValidationError('The store redirected an authenticated API request. Use its final HTTPS store address; no credentials were forwarded.');
  let body = null;
  try { body = text ? JSON.parse(text) : {}; } catch {
    if(response.ok){const error=new ValidationError('The external service returned an unreadable API response. Verify its API access before continuing.');error.providerOutcomeUncertain=!['GET','HEAD','OPTIONS'].includes(String(options.method||'GET').toUpperCase());throw error;}
    body={};
  }
  if (!response.ok) {
    const providerDetail = body?.Fault?.Error?.[0]?.Detail || body?.Fault?.Error?.[0]?.Message
      || body?.message || body?.error_description || body?.errors?.[0]?.detail;
    const error = new Error(providerDetail || `Provider returned HTTP ${response.status}.`);
    error.status = response.status; error.providerBody = body;
    if(response.status===429||response.status===503){
      const retry=response.headers.get('retry-after'),seconds=Number(retry);
      const delay=retry?(Number.isFinite(seconds)?seconds*1000:Date.parse(retry)-Date.now()):60_000;
      error.retryAfterMs=Math.max(60_000,Math.min(24*60*60_000,Number.isFinite(delay)?delay:60_000));
    }
    throw error;
  }
  return { body, headers: response.headers, status: response.status };
}

// A provider page must fit within a bounded transport envelope, including
// endpoints without pagination. Never trust Content-Length alone: compressed
// and chunked bodies can be larger than the advertised transfer size.
async function readResponseText(response,maxBytes=32*1024*1024){
  const tooLarge=()=>new ValidationError('The provider response is too large to process safely. Use smaller provider pages or a staged catalogue import.');
  if(Number(response.headers?.get('content-length'))>maxBytes){await response.body?.cancel();throw tooLarge();}
  if(!response.body?.getReader){const text=await response.text();if(Buffer.byteLength(text)>maxBytes)throw tooLarge();return text;}
  const reader=response.body.getReader();const chunks=[];let bytes=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;
    if(bytes>maxBytes){await reader.cancel();throw tooLarge();}chunks.push(Buffer.from(value));}
    return Buffer.concat(chunks,bytes).toString('utf8');
  }finally{reader.releaseLock();}
}

/** Preserve a provider's destination without supplying absent address parts. */
function postalAddress(parts = {}) {
  const fields = [parts.line1, parts.line2, parts.city, parts.region, parts.postalCode, parts.country];
  const values = fields.map(value => String(value || '').trim()).filter(Boolean);
  return values.length ? values.join(', ') : null;
}

module.exports = { safeEqual, hmacBase64, requireVerified, normalizeStoreUrl, jsonRequest, postalAddress, readResponseText };
