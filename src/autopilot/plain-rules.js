'use strict';
// Job 207: follows rules you write in plain words, alone on every plan
// (Starter up to 5 rules, Growth 50, Pro 500, Custom unlimited).
//
// The owner writes one rule. plain-rule-reader.js reads it without AI into one
// of the supported kinds, and the names in it are found exactly in the
// records. StockChief then shows exactly what the rule will do and which plan
// it needs. Nothing is saved until the owner confirms that meaning. The rule is
// then saved by that kind's own service, which checks the owner, the plan and
// the shared rule allowance again and writes its own audit entry:
//   watch     -> watch rules (job 167)
//   reorder   -> a reorder setting, turned on from its review page like any
//                other standing instruction (where job 210 tests it first)
//   approval  -> who approves what (job 176, Pro and Custom)
//   split     -> splitting big draft purchase orders (job 25, Pro and Custom)
//   combine   -> combining draft purchase orders (job 24, Growth and up)
//   supplier  -> always/never supplier rules (this job)
// A rule can only use what the plan allows; otherwise the page says which plan
// unlocks it. A sentence it cannot read exactly is refused with the reason and
// examples, and nothing is saved. Saving the same rule again changes nothing.
const crypto=require('node:crypto');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const audit=require('../operations/postgres-security-audit');
const reader=require('./plain-rule-reader');
const supplierRules=require('../purchasing/supplier-choice-rules');
const {ValidationError,AuthorizationError}=require('../domain/errors');

const JOB=207,path='/autopilot/learning/rules';
const TIERS=[['starter','Starter'],['growth','Growth'],['pro','Pro'],['enterprise','Custom']];
const KINDS={
  watch:{label:'Watch rule',job:167,lives:{href:'/autopilot/reviews/watch-rules',label:'Watch rules'}},
  reorder:{label:'Reorder setting',job:JOB,lives:{href:'/what-you-told-me',label:'What you’ve told me'}},
  supplier:{label:'Supplier rule',job:JOB,lives:{href:path+'#supplier-rules',label:'Supplier rules'}},
  combine:{label:'Combine purchase orders',job:24,lives:{href:'/autopilot/reviews/combine-draft-orders',label:'Combining rules'}},
  approval:{label:'Who approves',job:176,lives:{href:'/autopilot/approval-routing',label:'Who approves what'}},
  split:{label:'Split big purchase orders',job:25,lives:{href:'/autopilot/reviews/split-draft-orders',label:'Splitting rules'}},
};
const EXAMPLE_KIND={Watch:'watch',Reorder:'reorder',Buffer:'reorder',Supplier:'supplier',Combine:'combine',Approval:'approval',Split:'split'};

