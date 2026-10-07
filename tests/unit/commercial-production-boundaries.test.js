'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {scan}=require('../../scripts/audit-commercial-production-boundaries');
const {classification,classify}=require('../../src/commercial/production-provider-registry');
const src=path.resolve(__dirname,'..','..','src');
const read=name=>fs.readFileSync(path.join(src,name),'utf8');
// Every direct provider boundary reachable by static require from the
// PostgreSQL web or worker entrypoints must be reviewed when it changes.
// The runtime guards make legacy model/HTTP paths fail closed if invoked.
const expected={
 'actions/second-read.js':1,'ai/deadline.js':1,'ai/providers/anthropic.js':1,
 'assistant/calls.js':1,'assistant/mail-draft.js':1,'assistant/postgres-service.js':3,
 'assistant/postgres-evidence-answer.js':1,
 'assistant/understand.js':1,'attention/interpretation-service.js':1,'commercial/model.js':1,
 'commercial/stripe-billing.js':1,'connections/providers/common.js':1,'connections/reply-drafting.js':1,
 'foundry/document-intake.js':1,'foundry/understanding-service.js':3,'imports/mapping-service.js':1,
 'lib/provider-http.js':1,'manager/operating-instructions.js':1,
 'manager/postgres-operating-instructions.js':1,'operations/email.js':1,'operations/monitoring.js':1,
 'operations/postgres-monitoring.js':1,'payments/connect.js':3,'payments/providers/stripe.js':1,
 'product-brain/navigation.js':1,'purchasing/supplier-document-extractor.js':1,
 'sales/order-from-email.js':1,'shipping/providers/easypost-partner.js':1,
 'shipping/providers/easypost.js':1,'shipping/providers/shipengine.js':2,
 'shipping/providers/shippo.js':1,'shipping/providers/shipstation.js':1,
 'shipping/shipengine-platform.js':1,
};
test('PostgreSQL production dependency graph has no unclassified direct provider boundary',()=>{
 const {boundaries}=scan();const actual={};for(const item of boundaries)actual[item.file]=(actual[item.file]||0)+1;
 assert.deepEqual(actual,expected);
 assert.deepEqual(Object.keys(classification).sort(),Object.keys(expected).sort());
 const categories=new Set(['METERED','METERED_INTERNAL_COST','PLATFORM_BILLING_RECONCILED',
  'KNOWN_FIXED_INFRASTRUCTURE','NOT_PG_ENABLED']);
 for(const boundary of boundaries)assert.ok(categories.has(classify(boundary)),
  `${boundary.file}:${boundary.line} has no commercial classification`);
 // Actual PostgreSQL model entrypoints feed the commercial wrapper.
 for(const file of ['assistant/postgres-service.js','manager/postgres-operating-instructions.js',
  'imports/postgres-service.js'])assert.match(read(file),/commercial\/model/);
 assert.match(read('ai/providers/anthropic.js'),/commercial_meter_required/);
 assert.match(read('lib/provider-http.js'),/no commercial operation scope/);
 assert.match(read('operations/postgres-runtime-handlers.js'),/provider:'resend',operation:'system_email'/);
 assert.match(read('operations/postgres-monitoring.js'),/operation:'operational_alert'/);
 assert.match(read('operations/monitoring.js'),/legacy alert dispatcher is unavailable in PostgreSQL/);
 assert.match(read('shipping/shipengine-platform.js'),/legacy ShipEngine platform connector is not enabled in PostgreSQL/);
});
