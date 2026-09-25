const encoder = new TextEncoder();

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function truncate(value, limit) {
  const text = String(value ?? '').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function equal(left, right) {
  const first = String(left ?? '');
  const second = String(right ?? '');
  if (!first || first.length !== second.length) return false;
  let difference = 0;
  for (let index = 0; index < first.length; index += 1) {
    difference |= first.charCodeAt(index) ^ second.charCodeAt(index);
  }
  return difference === 0;
}

function required(env, name) {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function alertId(value) {
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_-]{6,160}$/.test(id)) throw new Error('Invalid alert identity.');
  return id;
}

export async function signAlertId(id, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(id)));
}

async function verifyAlertId(id, signature, secret) {
  return equal(signature, await signAlertId(id, secret));
}

function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#f6f7fb;color:#15172a;margin:0}.card{max-width:640px;margin:10vh auto;background:#fff;border:1px solid #dfe2ee;border-radius:18px;padding:32px;box-shadow:0 12px 36px #1b1f3a18}h1{margin-top:0}.button{display:inline-block;border:0;border-radius:10px;background:#5146e5;color:#fff;padding:12px 18px;font-weight:700;cursor:pointer}.muted{color:#62677c}</style></head><body><main class="card">${body}</main></body></html>`, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

async function sendAlertEmail(alert, request, env, fetchImpl) {
  const id = alertId(alert.id);
  const signature = await signAlertId(id, required(env, 'ALERT_LINK_SECRET'));
  const origin = new URL(request.url).origin;
  const acknowledgeUrl = `${origin}/ack?id=${encodeURIComponent(id)}&sig=${encodeURIComponent(signature)}`;
  const severity = truncate(alert.severity || 'ERROR', 24).toUpperCase();
  const title = truncate(alert.title || 'StockChief operational alert', 180);
  const detail = truncate(alert.detail || 'No additional detail was provided.', 4000);
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${required(env, 'RESEND_API_KEY')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: required(env, 'FROM_EMAIL'),
      to: [required(env, 'ALERT_TO_EMAIL')],
      subject: `[StockChief ${severity}] ${title}`,
      text: `${title}\n\n${detail}\n\nAcknowledge this incident: ${acknowledgeUrl}`,
      html: `<h1>${escapeHtml(title)}</h1><p><strong>Severity:</strong> ${escapeHtml(severity)}</p><p>${escapeHtml(detail).replaceAll('\n', '<br>')}</p><p><a href="${escapeHtml(acknowledgeUrl)}">Review and acknowledge this incident</a></p><p>Alert ${escapeHtml(id)} · occurrence ${Number(alert.occurrenceCount || 1)}</p>`,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || `Resend returned ${response.status}.`);
  return { id, externalId: result.id || null };
}

async function ingest(request, env, fetchImpl) {
  const authorization = String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!equal(authorization, required(env, 'ALERT_INGEST_TOKEN'))) return json({ error: 'unauthorized' }, 401);
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 32 * 1024) return json({ error: 'payload_too_large' }, 413);
  const alert = await request.json().catch(() => null);
  if (!alert || typeof alert !== 'object') return json({ error: 'invalid_json' }, 400);
  try {
    const delivered = await sendAlertEmail(alert, request, env, fetchImpl);
    return json({ ok: true, alertId: delivered.id, externalId: delivered.externalId }, 202);
  } catch (error) {
    return json({ error: 'delivery_failed', message: error.message }, 502);
  }
}

async function acknowledgeForm(request, env, fetchImpl) {
  const form = await request.formData();
  const id = alertId(form.get('id'));
  const signature = String(form.get('sig') || '');
  if (!await verifyAlertId(id, signature, required(env, 'ALERT_LINK_SECRET'))) {
    return page('Invalid acknowledgment', '<h1>This acknowledgment link is invalid.</h1>', 401);
  }
  const stockchief = required(env, 'STOCKCHIEF_PUBLIC_URL').replace(/\/$/, '');
  const response = await fetchImpl(`${stockchief}/api/v1/operations/alerts/${encodeURIComponent(id)}/ack`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${required(env, 'STOCKCHIEF_ACK_TOKEN')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ responder: required(env, 'ALERT_RESPONDER') }),
  });
  if (response.ok) return page('Incident acknowledged', '<h1>Incident acknowledged</h1><p>StockChief recorded your response. Continue investigation in Production operations.</p>');
  if (response.status === 404) return page('Incident already handled', '<h1>This incident was already handled.</h1><p class="muted">No duplicate acknowledgment was recorded.</p>');
  return page('Acknowledgment failed', `<h1>StockChief did not accept the acknowledgment.</h1><p class="muted">HTTP ${response.status}. Try again or open Production operations.</p>`, 502);
}

async function acknowledgePage(request, env) {
  const url = new URL(request.url);
  const id = alertId(url.searchParams.get('id'));
  const signature = String(url.searchParams.get('sig') || '');
  if (!await verifyAlertId(id, signature, required(env, 'ALERT_LINK_SECRET'))) {
    return page('Invalid acknowledgment', '<h1>This acknowledgment link is invalid.</h1>', 401);
  }
  return page('Acknowledge incident', `<h1>Acknowledge StockChief incident</h1><p>Confirm that a monitored responder has seen alert <strong>${escapeHtml(id)}</strong>.</p><form method="post" action="/ack"><input type="hidden" name="id" value="${escapeHtml(id)}"><input type="hidden" name="sig" value="${escapeHtml(signature)}"><button class="button" type="submit">Acknowledge incident</button></form>`);
}

export function createHandler({ fetchImpl = fetch } = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      try {
        if (request.method === 'GET' && url.pathname === '/') return json({ ok: true, service: 'stockchief-alert-responder' });
        if (request.method === 'POST' && url.pathname === '/ingest') return ingest(request, env, fetchImpl);
        if (request.method === 'GET' && url.pathname === '/ack') return acknowledgePage(request, env);
        if (request.method === 'POST' && url.pathname === '/ack') return acknowledgeForm(request, env, fetchImpl);
        return json({ error: 'not_found' }, 404);
      } catch (error) {
        return json({ error: 'request_failed', message: error.message }, 400);
      }
    },
  };
}

export default createHandler();
