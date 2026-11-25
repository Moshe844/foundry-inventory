'use strict';

const config = require('../config');

// Microsoft reads this public client ID to verify the app's publisher domain.
// Keep the route public and exact; no other hidden files are exposed.
module.exports = (_req, res) => {
  const applicationId = config.connections.microsoft365.clientId;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(applicationId || ''))
    return res.status(404).end();
  return res.set('Cache-Control', 'public, max-age=300').json({associatedApplications:[{applicationId}]});
};
