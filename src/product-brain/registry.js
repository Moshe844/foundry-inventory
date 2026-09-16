'use strict';

const permissions = require('../actions/permissions');
const catalog = require('./catalog');

const clone = (value) => JSON.parse(JSON.stringify(value));
const pathJoin = (mount, path) => {
  const joined = `${mount || ''}${path === '/' ? '' : path || ''}` || '/';
  return joined.replace(/\/+/g, '/');
};
const routeRegex = (pattern) => new RegExp(`^${String(pattern)
  .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  .replace(/:([A-Za-z0-9_]+)\\\?/g, '[^/]*')
  .replace(/:([A-Za-z0-9_]+)/g, '[^/]+')}$`);

function routeLayers(router) {
  const rows = [];
  for (const layer of (router && router.stack) || []) {
    if (!layer.route) continue;
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    const methods = Object.keys(layer.route.methods || {}).filter((method) => layer.route.methods[method]);
    const declared = ((layer.route && layer.route.stack) || [])
      .map((handler) => handler.handle && handler.handle.productMetadata)
      .filter(Boolean);
    for (const path of paths) for (const method of methods) rows.push({ path, method: method.toUpperCase(), declared });
  }
  return rows;
}

class ProductBrain {
  constructor(source = catalog) {
    this.capabilities = new Map(source.capabilities.map((entry) => [entry.id, Object.freeze({ ...entry })]));
    this.destinations = new Map(source.destinations.map((entry) => [entry.id, Object.freeze({ ...entry })]));
    this.entities = new Map((source.entities || []).map((entry) => [entry.id, Object.freeze({ ...entry })]));
    this.routeFamilies = source.routeFamilies;
    this.routes = [];
  }

  capability(id) { return this.capabilities.get(id) || null; }
  destination(id) { return this.destinations.get(id) || null; }
  listCapabilities() { return [...this.capabilities.values()].map(clone); }
  listDestinations() { return [...this.destinations.values()].map(clone); }
  entity(id) { return this.entities.get(id) || null; }
  listEntities() { return [...this.entities.values()].map(clone); }

  classify(path) {
    return this.routeFamilies.find((family) => family.patterns.some((pattern) => pattern.test(path))) || null;
  }

  hasRoute(href, method = 'GET') {
    let pathname;
    try { pathname = new URL(String(href), 'http://foundry.local').pathname; } catch { return false; }
    return this.routes.some((route) => route.method === method && routeRegex(route.path).test(pathname));
  }

  routeForHref(href, method = 'GET') {
    let pathname;
    try { pathname = new URL(String(href), 'http://foundry.local').pathname; } catch { return null; }
    return this.routes.find((route) => route.method === method && routeRegex(route.path).test(pathname)) || null;
  }

  registerRouter(name, router, { mountPath = '' } = {}) {
    for (const route of routeLayers(router)) {
      const path = pathJoin(mountPath, route.path);
      const family = this.classify(path);
      const capability = family && family.capability ? this.capability(family.capability) : null;
      const explicit = route.declared.find((entry) => entry.permission);
      const readOnly = route.method === 'GET' || route.method === 'HEAD';
      this.routes.push({ name, path, method: route.method, family: family && family.id,
        internal: Boolean(family && family.internal), capabilityId: capability && capability.id,
        permission: (explicit && explicit.permission) || (family && Object.prototype.hasOwnProperty.call(family, 'permission')
          ? family.permission
          : capability && (readOnly
            ? capability.permission : capability.actionPermission || capability.permission)),
        permissionSource: explicit ? 'route' : 'capability',
        prerequisites: capability ? capability.prerequisites || [] : [],
        authorityRequirement: capability ? capability.authorityCapability || null : null,
        destinationId: capability ? capability.destination || null : null,
        sideEffects: readOnly || !capability ? [] : capability.sideEffects || [
          'Writes an audited change through StockChief\'s deterministic domain services.',
        ] });
    }
    return router;
  }

