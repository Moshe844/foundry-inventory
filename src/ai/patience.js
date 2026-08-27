'use strict';

/**
 * Whether anybody is waiting for the answer.
 *
 * This machine refuses outbound sockets in windows — EACCES from connect, a
 * filtering driver saying no — and the windows outlast the half minute the
 * provider spends waiting one out. Three of them survived that on the first day
 * the retries shipped.
 *
 * The obvious response, waiting longer, is only right for half the calls. A
 * person who has typed a sentence and pressed a button is owed an answer or an
 * honest failure in seconds; making them watch a spinner for four minutes is a
 * worse outcome than telling them to try again. Scheduled work has nobody
 * watching it at all, and a run that quietly takes four minutes instead of one
 * costs nothing and saves the customer an entry in Needs You explaining that
 * Foundry could not think.
 *
 * So patience is a property of the occasion, not of the call site. The
 * schedulers mark their runs unattended and everything they reach inherits it,
 * which is both less threading and harder to get wrong than asking nineteen
 * services to remember which kind of work they are doing.
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const scope = new AsyncLocalStorage();

/** Runs fn with every provider call inside it marked as having nobody waiting. */
function unattended(fn) {
  return scope.run(true, fn);
}

function nobodyIsWaiting() {
  return scope.getStore() === true;
}

module.exports = { unattended, nobodyIsWaiting };
