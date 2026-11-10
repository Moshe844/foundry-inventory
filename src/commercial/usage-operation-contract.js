'use strict';
const {ValidationError}=require('../domain/errors');
const reads=new Set(['authorization_exchange','address_lookup','connect_authorization','connect_account_read','connect_deauthorize','webhook_registration','push_renewal',
 'catalog_sync','mailbox_poll','commerce_position_read','accounting_snapshot','accounting_verify','carrier_quote','carrier_tracking','carrier_claim_read','shipping_account_verify','inventory_read','audit_read','agent_job_status','verify_original_invoice_payment']);
const writes=new Set(['commerce_position_publish','journal_export','customer_create','invoice_create','refund_create','label_purchase','carrier_claim_submit','freight_pickup_book']);
function category(operation){if(reads.has(operation))return null;if(writes.has(operation))return 'connected_operations';if(['outbound_email','reply_email'].includes(operation))return 'emails_sent';if(operation==='outbound_webhook')return 'api_requests';throw new ValidationError('This external operation has no registered usage contract. No provider work was performed.');}
function definiteRejection(operation,error){
 if(['carrier_claim_submit','freight_pickup_book'].includes(operation))return error?.providerWriteAttempted===false;
 // Commerce delivery already retries a provider's explicit rate-limit refusal.
 // Match that policy here without treating other providers' 429s, network
 // timeouts or uncertain acknowledgements as safe to repeat.
 return operation==='commerce_position_publish'&&error?.providerOutcomeUncertain!==true&&
  (error?.providerWriteAttempted===false||Number(error?.status)===429);
}
module.exports={category,reads,writes,definiteRejection};
