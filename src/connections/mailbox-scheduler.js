'use strict';

const providerService = require('./provider-service');
const connections = require('./service');

const running = new Set();
const DEFAULT_WAKE_MS = 15_000;

function failureDetails(row, error, now) {
  const message = String(error?.message || error || 'The mailbox check failed.');
  const authentication = [401, 403].includes(Number(error?.status))
    || /invalid[_ -]?grant|revoked|access expired|unauthori[sz]ed|reconnect this mailbox/i.test(message);
  if (authentication) return {
    surface: true,
    issueType: 'MAILBOX_AUTH_REQUIRED',
    title: `${row.display_name} needs to be reconnected`,
    detail: `${row.display_name} no longer accepts the saved authorization. No email was processed after access failed.`,
    resolutionHint: `Reconnect ${row.display_name}; sender rules and message history will stay in Foundry.`,
  };

  const baseline = Date.parse(row.last_synced_at || row.created_at || 0);
  const graceMinutes = Math.max(3, Number(row.expected_interval_minutes || 15));
  return {
    surface: Number.isFinite(baseline) && baseline + graceMinutes * 60_000 <= now,
    issueType: 'MAILBOX_SYNC_FAILED',
    title: `Foundry cannot currently reach ${row.display_name}`,
    detail: `The mailbox authorization is still saved, but this Foundry server could not reach ${row.display_name}. No message was lost or partly applied.`,
    resolutionHint: 'Foundry will keep retrying. If this continues, allow this computer to reach the email provider through its network or security software.',
  };
}

async function runDue(db, options = {}) {
  const now = Number(options.now || Date.now());
  const rows = db.prepare(`SELECT * FROM workspace_connectors
    WHERE provider_type IN ('gmail','microsoft365') AND status = 'connected' AND paused_at IS NULL`).all();
  const results = [];
  for (const row of rows) {
    // Subscription maintenance is independent of whether another mailbox poll
    // is due. A quiet inbox must not be the reason its webhook expires.
    await providerService.maintainMailboxWatch(db, row.workspace_id, row.id, { now });
    const config = connections.parseJson(row.config, {});
    const intervalMs = Math.max(60_000, Number(options.intervalMs
      || config.mailboxCheckMinutes * 60_000 || 5 * 60_000));
    const baseline = Date.parse(row.last_synced_at || row.created_at || 0);
    if (!options.force && Number.isFinite(baseline) && baseline + intervalMs > now) continue;
    if (running.has(row.id)) continue;
    running.add(row.id);
    try {
      results.push({ connectorId: row.id, ok: true,
        ...(await providerService.syncMailbox(db, row.workspace_id, row.id)) });
      connections.resolveIssues(db, row.workspace_id, row.id, 'MAILBOX_SYNC_FAILED');
      connections.resolveIssues(db, row.workspace_id, row.id, 'MAILBOX_AUTH_REQUIRED');
    } catch (error) {
      const problem = failureDetails(row, error, now);
      db.prepare('UPDATE workspace_connectors SET last_error = ?, updated_at = ? WHERE id = ?')
        .run(problem.detail.slice(0, 500), new Date(now).toISOString(), row.id);
      if (problem.surface) connections.issue(db, { workspaceId: row.workspace_id, connectorId: row.id,
        issueType: problem.issueType, fingerprint: `mailbox-health:${row.id}`,
        title: problem.title, detail: problem.detail, resolutionHint: problem.resolutionHint });
      results.push({ connectorId: row.id, ok: false, error: String(error.message || error) });
    } finally { running.delete(row.id); }
  }
  const workspaceIds = db.prepare(`SELECT DISTINCT workspace_id FROM purchase_orders
    WHERE status IN ('ORDERED','PARTIALLY_RECEIVED')`).all().map((row) => row.workspace_id);
  for (const workspaceId of workspaceIds) {
    const prepared = require('../purchasing/supplier-communications').prepareDueFollowups(db, workspaceId, { now });
    for (const communication of prepared) {
      try { await require('../purchasing/supplier-communications').dispatchAutomaticForOrder(
        db, workspaceId, communication.purchaseOrderId); } catch { /* durable failed outbox row is the user-facing outcome */ }
    }
  }
  return results;
}

function start(db, options = {}) {
  // Wake cheaply several times per minute. The old one-minute wake-up could
  // fall one second before a mailbox became due, skip it, and not return for
  // another full minute. runDue still enforces each mailbox's own cadence, so
  // this does not poll providers more often than the owner selected.
  const tickMs = Math.max(5_000, Number(options.tickMs || DEFAULT_WAKE_MS));
  // A restart or newly changed cadence should not leave owners waiting for the
  // first timer boundary before anything happens.
  setImmediate(() => { runDue(db).catch((error) =>
    console.error('[supplier-mailbox] initial check failed', error)); });
  const timer = setInterval(() => { runDue(db).catch((error) =>
    console.error('[supplier-mailbox] scheduled check failed', error)); }, tickMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { DEFAULT_WAKE_MS, failureDetails, runDue, start };
