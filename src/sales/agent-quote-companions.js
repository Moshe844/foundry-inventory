
'use strict';

const {ValidationError,AuthorizationError}=require('../domain/errors');
const {newId}=require('../lib/util');
const policy=require('../commercial/agent-plan'),permissions=require('../actions/permissions');
const pricing=require('../pricing/postgres-promotions'),money=require('../domain/currency');
const quantity=require('../domain/stock-quantity');
const quotes=require('./postgres-quotes'),proof=require('./quote-companion-evidence');
const ACTION='sales_quote.add_companions';
const JOB=79;
const KIND='agent.sales-quote.cross-sell.v1';
const rules='stockchief_runtime.agent_quote_companion_rules';
const work='stockchief_runtime.agent_quote_companion_work';
const scoped=db=>({query:(...args)=>db.query(...args),transaction:fn=>fn(db)});

async function owner(db,ctx,{lock=false}={}){
  if(lock)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
  const actor=(await db.query(`SELECT u.role,u.permissions FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)`+
    (lock?' FOR SHARE OF u,w':''),[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!actor)throw new AuthorizationError('Only the current inventory owner can authorize quotation companions.');
  permissions.assertCan(actor,permissions.MANAGE_SALES,'manage quotation companions');
}
async function access(db,ctx,operation,{lock=false,stop=false}={}){
  await owner(db,ctx,{lock});
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,operation);
  await require('../commercial/enforcement').workspace(db,ctx.workspaceId,'sales_orders.core');
  if(stop){
    const automatic=operation==='automatic',reason=await policy.stopped(db,ctx.workspaceId,state,ACTION,automatic);
    if(reason)throw new ValidationError(reason);
    if(automatic&&!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate){
      throw new ValidationError('Enable routine work before automatic quotation additions.');
    }
  }
  return state;
}

async function selections(db,ctx,value){
  let entries;
  try{entries=typeof value==='string'?JSON.parse(value):value;}catch{throw new ValidationError('Choose the exact companion SKUs and quantities.');}
  if(!Array.isArray(entries)||!entries.length||entries.length>500||entries.some(r=>!r||typeof r.sku!=='string'||!r.sku.trim())){
    throw new ValidationError('Choose distinct companion SKUs and quantities.');
  }
  const codes=entries.map(r=>r.sku.trim().toLowerCase());
  if(new Set(codes).size!==codes.length)throw new ValidationError('List each companion only once.');
  const products=(await db.query(`SELECT s.id sku_id,s.code,i.quantity_precision,i.quantity_increment,i.tracking_mode,
    i.secondary_unit_label,i.secondary_precision,i.secondary_increment FROM skus s
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND lower(s.code)=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1`,[ctx.workspaceId,codes])).rows;
  return entries.map((entry,index)=>{
    const matching=products.filter(r=>r.code.toLowerCase()===codes[index]);
    if(matching.length!==1)throw new ValidationError('Choose one exact active variant for '+entry.sku+'.');
    const p=matching[0],units=quantity.validate(p,entry.quantity??p.quantity_increment,{label:'Companion quantity'});
    return {skuId:p.sku_id,sku:p.code,quantity:units,...(entry.secondaryQuantity!=null&&entry.secondaryQuantity!==''?{secondaryQuantity:entry.secondaryQuantity}:{})};
  });
}

async function build(db,ctx,row,args){
  return db.transaction(async c=>{
    await access(c,ctx,'draft');
    const source=await proof.original(c,ctx,row.id);
    const site=await proof.site(c,ctx,source.q,args.companionWarehouse);
    const picked=await selections(c,ctx,args.companionLines);
    const p=await proof.calculate(c,ctx,source,site,picked);
    return {payload:{...p,selected:picked},summary:'Add '+p.additions.map(a=>a.quantity+' '+a.unit+' of '+a.sku).join(', ')+
      ' to a private revision of '+p.quoteNumber+' for '+p.customerName+'. Revised total '+money.format(p.totalMinor,p.currency)+'.'};
  },{isolation:'REPEATABLE READ',retrySafe:true});
}

async function retained(db,ctx,quoteId){
  return (await db.query('SELECT * FROM '+work+' WHERE workspace_id=$1 AND quote_id=$2',[ctx.workspaceId,quoteId])).rows[0];
}

async function save(db,ctx,p,{key,rule=null}){
  const storage=require('../commercial/storage-capacity'),detail={originalQuote:p.recordId,location:p.location.id,
    approvedRule:rule?.id||null,addedMinor:p.addedMinor,additions:p.additions.map(l=>({
      skuId:l.skuId,quantity:l.quantity,secondaryQuantity:l.secondaryQuantity,sharedOrders:l.sharedOrders,orders:l.orderEvidence,stock:l.stock}))};
  await storage.reserve(db,ctx.workspaceId,'quote-companions:'+p.recordId,Buffer.byteLength(JSON.stringify({input:p.input,detail}))*4+8192,{finished:true});
  const revision=await quotes.create(scoped(db),ctx,{...p.input,requestKey:key,validUntil:p.validUntil,supersedesId:p.recordId});
  if(revision.pricing_hash!==p.reviewedHash)throw new ValidationError('The quotation prices changed before the revision was saved.');
  await db.query(`INSERT INTO ${work}(workspace_id,quote_id,rule_id,rule_revision,state,approved_by,revision_id,source_fingerprint,evidence)
    VALUES($1,$2,$3,$4,'COMPLETED',$5,$6,$7,$8::jsonb)
    ON CONFLICT(quote_id) DO UPDATE SET state='COMPLETED',rule_id=EXCLUDED.rule_id,rule_revision=EXCLUDED.rule_revision,
      approved_by=EXCLUDED.approved_by,revision_id=EXCLUDED.revision_id,source_fingerprint=EXCLUDED.source_fingerprint,
      evidence=EXCLUDED.evidence,issue=NULL,updated_at=now()`,
  [ctx.workspaceId,p.recordId,rule?.id||null,rule?.revision||null,ctx.actorId,revision.id,p.sourceFingerprint,JSON.stringify(detail)]);
  return {quoteId:revision.id,quoteNumber:revision.quote_number,priorQuoteId:p.recordId};
}

async function execute(db,ctx,p){
  await access(db,ctx,'draft',{lock:true,stop:true});
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['quotation:'+ctx.workspaceId]);
  const prior=await retained(db,ctx,p.recordId);
  if(prior?.state==='COMPLETED'){
    if(prior.source_fingerprint!==p.sourceFingerprint)throw new ValidationError('A quotation companion revision already exists.');
    const revision=await quotes.get(db,ctx.workspaceId,prior.revision_id);
    return {quoteId:revision.id,quoteNumber:revision.quote_number,priorQuoteId:p.recordId,replayed:true};
  }
  const source=await proof.original(db,ctx,p.recordId,{lock:true}),location=await proof.site(db,ctx,source.q,p.location.id);
  const current=await proof.calculate(db,ctx,source,location,p.selected,{lock:true});
  if(current.sourceFingerprint!==p.sourceFingerprint)throw new ValidationError('The quotation, matching orders, stock or pricing changed. Prepare a fresh revision.');
  return save(db,ctx,current,{key:'quote-companions:'+p.idempotencyKey});
}

