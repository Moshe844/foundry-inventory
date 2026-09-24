'use strict';

/**
 * Somebody asks StockChief to write to a customer or a supplier.
 *
 * StockChief has sent mail for a while — shipping notices, payment links,
 * purchase orders, replies to customers — but only ever as a consequence of
 * something else happening. Asked outright to email somebody, it said it could
 * not: the operation simply was not in the list of things it could choose to
 * do, so the reader picked "unsupported" and wrote a limitation that was not
 * true.
 *
 * Nothing here sends. A message goes out in the owner's name, so it is
 * written, shown, and sent only when they say so — the same rule the shipping
 * notice and the payment link already follow. The difference between those and
 * this is only who started it.
 */

const { ValidationError } = require('../domain/errors');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const compare = (value) => String(value || '').trim().toLowerCase();

/**
 * Who this is going to.
 *
 * An address is taken as written. A name is looked up among the people the
 * business already deals with — and never guessed at, because a message sent
 * to the wrong customer cannot be recalled.
 */
function findRecipient(db, workspaceId, text) {
  const raw = String(text || '').trim();
  const roleNamed = /^(?:the\s+|our\s+|my\s+|an?\s+)?(supplier|vendor|customer|client)\s+(?:named\s+|called\s+)?(.+)$/i.exec(raw);
  const roleKind = roleNamed ? (/supplier|vendor/i.test(roleNamed[1]) ? 'supplier' : 'customer') : null;
  const lookupText = roleNamed ? roleNamed[2].trim() : raw;
  const wanted = compare(lookupText);
  if (!wanted) return null;
  if (EMAIL.test(wanted)) return { kind: 'address', name: lookupText, email: lookupText };

  const exactCustomers = roleKind === 'supplier' ? [] : db.prepare(`SELECT id, name, email FROM customers
    WHERE workspace_id = ? AND name = ? COLLATE NOCASE
      AND (record_state IS NULL OR record_state <> 'ARCHIVED')`).all(workspaceId, lookupText);
  const exactSuppliers = roleKind === 'customer' ? [] : db.prepare(`SELECT id, name, email FROM suppliers
    WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND status = 'active'`).all(workspaceId, lookupText);
  const exact = [...exactCustomers.map((row) => ({ ...row, kind: 'customer' })),
    ...exactSuppliers.map((row) => ({ ...row, kind: 'supplier' }))];
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    return { kind: 'several', candidates: exact.map((row) => ({
      label: `${row.name} (${row.kind})`, value: `the ${row.kind} named ${row.name}`,
    })) };
  }

  /*
   * "Acme" is Acme Trade Supply when nobody else is called Acme. A short
   * name is taken only when it fits exactly one customer or supplier — a
   * message to the wrong one cannot be recalled, so two fits is a question.
   */
  const like = `%${lookupText.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const customers = roleKind === 'supplier' ? [] : db.prepare(`SELECT id, name, email FROM customers WHERE workspace_id = ? AND name LIKE ? ESCAPE '\\'
    AND (record_state IS NULL OR record_state <> 'ARCHIVED')`).all(workspaceId, like);
  const suppliers = roleKind === 'customer' ? [] : db.prepare(`SELECT id, name, email FROM suppliers WHERE workspace_id = ? AND name LIKE ? ESCAPE '\\'
    AND status = 'active'`).all(workspaceId, like);
  if (customers.length + suppliers.length === 1) {
    const one = customers[0] || suppliers[0];
    return { kind: customers[0] ? 'customer' : 'supplier', id: one.id, name: one.name, email: one.email };
  }
  if (customers.length + suppliers.length > 1) {
    return { kind: 'several', candidates: [
      ...customers.map((row) => ({ label: `${row.name} (customer)`, value: `the customer named ${row.name}` })),
      ...suppliers.map((row) => ({ label: `${row.name} (supplier)`, value: `the supplier named ${row.name}` })),
    ] };
  }
  return null;
}

/**
 * Write it down and show it.
 *
 * The words are the owner's. StockChief does not compose, improve or expand
 * them: a message that says more than the person asked it to say is a message
 * they did not write, going out over their name.
 */
function prepare(db, ctx, { recipientText, body, instruction }) {
  const continueWith = (needs, overrides = {}) => ({
    type: 'outbound_message', needs,
    recipientText: overrides.recipientText === undefined ? (recipientText || '') : overrides.recipientText,
    body: overrides.body === undefined ? (body || '') : overrides.body,
    instruction: instruction || '',
  });
  if (!recipientText) {
    return { kind: 'question', reason: 'missing', question: 'Who should StockChief send that to?',
      continuation: continueWith('recipient') };
  }
  /*
   * "The supplier", "our customer": a role, not a name. Understood — and
   * missing which one. The only supplier on file is the one they mean; two
   * or more is a question with the names as choices; none is a dead end
   * with the way out attached. Three different states, said as three.
   */
  const role = /^(?:the\s+|our\s+|my\s+|an?\s+)?(supplier|vendor|customer|client)s?$/i.exec(String(recipientText).trim());
  let recipient;
  if (role) {
    const kind = /supplier|vendor/i.test(role[1]) ? 'supplier' : 'customer';
    const rows = kind === 'supplier'
      ? db.prepare("SELECT id, name, email FROM suppliers WHERE workspace_id = ? AND status = 'active' ORDER BY name").all(ctx.workspaceId)
      : db.prepare("SELECT id, name, email FROM customers WHERE workspace_id = ? AND (record_state IS NULL OR record_state <> 'ARCHIVED') ORDER BY name").all(ctx.workspaceId);
    if (!rows.length) {
      return { kind: 'question', reason: 'missing',
        question: `There are no ${kind}s on file yet, so there is nobody to write to. Add the ${kind} first and say this again.`,
        where: { label: kind === 'supplier' ? 'Add a supplier' : 'Add a customer', href: kind === 'supplier' ? '/suppliers#add-supplier' : '/sales/customers/new' },
        continuation: continueWith('recipient') };
    }
    if (rows.length > 1) {
      return { kind: 'question', reason: 'ambiguous',
        question: `Which ${kind}? ${rows.slice(0, 6).map((r) => r.name).join(', ')}${rows.length > 6 ? ` and ${rows.length - 6} more` : ''}.`,
        choices: rows.slice(0, 12).map((r) => ({ label: r.name, value: `the ${kind} named ${r.name}` })),
        continuation: continueWith('recipient') };
    }
    recipient = { kind, id: rows[0].id, name: rows[0].name, email: rows[0].email };
  } else {
    recipient = findRecipient(db, ctx.workspaceId, recipientText);
  }
  if (!recipient) {
    const namedRole = /^(?:the\s+|our\s+|my\s+|an?\s+)?(supplier|vendor|customer|client)\s+(?:named\s+|called\s+)?(.+)$/i.exec(String(recipientText).trim());
    const contactName = (namedRole ? namedRole[2] : recipientText).trim();
    const requestedKind = namedRole
      ? (/supplier|vendor/i.test(namedRole[1]) ? 'supplier' : 'customer')
      : null;
    const kinds = requestedKind ? [requestedKind] : ['supplier', 'customer'];
    return { kind: 'question', reason: 'no_match',
      question: `StockChief has no ${requestedKind || 'customer or supplier'} called “${contactName}”, `
        + 'and that is not an email address. Add the right contact, or choose a different existing contact.',
      contactSetup: { name: contactName, kinds },
      choices: kinds.map((kind) => ({
        label: `Create ${contactName} as a ${kind}`,
        value: `Create ${kind} named ${contactName}`,
      })),
      continuation: continueWith('recipient') };
  }
  if (recipient.kind === 'several') {
    return { kind: 'question', reason: 'ambiguous',
      question: `“${recipientText}” matches more than one business contact. Which one: ${recipient.candidates.map((candidate) => candidate.label).join(', ')}?`,
      choices: recipient.candidates,
      continuation: continueWith('recipient_kind') };
  }
  if (!recipient.email) {
    // A dead end with the way out attached: the record that needs the address.
    return { kind: 'question', reason: 'missing_email',
      question: `There is no email address on file for ${recipient.name}, so there is nowhere to send this. Add one on their record and send this again.`,
      where: recipient.id ? { label: `Add an email for ${recipient.name}`, href: recipient.kind === 'supplier' ? `/suppliers/${recipient.id}` : `/sales/customers/${recipient.id}` } : null,
      prerequisite: recipient.id ? {
        type: 'contact_email', contactKind: recipient.kind, contactId: recipient.id, contactName: recipient.name,
      } : null,
      continuation: continueWith('email', {
        recipientText: recipient.id ? `the ${recipient.kind} named ${recipient.name}` : recipient.email,
      }) };
  }
  if (!String(body || '').trim()) {
    return { kind: 'question', reason: 'missing_body', question: `What should StockChief say to ${recipient.name}?`,
      continuation: continueWith('body', {
        recipientText: recipient.id ? `the ${recipient.kind} named ${recipient.name}` : recipient.email,
      }) };
  }

  /*
   * No mailbox is not no draft. The draft is written and shown either way;
   * its page says there is nothing to send it from and offers the words to
   * copy, or the settings to connect one. Refusing to write it left the
   * person with nothing at all.
   */
  const sending = require('../sales/customer-communications').sendingMailbox(db, ctx.workspaceId);

  return {
    kind: 'message_draft',
    recipient,
    body: String(body).trim(),
    instruction,
    mailbox: sending.connectorId ? 'ready' : sending.options.length ? 'unchosen' : 'none',
    /*
     * Deliberately not a subject StockChief invented. The owner said what they
     * wanted said; inventing a heading for it is the first step towards
     * inventing the rest.
     */
    subject: null,
  };
}

async function continuePreparation(db, ctx, state, answer, options = {}) {
  const next = state || {};
  const said = String(answer || '').trim();
  let recipientText = String(next.recipientText || '').trim();
  let body = String(next.body || '').trim();
  const roleAndBody = /^(?:it(?:'s|\s+is)\s+)?(?:the\s+)?(supplier|vendor|customer|client)(?:\s+(?:contact|record))?\s*[,;:.-]*\s*(?:(?:the\s+)?(?:email|message|note)\s*)?(?:should\s+say|says?|say|body\s*:?)\s*[,;:.-]*\s*(.+)$/i.exec(said);
  const roleOnly = /^(?:it(?:'s|\s+is)\s+)?(?:the\s+)?(supplier|vendor|customer|client)(?:\s+(?:contact|record))?\s*[.!]?$/i.exec(said);
  if (roleAndBody) {
    const kind = /supplier|vendor/i.test(roleAndBody[1]) ? 'supplier' : 'customer';
    const name = recipientText.replace(/^(?:the\s+|our\s+|my\s+)?(?:supplier|vendor|customer|client)\s+(?:named\s+|called\s+)?/i, '').trim();
    recipientText = name ? `the ${kind} named ${name}` : `the ${kind}`;
    body = roleAndBody[2].trim();
  } else if (roleOnly) {
    const kind = /supplier|vendor/i.test(roleOnly[1]) ? 'supplier' : 'customer';
    const name = recipientText.replace(/^(?:the\s+|our\s+|my\s+)?(?:supplier|vendor|customer|client)\s+(?:named\s+|called\s+)?/i, '').trim();
    recipientText = name ? `the ${kind} named ${name}` : `the ${kind}`;
  } else if (next.needs === 'recipient' || next.needs === 'recipient_kind') {
    recipientText = said;
  } else if (next.needs === 'body') {
    body = said.replace(/^(?:(?:the\s+)?(?:email|message|note)\s*)?(?:should\s+say|says?|say|body)\s*[:,.-]?\s*/i, '').trim();
  }
  return prepareOrCompose(db, ctx, {
    recipientText, body, instruction: next.instruction || '',
  }, options);
}

async function resumePreparation(db, ctx, state, options = {}) {
  const saved = state || {};
  return prepareOrCompose(db, ctx, {
    recipientText: saved.recipientText || '',
    body: saved.body || '',
    instruction: saved.instruction || '',
  }, options);
}

/**
 * Write it down, so there is a page to read it on and a button to send it.
 *
 * It goes into the same record every other customer message uses, with the
 * same PREPARED status. A draft that lived only in memory was a draft the
 * person could not find again — and, as it turned out, never saw at all.
 */
function record(db, ctx, draft) {
  if (!draft || draft.kind !== 'message_draft') {
    throw new ValidationError('There is no prepared message to record.');
  }
  const comms = require('../sales/customer-communications');
  const sending = comms.sendingMailbox(db, ctx.workspaceId);
  const message = comms.prepareOwnerMessage(db, ctx, {
    recipient: draft.recipient.email,
    customerId: draft.recipient.kind === 'customer' ? draft.recipient.id : null,
    subject: draft.subject,
    body: draft.body,
    connectorId: draft.connectorId || sending.connectorId,
    messageKind: draft.composed ? 'assistant_draft' : 'owner_message',
  });
  // The facts a composed draft was written from, kept beside it for its page.
  if (draft.composed && Array.isArray(draft.facts)) {
    try {
      db.prepare(`INSERT INTO assistant_draft_facts (message_id, workspace_id, facts, facts_used, instruction, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(message.id, ctx.workspaceId, JSON.stringify(draft.facts), JSON.stringify(draft.factsUsed || []), String(draft.instruction || '').slice(0, 2000), new Date().toISOString());
    } catch (err) { console.error('[foundry] could not keep the draft facts', err); }
  }
  return message;
}

