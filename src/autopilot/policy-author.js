'use strict';

/**
 * Turning "handle ordinary transfers yourself" into a policy someone can read.
 *
 * The division of labour is the whole point, and it is the same one used
 * everywhere else in Foundry: the model reads English, and nothing else.
 *
 * It may propose a name, pick locations by the names the customer used, and
 * suggest a ceiling. It cannot invent an action type Foundry does not automate,
 * cannot drop a safety condition, cannot approve anything, and cannot produce a
 * policy without a limit — every one of those is re-decided here in ordinary
 * code after the model has spoken, against the workspace's real locations.
 *
 * What comes out is a *proposal*. It authorises nothing until a person reads it
 * and approves it, and then only while the workspace is set to run itself. A
 * sentence typed into a box must never be one step from autonomous execution.
 */

const config = require('../config');
const { createProviderForTier } = require('../ai/provider');
const { validate: validateSchema } = require('../foundry/validator');
const { toWireSchema } = require('../foundry/schema-tools');
const repo = require('../domain/repository');
const policyService = require('./policy-service');
const { ValidationError } = require('../domain/errors');

const MAX_INSTRUCTION = 600;

/**
 * Deliberately small. The model chooses a name, a ceiling, and which of the
 * customer's locations they meant — nothing that decides whether an action is
 * safe.
 */
const POLICY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['understood', 'name', 'maximumQuantity', 'locationNames', 'dailyLimit', 'unsupportedReason'],
  properties: {
    understood: {
      type: 'boolean',
      description: 'True only if they are asking Foundry to move stock between their own locations by itself.',
    },
    name: { type: 'string', description: 'A short name they would recognise on a list.' },
    maximumQuantity: {
      type: 'integer',
      description: 'The most Foundry may move in one go. Use the number they said. 0 if they gave none.',
    },
    dailyLimit: {
      type: 'integer',
      description: 'How many such moves a day, if they said. 0 if they did not.',
    },
    locationNames: {
      type: 'array',
      items: { type: 'string' },
      description: 'Locations they named, verbatim. Empty if they named none.',
    },
    unsupportedReason: {
      type: 'string',
      description: 'If understood is false, one plain sentence saying what Foundry cannot automate.',
    },
  },
};

const SYSTEM = `
You read one sentence from a business owner about what their inventory system
may do without asking, and turn it into structured fields. You are not deciding
whether anything is safe; other code does that and will overrule you.

Foundry can automate exactly one thing: moving stock between the customer's own
locations. It cannot automatically buy, sell, adjust counts, correct
discrepancies, contact suppliers, or send orders. If they are asking for any of
those, set understood to false and say plainly which part it cannot do.

Never invent a quantity. If they did not give a limit, use 0 — asking them is
better than choosing for them.
`.trim();

function prompt(instruction, locations) {
  return [
    'The business owner said:',
    `"""${instruction}"""`,
    '',
    'Their locations are:',
    ...locations.map((l) => `- ${l.name}`),
    '',
    'Return the fields. Use their words for the name where you can.',
  ].join('\n');
}

/** Matches a name the model returned back to a real location, or nothing. */
function resolveLocations(locations, names) {
  const found = [];
  for (const name of names || []) {
    const wanted = String(name).trim().toLowerCase();
    if (!wanted) continue;
    const match =
      locations.find((l) => l.name.toLowerCase() === wanted) ||
      locations.find((l) => l.name.toLowerCase().includes(wanted)) ||
      locations.find((l) => wanted.includes(l.name.toLowerCase()));
    if (match && !found.some((f) => f.id === match.id)) found.push(match);
  }
  return found;
}

/**
 * Reads the instruction and returns a policy draft plus the questions that
 * still need answering. Never writes anything.
 */
