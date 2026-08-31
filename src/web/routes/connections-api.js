'use strict';

const express = require('express');
const connections = require('../../connections/service');
const ingestion = require('../../connections/event-ingestion');
const precheckout = require('../../connections/precheckout');
const { DomainError } = require('../../domain/errors');

function createConnectionsApi(db) {
  const router = express.Router();

  router.options('/precheckout', (req, res) => res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '600',
  }).status(204).end());

  router.post('/precheckout', (req, res) => {
    try {
      const auth = connections.authenticate(db, req.get('authorization'));
      const result = precheckout.evaluate(db, auth, req.body || {});
      return res.set('Access-Control-Allow-Origin', '*').json(result);
    } catch (error) {
      const status = error instanceof DomainError ? error.status : 500;
      if (!(error instanceof DomainError)) console.error('[connections] unexpected precheckout error', error);
      return res.status(status).set('Access-Control-Allow-Origin', '*').json({ error: {
        code: error.code || 'error',
        message: error instanceof DomainError ? error.message : 'Inventory could not be checked before checkout.',
      } });
    }
  });

  router.get('/events/schema', (req, res) => {
    try {
      connections.authenticate(db, req.get('authorization'));
      return res.json({
        name: 'Foundry normalized business event contract', version: '1.0',
        endpoint: '/api/v1/events', precheckoutEndpoint: '/api/v1/precheckout',
        authentication: 'Authorization: Bearer <connection token>',
        batching: { singleEvent: true, envelope: { events: 'array' }, maximumEvents: ingestion.MAX_BATCH },
        idempotency: 'eventId is required and immutable within one connection. Safe retries return replayed=true.',
        ordering: 'Use aggregateId and a monotonically increasing version for stale-event protection.',
        eventTypes: Object.freeze([
          'sale.completed', 'sales_order.created', 'sales_order.snapshot', 'sales_order.changed',
          'sales_order.fulfilled', 'sales_order.cancelled', 'return.completed', 'return.reported',
          'inventory.receipt', 'inventory.transfer', 'inventory.adjustment',
          'product.changed', 'location.changed', 'reconciliation.summary',
        ]),
        envelope: { eventId: 'provider-event-id', type: 'sale.completed', version: '1',
          aggregateId: 'order-123', occurredAt: 'ISO-8601 timestamp', data: { externalSku: 'sku-123',
            skuCode: 'ABC-123', externalLocationId: 'store-1', locationName: 'Main Store', quantity: 1 } },
      });
    } catch (error) {
      const status = error instanceof DomainError ? error.status : 500;
      return res.status(status).json({ error: { code: error.code || 'error',
        message: error instanceof DomainError ? error.message : 'The event contract could not be returned.' } });
    }
  });

  router.post('/events', (req, res) => {
    try {
      const auth = connections.authenticate(db, req.get('authorization'));
      const result = ingestion.ingestBatch(db, auth, req.body || {});
      const partial = result.needsMapping || result.failed;
      return res.status(partial ? 207 : 200).json(result);
    } catch (error) {
      const status = error instanceof DomainError ? error.status : 500;
      if (!(error instanceof DomainError)) console.error('[connections] unexpected event error', error);
      return res.status(status).json({ error: { code: error.code || 'error',
        message: error instanceof DomainError ? error.message : 'The external event could not be processed.' } });
    }
  });

  // Email providers may use a dedicated URL, but the payload is converted to
  // the same normalized event contract before any service sees it.
  router.post('/email/messages', (req, res) => {
    try {
      const auth = connections.authenticate(db, req.get('authorization'));
      if (auth.providerType !== 'supplier_email') return res.status(409).json({ error: {
        code: 'wrong_connection_type', message: 'Use a supplier email connection token for this endpoint.' } });
      const body = req.body || {};
      const result = ingestion.ingest(db, auth, { eventId: body.eventId || body.messageId,
        type: 'supplier_document.received', occurredAt: body.receivedAt, data: body });
      return res.status(result.accepted ? 200 : 207).json(result);
    } catch (error) {
      const status = error instanceof DomainError ? error.status : 500;
      if (!(error instanceof DomainError)) console.error('[connections] unexpected email error', error);
      return res.status(status).json({ error: { code: error.code || 'error',
        message: error instanceof DomainError ? error.message : 'The supplier message could not be captured.' } });
    }
  });

  return router;
}

module.exports = { createConnectionsApi };
