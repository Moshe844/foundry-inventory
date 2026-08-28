'use strict';

/**
 * The path from a sentence to something a person can approve.
 *
 *   instruction → intent (model) → resolution (deterministic) → proposal
 *
 * Nothing here executes. The result is always one of three honest outcomes: a
 * proposal to look at, a question, or "Foundry cannot do that" — and the third
 * is a real answer, not a failure. Refusing to invent a purchase order is the
 * behaviour that keeps the rest trustworthy.
 */

const { inTransaction } = require('../db');
const intentService = require('./intent-service');
const proposals = require('./proposal-service');
const resolver = require('./resolver');
const presenter = require('./presenter');
const purchaseIntent = require('../purchasing/purchase-intent');
const policy = require('./policy');
const permissions = require('./permissions');
const attention = require('../attention/attention-engine');
const planApplier = require('../foundry/plan-applier');
const repo = require('../domain/repository');
const replenishmentPlan = require('../purchasing/replenishment-plan');
const signalEngine = require('../signals/signal-engine');
const { newId, nowIso } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');

/** Everything the model needs to read an instruction in this workspace's terms. */
function instructionContext(db, workspaceId) {
  const configuration = planApplier.getConfiguration(db, workspaceId);
  const terminology = (configuration && configuration.terminology) || {};
  const pending = proposals.listOpen(db, workspaceId, { limit: 3 });
  const items = db
    .prepare('SELECT name FROM items WHERE workspace_id = ? AND is_active = 1 ORDER BY name LIMIT 41')
    .all(workspaceId)
    .map((row) => row.name);

  return {
    locationNames: repo.listLocations(db, workspaceId).map((l) => l.name),
    itemNames: items,
    itemCount: db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ? AND is_active = 1').get(workspaceId).n,
    stockNoun: terminology.item || null,
    pendingAction: pending.length === 1 ? presenter.oneLine(db, workspaceId, pending[0]) : null,
    pendingCount: pending.length,
  };
}

/** Phrases that mean "the thing you already proposed", not a new instruction. */
const AGREEMENT = /^\s*(yes|yep|yeah|ok(ay)?|sure|go ahead|do it|do that|please do|carry on|confirm(ed)?|approve( it)?|make it so|do what you recommended|do your recommendation)\s*[.!]?\s*$/i;
const ALL_LOCATIONS = '__all_locations__';

function locationFieldFor(actionType) {
  if (actionType === 'receive') return 'destinationLocation';
  if (['issue', 'adjust'].includes(actionType)) return 'sourceLocation';
  return null;
}

function locationClarification(result, actionType) {
  const field = locationFieldFor(actionType);
  const clarification = result && result.clarification;
  if (!field || !clarification || !Array.isArray(clarification.choices) || clarification.choices.length < 2) return null;
  if (!/(^|_)location$/.test(String(clarification.dimension || ''))) return null;
  const individual = clarification.choices.filter((choice) => choice && choice.value !== ALL_LOCATIONS);
  if (individual.length < 2) return null;
  return {
    field,
    individual,
    choices: [
      ...individual,
      { label: individual.length === 2 ? 'Both locations' : 'All locations', value: ALL_LOCATIONS },
    ],
  };
}

function exactInstructionSlice(instruction, candidate) {
  const source = String(instruction || '');
  const wanted = String(candidate || '').trim();
  if (!wanted) return '';
  const index = source.toLowerCase().indexOf(wanted.toLowerCase());
  return index < 0 ? '' : source.slice(index, index + wanted.length);
}

/**
 * Gives each parsed action only the words that belong to that action.
 *
 * The model may provide an exact source slice. It is accepted only when every
 * line has a distinct, literal slice of the person's instruction. Otherwise a
 * conservative deterministic split handles ordinary lists ("A and B", comma
 * lists, semicolons and new lines). Numeric anchors are a final fallback for
 * repeated quantities. If none can be proved, empty slices force a grounded
 * clarification instead of leaking a colour or size from a neighbouring line.
 */
