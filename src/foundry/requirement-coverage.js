'use strict';

/*
 * Preserve the owner's complete request independently of model interpretation.
 *
 * The structured understanding is intentionally constrained to things the
 * engine can configure. That must never make an extra requirement disappear
 * from the review screen. Sentence-level source statements provide a simple,
 * deterministic coverage ledger: no business-specific keyword list, and no
 * model is allowed to decide which of the owner's statements are worth showing.
 */

function sourceStatements(description) {
  const clean = String(description || '').replace(/\r\n?/g, '\n').trim();
  if (!clean) return [];

  const statements = clean
    .split(/(?:\n+|(?<=[.!?])\s+)/u)
    .map((statement) => statement.trim().replace(/^[“”"']+|[“”"']+$/g, ''))
    .filter(Boolean);

  const seen = new Set();
  return statements.filter((statement) => {
    const key = statement.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalise(value) {
  return String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Grammatical scaffolding, not business vocabulary. Removing these words lets
// a citation such as "multiple SKUs based on attributes such as size" cover
// the source fragment "while others have multiple SKUs ..." without teaching
// the reconciler what a SKU, size, workflow, or any other requirement means.
const GRAMMAR_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'while', 'whereas', 'with', 'without',
  'of', 'to', 'from', 'for', 'in', 'on', 'at', 'by', 'as', 'such', 'that',
  'which', 'who', 'our', 'we', 'they', 'their', 'it', 'its', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'have', 'has', 'had', 'can', 'could', 'should',
  'would', 'may', 'might', 'must', 'need', 'needs', 'require', 'requires',
  'include', 'includes', 'including', 'some', 'other', 'others', 'each', 'every',
  'same', 'more', 'than',
]);

const SEMANTIC_ROLES = new Set([
  'resolvable_requirement',
  'operational_requirement',
  'business_context',
  'evidence_instruction',
  'behavioral_guardrail',
]);

const CONTEXT_ROLES = new Set([
  'business_context',
  'evidence_instruction',
  'behavioral_guardrail',
]);

/**
 * Infer a role only for legacy or deterministically restored entries. New
 * model output supplies the role explicitly. These rules use grammatical
 * intent (prohibition, future-passive evidence, obligation, or unresolved
 * action), never inventory fields or business-specific nouns.
 */
function inferSemanticRole(requirement) {
  if (SEMANTIC_ROLES.has(requirement?.semanticRole)) return requirement.semanticRole;

  const source = normalise(requirement?.sourceText);
  const nextStep = normalise(requirement?.nextStep);
  if (/\b(?:do not|does not|must not|should not|never)\b/u.test(source)) {
    return 'behavioral_guardrail';
  }
  if (/\b(?:will|shall|can|may) be \p{L}{3,}(?:ed|en)\b/u.test(source)) {
    return 'evidence_instruction';
  }
  if (requirement?.status === 'needs_detail' && nextStep) {
    return 'resolvable_requirement';
  }
  if (/\b(?:need|needs|required?|requires|must|should|have to)\b/u.test(source)) {
    return 'operational_requirement';
  }
  if (requirement?.status === 'supported_today' || requirement?.status === 'unsupported_today') {
    return 'operational_requirement';
  }
  return 'business_context';
}

function stem(token) {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function meaningfulTokens(value) {
  return new Set(normalise(value).split(' ')
    .filter((token) => token && !GRAMMAR_WORDS.has(token))
    .map(stem));
}

function containsExactPhrase(description, phrase) {
  const source = ` ${normalise(description)} `;
  const wanted = normalise(phrase);
  return Boolean(wanted) && source.includes(` ${wanted} `);
}

function withoutLeadingConjunction(value) {
  return String(value || '').replace(/^\s*(?:and|or|but|while|whereas)\s+/iu, '').trim();
}

function chunks(value, maxLength = 500) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text ? [text] : [];
  const result = [];
  let rest = text;
  while (rest.length > maxLength) {
    let end = rest.lastIndexOf(' ', maxLength);
    if (end < Math.floor(maxLength * 0.6)) end = maxLength;
    result.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) result.push(rest);
  return result;
}

/**
 * Break the owner's prose into reviewable requirement units without knowing
 * anything about inventory field names. Sentence and list boundaries are
 * evidence supplied by the owner; no capability vocabulary is consulted.
 */
function requirementUnits(description) {
  const units = [];
  for (const statement of sourceStatements(description)) {
    // Keep ordinary comma-separated lists together. Split only at punctuation
    // that starts another grammatical clause, so a missing list member causes
    // one readable source sentence to be restored instead of orphan fragments.
    const sections = statement.split(
      /\s*(?:;|,(?=\s*(?:(?:(?:and|but|while|whereas)\s+)?(?:we|you|they|it|he|she|some|others?|the same|our|their|this|that)\b|so\s+(?:do|does|must|should|will)\b)))\s*/iu
    ).filter(Boolean);
    for (const section of sections) {
      const clean = withoutLeadingConjunction(section).replace(/[.!?]+$/u, '').trim();
      units.push(...chunks(clean));
    }
  }

  const seen = new Set();
  return units.filter((unit) => {
    const key = normalise(unit);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validRequirement(requirement, description) {
  if (!requirement || !containsExactPhrase(description, requirement.sourceText)) return null;
  const sourceText = String(requirement.sourceText || '').trim();
  if (!sourceText || sourceText.length > 500) return null;
  const nextStep = String(requirement.nextStep || '').trim().slice(0, 300);
  return {
    sourceText,
    understanding: String(requirement.understanding || sourceText).trim().slice(0, 300) || sourceText.slice(0, 300),
    status: ['supported_today', 'needs_detail', 'unsupported_today'].includes(requirement.status)
      ? requirement.status
      : 'needs_detail',
    nextStep: /^(?:none|n\/?a|not applicable)$/iu.test(nextStep) ? '' : nextStep,
    semanticRole: inferSemanticRole(requirement),
  };
}

function phraseContains(container, contained) {
  const outer = ` ${normalise(container)} `;
  const inner = normalise(contained);
  return Boolean(inner) && outer.includes(` ${inner} `);
}

/**
 * Whether a grounded citation already carries the meaning-bearing words in a
 * source unit. Direction matters: a broad citation may cover a short fragment,
 * but a one-word citation must not erase the rest of a longer requirement.
 */
function semanticallyCovers(citation, sourceUnit) {
  if (phraseContains(citation, sourceUnit)) return true;
  const wanted = meaningfulTokens(sourceUnit);
  const offered = meaningfulTokens(citation);
  if (!wanted.size || !offered.size) return false;
  const overlap = [...wanted].filter((token) => offered.has(token)).length;
  if (wanted.size === 1) return overlap === 1;
  return overlap >= 2 && overlap / wanted.size >= 0.6;
}

function requirementsCoverUnit(requirements, sourceUnit) {
  if (requirements.some((requirement) => phraseContains(requirement.sourceText, sourceUnit))) return true;
  const wanted = meaningfulTokens(sourceUnit);
  if (!wanted.size) return false;
  const offered = new Set();
  for (const requirement of requirements) {
    for (const token of meaningfulTokens(requirement.sourceText)) offered.add(token);
  }
  const overlap = [...wanted].filter((token) => offered.has(token)).length;
  if (wanted.size === 1) return overlap === 1;
  return overlap >= 2 && overlap / wanted.size >= 0.6;
}

function isRestoredFallback(requirement) {
  return requirement
    && requirement.status === 'needs_detail'
    && !String(requirement.nextStep || '').trim()
    && normalise(requirement.understanding) === normalise(requirement.sourceText);
}

/**
 * Reconcile fallible model extraction against the authoritative owner text.
 *
 * Model entries survive only when their citation is an exact phrase from the
 * description. Every source unit not present inside one of those citations is
 * restored conservatively. The fallback repeats the owner's words and marks
 * the mapping as needing detail, so completeness never turns into invention.
 */
function reconcile(description, modelRequirements = []) {
  const reconciled = [];
  const seen = new Set();

  // Older versions persisted deterministic fallback fragments alongside the
  // model result. Drop those recognizable rows first, then rebuild coverage
  // from the authoritative description. This makes reconciliation idempotent
  // and repairs already-saved proposals when they are reopened.
  const primaryRequirements = (Array.isArray(modelRequirements) ? modelRequirements : [])
    .filter((candidate) => !isRestoredFallback(candidate));

  for (const candidate of primaryRequirements) {
    const requirement = validRequirement(candidate, description);
    if (!requirement) continue;
    const key = normalise(requirement.sourceText);
    if (seen.has(key)) continue;
    seen.add(key);
    reconciled.push(requirement);
  }

  for (const unit of requirementUnits(description)) {
    if (requirementsCoverUnit(reconciled, unit)) continue;
    const key = normalise(unit);
    if (seen.has(key)) continue;
    seen.add(key);
    const fallback = {
      sourceText: unit,
      understanding: unit.slice(0, 300),
      status: 'needs_detail',
      nextStep: '',
    };
    reconciled.push({ ...fallback, semanticRole: inferSemanticRole(fallback) });
  }

  return reconciled;
}

/** A complete, untruncated downstream view over the reconciled ledger. */
function summarize(requirements = []) {
  const all = (Array.isArray(requirements) ? requirements : []).map((requirement) => (
    SEMANTIC_ROLES.has(requirement?.semanticRole)
      ? requirement
      : { ...requirement, semanticRole: inferSemanticRole(requirement) }
  ));
  const context = all.filter((requirement) => CONTEXT_ROLES.has(requirement.semanticRole));
  const actionable = all.filter((requirement) => !CONTEXT_ROLES.has(requirement.semanticRole));
  return {
    total: all.length,
    supported: actionable.filter((requirement) => requirement.status === 'supported_today'),
    needsDetail: actionable.filter((requirement) => (
      requirement.status === 'needs_detail'
      && requirement.semanticRole === 'resolvable_requirement'
    )),
    needsOwnerInput: actionable.filter((requirement) => (
      requirement.status === 'needs_detail'
      && requirement.semanticRole !== 'resolvable_requirement'
    )),
    unsupported: actionable.filter((requirement) => requirement.status === 'unsupported_today'),
    context,
  };
}

module.exports = {
  sourceStatements,
  requirementUnits,
  reconcile,
  summarize,
  containsExactPhrase,
  semanticallyCovers,
  requirementsCoverUnit,
  inferSemanticRole,
};