  registerRoute(name, path, method = 'GET') {
    const family = this.classify(path);
    const capability = family && family.capability ? this.capability(family.capability) : null;
    this.routes.push({ name, path, method, family: family && family.id,
      internal: Boolean(family && family.internal), capabilityId: capability && capability.id,
      permission: family && Object.prototype.hasOwnProperty.call(family, 'permission')
        ? family.permission : capability && capability.permission,
      permissionSource: 'capability', prerequisites: capability ? capability.prerequisites || [] : [],
      authorityRequirement: capability ? capability.authorityCapability || null : null,
      destinationId: capability ? capability.destination || null : null,
      sideEffects: method === 'GET' || method === 'HEAD' || !capability ? [] : capability.sideEffects || [
        'Writes an audited change through StockChief\'s deterministic domain services.',
      ] });
  }

  validate() {
    const errors = [];
    for (const destination of this.destinations.values()) {
      if (!this.capability(destination.capability)) errors.push(`Destination ${destination.id} names unknown capability ${destination.capability}.`);
      if (!destination.href || !destination.href.startsWith('/')) errors.push(`Destination ${destination.id} has no safe application path.`);
      else if (this.routes.length && !this.hasRoute(destination.href)) errors.push(`Destination ${destination.id} does not resolve to a GET route: ${destination.href}.`);
    }
    for (const entity of this.entities.values()) {
      if (!this.capability(entity.capability)) errors.push(`Entity ${entity.id} names unknown capability ${entity.capability}.`);
      if (!entity.route || !this.classify(new URL(entity.route.replace(/:[A-Za-z]+/g, 'record'), 'http://foundry.local').pathname)) {
        errors.push(`Entity ${entity.id} has no registered route family.`);
      }
      for (const context of entity.contexts || []) {
        if (!context.id || !context.route || !Array.isArray(context.aliases) || !context.aliases.length) {
          errors.push(`Entity ${entity.id} has an incomplete record-context destination.`);
          continue;
        }
        const concrete = context.route.replace(/:id|:title|:relatedId/g, 'record');
        if (!this.classify(new URL(concrete, 'http://foundry.local').pathname)) {
          errors.push(`Entity ${entity.id} context ${context.id} has no registered route family.`);
        }
        if (this.routes.length && !this.hasRoute(concrete)) {
          errors.push(`Entity ${entity.id} context ${context.id} does not resolve to a GET route: ${context.route}.`);
        }
      }
    }
    for (const route of this.routes) {
      if (!route.family) errors.push(`${route.method} ${route.path} from ${route.name} has no product metadata.`);
      if (!route.internal && !route.capabilityId) errors.push(`${route.method} ${route.path} has no capability.`);
      if (!route.internal && route.family !== 'auth' && !route.permission) errors.push(`${route.method} ${route.path} has no permission metadata.`);
      if (!route.internal && !Array.isArray(route.prerequisites)) errors.push(`${route.method} ${route.path} has no prerequisite contract.`);
      if (!route.internal && !Array.isArray(route.sideEffects)) errors.push(`${route.method} ${route.path} has no side-effect contract.`);
      if (!route.internal && !['GET', 'HEAD'].includes(route.method) && !route.sideEffects.length) {
        errors.push(`${route.method} ${route.path} has no declared side effect.`);
      }
    }
    for (const actionType of Object.keys(permissions.ACTION_PERMISSION)) {
      if (!this.actionContract(actionType)) errors.push(`Action ${actionType} has no canonical capability contract.`);
    }
    if (errors.length) {
      const error = new Error(`Product brain validation failed:\n- ${errors.join('\n- ')}`);
      error.code = 'PRODUCT_BRAIN_INVALID';
      error.problems = errors;
      throw error;
    }
    return { routeCount: this.routes.length, userFacing: this.routes.filter((route) => !route.internal).length,
      internal: this.routes.filter((route) => route.internal).length, capabilityCount: this.capabilities.size,
      destinationCount: this.destinations.size, entityCount: this.entities.size };
  }

  accessForCapability(id, membership) {
    const capability = this.capability(id);
    if (!capability) return { exists: false, available: false, allowed: false, reason: 'StockChief has no registered capability with that name.' };
    if (capability.status !== 'available') return { exists: true, available: false, allowed: false,
      capability, reason: capability.unavailableReason, prerequisites: capability.prerequisites || [] };
    const allowed = !capability.permission || permissions.can(membership, capability.permission);
    return { exists: true, available: true, allowed, capability,
      reason: allowed ? null : `Your role does not include “${permissions.LABELS[capability.permission] || capability.permission}”.` };
  }

