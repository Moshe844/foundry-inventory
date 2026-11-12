'use strict';
// Job 38: plan an import purchase order that fills a 20 ft or 40 ft container
// from real reorder needs. Most-needed goods go in first, then the next
// most-needed products top the container up, by space and by weight, inside
// supplier minimums and packs. Missing sizes, weights or prices stop the plan.
const policy=require('../commercial/agent-plan'),money=require('../domain/currency');
const {hash}=require('../pricing/postgres-promotions'),{newId}=require('../lib/util');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const packing=require('./container-packing'),source=require('./container-plan-source'),decision=require('./replenishment-decision');
const rules='stockchief_runtime.agent_container_order_rules',orders='stockchief_runtime.agent_container_orders';
const action='purchasing.plan_container',kind='purchasing.container-order.v1',JOB=38;
const OPEN_PO=['DRAFT','AWAITING_APPROVAL'],TAUGHT_PO=['APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED'];
const held=e=>[400,402,403,404,409,422].includes(e?.status)||['validation_error','entitlement_required','forbidden','not_found'].includes(e?.code);
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
const audit=(c,ctx,entry)=>require('../operations/postgres-security-audit').record(c,ctx,entry);

async function owner(c,ctx,lock=false){
 if(!(await c.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
  WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)${lock?' FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rowCount)
  throw new AuthorizationError('Only the current inventory owner can plan container orders.');
 await require('../operations/postgres-warehouse-access').assertInventoryWide(c,ctx);
}
function whole(value,label,min,max){const n=Number(value);if(value===''||value==null||!Number.isSafeInteger(n)||n<min||n>max)throw new ValidationError(label+' must be a whole number from '+min+' to '+max+'.');return n;}
// The terms that a taught example must match exactly.
const terms=r=>({supplierId:r.supplier_id,destinationId:r.destination_id,currency:r.currency,container:r.container,fill:r.fill_percent,minimumFill:r.minimum_fill_percent,coverDays:r.cover_days,maximumMinor:String(r.maximum_minor)});

async function rule(c,ctx,id,lock=false){
 const r=(await c.query(`SELECT r.*,s.name AS supplier_name,s.email AS supplier_email,l.name AS destination_name FROM ${rules} r
  JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.destination_id
  WHERE r.workspace_id=$1 AND r.id=$2${lock?' FOR UPDATE OF r':''}`,[ctx.workspaceId,id])).rows[0];
 if(!r)throw new NotFoundError('That container rule is not in this inventory.');
 return r;
}
async function order(c,ctx,id,lock=false){
 const o=(await c.query(`SELECT o.*,p.po_number,p.status AS po_status,p.approved_by_user_id FROM ${orders} o LEFT JOIN purchase_orders p ON p.workspace_id=o.workspace_id AND p.id=o.purchase_order_id
  WHERE o.workspace_id=$1 AND o.id=$2${lock?' FOR UPDATE OF o':''}`,[ctx.workspaceId,id])).rows[0];
 if(!o)throw new NotFoundError('That container order is not in this inventory.');
 return o;
}

// ---- The plan ------------------------------------------------------------
function space(p,q){
 if(!q)return {mm3:0,grams:0,cartons:0};
 if(p.measure.kind==='carton'){const cartons=Math.ceil(q/p.measure.unitsPerCarton);return {mm3:cartons*p.measure.cartonMm3,grams:cartons*p.measure.cartonGrams,cartons};}
 return {mm3:q*p.measure.unitMm3,grams:q*p.measure.unitGrams,cartons:null};
}
function measureOf(row,profile){
 if(profile){
  const pack=profile.pack,unitsPerCarton=Number(pack.unitsPerCarton);
  if(Number.isSafeInteger(unitsPerCarton)&&unitsPerCarton>0)return {kind:'carton',unitsPerCarton,cartonMm3:pack.length*pack.width*pack.height,cartonGrams:pack.weight,reference:profile.source_reference};
 }
 const dims=['length_mm','width_mm','height_mm','weight_grams'].map(k=>row[k]==null?null:Number(row[k]));
 if(dims.every(v=>Number.isFinite(v)&&v>0))return {kind:'product',unitMm3:Math.ceil(dims[0]*dims[1]*dims[2]),unitGrams:dims[3]};
 return null;
}
function positionFor(rows,skuId,destinationId){
 return rows.find(r=>r.sku_id===skuId&&r.location_id===destinationId&&!r.planning_suppressed)||rows.find(r=>r.sku_id===skuId&&r.scope==='workspace')||null;
}
async function facts(c,ctx,r){
 const supplier=(await c.query("SELECT id,name,currency,email FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'",[ctx.workspaceId,r.supplier_id])).rows[0];
 if(!supplier)throw new ValidationError('This supplier is no longer active. Review the container rule.');
 if(supplier.currency!==r.currency)throw new ValidationError('The supplier currency changed to '+supplier.currency+'. Review the container rule before ordering.');
 const place=(await c.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',[ctx.workspaceId,r.destination_id])).rows[0];
 if(!place)throw new ValidationError('Choose an active warehouse you own to receive the container.');
 const offers=(await c.query(`SELECT si.sku_id,si.purchase_unit,si.units_per_purchase_unit,si.minimum_order_quantity,si.order_multiple,si.last_unit_cost::text AS last_unit_cost,
   s.code,s.weight_grams::text AS weight_grams,s.length_mm::text AS length_mm,s.width_mm::text AS width_mm,s.height_mm::text AS height_mm,
   i.id AS item_id,i.name,i.unit_label,i.quantity_precision::int AS quantity_precision
  FROM supplier_items si JOIN skus s ON s.workspace_id=si.workspace_id AND s.id=si.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  WHERE si.workspace_id=$1 AND si.supplier_id=$2 AND si.is_active=1 AND s.is_active=1 AND i.is_active=1 AND i.quantity_precision=0 AND i.secondary_unit_label IS NULL
   AND NOT EXISTS(SELECT 1 FROM kit_components k WHERE k.workspace_id=s.workspace_id AND k.kit_sku_id=s.id)
  ORDER BY s.code,s.id LIMIT 1001`,[ctx.workspaceId,r.supplier_id])).rows;
 if(offers.length>1000)throw new ValidationError('Plan up to 1,000 products from one supplier in a container rule.');
 const ids=offers.map(o=>o.sku_id),positions=ids.length?await require('../forecasting/postgres-planning-service').position(c,ctx.workspaceId,{onlySkuIds:ids}):[];
 const identities=offers.map(o=>({o,scope:hash(source.identity({supplier_id:r.supplier_id,destination_location_id:r.destination_id,currency:r.currency,sku_id:o.sku_id,code:o.code,unit_label:o.unit_label,quantity_precision:o.quantity_precision,purchase_unit:o.purchase_unit,units_per_purchase_unit:o.units_per_purchase_unit}))}));
 const profiles=ids.length?(await c.query('SELECT scope_hash,pack,source_reference FROM stockchief_runtime.agent_container_pack_profiles WHERE workspace_id=$1 AND scope_hash=ANY($2::text[])',[ctx.workspaceId,identities.map(x=>x.scope)])).rows:[];
 const products=identities.map(({o,scope})=>{
  const p=positionFor(positions,o.sku_id,r.destination_id),rate=p?Number(p.rate)||0:0,projected=p?Number(p.projected)||0:0;
  const need=p&&p.shortage?Math.max(1,decision.requiredUnits(p)):0;
  const unitsPer=Number(o.units_per_purchase_unit),moq=o.minimum_order_quantity==null?1:Number(o.minimum_order_quantity),mult=o.order_multiple==null?1:Number(o.order_multiple);
  if(![unitsPer,moq,mult].every(n=>Number.isSafeInteger(n)&&n>0))throw new ValidationError('Review the supplier pack, minimum and multiple for '+o.code+'.');
  const minPacks=Math.ceil(moq/mult)*mult;
  return {skuId:o.sku_id,itemId:o.item_id,code:o.code,name:o.name,unit:o.unit_label,purchaseUnit:o.purchase_unit,unitsPer,moq,mult,minPacks,
   unitCostMinor:o.last_unit_cost==null?null:money.toMinor(String(o.last_unit_cost),r.currency,{label:'Supplier unit price'}),
   measure:measureOf(o,profiles.find(x=>x.scope_hash===scope)),rate,projected,need,shortage:Boolean(p?.shortage),target:p?.target??null,reorder:p?.reorder??null,q:0};
 });
 return {supplier,place,products};
}
function calculate(r,f){
 const spec=r.container,capacity=spec.length*spec.width*spec.height,usable=Math.floor(capacity*r.fill_percent/100),payload=spec.payload;
 const relevant=f.products.filter(p=>p.need>0||p.rate>0);
 const missing=relevant.filter(p=>!p.measure||p.unitCostMinor==null).map(p=>({skuId:p.skuId,itemId:p.itemId,code:p.code,name:p.name,missing:[...(!p.measure?['size and weight']:[]),...(p.unitCostMinor==null?['supplier price']:[])]}));
 const base={supplierId:r.supplier_id,supplier:f.supplier.name,destinationId:r.destination_id,destination:f.place.name,currency:r.currency,termsHash:hash(terms(r)),
  container:{feet:spec.feet,capacityMm3:capacity,usableMm3:usable,payloadGrams:payload,fillPercent:r.fill_percent,minimumFillPercent:r.minimum_fill_percent},coverDays:r.cover_days};
 const needed=relevant.filter(p=>p.need>0);
 if(missing.length)return {...base,missing,lines:[],left:[],needed:needed.length,usedMm3:0,usedGrams:0,volumePercent:0,weightPercent:0,valueMinor:0,
  fingerprint:hash({rule:r.id,terms:base.termsHash,missing:missing.map(m=>[m.skuId,m.missing]),positions:relevant.map(p=>[p.skuId,p.projected,p.need])})};
 const used={mm3:0,grams:0},left=[];
 const fits=(p,q)=>{const before=space(p,p.q),after=space(p,q);return used.mm3-before.mm3+after.mm3<=usable&&used.grams-before.grams+after.grams<=payload;};
 const apply=(p,q)=>{const before=space(p,p.q),after=space(p,q);used.mm3+=after.mm3-before.mm3;used.grams+=after.grams-before.grams;p.q=q;};
 const days=p=>p.rate>0?p.projected/p.rate:null;
 // Needed first: products at or below their reorder point, lowest days of stock first.
 needed.sort((a,b)=>(days(a)??Number.MAX_SAFE_INTEGER)-(days(b)??Number.MAX_SAFE_INTEGER)||a.code.localeCompare(b.code));
 for(const p of needed){
  const packs=Math.max(Math.ceil(p.need/p.unitsPer/p.mult)*p.mult,p.minPacks);
  // Largest whole multiple of the supplier's order step, at or above the minimum, that fits.
  let lo=p.minPacks/p.mult-1,hi=packs/p.mult;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(fits(p,mid*p.mult*p.unitsPer))lo=mid;else hi=mid-1;}
  const n=lo*p.mult;
  if(n<p.minPacks){left.push({skuId:p.skuId,code:p.code,name:p.name,units:p.need,reason:'Does not fit in this container'});continue;}
  apply(p,n*p.unitsPer);
  if(n<packs&&p.q<p.need)left.push({skuId:p.skuId,code:p.code,name:p.name,units:p.need-p.q,reason:'Only part fits in this container'});
 }
 // Then top up with the next most-needed products: always the one with the
 // fewest days of stock, up to the owner's cover limit, while space and weight last.
 const pool=relevant.filter(p=>p.rate>0);
 for(let guard=0;guard<20000;guard++){
  let best=null,second=Infinity;
  for(const p of pool){if(p.done)continue;const d=(p.projected+p.q)/p.rate;if(!best||d<best.d||(d===best.d&&p.code<best.p.code)){if(best)second=Math.min(second,best.d);best={p,d};}else second=Math.min(second,d);}
  if(!best)break;
  const p=best.p,step=(p.q?p.mult:p.minPacks)*p.unitsPer,limit=Math.floor(r.cover_days*p.rate-p.projected);
  if(p.q+step>limit){p.done=true;continue;}
  let k=1;
  if(p.q){k=Math.floor((limit-p.q)/step);if(second!==Infinity)k=Math.min(k,Math.max(1,Math.ceil((second*p.rate-(p.projected+p.q))/step)));}
  let lo=0,hi=Math.max(1,k);while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(fits(p,p.q+mid*step))lo=mid;else hi=mid-1;}
  if(!lo){p.done=true;continue;}
  apply(p,p.q+lo*step);
 }
 const lines=f.products.filter(p=>p.q>0).map(p=>{const s=space(p,p.q);return {skuId:p.skuId,itemId:p.itemId,code:p.code,name:p.name,unit:p.unit,purchaseUnit:p.purchaseUnit,unitsPerPurchaseUnit:p.unitsPer,
  quantity:p.q,purchaseUnits:p.q/p.unitsPer,unitCostMinor:p.unitCostMinor,valueMinor:p.q*p.unitCostMinor,why:p.need>0?'needed':'top-up',need:p.need,
  measure:p.measure.kind,cartons:s.cartons,mm3:s.mm3,grams:s.grams,daysBefore:p.rate>0?Math.floor(p.projected/p.rate):null,daysAfter:p.rate>0?Math.floor((p.projected+p.q)/p.rate):null};})
  .sort((a,b)=>(a.why===b.why?0:a.why==='needed'?-1:1)||a.code.localeCompare(b.code));
 const pct=(a,b)=>b>0?Math.round(a*1000/b)/10:0,valueMinor=lines.reduce((n,l)=>n+l.valueMinor,0);
 if(!Number.isSafeInteger(valueMinor))throw new ValidationError('This container order value is too large to record.');
 const plan={...base,missing:[],lines,left,needed:needed.length,usedMm3:used.mm3,usedGrams:Math.round(used.grams*1000)/1000,
  volumePercent:pct(used.mm3,capacity),weightPercent:pct(used.grams,payload),valueMinor};
 plan.fullEnough=Math.max(plan.volumePercent,plan.weightPercent)>=r.minimum_fill_percent;
 plan.fingerprint=hash({rule:r.id,terms:base.termsHash,lines:lines.map(l=>[l.skuId,l.quantity,l.unitCostMinor]),positions:relevant.map(p=>[p.skuId,p.projected,p.need])});
 return plan;
}
async function current(c,ctx,r){return calculate(r,await facts(c,ctx,r));}

// ---- Owner settings --------------------------------------------------------
async function save(db,ctx,input){
 return tx(db,async c=>{
  await owner(c,ctx,true);
  // Saving the rule gives no power during the first 14 days or Watch only:
  // the routine then only records what it would have ordered.
  await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
  const prior=input.id?await rule(c,ctx,input.id,true):null;
  if(prior&&Number(input.revision)!==prior.revision)throw new ValidationError('This container rule changed. Open its current settings.');
  if(input.stop==='yes'){
   if(!prior)throw new ValidationError('Choose a saved container rule to stop.');
   await c.query(`UPDATE ${rules} SET enabled=false,revision=revision+1,next_check_at=NULL WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,prior.id]);
   await audit(c,ctx,{action:'Routine container ordering stopped',reference:prior.id});return {id:prior.id};
  }
  if(input.confirmed!=='yes')throw new ValidationError('Confirm the container measurements, payload and limits you checked.');
  const supplier=(await c.query("SELECT id,currency FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'",[ctx.workspaceId,prior?prior.supplier_id:String(input.supplierId||'')])).rows[0];
  if(!supplier)throw new ValidationError('Choose an active supplier.');
  const place=(await c.query('SELECT id FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',[ctx.workspaceId,prior?prior.destination_id:String(input.destinationId||'')])).rows[0];
  if(!place)throw new ValidationError('Choose an active warehouse you own to receive the container.');
  const payloadGrams=input.payloadKg!==undefined?whole(input.payloadKg,'Most weight it can carry (kg)',1,1000000)*1000:input.payloadGrams;
  const spec=packing.container({...input,payloadGrams,containerCount:'1'}),container={feet:spec.feet,length:spec.length,width:spec.width,height:spec.height,payload:spec.payload};
  const fill=whole(input.fillPercent,'Fill up to (% of space)',1,100),minimum=whole(input.minimumFillPercent,'Ask me if less full than (%)',1,100),cover=whole(input.coverDays,'Top up to at most this many days of stock',1,730);
  if(minimum>fill)throw new ValidationError('The minimum fill cannot be higher than the fill target.');
  const maximum=money.userToMinor(String(input.maximumValue??''),supplier.currency,{label:'Largest container order'});
  if(!(maximum>0))throw new ValidationError('Enter the largest container order value you allow.');
  const enabled=input.routine==='yes';
  if(enabled&&(!prior||!prior.enabled))await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
  const id=prior?.id||newId('container-rule');
  if(prior)await c.query(`UPDATE ${rules} SET container=$3,fill_percent=$4,minimum_fill_percent=$5,cover_days=$6,maximum_minor=$7,enabled=$8,authorized_by=$9,currency=$10,revision=revision+1,next_check_at=NULL,last_issue=NULL WHERE workspace_id=$1 AND id=$2`,
   [ctx.workspaceId,id,container,fill,minimum,cover,maximum,enabled,ctx.actorId,supplier.currency]);
  else{
   if((await c.query(`SELECT 1 FROM ${rules} WHERE workspace_id=$1 AND supplier_id=$2 AND destination_id=$3`,[ctx.workspaceId,supplier.id,place.id])).rowCount)throw new ValidationError('This supplier and warehouse already have a container rule. Open it to change its settings.');
   await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'container-rule:'+id,16384,{finished:true});
   await c.query(`INSERT INTO ${rules}(id,workspace_id,supplier_id,destination_id,currency,container,fill_percent,minimum_fill_percent,cover_days,maximum_minor,enabled,authorized_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id,ctx.workspaceId,supplier.id,place.id,supplier.currency,container,fill,minimum,cover,maximum,enabled,ctx.actorId]);
  }
  await audit(c,ctx,{action:prior?'Container order rule changed':'Container order rule saved',reference:id,before:prior?terms(prior):{},after:{...terms({supplier_id:supplier.id,destination_id:place.id,currency:supplier.currency,container,fill_percent:fill,minimum_fill_percent:minimum,cover_days:cover,maximum_minor:maximum}),routine:enabled}});
  return {id};
 });
}

// ---- Teaching (Pro) ----------------------------------------------------------
async function trained(c,ctx,r){
 if(!r.taught_order_id||r.training_signature!==hash(terms(r)))return false;
 // The example is an order the owner approved individually: drafted by them or by the routine, never one placed on its own.
 const example=(await c.query(`SELECT o.status AS order_status,o.rule_id,p.status,p.approved_by_user_id FROM ${orders} o JOIN purchase_orders p ON p.workspace_id=o.workspace_id AND p.id=o.purchase_order_id WHERE o.workspace_id=$1 AND o.id=$2`,[ctx.workspaceId,r.taught_order_id])).rows[0];
 return Boolean(example&&example.rule_id===r.id&&example.order_status==='DRAFTED'&&TAUGHT_PO.includes(example.status)&&example.approved_by_user_id===r.authorized_by);
}
async function teach(db,ctx,id,input){
 return tx(db,async c=>{
  await owner(c,ctx,true);
  const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft'),stop=await policy.stopped(c,ctx.workspaceId,account,action,false);if(stop)throw new ValidationError(stop);
  const o=await order(c,ctx,id),r=await rule(c,ctx,o.rule_id,true);
  if(input.confirmed!=='yes'||o.status!=='DRAFTED'||!TAUGHT_PO.includes(o.po_status)||o.approved_by_user_id!==ctx.actorId||o.plan.termsHash!==hash(terms(r)))
   throw new ValidationError('Teach from a container order you approved yourself, planned with the current rule settings.');
  if(r.authorized_by!==ctx.actorId)await c.query(`UPDATE ${rules} SET authorized_by=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id,ctx.actorId]);
  await c.query(`UPDATE ${rules} SET taught_order_id=$3,training_signature=$4 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id,o.id,hash(terms(r))]);
  await audit(c,ctx,{action:'Container ordering taught from an approved example',reference:r.id,after:{orderId:o.id,purchaseOrderId:o.purchase_order_id}});
  return {id:r.id};
 });
}

