'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const physicalEvents = require('../../src/manager/physical-events');
const inbox = require('../../src/manager/needs-you-inbox');
const dismissals = require('../../src/manager/needs-you-dismissals');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

test('dismissing a Needs You item removes it durably from the unified inbox without changing the source record', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const event = physicalEvents.record(db, workspace.ctx, {
    eventType: 'reported_event', statedAs: 'Some stock was found but its location is unknown.',
  });

  const entry = inbox.inbox(db, workspace.workspaceId)
    .find((candidate) => candidate.id === `event:${event.id}`);
  assert.ok(entry, 'the underlying shortage is initially visible');
  assert.equal(entry.dismiss.action, '/needs-you/dismiss');
  assert.equal(entry.dismiss.entryId, entry.id);

  dismissals.dismiss(db, workspace.ctx, entry.id);

  assert.equal(inbox.inbox(db, workspace.workspaceId)
    .some((candidate) => candidate.id === entry.id), false,
  'the same inbox construction no longer returns the dismissed item');
  assert.equal(physicalEvents.get(db, workspace.workspaceId, event.id).status, 'NEEDS_HUMAN',
    'dismissing an inbox prompt does not complete or otherwise mutate the source event');
  db.close();
});
