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

function translateError(err) {
  const status = err && err.status;
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
    console.error('[foundry] provider rejected the request:', err && err.message);
    return new ProviderError('Foundry could not ask the model that. This has been logged.', {
      code: 'ai_bad_request',
      status: 500,
      cause: err,
    });
  }
  // The message a customer sees asks them to check the connection, which is the
  // right thing to say and impossible to act on without knowing what failed.
  // Every other branch above logs; this one — the branch that catches
  // everything unrecognised, and so the one most likely to be hit by something
  // nobody predicted — said nothing to the operator at all.
  console.error(
    '[foundry] could not reach the model provider:',
    (err && (err.code || err.name)) || 'unknown',
    (err && err.message) || String(err)
  );
  return new ProviderError(
    'Foundry could not reach the model provider. Check the connection and try again.',
    { code: 'ai_request_failed', status: 503, retryable: true, cause: err }
  );
}

module.exports = { create };
