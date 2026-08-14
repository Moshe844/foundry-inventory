'use strict';

/**
 * Prompts for the interpretation layer.
 *
 * The model is never asked what is wrong with the inventory — that question is
 * already answered, deterministically, before it is called. It is asked only to
 * say the answer well.
 */

const INTERPRETATION_SYSTEM = `You write the wording for an inventory briefing.

Foundry has already measured everything and decided what matters. Your job is
only to phrase each finding so a shop owner or warehouse manager understands it
in one read. You are a writer here, not an analyst.

Absolute rules:
- Never state a number that is not already in the finding you were given. Do not
  round, convert, re-scale, total, or infer new figures.
- Never add a cause, a culprit, or a conclusion that was not given to you. If a
  correction is large, that is all it is; do not suggest theft, fraud or blame.
- Never promise an action. Foundry does not move stock. Write "consider", not
  "I have moved".
- Never invent products, locations, people or dates.
- If a finding already reads well, return it close to unchanged. That is a good
  answer, not a lazy one.

Style: plain language, no jargon, no exclamation marks, no hype. The title is a
short statement of the situation. The summary is one line. The recommendation is
one sentence about what a person might do next.`;

function interpretationPrompt(items, context) {
  const business = context.businessType ? `Business: ${context.businessType}.` : '';
  const vocabulary = context.vocabulary ? `They call their stock "${context.vocabulary}".` : '';

  const rendered = items
    .map((item, index) => {
      const facts = item.evidence.map((e) => `    - ${e.label}: ${e.value} (${e.kind})`).join('\n');
      return [
        `[${index + 1}] id: ${item.attentionId}`,
        `    category: ${item.category}`,
        `    severity: ${item.severity}`,
        `    current title: ${item.deterministicTitle}`,
        `    current summary: ${item.deterministicSummary}`,
        `    current recommendation: ${item.deterministicRecommendation}`,
        `    detail: ${item.explanation}`,
        '    evidence:',
        facts,
      ].join('\n');
    })
    .join('\n\n');

  return `${business} ${vocabulary}

Rewrite the wording of each finding below. Return one entry per finding, using
the same id. Use only the figures shown in that finding's own evidence.

${rendered}`;
}

const BRIEF_SYSTEM = `You write the opening lines of a daily inventory briefing.

The findings below were measured by Foundry. Write two or three sentences that
tell the reader what today looks like overall and what to deal with first. Use
only the findings given. Do not add numbers that are not shown, do not invent
trends, and do not speculate about causes. Plain, calm, specific.`;

function briefPrompt(items, context) {
  const lines = items
    .map((item) => `- [${item.severity}] ${item.deterministicTitle} — ${item.deterministicSummary}`)
    .join('\n');
  return `Business: ${context.businessType || 'an inventory operation'}.
There ${items.length === 1 ? 'is 1 finding' : `are ${items.length} findings`} open today:

${lines}

Write the opening of the briefing.`;
}

module.exports = {
  INTERPRETATION_SYSTEM,
  BRIEF_SYSTEM,
  interpretationPrompt,
  briefPrompt,
};
