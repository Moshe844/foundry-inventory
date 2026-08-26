'use strict';

/**
 * Anthropic adapter.
 *
 * Uses structured outputs so the model is constrained to the schema Foundry
 * asked for rather than free prose that needs parsing. The response is still
 * validated by the caller — a constrained decode is a convenience, not a
 * security boundary.
 */

const dns = require('node:dns');
const Anthropic = require('@anthropic-ai/sdk');
const netTrust = require('../../net-trust');
const config = require('../../config');
const { ProviderError, ProviderOutputError } = require('../provider');
const { toWireSchema } = require('../../foundry/schema-tools');

/**
 * Resolve the provider over IPv4 first.
 *
 * api.anthropic.com publishes both an A and an AAAA record. This host answers
 * the AAAA and then cannot route to it — connecting to the IPv6 address fails
 * with ENETUNREACH — so every request depends on Node racing the two families
 * and abandoning the dead one inside its fallback window. That usually works,
 * which is why it fails intermittently rather than always: the log shows bursts
 * of "Connection error" through the day and overnight on scheduled runs, three
 * attempts each because the SDK had already retried twice.
 *
 * Preferring IPv4 removes the race rather than winning it. On a host with
 * working IPv6 this changes only the order things are tried, so it costs
 * nothing there either.
 */
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  /* An older runtime without the setting is no worse off than before. */
}

// The other half of reaching the provider on this machine: trusting the roots
// the machine itself trusts. Done here as well as at server start, because the
// provider is also reached from tests, scripts and scheduled work that never
// go through src/server.js.
netTrust.installSystemCertificates();

/**
 * Connection failures the machine recovers from on its own.
 *
 * An outbound socket here is refused outright — EACCES from connect, which on
 * Windows is a filtering driver saying no rather than a network failing to
 * carry the packet. It arrives in windows: a run of calls fails, and calls a
 * minute later succeed with nothing changed in between. The log shows this
 * plainly, three logged failures inside forty-five seconds and then hours of
 * quiet, and a connection opened by hand during a quiet stretch works forty
 * times out of forty.
 *
 * The SDK does retry, twice, but immediately — all three attempts land inside
 * the same few seconds and so inside the same window. That is why the customer
 * saw a failure at all: not because the machine could not be reached, but
 * because Foundry gave up in six seconds on something that clears in under a
 * minute. Waiting longer between attempts is the whole fix.
 *
 * Deliberately narrow. A refused socket and a dropped connection are worth
 * outliving; a rejected certificate, a bad key or a rejected request are not,
 * and retrying those would only make a settled answer take longer to arrive.
 */