async function owner(db,ctx){
  const allowed=(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL`,[ctx.workspaceId,ctx.actorId])).rowCount;
  if(!allowed)throw new AuthorizationError('Only the owner can write rules.');
}
function planFor(state,job){
  const plan=policy.usesAgentTerms(state)?state.plan:null;
  const allowed=Boolean(plan)&&policy.permits(plan,job,'automatic',{trained:true});
  return {allowed,trained:allowed&&policy.allowance(plan,job)==='trained',
    lowest:TIERS.find(([tier])=>policy.permits(tier,job,'automatic',{trained:true}))?.[1]||null,
    current:TIERS.find(([tier])=>tier===plan)?.[1]||null};
}

// Exact lookups. Anything missing or matching more than one record is asked back.
async function product(db,workspaceId,name,{variants=false}={}){
  const {rows}=await db.query(`SELECT s.id,s.code,s.variant_label,i.id AS item_id,i.name,lower(s.code)=lower($2) AS by_code,
      lower(i.name||CASE WHEN coalesce(s.variant_label,'')='' THEN '' ELSE ' '||s.variant_label END)=lower($2) AS by_variant
    FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND (lower(s.code)=lower($2) OR lower(i.name)=lower($2)
      OR lower(i.name||CASE WHEN coalesce(s.variant_label,'')='' THEN '' ELSE ' '||s.variant_label END)=lower($2))
    ORDER BY i.name,s.position,s.id LIMIT 60`,[workspaceId,name]);
  const label=r=>r.name+(r.variant_label?' · '+r.variant_label:'');
  const code=rows.filter(r=>r.by_code);
  if(code.length===1)return {kind:'SKU',skuId:code[0].id,itemId:code[0].item_id,code:code[0].code,name:label(code[0])};
  const variant=rows.filter(r=>r.by_variant&&r.variant_label);
  if(variant.length===1)return {kind:'SKU',skuId:variant[0].id,itemId:variant[0].item_id,code:variant[0].code,name:label(variant[0])};
  if(!rows.length)throw new ValidationError('No active product or SKU is called “'+name+'”. Check the spelling or use the SKU code.');
  const items=[...new Set(rows.map(r=>r.item_id))];
  if(items.length>1)throw new ValidationError('More than one product is called “'+name+'”. Use the SKU code, such as '+rows.slice(0,3).map(r=>r.code).join(' or ')+'.');
  if(rows.length===1)return {kind:'SKU',skuId:rows[0].id,itemId:rows[0].item_id,code:rows[0].code,name:label(rows[0])};
  if(!variants)throw new ValidationError('“'+name+'” has '+rows.length+' variants. Use one SKU code, such as '+rows.slice(0,3).map(r=>r.code).join(' or ')+'.');
  return {kind:'ITEM',itemId:rows[0].item_id,name:rows[0].name,variants:rows.length};
}
async function supplier(db,workspaceId,name){
  const {rows}=await db.query(`SELECT id,name,currency,freight_terms_currency,ordinary_freight_minor FROM suppliers
    WHERE workspace_id=$1 AND status='active' AND lower(trim(name))=lower(trim($2)) ORDER BY id LIMIT 2`,[workspaceId,name]);
  if(rows.length>1)throw new ValidationError('More than one active supplier is called “'+name+'”. Rename one of them first.');
  if(!rows.length)throw new ValidationError('No active supplier is called “'+name+'”. Check the spelling.');
  return rows[0];
}
async function place(db,workspaceId,name){
  const {rows}=await db.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL
    AND lower(trim(name))=lower(trim($2)) ORDER BY (parent_location_id IS NULL) DESC,id LIMIT 2`,[workspaceId,name]);
  if(!rows.length)throw new ValidationError('No active location is called “'+name+'”. Check the spelling.');
  return rows[0];
}
async function warehouses(db,workspaceId){
  return (await db.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL
    AND parent_location_id IS NULL AND kind IN ('warehouse','store') ORDER BY name,id`,[workspaceId])).rows;
}
async function category(db,workspaceId,name){
  const {rows}=await db.query(`SELECT trim(f.category) AS name FROM catalogue_item_facts f JOIN items i ON i.workspace_id=f.workspace_id AND i.id=f.item_id AND i.is_active=1
    WHERE f.workspace_id=$1 AND lower(trim(f.category))=lower(trim($2)) LIMIT 1`,[workspaceId,name]);
  if(!rows.length)throw new ValidationError('No active product is in the category “'+name+'”. Check the spelling.');
  return {name:rows[0].name,key:rows[0].name.toLowerCase()};
}
async function person(db,workspaceId,name){
  const people=await require('./approval-desk').people(db,workspaceId),wanted=name.toLowerCase();
  let found=people.filter(p=>String(p.name||'').toLowerCase()===wanted);
  if(!found.length)found=(await db.query('SELECT u.id FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.workspace_id=$1 AND lower(a.email)=$2',[workspaceId,wanted])).rows.map(r=>people.find(p=>p.id===r.id)).filter(Boolean);
  if(!found.length)found=people.filter(p=>String(p.name||'').toLowerCase().split(' ')[0]===wanted);
  if(found.length>1)throw new ValidationError('More than one person on your team is called “'+name+'”. Use their full name.');
  if(!found.length)throw new ValidationError('Nobody on your team is called “'+name+'”. Check the name on the Team page.');
  return found[0];
}
async function baseCurrency(db,workspaceId){
  return (await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[workspaceId])).rows[0]?.base_currency||'USD';
}
const SYMBOLS={'€':'EUR','£':'GBP'};
// The currency an amount is in: its code or symbol, else the expected one.
function currencyOf(amount,expected,who){
  const fromSymbol=amount.symbol==='$'?(money.format(0,expected).includes('$')?expected:'$'):amount.symbol?SYMBOLS[amount.symbol]:null;
  const named=amount.code||fromSymbol;
  if(named&&named!==expected)throw new ValidationError(who+' uses '+expected+'. Write the amount in '+expected+', like 500 '+expected+'.');
  return expected;
}
const formatted=(amount,currency)=>money.format(money.userToMinor(amount,currency,{label:'The amount'}),currency);
const join=list=>list.length<2?list.join(''):list.slice(0,-1).join(', ')+' and '+list[list.length-1];

async function interpret(db,ctx,words){
  const ws=ctx.workspaceId;
  if(words.kind==='watch'){
    const parser=require('./watch-rule-parser'),parsed=parser.parse(words.sentence);
    const subject=await require('./watch-rules').resolve(db,ws,parsed.subject);
    return {meaning:[parser.meaning({subject_kind:subject.kind,subject_name:subject.name,condition:parsed.condition,amount:parsed.amount,inclusive:parsed.inclusive,days:parsed.days}),
      'StockChief checks it through the day and tells you in the app and in Needs you, and by email if you chose a mailbox for alerts.'],
      save:{instruction:parsed.instruction}};
  }
  if(words.kind==='reorder'){
    const sku=await product(db,ws,words.product),at=words.place?await place(db,ws,words.place):null,where=at?' at '+at.name:' across your locations';
    const lines=[];
    if(words.reorderPoint!=null)lines.push('When '+sku.code+' ('+sku.name+') has '+words.reorderPoint+' or fewer'+where+', it goes on the reorder list'+(words.targetStock!=null?', ordering back up to '+words.targetStock:'')+'.');
    if(words.safetyStock!=null)lines.push('Keep '+words.safetyStock+' units of '+sku.code+' ('+sku.name+') as a buffer'+where+'. Reorders plan to keep stock above it.');
    lines.push('This setting only decides when stock is needed. It does not order anything by itself. You turn it on from the next page.');
    return {meaning:lines,save:{sku:sku.code,location:at?.name||'',reorderPoint:words.reorderPoint,targetStock:words.targetStock,safetyStock:words.safetyStock}};
  }
  if(words.kind==='supplier'){
    const vendor=await supplier(db,ws,words.supplier);
    let rule={choice:words.choice,scopeKind:'ALL',scopeName:'',skuId:null,itemId:null,categoryKey:null};
    if(words.scope==='CATEGORY'){const found=await category(db,ws,words.name);rule={...rule,scopeKind:'CATEGORY',scopeName:found.name,categoryKey:found.key};}
    else if(words.scope==='PRODUCT'){const found=await product(db,ws,words.name,{variants:true});
      rule=found.kind==='SKU'?{...rule,scopeKind:'SKU',scopeName:found.code+' ('+found.name+')',skuId:found.skuId}:{...rule,scopeKind:'ITEM',scopeName:found.name+' (all '+found.variants+' variants)',itemId:found.itemId};}
    return {meaning:[supplierRules.meaning({choice:rule.choice,scope_kind:rule.scopeKind,scope_name:rule.scopeName,supplier:vendor.name}),
      'This covers reorder drafts, supplier picks and automatic reorders.'],save:{...rule,instruction:words.sentence,supplierId:vendor.id}};
  }
  if(words.kind==='approval'){
    const desk=require('./approval-desk'),kind=desk.KINDS[words.approval],who=await person(db,ws,words.person);
    if(who.role==='owner')throw new ValidationError('Approvals already come to you. Name the team member who should approve instead.');
    if(!desk.canApproveKind(who,words.approval))throw new ValidationError(who.name+' cannot approve '+kind.noun+'. Give them that permission on the Team page first.');
    if(who.warehouse_location_ids!==null)throw new ValidationError(who.name+' only sees some warehouses. Approvals go to people who see the whole inventory.');
    if(words.money&&!kind.money)throw new ValidationError(kind.label+' have no amount. Leave the amount out.');
    const currency=words.money?currencyOf(words.money,(words.money.code||SYMBOLS[words.money.symbol])||await baseCurrency(db,ws),'Your inventory'):null;
    const lines=[kind.label+(words.money?' over '+formatted(words.money.amount,currency):'')+' go to '+who.name+' for approval instead of you.',
      'Each approval is still decided on its own page, which checks '+who.name+'’s permission and limit again.'];
    if(words.ordersWord)lines.unshift('StockChief reads “orders” here as purchase orders, the orders that wait for approval.');
    return {meaning:lines,save:{kind:words.approval,amount:words.money?.amount||'',currency:currency||'',userId:who.id}};
  }
  if(words.kind==='split'){
    const vendor=await supplier(db,ws,words.supplier),currency=vendor.currency;
    currencyOf(words.money,currency,vendor.name);
    if(words.budget)currencyOf(words.budget,currency,vendor.name);
    const sites=words.places?await Promise.all(words.places.split(/\s*(?:,|\band\b)\s*/i).filter(Boolean).map(name=>place(db,ws,name))):await warehouses(db,ws);
    if(!sites.length)throw new ValidationError('Add a receiving warehouse before splitting purchase orders.');
    const how={warehouse:'into one order for each receiving warehouse','delivery-date':'into one order for each delivery date on its lines',
      budget:'into orders of up to '+(words.budget?formatted(words.budget.amount,currency):'')+' each'}[words.strategy];
    return {meaning:['Draft purchase orders from '+vendor.name+' worth more than '+formatted(words.money.amount,currency)+' are split '+how+'.',
      'It covers receiving at '+join(sites.map(s=>s.name))+'. It splits unsent drafts only, and sends or approves nothing.'],
      trainedNote:'StockChief first needs one split like this that you approved by hand.',
      save:{supplierId:vendor.id,currency,strategy:words.strategy,locationIds:sites.map(s=>s.id).sort(),maximum:words.money.amount,budget:words.budget?.amount||null}};
  }
  if(words.kind==='combine'){
    const vendor=await supplier(db,ws,words.supplier),currency=vendor.currency;
    currencyOf(words.money,currency,vendor.name);
    if(vendor.freight_terms_currency!==vendor.currency||vendor.ordinary_freight_minor==null)
      throw new ValidationError('Record '+vendor.name+'’s usual shipping cost first, so StockChief can see what combining saves.');
    let site;
    if(words.place)site=await place(db,ws,words.place);
    else{const all=await warehouses(db,ws);if(all.length!==1)throw new ValidationError('Say which receiving warehouse, as in “Combine '+vendor.name+' POs for '+(all[0]?.name||'Brooklyn')+' into one, up to $2,000”.');site=all[0];}
    return {meaning:['Unsent draft purchase orders from '+vendor.name+' to '+site.name+' that are due the same day are combined into one order of up to '+formatted(words.money.amount,currency)+', to save shipping.',
      'It combines unsent drafts only, and sends or approves nothing.'],
      trainedNote:'StockChief first needs one combined order like this that you approved by hand.',
      save:{supplierId:vendor.id,currency,locationId:site.id,maximum:words.money.amount}};
  }
  return {builtIn:true,meaning:['StockChief already does this on every plan: the first order to a new supplier always needs a person.',
    'There is nothing to save, and it does not use one of your rules.'],save:null};
}

// Reads a rule and says exactly what it would do. Changes nothing.
async function read(db,ctx,sentence){
  const words=reader.read(sentence);
  const state=await policy.accountState(db,ctx.workspaceId),done=await interpret(db,ctx,words);
  const kind=KINDS[words.kind];
  const plan=kind?planFor(state,kind.job):{allowed:true};
  const reading={sentence:words.sentence,kind:words.kind,label:kind?.label||'Already how StockChief works',builtIn:Boolean(done.builtIn),
    meaning:done.meaning,lives:kind?.lives||null,plan,trainedNote:plan.trained?done.trainedNote||null:null,save:done.save};
  reading.key=crypto.createHash('sha256').update(JSON.stringify([reading.kind,reading.meaning,reading.save])).digest('hex');
  return reading;
}

// Same-rule replays change nothing. Returns {message, href}.
async function saveSplit(db,ctx,s){
  const splitting=require('../purchasing/agent-purchase-splitting'),maximum=money.userToMinor(s.maximum,s.currency),budget=s.budget?money.userToMinor(s.budget,s.currency):null;
  const prior=(await db.query(`SELECT id,revision,location_ids,maximum_source_minor,budget_minor FROM stockchief_runtime.agent_purchase_split_rules
    WHERE workspace_id=$1 AND supplier_id=$2 AND currency=$3 AND strategy=$4`,[ctx.workspaceId,s.supplierId,s.currency,s.strategy])).rows[0];
  if(prior&&Number(prior.maximum_source_minor)===maximum&&(prior.budget_minor==null?null:Number(prior.budget_minor))===budget&&[...prior.location_ids].sort().join()===s.locationIds.join())
    return {unchanged:true,id:prior.id};
  const example=(await db.query(`SELECT p.id FROM stockchief_runtime.assistant_action_proposals p
    JOIN purchase_orders o ON o.workspace_id=p.workspace_id AND o.id=p.result->'originals'->>0
    WHERE p.workspace_id=$1 AND p.actor_user_id=$2 AND p.action_type='purchase_order.split_draft' AND p.status='EXECUTED'
      AND p.result->>'automatic' IS DISTINCT FROM 'true' AND o.supplier_id=$3 AND p.payload#>>'{args,splitStrategy}'=$4
    ORDER BY p.executed_at DESC,p.id LIMIT 1`,[ctx.workspaceId,ctx.actorId,s.supplierId,s.strategy])).rows[0];
  await splitting.configure(db,ctx,{confirmed:'yes',strategy:s.strategy,supplierId:s.supplierId,locationIds:s.locationIds,maximum:s.maximum,
    budget:s.budget||'',trainingProposal:example?.id||'',revision:prior?.revision||0});
  return {id:s.supplierId};
}
async function saveCombine(db,ctx,s){
  const combining=require('../purchasing/agent-freight-combine'),maximum=money.userToMinor(s.maximum,s.currency);
  const prior=(await db.query(`SELECT id,revision,maximum_minor FROM stockchief_runtime.agent_freight_combine_rules
    WHERE workspace_id=$1 AND supplier_id=$2 AND location_id=$3 AND currency=$4`,[ctx.workspaceId,s.supplierId,s.locationId,s.currency])).rows[0];
  if(prior&&Number(prior.maximum_minor)===maximum)return {unchanged:true,id:prior.id};
  const example=(await db.query(`SELECT p.id FROM stockchief_runtime.assistant_action_proposals p
    JOIN purchase_orders o ON o.workspace_id=p.workspace_id AND o.id=p.result->'drafts'->>0
    WHERE p.workspace_id=$1 AND p.actor_user_id=$2 AND p.action_type='purchase_order.combine_drafts' AND p.status='EXECUTED'
      AND p.result->>'automatic'='false' AND o.supplier_id=$3 AND o.destination_location_id=$4 AND (p.result#>>'{freight,savedMinor}')::bigint>0
    ORDER BY p.executed_at DESC,p.id LIMIT 1`,[ctx.workspaceId,ctx.actorId,s.supplierId,s.locationId])).rows[0];
  await combining.configure(db,ctx,{confirmed:'yes',supplierId:s.supplierId,locationId:s.locationId,maximum:s.maximum,
    trainingProposal:example?.id||'',revision:prior?.revision||0});
  return {id:s.supplierId};
}
async function saveReorder(db,ctx,s){
  const instructions=require('../manager/postgres-operating-instructions'),n=v=>v==null?-1:Number(v);
  const sku=(await db.query('SELECT id FROM skus WHERE workspace_id=$1 AND lower(code)=lower($2) AND is_active=1',[ctx.workspaceId,s.sku])).rows[0];
  const location=s.location?(await db.query('SELECT id FROM locations WHERE workspace_id=$1 AND lower(trim(name))=lower(trim($2)) AND is_active=1 ORDER BY (parent_location_id IS NULL) DESC,id LIMIT 1',[ctx.workspaceId,s.location])).rows[0]:null;
  // A double click reopens the same waiting setting instead of a second copy.
  const waiting=sku?(await db.query(`SELECT id FROM operating_instruction_proposals WHERE workspace_id=$1 AND created_by_user_id=$2 AND status='PENDING'
    AND jsonb_array_length(resolved_changes::jsonb)=1 AND resolved_changes::jsonb->0->>'domain'='replenishment' AND resolved_changes::jsonb->0->>'skuId'=$3
    AND coalesce(resolved_changes::jsonb->0->>'locationId','')=$4 AND (resolved_changes::jsonb->0->>'reorderPoint')::numeric=$5
    AND (resolved_changes::jsonb->0->>'targetStock')::numeric=$6 AND (resolved_changes::jsonb->0->>'safetyStock')::numeric=$7 ORDER BY created_at DESC LIMIT 1`,
  [ctx.workspaceId,ctx.actorId,sku.id,location?.id||'',n(s.reorderPoint),n(s.targetStock),n(s.safetyStock)])).rows[0]:null;
  const proposal=waiting||await instructions.prepareReorderForm(db,ctx,{sku:s.sku,location:s.location,
    reorderPoint:s.reorderPoint==null?'':String(s.reorderPoint),targetStock:s.targetStock==null?'':String(s.targetStock),safetyStock:s.safetyStock==null?'':String(s.safetyStock)});
  return {id:proposal.id,unchanged:Boolean(waiting),pending:true};
}

async function confirm(db,ctx,input={}){
  await owner(db,ctx);
  const reading=await read(db,ctx,input.rule);
  if(reading.builtIn)throw new ValidationError('There is nothing to save: StockChief already does this.');
  if(String(input.key||'')!==reading.key)throw new ValidationError('Your records changed since StockChief read this rule. Check what it means again before saving.');
  await policy.requireWorkspaceJob(db,ctx.workspaceId,KINDS[reading.kind].job,'automatic',{trained:true});
  const s=reading.save;let result;
  if(reading.kind==='watch'){const saved=await require('./watch-rules').save(db,ctx,{instruction:s.instruction});result={id:saved.id,unchanged:Boolean(saved.unchanged)};}
  else if(reading.kind==='reorder')result=await saveReorder(db,ctx,s);
  else if(reading.kind==='supplier')result=await supplierRules.save(db,ctx,s);
  else if(reading.kind==='approval'){const saved=await require('./approval-desk').saveRule(db,ctx,s);result={id:saved.id,unchanged:Boolean(saved.unchanged)};}
  else if(reading.kind==='split')result=await saveSplit(db,ctx,s);
  else result=await saveCombine(db,ctx,s);
  if(!result.unchanged)await audit.record(db,ctx,{action:'Rule written in plain words',reference:reading.kind+':'+result.id,
    after:{rule:reading.sentence,meaning:reading.meaning.join(' ')}});
  return {...result,kind:reading.kind,href:result.pending?'/operating-instructions/'+result.id:KINDS[reading.kind].lives.href,
    message:result.pending?(result.unchanged?'This setting is already waiting for you. ':'')+'Check the exact setting and turn it on.':
      result.unchanged?'That rule is already saved. Nothing changed.':'Rule saved: '+reading.meaning[0]};
}

// How many rules the owner's inventories hold now, counted from the same rule
// tables as the allowance (agent-rule-quota.js), for the line on the page. A
// table this database does not have yet holds no rules.
async function usage(db,state){
  const quota=require('../commercial/agent-rule-quota'),limit=Object.hasOwn(quota.limits,state.plan)?quota.limits[state.plan]:null;
  if(!state.accountId)return {used:0,limit};
  const present=new Set((await db.query(`SELECT t FROM unnest($1::text[]) t WHERE to_regclass('stockchief_runtime.'||t) IS NOT NULL`,[quota.sources.map(([table])=>table)])).rows.map(r=>r.t));
  const terms=quota.sources.filter(([table])=>present.has(table)).map(([table,predicate])=>
    `(SELECT count(*) FROM stockchief_runtime.${table} t JOIN owned o ON o.id=t.workspace_id${predicate?' WHERE '+predicate:''})`);
  const row=(await db.query(`WITH owned AS MATERIALIZED(SELECT id FROM workspaces WHERE owner_account_id=$1 AND deletion_requested_at IS NULL)
    SELECT ${terms.concat('0').join('+')}+(SELECT count(*) FROM stockchief_runtime.agent_instruction_rule_targets t JOIN owned o ON o.id=t.workspace_id WHERE t.active) AS used`,[state.accountId])).rows[0];
  return {used:Number(row.used),limit};
}

async function page(db,ctx,query={}){
  await owner(db,ctx);
  const state=await policy.accountState(db,ctx.workspaceId),rule=String(query.rule||'').slice(0,reader.MAX+80);
  let reading=null,error=null;
  if(rule.trim()){
    try{reading=await read(db,ctx,rule);}catch(e){if(!(e instanceof ValidationError))throw e;error=e.message;}
  }
  const allowance=await usage(db,state);
  return {path,rule,reading,error,used:allowance.used,limit:allowance.limit,plan:planFor(state,JOB).current,
    examples:reader.EXAMPLES.map(e=>({...e,allowed:planFor(state,KINDS[EXAMPLE_KIND[e.kind]].job).allowed})),
    places:Object.values(KINDS).map(k=>({...k.lives,allowed:planFor(state,k.job).allowed,lowest:planFor(state,k.job).lowest})),
    supplierRules:await supplierRules.list(db,ctx.workspaceId)};
}

async function review(db,ctx){
  const rows=(await supplierRules.list(db,ctx.workspaceId)).map(r=>({Rule:r.instruction,'What it does':r.meaning,link:path+'#supplier-rules'}));
  return {summary:'Write a rule in plain words on the rules page. StockChief shows exactly how it reads it, and saves it only after you confirm.',
    rows:[{Rule:'Write a new rule',"What it does":'Open the rules page',link:path},...rows]};
}

module.exports={JOB,path,KINDS,read,confirm,page,usage,
  definition:{id:JOB,key:'plain-words-rules',label:'Rules you write in plain words',readPage:review}};