async function verify(db,ctx,r,p){
  const [revision,record]=await Promise.all([quotes.get(db,ctx.workspaceId,r.quoteId),retained(db,ctx,p.recordId)]);
  return Boolean(record?.state==='COMPLETED'&&record.revision_id===revision.id&&record.source_fingerprint===p.sourceFingerprint&&
    revision.pricing_hash===p.reviewedHash&&revision.supersedes_id===p.recordId&&revision.customer_id===p.customerId&&
    pricing.hash(revision.input)===pricing.hash(p.input));
}

async function configuration(db,ctx,q,locationId,input){
  return db.transaction(async c=>{
    if(input.stop==='yes')await owner(c,ctx,{lock:true});
    else await access(c,ctx,'automatic',{lock:true});
    const current=await quotes.get(c,ctx.workspaceId,q);
    const site=await proof.site(c,ctx,current,locationId),currency=money.code(current.pricing.currency);
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['quote-companion-rule:'+ctx.workspaceId]);
    const prior=(await c.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 AND customer_id=$2 AND location_id=$3 AND currency=$4 FOR UPDATE`,
      [ctx.workspaceId,current.customer_id,site.id,currency])).rows[0];
    if(!Number.isInteger(Number(input.revision))||Number(input.revision)!==(prior?.revision||0)){
      throw new ValidationError('Reload the current quotation companion rule before changing it.');
    }
    if(input.stop==='yes'){
      if(prior?.enabled){
        await c.query('UPDATE '+rules+' SET enabled=false,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,prior.id]);
        await require('../operations/postgres-security-audit').record(c,ctx,{action:'Quotation companion authority stopped',
          reference:current.quote_number,before:{revision:prior.revision,enabled:true},after:{enabled:false}});
      }
      return;
    }
    if(input.confirmed!=='yes')throw new ValidationError('Confirm the scope and maximum addition before enabling routine quotation changes.');
    const anchor=(await selections(c,ctx,[{sku:input.anchorSku}]))[0];
    if(!current.input.lines.some(line=>line.skuId===anchor.skuId))throw new ValidationError('Choose an exact anchor product on the source quotation.');
    const companions=await selections(c,ctx,input.companionLines);
    if(companions.some(line=>line.skuId===anchor.skuId))throw new ValidationError('Choose companions distinct from the anchor product.');
    const maximum=money.userToMinor(input.maximum,currency,{label:'Maximum added quotation value'});
    if(maximum<=0)throw new ValidationError('Set a positive maximum addition for the scope.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    const id=prior?.id||newId('quote-companions-rule'),encoded=JSON.stringify(companions);
    await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'quote-companion-rule:'+id,Buffer.byteLength(encoded)*2+4096,{finished:true});
    await c.query(`INSERT INTO ${rules} AS current(id,workspace_id,customer_id,location_id,anchor_sku_id,currency,companions,maximum_added_minor,owner_id)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) ON CONFLICT(workspace_id,customer_id,location_id,currency) DO UPDATE
      SET anchor_sku_id=EXCLUDED.anchor_sku_id,companions=EXCLUDED.companions,maximum_added_minor=EXCLUDED.maximum_added_minor,
        owner_id=EXCLUDED.owner_id,enabled=true,revision=current.revision+1,updated_at=now()`,
    [id,ctx.workspaceId,current.customer_id,site.id,anchor.skuId,currency,encoded,maximum,ctx.actorId]);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Quotation companion authority saved',reference:current.quote_number,
      before:prior?{revision:prior.revision,enabled:prior.enabled}:{},after:{currency,customer:current.customer_id,location:site.id,anchor:anchor.skuId,maximum}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function queueForNewQuote(db,ctx,q){
  if(q.supersedes_id)return;
  const matching=(await db.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 AND customer_id=$2 AND currency=$3 AND enabled
    AND anchor_sku_id=ANY($4::text[]) AND ($5::text IS NULL OR location_id=$5) ORDER BY id LIMIT 2`,
  [ctx.workspaceId,q.customer_id,q.pricing.currency,q.input.lines.map(l=>l.skuId),q.input.fulfillmentLocationId||null])).rows;
  if(!matching.length)return;
  const state=await policy.accountState(db,ctx.workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'automatic'))return;
  const rule=matching.length===1?matching[0]:null;
  const queued=await db.query(`INSERT INTO ${work}(workspace_id,quote_id,rule_id,rule_revision,state,issue)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(quote_id) DO NOTHING RETURNING quote_id`,
  [ctx.workspaceId,q.id,rule?.id||null,rule?.revision||null,rule?'QUEUED':'HELD',rule?null:'Choose the exact fulfillment warehouse for overlapping scopes.']);
  if(rule&&queued.rowCount)await require('../operations/postgres-job-queue').enqueue(scoped(db),{workspaceId:ctx.workspaceId,
    kind:KIND,idempotencyKey:'quote-companions:'+q.id,payload:{quoteId:q.id},maxAttempts:8,priority:55});
}

