'use strict';
// Direct vendor boundaries statically reachable from the PostgreSQL app or
// worker. NOT_PG_ENABLED files are transitively loaded legacy code; the
// PostgreSQL Anthropic/HTTP gates deny their unscoped execution before spend.
const classification=Object.freeze({
 'actions/second-read.js':'NOT_PG_ENABLED',
 'ai/deadline.js':'NOT_PG_ENABLED',
 'ai/providers/anthropic.js':'METERED',
 'assistant/calls.js':'NOT_PG_ENABLED',
 'assistant/mail-draft.js':'NOT_PG_ENABLED',
 // Ask receives a per-call commercial/model wrapper in postgres-service;
 // planner retries, fit reviews and answers remain separate metered attempts.
 'assistant/postgres-capability-planner.js':'METERED',
 'assistant/postgres-control-plane.js':'METERED',
 'assistant/postgres-evidence-answer.js':'METERED',
 'assistant/postgres-service.js':'METERED',
 'assistant/understand.js':'NOT_PG_ENABLED',
 'attention/interpretation-service.js':'NOT_PG_ENABLED',
 'commercial/model.js':'METERED',
 'commercial/stripe-billing.js':'PLATFORM_BILLING_RECONCILED',
 'connections/postgres-reply-drafting.js':'METERED',
 'connections/providers/common.js':'METERED',
 'connections/reply-drafting.js':'NOT_PG_ENABLED',
 'foundry/document-intake.js':'NOT_PG_ENABLED',
 'foundry/understanding-service.js':'NOT_PG_ENABLED',
 'imports/mapping-service.js':'METERED',
 'lib/provider-http.js':'METERED',
 'manager/operating-instructions.js':'NOT_PG_ENABLED',
 'manager/postgres-operating-instructions.js':'METERED',
 'operations/email.js':'METERED_INTERNAL_COST',
 'operations/monitoring.js':'NOT_PG_ENABLED',
 'operations/postgres-monitoring.js':'METERED_INTERNAL_COST',
 'payments/connect.js':'METERED',
 'payments/providers/stripe.js':'METERED',
 'product-brain/navigation.js':'NOT_PG_ENABLED',
 'purchasing/supplier-document-extractor.js':'NOT_PG_ENABLED',
 'sales/order-from-email.js':'NOT_PG_ENABLED',
 'shipping/providers/easypost-partner.js':'METERED',
 'shipping/providers/easypost.js':'METERED',
 'shipping/providers/shipengine.js':'METERED',
 'shipping/providers/shippo.js':'METERED',
 'shipping/providers/shipstation.js':'METERED',
 'shipping/shipengine-platform.js':'NOT_PG_ENABLED',
});
function classify(boundary){
 if(boundary.file==='shipping/providers/shipengine.js'&&boundary.expression.includes('options.fetch'))
  return 'KNOWN_FIXED_INFRASTRUCTURE'; // Public JWKS verification fetch.
 return classification[boundary.file]||null;
}
module.exports={classification,classify};