function instructionSlices(instruction, lines) {
  const source = String(instruction || '').trim();
  if (lines.length <= 1) return [source];

  const supplied = lines.map((line) => exactInstructionSlice(source, line.sourceText));
  if (supplied.every(Boolean)
      && new Set(supplied.map((slice) => slice.toLowerCase())).size === lines.length
      && supplied.every((slice) => slice.length < source.length)) {
    return supplied;
  }

  const splitPatterns = [
    /\s*(?:;|\n+|,\s*(?:and\s+)?(?=\d+\b)|\band\b(?=\s+\d+\b)|\bthen\b)\s*/i,
    /\s*(?:;|\n+|\band\b|\bthen\b)\s*/i,
    /\s*(?:;|\n+|,\s*(?:and\s+)?|\band\b|\bthen\b)\s*/i,
  ];
  for (const pattern of splitPatterns) {
    const clauses = source.split(pattern).map((part) => part.trim()).filter(Boolean);
    // A split is evidence only when it accounts for every parsed action once.
    // Product names containing "and" usually create extra pieces and are
    // therefore rejected rather than guessed through.
    if (clauses.length === lines.length) return clauses;
  }

  const positions = [];
  let cursor = 0;
  for (const line of lines) {
    const amount = Number.isInteger(line.quantity) && line.quantity >= 0
      ? line.quantity
      : Number.isInteger(line.adjustmentTarget) && line.adjustmentTarget >= 0
        ? line.adjustmentTarget : null;
    if (amount === null) return lines.map(() => '');
    const tail = source.slice(cursor);
    const match = new RegExp(`(^|[^a-z0-9])${amount}(?=$|[^a-z0-9])`, 'i').exec(tail);
    if (!match) return lines.map(() => '');
    const position = cursor + match.index + match[1].length;
    positions.push(position);
    cursor = position + String(amount).length;
  }
  const boundaries = [0];
  for (let index = 1; index < positions.length; index += 1) {
    const previous = positions[index - 1];
    const current = positions[index];
    const between = source.slice(previous, current);
    const separator = /(?:[;,\n]+|[.!?]\s+|\band\b|\bthen\b)/gi;
    let match;
    let boundary = current;
    while ((match = separator.exec(between))) boundary = previous + match.index + match[0].length;
    boundaries.push(boundary);
  }
  boundaries.push(source.length);
  return lines.map((_, index) => source.slice(boundaries[index], boundaries[index + 1]).trim());
}

/**
 * Reads an instruction and returns what should happen next.
 *
 * @returns {{ kind: 'proposal'|'plan'|'question'|'unsupported'|'existing', ... }}
 */