async function run(database,workspaceId,quoteId){
  return database.transaction(async db=>{
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['quotation:'+workspaceId]);
    const waiting=(await db.query('SELECT * FROM '+work+' WHERE workspace_id=$1 AND quote_id=$2 FOR UPDATE',[workspaceId,quoteId])).rows[0];
    if(!waiting||waiting.state!=='QUEUED')return {state:waiting?.state||'MISSING',quoteId:waiting?.revision_id||null,replayed:true};
    await db.query('SAVEPOINT quote_companion_revision');
    let current,rule,ctx;
    try{
      rule=(await db.query('SELECT * FROM '+rules+' WHERE workspace_id=$1 AND id=$2 FOR SHARE',[workspaceId,waiting.rule_id])).rows[0];
      if(!rule?.enabled||rule.revision!==waiting.rule_revision)throw new ValidationError('The owner’s quotation companion scope changed.');
      ctx={workspaceId,actorId:rule.owner_id};
      await access(db,ctx,'automatic',{lock:true,stop:true});
      const source=await proof.original(db,ctx,quoteId,{lock:true}),location=await proof.site(db,ctx,source.q,rule.location_id);
      if(source.q.customer_id!==rule.customer_id||source.currency!==rule.currency)throw new ValidationError('The quotation falls outside the approved customer or currency.');
      const existing=new Set(source.q.input.lines.map(l=>l.skuId));
      if(!existing.has(rule.anchor_sku_id))throw new ValidationError('The quotation does not contain the authorized anchor product.');
      const applicable=rule.companions.filter(l=>!existing.has(l.skuId));
      if(!applicable.length)throw new ValidationError('All approved companions are already present.');
      current=await proof.calculate(db,ctx,source,location,applicable,{lock:true,anchorSkuId:rule.anchor_sku_id});
      if(current.addedMinor>Number(rule.maximum_added_minor))throw new ValidationError('The exact addition exceeds the owner’s maximum.');
      const saved=await save(db,ctx,current,{key:'auto-quote-companions:'+quoteId,rule});
      await db.query('RELEASE SAVEPOINT quote_companion_revision');
      return {state:'COMPLETED',...saved};
    }catch(error){
      if(!['validation_error','forbidden','not_found','entitlement_required'].includes(error.code))throw error;
      await db.query('ROLLBACK TO SAVEPOINT quote_companion_revision');
      await db.query("UPDATE "+work+" SET state='HELD',issue=$3,updated_at=now() WHERE workspace_id=$1 AND quote_id=$2",
        [workspaceId,quoteId,String(error.message).slice(0,600)]);
      return {state:'HELD',reason:error.message};
    }
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function page(db,ctx,id,{locationId,page=1}={}){
  const state=await access(db,ctx,'suggest'),mode=policy.allowance(state.plan,JOB);
  const q=await quotes.get(db,ctx.workspaceId,id),outcome=await retained(db,ctx,id);
  const locations=(await db.query("SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL ORDER BY name,id",[ctx.workspaceId])).rows;
  const basic={q,mode,outcome,locations,chosen:q.input.fulfillmentLocationId||locationId||null,problem:null,candidates:[],rule:null,more:false,page};
  try{
    const source=await proof.original(db,ctx,id);
    if(mode==='suggest'){
      const [row]=await proof.sources(db,ctx,{anchors:q.input.lines.map(l=>l.skuId),currency:source.currency,locationId:q.input.fulfillmentLocationId||null,limit:1});
      return {...basic,suggestion:row?'Consider '+row.name+' from '+row.shared_orders+' fulfilled combinations.':null};
    }
    if(!basic.chosen&&locations.length===1)basic.chosen=locations[0].id;
    if(!basic.chosen)return basic;
    const location=await proof.site(db,ctx,q,basic.chosen);
    const rows=await proof.sources(db,ctx,{anchors:q.input.lines.map(l=>l.skuId),currency:source.currency,locationId:location.id,
      limit:51,offset:(page-1)*50});
    const [rule,anchors]=await Promise.all([
      db.query('SELECT * FROM '+rules+' WHERE workspace_id=$1 AND customer_id=$2 AND location_id=$3 AND currency=$4',
        [ctx.workspaceId,q.customer_id,location.id,source.currency]).then(r=>r.rows[0]),
      db.query('SELECT id,code FROM skus WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY code',
        [ctx.workspaceId,q.input.lines.map(l=>l.skuId)]).then(r=>r.rows)
    ]);
    return {...basic,anchors,candidates:rows.slice(0,50),more:rows.length>50,rule};
  }catch(error){if(error.code!=='validation_error')throw error;return {...basic,problem:error.message};}
}

module.exports={ACTION,JOB,KIND,configuration,queueForNewQuote,run,page,retained,
  spec:{name:ACTION,agentJob:JOB,record:'sales_quotation',ownerOnly:true,permission:permissions.MANAGE_SALES,
    fields:['recordReference','companionWarehouse','companionLines'],capability:'sales_orders.core',
    resultingRecords:['sales_quotations',work],resultReference:'quoteId',resultDisplayReference:'quoteNumber',
    description:'Prepare a private native quotation revision with the owner-selected companion products supported by actual fulfilled combinations and exact stock, warehouse and customer pricing. Use exact companion SKUs and quantities. Never accept or send the quotation.',
    build,execute,verify}};
