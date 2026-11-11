'use strict';

const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const {newId}=require('../lib/util');
const table='stockchief_runtime.agent_supplier_delivery_chase_rules';
const path='/autopilot/supplier-delivery-chases';
const phase='supplier_delivery_late';

async function owner(db,ctx,{lock=false}={}){
  const member=await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId]);
  if(!member.rowCount)throw new AuthorizationError('Only the inventory owner can authorize late-delivery messages.');
  await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
}

async function contact(db,workspaceId,supplierId,connectorId){
  const supplier=(await db.query(`SELECT id,name,email,contact_name FROM suppliers
    WHERE workspace_id=$1 AND id=$2 AND status='active'`,[workspaceId,supplierId])).rows[0];
  if(!supplier||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supplier.email||''))
    return {ready:false,reason:'Set the exact email for this active supplier before preparing a late-delivery message.'};
  const mailbox=await require('../shipping/agent-shipping-notices').mailbox(db,workspaceId,connectorId);
  if(!mailbox?.provider_account_id)return {ready:false,reason:'Choose an active sending mailbox with a verified account identity.'};
  return {ready:true,supplier,mailbox};
}

async function activeRule(db,workspaceId,supplierId){
  return (await db.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND supplier_id=$2 AND enabled`,[workspaceId,supplierId])).rows[0]||null;
}

async function authority(db,workspaceId,scope,order){
  const rule=(await db.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND id=$2 AND enabled`,[workspaceId,scope.ruleId])).rows[0];
  if(!rule||rule.revision!==scope.ruleRevision||rule.supplier_id!==order.supplier_id||order.delivery_kind!=='WAREHOUSE'||
    !['ORDERED','PARTIALLY_RECEIVED'].includes(order.status)||!order.ordered_at||
    rule.connector_id!==scope.connectorId||rule.recipient!==scope.recipientEmail)
    throw new ValidationError('The current supplier, mailbox or late-delivery authority differs from the saved rule.');
  await owner(db,{workspaceId,actorId:rule.authorized_by});
  const delivery=await contact(db,workspaceId,rule.supplier_id,rule.connector_id);
  if(!delivery.ready||delivery.supplier.email!==rule.recipient||delivery.mailbox.provider_account_id!==rule.mailbox_account)
    throw new ValidationError('The authorized supplier email or sending mailbox changed. Review the rule before sending.');
  return {rule,delivery,options:{maximum:rule.maximum_messages,intervalHours:rule.interval_hours}};
}