async function interpret(db, ctx, membership, instruction, options = {}) {
  const text = String(instruction || '').trim();
  if (!text) return { kind: 'question', question: 'What would you like Foundry to do?' };

  // "Do it" refers to something already on the table. Resolving that here, in
  // code, means the model is never the thing deciding which action was meant.
  if (AGREEMENT.test(text)) {
    const open = proposals.listOpen(db, ctx.workspaceId, { limit: 5 })
      .filter((p) => p.status === 'AWAITING_APPROVAL');
    if (open.length === 1) {
      return { kind: 'existing', proposal: open[0], instruction: text };
    }
    if (open.length === 0) {
      return {
        kind: 'question',
        question: 'There is nothing waiting for approval. What would you like Foundry to do?',
      };
    }
    return {
      kind: 'question',
      question: 'Which one would you like Foundry to carry out?',
      choices: open.map((p) => ({ proposalId: p.proposalId, summary: presenter.oneLine(db, ctx.workspaceId, p) })),
    };
  }

  // A continuation may supply the already-read, server-held intent. Reusing
  // it is what makes a follow-up continue the same grouped request instead of
  // asking the model to reconstruct every line from the original prose.
  const intent = options.parsedIntent || await intentService.readInstruction(text, {
    provider: options.provider,
    context: options.context || instructionContext(db, ctx.workspaceId),
  });

  if (intent.unsupportedReason && intent.lines.length === 0) {
    return { kind: 'unsupported', message: intent.unsupportedReason };
  }
  if (intent.clarifyingQuestion && intent.lines.length === 0) {
    // A model can notice that an identity is incomplete without knowing which
    // catalogue dimension is actually unresolved. Ground generic identity
    // questions against real SKUs before showing them to the person.
    if (/\b(product|item|variant|version|which one)\b/i.test(intent.clarifyingQuestion)) {
      const grounded = resolver.clarifySkuFromInstruction(db, ctx.workspaceId, text);
      if (grounded && !grounded.ok && grounded.reason === 'ambiguous') {
        return {
          kind: 'question',
          question: grounded.message,
          clarification: grounded.clarification || null,
          choices: grounded.clarification ? grounded.clarification.choices : null,
        };
      }
    }
    return { kind: 'question', question: intent.clarifyingQuestion };
  }

  const usable = intent.lines.filter((line) => !['clarify', 'unsupported'].includes(line.actionType));
  const blocked = intent.lines.find((line) => ['clarify', 'unsupported'].includes(line.actionType));

  // Part of an instruction is not a smaller instruction.
  //
  // When some lines resolved and others did not, the ones that did used to go
  // ahead on their own and nothing was said about the rest — the preview showed
  // a run of correct changes with no sign that anything was missing. If any
  // part of what somebody asked for cannot be carried out, none of it proceeds
  // until they have seen which part.
  if (usable.length > 0 && blocked) {
    const named = intent.lines
      .filter((line) => ['clarify', 'unsupported'].includes(line.actionType))
      .map((line) => [line.item, line.variant].filter(Boolean).join(' ') || 'one of them')
      .filter((value, index, all) => all.indexOf(value) === index);
    const detail = intent.clarifyingQuestion || intent.unsupportedReason || '';
    return {
      kind: 'question',
      question:
        `Foundry understood ${usable.length} of the ${intent.lines.length} changes you asked for, `
        + `but not this: ${named.join(', ')}. `
        + `${detail} `.trim()
        + ' Nothing has been prepared — say that part another way and Foundry will do the whole instruction together.',
    };
  }

  if (usable.length === 0) {
    if (blocked && blocked.actionType === 'unsupported') {
      return { kind: 'unsupported', message: intent.unsupportedReason || 'Foundry cannot do that yet.' };
    }
    const modelQuestion = intent.clarifyingQuestion || '';
    if (/\b(product|item|variant|version|which one)\b/i.test(modelQuestion)) {
      const grounded = resolver.clarifySkuFromInstruction(db, ctx.workspaceId, text);
      if (grounded && !grounded.ok && grounded.reason === 'ambiguous') {
        return {
          kind: 'question',
          question: grounded.message,
          clarification: grounded.clarification || null,
          choices: grounded.clarification ? grounded.clarification.choices : null,
        };
      }
    }
    return {
      kind: 'question',
      question: modelQuestion || 'Could you say a little more about what you want Foundry to do?',
    };
  }

  // Permission is checked before anything is written, so a person without it
  // is told plainly rather than shown a proposal they can never approve.
  for (const line of usable) permissions.assertCanPerform(membership, line.actionType);

  // Purchasing is a different kind of thing from moving stock, and it has its
  // own object with its own approval. It leaves this pipeline here rather than
  // being forced into an action proposal that would mean something else.
  const purchase = usable.find((line) => line.actionType === 'purchase');
  if (purchase) {
    const result = purchaseIntent.build(db, ctx, membership, purchase, { instruction: text });
    if (!result.ok) {
      return result.unsupported
        ? { kind: 'unsupported', message: result.unsupported }
        : {
            kind: 'question',
            question: result.question,
            clarification: result.clarification || null,
            choices: result.choices || (result.clarification && result.clarification.choices) || null,
          };
    }
    return { kind: 'purchase_order', order: result.order, assumptions: result.assumptions };
  }

  const shipment = usable.find((line) => line.actionType === 'receive_shipment');
  if (shipment) {
    return { kind: 'receive_shipment', supplier: shipment.supplier || '', instruction: text };
  }

  return inTransaction(db, () => {
    const built = [];
    const missingReasons = [];
    const slices = instructionSlices(text, usable);
    for (let index = 0; index < usable.length; index += 1) {
      const line = usable[index];
      const result = proposals.build(db, ctx, line, {
        // Lines expanded from one all-locations answer still belong to the
        // same original clause. A mechanical two-line split has no second
        // piece of prose, so keep the original identity evidence for each
        // clone instead of turning an exact SKU code back into ambiguity.
        instruction: line._sourceInstruction || slices[index],
        groundIdentity: true,
      });
      if (!result.ok) {
        if (result.needsReason) {
          missingReasons.push({ index, context: result.reasonContext || null });
          continue;
        }
        if (result.missingLocation && line.actionType === 'transfer') {
          return {
            kind: 'missing_location',
            locationName: result.missingLocation.name,
            role: result.missingLocation.role,
            instruction: text,
            line,
            question: result.question,
          };
        }
        if (line.actionType === 'create_item'
            && result.clarification
            && result.clarification.dimension === 'destination_location') {
          return {
            kind: 'question',
            question: result.question,
            clarification: result.clarification,
            choices: result.choices || result.clarification.choices || null,
            continuation: {
              kind: 'create_item_receiving_location',
              originalInstruction: text,
              parsedIntent: intent,
              lineIndex: index,
            },
          };
        }
        const locationQuestion = locationClarification(result, line.actionType);
        if (locationQuestion) {
          return {
            kind: 'question',
            question: result.question,
            clarification: { ...result.clarification, choices: locationQuestion.choices },
            choices: locationQuestion.choices,
            continuation: {
              kind: 'location_selection',
              originalInstruction: text,
              parsedIntent: intent,
              lineIndex: index,
              field: locationQuestion.field,
              locations: locationQuestion.individual.map((choice) => String(choice.value)),
            },
          };
        }
        // A refusal the engine can explain travels with its explanation. The
        // caller needs the numbers to say what is wrong and what to do next.
        if (result.noChange && line._applyAcrossLocations) continue;
        if (result.unsupported) {
          return { kind: 'unsupported', message: result.unsupported, blocked: result.blocked || null };
        }
        return {
          kind: 'question',
          question: result.question,
          needsReason: Boolean(result.needsReason),
          clarification: result.clarification || null,
          choices: result.choices || (result.clarification && result.clarification.choices) || null,
        };
      }
      built.push(result.proposal);
    }

    if (built.length === 0 && usable.some((line) => line._applyAcrossLocations)) {
      return { kind: 'unsupported', message: 'Every selected location already has that count. Nothing needs changing.' };
    }

    if (missingReasons.length) {
      const grouped = missingReasons.length > 1;
      const allOpening = missingReasons.every(({ context }) => context && context.current === 0);
      const question = grouped
        ? allOpening
          ? `You're setting starting inventory from zero across ${missingReasons.length} stock positions. What is the reason for these opening balances?`
          : `You're correcting counts across ${missingReasons.length} stock positions. What is the reason for these changes?`
        : `Why is the count changing from ${missingReasons[0].context.current} to ${missingReasons[0].context.target}? Foundry needs the reason on record.`;
      return {
        kind: 'question',
        question,
        needsReason: true,
        clarification: { dimension: 'reason', choices: [] },
        continuation: {
          kind: 'adjustment_reason',
          originalInstruction: text,
          parsedIntent: intent,
          lineIndexes: missingReasons.map(({ index }) => index),
        },
      };
    }

    // Two counts for the same shelf in one instruction contradict each other.
    //
    // A plan applies its lines in order, so the second would quietly win and
    // the first would vanish without ever being wrong out loud. Foundry says
    // which position was named twice and lets the person pick the number.
    const seen = new Map();
    for (const draft of built) {
      if (draft.actionType !== 'adjust') continue;
      const key = `${draft.lotId || draft.skuId}@${draft.sourceLocationId}`;
      if (seen.has(key)) {
        const subject = presenter.subjectOf(db, ctx.workspaceId, draft);
        const name = [subject.name, subject.detail].filter(Boolean).join(' / ');
        const where = draft.expectedBeforeState.sourceLocationName || 'that location';
        return {
          kind: 'question',
          question:
            `That gives ${name} at ${where} two different counts — ${seen.get(key)} and ${draft.adjustmentTarget}. `
            + 'Foundry will not pick one. Which is right?',
        };
      }
      seen.set(key, draft.adjustmentTarget);
    }

    if (built.length === 1) {
      const stored = proposals.persist(db, ctx, built[0], {
        sourceType: options.sourceType || 'USER_REQUEST',
        sourceAttentionId: options.sourceAttentionId || null,
        instruction: text,
        notes: options.reasonNote || null,
      });
      return { kind: 'proposal', proposal: stored };
    }

    const plan = createPlan(db, ctx, built, { instruction: text, notes: options.reasonNote || null });
    return { kind: 'plan', plan };
  });
}

