'use strict';

/*
 * Which inbound mail still owes somebody an answer.
 *
 * Foundry already classified inbound mail, but only ever along one axis: did a
 * document come out of it. That is a different question from whether a person
 * is waiting to hear back. A supplier can send an order acknowledgement that
 * matches a purchase order perfectly — processed, filed, nothing left to
 * extract — and end it with "can you confirm the new date?", which nobody has
 * answered. One status cannot carry both facts, so this is its own.
 *
 * Three drawers, in the words somebody would use about their own morning:
 *
 *   Needs a reply — a person asked something and is waiting.
 *   Waiting       — we answered; the ball is with them.
 *   Handled       — nothing is owed. Foundry filing a document counts.
 *
 * The judgement is deterministic and it explains itself. Every message carries
 * the reason it landed where it did, because an inbox that sorts your mail
 * without saying why is one you end up checking twice.
 *
 * It is also only a first guess. The owner can move anything to any drawer and
 * their choice sticks, so being wrong here costs a click rather than a
 * customer.
 */

/*
 * Phrases that mean somebody is waiting on you.
 *
 * Kept as whole phrases rather than single words: "can" and "when" appear in
 * every second sentence, but "can you" and "when will" are somebody asking.
 */
const ASKING = [
  'can you', 'could you', 'would you', 'will you', 'are you able',
  'please confirm', 'please advise', 'please let', 'please send', 'please check',
  'let me know', 'let us know', 'get back to', 'come back to me',
  'when will', 'when can', 'when do', 'when are', 'how soon', 'any update',
  'any news', 'following up', 'follow up on', 'chasing', 'checking in',
  'do you have', 'do you still', 'is it possible', 'would it be possible',
  'what is the', 'what are the', 'how much', 'how many', 'how long',
  'we need', 'i need', 'we would like', 'i would like', 'looking for',
  'confirm receipt', 'confirm that', 'advise on', 'quote for', 'quote on',
];

/*
 * Trouble, which needs an answer whether or not it was phrased as a question.
 *
 * Added after a spot check on realistic mail filed this away: "We still have
 * not received the order that was due last Tuesday." No question mark, no
 * asking phrase, and too short to read as a letter — so the single most urgent
 * message a shop can receive was quietly marked handled. A complaint is short
 * precisely because somebody is annoyed.
 */
const PROBLEM = [
  'have not received', "haven't received", 'havent received', 'not received',
  'still waiting', 'not arrived', 'never arrived', 'no sign of',
  'missing', 'short shipped', 'shorted us', 'shortage',
  'damaged', 'broken', 'faulty', 'defective', 'wrong item', 'wrong size',
  'incorrect', 'not what we ordered', 'overcharged', 'charged twice',
  'dispute', 'complaint', 'refund', 'cancel the', 'cancel my', 'cancel our',
  'urgent', 'asap', 'as soon as possible', 'still outstanding', 'overdue', 'past due',
];

/*
 * "Please" nearly always precedes an ask, with a short list of exceptions that
 * precede an attachment or a disclaimer instead.
 */
const PLEASE = /\bplease\b(?!\s+(?:find|note|see|be advised|disregard|ignore|do not|don't))/i;

/*
 * Automatic mail that reads like a question but is nobody's conversation.
 *
 * A delivery-notification robot writes "when will you collect this?" and there
 * is no person at the other end. Sending these to a reply queue is how a queue
 * fills with things that cannot be replied to.
 */
const NO_REPLY_SENDER = /(^|[.@_-])(no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon|postmaster|bounce|automated|auto-?confirm)([.@_-]|$)/i;
const AUTOMATIC_SUBJECT = /\b(out of office|automatic reply|undeliverable|delivery status notification|read receipt|unsubscribe)\b/i;

// Statuses that mean Foundry got what it needed out of this message.
const FILED = ['MATCHED', 'INVENTORY_APPLIED', 'INVENTORY_RESTORED', 'SAVED_NO_ACTION',
  'DUPLICATE', 'DUPLICATE_IGNORED', 'IGNORED'];

const clean = (value) => String(value || '').toLowerCase();

/**
 * How much of this message is somebody writing, as opposed to a signature, a
 * quoted thread and a legal footer.
 *
 * Only used to tell a bare document drop from a note, so it is deliberately
 * crude: cut the message at the first quoted reply, then count what is left.
 */
function prose(bodyText) {
  const body = String(bodyText || '');
  const cut = body.search(/\n\s*(>|On .{0,80}wrote:|-{2,}\s*Original Message|From:\s)/);
  const own = (cut > 0 ? body.slice(0, cut) : body)
    .replace(/^\s*(sent from|regards|kind regards|best|thanks|thank you|cheers)\b.*$/gim, '')
    .trim();
  return own;
}

/**
 * Where a newly captured message belongs, and why.
 *
 * Returns { state, reason }. The reason is shown to the owner verbatim, so it
 * says what was actually observed rather than naming a rule.
 */
function judge(message = {}) {
  const sender = String(message.sender || '');
  const subject = String(message.subject || '');
  const body = prose(message.bodyText !== undefined ? message.bodyText : message.body_text);
  const attachments = Number(message.attachmentCount || 0);
  const status = String(message.processingStatus || message.processing_status || 'CAPTURED');
  const text = `${clean(subject)} ${clean(body)}`;

  if (NO_REPLY_SENDER.test(sender) || AUTOMATIC_SUBJECT.test(subject)) {
    return { state: 'HANDLED', reason: 'This came from an automatic address, so there is nobody to reply to.' };
  }

  const asked = ASKING.find((phrase) => text.includes(phrase));
  const question = /\?/.test(subject) || /\?/.test(body);

  if (asked || question) {
    return {
      state: 'NEEDS_REPLY',
      reason: asked
        ? `They wrote "${asked}", so somebody is waiting on an answer.`
        : 'This message asks a question.',
    };
  }

  const trouble = PROBLEM.find((phrase) => text.includes(phrase));
  if (trouble) {
    return {
      state: 'NEEDS_REPLY',
      reason: `They mention "${trouble}". A complaint does not have to be phrased as a question.`,
    };
  }

  if (PLEASE.test(text)) {
    return { state: 'NEEDS_REPLY', reason: 'They asked you to do something.' };
  }

  if (FILED.includes(status)) {
    return { state: 'HANDLED', reason: 'Foundry took what it needed from this and filed it. Nothing was asked.' };
  }

  // A file with nothing written around it is a delivery, not a conversation.
  if (attachments > 0 && body.length < 140) {
    return { state: 'HANDLED', reason: 'This is a file with no question around it.' };
  }

  if (body.length >= 140) {
    return {
      state: 'NEEDS_REPLY',
      reason: 'Somebody wrote to you at length without asking anything Foundry recognised, so it has not assumed this is finished.',
    };
  }

  return { state: 'HANDLED', reason: 'Nothing in this asks for an answer.' };
}

module.exports = { judge, prose, ASKING, PROBLEM, PLEASE, NO_REPLY_SENDER, AUTOMATIC_SUBJECT, FILED };
