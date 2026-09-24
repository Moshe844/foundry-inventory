'use strict';

if (process.env.NODE_ENV !== 'test' || !process.env.DATABASE_PATH) {
  throw new Error('Operational safety fixtures require an isolated test database.');
}

const { openDatabase } = require('../../src/db');
const { seedWorkspace, makeQuantityItem } = require('../helpers');
const auth = require('../../src/domain/auth-service');
const connections = require('../../src/connections/service');
const credentials = require('../../src/connections/credentials');
const suppliers = require('../../src/purchasing/supplier-service');
const learning = require('../../src/learning/service');
const repairs = require('../../src/repairs/service');
const modes = require('../../src/autopilot/modes');
const managerLoop = require('../../src/manager/loop');
const { createApp } = require('../../src/app');

const db = openDatabase(process.env.DATABASE_PATH);
const workspace = seedWorkspace(db, { workspaceName:'Operational Safety Fixture',
  email:'safety@example.test', password:'operational-ui-2026' });
const membership = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
db.prepare(`INSERT INTO workspace_configuration (workspace_id,configured_at,configuration_version,
  terminology,operational_defaults,inventory_model,updated_at) VALUES (?,datetime('now'),1,'{}','{}','{}',datetime('now'))`)
  .run(workspace.workspaceId);
const original = makeQuantityItem(db, workspace.ctx, { name:'Original Mapping', baseCode:'ORIGINAL' });
const corrected = makeQuantityItem(db, workspace.ctx, { name:'Corrected Mapping', baseCode:'CORRECTED' });
const connector = connections.create(db, workspace.ctx, membership, { providerType:'reference_webhook', displayName:'Mapping fixture' }).connection;
connections.mapExternal(db, workspace.ctx, connector.id, { entityType:'sku', externalId:'external-product', foundryRecordId:original.skuId });
const repairCase = repairs.openAndAssess(db, workspace.ctx, { kind:'wrong_mapping',
  symptom:'Interrupted mapping repair fixture', failedInvariant:'Future imports must use the approved product',
  affectedRecords:{ connectorId:connector.id, entityType:'sku', externalId:'external-product', foundryRecordId:corrected.skuId },
  idempotencyKey:'ui-interrupted-repair' }).repairCase;
repairs.approve(db, workspace.ctx, membership, repairCase.id);
db.prepare("UPDATE repair_cases SET status='EXECUTING',checkpoint='executing' WHERE id=?").run(repairCase.id);
const supplier = suppliers.createSupplier(db, workspace.ctx, membership, { name:'Measured Supplier', defaultLeadTimeDays:10 });
const proposal = learning.propose(db, workspace.workspaceId, { improvementKind:'SUPPLIER_LEAD_TIME', targetType:'SUPPLIER',
  targetId:supplier.id, headline:'Fixture: use twelve-day supplier timing', rationale:'Seeded historical outcome fixture.',
  currentValue:{ days:10 }, proposedValue:{ days:12 }, evidence:{ samples:3, meanDays:12 },
  expectedImpact:{ description:'Use the measured supplier timing.' }, ruleId:'supplier-lead-time-bias', ruleVersion:'1.0.0', materiality:'MEDIUM' });
learning.grantAuthority(db, workspace.ctx, membership, 'SUPPLIER_LEAD_TIME', {
  targetIds:[supplier.id], maximumAbsoluteChange:3, maximumPercentChange:50, maximumMateriality:'HIGH' });
modes.setMode(db, workspace.ctx, membership, modes.MODES.POLICY_AUTOMATED);
modes.pause(db, workspace.ctx, membership, 'UI interrupted-work safety test');

const mailboxes = {};
for (const providerType of ['gmail','microsoft365']) {
  const connection = connections.create(db, workspace.ctx, membership, { providerType:'supplier_email', displayName:`${providerType} pagination fixture` }).connection;
  credentials.put(db, workspace.workspaceId, connection.id, 'provider', {
    accessToken:'fixture-token',refreshToken:'fixture-refresh-token', expiresAt:Date.now() + 86400000 });
  db.prepare(`UPDATE workspace_connectors SET provider_type=?,provider_account_id=?,provider_account_name=?,
    credential_ref=?,setup_status='CONNECTED',config=? WHERE id=?`).run(providerType, `${providerType}@fixture.test`,
      `${providerType}@fixture.test`, `connection_credentials:${connection.id}`, JSON.stringify({ captureUnknownSenders:true }), connection.id);
  mailboxes[providerType] = connection.id;
}
const failed = connections.create(db, workspace.ctx, membership, { providerType:'supplier_email', displayName:'Failed Gmail fixture' }).connection;
db.prepare(`UPDATE workspace_connectors SET provider_type='gmail',status='error',setup_status='AUTHORIZATION_FAILED',
  credential_ref=NULL,last_error='Fixture authorization failure: consent was not completed.' WHERE id=?`).run(failed.id);

