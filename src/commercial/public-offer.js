'use strict';
const catalog=require('./catalog');
const features=[
 ['inventory.core','Products, variants and stock movements.','starter'],
 ['purchasing.core','Purchase orders, suppliers and receiving.','starter'],
 ['sales_orders.core','Sales orders, customers and invoices.','starter'],
 ['returns.core','Returns with inspection, restocking and refunds.','starter'],
 ['imports.spreadsheet','Import files with a review before stock changes.','starter'],
 ['ask.lookup','Ask questions and open the right business page.','starter'],
 ['accounting.reports','Stock value, sales tax and accounting reports.','starter'],
 ['operations.alerts','Low-stock views and items needing attention.','starter'],
 ['shipping.workflow','Record dispatch, carriers and tracking.','starter'],
 ['communications.email_ingestion','Read your connected Gmail or Microsoft 365 mailbox.','growth'],
 ['communications.ai_drafts','Prepare business replies for your review.','growth'],
 ['communications.send_approved','Send approved emails from your connected mailbox.','growth'],
 ['shipping.labels','Rates, labels and tracking with your own shipping account.','starter'],
 ['accounting.sync','Connect your accounting account and reconcile records.','growth'],
 ['planning.basic','Review stock shortages and replenishment plans.','growth'],
 ['automation.transfers','Automatic transfers within limits you approve.','pro'],
 ['automation.purchasing','Automatic purchasing within limits you approve.','pro'],
 ['warehouse.advanced','Warehouse picking and scan verification.','pro'],
 ['api.public','Business API access with an audit trail.','pro'],
 ['support.priority','Priority email support.','growth'],
 ['support.chat','Priority support conversations inside StockChief.','pro'],
 ['migration.assisted','Onboarding, import and migration help requests.','pro'],
 ['identity.sso','Company single sign-on with your identity provider.','enterprise'],
 ['connections.custom_api','Custom APIs and data feeds for your business.','enterprise'],
];
const rank={starter:0,growth:1,pro:2,enterprise:3};
function enabled(plan,key){return (plan.entitlements||[]).some(e=>catalog.canonicalCapability(e.capability)===key&&Number(e.enabled)===1)&&catalog.capability(key)?.readiness!=='DISABLED';}
function describe(plan){const meters=new Map((plan.meters||[]).map(m=>[m.meter,m]));return {...plan,
 name:plan.id==='enterprise'?'Custom':plan.public_name,
 features:features.filter(([key,,tier])=>rank[tier]<=rank[plan.id]&&enabled(plan,key)).map(([capability,text])=>({capability,text})),
 allowances:['ai_work_credits','emails_sent','members','workspaces','locations','active_skus','import_rows','scheduled_reports','sales_channels','shipping_accounts'].map(key=>({meter:key,label:meters.get(key)?.label||catalog.meter(key)?.label,units:meters.get(key)?.included_units??null})),
 approximateWorkSteps:Math.floor(Number(meters.get('ai_work_credits')?.included_units||0)/Number(meters.get('ai_work_credits')?.credit_unit_scale||1)),
 };}
function purchasableAddons(packs){return packs.filter(p=>p.purchasable===true&&p.status==='APPROVED');}
function comparison(plans){let previous=null;return plans.slice().sort((a,b)=>Number(a.display_order||0)-Number(b.display_order||0)).map(raw=>{const plan=describe(raw),current=new Set(plan.features.map(f=>f.capability)),inherits=previous&&previous.features.every(f=>current.has(f.capability)),inherited=new Set(inherits?previous.features.map(f=>f.capability):[]),result={...plan,includesPlan:inherits?previous.name:null,incrementalFeatures:plan.features.filter(f=>!inherited.has(f.capability))};previous=plan;return result;});}
module.exports={describe,comparison,features,enabled,purchasableAddons};