// ---- Drafting, sending and undo -------------------------------------------------
function body(supplier,plan,po){
 return [`Hello${supplier.contact_name?' '+supplier.contact_name:''},`,'',`Purchase order ${po.poNumber} for one ${plan.container.feet} ft container:`,
  ...plan.lines.map(l=>`${l.purchaseUnits} ${l.purchaseUnit} (${l.quantity} ${l.unit}) × ${l.code} at ${money.format(l.unitCostMinor,plan.currency)} each`),'',
  `Total goods: ${money.format(plan.valueMinor,plan.currency)}.`,`Please confirm acceptance and the ship date for ${po.poNumber}.`].join('\n');
}
async function createPurchase(c,ctx,r,plan,id,automatic){
 await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'container-order:'+id,plan.lines.length*4096+32768,{finished:true});
 return require('../operations/postgres-business-workflows').createPurchaseOrderInTransaction(c,ctx,{
  supplierId:r.supplier_id,destinationLocationId:r.destination_id,currency:r.currency,source:'instruction',idempotencyKey:'container-order:'+id,
  reference:'Container '+plan.container.feet+' ft',sourceDetail:{containerOrderId:id,ruleId:r.id,automatic},
  notes:`Planned to fill a ${plan.container.feet} ft container: ${plan.volumePercent}% of the space and ${plan.weightPercent}% of the payload.`,
  lines:plan.lines.map(l=>({skuId:l.skuId,quantityUnits:l.quantity,quantityPurchaseUnits:l.purchaseUnits,unitsPerPurchaseUnit:l.unitsPerPurchaseUnit,purchaseUnit:l.purchaseUnit,unitCost:money.fromMinor(l.unitCostMinor,r.currency),destinationLocationId:r.destination_id}))});
}
// Returns null when this order may be placed without a person, or the reason it needs one.
async function authority(c,ctx,r,plan,account){
 const state=await require('../autopilot/postgres-service').getState(c,ctx.workspaceId);
 if(!state.canAutomate)return 'StockChief is set to ask before ordering. Approve this container order.';
 const mode=await require('../autopilot/job-modes').restriction(c,ctx.workspaceId,JOB,true);if(mode)return mode;
 if(!policy.permits(account.plan,JOB,'automatic',{trained:await trained(c,ctx,r)}))return 'Approve one container order from this rule yourself, then teach it. After that StockChief orders on its own within your limits.';
 if(!r.enabled||r.authorized_by!==ctx.actorId)return 'Routine container ordering is not switched on for this rule.';
 if(!plan.fullEnough)return `The container would be only ${Math.max(plan.volumePercent,plan.weightPercent)}% full. Your rule asks you when it is under ${r.minimum_fill_percent}%.`;
 if(plan.valueMinor>Number(r.maximum_minor))return `This order is ${money.format(plan.valueMinor,r.currency)}, over your container order limit of ${money.format(Number(r.maximum_minor),r.currency)}.`;
 const cap=policy.purchaseLimits(account);
 if(!cap)return 'Automatic ordering needs agreed purchase limits.';
 if(cap.currency!==r.currency||plan.valueMinor>money.toMinor(String(cap.perOrder),cap.currency))return 'This order needs approval under your plan’s per-order limit.';
 const delivery=await require('../autopilot/postgres-service').supplierDeliveryReadiness(scoped(c),ctx.workspaceId,r.supplier_id);
 if(!delivery.ready)return delivery.reason;
 const value=Number(money.fromMinor(plan.valueMinor,r.currency));
 for(const l of plan.lines){
  const reason=await policy.purchaseReview(c,ctx.workspaceId,{supplierId:r.supplier_id,skuId:l.skuId,currency:r.currency,value,unitCost:Number(money.fromMinor(l.unitCostMinor,r.currency)),
   unitsPerPurchaseUnit:l.unitsPerPurchaseUnit,purchaseUnit:l.purchaseUnit,destinationLocationId:r.destination_id},{itemScope:plan.lines.map(x=>x.skuId)},account,null);
  if(reason)return reason;
 }
 return null;
}
async function send(c,ctx,r,plan,id,purchase){
 const flows=require('../operations/postgres-business-workflows');
 await flows.approvePurchaseOrder(scoped(c),ctx,purchase.purchaseOrderId,{idempotencyKey:'container-order:'+id+':approve'});
 const delivery=await require('../autopilot/postgres-service').supplierDeliveryReadiness(scoped(c),ctx.workspaceId,r.supplier_id);
 if(!delivery.ready)throw new ValidationError(delivery.reason);
 const queued=await require('../connections/postgres-outbound-mail').queueInTransaction(c,ctx,{recipientKind:'supplier',recipientId:r.supplier_id,recipientEmail:delivery.supplier.email,
  connectorId:delivery.mailbox.id,purchaseOrderId:purchase.purchaseOrderId,subject:'Purchase order '+purchase.poNumber,body:body(delivery.supplier,plan,purchase)},'container-order:'+id+':email');
 // Counts against the shared weekly automatic purchasing limit.
 await c.query(`INSERT INTO work_items(id,workspace_id,category,source,source_evidence,affected_entities,recommended_action,priority,confidence,approval_requirement,execution_status,verification_status,idempotency_key,purchase_order_id,outcome,created_at,completed_at)
  VALUES($1,$2,'container_order','postgres_autopilot',$3,$4,$5,30,'high','NONE','COMPLETED','VERIFIED',$6,$7,$8,$9,$9) ON CONFLICT DO NOTHING`,
  [newId('work'),ctx.workspaceId,JSON.stringify([{containerOrderId:id,ruleId:r.id}]),JSON.stringify({supplierId:r.supplier_id}),JSON.stringify({kind:'container_order',supplierId:r.supplier_id}),
   'container-order:'+id,purchase.purchaseOrderId,JSON.stringify({containerOrderId:id,purchaseOrderId:purchase.purchaseOrderId,approvedAutomatically:true}),new Date().toISOString()]);
 return queued;
}
async function record(c,ctx,r,plan,{id=newId('container-order'),status,reason=null,automatic=false,purchaseOrderId=null}){
 await c.query(`INSERT INTO ${orders}(id,workspace_id,rule_id,rule_revision,source_fingerprint,plan,status,reason,automatic,created_by,purchase_order_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [id,ctx.workspaceId,r.id,r.revision,plan.fingerprint,plan,status,reason,automatic,ctx.actorId,purchaseOrderId]);
 return id;
}
async function place(c,ctx,r,plan,{automatic,reason}){
 const replay=(await c.query(`SELECT id,status,purchase_order_id FROM ${orders} WHERE workspace_id=$1 AND rule_id=$2 AND source_fingerprint=$3 FOR UPDATE`,[ctx.workspaceId,r.id,plan.fingerprint])).rows[0];
 // The same facts are ordered once. An earlier watch-only record becomes the real order.
 if(replay&&replay.purchase_order_id)return {id:replay.id,status:replay.status,purchaseOrderId:replay.purchase_order_id,replayed:true};
 const id=replay?.id||newId('container-order'),purchase=await createPurchase(c,ctx,r,plan,id,automatic);
 if(replay)await c.query(`UPDATE ${orders} SET status='DRAFTED',purchase_order_id=$3,automatic=$4,reason=NULL,plan=$5,rule_revision=$6,created_by=$7,created_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,purchase.purchaseOrderId,automatic,plan,r.revision,ctx.actorId]);
 else await record(c,ctx,r,plan,{id,status:'DRAFTED',automatic,purchaseOrderId:purchase.purchaseOrderId});
 let status='DRAFTED',queued=null;
 if(automatic&&!reason){
  await c.query('SAVEPOINT container_order_send');
  try{queued=await send(c,ctx,r,plan,id,purchase);status='SENT';await c.query('RELEASE SAVEPOINT container_order_send');}
  catch(error){if(!held(error))throw error;await c.query('ROLLBACK TO SAVEPOINT container_order_send');await c.query('RELEASE SAVEPOINT container_order_send');reason=error.message;}
 }
 await c.query(`UPDATE ${orders} SET status=$3,reason=$4,purchase_order_id=$5,communication_id=$6,effect_id=$7 WHERE workspace_id=$1 AND id=$2`,
  [ctx.workspaceId,id,status,reason,purchase.purchaseOrderId,queued?.communicationId||null,queued?.effectId||null]);
 await audit(c,ctx,{action:status==='SENT'?'Container order placed and queued to the supplier':'Container order drafted for approval',reference:id,
  after:{ruleId:r.id,purchaseOrderId:purchase.purchaseOrderId,automatic,valueMinor:plan.valueMinor,currency:r.currency,volumePercent:plan.volumePercent,weightPercent:plan.weightPercent,reason}});
 return {id,status,purchaseOrderId:purchase.purchaseOrderId,poNumber:purchase.poNumber,reason,replayed:false};
}
async function pending(c,ctx,r){
 return (await c.query(`SELECT o.id,o.purchase_order_id,p.po_number FROM ${orders} o JOIN purchase_orders p ON p.workspace_id=o.workspace_id AND p.id=o.purchase_order_id
  WHERE o.workspace_id=$1 AND o.rule_id=$2 AND o.status='DRAFTED' AND p.status=ANY($3::text[]) ORDER BY o.created_at DESC LIMIT 1`,[ctx.workspaceId,r.id,OPEN_PO])).rows[0]||null;
}
async function prepare(db,ctx,id,input){
 return tx(db,async c=>{
  await owner(c,ctx,true);
  const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft'),stop=await policy.stopped(c,ctx.workspaceId,account,action,false);if(stop)throw new ValidationError(stop);
  const r=await rule(c,ctx,id,true),open=await pending(c,ctx,r);
  if(open)throw new ValidationError('Container order '+open.po_number+' is still waiting for approval. Approve or cancel it first.');
  const plan=await current(c,ctx,r);
  if(plan.missing.length)throw new ValidationError('Add '+plan.missing.map(m=>m.missing.join(' and ')+' for '+m.code).join('; ')+' before planning this container.');
  if(!plan.lines.length)throw new ValidationError('Nothing needs ordering from this supplier right now.');
  if(input.confirmed!=='yes'||input.fingerprint!==plan.fingerprint)throw new ValidationError('Stock or supplier facts changed. Review the current container plan before drafting it.');
  return place(c,ctx,r,plan,{automatic:false,reason:null});
 });
}
// The routine, run from the worker queue.
async function onRule(db,workspaceId,id){
 try{return await tx(db,async c=>{
  const initial=(await c.query(`SELECT authorized_by FROM ${rules} WHERE workspace_id=$1 AND id=$2`,[workspaceId,id])).rows[0];
  if(!initial)return {removed:true};
  const ctx={workspaceId,actorId:initial.authorized_by};
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('account-purchase:'||owner_account_id,0)) FROM workspaces WHERE id=$1",[workspaceId]);
  await require('./postgres-purchase-exposure').lock(c,workspaceId);
  await owner(c,ctx,true);
  const r=await rule(c,ctx,id,true);
  if(!r.enabled)return {stopped:true};
  const account=await policy.requireWorkspaceJob(c,workspaceId,JOB,'draft'),state=await require('../autopilot/postgres-service').getState(c,workspaceId);
  const hard=await policy.stopped(c,workspaceId,account,action,false)||(!state.canAct?'Automatic work is paused. Review the inventory’s automation settings.':null)||await require('../commercial/agent-rule-quota').restriction(c,account);
  const finish=async issue=>c.query(`UPDATE ${rules} SET next_check_at=clock_timestamp()+interval '1 hour',last_issue=$3 WHERE workspace_id=$1 AND id=$2`,[workspaceId,id,issue]);
  const open=await pending(c,ctx,r);
  if(open){await finish(null);return {waiting:open.id};}
  const plan=await current(c,ctx,r);
  if(!plan.needed){await finish(null);return {notNeeded:true};}
  if(plan.missing.length){
   const issue='Add '+plan.missing.map(m=>m.missing.join(' and ')+' for '+m.code).join('; ')+'. StockChief does not guess sizes, weights or prices.';
   if(!(await c.query(`SELECT 1 FROM ${orders} WHERE workspace_id=$1 AND rule_id=$2 AND source_fingerprint=$3`,[workspaceId,id,plan.fingerprint])).rowCount)
    await record(c,ctx,r,plan,{status:'NEEDS_FACTS',reason:issue,automatic:true});
   await finish(issue.slice(0,1000));return {held:true,reason:issue};
  }
  if(hard){
   if(!(await c.query(`SELECT 1 FROM ${orders} WHERE workspace_id=$1 AND rule_id=$2 AND source_fingerprint=$3`,[workspaceId,id,plan.fingerprint])).rowCount)
    await record(c,ctx,r,plan,{status:'WATCHED',reason:hard,automatic:true});
   await finish(hard);return {held:true,reason:hard,watched:true};
  }
  if(!plan.lines.length){const issue='The needed goods do not fit in this container. Check its measurements and payload.';await finish(issue);return {held:true,reason:issue};}
  const reason=await authority(c,ctx,r,plan,account),result=await place(c,ctx,r,plan,{automatic:true,reason});
  await finish(null);
  return result;
 });}catch(error){
  if(!held(error))throw error;
  await db.query(`UPDATE ${rules} SET next_check_at=clock_timestamp()+interval '1 hour',last_issue=$3 WHERE workspace_id=$1 AND id=$2`,[workspaceId,id,String(error.message).slice(0,1000)]);
  return {held:true,reason:error.message};
 }
}
async function undo(db,ctx,id,input){
 return tx(db,async c=>{
  await owner(c,ctx,true);
  const o=await order(c,ctx,id,true);
  if(o.status==='UNDONE')return {id:o.rule_id,replayed:true};
  if(input.confirmed!=='yes'||!['DRAFTED','SENT'].includes(o.status))throw new ValidationError('Choose a drafted or sent container order to undo.');
  const mail=(await c.query(`SELECT e.id,e.status,m.id AS message_id,m.status AS message_status FROM supplier_communications m
   LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.kind='mail.outbound.send' AND e.aggregate_id=m.id
   WHERE m.workspace_id=$1 AND m.idempotency_key=$2 FOR UPDATE OF m`,[ctx.workspaceId,'container-order:'+id+':email'])).rows[0];
  if(mail&&(mail.message_status!=='QUEUED'||(mail.status&&mail.status!=='PENDING')))throw new ValidationError('The supplier email has already gone out or is being sent. Ask the supplier to cancel, then cancel the PO yourself.');
  if(!['DRAFT','AWAITING_APPROVAL','APPROVED'].includes(o.po_status))throw new ValidationError('This PO has moved on ('+o.po_status.toLowerCase()+'). Open it to make a correction.');
  if(mail){
   if(mail.id)await c.query("UPDATE stockchief_runtime.provider_effects SET status='CANCELLED',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND status='PENDING'",[ctx.workspaceId,mail.id]);
   await c.query("UPDATE supplier_communications SET status='CANCELLED',updated_at=clock_timestamp()::text WHERE workspace_id=$1 AND id=$2 AND status='QUEUED'",[ctx.workspaceId,mail.message_id]);
  }
  await require('../operations/postgres-business-workflows').cancelPurchaseOrderInTransaction(c,ctx,o.purchase_order_id,{idempotencyKey:'container-order:'+id+':undo',reason:'Owner undid the container order before it was sent.'});
  await c.query(`UPDATE ${orders} SET status='UNDONE',undone_at=clock_timestamp(),undone_by=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,ctx.actorId]);
  await audit(c,ctx,{action:'Container order undone before sending',reference:id,before:{status:o.status,purchaseOrderId:o.purchase_order_id},after:{status:'UNDONE',emailCancelled:Boolean(mail)}});
  return {id:o.rule_id,replayed:false};
 });
}

// ---- Scheduling, pages and notices ---------------------------------------------
async function schedule(db,workspaceId){
 const rows=(await db.query(`SELECT id,revision FROM ${rules} WHERE workspace_id=$1 AND enabled AND (next_check_at IS NULL OR next_check_at<=now()) ORDER BY next_check_at NULLS FIRST,id LIMIT 5`,[workspaceId])).rows;
 const hour=new Date().toISOString().slice(0,13);
 for(const r of rows)await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind,idempotencyKey:'container-order:'+r.id+':'+r.revision+':'+hour,payload:{ruleId:r.id},priority:35,maxAttempts:3});
 return {queued:rows.length};
}
async function screen(db,ctx,{id=null}={}){
 await owner(db,ctx);
 const state=await policy.accountState(db,ctx.workspaceId),plan=policy.usesAgentTerms(state)?state.plan:null,locked=!policy.permits(plan,JOB,'draft');
 const list=(await db.query(`SELECT r.id,r.enabled,r.container,r.last_issue,s.name AS supplier_name,l.name AS destination_name FROM ${rules} r JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.destination_id WHERE r.workspace_id=$1 ORDER BY s.name,r.id LIMIT 100`,[ctx.workspaceId])).rows;
 const base={locked,plan,shadow:state.shadow,rules:list,runsAlone:plan==='enterprise',selected:null};
 if(!id){
  if(locked)return base;
  const suppliers=(await db.query("SELECT id,name,currency FROM suppliers WHERE workspace_id=$1 AND status='active' ORDER BY name,id LIMIT 250",[ctx.workspaceId])).rows,
   places=(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL ORDER BY name,id LIMIT 250',[ctx.workspaceId])).rows;
  return {...base,suppliers,places};
 }
 const r=await rule(db,ctx,id),history=(await db.query(`SELECT o.id,o.status,o.reason,o.automatic,o.created_at,o.purchase_order_id,o.rule_revision,o.plan->>'valueMinor' AS value_minor,o.plan->>'volumePercent' AS volume_percent,o.plan->>'weightPercent' AS weight_percent,
  p.po_number,p.status AS po_status,p.approved_by_user_id,e.status AS effect_status FROM ${orders} o LEFT JOIN purchase_orders p ON p.workspace_id=o.workspace_id AND p.id=o.purchase_order_id
  LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=o.workspace_id AND e.id=o.effect_id WHERE o.workspace_id=$1 AND o.rule_id=$2 ORDER BY o.created_at DESC,o.id DESC LIMIT 20`,[ctx.workspaceId,id])).rows;
 let current=null,problem=null,taught=false;
 if(!locked){try{current=await calculate(r,await facts(db,ctx,r));taught=await trained(db,ctx,r);}catch(e){if(!held(e))throw e;problem=e.message;}}
 return {...base,selected:r,history,current,problem,taught,open:locked?null:await pending(db,ctx,r)};
}
async function inbox(db,workspaceId){
 const rows=(await db.query(`SELECT r.id,r.last_issue,r.next_check_at,s.name AS supplier_name,o.id AS order_id,o.reason,p.po_number,o.created_at FROM ${rules} r JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id
  LEFT JOIN LATERAL(SELECT o.id,o.purchase_order_id,o.created_at,o.reason FROM ${orders} o JOIN purchase_orders p ON p.workspace_id=o.workspace_id AND p.id=o.purchase_order_id WHERE o.workspace_id=r.workspace_id AND o.rule_id=r.id AND o.status='DRAFTED' AND o.automatic AND p.status=ANY($2::text[]) ORDER BY o.created_at DESC LIMIT 1) o ON true
  LEFT JOIN purchase_orders p ON p.workspace_id=r.workspace_id AND p.id=o.purchase_order_id
  WHERE r.workspace_id=$1 AND r.enabled AND (r.last_issue IS NOT NULL OR o.id IS NOT NULL) ORDER BY r.id LIMIT 50`,[workspaceId,OPEN_PO])).rows;
 return rows.map(row=>({kind:'purchase',importance:'Needs You',priority:70,title:row.po_number?'Approve container order '+row.po_number+' for '+row.supplier_name:'Container order for '+row.supplier_name+' needs you',
  happened:row.po_number?'StockChief planned a container order and drafted the PO.':'StockChief stopped planning this container.',why:row.last_issue||row.reason||'Review the planned lines, fill and value.',
  recommendation:'Review the container plan.',href:'/autopilot/container-orders/'+row.id,actionLabel:'Review container order',sourceId:'container-order:'+row.id,at:row.created_at||row.next_check_at,createdAt:row.created_at||row.next_check_at}));
}
module.exports={save,prepare,teach,undo,onRule,schedule,screen,inbox,calculate,facts,current,rule,order,kind,action};
