'use strict';

/** CI gate: the live Express graph must satisfy the canonical product contract. */
const { createApp } = require('../src/app');

const app = createApp({ databasePath: ':memory:', env: 'test',
  sessionSecret: 'product-brain-ci-validation-only' });
const coverage = app.locals.productBrainCoverage;
process.stdout.write(`Product brain: ${coverage.routeCount} routes (${coverage.userFacing} user-facing, ${coverage.internal} internal), `
  + `${coverage.capabilityCount} capabilities, `
  + `${coverage.destinationCount} destinations, ${coverage.entityCount} entity types.\n`);
app.locals.db.close();
