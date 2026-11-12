'use strict';

const source = require('./product-retirement-source');
const policy = require('../commercial/agent-plan');
const { hash } = require('../pricing/postgres-promotions');
const { newId } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const action = 'catalog.retire_discontinued', jobKind = 'catalog.retire-products.v1';

async function lock(c, ctx) {
  await c.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s', [ctx.workspaceId]);
  await source.owner(c, ctx);
  return policy.requireWorkspaceJob(c, ctx.workspaceId, 132, 'draft');
}
async function notice(db, ctx, id, locking = false) {
  const row = (await db.query('SELECT * FROM stockchief_runtime.agent_product_retirement_notices WHERE workspace_id=$1 AND id=$2' + (locking ? ' FOR UPDATE' : ''), [ctx.workspaceId, id])).rows[0];
  if (!row) throw new NotFoundError('That discontinuation notice is not in this inventory.');
  return row;
}
const raw = n => ({ supplierId:n.supplier_id, reference:n.reference, products:n.products });
async function preview(db, ctx, input) { return source.facts(db, ctx, input); }

async function record(db, ctx, input) {
  return db.transaction(async c => {
    const state=await lock(c, ctx),stop=await policy.stopped(c,ctx.workspaceId,state,action,false);if(stop)throw new ValidationError(stop);
    const parsed=source.input(input),existing=(await c.query('SELECT * FROM stockchief_runtime.agent_product_retirement_notices WHERE workspace_id=$1 AND supplier_id=$2 AND reference=$3',[ctx.workspaceId,parsed.supplierId,parsed.reference])).rows[0];
    if(existing){
      if(input.sourceChecked!=='yes'||input.sourceFingerprint!==existing.source_fingerprint||hash(source.input(raw(existing)))!==hash(parsed))throw new ValidationError('This supplier reference already identifies a different checked notice. Review the existing source.');
      return {id:existing.id,replayed:true};
    }
    const p = await source.facts(c, ctx, input);
    if (input.sourceChecked !== 'yes' || input.sourceFingerprint !== p.sourceFingerprint)
      throw new ValidationError('Check the original supplier notice and these exact SKU pairs before recording its instructions. Recording a source is separate from approving retirement.');
    const prior = (await c.query('SELECT * FROM stockchief_runtime.agent_product_retirement_notices WHERE workspace_id=$1 AND supplier_id=$2 AND reference=$3', [ctx.workspaceId, p.supplier.id, p.reference])).rows[0];
    if (prior) {
      if (prior.source_fingerprint !== p.sourceFingerprint) throw new ValidationError('This supplier reference already identifies a different notice. Review the existing source.');
      return { id:prior.id, replayed:true };
    }
    const id = newId('discontinued');
    const inserted=await c.query('INSERT INTO stockchief_runtime.agent_product_retirement_notices(id,workspace_id,supplier_id,reference,products,source_fingerprint,source_snapshot,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,supplier_id,reference) DO NOTHING RETURNING id', [id,ctx.workspaceId,p.supplier.id,p.reference,input.products,p.sourceFingerprint,p,ctx.actorId]);
    if(!inserted.rowCount){const conflict=Error('The notice was recorded concurrently; retry its exact checked source.');conflict.code='40001';throw conflict;}
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier discontinuation source recorded',reference:id,after:{supplierId:p.supplier.id,reference:p.reference,sourceFingerprint:p.sourceFingerprint}});
    const setting = (await c.query('SELECT enabled FROM stockchief_runtime.agent_product_retirement_settings WHERE workspace_id=$1 AND supplier_id=$2',[ctx.workspaceId,p.supplier.id])).rows[0];
    if (setting?.enabled) await enqueue(c,ctx.workspaceId,id);
    return {id,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function apply(db, ctx, id, input = {}, { automatic = false } = {}) {
  return db.transaction(async c => {
    const state=await lock(c,ctx),stop=await policy.stopped(c,ctx.workspaceId,state,action,automatic);
    if(stop)throw new ValidationError(stop);
    const n=await notice(c,ctx,id,true);
    if(n.applied_at)return {replayed:true,...n.result};
    const originals=n.source_snapshot.pairs.map(p=>p.old),allIds=[...new Set(n.source_snapshot.pairs.flatMap(p=>[p.old.id,p.replacement.id]))].sort();
    await c.query('SELECT id FROM items WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[ctx.workspaceId,[...new Set(n.source_snapshot.pairs.flatMap(p=>[p.old.item_id,p.replacement.item_id]))].sort()]);
    await c.query('SELECT id FROM skus WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[ctx.workspaceId,allIds]);
    await c.query('SELECT id FROM suppliers WHERE workspace_id=$1 AND id=$2 FOR SHARE',[ctx.workspaceId,n.supplier_id]);
    await c.query('SELECT id FROM supplier_items WHERE workspace_id=$1 AND supplier_id=$2 AND sku_id=ANY($3::text[]) ORDER BY id FOR SHARE',[ctx.workspaceId,n.supplier_id,allIds]);
    const p=await source.facts(c,ctx,raw(n));
    if(p.sourceFingerprint!==n.source_fingerprint)throw new ValidationError('A product, replacement or supplier changed after this source was recorded. Review a new notice.');
    if(automatic){
      const setting=(await c.query('SELECT * FROM stockchief_runtime.agent_product_retirement_settings WHERE workspace_id=$1 AND supplier_id=$2 FOR SHARE',[ctx.workspaceId,n.supplier_id])).rows[0];
      if(!setting?.enabled||setting.authorized_by!==ctx.actorId||new Date(n.created_at)<new Date(setting.authorized_at)||hash(setting.supplier_snapshot)!==hash(p.supplier))throw new ValidationError('This notice needs a current, unchanged owner-authorized supplier scope. Historical notices are not processed by new authority.');
      const maximum=Math.min(setting.maximum_products,setting.taught_maximum||100);
      if(p.pairs.length>maximum)throw new ValidationError('This notice exceeds the owner’s product limit, including any lower taught limit.');
      policy.requireJob(state.plan,132,'automatic',{trained:Boolean(setting.taught_notice_id)});
      if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('Automatic product retirement is paused.');
    }else if(input.confirmed!=='yes'||input.sourceFingerprint!==p.sourceFingerprint)throw new ValidationError('Approve these exact product retirements and replacement links before applying.');
    // Job 132's retirement: no more reordering, the replacement recorded,
    // zero-stock products archived and stock left sold down.
    const work=require('./agent-retirement-work');
    const started=await work.startMany(c,ctx,p.pairs.map(pair=>({skuId:pair.old.id,replacementSkuId:pair.replacement.id,evidence:{notice:n.reference}})),
      {source:'SUPPLIER',noticeId:id,automatic,clearance:await clearance(c,ctx)});
    const result={changedCount:originals.length,items:p.pairs.map((pair,i)=>({oldItemId:pair.old.item_id,oldCode:pair.old.code,replacementItemId:pair.replacement.item_id,
      replacementCode:pair.replacement.code,status:started.rows[i].status,left:started.rows[i].left}))};
    await c.query('UPDATE stockchief_runtime.agent_product_retirement_notices SET applied_at=clock_timestamp(),applied_by=$3,automatic=$4,result=$5,last_issue=NULL WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,ctx.actorId,automatic,result]);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Discontinued products retired with replacement guidance',reference:id,after:{...result,automatic,sourceFingerprint:p.sourceFingerprint}});
    return {replayed:false,...result};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// The clearance markdown the owner saved for stock left on discontinued products.
async function clearance(c,ctx){const rule=await require('./agent-retirement-work').loadRule(c,ctx.workspaceId);return rule?.markdown_points?{points:rule.markdown_points,stepDays:rule.step_days}:null;}

async function configure(db,ctx,supplierId,input){
 return db.transaction(async c=>{
  await source.owner(c,ctx);
  const prior=(await c.query('SELECT * FROM stockchief_runtime.agent_product_retirement_settings WHERE workspace_id=$1 AND supplier_id=$2 FOR UPDATE',[ctx.workspaceId,supplierId])).rows[0];
  if(Number(input.revision)!==(prior?.revision||0))throw new ValidationError('Reload the current retirement authority before changing it.');
  if(input.stop==='yes'){
   if(prior)await c.query('UPDATE stockchief_runtime.agent_product_retirement_settings SET enabled=false,revision=revision+1 WHERE workspace_id=$1 AND supplier_id=$2',[ctx.workspaceId,supplierId]);
   await require('../operations/postgres-security-audit').record(c,ctx,{action:'Automatic product retirement stopped',reference:supplierId});return;
  }
  const state=await lock(c,ctx),stop=await policy.stopped(c,ctx.workspaceId,state,action,true);if(stop)throw new ValidationError(stop);
  const maximum=String(input.maximumProducts??'');
  if(input.confirmed!=='yes'||!/^\d{1,3}$/.test(maximum)||Number(maximum)<1||Number(maximum)>100)throw new ValidationError('Enter and confirm an explicit limit from one to 100 products per checked notice.');
  const supplier=(await c.query("SELECT id,name,email,status FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'",[ctx.workspaceId,supplierId])).rows[0];
  if(!supplier||input.supplierFingerprint!==hash(supplier))throw new ValidationError('Review the current supplier before authorizing retirement.');
  let example=null;if(input.exampleId){example=await notice(c,ctx,input.exampleId);if(example.supplier_id!==supplierId||example.applied_by!==ctx.actorId||!example.applied_at||example.automatic||!example.result?.changedCount)throw new ValidationError('Teach this supplier scope from your individually approved completed retirement.');}
  const taughtId=example?.id||prior?.taught_notice_id||null,taughtMaximum=example?Number(maximum):prior?.taught_maximum||null;
  policy.requireJob(state.plan,132,'automatic',{trained:Boolean(taughtId)});
  if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('Enable routine work before granting automatic retirement authority.');
  await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
  await c.query(`INSERT INTO stockchief_runtime.agent_product_retirement_settings(workspace_id,supplier_id,enabled,maximum_products,supplier_snapshot,authorized_by,taught_notice_id,taught_maximum)
   VALUES($1,$2,true,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,supplier_id) DO UPDATE SET enabled=true,maximum_products=EXCLUDED.maximum_products,supplier_snapshot=EXCLUDED.supplier_snapshot,authorized_by=EXCLUDED.authorized_by,authorized_at=clock_timestamp(),revision=agent_product_retirement_settings.revision+1,taught_notice_id=EXCLUDED.taught_notice_id,taught_maximum=EXCLUDED.taught_maximum`,[ctx.workspaceId,supplierId,Number(maximum),supplier,ctx.actorId,taughtId,taughtMaximum]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier product retirement scope authorized',reference:supplierId,after:{maximumProducts:Number(maximum),taughtNoticeId:taughtId,checkedSourceRequired:true,stockWriteoff:false}});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function page(db,ctx,id){
 await source.owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,132,'draft');const n=await notice(db,ctx,id),state=await policy.accountState(db,ctx.workspaceId);
 const setting=(await db.query('SELECT * FROM stockchief_runtime.agent_product_retirement_settings WHERE workspace_id=$1 AND supplier_id=$2',[ctx.workspaceId,n.supplier_id])).rows[0]||null;
 const supplier=(await db.query('SELECT id,name,email,status FROM suppliers WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,n.supplier_id])).rows[0];
 let problem=null,fresh=null;if(!n.applied_at){try{fresh=await source.facts(db,ctx,raw(n));if(fresh.sourceFingerprint!==n.source_fingerprint)problem='The recorded products or supplier changed. Review a new notice.';}catch(error){if(![400,402,403,404,422].includes(error.status))throw error;problem=error.message;}}
 return {notice:n,setting,plan:state.plan,shadow:state.shadow,supplier,supplierFingerprint:hash(supplier),freshFingerprint:problem?null:fresh?.sourceFingerprint,problem};
}
async function list(db,ctx,options={}){
 const pages={};for(const key of ['page','supplierPage','settingsPage']){const n=Number(options[key]||1);if(!Number.isSafeInteger(n)||n<1||n>1000000)throw new ValidationError('Choose a valid product retirement page.');pages[key]=n;}
 await source.owner(db,ctx);const state=await policy.accountState(db,ctx.workspaceId),locked=!policy.usesAgentTerms(state)||!policy.permits(state.plan,132,'draft');
 const rows=(await db.query('SELECT n.id,n.reference,n.applied_at,s.name AS supplier_name FROM stockchief_runtime.agent_product_retirement_notices n JOIN suppliers s ON s.workspace_id=n.workspace_id AND s.id=n.supplier_id WHERE n.workspace_id=$1 ORDER BY n.created_at DESC,n.id DESC LIMIT 101 OFFSET $2',[ctx.workspaceId,(pages.page-1)*100])).rows;
 const suppliers=locked?[]:(await db.query("SELECT id,name FROM suppliers WHERE workspace_id=$1 AND status='active' ORDER BY name,id LIMIT 101 OFFSET $2",[ctx.workspaceId,(pages.supplierPage-1)*100])).rows;
 const settings=(await db.query('SELECT x.*,s.name AS supplier_name FROM stockchief_runtime.agent_product_retirement_settings x JOIN suppliers s ON s.workspace_id=x.workspace_id AND s.id=x.supplier_id WHERE x.workspace_id=$1 ORDER BY s.name,x.supplier_id LIMIT 101 OFFSET $2',[ctx.workspaceId,(pages.settingsPage-1)*100])).rows;
 return {locked,plan:state.plan,shadow:state.shadow,...pages,rows:rows.slice(0,100),more:rows.length>100,suppliers:suppliers.slice(0,100),supplierMore:suppliers.length>100,settingsMore:settings.length>100,settings:settings.slice(0,100).map(s=>({...s,allowed:policy.usesAgentTerms(state)&&policy.permits(state.plan,132,'automatic',{trained:Boolean(s.taught_notice_id)})}))};
}
async function guidance(db,workspaceId,itemId){const current=await require('./retirement-guidance').forItem(db,workspaceId,itemId);if(current)return current;return (await db.query(`SELECT old.code AS old_code,target.code AS replacement_code,i.id AS replacement_item_id,i.name AS replacement_name FROM stockchief_runtime.agent_product_replacements r JOIN skus old ON old.workspace_id=r.workspace_id AND old.id=r.old_sku_id JOIN skus target ON target.workspace_id=r.workspace_id AND target.id=r.replacement_sku_id JOIN items i ON i.workspace_id=target.workspace_id AND i.id=target.item_id WHERE r.workspace_id=$1 AND old.item_id=$2 AND old.is_active=0 AND target.is_active=1 AND i.is_active=1 ORDER BY old.code`,[workspaceId,itemId])).rows;}
async function inbox(db,workspaceId,actorId){
 const work=await require('./agent-retirement-work').inbox(db,workspaceId);
 return work.concat(await noticeInbox(db,workspaceId,actorId));
}
async function noticeInbox(db,workspaceId,actorId){
 const rows=(await db.query('SELECT n.id,n.reference,n.last_issue,n.created_at,s.name FROM stockchief_runtime.agent_product_retirement_notices n JOIN suppliers s ON s.workspace_id=n.workspace_id AND s.id=n.supplier_id WHERE n.workspace_id=$1 AND n.applied_at IS NULL AND n.last_issue IS NOT NULL ORDER BY n.created_at,n.id LIMIT 50',[workspaceId])).rows;
 if(!rows.length)return [];await source.owner(db,{workspaceId,actorId});const state=await policy.accountState(db,workspaceId),eligible=policy.usesAgentTerms(state)&&policy.permits(state.plan,132,'draft');
 return rows.map(n=>({kind:'catalog',importance:'Needs You',priority:68,title:'Review discontinued products: '+n.name+' · '+n.reference,happened:'Product retirement stopped before changing the catalog.',why:n.last_issue,recommendation:'Review the current products, source notice and retirement authority.',href:eligible?'/autopilot/discontinued-products/'+n.id:'/autopilot/discontinued-products',actionLabel:'Review discontinued products',sourceId:'product-retirement:'+n.id,at:n.created_at,createdAt:n.created_at}));
}
async function onNotice(db,workspaceId,id){try{const n=(await db.query('SELECT authorized_by FROM stockchief_runtime.agent_product_retirement_settings x JOIN stockchief_runtime.agent_product_retirement_notices n ON n.workspace_id=x.workspace_id AND n.supplier_id=x.supplier_id WHERE n.workspace_id=$1 AND n.id=$2',[workspaceId,id])).rows[0];if(!n)throw new ValidationError('No enabled owner retirement scope.');return await apply(db,{workspaceId,actorId:n.authorized_by},id,{}, {automatic:true});}catch(error){if(![400,402,403,404,422].includes(error.status))throw error;await db.query('UPDATE stockchief_runtime.agent_product_retirement_notices SET last_issue=$3 WHERE workspace_id=$1 AND id=$2 AND applied_at IS NULL',[workspaceId,id,String(error.message).slice(0,500)]);return {held:true,reason:error.message};}}
async function enqueue(c,workspaceId,id){return require('../operations/postgres-job-queue').enqueue({query:(...a)=>c.query(...a),transaction:fn=>fn(c)},{workspaceId,kind:jobKind,idempotencyKey:'discontinue:'+id,payload:{noticeId:id},priority:30,maxAttempts:3});}

module.exports={preview,record,apply,configure,page,list,guidance,inbox,onNotice,jobKind,action,definition:{id:132,key:'discontinued-products',label:'Retire discontinued products and show replacements',readPage:(db,ctx,options)=>require('./agent-retirement-work').review(db,ctx,options)}};
