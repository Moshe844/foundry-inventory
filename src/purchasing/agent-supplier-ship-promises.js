'use strict';

const {ValidationError,NotFoundError}=require('../domain/errors');
const {newId}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const policy=require('../commercial/agent-plan');
const {contact}=require('./agent-supplier-delivery-chases');
const rules='stockchief_runtime.agent_supplier_confirmation_rules';
const promises='stockchief_runtime.agent_supplier_ship_promises';
const kind='supplier.record-ship-promise.v1';
const path='/autopilot/supplier-confirmations';
const phase='supplier_confirmation_due';

async function owner(db,ctx){
  await require('./supplier-email-terms-source').owner(db,ctx);
  await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
}

async function source(db,workspaceId,id,{lock=false}={}){
  const result=(await db.query(`SELECT r.id,r.expected_date::text,r.ship_date::text,r.availability_generation,r.fingerprint,r.created_at,
    l.recipient,l.expires_at,p.id AS purchase_order_id,p.po_number,p.supplier_id,p.status,p.expected_date AS arrival_date,
    s.name AS supplier_name,s.email
    FROM stockchief_runtime.supplier_link_submissions r JOIN stockchief_runtime.supplier_order_links l
      ON l.workspace_id=r.workspace_id AND l.token_hash=r.token_hash
    JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id
    JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id AND s.status='active'
    WHERE r.workspace_id=$1 AND r.id=$2 AND r.kind='confirm' AND r.ship_date IS NOT NULL AND p.delivery_kind='WAREHOUSE'
      ${lock?'FOR UPDATE OF p':''}`,[workspaceId,id])).rows[0];
  if(!result)throw new NotFoundError('Choose an original supplier confirmation with a ship date.');
  const expected=require('./supplier-order-link').responseFingerprint('confirm',result.expected_date,result.ship_date,result.availability_generation);
  if(result.fingerprint!==expected||result.recipient!==String(result.email||'').toLowerCase()||new Date(result.expires_at)<=new Date(result.created_at)||
    !['APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED'].includes(result.status))
    throw new ValidationError('The supplier, signed response or purchase changed. Review the current original evidence.');
  const newest=(await db.query(`SELECT r.id FROM stockchief_runtime.supplier_link_submissions r
    JOIN stockchief_runtime.supplier_order_links l ON l.workspace_id=r.workspace_id AND l.token_hash=r.token_hash
    WHERE r.workspace_id=$1 AND l.purchase_order_id=$2 AND r.kind='confirm' AND r.ship_date IS NOT NULL
      AND l.recipient=$3 AND l.expires_at>r.created_at ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,
  [workspaceId,result.purchase_order_id,result.recipient])).rows[0];
  if(newest?.id!==id)throw new ValidationError('A newer supplier ship-date confirmation is available. Review the latest original response.');
  const fingerprint=hash({id,order:result.purchase_order_id,supplier:result.supplier_id,recipient:result.recipient,
    date:result.ship_date,arrival:result.arrival_date,proof:result.fingerprint,receivedAt:new Date(result.created_at).toISOString()});
  return {...result,reviewFingerprint:fingerprint};
}

async function example(db,ctx,id,supplierId,delivery){
  const original=(await db.query(`SELECT p.source_id,p.ship_date::text,p.reported_at FROM ${promises} p
    JOIN stockchief_runtime.supplier_link_submissions r ON r.workspace_id=p.workspace_id AND r.id=p.source_id
    JOIN stockchief_runtime.supplier_order_links l ON l.workspace_id=r.workspace_id AND l.token_hash=r.token_hash
    WHERE p.workspace_id=$1 AND p.source_id=$2 AND p.supplier_id=$3 AND p.actor_id=$4 AND NOT p.automatic
      AND l.recipient=lower($5) AND p.training_connector_id=$6 AND p.training_mailbox_account=$7
      AND EXISTS(SELECT 1 FROM supplier_communications m
        WHERE m.workspace_id=p.workspace_id AND m.supplier_id=p.supplier_id AND m.purchase_order_id=p.purchase_order_id
          AND m.connector_id=$6 AND lower(m.recipient)=lower($5) AND m.status='SENT' AND m.external_message_id IS NOT NULL
          AND m.sent_at::timestamptz<=p.reported_at)`,
  [ctx.workspaceId,id,supplierId,ctx.actorId,delivery.supplier.email,delivery.mailbox.id,delivery.mailbox.provider_account_id])).rows[0];
  if(!original)throw new ValidationError('On Growth, first record a matching supplier confirmation from a purchase sent through this mailbox, then approve it as the example.');
  return original;
}

async function activeRule(db,workspaceId,supplierId){
  return (await db.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 AND supplier_id=$2 AND enabled`,[workspaceId,supplierId])).rows[0]||null;
}

