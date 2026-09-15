'use strict';

/*
 * The catalog is the declaration. This loader contains no second operation
 * list: every currently autonomous definition names the domain module that
 * owns its authorization, mutation and verification adapter. Adding an
 * autonomous catalog entry without an owner therefore fails startup and CI.
 */
const catalog = require('./catalog');

function load() {
  const service = require('./service');
  for (const definition of catalog.DEFINITIONS) {
    if (definition.autonomousNow) require(definition.adapterModule);
  }
  const registered = new Set(service.registeredTypes());
  const missing = catalog.DEFINITIONS
    .filter((definition) => definition.autonomousNow && !registered.has(definition.type));
  if (missing.length) {
    throw new Error(`Autonomous operation adapter coverage is incomplete: ${missing
      .map((definition) => definition.type).join(', ')}`);
  }
  return { required:catalog.DEFINITIONS.filter((definition) => definition.autonomousNow)
    .map((definition) => definition.type), registered:[...registered].sort() };
}

module.exports = { load };
