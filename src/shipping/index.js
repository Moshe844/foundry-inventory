'use strict';

/*
 * Shipping, assembled.
 *
 * The registration lives here rather than in the provider file so that the
 * seam has no opinion about who is behind it — the same arrangement the
 * payment providers use.
 *
 * Two are registered. Which one is used comes from SHIPPING_PROVIDER, and
 * otherwise from whichever has a key configured — a shop has one shipping
 * account, not a choice to make on every parcel. Adding Shippo changed no file
 * but this one and its own, which is the only real test of whether the seam
 * was an abstraction or a wish.
 */

const provider = require('./provider');

provider.register('shipengine', require('./providers/shipengine'));
provider.register('shipstation', require('./providers/shipstation'));
provider.register('easypost', require('./providers/easypost'));
provider.register('shippo', require('./providers/shippo'));

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