async function assertRule(db,workspaceId,rule){
  const ctx={workspaceId,actorId:rule.authorized_by};
  await owner(db,ctx);
  const account=await policy.accountState(db,workspaceId);
  const delivery=await contact(db,workspaceId,rule.supplier_id,rule.connector_id);
  if(!delivery.ready||delivery.supplier.email!==rule.recipient||delivery.mailbox.provider_account_id!==rule.mailbox_account)
    throw new ValidationError('The supplier address or mailbox account changed. Review the confirmation rule again.');
  if(account.plan==='growth')await example(db,ctx,rule.example_source_id,rule.supplier_id,delivery);
  await policy.requireWorkspaceJob(db,workspaceId,29,'automatic',{trained:Boolean(rule.example_source_id)});
  const stop=await policy.stopped(db,workspaceId,account,'communication.send_email',true,{recipientKind:'supplier',followUpPhase:phase});
  if(stop||!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)
    throw new ValidationError(stop||'Routine supplier confirmations are paused.');
  return {ctx,delivery};
}

async function sendAuthority(db,workspaceId,scope,order){
  const rule=(await db.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 AND id=$2 AND enabled`,[workspaceId,scope.ruleId])).rows[0];
  if(!rule||rule.revision!==scope.ruleRevision||rule.supplier_id!==order.supplier_id||rule.connector_id!==scope.connectorId||
    rule.recipient!==scope.recipientEmail||order.delivery_kind!=='WAREHOUSE'||!order.ordered_at||!['ORDERED','PARTIALLY_RECEIVED'].includes(order.status))
    throw new ValidationError('The supplier, mailbox or confirmation authority changed. Review this exact order.');
  const {delivery}=await assertRule(db,workspaceId,rule);
  return {delivery,options:{maximum:rule.maximum_messages,intervalHours:rule.interval_hours}};
}

async function record(db,workspaceId,id,{ctx=null,expectedFingerprint=null}={}){
  return db.transaction(async tx=>{
    if(ctx)await owner(tx,ctx);
    await policy.requireWorkspaceJob(tx,workspaceId,29,'draft');
    const prior=(await tx.query(`SELECT * FROM ${promises} WHERE workspace_id=$1 AND source_id=$2`,[workspaceId,id])).rows[0];
    if(prior)return {purchaseOrderId:prior.purchase_order_id,replayed:true};
    const current=await source(tx,workspaceId,id,{lock:true});
    if(ctx&&expectedFingerprint!==current.reviewFingerprint)throw new ValidationError('Reload the original supplier confirmation before recording its ship date.');
    const rule=ctx?null:await activeRule(tx,workspaceId,current.supplier_id);
    let actor=ctx,training=null;
    if(!ctx){
      if(!rule)throw new ValidationError('Review and record this exact original ship date, or authorize a routine for this supplier.');
      actor=(await assertRule(tx,workspaceId,rule)).ctx;
      const today=await require('../lib/business-time').today(tx,workspaceId);
      const end=require('../accounting/customer-money').addDays(today,rule.maximum_ship_days);
      if(current.ship_date<today||current.ship_date>end||current.arrival_date&&current.ship_date>current.arrival_date)
        throw new ValidationError('Review the ship date against the current delivery promise and the dates you authorized.');
    }else{
      const senders=(await tx.query(`SELECT DISTINCT m.connector_id,b.provider_account_id FROM supplier_communications m
        JOIN workspace_connectors b ON b.workspace_id=m.workspace_id AND b.id=m.connector_id
        WHERE m.workspace_id=$1 AND m.purchase_order_id=$2 AND m.supplier_id=$3 AND lower(m.recipient)=$4
          AND m.status='SENT' AND m.external_message_id IS NOT NULL AND m.sent_at::timestamptz<=$5::timestamptz
          AND b.status='connected' AND b.paused_at IS NULL AND b.provider_account_id IS NOT NULL LIMIT 2`,
      [workspaceId,current.purchase_order_id,current.supplier_id,current.recipient,current.created_at])).rows;
      if(senders.length===1)training=senders[0];
    }
    await require('../commercial/storage-capacity').reserve(tx,workspaceId,'supplier-ship-date:'+id,4096,{finished:true});
    const inserted=await tx.query(`INSERT INTO ${promises}(source_id,workspace_id,purchase_order_id,supplier_id,actor_id,ship_date,
      reported_at,source_fingerprint,automatic,training_connector_id,training_mailbox_account)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(source_id) DO NOTHING RETURNING source_id`,
    [id,workspaceId,current.purchase_order_id,current.supplier_id,actor.actorId,current.ship_date,current.created_at,current.reviewFingerprint,Boolean(rule),
      training?.connector_id||null,training?.provider_account_id||null]);
    if(!inserted.rowCount)return {purchaseOrderId:current.purchase_order_id,replayed:true};
    await require('../operations/postgres-security-audit').record(tx,actor,{action:'Original supplier ship date recorded',reference:current.po_number,
      after:{sourceId:id,shipDate:current.ship_date,arrivalDate:current.arrival_date,automatic:Boolean(rule)}});
    return {purchaseOrderId:current.purchase_order_id,shipDate:current.ship_date,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function configure(db,ctx,input){
  return db.transaction(async tx=>{
    await owner(tx,ctx);
    const prior=input.id?(await tx.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,input.id])).rows[0]:null;
    if(input.id&&(!prior||prior.revision!==Number(input.revision)))throw new ValidationError('Reload this supplier confirmation rule before changing it.');
    if(input.stop==='yes'){
      if(!prior)throw new ValidationError('Choose the supplier confirmation rule to stop.');
      await tx.query(`UPDATE ${rules} SET enabled=false,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,prior.id]);
      return {id:prior.id,stopped:true};
    }
    await policy.requireWorkspaceJob(tx,ctx.workspaceId,29,'draft');
    const supplierId=prior?.supplier_id||input.supplierId;
    if(!supplierId||input.supplierId&&input.supplierId!==supplierId||input.confirmed!=='yes')throw new ValidationError('Confirm the exact supplier and confirmation limits.');
    const maximum=Number(input.maximumMessages),interval=Number(input.intervalHours),days=Number(input.maximumShipDays);
    if(![maximum,interval,days].every(Number.isSafeInteger)||maximum<1||maximum>5||interval<24||interval>720||
      input.maximumShipDays===''||days<0||days>365)throw new ValidationError('Enter the reminder count, minimum interval and maximum ship-date horizon.');
    const delivery=await contact(tx,ctx.workspaceId,supplierId,input.connectorId);
    if(!delivery.ready||delivery.supplier.email!==input.expectedRecipient)throw new ValidationError(delivery.reason||'Review the current supplier address.');
    const account=await policy.accountState(tx,ctx.workspaceId);
    const proof=account.plan==='growth'?await example(tx,ctx,input.exampleId||prior?.example_source_id,supplierId,delivery):null;
    await policy.requireWorkspaceJob(tx,ctx.workspaceId,29,'automatic',{trained:Boolean(proof)});
    await require('../manager/postgres-operating-instructions').checkRuleLimit(tx,ctx,[],prior?.enabled?0:1);
    const id=prior?.id||newId('supplier_confirm'),exampleId=proof?.source_id||prior?.example_source_id||null;
    const values=[ctx.workspaceId,id,delivery.mailbox.id,ctx.actorId,delivery.supplier.email,delivery.mailbox.provider_account_id,maximum,interval,days,exampleId];
    if(prior)await tx.query(`UPDATE ${rules} SET connector_id=$3,authorized_by=$4,recipient=$5,mailbox_account=$6,
      maximum_messages=$7,interval_hours=$8,maximum_ship_days=$9,example_source_id=$10,enabled=true,revision=revision+1,updated_at=now()
      WHERE workspace_id=$1 AND id=$2`,values);
    else {
      await require('../commercial/storage-capacity').reserve(tx,ctx.workspaceId,'supplier-confirmation-rule:'+id,4096,{finished:true});
      const created=await tx.query(`INSERT INTO ${rules}(workspace_id,id,connector_id,authorized_by,recipient,mailbox_account,
        maximum_messages,interval_hours,maximum_ship_days,example_source_id,supplier_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(workspace_id,supplier_id) DO NOTHING`,[...values,supplierId]);
      if(!created.rowCount)throw new ValidationError('Open the saved confirmation rule for this supplier.');
    }
    await require('../operations/postgres-security-audit').record(tx,ctx,{action:'Supplier confirmation routine authorized',reference:delivery.supplier.name,
      after:{id,maximum,interval,days,exampleId,connectorId:delivery.mailbox.id}});
    return {id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function enqueue(client,workspaceId,id){
  const account=await policy.accountState(client,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,29,'draft'))return;
  return require('../operations/postgres-job-queue').enqueue({query:(sql,args)=>client.query(sql,args),transaction:fn=>fn(client)},
    {workspaceId,kind,idempotencyKey:'supplier-ship-date:'+id,payload:{sourceId:id},priority:55,maxAttempts:3});
}