let fault = null;
const mailboxFetches = {
  gmail:{ listCalls:0,uniqueMessages:new Set() },
  microsoft365:{ listCalls:0,uniqueMessages:new Set() },
};
global.fetch = async (value) => {
  const url = new URL(value);
  const google = url.hostname === 'gmail.googleapis.com';
  const microsoft = url.hostname === 'graph.microsoft.com';
  if (url.hostname === 'oauth2.googleapis.com' || url.hostname === 'login.microsoftonline.com') {
    if (fault === 'transient-refresh') return Response.json({error:'temporarily_unavailable'},{status:503});
    if (fault === 'revoked-refresh') return Response.json({error:'invalid_grant'},{status:400});
    return Response.json({access_token:'fixture-refreshed-token',refresh_token:'fixture-next-refresh-token',expires_in:3600});
  }
  if (!google && !microsoft) throw new Error(`No real external requests are permitted in this fixture: ${url.hostname}`);
  if (google && url.pathname.endsWith('/profile')) return Response.json({emailAddress:fault === 'identity-mismatch' ? 'wrong@fixture.test' : 'gmail@fixture.test'});
  if (microsoft && url.pathname === '/v1.0/me') return Response.json({id:'microsoft365@fixture.test',mail:'microsoft365@fixture.test'});
  if (google && /\/messages\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split('/').pop();
    mailboxFetches.gmail.uniqueMessages.add(id);
    return Response.json({ id, threadId:id, internalDate:String(Date.now()), payload:{ mimeType:'text/plain',
      headers:[{ name:'From', value:'unapproved@fixture.test' },{ name:'Subject', value:`Gmail paginated message ${id}` }],
      body:{ data:Buffer.from('Unrelated fixture bulletin.').toString('base64url') } } });
  }
  const second = url.searchParams.has('pageToken') || url.searchParams.has('$skiptoken');
  const identifiers = Array.from({ length:second ? 26 : 50 }, (_, index) => String(second ? index + 49 : index));
  const next = fault === 'repeat' || !second;
  if (google) {
    mailboxFetches.gmail.listCalls += 1;
    return Response.json({ messages:identifiers.map((id) => ({ id })), ...(next ? { nextPageToken:'second' } : {}) });
  }
  mailboxFetches.microsoft365.listCalls += 1;
  identifiers.forEach((id) => mailboxFetches.microsoft365.uniqueMessages.add(id));
  return Response.json({ value:identifiers.map((id) => ({ id, subject:`Microsoft paginated message ${id}`,
    from:{ emailAddress:{ address:'unapproved@fixture.test' } }, body:{ content:'Unrelated fixture bulletin.' }, receivedDateTime:new Date().toISOString() })),
    ...(next ? { '@odata.nextLink':'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=second' } : {}) });
};
process.on('message', (message) => {
  if (message.type === 'stockchief.test.mail-stats') {
    process.send({ type:'stockchief.test.mail-stats',stats:Object.fromEntries(Object.entries(mailboxFetches)
      .map(([provider,value]) => [provider,{ listCalls:value.listCalls,uniqueMessages:value.uniqueMessages.size }])) });
    return;
  }
  if (message.type !== 'stockchief.test.mail-fault') return;
  fault = message.fault;
  process.send({ type:'stockchief.test.fault-set' });
});
const aiProvider = { name:'stalled-reading-fixture',model:'fixture',complete:async (request) => {
  if (request.schemaName === 'inventory_action_intent') return new Promise(() => {});
  throw new Error('No scripted model response for this fixture.');
} };
const app = createApp({ db, env:'test', sessionSecret:'operational-safety-ui',aiProvider });
app.locals.catalogueReviewDeadlineMs = 25;
const timer = setInterval(() => managerLoop.run(db, workspace.ctx, membership, { trigger:'safety-fixture-timer' }), 500);
const server = app.listen(0,'127.0.0.1', () => process.send({ type:'stockchief.test.ready', port:server.address().port,
  email:workspace.account.email, password:workspace.account.password, mailboxes, failedMailboxId:failed.id,
  repairCaseId:repairCase.id, learningProposalId:proposal.id }));
process.on('SIGTERM', () => { clearInterval(timer); server.close(() => { db.close(); process.exit(0); }); });
