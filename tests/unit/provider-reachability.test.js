'use strict';

/**
 * Reaching the model provider from the machine Foundry is installed on.
 *
 * Two failures were being reported to customers as one sentence — "Foundry
 * could not reach the model provider. Check the connection and try again." —
 * and neither of them was the connection.
 *
 * The first was the certificate. This host inspects TLS and reissues
 * certificates under a root held in the Windows store, which Node does not
 * read; the runtime rejected a certificate every other program on the machine
 * accepts. There is a launch flag for it, and relying on a launch flag means
 * the fix survives exactly as long as everybody remembers to type it.
 *
 * The second was the socket being refused outright — EACCES from connect, a
 * filtering driver saying no — in windows lasting under a minute. Foundry gave
 * up after three attempts inside six seconds, so a fault the machine cleared on
 * its own reached the customer as a failure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');

const netTrust = require('../../src/net-trust');
const anthropic = require('../../src/ai/providers/anthropic');

/** The failure shape the SDK produces: a flat message wrapping the real cause. */
function connectionError(code, message) {
  const wire = new Error(message || 'connection failed');
  wire.code = code;
  wire.syscall = 'connect';
  const wrapped = new Error('Connection error.');
  wrapped.cause = Object.assign(new TypeError('fetch failed'), { cause: wire });
  return wrapped;
}

test("Foundry trusts the certificate authorities this machine trusts", () => {
  if (typeof tls.getCACertificates !== 'function') return; // nothing to prove on an older runtime

  const restore = tls.getCACertificates('default');
  try {
    // A runtime that carries only its own list — which is what produced
    // UNABLE_TO_VERIFY_LEAF_SIGNATURE against the inspected connection.
    tls.setDefaultCACertificates(tls.getCACertificates('bundled'));
    const system = tls.getCACertificates('system');
    const key = (pem) => String(pem).replace(/\s+/g, '');
    const before = new Set(tls.getCACertificates('default').map(key));
    const missing = system.filter((cert) => !before.has(key(cert)));

    const result = netTrust.installSystemCertificates();

    if (missing.length) {
      assert.equal(result.applied, true, 'the machine had roots Node did not carry');
      assert.ok(result.added > 0, 'and they were added');
      // The machine store lists an authority once per store it sits in, so the
      // number added is the number of distinct ones, not the number read.
      assert.ok(result.added <= missing.length, 'each one added once, not once per listing');
    }
    const after = new Set(tls.getCACertificates('default').map(key));
    for (const cert of system) {
      assert.ok(after.has(key(cert)), 'every authority this machine trusts is now trusted');
    }
    for (const cert of tls.getCACertificates('bundled')) {
      assert.ok(after.has(key(cert)), 'and nothing Node already trusted was taken away');
    }

    // Running it again must not stack a second copy of the machine's store.
    const size = tls.getCACertificates('default').length;
    netTrust.installSystemCertificates();
    assert.equal(tls.getCACertificates('default').length, size,
      'trusting the same authorities twice does not double the list');
  } finally {
    tls.setDefaultCACertificates(restore);
  }
});

test('trusting the machine twice changes nothing the second time', () => {
  if (typeof tls.getCACertificates !== 'function') return;
  netTrust.installSystemCertificates();
  const again = netTrust.installSystemCertificates();
  assert.equal(again.applied, false);
  assert.equal(again.added, 0);
  assert.equal(again.reason, 'already trusted');
});

test('a refused socket is waited out, not reported', async () => {
  let attempts = 0;
  const answer = await anthropic.outlive(async () => {
    attempts += 1;
    if (attempts < 3) throw connectionError('EACCES', 'connect EACCES 160.79.104.10:443');
    return { ok: true };
  }, [1, 1, 1]);

  assert.deepEqual(answer, { ok: true }, 'the call that eventually worked is the answer');
  assert.equal(attempts, 3, 'and Foundry kept trying across the window');
});

test('a refusal that never lifts is explained as the machine, not the network', async () => {
  let attempts = 0;
  await assert.rejects(
    () => anthropic.outlive(async () => {
      attempts += 1;
      throw connectionError('EACCES', 'connect EACCES 160.79.104.10:443');
    }, [1, 1, 1]),
    (err) => {
      assert.equal(err.code, 'ai_blocked_locally');
      assert.match(err.message, /Security software on this computer/);
      assert.doesNotMatch(err.message, /Check the connection/,
        'the connection is the one part that was working');
      return true;
    }
  );
  assert.equal(attempts, 4, 'every attempt was spent before giving up');
});

test('a rejected certificate is answered at once, and names the real cause', async () => {
  let attempts = 0;
  await assert.rejects(
    () => anthropic.outlive(async () => {
      attempts += 1;
      throw connectionError('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate');
    }, [1, 1, 1]),
    (err) => {
      assert.equal(err.code, 'ai_untrusted_certificate');
      assert.match(err.message, /inspects secure traffic/);
      return true;
    }
  );
  assert.equal(attempts, 1, 'waiting does not make an untrusted certificate trusted');
});

test('an answer from the provider is never retried, however it reads', async () => {
  for (const [status, code] of [[401, 'ai_unauthorized'], [400, 'ai_bad_request']]) {
    let attempts = 0;
    await assert.rejects(
      () => anthropic.outlive(async () => {
        attempts += 1;
        const err = new Error('rejected');
        err.status = status;
        throw err;
      }, [1, 1, 1]),
      (err) => {
        assert.equal(err.code, code);
        return true;
      }
    );
    assert.equal(attempts, 1, `a ${status} is a settled answer, not a bad moment`);
  }
});

test('the provider still says which failures may be tried again', () => {
  const blocked = anthropic.translateError(connectionError('EACCES', 'connect EACCES'));
  assert.equal(blocked.retryable, true, 'a filtering driver changes its mind');

  const untrusted = anthropic.translateError(
    connectionError('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify')
  );
  assert.notEqual(untrusted.retryable, true, 'an untrusted root does not');
});
