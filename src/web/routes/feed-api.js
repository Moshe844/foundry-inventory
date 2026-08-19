'use strict';

const express = require('express');
const feed = require('../../connectors/event-feed');
const { DomainError } = require('../../domain/errors');

/**
 * Machine-to-machine boundary. Mounted before cookie sessions and CSRF: bearer
 * authentication is the request identity, and no browser credential is used.
 */
function createFeedApi(db) {
  const router = express.Router();

  router.post('/events', (req, res) => {
    try {
      const auth = feed.authenticate(db, req.get('authorization'));
      const result = feed.ingestBatch(db, auth, req.body || {});
      return res.status(result.rejected ? 207 : 200).json(result);
    } catch (error) {
      const status = error instanceof DomainError ? error.status : 500;
      if (!(error instanceof DomainError)) console.error('[feed] unexpected error', error);
      return res.status(status).json({
        error: {
          code: error.code || 'error',
          message: error instanceof DomainError
            ? error.message
            : 'The operating event could not be processed.',
        },
      });
    }
  });

  return router;
}

module.exports = { createFeedApi };
