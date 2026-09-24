'use strict';

const config = require('../config');

function validateProductionEnvironment(options = {}) {
  const env = options.env || config.env;
  if (env !== 'production') return;
  const publicOrigin = options.publicOrigin || config.connections.publicOrigin;
  const sessionSecret = options.sessionSecret || process.env.SESSION_SECRET;
  const encryptionKey = options.encryptionKey || process.env.FOUNDRY_CONNECTION_ENCRYPTION_KEY;
  const releaseRef = options.releaseRef || config.operations.releaseRef;
  if (!publicOrigin || !/^https:\/\/[^/]+/i.test(publicOrigin)) {
    throw new Error('Production StockChief requires an HTTPS FOUNDRY_PUBLIC_URL.');
  }
  if (options.requireSession !== false && String(sessionSecret || '').length < 32) {
    throw new Error('Production StockChief requires a stable SESSION_SECRET of at least 32 characters.');
  }
  if (String(encryptionKey || '').length < 32) {
    throw new Error('Production StockChief requires a stable FOUNDRY_CONNECTION_ENCRYPTION_KEY of at least 32 characters.');
  }
  if (!releaseRef || releaseRef === 'development') {
    throw new Error('Production StockChief requires an immutable FOUNDRY_RELEASE_REF or hosting commit identifier.');
  }
}

module.exports = { validateProductionEnvironment };