/** Send what was approved, through the mailbox everything else goes through. */
async function send(db, ctx, membership, draft, options = {}) {
  const comms = require('../sales/customer-communications');
  const message = draft && draft.id ? draft : record(db, ctx, draft);
  if (options.subject) {
    comms.updateDraft(db, ctx.workspaceId, message.id, { subject: options.subject });
  }
  return comms.sendThroughMailbox(db, ctx.workspaceId, message.id, ctx.actorId || null);
}

/*
 * Words dictated are kept exactly; a purpose stated is written up from the
 * recipient's own records, checked, and shown as a draft with the facts it
 * used. "Email Lakeside and ask for a price list" is the second kind.
 */
async function prepareOrCompose(db, ctx, { recipientText, body, instruction }, options = {}) {
  const source = String(instruction || '');
  const fields = /\bsubject\s*:\s*([\s\S]*?)\s+body\s*:\s*([\s\S]+)$/i.exec(source);
  const routing = fields ? source.slice(0,fields.index) : source;
  const requested = /\b(?:from|using|through|via)\s+(?:the\s+)?(?:connected\s+)?(gmail|outlook|microsoft\s*365)(?:\s+mailbox)?\b/i.exec(routing);
  let connectorId = null;
  if (requested) {
    const providerType = /^gmail$/i.test(requested[1]) ? 'gmail' : 'microsoft365';
    const matches = require('../sales/customer-communications').sendingMailbox(db, ctx.workspaceId).options
      .filter((mailbox) => mailbox.provider_type === providerType);
    if (matches.length !== 1) return { kind:'question', question:matches.length
      ? `More than one ${requested[1]} mailbox is connected. Choose the exact sender before preparing this email.`
      : `No usable ${requested[1]} mailbox is connected. Reconnect or resume it first; I did not substitute another sender.` };
    connectorId = matches[0].id;
  }
  if (fields) {
    const shaped = prepare(db, ctx, { recipientText, body:fields[2].trim(), instruction });
    return shaped.kind === 'message_draft' ? { ...shaped,subject:fields[1].trim(),connectorId } : shaped;
  }
  const mailDraft = require('../assistant/mail-draft');
  const hasCompositionPurpose = /\b(?:about|regarding|concerning|asking|to\s+ask|and\s+ask|and\s+chase|and\s+tell|chase|remind)\b/i.test(routing);
  if (!String(body || '').trim() && !hasCompositionPurpose) {
    return prepare(db, ctx, { recipientText, body: '', instruction });
  }
  if (!mailDraft.wantsComposition(instruction, body)) {
    const shaped = prepare(db, ctx, { recipientText, body, instruction });
    return shaped.kind === 'message_draft' ? { ...shaped,connectorId } : shaped;
  }
  // The recipient has to be one StockChief knows before anything is written about them.
  const shaped = prepare(db, ctx, { recipientText, body: body || '(to be written)', instruction });
  if (shaped.kind !== 'message_draft') return shaped;
  const composed = await mailDraft.compose(db, ctx, {
    recipient: shaped.recipient, purpose: String(body || instruction).trim(), instruction, referentNote: options.referentNote || '',
  }, { provider: options.provider });
  if (!composed.ok) return { kind: 'question', question: composed.question };
  return { ...shaped, connectorId, body: composed.body, subject: composed.subject, composed: true, facts: composed.facts, factsUsed: composed.factsUsed };
}

module.exports = { prepare, prepareOrCompose, continuePreparation, resumePreparation, record, send, findRecipient };
