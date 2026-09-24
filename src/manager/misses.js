'use strict';

const permissions = require('../actions/permissions');
const { newId, nowIso, requireText } = require('../lib/util');
const { NotFoundError } = require('../domain/errors');

function list(db, ctx, membership) {
  permissions.assertCan(membership, permissions.OPERATE, 'view Ask miss reports');
  if (permissions.can(membership, permissions.ADMIN)) {
    return db.prepare('SELECT * FROM operator_misses WHERE workspace_id = ? ORDER BY created_at DESC, id').all(ctx.workspaceId);
  }
  return db.prepare('SELECT * FROM operator_misses WHERE workspace_id = ? AND reported_by_user_id = ? ORDER BY created_at DESC, id')
    .all(ctx.workspaceId, ctx.actorId);
}

function report(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.OPERATE, 'report an Ask miss');
  const question = requireText(input.question, 'The question you asked', { max: 4000 });
  const expected = requireText(input.expectedBehavior, 'What should have happened', { max: 4000 });
  const actual = requireText(input.actualBehavior, 'What actually happened', { max: 4000 });
  const intent = db.prepare(`SELECT id FROM manager_intents WHERE workspace_id = ? AND user_id = ? AND stated_as = ?
    ORDER BY created_at DESC LIMIT 1`).get(ctx.workspaceId, ctx.actorId, question);
  const id = newId('miss');
  db.prepare(`INSERT INTO operator_misses(id, workspace_id, reported_by_user_id, intent_id, question,
    expected_behavior, actual_behavior, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ctx.workspaceId, ctx.actorId, intent?.id || null, question, expected, actual, nowIso());
  return id;
}

function review(db, ctx, membership, id, note) {
  permissions.assertCan(membership, permissions.ADMIN, 'review an Ask miss');
  if (!db.prepare('SELECT id FROM operator_misses WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, id)) throw new NotFoundError('That report is not in this inventory.');
  db.prepare(`UPDATE operator_misses SET status = 'REVIEWED', review_note = ?, reviewed_by_user_id = ?, reviewed_at = ?
    WHERE workspace_id = ? AND id = ?`).run(requireText(note, 'Review and next fix', { max: 4000 }), ctx.actorId, nowIso(), ctx.workspaceId, id);
}

module.exports = { list, report, review };
