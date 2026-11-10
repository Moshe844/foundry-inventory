'use strict';
const {randomBytes,createHash}=require('node:crypto'),{newId}=require('../lib/util'),{ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan'),prices=require('../pricing/postgres-promotions'),money=require('../domain/currency');
const preorders=require('./preorder-supply');
const kind='customer.order-page.v1',preorderKind='customer.preorder.v1',arrivalKind='customer.preorder-arrival.v1',action='customer_order.from_page',preorderAction='customer_order.from_preorder';
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const tokenHash=s=>createHash('sha256').update(s).digest('hex');
// Customer acceptance covers selling terms. Fresh internal costs still pass every native pricing guard.
const termsHash=q=>prices.quoteHash({...q,lines:q.lines.map(l=>({...l,costUnitMinor:null}))});
function plain(v,label,max=160){if(typeof v!=='string'||!v.trim()||v.trim().length>max||/[\u0000-\u001f\u007f]/.test(v))throw new ValidationError('Enter '+label+' on one plain line, up to '+max+' characters.');return v.trim();}
function integer(v,label,max=100000){const n=Number(v);if(!Number.isSafeInteger(n)||n<1||n>max)throw new ValidationError(label+' must be one to '+max+' whole units.');return n;}
async function owner(c,ctx,lock=false){if(!(await c.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
 WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)${lock?' FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rowCount)throw new AuthorizationError('Only the current inventory owner can authorize customer order pages.');await require('../operations/postgres-warehouse-access').assertInventoryWide(c,ctx);if(lock)await c.query('SELECT a.id FROM accounts a JOIN workspaces w ON w.owner_account_id=a.id WHERE w.id=$1 FOR UPDATE OF a',[ctx.workspaceId]);}
async function access(c,ctx,{automatic=false,trained=false,checkMode=false,lock=true,preorder=false}={}){if(lock)await c.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);const a=await policy.requireWorkspaceJob(c,ctx.workspaceId,preorder?68:83,automatic?'automatic':'draft',{trained});if(checkMode){const reason=await policy.stopped(c,ctx.workspaceId,a,preorder?preorderAction:action,automatic);if(reason)throw new ValidationError(reason);}if(automatic){await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('Routine customer order drafting is paused.');}return a;}
async function preorderAuthority(c,ctx,{automatic}){
 await access(c,ctx,{preorder:true,automatic,checkMode:true});
}
async function page(c,ctx,id,lock=false){const p=(await c.query('SELECT * FROM stockchief_runtime.agent_customer_order_pages WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];if(!p)throw new NotFoundError('That customer order page is not in this inventory.');return p;}
async function basis(c,ctx,p){
 await owner(c,ctx);const customer=(await c.query("SELECT id,name,email,phone,shipping_address,tax_exempt,tax_exempt_reference FROM customers WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE'",[ctx.workspaceId,p.customer_id])).rows[0];
 if(!customer||p.delivery_method==='SHIP'&&!customer.shipping_address)throw new ValidationError('Confirm this active customer and its existing delivery address before publishing an order page.');
 if(!(await c.query('SELECT 1 FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',[ctx.workspaceId,p.location_id])).rowCount)throw new ValidationError('Choose an active internal fulfillment location.');
 const base=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.base_currency;if(base!==p.currency)throw new ValidationError('This page must use the current accounting currency. Review separately confirmed foreign-currency offers outside this workflow.');
 const precise=Boolean(p.preorder_enabled&&(p.precise_units||p.source_snapshot?.preorderPrecision===true));
 if(!Array.isArray(p.sku_ids)||!p.sku_ids.length||p.sku_ids.length>100||new Set(p.sku_ids).size!==p.sku_ids.length)throw new ValidationError('Choose one to 100 distinct products for this customer.');
 const products=(await c.query(`SELECT s.id,s.code,i.name,pr.amount_minor::text,pr.currency,pr.id price_id${precise?',i.unit_label,i.quantity_increment,i.quantity_precision,i.tracking_mode':''} FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 JOIN LATERAL(SELECT p.id,p.amount_minor,p.currency FROM sku_prices p WHERE p.workspace_id=s.workspace_id AND p.sku_id=s.id ORDER BY p.created_at DESC,p.id DESC LIMIT 1)pr ON true
 WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1 AND i.secondary_unit_label IS NULL${precise?" AND i.tracking_mode IN ('quantity','lot','serial')":" AND i.tracking_mode='quantity' AND i.quantity_precision=0"}
 AND NOT EXISTS(SELECT 1 FROM kit_components k WHERE k.workspace_id=s.workspace_id AND k.kit_sku_id=s.id) ORDER BY s.id`,[ctx.workspaceId,p.sku_ids])).rows;
 if(products.length!==p.sku_ids.length||products.some(s=>s.currency!==p.currency||!Number.isSafeInteger(Number(s.amount_minor))||Number(s.amount_minor)<=0))throw new ValidationError('Every offered product needs a current selling price and supported stock units. Kits and catch-weight goods need separate review.');
 if(!p.tax_rate_id&&p.tax_treatment!=='NON_TAXABLE_CONFIRMED')throw new ValidationError('Choose the confirmed sales tax rate, or explicitly confirm the non-taxable treatment.');
 const input={orderDate:await require('../lib/business-time').today(c,ctx.workspaceId),customerId:customer.id,currency:p.currency,deliveryMethod:p.delivery_method,fulfillmentLocationId:p.location_id,taxRateId:p.tax_rate_id||undefined,lines:products.map(s=>({skuId:s.id,quantity:precise?Number(s.quantity_increment):1}))};
 const quote=await prices.prepareQuote(c,ctx,input);if(quote.violations.length)throw new ValidationError('Resolve the current selling-price safeguards before publishing this page.');
 const preorderSources=p.preorder_enabled?p.preorder_sources||await preorders.offered(c,ctx.workspaceId,p.id):null;
 if(preorderSources){await policy.requireWorkspaceJob(c,ctx.workspaceId,68,'draft');if(preorderSources.length!==p.sku_ids.length)throw new ValidationError('This preorder needs a placed source for each offered product.');}
 const snapshot={customer,products,locationId:p.location_id,deliveryMethod:p.delivery_method,taxTreatment:p.tax_treatment,taxRateId:p.tax_rate_id||null,currency:p.currency,quoteHash:termsHash(quote),...(preorderSources?{preorderSources}:{}),...(precise?{preorderPrecision:true}:{})};return {snapshot,hash:prices.hash(snapshot),products,customer,input,quote,preorderSources};
}
async function publish(db,ctx,input){return tx(db,async c=>{
 await owner(c,ctx,true);const prior=input.id?await page(c,ctx,input.id,true):null;
 const preorderOrder=String(input.preorderOrder||'').trim(),preorder=Boolean(preorderOrder||input.keepPreorder&&prior?.preorder_enabled);
 await access(c,ctx,{preorder});if(prior&&Number(input.revision)!==prior.revision)throw new ValidationError('Reload the current customer page before republishing.');
 const currency=money.code(input.currency),skuCodes=(Array.isArray(input.skuCodes)?input.skuCodes:String(input.skuCodes||'').split(/\r?\n/)).map(v=>String(v).trim()).filter(Boolean);
 let skuIds=input.skuIds;if(!skuIds){if(!skuCodes.length||skuCodes.length>100||new Set(skuCodes).size!==skuCodes.length)throw new ValidationError('Enter one to 100 distinct exact SKU codes.');const matches=(await c.query('SELECT id,code FROM skus WHERE workspace_id=$1 AND code=ANY($2::text[])',[ctx.workspaceId,skuCodes])).rows;if(matches.length!==skuCodes.length)throw new ValidationError('Match every exact SKU code to one product in this inventory.');skuIds=matches.map(s=>s.id);}
 const p={customer_id:String(input.customerId),location_id:String(input.locationId),delivery_method:String(input.deliveryMethod),currency,tax_rate_id:input.taxRateId||null,tax_treatment:input.taxRateId?'CONFIRMED_RATE':input.taxTreatment,sku_ids:skuIds};
 if(!['SHIP','PICKUP'].includes(p.delivery_method)||input.confirmed!=='yes')throw new ValidationError('Confirm the exact customer, published products/prices, delivery scope, tax treatment and public-link authority.');
 if(prior&&prior.customer_id!==p.customer_id)throw new ValidationError('Use a separate page for another customer.');
 if(preorder){
  await policy.requireWorkspaceJob(c,ctx.workspaceId,68,'draft');
  p.preorder_enabled=true;
  p.precise_units=true;
  p.preorder_sources=preorderOrder?await preorders.selectOrder(c,ctx,p,preorderOrder):await preorders.offered(c,ctx.workspaceId,prior.id);
  await preorders.current(c,ctx,p,p.preorder_sources,{lock:true});
 }
 const f=await basis(c,ctx,p),maximumUnits=integer(input.maximumUnits,'Maximum quantity per product'),maximumMinor=money.userToMinor(input.maximumAmount,currency,{label:'Maximum total per customer request'});if(maximumMinor<=0)throw new ValidationError('Choose a positive request total limit.');
 const days=integer(input.expiryDays,'Link validity in days',30),label=plain(input.label,'the customer page title',120),id=prior?.id||newId('customer-page'),token=randomBytes(32).toString('base64url');
 if((await c.query('SELECT 1 FROM stockchief_runtime.agent_customer_order_pages WHERE workspace_id=$1 AND lower(label)=lower($2) AND id<>$3',[ctx.workspaceId,label,id])).rowCount)throw new ValidationError('A customer page already uses this title. Renew its existing link, or choose a different title for a different page.');
 await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'customer-page:'+id,Buffer.byteLength(JSON.stringify(f.snapshot))+16384,{finished:true});
 if(prior){await c.query('UPDATE stockchief_runtime.agent_customer_order_pages SET location_id=$3,label=$4,delivery_method=$5,currency=$6,tax_rate_id=$7,tax_treatment=$8,sku_ids=$9::jsonb,source_snapshot=$10::jsonb,source_hash=$11,maximum_units=$12,maximum_minor=$13,token_hash=$14,expires_at=clock_timestamp()+$15::int*interval \'1 day\',enabled=true,routine_enabled=false,authorized_by=$16,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,p.location_id,label,p.delivery_method,currency,p.tax_rate_id,p.tax_treatment,JSON.stringify(skuIds),JSON.stringify(f.snapshot),f.hash,maximumUnits,maximumMinor,tokenHash(token),days,ctx.actorId]);await c.query('UPDATE stockchief_runtime.agent_customer_page_rules SET enabled=false,revision=revision+1 WHERE workspace_id=$1 AND page_id=$2',[ctx.workspaceId,id]);}
 else await c.query('INSERT INTO stockchief_runtime.agent_customer_order_pages(id,workspace_id,customer_id,location_id,label,delivery_method,currency,tax_rate_id,tax_treatment,sku_ids,source_snapshot,source_hash,maximum_units,maximum_minor,token_hash,expires_at,authorized_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,clock_timestamp()+$16::int*interval \'1 day\',$17)',[id,ctx.workspaceId,p.customer_id,p.location_id,label,p.delivery_method,currency,p.tax_rate_id,p.tax_treatment,JSON.stringify(skuIds),JSON.stringify(f.snapshot),f.hash,maximumUnits,maximumMinor,tokenHash(token),days,ctx.actorId]);
 if(p.preorder_enabled||prior?.preorder_enabled){
  await c.query('DELETE FROM stockchief_runtime.agent_preorder_sources WHERE workspace_id=$1 AND page_id=$2',[ctx.workspaceId,id]);
  await c.query('UPDATE stockchief_runtime.agent_customer_order_pages SET preorder_enabled=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,Boolean(p.preorder_enabled)]);
  if(p.preorder_enabled)await c.query(`INSERT INTO stockchief_runtime.agent_preorder_sources(workspace_id,page_id,sku_id,purchase_order_line_id)
    SELECT $1,$2,source.sku_id,source.purchase_order_line_id FROM jsonb_to_recordset($3::jsonb) AS source(sku_id text,purchase_order_line_id text)`,
    [ctx.workspaceId,id,JSON.stringify(p.preorder_sources)]);
 }
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Customer order page published with exact approved scope',reference:id,after:{customerId:p.customer_id,products:skuIds,locationId:p.location_id,maximumUnits,maximumMinor,days,priorLinksRevoked:Boolean(prior),routineDrafting:false,preorder:p.preorder_enabled===true}});return {id,token,revision:(prior?.revision||0)+1};
 });}
async function renew(db,ctx,id,input){return tx(db,async c=>{await owner(c,ctx,true);const p=await page(c,ctx,id,true);await access(c,ctx,{preorder:p.preorder_enabled});if(Number(input.revision)!==p.revision||input.confirmed!=='yes')throw new ValidationError('Reload and confirm renewing this exact published customer offer.');if((await basis(c,ctx,p)).hash!==p.source_hash)throw new ValidationError('The customer, products, prices or tax treatment changed. Publish a newly reviewed offer instead.');return publish(scoped(c),ctx,{id,revision:p.revision,label:p.label,customerId:p.customer_id,locationId:p.location_id,deliveryMethod:p.delivery_method,currency:p.currency,taxRateId:p.tax_rate_id,taxTreatment:p.tax_treatment,skuIds:p.sku_ids,maximumUnits:p.maximum_units,maximumAmount:money.fromMinor(p.maximum_minor,p.currency),expiryDays:input.expiryDays,confirmed:'yes',keepPreorder:p.preorder_enabled});});}
async function publicContext(c,token,{lock=false}={}){
 if(typeof token!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(token))throw new NotFoundError('This customer order link is unavailable. Contact the business.');
 const p=(await c.query('SELECT * FROM stockchief_runtime.agent_customer_order_pages WHERE token_hash=$1 AND enabled AND expires_at>clock_timestamp()'+(lock?' FOR UPDATE':''),[tokenHash(token)])).rows[0];if(!p)throw new NotFoundError('This customer order link is unavailable. Contact the business.');
 const ctx={workspaceId:p.workspace_id,actorId:p.authorized_by};await owner(c,ctx);await access(c,ctx,{lock:false,preorder:p.preorder_enabled});const f=await basis(c,ctx,p);if(f.hash!==p.source_hash)throw new ValidationError('The published order details need review by the business. Please contact them before sending a request.');return {p,ctx,f};
}
function requestLines(p,products,raw){
 if(!Array.isArray(raw)||!raw.length||raw.length>100)throw new ValidationError('Choose one to 100 listed products.');
 const lines=[],seen=new Set(),byId=new Map(products.map(product=>[product.id,product]));
 for(const line of raw){
  if(!line||typeof line!=='object')throw new ValidationError('Choose listed products and enter their quantities.');
  if(String(line.quantity||'').trim()===''||Number(line.quantity)===0)continue;
  const skuId=String(line.skuId),product=byId.get(skuId);
  if(!product||seen.has(skuId))throw new ValidationError('Choose each offered product once.');
  const quantity=product.quantity_increment===undefined?integer(line.quantity,'Requested quantity',p.maximum_units):
   require('../domain/stock-quantity').validate(product,line.quantity,{label:'Quantity for '+product.code});
  if(quantity>p.maximum_units)throw new ValidationError('The quantity exceeds the confirmed limit for '+product.code+'.');
  seen.add(skuId);
  lines.push({skuId,quantity});
 }
 if(!lines.length)throw new ValidationError('Choose a positive quantity for at least one offered product.');
 return lines.sort((a,b)=>a.skuId.localeCompare(b.skuId));
}
async function quoteRequest(c,token,input,{preview=true}={}){const {p,ctx,f}=await publicContext(c,token),reference=plain(input.reference,'your purchase order or request reference',80),lines=requestLines(p,f.products,input.lines),orderInput={...f.input,lines,reference,shipToAddress:p.delivery_method==='SHIP'?f.customer.shipping_address:undefined},quote=await prices.prepareQuote(c,ctx,orderInput);if(quote.violations.length||quote.totalMinor<=0||quote.totalMinor>Number(p.maximum_minor))throw new ValidationError('This request needs the business to review its quantities, prices or total limit.');
 const incoming=f.preorderSources&&preview?await preorders.requireCapacity(c,ctx,p,f.preorderSources,lines):null;
 const preorderArrival=incoming?incoming.map(row=>row.expected_date).sort().at(-1):null;
 const source={pageId:p.id,pageRevision:p.revision,sourceHash:p.source_hash,input:orderInput,quoteHash:termsHash(quote),...(f.preorderSources?{preorder:true}:{})},snapshot={...source,quote,nativeQuoteHash:prices.quoteHash(quote),products:f.products.filter(s=>lines.some(l=>l.skuId===s.id))};return {p,ctx,f,snapshot,preorderArrival,requestHash:prices.hash({...source,pageRevision:undefined,input:{...orderInput,reference:reference.toLowerCase()}}),reference};}
async function submit(db,token,input){return tx(db,async c=>{
 const q=await quoteRequest(c,token,input,{preview:false}),{p,ctx,snapshot,requestHash,reference}=q;await owner(c,ctx,true);await access(c,ctx,{preorder:p.preorder_enabled});await page(c,ctx,p.id,true);
 if(input.confirmed!=='yes'||input.expectedHash!==requestHash)throw new ValidationError('Review the exact products, quantities and current total before sending this request.');
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([ctx.workspaceId,p.customer_id,reference.toLowerCase()])]);
 const prior=(await c.query('SELECT * FROM stockchief_runtime.agent_customer_page_requests WHERE workspace_id=$1 AND customer_id=$2 AND reference_key=$3',[ctx.workspaceId,p.customer_id,reference.toLowerCase()])).rows[0];if(prior){if(prior.request_hash!==requestHash)throw new ValidationError('This customer reference already contains different request details. Contact the business before sending another version.');return {id:prior.id,replayed:true};}
 if((await c.query('SELECT 1 FROM sales_orders WHERE workspace_id=$1 AND customer_id=$2 AND lower(reference)=lower($3)',[ctx.workspaceId,p.customer_id,reference])).rowCount)throw new ValidationError('This customer reference has already been used. Contact the business.');
 const count=(await c.query("SELECT count(*)::int n FROM(SELECT 1 FROM stockchief_runtime.agent_customer_page_requests WHERE workspace_id=$1 AND status='RECEIVED' LIMIT 1001)p",[ctx.workspaceId])).rows[0].n;if(count>=1000)throw new ValidationError('The business has a full request queue. Please contact them directly.');
 const incoming=q.f.preorderSources?await preorders.requireCapacity(c,ctx,p,q.f.preorderSources,snapshot.input.lines,{lock:true}):null;
 if(incoming){
  const currentArrival=incoming.map(line=>line.expected_date).sort().at(-1);
  if(input.expectedArrival!==currentArrival)throw new ValidationError('The expected stock arrival changed. Review the current date before sending this preorder.');
  snapshot.preorderArrival=currentArrival;
 }
 const id=newId('customer-request');await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'customer-page-request:'+id,Buffer.byteLength(JSON.stringify(snapshot))+16384,{finished:true});
 await c.query('INSERT INTO stockchief_runtime.agent_customer_page_requests(id,workspace_id,page_id,customer_id,reference,reference_key,source_hash,request_hash,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',[id,ctx.workspaceId,p.id,p.customer_id,reference,reference.toLowerCase(),p.source_hash,requestHash,JSON.stringify(snapshot)]);
 if(incoming)await preorders.claim(c,ctx,id,incoming);
 await require('../operations/postgres-job-queue').enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind:incoming?preorderKind:kind,idempotencyKey:id,payload:{requestId:id,ownerId:ctx.actorId},priority:65});return {id};
 });}
async function request(c,ctx,id,lock=false){const r=(await c.query('SELECT * FROM stockchief_runtime.agent_customer_page_requests WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];if(!r)throw new NotFoundError('That customer request is not in this inventory.');return r;}
function scope(r,p){return {customerId:p.customer_id,sourceHash:p.source_hash,locationId:p.location_id,deliveryMethod:p.delivery_method,quoteHash:r.snapshot.quoteHash,lines:r.snapshot.input.lines};}
async function completedExample(c,ctx,r,p){if(r.status!=='DRAFTED'||r.automatic||r.processed_by!==ctx.actorId||r.page_id!==p.id||r.source_hash!==p.source_hash)throw new ValidationError('Teach a matching individually reviewed page request after its order is confirmed.');const o=(await c.query("SELECT status,customer_id,fulfillment_location_id,delivery_method,ship_to_address,pricing_quote_id FROM sales_orders WHERE workspace_id=$1 AND id=$2 AND created_by_user_id=$3",[ctx.workspaceId,r.sales_order_id,ctx.actorId])).rows[0],quote=o?.pricing_quote_id?(await c.query('SELECT quote FROM stockchief_runtime.pricing_order_snapshots WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,o.pricing_quote_id])).rows[0]?.quote:null;if(!o||!['CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED'].includes(o.status)||o.customer_id!==p.customer_id||o.fulfillment_location_id!==p.location_id||o.delivery_method!==p.delivery_method||p.delivery_method==='SHIP'&&o.ship_to_address!==p.source_snapshot.customer.shipping_address||!quote||termsHash(quote)!==r.snapshot.quoteHash)throw new ValidationError('The completed customer order no longer proves this exact page request, prices, quantities and delivery scope.');return true;}
async function createDraft(db,ctx,id,input={}, {automatic=false}={}){return tx(db,async c=>{
 await owner(c,ctx,true);const r=await request(c,ctx,id,true),p=await page(c,ctx,r.page_id,true);
 await access(c,ctx,{preorder:p.preorder_enabled});
 if(r.status==='DRAFTED')return {id,salesOrderId:r.sales_order_id,replayed:true};if(r.status!=='RECEIVED')throw new ValidationError('That customer request was stopped.');
 if(!p.enabled||new Date(p.expires_at).getTime()<=Date.now()||p.authorized_by!==ctx.actorId)throw new ValidationError('This customer page stopped or expired. Review the customer request individually through a current page.');
 const f=await basis(c,ctx,p);if(f.hash!==r.source_hash||p.source_hash!==r.source_hash)throw new ValidationError('Customer, delivery, product, pricing or tax details changed. Obtain a fresh reviewed customer request.');
 const quote=await prices.prepareQuote(c,ctx,r.snapshot.input,{lock:true});if(termsHash(quote)!==r.snapshot.quoteHash||quote.violations.length||quote.totalMinor>Number(p.maximum_minor))throw new ValidationError('The exact accepted customer total or current safeguards changed. Obtain a fresh request.');
 if(f.preorderSources){
  await preorderAuthority(c,ctx,{automatic});
  await preorders.assertCurrentClaim(c,ctx,p,f.preorderSources,id,r.snapshot.input.lines);
  if(automatic){
   if(!p.routine_enabled)throw new ValidationError('This preorder page needs individual review.');
   if(await policy.customerOrderNeedsPerson(c,ctx.workspaceId,'sales_order.create',r.snapshot.input))throw new ValidationError('A person must review the first order for this customer or delivery address.');
  }else if(input.confirmed!=='yes'||input.expectedHash!==r.request_hash){
   throw new ValidationError('Review and approve the original preorder before creating its native order.');
  }
 }else if(automatic){
  if(!p.routine_enabled)throw new ValidationError('This customer page requires individual request review.');const scopeHash=prices.hash(scope(r,p)),rule=(await c.query('SELECT * FROM stockchief_runtime.agent_customer_page_rules WHERE workspace_id=$1 AND page_id=$2 AND scope_hash=$3 AND enabled FOR SHARE',[ctx.workspaceId,p.id,scopeHash])).rows[0];let trained=false;
  if(rule&&rule.authorized_by===ctx.actorId){const e=await request(c,ctx,rule.example_request_id);trained=await completedExample(c,ctx,e,p);if(prices.hash(scope(e,p))!==scopeHash)throw new ValidationError('This taught request scope changed. Review this order individually.');}
  await access(c,ctx,{automatic:true,trained,checkMode:true});if(await policy.customerOrderNeedsPerson(c,ctx.workspaceId,'sales_order.create',r.snapshot.input))throw new ValidationError('A person must review the first order for this customer or delivery address.');
 }else{await access(c,ctx,{checkMode:true});if(input.confirmed!=='yes'||input.expectedHash!==r.request_hash)throw new ValidationError('Review and approve this exact original customer request before creating its order draft.');}
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([ctx.workspaceId,p.customer_id,r.reference_key])]);if((await c.query('SELECT 1 FROM sales_orders WHERE workspace_id=$1 AND customer_id=$2 AND lower(reference)=lower($3)',[ctx.workspaceId,p.customer_id,r.reference])).rowCount)throw new ValidationError('Another order already uses this customer reference. Review it instead of creating a duplicate.');
 await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'customer-order-draft:'+id,Buffer.byteLength(JSON.stringify(r.snapshot))*2+32768,{finished:true});
 const operations=require('../operations/postgres-business-workflows');
 const result=await operations.createSalesOrderInTransaction(c,ctx,{...r.snapshot.input,pricingQuoteHash:prices.quoteHash(quote),idempotencyKey:'customer-order-page:'+id});
 await c.query("UPDATE stockchief_runtime.agent_customer_page_requests SET status='DRAFTED',sales_order_id=$3,automatic=$4,processed_by=$5,processed_at=clock_timestamp(),problem=NULL WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,result.salesOrderId,automatic,ctx.actorId]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Original customer page request drafted',reference:id,after:{salesOrderId:result.salesOrderId,automatic,awaitingLinkedReceipt:Boolean(f.preorderSources&&automatic),stockAndPaymentsUnchanged:true}});return {id,...result,automatic};
 });}
async function configure(db,ctx,id,input){return tx(db,async c=>{await owner(c,ctx,true);const p=await page(c,ctx,id,true);if(Number(input.revision)!==p.revision)throw new ValidationError('Reload the current page before changing authority.');if(input.stop==='yes'){await c.query('UPDATE stockchief_runtime.agent_customer_order_pages SET enabled=false,routine_enabled=false,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);await c.query('UPDATE stockchief_runtime.agent_customer_page_rules SET enabled=false,revision=revision+1 WHERE workspace_id=$1 AND page_id=$2',[ctx.workspaceId,id]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Customer order page stopped and link revoked',reference:id});return {id};}if(p.preorder_enabled)await preorderAuthority(c,ctx,{automatic:true});else await access(c,ctx,{automatic:true,trained:true,checkMode:true});if(input.confirmed!=='yes')throw new ValidationError(p.preorder_enabled?'Confirm routine preorder acceptance from this exact customer, incoming stock and price limits.':'Confirm routine creation of unapproved drafts within this exact published customer page and limits.');const f=await basis(c,ctx,p);if(!p.enabled||f.hash!==p.source_hash)throw new ValidationError('Republish the current exact offer before enabling routine drafts.');await c.query('UPDATE stockchief_runtime.agent_customer_order_pages SET routine_enabled=true,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Routine customer page drafting authorized',reference:id,after:{maximumUnits:p.maximum_units,maximumMinor:Number(p.maximum_minor),proRequiresMatchingCompletedExample:!p.preorder_enabled,ordersRemainDrafts:!p.preorder_enabled}});return {id};});}
async function teach(db,ctx,id,input){return tx(db,async c=>{await owner(c,ctx,true);const r=await request(c,ctx,id,true),p=await page(c,ctx,r.page_id,true);await access(c,ctx,{checkMode:true});if(!p.enabled||new Date(p.expires_at).getTime()<=Date.now()||(await basis(c,ctx,p)).hash!==p.source_hash)throw new ValidationError('Republish the current customer offer before teaching a new request.');await completedExample(c,ctx,r,p);if(input.confirmed!=='yes')throw new ValidationError('Confirm teaching only this exact completed customer order shape, prices, quantities and delivery scope.');const value=scope(r,p),scopeHash=prices.hash(value),prior=(await c.query('SELECT * FROM stockchief_runtime.agent_customer_page_rules WHERE workspace_id=$1 AND page_id=$2 AND scope_hash=$3 FOR UPDATE',[ctx.workspaceId,p.id,scopeHash])).rows[0];if(prior?.enabled)return {id:prior.id,replayed:true};await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);const ruleId=prior?.id||newId('customer-page-rule');await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'customer-page-rule:'+ruleId,Buffer.byteLength(JSON.stringify(value))+8192,{finished:true});if(prior)await c.query('UPDATE stockchief_runtime.agent_customer_page_rules SET enabled=true,example_request_id=$3,authorized_by=$4,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ruleId,id,ctx.actorId]);else await c.query('INSERT INTO stockchief_runtime.agent_customer_page_rules(id,workspace_id,page_id,scope_hash,scope,example_request_id,authorized_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)',[ruleId,ctx.workspaceId,p.id,scopeHash,JSON.stringify(value),id,ctx.actorId]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Completed customer page request taught',reference:id,after:{ruleId,scope:value}});return {id:ruleId};});}
async function stopRequest(db,ctx,id,input){return tx(db,async c=>{await owner(c,ctx,true);const r=await request(c,ctx,id,true);if(input.confirmed!=='yes')throw new ValidationError('Confirm stopping this unprocessed customer request.');if(r.status==='DRAFTED')throw new ValidationError('Use the existing order to review or cancel a created draft.');await c.query("UPDATE stockchief_runtime.agent_customer_page_requests SET status='STOPPED' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id]);return {id};});}
async function onRequest(db,workspaceId,id,ownerId,{preorder=false}={}){try{
 const result=await createDraft(db,{workspaceId,actorId:ownerId},id,{}, {automatic:true});
 if(preorder)await settlePreorders(db,workspaceId,{requestId:id});
 return result;
}catch(e){if(![400,402,403,404,422].includes(e.status))throw e;await db.query("UPDATE stockchief_runtime.agent_customer_page_requests SET problem=$3 WHERE workspace_id=$1 AND id=$2 AND status='RECEIVED'",[workspaceId,id,String(e.message).slice(0,500)]);return {held:true,reason:e.message};}}
async function preorderSchemaExists(db){
 const {rows:[row]}=await db.query("SELECT to_regclass('stockchief_runtime.agent_preorder_claims') IS NOT NULL AS installed");
 return row.installed;
}
async function queueArrival(client,ctx,receiptId,lineIds){
 if(!await preorderSchemaExists(client))return;
 const affected=(await client.query(`SELECT 1 FROM stockchief_runtime.agent_preorder_claims
  WHERE workspace_id=$1 AND purchase_order_line_id=ANY($2::text[]) LIMIT 1`,[ctx.workspaceId,lineIds])).rowCount;
 if(affected)await require('../operations/postgres-job-queue').enqueue(scoped(client),{
  workspaceId:ctx.workspaceId,kind:arrivalKind,idempotencyKey:receiptId,payload:{receiptId},priority:70});
}

async function settlePreorders(db,workspaceId,{requestId=null,receiptId=null}={}){
 const state=await policy.accountState(db,workspaceId);
 if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,68,'automatic')||!await preorderSchemaExists(db))return {reserved:0,held:0};
 const due=(await db.query(`SELECT r.id,p.authorized_by FROM stockchief_runtime.agent_customer_page_requests r
  JOIN stockchief_runtime.agent_customer_order_pages p ON p.workspace_id=r.workspace_id AND p.id=r.page_id
  JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id
  WHERE r.workspace_id=$1 AND r.status='DRAFTED' AND r.automatic AND p.preorder_enabled AND p.enabled AND p.routine_enabled
    AND p.source_hash=r.source_hash AND o.status='DRAFT' AND ($2::text IS NULL OR r.id=$2)
    AND EXISTS(SELECT 1 FROM stockchief_runtime.agent_preorder_claims claim
      JOIN purchase_order_receipt_lines l ON l.workspace_id=claim.workspace_id AND l.purchase_order_line_id=claim.purchase_order_line_id AND l.location_id=claim.location_id
      JOIN purchase_order_receipts receipt ON receipt.workspace_id=l.workspace_id AND receipt.id=l.receipt_id
      JOIN balances balance ON balance.workspace_id=claim.workspace_id AND balance.sku_id=claim.sku_id AND balance.location_id=claim.location_id
      WHERE claim.workspace_id=r.workspace_id AND claim.request_id=r.id AND receipt.created_at::timestamptz>=claim.created_at AND balance.on_hand>0
        AND ($3::text IS NULL OR receipt.id=$3))
  ORDER BY o.allocation_priority,o.needed_by NULLS LAST,o.created_at,o.id LIMIT 25`,[workspaceId,requestId,receiptId])).rows;
 const result={reserved:0,held:0};
 for(const candidate of due){
  const ctx={workspaceId,actorId:candidate.authorized_by};
  try{
   const done=await tx(db,async c=>{
    await owner(c,ctx,true);await preorderAuthority(c,ctx,{automatic:true});
    const r=await request(c,ctx,candidate.id,true),p=await page(c,ctx,r.page_id,true);
    if(!r.automatic||!p.preorder_enabled||!p.enabled||!p.routine_enabled||p.source_hash!==r.source_hash||p.authorized_by!==ctx.actorId){
     throw new ValidationError('The exact preorder authority changed.');
    }
    if(!(await preorders.hasArrived(c,ctx,r.id)))return false;
    const order=(await c.query(`SELECT o.*,snap.quote FROM sales_orders o
      JOIN stockchief_runtime.pricing_order_snapshots snap ON snap.workspace_id=o.workspace_id AND snap.id=o.pricing_quote_id
      WHERE o.workspace_id=$1 AND o.id=$2 FOR UPDATE OF o`,[workspaceId,r.sales_order_id])).rows[0];
    if(order&&order.status!=='DRAFT')return false;
    if(!order||order.customer_id!==p.customer_id||order.fulfillment_location_id!==p.location_id||
      order.delivery_method!==p.delivery_method||order.currency!==p.currency||order.reference!==r.reference||
      (p.delivery_method==='SHIP'&&order.ship_to_address!==r.snapshot.input.shipToAddress)||
      termsHash(order.quote)!==r.snapshot.quoteHash)throw new ValidationError('The native preorder changed. Review it before setting stock aside.');
    const lines=(await c.query('SELECT id,sku_id,quantity_ordered FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2 FOR SHARE',
      [workspaceId,order.id])).rows;
    const accepted=new Map(r.snapshot.input.lines.map(row=>[row.skuId,row.quantity]));
    if(lines.length!==accepted.size||new Set(lines.map(row=>row.sku_id)).size!==accepted.size||
      lines.some(row=>Number(row.quantity_ordered)!==accepted.get(row.sku_id)))throw new ValidationError('The native preorder quantities changed.');
    const reserved=await require('../operations/postgres-business-workflows').confirmSalesOrderInTransaction(c,ctx,order.id,
      {idempotencyKey:'preorder-arrived:'+r.id,requireFullAllocation:true});
    const expected=new Map(lines.map(row=>[row.id,Number(row.quantity_ordered)]));
    if(reserved.status!=='CONFIRMED'||reserved.allocations.length!==expected.size||
      reserved.allocations.some(row=>row.locationId!==p.location_id||row.quantity!==expected.get(row.lineId))){
      throw new ValidationError('The exact preorder cannot be reserved at the promised location.');
    }
    await c.query('UPDATE stockchief_runtime.agent_customer_page_requests SET problem=NULL WHERE workspace_id=$1 AND id=$2',[workspaceId,r.id]);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Reserved arrived stock for accepted preorder',reference:r.reference,
      after:{orderId:order.id,units:[...accepted].map(([sku,quantity])=>({sku,quantity}))}});
    return true;
   });
   if(done)result.reserved++;
  }catch(error){
   if(!['entitlement_required','forbidden','validation_error','not_found'].includes(error.code))throw error;
   result.held++;
   await db.query('UPDATE stockchief_runtime.agent_customer_page_requests SET problem=$3 WHERE workspace_id=$1 AND id=$2',
     [workspaceId,candidate.id,String(error.message).slice(0,500)]);
  }
 }
 return result;
}
async function screen(db,ctx,input={}){
 await owner(db,ctx);const state=await policy.accountState(db,ctx.workspaceId),allowed=policy.usesAgentTerms(state)&&policy.permits(state.plan,83,'draft'),profilePage=integer(input.profilesPage||1,'Page number',10000),requestPage=integer(input.requestsPage||1,'Page number',10000);
 const profiles=(await db.query('SELECT p.*,c.name customer_name,l.name location_name FROM stockchief_runtime.agent_customer_order_pages p JOIN customers c ON c.workspace_id=p.workspace_id AND c.id=p.customer_id JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id WHERE p.workspace_id=$1 ORDER BY p.created_at DESC,p.id LIMIT 101 OFFSET $2',[ctx.workspaceId,(profilePage-1)*100])).rows;
 const requests=(await db.query('SELECT r.*,c.name customer_name,o.order_number FROM stockchief_runtime.agent_customer_page_requests r JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id LEFT JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id WHERE r.workspace_id=$1 ORDER BY r.created_at DESC,r.id LIMIT 101 OFFSET $2',[ctx.workspaceId,(requestPage-1)*100])).rows;
 const preordersAllowed=policy.usesAgentTerms(state)&&policy.permits(state.plan,68,'draft'),
   automaticPreorders=preordersAllowed&&policy.permits(state.plan,68,'automatic')&&!state.shadow,canPublish=allowed||preordersAllowed;
 const customers=canPublish?(await db.query("SELECT id,name FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' ORDER BY name,id LIMIT 201",[ctx.workspaceId])).rows:[],locations=canPublish?(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL ORDER BY name,id LIMIT 251',[ctx.workspaceId])).rows:[],taxRates=canPublish?(await db.query("SELECT id,name FROM accounting_tax_rates WHERE workspace_id=$1 AND active=1 AND applies_to IN('SALES','BOTH') ORDER BY name,id LIMIT 101",[ctx.workspaceId])).rows:[],currency=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.base_currency;
 const selected=input.requestId?await request(db,ctx,input.requestId):null;
 if(selected?.snapshot.preorder&&selected.sales_order_id){
  selected.order_status=(await db.query('SELECT status FROM sales_orders WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,selected.sales_order_id])).rows[0]?.status||'DRAFT';
 }
 if(selected?.status==='DRAFTED'&&!selected.automatic&&!selected.snapshot.preorder){selected.canTeach=false;try{const p=await page(db,ctx,selected.page_id);if(!p.enabled||(await basis(db,ctx,p)).hash!==p.source_hash)throw new ValidationError('Review and republish the current customer offer first.');await completedExample(db,ctx,selected,p);selected.canTeach=true;}catch(e){if(![400,402,403,404,422].includes(e.status))throw e;selected.trainingProblem=e.message;}}return {allowed,preordersAllowed,automaticPreorders,plan:state.plan,shadow:state.shadow,profiles:profiles.slice(0,100),moreProfiles:profiles.length>100,profilePage,requests:requests.slice(0,100),moreRequests:requests.length>100,requestPage,customers:customers.slice(0,200),moreCustomers:customers.length>200,locations:locations.slice(0,250),moreLocations:locations.length>250,taxRates:taxRates.slice(0,100),moreTaxRates:taxRates.length>100,currency,selected};
}
async function readPage(db,ctx,{page=1}={}){const s=await screen(db,ctx,{requestsPage:page});return {summary:'Known customers submit exact products, whole quantities and a unique reference through a private order page. Pro learns matching confirmed individual request shapes; Custom can draft within explicit page limits without training. Orders remain unconfirmed drafts; payments, availability, physical shipping and delivery promises stay separate.',rows:s.requests.map(r=>({Customer:r.customer_name,Reference:r.reference,Status:r.status.replace('_',' '),Order:r.order_number||'Not drafted',Review:r.problem||'',link:'/autopilot/customer-order-pages?requestId='+r.id})),more:s.moreRequests};}
function notices(row){if(!row?.n)return [];return [{kind:'order',importance:'Needs You',priority:50,title:row.n+' customer page request'+(row.n===1?' needs':'s need')+' review',happened:'The customer checked the exact request. No confirmed order, stock movement or payment was created.',why:'Review the original accepted products, quantities, prices and delivery scope before drafting, or stop the request.',actionLabel:'Review customer page requests',href:'/autopilot/customer-order-pages',sourceId:'customer-page-requests',at:row.created_at,createdAt:row.created_at}];}
const preorderDefinition={id:68,key:'preorders',label:'Accept preorders and reserve arrived stock',readPage:async(db,ctx,{page:pageNumber=1}={})=>{
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,68,'draft');
 const rows=(await db.query(`SELECT r.reference AS "Reference",c.name AS "Customer",o.order_number AS "Order",
  coalesce(o.status,r.status) AS "Status",r.problem AS "Review",'/autopilot/customer-order-pages?requestId='||r.id AS link
  FROM stockchief_runtime.agent_customer_page_requests r JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id
  LEFT JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id
  WHERE r.workspace_id=$1 AND r.snapshot->>'preorder'='true' ORDER BY r.created_at DESC,r.id LIMIT 101 OFFSET $2`,[ctx.workspaceId,(pageNumber-1)*100])).rows;
 return {rows:rows.slice(0,100),more:rows.length>100,summary:'Preorders use placed incoming orders, an exact approved customer offer and checked capacity. Physical shipping and payments have separate controls.'};
}};
module.exports={owner,page,basis,publish,renew,publicContext,quoteRequest,submit,request,createDraft,configure,teach,stopRequest,onRequest,queueArrival,settlePreorders,screen,notices,kind,preorderKind,arrivalKind,action,preorderAction,scope,preorderDefinition,definition:{id:83,key:'customer-order-pages',label:'Review customer order page requests',readPage}};