/** Translate a person's free-text audit explanation into the existing reason taxonomy. */
function adjustmentReasonFromAnswer(answer) {
  const text = String(answer || '').trim();
  if (!text) return null;
  if (/\b(physical\s+count|recount|counted|stocktake)\b/i.test(text)) return 'physical_count';
  if (/\b(damage|damaged|broken|scrap(?:ped)?)\b/i.test(text)) return 'damage';
  if (/\b(loss|lost|missing|stolen|theft)\b/i.test(text)) return 'loss';
  if (/\b(found|discovered|unexpected\s+stock)\b/i.test(text)) return 'found';
  if (/\b(opening|starting|start\s+from\s+scratch|initial|beginning|correction|correcting|error|wrong)\b/i.test(text)) {
    return 'correction';
  }
  return 'other';
}

/** Resume a stored clarification without reinterpreting or losing its lines. */
async function continueInterpretation(db, ctx, membership, continuation, answer, options = {}) {
  if (!continuation || !continuation.parsedIntent || !Array.isArray(continuation.parsedIntent.lines)) {
    throw new ValidationError('That clarification is no longer available. Please send the instruction again.');
  }
  if (continuation.kind === 'create_item_receiving_location') {
    const locationName = String(answer || '').trim();
    if (!locationName) {
      return {
        kind: 'question',
        question: 'Where should the new stock be received?',
        continuation,
      };
    }
    const parsedIntent = {
      ...continuation.parsedIntent,
      lines: continuation.parsedIntent.lines.map((line, index) =>
        index === continuation.lineIndex ? { ...line, destinationLocation: locationName } : { ...line }
      ),
    };
    return interpret(db, ctx, membership, continuation.originalInstruction, {
      ...options,
      parsedIntent,
    });
  }
  if (continuation.kind === 'location_selection') {
    const selected = String(answer || '').trim();
    const allowed = Array.isArray(continuation.locations) ? continuation.locations : [];
    if (!selected || (selected !== ALL_LOCATIONS && !allowed.includes(selected))) {
      return {
        kind: 'question',
        question: 'Which location should Foundry use?',
        choices: [
          ...allowed.map((location) => ({ label: location, value: location })),
          ...(allowed.length > 1 ? [{ label: allowed.length === 2 ? 'Both locations' : 'All locations', value: ALL_LOCATIONS }] : []),
        ],
        continuation,
      };
    }
    const parsedIntent = {
      ...continuation.parsedIntent,
      lines: continuation.parsedIntent.lines.flatMap((line, index) => {
        if (index !== continuation.lineIndex) return [{ ...line }];
        const locations = selected === ALL_LOCATIONS ? allowed : [selected];
        return locations.map((location) => ({
          ...line,
          [continuation.field]: location,
          _applyAcrossLocations: selected === ALL_LOCATIONS,
          _sourceInstruction: continuation.originalInstruction,
        }));
      }),
    };
    return interpret(db, ctx, membership, continuation.originalInstruction, {
      ...options,
      parsedIntent,
    });
  }
  if (continuation.kind !== 'adjustment_reason') {
    throw new ValidationError('That clarification is no longer available. Please send the instruction again.');
  }
  const reasonCode = adjustmentReasonFromAnswer(answer);
  if (!reasonCode) {
    return {
      kind: 'question',
      question: 'What is the reason for these count changes?',
      needsReason: true,
      continuation,
    };
  }
  const selected = new Set(continuation.lineIndexes || []);
  const parsedIntent = {
    ...continuation.parsedIntent,
    lines: continuation.parsedIntent.lines.map((line, index) =>
      selected.has(index) ? { ...line, reasonCode } : { ...line }
    ),
  };
  return interpret(db, ctx, membership, continuation.originalInstruction, {
    ...options,
    parsedIntent,
    reasonNote: String(answer).trim(),
  });
}

