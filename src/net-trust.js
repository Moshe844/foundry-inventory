'use strict';

/**
 * Make outbound HTTPS work on the machine Foundry is actually installed on.
 *
 * This host inspects TLS. The certificate served for api.anthropic.com is not
 * Anthropic's: it is reissued by a root called "Meshimer CA" that is installed
 * in the Windows certificate store, which is how every browser and every other
 * program on the machine accepts it without complaint. Node does not read that
 * store. It carries its own list of authorities, and a certificate signed by a
 * root it has never heard of is rejected with UNABLE_TO_VERIFY_LEAF_SIGNATURE
 * — the failure that fills the top of data/provider-errors.log.
 *
 * There is a launch flag for this, --use-system-ca, and package.json passes it.
 * That is not a fix, it is a fix that has to be remembered. Anything that runs
 * the server another way — a service wrapper, a scheduled task, a test, an
 * editor's run button, a colleague typing `node src/server.js` — loses it, and
 * loses it as an unexplained connection error rather than as a missing flag.
 * Trust belongs in the program, so it travels with the program.
 *
 * Newer runtimes already merge the system store into their defaults, so on
 * those this changes nothing. On the ones that do not, it is the difference
 * between working and not.
 */

const tls = require('node:tls');

/**
 * A certificate's identity, independent of how it was written down.
 *
 * The same certificate does not come back as the same string once it has been
 * through setDefaultCACertificates — the encoding is re-emitted with different
 * wrapping. Comparing the text would make every certificate look new on a
 * second call, and the trusted list would grow a full copy of the machine's
 * store every time this ran.
 */
const identity = (pem) => String(pem).replace(/\s+/g, '');

function installSystemCertificates() {
  // Older runtimes have neither call. There is nothing to do there but say so.
  if (typeof tls.getCACertificates !== 'function'
    || typeof tls.setDefaultCACertificates !== 'function') {
    return { applied: false, added: 0, reason: 'runtime has no system certificate store access' };
  }

  let system;
  let current;
  try {
    system = tls.getCACertificates('system');
    current = tls.getCACertificates('default');
  } catch (err) {
    return { applied: false, added: 0, reason: err.message };
  }

  const known = new Set(current.map(identity));
  const missing = [];
  for (const cert of system) {
    const key = identity(cert);
    if (known.has(key)) continue;
    known.add(key); // a store can list the same authority twice; trust it once
    missing.push(cert);
  }
  if (!missing.length) {
    return { applied: false, added: 0, reason: 'already trusted' };
  }

  try {
    // Added to what Node already trusts, never substituted for it. Replacing
    // the list would mean this machine's administrator silently deciding which
    // public authorities Foundry accepts, which is a much larger thing than
    // fixing an interception proxy.
    tls.setDefaultCACertificates([...current, ...missing]);
  } catch (err) {
    return { applied: false, added: 0, reason: err.message };
  }
  return { applied: true, added: missing.length, reason: '' };
}

module.exports = { installSystemCertificates };