async function draft(db, workspaceId, instruction, options = {}) {
  const clean = String(instruction || '').trim().slice(0, MAX_INSTRUCTION);
  if (!clean) throw new ValidationError('Say what you would like Foundry to handle by itself.');
  if (!options.provider && !config.ai.configured) {
    throw new ValidationError('Foundry needs an AI provider configured to read that.');
  }

  const locations = repo.listLocations(db, workspaceId).filter((l) => !l.archived_at);
  const provider = options.provider || createProviderForTier('standard');

  const response = await provider.complete({
    system: SYSTEM,
    prompt: prompt(clean, locations),
    schema: POLICY_SCHEMA,
    schemaName: 'automation_policy_draft',
  });

  const result = validateSchema(toWireSchema(POLICY_SCHEMA), response.data, { key: 'policy-draft-wire' });
  if (!result.ok) {
    return { understood: false, unsupportedReason: 'Foundry could not work out what that meant.', questions: [] };
  }
  const read = result.data;

  if (!read.understood) {
    return {
      understood: false,
      unsupportedReason:
        read.unsupportedReason ||
        'Foundry only automates moving stock between your own locations. Everything else it prepares for you.',
      questions: [],
    };
  }

  // Everything from here is decided in code. The model's answer is raw material.
  const scoped = resolveLocations(locations, read.locationNames);
  const questions = [];

  // Locations: two or more, or it is not a transfer between them. Naming none is
  // taken as "all of mine", which is stated back rather than assumed silently.
  let locationScope = scoped.map((l) => l.id);
  if (scoped.length === 1) {
    questions.push(
      `You named ${scoped[0].name}. Which other location should Foundry be allowed to move stock to and from?`
    );
    locationScope = [];
  } else if (!scoped.length) {
    locationScope = locations.map((l) => l.id);
    questions.push(`This would cover all ${locations.length} of your locations. Narrow it if that is too wide.`);
  }

  // The ceiling is never guessed. `validate` would reject a policy without one,
  // and inventing a number here to get past that check would be the same fault
  // wearing a different hat.
  const maximumQuantity = Number.isFinite(read.maximumQuantity) && read.maximumQuantity > 0
    ? Math.trunc(read.maximumQuantity)
    : null;
  if (!maximumQuantity) {
    questions.push('What is the most Foundry may move in one go without asking you first?');
  }

  return {
    understood: true,
    instruction: clean,
    // Conditions are not the model's to choose. These are the safety checks that
    // make an automatic transfer defensible, and they are attached to every
    // policy this path produces.
    draft: {
      name: String(read.name || '').trim().slice(0, 120) || 'Automatic warehouse balancing',
      description: `From what you said: “${clean}”`,
      allowedActionTypes: ['transfer'],
      locationScope,
      conditions: [
        policyService.CONDITIONS.DESTINATION_STOCKOUT_RISK,
        policyService.CONDITIONS.SOURCE_ABOVE_SAFETY,
        policyService.CONDITIONS.NO_CONFLICTING_TRANSFER,
        policyService.CONDITIONS.SUFFICIENT_HISTORY,
      ],
      maximumQuantity,
      dailyLimit: Number.isFinite(read.dailyLimit) && read.dailyLimit > 0 ? Math.trunc(read.dailyLimit) : null,
    },
    locations: scoped.length ? scoped : locations,
    questions,
    // What it would say once written, so the customer reads the policy rather
    // than their own sentence reflected back at them.
    preview: maximumQuantity
      ? policyService.describe({
          allowedActionTypes: ['transfer'],
          maximumQuantity,
          dailyLimit: Number.isFinite(read.dailyLimit) && read.dailyLimit > 0 ? Math.trunc(read.dailyLimit) : null,
          locationScope,
          conditions: [
            policyService.CONDITIONS.DESTINATION_STOCKOUT_RISK,
            policyService.CONDITIONS.SOURCE_ABOVE_SAFETY,
            policyService.CONDITIONS.NO_CONFLICTING_TRANSFER,
            policyService.CONDITIONS.SUFFICIENT_HISTORY,
          ],
        })
      : [],
  };
}

module.exports = { POLICY_SCHEMA, draft, resolveLocations };