  evaluateCapability(db, workspaceId, id, membership) {
    const access = this.accessForCapability(id, membership);
    if (!access.exists || !access.available) return { ...access, userCanExecute: false, foundryCanExecuteAutomatically: false };
    const capability = access.capability;
    let autonomy = { allowed: false, because: 'This capability is not an autonomous operation.' };
    if (capability.authorityCapability && db && workspaceId) {
      try { autonomy = require('../autopilot/capabilities').may(db, workspaceId, capability.authorityCapability); }
      catch (error) { autonomy = { allowed: false, because: error.message }; }
    }
    return { ...access, userCanExecute: access.allowed,
      foundryCanExecuteAutomatically: Boolean(access.allowed && autonomy.allowed),
      autonomyReason: access.allowed ? autonomy.because : access.reason,
      prerequisites: capability.prerequisites || [],
      destination: capability.destination ? this.destination(capability.destination) : null };
  }

  accessForHref(href, membership) {
    const raw = String(href || '');
    if (!raw.startsWith('/') || raw.startsWith('//')) {
      return { exists: false, available: false, allowed: false, reason: 'That is not a safe StockChief destination.' };
    }
    let pathname;
    try { pathname = new URL(raw, 'http://foundry.local').pathname; } catch { return { exists: false, available: false, allowed: false, reason: 'The destination is invalid.' }; }
    const family = this.classify(pathname);
    if (!family || family.internal) return { exists: false, available: false, allowed: false, reason: 'That is not a user-facing StockChief destination.' };
    const access = this.accessForCapability(family.capability, membership);
    if (!access.exists || !access.available) return access;
    const route = this.routes.length ? this.routeForHref(href) : null;
    if (this.routes.length && !route) return { ...access, exists: false, allowed: false, reason: 'That StockChief destination is not registered.' };
    const permission = route && route.permission ? route.permission : access.capability.permission;
    const allowed = !permission || permissions.can(membership, permission);
    return { ...access, route, permission, allowed,
      reason: allowed ? null : `Your role does not include “${permissions.LABELS[permission] || permission}”.` };
  }

  managerCapabilities() {
    return [...this.capabilities.values()].filter((entry) => entry.status === 'available' && entry.manager)
      .map((entry) => ({ id: entry.id, description: entry.description, ...entry.manager }));
  }

  actionContract(actionType) {
    const capability = [...this.capabilities.values()].find((entry) =>
      (entry.actionTypes || []).includes(actionType));
    if (!capability) return null;
    return { actionType, capabilityId: capability.id,
      permission: permissions.permissionForAction(actionType), destination: capability.destination,
      authorityRequirement: capability.authorityCapability || null,
      prerequisites: capability.prerequisites || [],
      sideEffects: capability.sideEffects || [
        'Creates an audited business change through the existing deterministic domain service.',
      ] };
  }

  troubleshootingFor(id, membership) {
    const access = this.accessForCapability(id, membership);
    if (!access.exists) return { canResolve: false, explanation: access.reason, action: null };
    if (!access.available) return { canResolve: false, explanation: access.reason,
      requiredFirst: access.prerequisites || [], action: null };
    const destination = access.capability.destination && this.destination(access.capability.destination);
    if (!access.allowed) return { canResolve: false, explanation: access.reason, action: null };
    return { canResolve: true,
      explanation: `Open ${destination ? destination.label : access.capability.label} to inspect the live records and the exact recovery action.`,
      action: destination ? { href: destination.href, label: `Open ${destination.label}` } : null };
  }

  capabilityPrompt() {
    return [...this.capabilities.values()].map((entry) => {
      const availability = entry.status === 'available' ? 'AVAILABLE' : `NOT AVAILABLE: ${entry.unavailableReason}`;
      return `- ${entry.id} (${entry.label}): ${availability}. ${entry.description}`;
    }).join('\n');
  }
}

const canonical = new ProductBrain();

module.exports = { ProductBrain, canonical, routeLayers };