/** Several lines approved and executed as one, all or nothing by default. */
function createPlan(db, ctx, built, meta = {}) {
  const planId = newId('apl');
  const now = nowIso();
  const expiresAt = new Date(Date.now() + policy.PROPOSAL_TTL_MS).toISOString();

  db.prepare(
    `INSERT INTO action_plans
       (id, workspace_id, requested_by_user_id, original_instruction, summary,
        atomicity_policy, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'ALL_OR_NOTHING', 'AWAITING_APPROVAL', ?, ?)`
  ).run(planId, ctx.workspaceId, ctx.actorId, meta.instruction || null, meta.summary || '', now, expiresAt);

  const lines = built.map((proposal, index) =>
    proposals.persist(db, ctx, proposal, {
      planId,
      lineNumber: index + 1,
      sourceType: meta.sourceType || 'USER_REQUEST',
      instruction: meta.instruction || null,
      notes: meta.notes || null,
    })
  );

  return getPlan(db, ctx.workspaceId, planId, lines);
}

function getPlan(db, workspaceId, planId, preloaded = null) {
  const row = db.prepare('SELECT * FROM action_plans WHERE id = ? AND workspace_id = ?').get(planId, workspaceId);
  if (!row) return null;
  const lines =
    preloaded ||
    db
      .prepare('SELECT * FROM action_proposals WHERE plan_id = ? AND workspace_id = ? ORDER BY line_number')
      .all(planId, workspaceId)
      .map(proposals.hydrate);

  return {
    planId: row.id,
    workspaceId: row.workspace_id,
    requestedByUserId: row.requested_by_user_id,
    approvedByUserId: row.approved_by_user_id,
    originalInstruction: row.original_instruction,
    atomicityPolicy: row.atomicity_policy,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    completedAt: row.completed_at,
    lines,
    // A plan is as risky as its riskiest line.
    safetyLevel: lines.some((l) => l.safetyLevel === 'HIGH') ? 'HIGH' : 'MUTATION',
    warnings: lines.flatMap((l) => l.warnings),
  };
}

