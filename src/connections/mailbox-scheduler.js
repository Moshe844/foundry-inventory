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
    /*
     * Mail captured before the relevance gate existed is judged again by the
     * same rule, and this happens before anything is asked of the network.
     *
     * Deliberately not inside syncMailbox. Reviewing records Foundry already
     * holds needs no provider at all, and on the mailbox that prompted this
     * work the provider is exactly what is unreliable — so tying the tidy-up
     * to a successful poll would mean the owner's screen stayed wrong for
     * precisely as long as their connection was down.
     */
    try { require('./mail-relevance').sweepCaptured(db, row.workspace_id, row.id); }
    catch (error) { console.error('[supplier-mailbox] could not review captured mail', error); }
    /*
     * And the same for order conversations, for the same reason.
     *
     * A customer's answer to Foundry's question is already captured by the
     * time this matters; turning it into an order needs the catalogue and the
     * reader, not the mailbox. Tying it to a successful poll would leave an
     * order unmade because a connection was down, which is the one moment it
     * costs a customer.
     */
    try {
      await require('../sales/order-from-email').draftPending(db,
        { workspaceId: row.workspace_id, actorId: row.authorized_by_user_id });
    } catch (error) { console.error('[supplier-mailbox] could not read pending orders', error); }
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
  /*
   * Parcels the carrier has gone quiet about.
   *
   * The recovery path, not the main one. Webhooks are how tracking is meant to
   * work: the carrier knows the instant a parcel is scanned and says so, while
   * polling means being wrong for up to six hours about every parcel and
   * asking about hundreds that have not moved. This exists for the webhook
   * that was missed while the machine was asleep, and for a number somebody
   * typed in by hand that no webhook was ever registered for.
   */
  const shipping = require('../shipping');
  if (shipping.provider.configured()) {
    const shipped = db.prepare(`SELECT DISTINCT workspace_id FROM sales_shipments
      WHERE status = 'SHIPPED' AND tracking_number IS NOT NULL
        AND (tracking_status IS NULL OR tracking_status NOT IN ('DELIVERED','RETURNED','CANCELLED'))`)
      .all().map((row) => row.workspace_id);
    for (const workspaceId of shipped) {
      try { await shipping.tracking.sweep(db, { workspaceId, actorId: null }, { now }); }
      catch (error) { console.error('[shipping] tracking sweep failed', error.message); }
      /*
       * And the message for anything that has gone wrong, written and left
       * unsent. Writing costs nothing and commits nobody; sending is a
       * separate act under the owner's communication authority, and this
       * never performs it. The point is that when they open the decision, the
       * message they would have had to write is already written.
       */
      try { shipping.delayNotice.prepareAll(db, { workspaceId, actorId: null }); }
      catch (error) { console.error('[shipping] delay notices were not prepared', error.message); }
    }

    /*
     * And parcels that are packed and covered by a rule.
     *
     * The whole point of a rule is that nobody has to be at a screen for it to
     * apply. Every check is inside shipWithinAuthority — the mode, the
     * capability, and the rule against fresh rates — so a workspace that has
     * granted none of that does nothing here but a cheap query.
     */
    const waiting = db.prepare(`SELECT DISTINCT workspace_id FROM sales_shipments
      WHERE status = 'PACKED' AND tracking_number IS NULL`).all().map((row) => row.workspace_id);
    for (const workspaceId of waiting) {
      try { await shipping.service.sweep(db, { workspaceId, actorId: null }, {}); }
      catch (error) { console.error('[shipping] label sweep failed', error.message); }
    }
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