const OUTLIVABLE = new Set(['EACCES', 'EPERM', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']);
const BACKOFF_MS = [2000, 6000, 15000];

function outlivable(err) {
  if (err && err.status) return false; // the provider answered; this is not the network
  let cursor = err;
  for (let depth = 0; cursor && depth < 5; depth += 1) {
    if (cursor.code && OUTLIVABLE.has(cursor.code)) return true;
    cursor = cursor.cause;
  }
  return false;
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Runs the call, and waits out a refusal the machine is likely to withdraw.
 *
 * Anything that is not one of those is thrown on the first attempt, translated
 * as it always was. Only the last failure is translated, so the customer is
 * told what was still true after Foundry had genuinely stopped trying.
 */
async function outlive(attempt, delays = BACKOFF_MS) {
  let last;
  for (let tries = 0; tries <= delays.length; tries += 1) {
    try {
      return await attempt();
    } catch (err) {
      last = err;
      if (!outlivable(err) || tries === delays.length) break;
      console.error(
        `[foundry] provider connection refused locally; waiting ${delays[tries] / 1000}s and trying again`
      );
      await pause(delays[tries]);
    }
  }
  throw translateError(last);
}

function create(options = {}) {
  const apiKey = options.apiKey || config.ai.apiKey;
  const model = options.model || config.ai.model;
  const effort = options.effort || config.ai.effort;
  const maxTokens = options.maxTokens || config.ai.maxTokens;

  if (!apiKey) {
    throw new ProviderError(
      'Foundry is not connected to a model provider yet. Set ANTHROPIC_API_KEY and restart.',
      { code: 'ai_not_configured', status: 503 }
    );
  }

  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120000 });

  return {
    name: 'anthropic',
    model,

    /**
     * @param {{system: string, prompt: string, schema: object, schemaName: string}} request
     */
    async complete(request) {
      const startedAt = Date.now();
      // Extended thinking is a per-tier choice, not a constant. The small
      // models Foundry uses for bounded extraction do not support it at all,
      // and would not benefit from it if they did — deciding which column
      // holds quantities is not a reasoning problem.
      const wantsThinking = effort !== 'none' && effort !== null;
      const body = {
        model,
        max_tokens: maxTokens,
        system: request.system,
        ...(wantsThinking ? { thinking: { type: 'adaptive' } } : {}),
        output_config: {
          ...(wantsThinking ? { effort } : {}),
          format: {
            type: 'json_schema',
            schema: toWireSchema(request.schema),
          },
        },
        messages: [{ role: 'user', content: request.prompt }],
      };

      const response = await outlive(() => client.messages.create(body));

      if (response.stop_reason === 'refusal') {
        throw new ProviderError('The model declined to answer that request.', {
          code: 'ai_refusal',
          status: 422,
        });
      }
      if (response.stop_reason === 'max_tokens') {
        throw new ProviderOutputError('The model ran out of room before finishing its answer.');
      }

      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');

      if (!text.trim()) {
        throw new ProviderOutputError('The model returned an empty response.');
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        throw new ProviderOutputError('The model returned output that is not valid JSON.', {
          preview: text.slice(0, 400),
        });
      }

      return {
        data,
        usage: {
          provider: 'anthropic',
          model: response.model || model,
          inputTokens: response.usage ? response.usage.input_tokens : null,
          outputTokens: response.usage ? response.usage.output_tokens : null,
          latencyMs: Date.now() - startedAt,
        },
      };
    },
  };
}

/**
 * Records a provider failure where it can actually be found afterwards.
 *
 * Standard error is only useful to whoever started the process, and on a
 * machine where more than one thing starts the server that is nobody. The same
 * failure was reported twice with no trace of a cause either time, because the
 * output went to a console that had already scrolled away or belonged to
 * another session entirely.
 *
 * So it goes to a file beside the database as well: same host, same data
 * directory, readable regardless of who launched the server. Appending, because
 * the interesting case is a pattern over time rather than the latest line.
 * Wrapped in its own try — a logger that throws would turn a bad request into a
 * crash, which is a worse failure than the one it was trying to explain.
 */
/** True when the operating system refused the socket rather than failing to route it. */
function deniedLocally(err) {
  let cursor = err;
  for (let depth = 0; cursor && depth < 5; depth += 1) {
    if (cursor.code === 'EACCES' || cursor.code === 'EPERM') return true;
    cursor = cursor.cause;
  }
  return false;
}

/** True when the chain the certificate arrived under was not one this runtime trusts. */
const CERT_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_SIGNATURE_FAILURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

function certificateRejected(err) {
  let cursor = err;
  for (let depth = 0; cursor && depth < 5; depth += 1) {
    if (cursor.code && CERT_CODES.has(cursor.code)) return true;
    cursor = cursor.cause;
  }
  return false;
}

function recordFailure(err) {
  // "Connection error." is all the SDK says when the request never reached the
  // API, and on its own it is barely more use than the sentence the customer
  // sees. What distinguishes a reset socket from a DNS failure, a refused
  // connection or an expired certificate is underneath, in the cause chain the
  // SDK wraps — so the chain is unwound and recorded with it.
  const causes = [];
  let cursor = err && err.cause;
  for (let depth = 0; cursor && depth < 4; depth += 1) {
    causes.push([
      cursor.code || cursor.name || '',
      cursor.syscall || '',
      cursor.errno === undefined ? '' : String(cursor.errno),
      cursor.hostname || cursor.host || '',
      cursor.message || '',
    ].filter(Boolean).join(' '));
    cursor = cursor.cause;
  }

  const code = (err && (err.code || err.name)) || 'unknown';
  const message = [(err && err.message) || String(err), ...causes].join(' <- ');
  const status = err && err.status;
  console.error('[foundry] provider call failed:', code, status ? 'status ' + status : '', message);

  // The value of this file is that every line in it really happened to this
  // machine. A test that invents a refused socket to check the wording would
  // write a refused socket into the record, and the next person reading it for
  // a pattern would be reading a fault nobody had.
  if (process.env.NODE_TEST_CONTEXT) return;

  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const { dataDir } = require('../../config');
    fs.appendFileSync(
      path.join(dataDir, 'provider-errors.log'),
      `${new Date().toISOString()}	${code}	${status || '-'}	${message}
`
    );
  } catch {
    /* the request already failed; losing the note is not worth a second failure */
  }
}

