'use strict';

/**
 * "Undo that."
 *
 * The ledger knows the last thing this conversation did, and what became of
 * it. Undoing is never a deletion: a change that ran is undone by a new,
 * validated change the other way, shown for approval like any other; a
 * thing prepared but not yet approved is withdrawn; a draft not yet sent or
 * ordered is cancelled; a thing already sent, ordered or answered cannot be
 * undone and says so. Whatever happens, the earlier goal records it.
 */

const ledger = require('./ledger');
const { ValidationError } = require('../domain/errors');

/** What the most recent goal with a result points at, newest first. */
function findTarget(db, ctx, conversationId) {
  const turns = ledger.conversation(db, ctx, conversationId, { limit: 12 });
  const goals = turns.flatMap((t) => t.goals).reverse();
  for (const goal of goals) {
    const href = String(goal.resultHref || '').split('?')[0];
    if (!href) continue;
    let m;
    if ((m = /^\/actions\/plan\/([A-Za-z0-9_-]+)$/.exec(href))) return { goal, kind: 'plan', id: m[1] };
    if ((m = /^\/actions\/([A-Za-z0-9_-]+)$/.exec(href))) return { goal, kind: 'proposal', id: m[1] };
    if ((m = /^\/purchasing\/orders\/([A-Za-z0-9_-]+)$/.exec(href))) return { goal, kind: 'purchase_order', id: m[1] };
    if ((m = /^\/messages\/([A-Za-z0-9_-]+)$/.exec(href))) return { goal, kind: 'message', id: m[1] };
    if ((m = /^\/pricing\/proposals\/([A-Za-z0-9_-]+)$/.exec(href)) && m[1] !== 'batch') return { goal, kind: 'price', id: m[1] };
    if (/^\/pricing\/proposals\/batch$/.test(href)) return { goal, kind: 'price_batch', id: null };
    if ((m = /^\/operating-instructions\/([A-Za-z0-9_-]+)$/.exec(href))) return { goal, kind: 'instruction', id: m[1] };
    if (goal.status === 'answered' || goal.status === 'clarify' || goal.status === 'handed' || goal.status === 'refused' || goal.status === 'failed') continue;
  }
  return null;
}

/**
 * @returns {{done:boolean, said:string, href?:string, label?:string, status?:string, question?:boolean}}
 */
