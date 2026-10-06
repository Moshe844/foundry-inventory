'use strict';

const {ValidationError}=require('../domain/errors');

// Initial self-service provider set. These optional adapters remain in the
// repository for existing records and later qualified/contractual activation.
// In particular, having OAuth credentials must not silently turn one on.
const EXCLUDED=Object.freeze({
  quickbooks:'QuickBooks is not included in initial self-service launch. Existing accounting records remain available.',
  xero:'Xero is not included in initial self-service launch. Existing accounting records remain available.',
  shopify:'Shopify needs distribution and billing-term qualification before new self-service connections.',
  clover:'Clover needs App Market and developer-term qualification before new self-service connections.',
  microsoft365:'Microsoft 365 needs final live connector qualification before new self-service connections.',
  erp_future:'Custom ERP connections require a qualified contract and are not included in initial self-service launch.'
});

function reason(providerType){return EXCLUDED[String(providerType||'').toLowerCase()]||null;}
function assertNewConnection(providerType){const denied=reason(providerType);
 if(denied)throw new ValidationError(denied);}
function metadata(meta){const denied=reason(meta.type);
 return denied?{...meta,available:false,unavailableReason:denied}:meta;}

module.exports={EXCLUDED,reason,assertNewConnection,metadata};