async function configure(db,ctx,input){
  return db.transaction(async tx=>{
    await owner(tx,ctx,{lock:true});
    const previous=input.id?(await tx.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,input.id])).rows[0]:null;
    if(input.id&&!previous)throw new NotFoundError('That supplier follow-up rule is unavailable.');
    if(previous&&previous.revision!==Number(input.revision))throw new ValidationError('Reload this supplier rule before changing it.');
    if(input.stop==='yes'){
      if(!previous)throw new ValidationError('Choose the supplier follow-up rule to stop.');
      await tx.query(`UPDATE ${table} SET enabled=false,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,previous.id]);
      return {id:previous.id,stopped:true};
    }
    await policy.requireWorkspaceJob(tx,ctx.workspaceId,30,'automatic');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm the exact supplier, mailbox and reminder limit.');
    const supplierId=previous?.supplier_id||String(input.supplierId||'');
    if(!supplierId)throw new ValidationError('Choose the exact supplier before authorizing reminders.');
    if(input.supplierId&&input.supplierId!==supplierId)throw new ValidationError('This saved rule keeps its original supplier.');
    const maximum=Number(input.maximumMessages),interval=Number(input.intervalHours);
    if(!Number.isSafeInteger(maximum)||maximum<1||maximum>5||!Number.isSafeInteger(interval)||interval<24||interval>720)
      throw new ValidationError('Choose 1 to 5 reminders per order and at least 24 hours between messages, up to 720 hours.');
    const delivery=await contact(tx,ctx.workspaceId,supplierId,input.connectorId);
    if(!delivery.ready)throw new ValidationError(delivery.reason);
    if(input.expectedRecipient!==delivery.supplier.email)throw new ValidationError('The supplier email changed. Review its current address before authorizing reminders.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(tx,ctx,[],previous?.enabled?0:1);
    const id=previous?.id||newId('supplier_chase');
    const values=[ctx.workspaceId,id,delivery.mailbox.id,ctx.actorId,delivery.supplier.email,delivery.mailbox.provider_account_id,maximum,interval];
    if(previous)await tx.query(`UPDATE ${table} SET connector_id=$3,authorized_by=$4,recipient=$5,mailbox_account=$6,
      maximum_messages=$7,interval_hours=$8,enabled=true,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,values);
    else {
      await require('../commercial/storage-capacity').reserve(tx,ctx.workspaceId,'supplier-chase:'+id,4096,{finished:true});
      const created=await tx.query(`INSERT INTO ${table}(workspace_id,id,connector_id,authorized_by,recipient,mailbox_account,maximum_messages,interval_hours,supplier_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_id,supplier_id) DO NOTHING`,[...values,supplierId]);
      if(!created.rowCount)throw new ValidationError('Open the saved reminder rule for this supplier to change its limits.');
    }
    await require('../operations/postgres-security-audit').record(tx,ctx,{action:'Late supplier delivery follow-ups authorized',reference:delivery.supplier.name,
      after:{id,supplierId,connectorId:delivery.mailbox.id,recipient:delivery.supplier.email,maximum,interval}});
    return {id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function page(db,ctx,{id=null,supplierId=null,supplierName=null,page=1}={}){
  await owner(db,ctx);
  const state=await policy.accountState(db,ctx.workspaceId);
  const allowed=policy.usesAgentTerms(state)&&policy.permits(state.plan,30,'draft');
  const listSql=`SELECT r.*,s.name AS supplier_name,b.display_name AS mailbox_name FROM ${table} r
    JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id
    JOIN workspace_connectors b ON b.workspace_id=r.workspace_id AND b.id=r.connector_id
    WHERE r.workspace_id=$1`;
  page=Number(page);
  if(!Number.isSafeInteger(page)||page<1||page>1000000)throw new ValidationError('Choose a valid page of supplier reminder rules.');
  const rules=(await db.query(listSql+' ORDER BY s.name,r.id LIMIT 101 OFFSET $2',[ctx.workspaceId,(page-1)*100])).rows;
  let selected=id?(await db.query(listSql+' AND r.id=$2',[ctx.workspaceId,id])).rows[0]:null;
  if(id&&!selected)throw new NotFoundError('That supplier follow-up rule is unavailable.');
  const chosenId=selected?.supplier_id||supplierId;
  let supplier=null,supplierProblem=null;
  if(allowed&&(chosenId||supplierName)){
    const input=String(chosenId||supplierName).trim();
    const matches=input.length<=240?(await db.query(`SELECT id,name,email FROM suppliers WHERE workspace_id=$1 AND status='active'
      AND ${chosenId?'id=$2':'lower(name)=lower($2)'} LIMIT 2`,[ctx.workspaceId,input])).rows:[];
    if(matches.length===1)supplier=matches[0];
    else supplierProblem='Match the exact name to one active supplier. You can also open the settings from that supplier’s purchase order.';
  }
  if(supplier&&!selected)selected=(await db.query(listSql+' AND r.supplier_id=$2',[ctx.workspaceId,supplier.id])).rows[0]||null;
  const mailboxes=allowed?await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId):[];
  return {allowed,shadow:state.shadow,selected,supplier,supplierProblem,rules:rules.slice(0,100),more:rules.length>100,pageNumber:page,mailboxes,path};
}

const definition={id:30,key:'late-supplier-deliveries',label:'Follow up on late supplier deliveries',readPage:async()=>({
  summary:'Authorize reminders for an exact supplier and sending mailbox. StockChief checks the current promised date, actual receipts and supplier replies before sending.',
  rows:[{Action:'Review supplier reminder rules',link:path}],more:false})};

module.exports={path,phase,configure,activeRule,authority,contact,page,definition};