async function work(db,workspaceId,id){
  try{return await record(db,workspaceId,id);}
  catch(error){if(![400,402,403,404,422].includes(error.status))throw error;return {held:true,reason:error.message};}
}

async function recorded(db,workspaceId,orderId){
  return (await db.query(`SELECT source_id,ship_date::text,automatic FROM ${promises} WHERE workspace_id=$1 AND purchase_order_id=$2
    ORDER BY reported_at DESC,source_id DESC`,[workspaceId,orderId])).rows;
}

async function review(db,ctx,id){
  await owner(db,ctx);
  await policy.requireWorkspaceJob(db,ctx.workspaceId,29,'draft');
  const existing=(await db.query(`SELECT purchase_order_id FROM ${promises} WHERE workspace_id=$1 AND source_id=$2`,[ctx.workspaceId,id])).rows[0];
  return existing?{purchase_order_id:existing.purchase_order_id,replayed:true}:source(db,ctx.workspaceId,id);
}

async function page(db,ctx,{id=null,supplierId=null,supplierName=null,sourceId=null,page=1}={}){
  await owner(db,ctx);
  const account=await policy.accountState(db,ctx.workspaceId);
  const allowed=policy.usesAgentTerms(account)&&policy.permits(account.plan,29,'draft');
  page=Number(page);
  if(!Number.isSafeInteger(page)||page<1||page>1000000)throw new ValidationError('Choose a valid page of supplier confirmation rules.');
  const listSql=`SELECT r.*,s.name AS supplier_name,b.display_name AS mailbox_name FROM ${rules} r
    JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id
    JOIN workspace_connectors b ON b.workspace_id=r.workspace_id AND b.id=r.connector_id WHERE r.workspace_id=$1`;
  const list=(await db.query(listSql+' ORDER BY s.name,r.id LIMIT 101 OFFSET $2',[ctx.workspaceId,(page-1)*100])).rows;
  let selected=id?(await db.query(listSql+' AND r.id=$2',[ctx.workspaceId,id])).rows[0]:null;
  if(id&&!selected)throw new NotFoundError('That supplier confirmation rule is unavailable.');
  const chosenSource=allowed&&sourceId?(await db.query(`SELECT supplier_id FROM ${promises} WHERE workspace_id=$1 AND source_id=$2`,
    [ctx.workspaceId,sourceId])).rows[0]:null;
  const chosenId=selected?.supplier_id||chosenSource?.supplier_id||supplierId;
  let supplier=null,problem=null;
  if(allowed&&(chosenId||supplierName)){
    const input=String(chosenId||supplierName).trim();
    const matches=input.length<=240?(await db.query(`SELECT id,name,email FROM suppliers WHERE workspace_id=$1 AND status='active'
      AND ${chosenId?'id=$2':'lower(name)=lower($2)'} LIMIT 2`,[ctx.workspaceId,input])).rows:[];
    if(matches.length===1)supplier=matches[0];
    else problem='Choose one active supplier by its exact name.';
  }
  if(supplier&&!selected)selected=(await db.query(listSql+' AND r.supplier_id=$2',[ctx.workspaceId,supplier.id])).rows[0]||null;
  const examples=allowed&&account.plan==='growth'&&supplier?(await db.query(`SELECT s.source_id,s.ship_date::text,p.po_number,b.display_name
    FROM ${promises} s JOIN purchase_orders p ON p.workspace_id=s.workspace_id AND p.id=s.purchase_order_id
    JOIN workspace_connectors b ON b.workspace_id=s.workspace_id AND b.id=s.training_connector_id
    WHERE s.workspace_id=$1 AND s.supplier_id=$2 AND s.actor_id=$3 AND NOT s.automatic AND s.training_mailbox_account=b.provider_account_id
    ORDER BY s.reported_at DESC,s.source_id LIMIT 100`,[ctx.workspaceId,supplier.id,ctx.actorId])).rows:[];
  const mailboxes=allowed?await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId):[];
  return {allowed,plan:account.plan,shadow:account.shadow,supplier,selected,problem,examples,mailboxes,path,
    exampleId:sourceId||selected?.example_source_id||null,rules:list.slice(0,100),more:list.length>100,pageNumber:page};
}

const definition={id:29,key:'supplier-confirmations',label:'Request supplier confirmations and record ship dates',readPage:async()=>({
  summary:'Request confirmations within the exact supplier and mailbox rule. Record the original ship date separately from the expected warehouse arrival.',
  rows:[{Action:'Review supplier confirmation rules',link:path}],more:false})};

module.exports={kind,path,phase,source,record,recorded,review,page,definition,configure,activeRule,assertRule,sendAuthority,enqueue,work};
