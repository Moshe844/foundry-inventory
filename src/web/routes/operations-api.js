'use strict';

const crypto = require('node:crypto');
const express = require('express');
const config = require('../../config');
const monitoring = require('../../operations/monitoring');

function equal(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function createOperationsApi(db) {
  const router = express.Router();
  router.post('/alerts/:id/ack', (req, res) => {
    const expected = config.operations.alertAckToken;
    const presented = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '')
      || String(req.body && req.body.token || '');
    if (!expected || !equal(presented, expected)) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'Invalid responder token.' } });
    }
    const alert = monitoring.acknowledge(db, req.params.id,
      req.body && req.body.responder || 'external responder');
    if (!alert) return res.status(404).json({ error: { code: 'not_found', message: 'Alert not found or already handled.' } });
    return res.json({ ok: true, alertId: alert.id, status: alert.status });
  });
  return router;
}

module.exports = { createOperationsApi, equal };

