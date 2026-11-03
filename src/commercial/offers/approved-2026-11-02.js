'use strict';
// Immutable approved offer. A later commercial change gets a new file/version;
// historical subscription snapshots and paid grants are never rewritten.
const id='approved-2026-11-02';
const definitions={
 products:['Active products','STRUCTURAL'],active_skus:['Active SKUs','STRUCTURAL'],import_rows:['Rows per import','PER_OPERATION'],
 members:['People, including pending invitations','STRUCTURAL'],workspaces:['Inventories','STRUCTURAL'],
 locations:['Warehouses / physical sites per inventory','STRUCTURAL'],sublocations:['Bins and zones per inventory','STRUCTURAL'],
 connections:['Connected accounts and mailboxes','STRUCTURAL'],ai_work_credits:['AI Work Credits','USAGE'],
 incoming_emails:['Incoming emails processed','USAGE'],emails_sent:['Outgoing email recipients','USAGE'],connected_operations:['Connected Operations','USAGE'],
 saved_reports:['Saved custom reports','STRUCTURAL'],scheduled_reports:['Scheduled reports','STRUCTURAL'],
 api_keys:['Active API keys','STRUCTURAL'],api_requests:['API requests and delivered webhook events','USAGE'],
 api_requests_per_minute:['API requests per minute','PER_OPERATION'],custom_roles:['Custom roles per inventory','STRUCTURAL'],
 agent_jobs:['Concurrent agent jobs across the account','PER_OPERATION'],active_imports:['Active imports across inventories','PER_OPERATION'],
 storage_bytes:['Stored business data and attachments','STRUCTURAL'],
};
const common=['identity.core','workspace.core','inventory.core','inventory.multi_location','inventory.lot_serial','inventory.counts',
 'inventory.transfers','inventory.kits','purchasing.core','purchasing.suppliers','purchasing.invoices','receiving.core',
 'sales_orders.core','fulfillment.core','returns.core','shipping.workflow','shipping.rates','shipping.labels','shipping.tracking',
 'payments.customer','accounting.core','accounting.reports','accounting.sync','accounting.explanations','accounting.post_connected',
 'ask.lookup','ask.prepare_actions','communications.email_ingestion','communications.ai_drafts','communications.send_approved',
 'connections.commerce','connections.accounting','imports.spreadsheet','planning.basic','operations.alerts','api.public'];
const growth=['planning.transfer_before_buy','warehouse.advanced','authority.advanced','support.priority','reports.advanced'];
const pro=['automation.transfers','automation.purchasing','support.chat','migration.assisted','identity.sso'];
const plans={
 starter:{name:'Starter',monthlyMinor:19900,annualMinor:199000,limits:{products:1000,active_skus:5000,import_rows:25000,members:3,workspaces:1,locations:2,sublocations:100,connections:5,ai_work_credits:3000,incoming_emails:2000,emails_sent:1000,connected_operations:5000,saved_reports:25,scheduled_reports:3,api_keys:2,api_requests:100000,api_requests_per_minute:60,custom_roles:0,agent_jobs:1,active_imports:1,storage_bytes:2000000000},capabilities:common,syncSeconds:900,authority:'review'},
 growth:{name:'Growth',monthlyMinor:49900,annualMinor:499000,limits:{products:50000,active_skus:400000,import_rows:500000,members:10,workspaces:3,locations:10,sublocations:1000,connections:20,ai_work_credits:10000,incoming_emails:20000,emails_sent:10000,connected_operations:50000,saved_reports:250,scheduled_reports:25,api_keys:10,api_requests:1000000,api_requests_per_minute:300,custom_roles:10,agent_jobs:2,active_imports:2,storage_bytes:20000000000},capabilities:[...common,...growth],syncSeconds:300,authority:'scheduled_review'},
 pro:{name:'Pro',monthlyMinor:99900,annualMinor:999000,limits:{products:250000,active_skus:1000000,import_rows:1000000,members:25,workspaces:10,locations:50,sublocations:10000,connections:100,ai_work_credits:25000,incoming_emails:100000,emails_sent:50000,connected_operations:100000,saved_reports:1000,scheduled_reports:100,api_keys:50,api_requests:5000000,api_requests_per_minute:1000,custom_roles:50,agent_jobs:4,active_imports:4,storage_bytes:100000000000},capabilities:[...common,...growth,...pro],syncSeconds:60,authority:'policy'},
};
function meters(planId){const p=plans[planId];if(!p)throw Error('Unknown approved plan');return Object.entries(definitions).map(([meter,[label,kind]])=>{
 const units=p.limits[meter];
 return {plan_id:planId,meter,label,included_units:units,hard_limit:units,overage_mode:kind==='USAGE'&&meter!=='api_requests'?'PURCHASE':'PAUSE',rollover_months:meter==='ai_work_credits'?1:0,
  credit_unit_scale:meter==='ai_work_credits'?20:1,provider_budget_minor_per_credit:meter==='ai_work_credits'?1.5:null};
 });}
function configuration(planId){const p=plans[planId];return {offerId:id,locationAccounting:'sites_and_sublocations',syncIntervalSeconds:p.syncSeconds,automationAuthority:p.authority,
 usageCategories:['ai_work_credits','incoming_emails','emails_sent','connected_operations'],stockQuantityPlanCap:null,storageUnit:'decimal_bytes',
 providerCostReserves:{aiMinorPerCredit:1.5,aiFailureFraction:0.1,incomingMinorPerMessage:0.01,outgoingMinorPerRecipient:0.09,connectedMinorPerOperation:0.05},providerCostCeilingsMinor:{ai:Math.round(p.limits.ai_work_credits*1.5*1.1)},liveCheckoutAuthorized:false};}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
module.exports=freeze({id,definitions,plans,meters,configuration});
