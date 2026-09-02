'use strict';

/*
 * The half of a briefing that faces forwards.
 *
 * Home already answers "is anything wrong" and "what did Foundry handle". What
 * an owner also wants at eight in the morning is what is about to happen —
 * what is going out, what is coming in, who is waiting on a word. An employee
 * asked how things stand does not only report the past.
 *
 * Every line here is counted from records and says a date it read rather than
 * one it worked out. Nothing is predicted: "expected Thursday" is a date a
 * supplier gave, not a guess Foundry made, and if nobody gave one the line
 * says so instead.
 *
 * Deliberately few lines and deliberately short. A briefing that lists
 * everything is a report, and a report is the thing this replaces.
 */

const WORD = {
  0: 'Sunday', 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday',
  4: 'Thursday', 5: 'Friday', 6: 'Saturday',
};

/**
 * A date said the way somebody would say it, when it is close enough to matter.
 *
 * Beyond a week the day of the week stops being useful — "Thursday" three weeks
 * out is a different Thursday — so it falls back to the date itself.
 */
function when(date, today) {
  if (!date) return null;
  const day = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return null;
  const start = new Date(`${today.toISOString().slice(0, 10)}T00:00:00Z`);
  const days = Math.round((day - start) / 86400000);
  if (days < 0) return { text: 'overdue', days };
  if (days === 0) return { text: 'today', days };
  if (days === 1) return { text: 'tomorrow', days };
  if (days <= 6) return { text: WORD[day.getUTCDay()], days };
  return { text: `on ${String(date).slice(0, 10)}`, days };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * @returns {Array<{ text: string, href: string, tone: string }>}
 */
function build(db, workspaceId, options = {}) {
  const today = new Date(options.now || Date.now());
  const lines = [];
  const safely = (fn) => { try { return fn(); } catch { return null; } };

  // Boxes packed and waiting for a carrier: the closest thing to going out.
  safely(() => {
    const packed = db.prepare(`SELECT COUNT(*) AS n FROM sales_shipments
      WHERE workspace_id = ? AND status = 'PACKED'`).get(workspaceId).n;
    if (packed) {
      lines.push({
        text: `${plural(packed, 'shipment is', 'shipments are')} packed and waiting for a carrier.`,
        href: '/fulfilment', tone: 'go',
      });
    }
  });

  // Orders with stock committed and no box started.
  safely(() => {
    const ready = db.prepare(`SELECT COUNT(DISTINCT so.id) AS n
      FROM sales_orders so
      JOIN sales_order_lines sol ON sol.sales_order_id = so.id
      JOIN sales_order_allocations soa ON soa.sales_order_line_id = sol.id
      WHERE so.workspace_id = ? AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
        AND NOT EXISTS (SELECT 1 FROM sales_shipments sh
          WHERE sh.sales_order_id = so.id AND sh.status IN ('PICKING','PACKED'))`)
      .get(workspaceId).n;
    if (ready) {
      lines.push({
        text: `${plural(ready, 'order is', 'orders are')} ready to pick.`,
        href: '/fulfilment', tone: 'go',
      });
    }
  });

  // An order the customer wants sooner than anything has been done about it.
  safely(() => {
    const due = db.prepare(`SELECT so.id, so.order_number, so.needed_by, c.name AS customer_name
      FROM sales_orders so LEFT JOIN customers c ON c.id = so.customer_id
      WHERE so.workspace_id = ? AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
        AND so.needed_by IS NOT NULL
      ORDER BY so.needed_by LIMIT 1`).get(workspaceId);
    const said = due && when(due.needed_by, today);
    if (said && said.days <= 7) {
      lines.push({
        text: said.days < 0
          ? `${due.order_number} for ${due.customer_name || 'a customer'} was wanted by ${String(due.needed_by).slice(0, 10)}.`
          : `${due.customer_name || 'A customer'} wants ${due.order_number} ${said.text}.`,
        href: `/orders/${due.id}`,
        tone: said.days < 0 ? 'late' : 'go',
      });
    }
  });

  // Stock on its way in, on the date the supplier actually gave.
  safely(() => {
    const incoming = db.prepare(`SELECT po.id, po.po_number, po.expected_date, s.name AS supplier_name
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.workspace_id = ? AND po.status IN ('ORDERED','PARTIALLY_RECEIVED')
        AND po.expected_date IS NOT NULL
      ORDER BY po.expected_date LIMIT 1`).get(workspaceId);
    const said = incoming && when(incoming.expected_date, today);
    if (said) {
      lines.push({
        text: said.days < 0
          ? `${incoming.supplier_name}'s delivery on ${incoming.po_number} was expected ${String(incoming.expected_date).slice(0, 10)} and has not arrived.`
          : `${incoming.supplier_name}'s delivery is expected ${said.text}.`,
        href: `/purchasing/orders/${incoming.id}`,
        tone: said.days < 0 ? 'late' : 'go',
      });
    }
  });

  // People waiting on a word from you.
  safely(() => {
    const waiting = db.prepare(`SELECT COUNT(*) AS n FROM connection_email_messages
      WHERE workspace_id = ? AND reply_state = 'NEEDS_REPLY'`).get(workspaceId).n;
    if (waiting) {
      lines.push({
        text: `${plural(waiting, 'message is', 'messages are')} waiting on an answer.`,
        href: '/mail', tone: 'go',
      });
    }
  });

  return lines.slice(0, 4);
}

module.exports = { build, when };
