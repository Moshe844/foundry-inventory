'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const env = {
  ALERT_INGEST_TOKEN: 'ingest-secret',
  ALERT_LINK_SECRET: 'link-secret',
  STOCKCHIEF_ACK_TOKEN: 'ack-secret',
  STOCKCHIEF_PUBLIC_URL: 'https://qualify.stockchiefhq.test',
  ALERT_RESPONDER: 'on-call@example.test',
  RESEND_API_KEY: 'resend-secret',
  FROM_EMAIL: 'StockChief <alerts@example.test>',
  ALERT_TO_EMAIL: 'on-call@example.test',
};

test('Cloudflare alert responder authenticates delivery and sends one actionable email', async () => {
  const { createHandler } = await import('../../infra/cloudflare/stockchief-alert-responder.mjs');
  const calls = [];
  const handler = createHandler({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ id: 'email_123' });
  } });
  const rejected = await handler.fetch(new Request('https://alerts.example.test/ingest', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  }), env);
  assert.equal(rejected.status, 401);

  const response = await handler.fetch(new Request('https://alerts.example.test/ingest', {
    method: 'POST',
    headers: { authorization: 'Bearer ingest-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'alert_123456', severity: 'critical', title: 'Worker stopped', detail: 'Queue is not moving.' }),
  }), env);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, alertId: 'alert_123456', externalId: 'email_123' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  const message = JSON.parse(calls[0].options.body);
  assert.equal(message.to[0], 'on-call@example.test');
  assert.match(message.html, /Review and acknowledge this incident/);
  assert.match(message.html, /\/ack\?id=alert_123456&amp;sig=/);
});

test('Cloudflare alert responder requires a signed human confirmation before acknowledging StockChief', async () => {
  const { createHandler, signAlertId } = await import('../../infra/cloudflare/stockchief-alert-responder.mjs');
  const calls = [];
  const handler = createHandler({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ ok: true, status: 'ACKNOWLEDGED' });
  } });
  const id = 'alert_abcdef';
  const signature = await signAlertId(id, env.ALERT_LINK_SECRET);
  const review = await handler.fetch(new Request(`https://alerts.example.test/ack?id=${id}&sig=${signature}`), env);
  assert.equal(review.status, 200);
  assert.match(await review.text(), /Acknowledge incident/);
  assert.equal(calls.length, 0);

  const body = new URLSearchParams({ id, sig: signature });
  const acknowledged = await handler.fetch(new Request('https://alerts.example.test/ack', {
    method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }), env);
  assert.equal(acknowledged.status, 200);
  assert.match(await acknowledged.text(), /Incident acknowledged/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://qualify.stockchiefhq.test/api/v1/operations/alerts/${id}/ack`);
  assert.equal(calls[0].options.headers.authorization, 'Bearer ack-secret');
  assert.deepEqual(JSON.parse(calls[0].options.body), { responder: 'on-call@example.test' });
});

test('Cloudflare alert responder rejects a forged acknowledgement link', async () => {
  const { createHandler } = await import('../../infra/cloudflare/stockchief-alert-responder.mjs');
  const handler = createHandler({ fetchImpl: async () => { throw new Error('must not call'); } });
  const response = await handler.fetch(new Request('https://alerts.example.test/ack?id=alert_abcdef&sig=forged'), env);
  assert.equal(response.status, 401);
});