function translateError(err) {
  const status = err && err.status;
  // Every failure is recorded, not only the unrecognised ones. A wrong key, a
  // rate limit and an outage are all equally invisible to somebody reading a
  // calm sentence on a screen, and all three were.
  recordFailure(err);
  if (status === 401 || status === 403) {
    return new ProviderError('Foundry could not authenticate with the model provider.', {
      code: 'ai_unauthorized',
      status: 503,
      cause: err,
    });
  }
  if (status === 429) {
    return new ProviderError('The model provider is rate limiting Foundry. Try again shortly.', {
      code: 'ai_rate_limited',
      status: 503,
      retryable: true,
      cause: err,
    });
  }
  if (status && status >= 500) {
    return new ProviderError('The model provider is unavailable right now. Try again shortly.', {
      code: 'ai_unavailable',
      status: 503,
      retryable: true,
      cause: err,
    });
  }
  if (status === 400) {
    // A 400 is Foundry's own bug, not a network problem. The operator needs the
    // provider's actual complaint; the customer still sees something calm.
    return new ProviderError('Foundry could not ask the model that. This has been logged.', {
      code: 'ai_bad_request',
      status: 500,
      cause: err,
    });
  }
  // Denied locally, not unreachable. On Windows a filter driver — endpoint
  // security, a firewall — refusing an outbound socket surfaces as EACCES or
  // EPERM on connect, and telling somebody to check their connection sends
  // them to look at the one thing that is working. The connection is fine; a
  // program on this machine is not letting Foundry open it.
  if (deniedLocally(err)) {
    return new ProviderError(
      'Security software on this computer is refusing to let Foundry open the connection. '
        + 'Foundry kept trying for half a minute and it was still refused. The network itself '
        + 'is fine. Try again in a few minutes, and if it keeps happening ask whoever manages '
        + 'this machine to allow Foundry out to the model provider.',
      { code: 'ai_blocked_locally', status: 503, retryable: true, cause: err }
    );
  }

  // An intercepted certificate this runtime will not accept. Foundry adds the
  // machine's own authorities at startup, so reaching here means the runtime is
  // too old to expose them — a fact about the installation, not the network.
  if (certificateRejected(err)) {
    return new ProviderError(
      'Foundry could not verify the model provider\'s certificate. This computer inspects '
        + 'secure traffic, and the version of Node.js running Foundry is too old to read the '
        + 'certificate authorities this machine trusts. Upgrading Node.js fixes it.',
      { code: 'ai_untrusted_certificate', status: 503, cause: err }
    );
  }

  return new ProviderError(
    'Foundry could not reach the model provider. Check the connection and try again.',
    { code: 'ai_request_failed', status: 503, retryable: true, cause: err }
  );
}

// outlive and translateError are exported so the reachability rules can be
// tested without a network: which failures are worth waiting out, and what a
// customer is told about the ones that are not.
module.exports = { create, outlive, translateError };
