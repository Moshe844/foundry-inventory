'use strict';
const source=require('./supplier-forecast-source'),policy=require('../commercial/agent-plan');
const {newId}=require('../lib/util'),{hash}=require('../pricing/postgres-promotions'),{ValidationError,NotFoundError}=require('../domain/errors'),{addDays}=require('../accounting/customer-money');
const kind='supplier_forecast',action='supplier.share_forecast';
function monday(date){const day=new Date(date+'T00:00:00Z').getUTCDay();return addDays(date,-((day+6)%7));}
function scope(p){return {supplierId:p.supplierId,supplierName:p.supplierName,recipient:p.recipient,connectorId:p.connectorId,mailboxAccount:p.mailboxAccount,providerType:p.providerType,timeZone:p.timeZone,skuIds:p.skuIds,products:p.rows.map(r=>({skuId:r.skuId,sku:r.sku,name:r.name,unit:r.unit}))};}
function compose(p){
 const rows=p.rows.map(row=>row.sku+' · '+row.name+'\nRecorded stock: '+row.onHand+' '+row.unit+(row.needsReview?' (stock discrepancy reviewed by the owner)':'')+'\n'+(row.total===null?'12-week estimate: unknown — more confirmed order history is needed.':'12-week estimated demand: '+row.total+' '+row.unit+'\n'+row.forecast.map((week,index)=>'Week '+(index+1)+' ('+week.from+' to '+week.to+'): '+week.quantity+' '+row.unit).join('\n')));
 const body='Hello '+p.supplierName+',\n\nHere is our recorded stock and a 12-week demand estimate for the products selected below.\nPrepared: '+p.preparedAt+' ('+p.timeZone+').\n\n'+rows.join('\n\n')+'\n\nRecorded stock is owned stock on hand at active sites as of preparation, not stock available to promise. It excludes supplier-owned stock and does not subtract reservations or commitments.\nEstimates use average confirmed order demand in complete seven-day periods from '+p.historyFrom+' through '+p.historyThrough+'. At least eight complete periods and two order dates are required. Recent changes, promotions and seasonality are not predicted.\n\nThis is planning information only, not a purchase order, delivery promise or commitment. No customer details, prices or costs are included.\n\nThank you.';
 if(body.length>100000)throw new ValidationError('Choose fewer products so the complete forecast fits in one email.');
 return {subject:'Stock and 12-week demand estimate · '+p.today,body};
}
async function report(db,workspaceId,id){
 const row=(await db.query('SELECT *,week_start::text AS week_start FROM stockchief_runtime.agent_supplier_forecast_reports WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];
 if(!row)throw new NotFoundError('That supplier forecast is not in this inventory.');
 const {sourceFingerprint,...facts}=row.snapshot;
 if(sourceFingerprint!==row.source_fingerprint||hash(facts)!==sourceFingerprint||row.supplier_id!==facts.supplierId||row.connector_id!==facts.connectorId||row.week_start!==monday(facts.today))throw new ValidationError('This forecast no longer matches its saved source. Prepare a fresh preview.');
 compose(row.snapshot);return row;
}
async function preview(db,ctx,input){
 if(typeof input.requestKey!=='string'||!input.requestKey||input.requestKey.length>160)throw new ValidationError('Reload the forecast form before preparing it.');
 if(!Array.isArray(input.skuIds)||!input.skuIds.length||input.skuIds.length>250||input.skuIds.some(id=>typeof id!=='string'||!id)||new Set(input.skuIds).size!==input.skuIds.length)throw new ValidationError('Choose one to 250 distinct products to share with this supplier.');
 const inputHash=hash({supplierId:input.supplierId,connectorId:input.connectorId,skuIds:[...(input.skuIds||[])].sort()});
 await source.access(db,ctx);
 const prior=(await db.query('SELECT id,input_hash FROM stockchief_runtime.agent_supplier_forecast_reports WHERE workspace_id=$1 AND request_key=$2',[ctx.workspaceId,input.requestKey])).rows[0];
 if(prior){if(prior.input_hash!==inputHash)throw new ValidationError('This preview reference already uses different products. Open a new form.');return report(db,ctx.workspaceId,prior.id);}
 const p=await source.snapshot(db,ctx,input);compose(p);
 return db.transaction(async c=>{
  await source.access(c,ctx);
  const row=(await c.query(`INSERT INTO stockchief_runtime.agent_supplier_forecast_reports(id,workspace_id,supplier_id,connector_id,prepared_by,request_key,input_hash,snapshot,source_fingerprint,week_start)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(workspace_id,request_key) DO NOTHING RETURNING id`,[newId('forecast'),ctx.workspaceId,p.supplierId,p.connectorId,ctx.actorId,input.requestKey,inputHash,JSON.stringify(p),p.sourceFingerprint,monday(p.today)])).rows[0]||(await c.query('SELECT id,input_hash FROM stockchief_runtime.agent_supplier_forecast_reports WHERE workspace_id=$1 AND request_key=$2',[ctx.workspaceId,input.requestKey])).rows[0];
  if(row.input_hash&&row.input_hash!==inputHash)throw new ValidationError('This preview reference already uses different products.');
  return report(c,ctx.workspaceId,row.id);
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function currentScope(db,ctx,p){
 await source.access(db,ctx);
 const clock=await require('../lib/business-time').forWorkspace(db,ctx.workspaceId);
 const age=Date.parse(clock.instant)-Date.parse(p.preparedAt);
 if(!Number.isFinite(age)||age<0||age>86400000||monday(clock.calendarDate)!==monday(p.today))throw new ValidationError('This preview is older than 24 hours or belongs to an earlier week. Prepare a fresh forecast.');
 const supplier=(await db.query("SELECT name,email FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'",[ctx.workspaceId,p.supplierId])).rows[0],box=await require('../shipping/agent-shipping-notices').mailbox(db,ctx.workspaceId,p.connectorId);
 if(!supplier||supplier.name!==p.supplierName||supplier.email!==p.recipient||!box||box.provider_account_id!==p.mailboxAccount||box.provider_type!==p.providerType||clock.timeZone!==p.timeZone)throw new ValidationError('The supplier, sending mailbox or business time zone changed. Review a fresh forecast.');
 const rows=(await db.query('SELECT s.id,s.code,i.name,i.unit_label FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1 ORDER BY s.id',[ctx.workspaceId,p.skuIds])).rows;
 if(hash(rows.map(r=>({skuId:r.id,sku:r.code,name:r.name,unit:r.unit_label})))!==hash(scope(p).products))throw new ValidationError('A selected product or its units changed. Review a fresh forecast.');
 return clock;
}
async function authority(db,workspaceId,p){
 const ctx={workspaceId,actorId:p.actorId},saved=await report(db,workspaceId,p.recordId),facts=saved.snapshot;
 if(p.kind!==kind||p.sourceFingerprint!==saved.source_fingerprint||saved.prepared_by!==p.actorId||p.manualApproval!==true&&p.automatic!==true)throw new ValidationError('Approve the exact supplier forecast or its weekly scope before sending.');
 const account=await policy.requireWorkspaceJob(db,workspaceId,36,p.automatic?'automatic':'draft'),stop=await policy.stopped(db,workspaceId,account,action,p.automatic,p);if(stop)throw new ValidationError(stop);
 await currentScope(db,ctx,facts);
 if(facts.rows.some(r=>r.needsReview)&&(!p.negativeConfirmed||p.automatic))throw new ValidationError('Review the negative stock positions individually before sharing this forecast.');
 if(p.automatic){
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)throw new ValidationError('Automatic forecast sharing is paused.');
  const rule=(await db.query('SELECT * FROM stockchief_runtime.agent_supplier_forecast_rules WHERE workspace_id=$1 AND id=$2 AND enabled',[workspaceId,p.ruleId])).rows[0];
  if(!rule||rule.authorized_by!==p.actorId||rule.revision!==p.ruleRevision||rule.scope_hash!==hash(scope(facts)))throw new ValidationError('The authorized supplier forecast scope changed. Review it before sending.');
 }
 const queued=(await db.query("SELECT m.recipient,m.connector_id,m.subject,m.body FROM supplier_communications m WHERE m.workspace_id=$1 AND m.idempotency_key=$2",[workspaceId,'supplier-forecast:'+facts.supplierId+':'+saved.week_start])).rows[0],words=compose(facts);
 if(queued&&(queued.recipient!==facts.recipient||queued.connector_id!==facts.connectorId||queued.subject!==words.subject||queued.body!==words.body))throw new ValidationError('Another forecast already uses this supplier and week. Review that delivery before sharing again.');
 return saved;
}
async function queue(c,ctx,saved,grant){
 await authority(c,ctx.workspaceId,grant);const p=saved.snapshot,key='supplier-forecast:'+p.supplierId+':'+saved.week_start;
 const prior=(await c.query("SELECT m.*,e.id effect_id,e.payload FROM supplier_communications m LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' WHERE m.workspace_id=$1 AND m.idempotency_key=$2",[ctx.workspaceId,key])).rows[0];
 if(prior){
  if(prior.status==='FAILED'||!prior.effect_id||prior.payload?.standingAuthority?.recordId!==saved.id)throw new ValidationError('Review the earlier forecast delivery for this supplier and week before trying again.');
  return {communicationId:prior.id,effectId:prior.effect_id,status:prior.status,replayed:true};
 }
 const result=await require('../connections/postgres-outbound-mail').queueInTransaction(c,ctx,{recipientKind:'supplier',recipientId:p.supplierId,recipientEmail:p.recipient,connectorId:p.connectorId,...compose(p),standingAuthority:grant},key,{agentRequested:true,agentJob:36});
 await c.query('UPDATE stockchief_runtime.agent_supplier_forecast_reports SET communication_id=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,saved.id,result.communicationId]);
 return {...result,replayed:false};
}
async function send(db,ctx,id,input){
 if(input.confirmed!=='yes')throw new ValidationError('Confirm the supplier, recipient and exact selected products before sharing.');
 return db.transaction(async c=>{
  await source.access(c,ctx);const saved=await report(c,ctx.workspaceId,id);
  if(input.expectedFingerprint!==saved.source_fingerprint)throw new ValidationError('Review this exact forecast before sending.');
  return queue(c,ctx,saved,{kind,recordId:id,actorId:ctx.actorId,sourceFingerprint:saved.source_fingerprint,manualApproval:true,automatic:false,negativeConfirmed:input.negativeConfirmed==='yes'});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function configure(db,ctx,id,input){
 return db.transaction(async c=>{
  await source.owner(c,ctx);
  const prior=(await c.query('SELECT * FROM stockchief_runtime.agent_supplier_forecast_rules WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,input.ruleId||''])).rows[0];
  if(input.stop==='yes'){
   if(!prior||prior.revision!==Number(input.revision))throw new ValidationError('Reload the weekly sharing rule before stopping it.');
   await c.query('UPDATE stockchief_runtime.agent_supplier_forecast_rules SET enabled=false,revision=revision+1,updated_at=now() WHERE id=$1',[prior.id]);
   await require('../operations/postgres-security-audit').record(c,ctx,{action:'Weekly supplier forecast sharing stopped',reference:prior.supplier_id});return;
  }
  const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,36,'automatic');
  if(account.shadow)throw new ValidationError('Wait until the 14-day watch period ends before enabling weekly supplier sharing.');
  const saved=await report(c,ctx.workspaceId,id),p=saved.snapshot,clock=await currentScope(c,ctx,p);
  if(input.confirmed!=='yes'||saved.prepared_by!==ctx.actorId||input.expectedFingerprint!==p.sourceFingerprint||p.rows.some(r=>r.needsReview))throw new ValidationError('Review and confirm a current forecast with no negative stock discrepancies before enabling weekly sharing.');
  const due=String(input.firstSendOn||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(due)||!Number.isFinite(Date.parse(due))||new Date(due+'T00:00:00Z').toISOString().slice(0,10)!==due||due<clock.calendarDate||due>addDays(clock.calendarDate,365))throw new ValidationError('Choose a first sending date from today through the next year.');
  const existing=(await c.query('SELECT * FROM stockchief_runtime.agent_supplier_forecast_rules WHERE workspace_id=$1 AND supplier_id=$2 FOR UPDATE',[ctx.workspaceId,p.supplierId])).rows[0];
  if((existing?.revision||0)!==Number(input.revision||0))throw new ValidationError('The weekly rule changed. Reload its current preview.');
  await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],existing?.enabled?0:1);
  await c.query(`INSERT INTO stockchief_runtime.agent_supplier_forecast_rules(id,workspace_id,supplier_id,connector_id,authorized_by,scope,scope_hash,next_due_on)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,supplier_id) DO UPDATE SET connector_id=EXCLUDED.connector_id,authorized_by=EXCLUDED.authorized_by,scope=EXCLUDED.scope,scope_hash=EXCLUDED.scope_hash,next_due_on=EXCLUDED.next_due_on,enabled=true,revision=agent_supplier_forecast_rules.revision+1,retry_after=NULL,problem=NULL,updated_at=now()`,[existing?.id||newId('forecastrule'),ctx.workspaceId,p.supplierId,p.connectorId,ctx.actorId,JSON.stringify(scope(p)),hash(scope(p)),due]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Weekly supplier forecast sharing authorized',reference:p.supplierId,after:{recipient:p.recipient,skuIds:p.skuIds,firstSendOn:due}});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function run(db,workspaceId){
 const rules=(await db.query('SELECT r.*,r.next_due_on::text AS next_due_on FROM stockchief_runtime.agent_supplier_forecast_rules r WHERE r.workspace_id=$1 AND r.enabled AND (r.retry_after IS NULL OR r.retry_after<=now()) ORDER BY r.next_due_on,r.id LIMIT 10',[workspaceId])).rows;
 let queued=0,held=0,skipped=0;
 for(const rule of rules){try{
  const clock=await require('../lib/business-time').forWorkspace(db,workspaceId);if(rule.next_due_on>clock.calendarDate)continue;
  const outcome=await db.transaction(async c=>{
   const locked=(await c.query('SELECT *,next_due_on::text AS next_due_on FROM stockchief_runtime.agent_supplier_forecast_rules WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,rule.id])).rows[0];
   if(!locked?.enabled||locked.revision!==rule.revision||locked.next_due_on>clock.calendarDate)return;
   const ctx={workspaceId,actorId:locked.authorized_by},s=locked.scope,present=(await c.query("SELECT 1 FROM supplier_communications WHERE workspace_id=$1 AND idempotency_key=$2",[workspaceId,'supplier-forecast:'+s.supplierId+':'+monday(clock.calendarDate)])).rowCount;
   if(!present){
    const snapshot=await source.snapshot(c,ctx,{supplierId:s.supplierId,connectorId:s.connectorId,skuIds:s.skuIds});
    if(snapshot.today!==clock.calendarDate)throw new ValidationError('The business date changed while preparing this forecast. StockChief will prepare it again before sending.');
    if(hash(scope(snapshot))!==locked.scope_hash)throw new ValidationError('The supplier, selected products, units or sending mailbox changed. Review the weekly sharing scope.');
    const id=newId('forecast'),requestKey='weekly:'+locked.id+':'+monday(clock.calendarDate)+':'+locked.revision;
    await c.query(`INSERT INTO stockchief_runtime.agent_supplier_forecast_reports(id,workspace_id,supplier_id,connector_id,prepared_by,request_key,input_hash,snapshot,source_fingerprint,week_start) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,workspaceId,s.supplierId,s.connectorId,ctx.actorId,requestKey,hash(s),JSON.stringify(snapshot),snapshot.sourceFingerprint,monday(clock.calendarDate)]);
    await queue(c,ctx,await report(c,workspaceId,id),{kind,recordId:id,actorId:ctx.actorId,sourceFingerprint:snapshot.sourceFingerprint,automatic:true,manualApproval:false,ruleId:locked.id,ruleRevision:locked.revision});
   }
   let next=locked.next_due_on;while(next<=clock.calendarDate)next=addDays(next,7);
   await c.query('UPDATE stockchief_runtime.agent_supplier_forecast_rules SET next_due_on=$3,problem=NULL,retry_after=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2',[workspaceId,locked.id,next]);
   return present?'skipped':'queued';
  },{isolation:'SERIALIZABLE',retrySafe:true});
  if(outcome==='queued')queued++;else if(outcome==='skipped')skipped++;
 }catch(error){
  if(!['validation_error','authorization_error','entitlement_required','agent_plan_required'].includes(error.code))throw error;
  held++;await db.query("UPDATE stockchief_runtime.agent_supplier_forecast_rules SET problem=$3,retry_after=now()+interval '15 minutes',updated_at=now() WHERE workspace_id=$1 AND id=$2",[workspaceId,rule.id,String(error.message).slice(0,500)]);
 }}
 return {queued,held,skipped};
}
async function page(db,ctx,{id=null,q=''}={}){
 await source.owner(db,ctx);const account=await policy.accountState(db,ctx.workspaceId),locked=!policy.usesAgentTerms(account)||!policy.permits(account.plan,36,'draft'),query=String(q).trim().slice(0,120);
 const suppliers=(await db.query("SELECT id,name,email FROM suppliers WHERE workspace_id=$1 AND status='active' AND ($2='' OR name ILIKE '%'||$2||'%') ORDER BY name,id LIMIT 51",[ctx.workspaceId,query])).rows;
 const rules=(await db.query('SELECT r.*,r.next_due_on::text AS next_due_on,s.name FROM stockchief_runtime.agent_supplier_forecast_rules r JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id WHERE r.workspace_id=$1 ORDER BY r.updated_at DESC,r.id LIMIT 100',[ctx.workspaceId])).rows;
 const saved=id&&!locked?await report(db,ctx.workspaceId,id):null,message=saved?.communication_id?await require('../connections/postgres-outbound-mail').get(db,ctx.workspaceId,'supplier',saved.communication_id):null;
 return {locked,suppliers:suppliers.slice(0,50),moreSuppliers:suppliers.length>50,q:query,mailboxes:await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId),rules,canSchedule:policy.permits(account.plan,36,'automatic'),shadow:account.shadow,saved,message,words:saved?compose(saved.snapshot):null,today:await require('../lib/business-time').today(db,ctx.workspaceId),requestKey:newId('forecast-preview')};
}
async function resolveCodes(db,workspaceId,value){
 const codes=String(value||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
 if(!codes.length||codes.length>250||new Set(codes).size!==codes.length)throw new ValidationError('Enter one to 250 distinct SKU codes, one per line.');
 const rows=(await db.query('SELECT id FROM skus WHERE workspace_id=$1 AND code=ANY($2::text[]) AND is_active=1 ORDER BY id',[workspaceId,codes])).rows;
 if(rows.length!==codes.length)throw new ValidationError('Use exact active SKU codes from this inventory, one per line.');return rows.map(r=>r.id);
}
module.exports={preview,report,send,authority,configure,run,compose,scope,monday,page,resolveCodes,definition:{id:36,key:'supplier-forecasts',label:'Share selected stock and 12-week forecasts with a supplier',readPage:async()=>({summary:'Choose exact products and a supplier to preview the stock and demand estimate before sharing. Growth requires approval for each email; Pro and Custom can send weekly within an owner-authorized scope.',rows:[{Action:'Prepare a supplier forecast or manage weekly sharing',link:'/autopilot/supplier-forecasts'}],more:false})}};