function undo(db, ctx, membership, target, options = {}) {
  const session = options.session || {};
  if (!target) return { done: false, said: 'There is nothing left to undo in this conversation: answers change nothing, and anything that was prepared here has already been withdrawn or run.' };
  const { goal, kind, id } = target;
  const settle = (status, said, extra = {}) => ledger.settle(db, ctx, goal.id, { status, said, ...extra });

  if (kind === 'proposal') {
    const proposals = require('../actions/proposal-service');
    const proposal = proposals.get(db, ctx.workspaceId, id);
    if (!proposal) return { done: false, said: 'That action could not be found any more.' };
    if (proposal.status === 'AWAITING_APPROVAL' || proposal.status === 'APPROVED') {
      proposals.cancel(db, ctx, id, 'undone');
      settle('withdrawn', 'Withdrawn: you asked to undo it before it ran. Nothing had changed.', { resultHref: null, resultLabel: null });
      return { done: true, said: `Withdrawn. “${goal.text.length > 60 ? `${goal.text.slice(0, 60)}…` : goal.text}” had not run yet, so nothing had changed; it is off the table now.`, status: 'done' };
    }
    if (proposal.status === 'SUCCEEDED') {
      // A transfer that ran is a transfer document; until it is dispatched,
      // undoing it is cancelling it — nothing has moved yet.
      const execution = db.prepare(`SELECT result FROM action_executions WHERE workspace_id = ? AND proposal_id = ? AND status = 'SUCCEEDED' ORDER BY finished_at DESC LIMIT 1`).get(ctx.workspaceId, id);
      const transferId = execution ? (JSON.parse(execution.result || '{}').transferId || null) : null;
      if (transferId) {
        const transferService = require('../transfers/transfer-service');
        const transfer = transferService.get(db, ctx.workspaceId, transferId);
        if (transfer && ['REQUESTED', 'APPROVED', 'PICKED'].includes(transfer.status)) {
          transferService.cancel(db, ctx, membership, transferId, { reason: 'Undone at the owner’s request before dispatch.' });
          settle('withdrawn', `Cancelled ${transfer.transfer_number || 'the transfer'} before anything was dispatched; the stock never left.`, { resultHref: `/transfers/${transferId}`, resultLabel: 'Open the cancelled transfer' });
          return { done: true, said: `Cancelled ${transfer.transfer_number || 'the transfer'}. Nothing had been dispatched, so the stock never left ${transfer.source_name || 'where it was'}.`, status: 'done', href: `/transfers/${transferId}`, label: 'Open the cancelled transfer' };
        }
        if (transfer && transfer.status !== 'RECEIVED') {
          return { done: false, said: `${transfer.transfer_number || 'That transfer'} is already ${String(transfer.status).toLowerCase()}: the stock is on its way. Receive it, then move it back, or record loss or damage on the transfer.`, href: `/transfers/${transferId}`, label: 'Open the transfer' };
        }
      }
      const actionService = require('../actions/action-service');
      const reversed = actionService.proposeCompensation(db, ctx, membership, id);
      if (reversed.kind === 'proposal') {
        return { done: true, said: 'That already ran, so StockChief worked out the change that puts it back — the same move the other way — for you to approve. Nothing is undone until you approve it.',
          href: `/actions/${reversed.proposal.proposalId}`, label: 'Review the reversal', status: 'needs_approval' };
      }
      return { done: false, said: reversed.message || reversed.question || 'That cannot be undone automatically.', href: `/actions/${id}`, label: 'Open the action' };
    }
    return { done: false, said: `That action is ${String(proposal.status).toLowerCase().replace(/_/g, ' ')}; there is nothing to undo.`, href: `/actions/${id}`, label: 'Open the action' };
  }

  if (kind === 'plan') {
    const actionService = require('../actions/action-service');
    const plan = actionService.getPlan(db, ctx.workspaceId, id);
    if (!plan) return { done: false, said: 'That plan could not be found any more.' };
    if (plan.status === 'AWAITING_APPROVAL') {
      actionService.setPlanStatus(db, ctx.workspaceId, id, 'CANCELLED');
      settle('withdrawn', 'Withdrawn: you asked to undo it before it ran. Nothing had changed.', { resultHref: null, resultLabel: null });
      return { done: true, said: `Withdrawn. The ${plan.lines ? plan.lines.length : ''} changes had not run, so nothing had changed; they are off the table now.`, status: 'done' };
    }
    return { done: false, said: 'Those changes already ran. Undo them one at a time from each action’s page, where StockChief works out the reverse for approval.', href: `/actions/plan/${id}`, label: 'Open the plan' };
  }

  if (kind === 'purchase_order') {
    const poService = require('../purchasing/po-service');
    let order = null;
    try { order = poService.get(db, ctx.workspaceId, id); } catch { order = null; }
    if (!order) return { done: false, said: 'That order could not be found any more.' };
    if (['DRAFT', 'AWAITING_APPROVAL'].includes(order.status)) {
      poService.cancel(db, ctx, membership, id, { reason: 'Undone at the owner’s request before approval.' });
      settle('withdrawn', `Cancelled: you asked to undo ${order.poNumber} before it was approved. The supplier was never told.`, { resultHref: `/purchasing/orders/${id}`, resultLabel: 'Open the cancelled draft' });
      return { done: true, said: `Cancelled ${order.poNumber}. It was a draft; the supplier was never told and nothing was ordered.`, status: 'done' };
    }
    return { done: false, said: `${order.poNumber} has already been ${String(order.status).toLowerCase().replace(/_/g, ' ')}. Cancelling a placed order is a decision for its page, with the supplier told.`, href: `/purchasing/orders/${id}#cancel`, label: `Open ${order.poNumber}` };
  }

  if (kind === 'message') {
    const comms = require('../sales/customer-communications');
    const message = comms.get(db, ctx.workspaceId, id);
    if (!message) return { done: false, said: 'That message could not be found any more.' };
    if (message.status === 'PREPARED') {
      comms.cancel(db, ctx.workspaceId, id, 'Undone at the owner’s request.');
      settle('withdrawn', 'Not sent: you asked to undo it. The draft is kept, marked not to send.', { resultHref: `/messages/${id}`, resultLabel: 'Open the draft' });
      return { done: true, said: `That message to ${message.recipient} will not be sent. It had not gone out.`, status: 'done' };
    }
    if (message.status === 'SENT') return { done: false, said: `That message to ${message.recipient} was already sent, and a sent email cannot be unsent. Write a follow-up if it was wrong.`, href: `/messages/${id}`, label: 'Open the message' };
    return { done: false, said: `That message is ${String(message.status).toLowerCase()}; there is nothing to undo.`, href: `/messages/${id}`, label: 'Open the message' };
  }

  if (kind === 'price' || kind === 'price_batch') {
    const priceChanges = require('../pricing/price-changes');
    const ids = kind === 'price' ? [id] : (Array.isArray(session.pendingPriceBatch) ? session.pendingPriceBatch : []);
    const pending = ids.map((pid) => { try { return priceChanges.get(db, ctx.workspaceId, pid); } catch { return null; } }).filter((p) => p && p.status === 'PENDING');
    if (pending.length) {
      priceChanges.cancelBatch(db, ctx.workspaceId, pending.map((p) => p.id));
      settle('withdrawn', `Withdrawn: you asked to undo ${pending.length === 1 ? 'the price change' : `${pending.length} price changes`} before approval. Prices are unchanged.`, { resultHref: null, resultLabel: null });
      return { done: true, said: `Withdrawn ${pending.length === 1 ? 'the price change' : `${pending.length} price changes`}. None had been approved, so no price changed.`, status: 'done' };
    }
    return { done: false, said: 'Those price changes were already approved. Set the price back by saying “change the price of <product> to <the old amount>”; the product page shows its price history.' };
  }

  if (kind === 'instruction') {
    const operating = require('../manager/operating-instructions');
    const rule = operating.get(db, ctx.workspaceId, id);
    if (!rule) return { done: false, said: 'That rule could not be found any more.' };
    if (rule.status === 'PENDING') {
      operating.cancel(db, ctx, id);
      settle('withdrawn', 'Withdrawn: you asked to undo the rule before it was in force.', { resultHref: null, resultLabel: null });
      return { done: true, said: 'Withdrawn. That rule was never in force.', status: 'done' };
    }
    return { done: false, said: 'That rule is already in force. Turn it off from its page, where StockChief says what it applies to.', href: `/operating-instructions/${id}`, label: 'Open the rule' };
  }

  throw new ValidationError('StockChief does not know how to undo that.');
}

/** Words that mean "undo the last thing". */
const ASKS_UNDO = /^\s*(?:please\s+)?(?:undo(?:\s+(?:that|this|it|the\s+last\s+(?:one|thing|change)))?|revert(?:\s+(?:that|this|it))?|reverse\s+(?:that|this|it)|put\s+(?:that|it)\s+back|take\s+(?:that|it)\s+back|cancel\s+(?:that|this|it)|scrap\s+(?:that|this|it)|never\s+mind(?:\s+(?:that|this|it))?|forget\s+(?:that|this|it))\s*[.!]?\s*$/i;

module.exports = { findTarget, undo, ASKS_UNDO };
