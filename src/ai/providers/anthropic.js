'use strict';

/**
 * Anthropic adapter.
 *
 * Uses structured outputs so the model is constrained to the schema Foundry
 * asked for rather than free prose that needs parsing. The response is still
 * validated by the caller — a constrained decode is a convenience, not a
 * security boundary.
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../config');
const { ProviderError, ProviderOutputError } = require('../provider');
const { toWireSchema } = require('../../foundry/schema-tools');

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
      let response;
      try {
        // Extended thinking is a per-tier choice, not a constant. The small
        // models Foundry uses for bounded extraction do not support it at all,
        // and would not benefit from it if they did — deciding which column
        // holds quantities is not a reasoning problem.
        const wantsThinking = effort !== 'none' && effort !== null;
        response = await client.messages.create({
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
        });
      } catch (err) {
        throw translateError(err);
      }

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
function recordFailure(err) {
  const code = (err && (err.code || err.name)) || 'unknown';
  const message = (err && err.message) || String(err);
  const status = err && err.status;
  console.error('[foundry] provider call failed:', code, status ? 'status ' + status : '', message);
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
  return new ProviderError(
    'Foundry could not reach the model provider. Check the connection and try again.',
    { code: 'ai_request_failed', status: 503, retryable: true, cause: err }
  );
}

module.exports = { create };