function setPlanStatus(db, workspaceId, planId, status, extra = {}) {
  const sets = ['status = @status'];
  const params = { id: planId, workspaceId, status };
  if (extra.approvedBy) {
    sets.push('approved_by_user_id = @approvedBy', 'approved_at = @now');
    params.approvedBy = extra.approvedBy;
    params.now = nowIso();
  }
  if (extra.completed) {
    sets.push('completed_at = @completedAt');
    params.completedAt = nowIso();
  }
  db.prepare(`UPDATE action_plans SET ${sets.join(', ')} WHERE id = @id AND workspace_id = @workspaceId`).run(params);
}

/**
 * Turns a Mission 3 finding into something reviewable.
 *
 * Only where an operation Foundry actually has can address the condition. A
 * stockout needs replenishment, which does not exist yet, so it gets no action
 * — inventing one would be worse than offering none.
 */
function proposeFromAttention(db, ctx, membership, attentionId) {
  const item = attention.getAttention(db, ctx.workspaceId, attentionId);
  if (!item) throw new NotFoundError('That item could not be found.');

  const isReplenishment =
    item.category === 'replenishment_needed' || item.relatedCategories.includes('replenishment_needed');
  const isImbalance =
    item.category === 'location_imbalance' || item.relatedCategories.includes('location_imbalance');
  if (!isReplenishment && !isImbalance) {
    return { kind: 'unsupported', message: actionabilityMessage(item) };
  }

  const metrics = item.metrics || {};
  let quantity;
  let fromId;
  let toId;

  if (isReplenishment) {
    // Rebuilt from current stock rather than read from the finding: approving a
    // movement worked out against yesterday's balances is how a plan and the
    // ledger end up disagreeing. The order half is not created here — buying
    // money goes through purchasing, on its own approval.
    const sku = signalEngine.skuSignals(db, ctx.workspaceId, { skuIds: [item.skuId] })[0];
    if (!sku) return { kind: 'unsupported', message: 'That product is no longer active.' };
    const plan = replenishmentPlan.buildPlan(db, ctx.workspaceId, sku);
    const move = plan.transfers[0];
    if (!move) {
      return {
        kind: 'unsupported',
        message: plan.purchase
          ? 'Nothing needs moving — this plan is an order, which is raised from Purchasing.'
          : 'There is no move that would clearly improve this.',
      };
    }
    quantity = move.quantity;
    fromId = move.fromLocationId;
    toId = move.toLocationId;
  } else {
    quantity = Number(metrics.suggestedTransferQuantity);
    fromId = metrics.quietLocationId;
    toId = metrics.busyLocationId;
  }

  if (!Number.isFinite(quantity) || quantity < 1) {
    return { kind: 'unsupported', message: 'There is no move that would clearly improve this.' };
  }

  permissions.assertCanPerform(membership, 'transfer');

  const from = db.prepare('SELECT name FROM locations WHERE id = ? AND workspace_id = ?')
    .get(fromId, ctx.workspaceId);
  const to = db.prepare('SELECT name FROM locations WHERE id = ? AND workspace_id = ?')
    .get(toId, ctx.workspaceId);
  if (!from || !to) return { kind: 'unsupported', message: 'The locations involved have changed.' };

  return inTransaction(db, () => {
    const built = proposals.build(db, ctx, {
      actionType: 'transfer',
      item: '',
      variant: '',
      lotCode: '',
      serials: [],
      sourceLocation: from.name,
      destinationLocation: to.name,
      quantity,
      // Resolution is by id here: the finding already knows exactly which SKU.
      resolvedSkuId: item.skuId,
    });
    if (!built.ok) return { kind: 'question', question: built.question || built.unsupported };

    const stored = proposals.persist(db, ctx, built.proposal, {
      sourceType: 'ATTENTION_ITEM',
      sourceAttentionId: attentionId,
      instruction: item.recommendation,
    });
    return { kind: 'proposal', proposal: stored };
  });
}

