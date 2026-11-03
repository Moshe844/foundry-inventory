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
 ['communications.email_ingestion','Process incoming email from a production-supported mailbox connection.','starter'],
 ['communications.ai_drafts','Prepare business replies for your review.','growth'],
 ['communications.send_approved','Send approved emails from your connected mailbox.','growth'],
 ['shipping.labels','Rates, labels and tracking with your own shipping account.','starter'],
 ['accounting.sync','Connect supported accounting accounts for the synchronization shown on Integrations.','starter'],
 ['connections.commerce','Connect supported e-commerce and POS accounts.','starter'],
 ['planning.basic','Review stock shortages and replenishment plans.','growth'],
 ['inventory.transfers','Move stock between your locations.','starter'],
 ['payments.customer','Accept customer card payments through your connected payment account (subject to provider setup).','enterprise'],
 ['automation.transfers','Automatic transfers within limits you approve.','pro'],
 ['automation.purchasing','Automatic purchasing within limits you approve.','pro'],
 ['warehouse.advanced','Warehouse picking and scan verification.','pro'],
 ['inventory.kits','Kits and bundles made from your product variants.','pro'],
 ['authority.advanced','Custom roles and per-person purchase approval limits.','growth'],
 ['reports.advanced','Advanced report comparisons and reviewed planning scenarios.','growth'],
 ['planning.transfer_before_buy','Review transfers between warehouses before buying more.','growth'],
 ['api.public','Business API access, signed webhooks and an audit trail.','pro'],
 ['support.priority','Priority email support.','growth'],
 ['support.chat','Priority support conversations inside StockChief.','pro'],
 ['migration.assisted','Onboarding, import and migration help requests.','pro'],
 ['identity.sso','Company single sign-on with a qualified OIDC identity provider.','pro'],
 ['connections.custom_api','Custom APIs and data feeds for your business.','enterprise'],
];
function enabled(plan,key){return (plan.entitlements||[]).some(e=>catalog.canonicalCapability(e.capability)===key&&Number(e.enabled)===1)&&catalog.capability(key)?.readiness!=='DISABLED';}
function describe(plan){const meters=new Map((plan.meters||[]).map(m=>[m.meter,m]));return {...plan,
 name:plan.id==='enterprise'?'Custom':plan.public_name,
 features:features.filter(([key])=>enabled(plan,key)).map(([capability,text])=>({capability,text})),
 allowances:[...Object.keys(require('./offers/approved-2026-11-02').definitions)].map(key=>({meter:key,label:meters.get(key)?.label||catalog.meter(key)?.label,units:meters.get(key)?.included_units??null,kind:catalog.meter(key)?.kind})),
 approximateWorkSteps:Math.floor(Number(meters.get('ai_work_credits')?.included_units||0)/Number(meters.get('ai_work_credits')?.credit_unit_scale||1)),
 };}
function purchasableAddons(packs){return packs.filter(p=>p.purchasable===true&&p.status==='APPROVED');}
function comparison(plans){let previous=null;return plans.slice().sort((a,b)=>Number(a.display_order||0)-Number(b.display_order||0)).map(raw=>{const plan=describe(raw),current=new Set(plan.features.map(f=>f.capability)),inherits=previous&&previous.features.every(f=>current.has(f.capability)),inherited=new Set(inherits?previous.features.map(f=>f.capability):[]),result={...plan,includesPlan:inherits?previous.name:null,incrementalFeatures:plan.features.filter(f=>!inherited.has(f.capability))};previous=plan;return result;});}
module.exports={describe,comparison,features,enabled,purchasableAddons};
