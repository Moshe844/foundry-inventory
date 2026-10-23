'use strict';

/*
 * Shipping, assembled.
 *
 * The shared registry loads provider adapters for every runtime. PostgreSQL
 * selects the business's encrypted accounts per shipment; this assembly also
 * exposes the services used by the legacy application.
 */

const provider = require('./provider');

module.exports = {
  provider,
  accounts: require('./accounts'),
  referral: require('./referral'),
  shipenginePlatform: require('./shipengine-platform'),
  partner: require('./providers/easypost-partner'),
  address: require('./address'),
  service: require('./service'),
  rules: require('./rules'),
  operationPolicy: require('./operation-policy'),
  ruleIntent: require('./rule-intent'),
  tracking: require('./tracking'),
  timeline: require('./timeline'),
  delayNotice: require('./delay-notice'),
  returns: require('./returns'),
};