function actionabilityMessage(item) {
  const messages = {
    // Mission 6 gave Foundry replenishment and purchase orders, so telling
    // someone to go and order it themselves is now false. It drafts the order;
    // sending it to the supplier stays a person's decision.
    stockout_risk:
      'Foundry can work out what to order and draft the purchase order for you on the purchasing page. ' +
      'It will not send anything to the supplier.',
    low_stock:
      'Foundry can work out what to order and draft the purchase order for you on the purchasing page.',
    expiring_inventory: 'Foundry can move this lot somewhere it will be used, but deciding what to do with it is yours. Ask Foundry to transfer it if that helps.',
    unusual_adjustment: 'This is something to check with the person who recorded it. There is no inventory action to take.',
    stale_inventory: 'Foundry can move this stock if you tell it where. There is no action it should take on its own.',
    serialized_inactivity: 'Foundry can move these units if you tell it where they should be.',
    data_integrity: 'This needs investigating rather than an inventory movement.',
  };
  return messages[item.category] || 'There is no inventory action Foundry can take for this.';
}

/**
 * A change of mind supersedes rather than edits: what was approved has to stay
 * exactly what was approved, so a new quantity is a new proposal.
 */
/**
 * Works the same action out again against stock as it stands now.
 *
 * A proposal is reasoning about numbers at a moment in time. When those numbers
 * move it stops being a thing that can be approved — but it was still rendered
 * with its warning box ticked and its Approve button live, so the one obvious
 * move on the page was the one guaranteed to fail. The engine refused it, which
 * is the important half; being told to press a button that cannot work is the
 * other half, and it is not a small one.
 *
 * The old proposal is superseded rather than edited: what somebody saw and did
 * not approve is part of the record. The new one carries the same intent — the
 * same product, place and target — re-derived from current balances, so the
 * before and after on screen are today's before and after.
 */
function recalculate(db, ctx, membership, proposalId) {
  const existing = proposals.get(db, ctx.workspaceId, proposalId);
  if (!existing) throw new NotFoundError('That action could not be found.');
  permissions.assertCanPerform(membership, existing.actionType);
  if (!['AWAITING_APPROVAL', 'INVALIDATED'].includes(existing.status)) {
    throw new ValidationError('That action can no longer be worked out again.');
  }

  return inTransaction(db, () => {
    const intent = intentFromProposal(db, ctx.workspaceId, existing);
    const built = proposals.build(db, ctx, intent);
    if (!built.ok) {
      throw new ValidationError(
        built.question || built.unsupported ||
        'Foundry cannot work this out against your stock as it stands now.'
      );
    }
    built.proposal.proposalVersion = existing.proposalVersion + 1;
    built.proposal.integrityHash = proposals.computeIntegrityHash(built.proposal);

    proposals.setStatus(db, ctx, proposalId, 'SUPERSEDED');
    proposals.record(db, ctx, proposalId, 'SUPERSEDED', { recalculated: true });

    return proposals.persist(db, ctx, built.proposal, {
      sourceType: existing.sourceType,
      sourceAttentionId: existing.sourceAttentionId,
      sourceProposalId: proposalId,
      planId: existing.planId,
      lineNumber: existing.lineNumber,
      instruction: existing.originalInstruction,
    });
  });
}

