'use strict';

/*
 * The providers this build knows about.
 *
 * Registering here rather than at each call site means a second provider is one
 * line in one file, and nothing above the registry ever names a company.
 */

const registry = require('./provider');

registry.register('stripe', require('./providers/stripe'));

module.exports = registry;
