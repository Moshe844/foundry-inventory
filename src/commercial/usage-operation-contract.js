'use strict';
const {ValidationError}=require('../domain/errors');
const reads=new Set(['authorization_exchange','connect_authorization','connect_account_read','connect_deauthorize','webhook_registration','push_renewal',
 'catalog_sync','mailbox_poll','commerce_position_read','accounting_snapshot','accounting_verify','carrier_quote','carrier_tracking','shipping_account_verify','inventory_read','verify_original_invoice_payment']);
const writes=new Set(['commerce_position_publish','journal_export','customer_create','invoice_create','refund_create','label_purchase']);
function category(operation){if(reads.has(operation))return null;if(writes.has(operation))return 'connected_operations';if(['outbound_email','reply_email'].includes(operation))return 'emails_sent';if(operation==='outbound_webhook')return 'api_requests';throw new ValidationError('This external operation has no registered usage contract. No provider work was performed.');}
module.exports={category,reads,writes};