function reviseQuantity(db, ctx, membership, proposalId, quantity) {
  const existing = proposals.get(db, ctx.workspaceId, proposalId);
  if (!existing) throw new NotFoundError('That action could not be found.');
  permissions.assertCanPerform(membership, existing.actionType);
  if (!['AWAITING_APPROVAL', 'APPROVED', 'INVALIDATED'].includes(existing.status)) {
    throw new ValidationError('That action can no longer be changed.');
  }
  const wanted = Math.trunc(Number(quantity));
  if (!Number.isFinite(wanted) || wanted < 1) throw new ValidationError('Enter how many, as a whole number.');

  return inTransaction(db, () => {
    const intent = intentFromProposal(db, ctx.workspaceId, existing, { quantity: wanted });
    const built = proposals.build(db, ctx, intent);
    if (!built.ok) {
      throw new ValidationError(built.question || built.unsupported || 'That change is not possible.');
    }
    built.proposal.proposalVersion = existing.proposalVersion + 1;
    built.proposal.integrityHash = proposals.computeIntegrityHash(built.proposal);

    proposals.setStatus(db, ctx, proposalId, 'SUPERSEDED');
    proposals.record(db, ctx, proposalId, 'SUPERSEDED', { newQuantity: wanted });

    return proposals.persist(db, ctx, built.proposal, {
      sourceType: existing.sourceType,
      sourceAttentionId: existing.sourceAttentionId,
      sourceProposalId: proposalId,
      planId: existing.planId,
      lineNumber: existing.lineNumber,
      instruction: existing.originalInstruction,
    });
  });
}

/** Rebuilds the intent behind a stored proposal, so it can be recalculated. */
function intentFromProposal(db, workspaceId, proposal, overrides = {}) {
  const location = (id) => {
    if (!id) return '';
    const row = db.prepare('SELECT name FROM locations WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    return row ? row.name : '';
  };
  const lot = proposal.lotId
    ? db.prepare('SELECT code FROM lots WHERE id = ? AND workspace_id = ?').get(proposal.lotId, workspaceId)
    : null;
  const serials = proposal.serialUnitIds.map((id) => {
    const row = db.prepare('SELECT serial FROM serial_units WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    return row ? row.serial : null;
  }).filter(Boolean);

  return {
    actionType: proposal.actionType,
    item: '',
    variant: '',
    lotCode: lot ? lot.code : '',
    serials,
    sourceLocation: location(proposal.sourceLocationId),
    destinationLocation: location(proposal.destinationLocationId),
    quantity: overrides.quantity ?? proposal.quantity,
    adjustmentTarget: overrides.adjustmentTarget ?? proposal.adjustmentTarget,
    reasonCode: proposal.reasonCode || '',
    resolvedSkuId: proposal.skuId,
    settings: proposal.settings,
    assumptions: [],
  };
}

/**
 * Undo is a new, validated movement in the opposite direction — never a
 * deletion. The ledger is append-only, so "putting it back" is itself work that
 * has to be checked against what the inventory looks like now.
 */
function proposeCompensation(db, ctx, membership, proposalId) {
  const original = proposals.get(db, ctx.workspaceId, proposalId);
  if (!original) throw new NotFoundError('That action could not be found.');
  if (original.status !== 'SUCCEEDED') throw new ValidationError('That action did not run, so there is nothing to undo.');

  if (original.actionType !== 'transfer') {
    return {
      kind: 'unsupported',
      message:
        original.actionType === 'adjust'
          ? 'A correction is undone by recording another correction, with its own reason.'
          : 'Foundry can only reverse a transfer automatically. Anything else needs a new action.',
    };
  }

  permissions.assertCanPerform(membership, 'transfer');

  return inTransaction(db, () => {
    const intent = intentFromProposal(db, ctx.workspaceId, original);
    // The same move, the other way round.
    const reversed = {
      ...intent,
      sourceLocation: intent.destinationLocation,
      destinationLocation: intent.sourceLocation,
    };
    const built = proposals.build(db, ctx, reversed);
    if (!built.ok) {
      return { kind: 'question', question: built.question || built.unsupported };
    }
    const stored = proposals.persist(db, ctx, built.proposal, {
      sourceType: 'COMPENSATION',
      sourceProposalId: proposalId,
      instruction: `Reverse ${original.proposalId}`,
    });
    return { kind: 'proposal', proposal: stored };
  });
}

module.exports = {
  AGREEMENT,
  interpret,
  continueInterpretation,
  adjustmentReasonFromAnswer,
  instructionContext,
  instructionSlices,
  createPlan,
  getPlan,
  setPlanStatus,
  proposeFromAttention,
  actionabilityMessage,
  recalculate,
  reviseQuantity,
  proposeCompensation,
  intentFromProposal,
};
