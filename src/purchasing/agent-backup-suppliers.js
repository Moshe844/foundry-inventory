'use strict';

const {AuthorizationError,NotFoundError,ValidationError}=require('../domain/errors');
const {newId}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const exact=require('../domain/exact-quantity');
const evidence=require('./backup-supplier-evidence');
const {pack}=require('./agent-reorder-workflows');
const storage=require('../commercial/storage-capacity');

const action='purchasing.switch_backup_supplier';
const rules='stockchief_runtime.agent_backup_supplier_rules';
const runs='stockchief_runtime.agent_backup_supplier_runs';
const notices='stockchief_runtime.agent_backup_supplier_notices';

async function owner(db,ctx){
  const row=await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL) FOR SHARE OF u,w`,
  [ctx.workspaceId,ctx.actorId]);
  if(!row.rowCount)throw new AuthorizationError('Only the current inventory owner can change a backup supplier rule.');
  await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
}

async function profile(db,ctx,skuId,locationId){
  const row=(await db.query(`SELECT s.id AS sku_id,s.code,i.quantity_precision,i.quantity_increment,
    i.unit_label,i.secondary_unit_label,l.id AS location_id,l.name AS location_name
    FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
    JOIN locations l ON l.workspace_id=s.workspace_id AND l.id=$3 AND l.is_active=1
    WHERE s.workspace_id=$1 AND s.id=$2 AND s.is_active=1 AND i.is_active=1 FOR SHARE OF s,i,l`,
  [ctx.workspaceId,skuId,locationId])).rows[0];
  if(!row)throw new ValidationError('Choose an active product and receiving location in this inventory.');
  return row;
}

async function offer(db,ctx,skuId,supplierId){
  const row=(await db.query(`SELECT si.id,si.supplier_sku,si.purchase_unit,si.units_per_purchase_unit::text,si.minimum_order_quantity::text,
    si.order_multiple::text,si.last_unit_cost::text,si.lead_time_days,s.id supplier_id,s.name,s.currency,s.payment_terms,
    s.minimum_order_amount::text,s.freight_terms_currency,s.free_freight_threshold_minor,s.ordinary_freight_minor
    FROM supplier_items si JOIN suppliers s ON s.id=si.supplier_id AND s.workspace_id=si.workspace_id
    WHERE si.workspace_id=$1 AND si.sku_id=$2 AND si.supplier_id=$3 AND si.is_active=1 AND s.status='active' FOR SHARE OF si,s`,
  [ctx.workspaceId,skuId,supplierId])).rows[0];
  if(!row)throw new ValidationError('Choose an active supplier already linked to this exact product.');
  return row;
}

function offerHash(offer){
  const {name,...terms}=offer;
  return hash(terms);
}

async function preference(db,ctx,skuId,locationId){
  return (await db.query(`SELECT id,preferred_supplier_id FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 FOR UPDATE`,
  [ctx.workspaceId,skuId,locationId])).rows[0]||null;
}

async function getRule(db,ctx,id,{lock=false}={}){
  const rule=(await db.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[ctx.workspaceId,id])).rows[0];
  if(!rule)throw new NotFoundError('This backup supplier rule is unavailable.');
  return rule;
}

async function configure(db,ctx,input){
  return db.transaction(async tx=>{
    await owner(tx,ctx);
    const old=input.id?await getRule(tx,ctx,input.id,{lock:true}):null;
    if(input.stop==='yes'){
      if(!old||Number(input.revision)!==old.revision)throw new ValidationError('Reload this rule before stopping it.');
      await tx.query(`UPDATE ${rules} SET enabled=false,revision=revision+1,problem=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,old.id]);
      return {id:old.id,stopped:true};
    }
    await policy.requireWorkspaceJob(tx,ctx.workspaceId,95,'draft');
    if(input.confirmed!=='yes'||Number(input.revision)!==Number(old?.revision||0))throw new ValidationError('Confirm the current backup terms and exact supplier preference.');
    if(input.primarySupplierId===input.backupSupplierId)throw new ValidationError('Choose two different suppliers.');
    if(old&&(old.sku_id!==input.skuId||old.location_id!==input.locationId))throw new ValidationError('A saved rule keeps its original product and receiving location.');
    const days=Number(input.confirmationDays);
    if(!Number.isSafeInteger(days)||days<1||days>90)throw new ValidationError('Choose a confirmation window of 1 to 90 days.');
    const product=await profile(tx,ctx,input.skuId,input.locationId);
    const primary=await offer(tx,ctx,input.skuId,input.primarySupplierId);
    const backup=await offer(tx,ctx,input.skuId,input.backupSupplierId);
    const maximum=money.userToMinor(input.maximumGoods,backup.currency,{label:'Maximum backup goods value'});
    if(maximum<=0)throw new ValidationError('Enter a positive maximum backup goods value.');
    pack(backup,product.quantity_increment||1,product);
    const current=await preference(tx,ctx,input.skuId,input.locationId);
    const restore=Boolean(old&&input.restorePrimary==='yes'&&current?.preferred_supplier_id===old.backup_supplier_id&&primary.supplier_id===old.primary_supplier_id);
    if(current?.preferred_supplier_id&&current.preferred_supplier_id!==primary.supplier_id&&!restore)throw new ValidationError('The chosen primary supplier differs from the current reorder preference. Review and set the primary before arming the backup rule.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(tx,ctx,[],old?.enabled?0:1);
    const id=old?.id||newId('supplier_backup');
    await storage.reserve(tx,ctx.workspaceId,'backup-rule:'+id+':'+Number(old?.revision||0),8192,{finished:true});
    if(!current?.preferred_supplier_id||restore){
      if(current)await tx.query('UPDATE reorder_policies SET preferred_supplier_id=$3,updated_at=now()::text WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,current.id,primary.supplier_id]);
      else await tx.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,preferred_supplier_id,source,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'foundry',now()::text,now()::text)`,[newId('rp'),ctx.workspaceId,input.skuId,input.locationId,primary.supplier_id]);
    }
    const updated=[ctx.workspaceId,id,primary.supplier_id,backup.supplier_id,days,offerHash(backup),backup.currency,maximum,ctx.actorId];
    const sameScope=old&&old.primary_supplier_id===primary.supplier_id&&old.backup_supplier_id===backup.supplier_id&&
      old.backup_offer_hash===offerHash(backup)&&old.confirmation_days===days&&Number(old.maximum_goods_minor)===maximum&&old.authorized_by===ctx.actorId;
    if(old)await tx.query(`UPDATE ${rules} SET primary_supplier_id=$3,backup_supplier_id=$4,confirmation_days=$5,backup_offer_hash=$6,
      currency=$7,maximum_goods_minor=$8,authorized_by=$9,enabled=true,revision=revision+1,taught_run_id=$10,problem=NULL,
      next_check_at=now(),updated_at=now() WHERE workspace_id=$1 AND id=$2`,[...updated,sameScope?old.taught_run_id:null]);
    else await tx.query(`INSERT INTO ${rules}(workspace_id,id,primary_supplier_id,backup_supplier_id,confirmation_days,backup_offer_hash,currency,
      maximum_goods_minor,authorized_by,sku_id,location_id,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)`,
    [...updated,input.skuId,input.locationId]);
    await require('../operations/postgres-security-audit').record(tx,ctx,{action:'Backup supplier rule saved',reference:product.code,
      after:{ruleId:id,primary:primary.name,backup:backup.name,confirmationDays:days,maximum,currency:backup.currency}});
    return {id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function recordUnavailable(db,ctx,id,input){
  return db.transaction(async tx=>{
    await owner(tx,ctx);
    await policy.requireWorkspaceJob(tx,ctx.workspaceId,95,'draft');
    const rule=await getRule(tx,ctx,id,{lock:true});
    const goods=await profile(tx,ctx,rule.sku_id,rule.location_id);
    const source=String(input.evidence||'').trim();
    const through=String(input.validThrough||'');
    const today=await require('../lib/business-time').today(tx,ctx.workspaceId);
    if(input.confirmed!=='yes'||source.length<8||source.length>4000)throw new ValidationError('Record the supplier’s original availability statement and confirm the exact product and location.');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(through)||!Number.isFinite(Date.parse(through))||new Date(through).toISOString().slice(0,10)!==through||through<today){
      throw new ValidationError('Enter the last day this supplier statement is still current.');
    }
    const quantity=require('../domain/stock-quantity').validate(goods,input.referenceQuantity,{positive:true});
    const secondary=goods.secondary_unit_label?exact.canonical(input.secondaryQuantity,{label:'Independently checked measure'}):null;
    if(secondary!==null&&exact.safeNumber(secondary,{positive:true})<=0)throw new ValidationError('Enter the independently checked measure.');
    let line=null;
    if(input.purchaseLineId){
      line=(await tx.query(`SELECT l.id,p.id AS order_id FROM purchase_order_lines l JOIN purchase_orders p
        ON p.id=l.purchase_order_id AND p.workspace_id=l.workspace_id
        WHERE l.workspace_id=$1 AND l.id=$2 AND l.sku_id=$3 AND p.supplier_id=$4
          AND coalesce(l.destination_location_id,p.destination_location_id)=$5 FOR SHARE OF p,l`,
      [ctx.workspaceId,input.purchaseLineId,rule.sku_id,rule.primary_supplier_id,rule.location_id])).rows[0];
      if(!line)throw new ValidationError('The original purchase line belongs to a different product, location or supplier.');
    }
    const noticeId=newId('backup_notice');
    const fingerprint=hash([rule.sku_id,rule.location_id,rule.primary_supplier_id,source,through,quantity,secondary,line?.id||null]);
    const prior=(await tx.query(`SELECT id FROM ${notices} WHERE workspace_id=$1 AND source_fingerprint=$2`,[ctx.workspaceId,fingerprint])).rows[0];
    if(prior)return {id:prior.id,replayed:true};
    await storage.reserve(tx,ctx.workspaceId,'backup-notice:'+noticeId,Buffer.byteLength(source)+4096,{finished:true});
    await tx.query(`INSERT INTO ${notices}(id,workspace_id,sku_id,location_id,supplier_id,purchase_order_id,line_id,
      recorded_by,evidence,source_fingerprint,valid_through,reference_quantity,secondary_quantity)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [noticeId,ctx.workspaceId,rule.sku_id,rule.location_id,rule.primary_supplier_id,line?.order_id||null,line?.id||null,
      ctx.actorId,source,fingerprint,through,quantity,secondary]);
    return {id:noticeId};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function withdrawNotice(db,ctx,id){
  await owner(db,ctx);
  await db.query(`UPDATE ${notices} SET revoked_at=now() WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL`,[ctx.workspaceId,id]);
}

async function linkLines(db,order){
  const plan=await policy.accountState(db,order.workspace_id);
  if(!policy.usesAgentTerms(plan)||!policy.permits(plan.plan,95,'draft'))return [];
  return (await db.query(`SELECT l.id,l.sku_id,p.supplier_id,r.id AS rule_id,r.location_id,s.code,i.name,
    (l.quantity_units-l.quantity_received_units)::text AS remaining
    FROM purchase_order_lines l JOIN purchase_orders p ON p.id=l.purchase_order_id AND p.workspace_id=l.workspace_id
    JOIN skus s ON s.id=l.sku_id AND s.workspace_id=l.workspace_id JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
    JOIN ${rules} r ON r.workspace_id=l.workspace_id AND r.sku_id=l.sku_id
      AND r.location_id=coalesce(l.destination_location_id,p.destination_location_id) AND r.primary_supplier_id=p.supplier_id AND r.enabled
    WHERE l.workspace_id=$1 AND l.purchase_order_id=$2 AND l.quantity_units>l.quantity_received_units ORDER BY l.line_number,l.id`,
  [order.workspace_id,order.id])).rows;
}

async function supplierReply(db,token,input){
  return db.transaction(async tx=>{
    const order=await require('./supplier-order-link').lookup(tx,token,true);
    const line=(await linkLines(tx,order)).find(row=>row.id===input.lineId);
    if(!line)throw new ValidationError('Choose an outstanding product on this original order.');
    const through=String(input.validThrough||'');
    const today=await require('../lib/business-time').today(tx,order.workspace_id);
    const message=String(input.reason||'').trim();
    if(input.confirmed!=='yes'||message.length<4||message.length>1000||!/^\d{4}-\d{2}-\d{2}$/.test(through)||
      !Number.isFinite(Date.parse(through))||new Date(through).toISOString().slice(0,10)!==through||through<today){
      throw new ValidationError('Confirm the exact item and the date through which it is unavailable.');
    }
    const fingerprint=hash([order.token_hash,line.id,through,message]);
    const saved=(await tx.query(`SELECT id FROM ${notices} WHERE workspace_id=$1 AND source_fingerprint=$2`,[order.workspace_id,fingerprint])).rows[0];
    if(saved)return {id:saved.id,replayed:true};
    const id=newId('backup_notice');
    const replyId=newId('supplierreply');
    await storage.reserve(tx,order.workspace_id,'backup-supplier-reply:'+id,Buffer.byteLength(message)+8192,{finished:true});
    await tx.query(`INSERT INTO stockchief_runtime.supplier_link_submissions(id,workspace_id,token_hash,kind,fingerprint)
      VALUES($1,$2,$3,'unavailable',$4)`,[replyId,order.workspace_id,order.token_hash,fingerprint]);
    await tx.query(`INSERT INTO ${notices}(id,workspace_id,sku_id,location_id,supplier_id,purchase_order_id,line_id,supplier_reply_id,
      evidence,source_fingerprint,valid_through,reference_quantity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id,order.workspace_id,line.sku_id,line.location_id,line.supplier_id,order.id,line.id,replyId,message,fingerprint,through,line.remaining]);
    return {id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function previewWithin(db,ctx,rule){
  if(!rule.enabled)throw new ValidationError('This backup supplier rule is stopped.');
  const goods=await profile(db,ctx,rule.sku_id,rule.location_id);
  const backup=await offer(db,ctx,rule.sku_id,rule.backup_supplier_id);
  const trigger=await evidence.candidates(db,ctx.workspaceId,rule);
  const source=evidence.proofFor(rule,trigger);
  if(offerHash(backup)!==rule.backup_offer_hash||backup.currency!==rule.currency){
    throw new ValidationError('The saved backup supplier price, pack or terms changed. Check and authorize its current offer.');
  }
  const wanted=trigger.notice?.reference_quantity||trigger.remaining;
  const priced=pack(backup,wanted,goods);
  const measure=trigger.notice?.secondary_quantity;
  if(goods.secondary_unit_label&&!measure){
    throw new ValidationError('Record the exact independent measure for the backup supplier quote before switching this product.');
  }
  if(measure&&priced.quantity!==exact.canonical(wanted)){
    throw new ValidationError('The supplier pack changes the quantity. Record the checked measure for that exact pack quantity.');
  }
  const amount=measure?exact.costMinor(measure,priced.unitCostMinor):priced.totalMinor;
  if(amount>Number(rule.maximum_goods_minor))throw new ValidationError('The backup goods value exceeds the authorized maximum.');
  if(backup.minimum_order_amount!=null&&amount<money.toMinor(backup.minimum_order_amount,backup.currency)){
    throw new ValidationError('This quantity is below the backup supplier’s saved minimum order value. Review the exact combined purchase first.');
  }
  const terms={skuId:goods.sku_id,sku:goods.code,locationId:goods.location_id,location:goods.location_name,
    primarySupplierId:rule.primary_supplier_id,backupSupplierId:backup.supplier_id,backupName:backup.name,
    currency:backup.currency,amount,quantity:priced.quantity,purchaseUnits:priced.purchaseUnits,measure:measure||null,
    confirmationDays:rule.confirmation_days,offerHash:rule.backup_offer_hash};
  const triggerKey=evidence.triggerKey(trigger);
  return {trigger,triggerKey,terms,fingerprint:hash({source,terms})};
}

async function preview(db,ctx,id){
  await owner(db,ctx);
  await policy.requireWorkspaceJob(db,ctx.workspaceId,95,'draft');
  return previewWithin(db,ctx,await getRule(db,ctx,id));
}

async function execute(db,ctx,id,input={},options={}){
  const automatic=options.automatic===true;
  return db.transaction(async tx=>{
    await owner(tx,ctx);
    const account=await policy.requireWorkspaceJob(tx,ctx.workspaceId,95,'draft');
    const rule=await getRule(tx,ctx,id,{lock:true});
    const current=await preference(tx,ctx,rule.sku_id,rule.location_id);
    if(current?.preferred_supplier_id===rule.backup_supplier_id){
      const replay=(await tx.query(`SELECT id FROM ${runs} WHERE workspace_id=$1 AND rule_id=$2 ORDER BY completed_at DESC,id LIMIT 1`,[ctx.workspaceId,id])).rows[0];
      if(replay)return {id:replay.id,replayed:true};
    }
    if(current?.preferred_supplier_id!==rule.primary_supplier_id)throw new ValidationError('The current reorder supplier differs from this rule. Review the saved preference before switching.');
    const initial=await previewWithin(tx,ctx,rule);
    if(initial.trigger.purchaseOrderId){
      await tx.query('SELECT id FROM purchase_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,initial.trigger.purchaseOrderId]);
    }
    const latest=await previewWithin(tx,ctx,rule);
    if(initial.fingerprint!==latest.fingerprint)throw new ValidationError('The source changed before the supplier preference could be saved.');
    const stop=await policy.stopped(tx,ctx.workspaceId,account,action,automatic);
    if(stop)throw new ValidationError(stop);
    if(automatic){
      const mode=(await tx.query('SELECT mode FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId])).rows[0];
      if(mode?.mode!=='POLICY_AUTOMATED'||rule.authorized_by!==ctx.actorId)throw new ValidationError('Automatic switching needs current owner routine authority.');
      const example=rule.taught_run_id?(await tx.query(`SELECT facts FROM ${runs} WHERE workspace_id=$1 AND id=$2 AND rule_id=$3 AND mode='human' FOR SHARE`,[ctx.workspaceId,rule.taught_run_id,id])).rows[0]:null;
      const prior=example?.facts?.terms;
      const trained=prior?.offerHash===latest.terms.offerHash&&prior?.currency===latest.terms.currency&&prior?.confirmationDays===latest.terms.confirmationDays&&
        Number(prior.amount)>=latest.terms.amount&&example?.facts?.trigger?.kind===latest.trigger.kind;
      await policy.requireWorkspaceJob(tx,ctx.workspaceId,95,'automatic',{trained});
    }else if(input.confirmed!=='yes'||input.fingerprint!==latest.fingerprint){
      throw new ValidationError('Review the current source and confirm this exact supplier preference change.');
    }
    const replay=(await tx.query(`SELECT id FROM ${runs} WHERE workspace_id=$1 AND rule_id=$2 AND trigger_key=$3`,[ctx.workspaceId,id,latest.triggerKey])).rows[0];
    if(replay)return {id:replay.id,replayed:true};
    const runId=newId('backup_switch');
    await storage.reserve(tx,ctx.workspaceId,'backup-switch:'+runId,Buffer.byteLength(JSON.stringify(latest))+8192,{finished:true});
    await tx.query('UPDATE reorder_policies SET preferred_supplier_id=$3,updated_at=now()::text WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,current.id,rule.backup_supplier_id]);
    await tx.query(`INSERT INTO ${runs}(id,workspace_id,rule_id,purchase_order_id,actor_id,trigger_key,reason,source_fingerprint,facts,mode)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[runId,ctx.workspaceId,id,latest.trigger.purchaseOrderId,ctx.actorId,
      latest.triggerKey,latest.trigger.kind,latest.fingerprint,JSON.stringify(latest),automatic?'automatic':'human']);
    await tx.query(`UPDATE ${rules} SET problem=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);
    await require('../operations/postgres-security-audit').record(tx,ctx,{action:'Reorder preference switched to backup supplier',reference:latest.terms.sku,
      after:{ruleId:id,runId,reason:latest.trigger.kind,backup:latest.terms.backupName,automatic}});
    return {id:runId,supplierId:rule.backup_supplier_id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function teach(db,ctx,id,input){
  return db.transaction(async tx=>{
    await owner(tx,ctx);
    const account=await policy.requireWorkspaceJob(tx,ctx.workspaceId,95,'automatic',{trained:true});
    const rule=await getRule(tx,ctx,id,{lock:true});
    if(account.shadow||input.confirmed!=='yes'||Number(input.revision)!==rule.revision||!rule.enabled){
      throw new ValidationError('Confirm a completed individual backup supplier example after the watch period.');
    }
    const run=(await tx.query(`SELECT facts FROM ${runs} WHERE workspace_id=$1 AND id=$2 AND rule_id=$3 AND actor_id=$4 AND mode='human'`,
    [ctx.workspaceId,input.runId,id,ctx.actorId])).rows[0];
    const terms=run?.facts?.terms;
    if(terms?.offerHash!==rule.backup_offer_hash||terms?.confirmationDays!==rule.confirmation_days||
      terms?.primarySupplierId!==rule.primary_supplier_id||terms?.backupSupplierId!==rule.backup_supplier_id||
      terms?.skuId!==rule.sku_id||terms?.locationId!==rule.location_id){
      throw new ValidationError('The completed example must use the current product, site, suppliers, offer and confirmation window.');
    }
    await tx.query(`UPDATE ${rules} SET taught_run_id=$3,authorized_by=$4,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,id,input.runId,ctx.actorId]);
    return {id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function schedule(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,95,'automatic',{trained:true}))return {checked:0,switched:0};
  const due=(await db.query(`SELECT r.id,r.authorized_by FROM ${rules} r JOIN reorder_policies p ON p.workspace_id=r.workspace_id
    AND p.sku_id=r.sku_id AND p.location_id=r.location_id AND p.preferred_supplier_id=r.primary_supplier_id
    WHERE r.workspace_id=$1 AND r.enabled AND r.authorized_by IS NOT NULL AND r.next_check_at<=now()
    ORDER BY r.next_check_at,r.id LIMIT 40`,[workspaceId])).rows;
  let switched=0;
  for(const rule of due){
    let problem=null;
    try{
      const result=await execute(db,{workspaceId,actorId:rule.authorized_by},rule.id,{}, {automatic:true});
      if(!result.replayed)switched++;
    }catch(error){
      if(!['validation_error','forbidden','entitlement_required','not_found'].includes(error.code))throw error;
      if(!error.message.startsWith('The primary supplier has no current'))problem=String(error.message).slice(0,600);
    }
    await db.query(`UPDATE ${rules} SET problem=$3,next_check_at=now()+interval '15 minutes' WHERE workspace_id=$1 AND id=$2`,
    [workspaceId,rule.id,problem]);
  }
  return {checked:due.length,switched};
}

async function exactChoice(db,ctx,{skuCode,primaryName,backupName}){
  await owner(db,ctx);
  await policy.requireWorkspaceJob(db,ctx.workspaceId,95,'draft');
  const sku=(await db.query('SELECT id FROM skus WHERE workspace_id=$1 AND lower(code)=lower($2) AND is_active=1 LIMIT 2',
    [ctx.workspaceId,String(skuCode||'').trim()])).rows;
  if(sku.length!==1)throw new ValidationError('Enter an exact active product code.');
  async function supplier(value){
    const matched=(await db.query(`SELECT s.id FROM suppliers s JOIN supplier_items i ON i.workspace_id=s.workspace_id AND i.supplier_id=s.id
      WHERE s.workspace_id=$1 AND i.sku_id=$2 AND i.is_active=1 AND s.status='active' AND lower(s.name)=lower($3) LIMIT 2`,
    [ctx.workspaceId,sku[0].id,String(value||'').trim()])).rows;
    if(matched.length!==1)throw new ValidationError('Enter the exact name of a current supplier linked to this product.');
    return matched[0].id;
  }
  return {skuId:sku[0].id,primarySupplierId:await supplier(primaryName),backupSupplierId:await supplier(backupName)};
}

async function page(db,ctx,id=null,number=1){
  await owner(db,ctx);
  const state=await policy.accountState(db,ctx.workspaceId);
  const allowed=policy.usesAgentTerms(state)&&policy.permits(state.plan,95,'draft');
  number=Number(number);
  if(!Number.isSafeInteger(number)||number<1||number>1000000)throw new ValidationError('Choose a valid backup supplier page.');
  const rows=(await db.query(`SELECT r.id,r.revision,r.enabled,r.problem,k.code,l.name AS location,p.name AS primary_name,b.name AS backup_name
    FROM ${rules} r JOIN skus k ON k.id=r.sku_id AND k.workspace_id=r.workspace_id
    JOIN locations l ON l.id=r.location_id AND l.workspace_id=r.workspace_id
    JOIN suppliers p ON p.id=r.primary_supplier_id AND p.workspace_id=r.workspace_id
    JOIN suppliers b ON b.id=r.backup_supplier_id AND b.workspace_id=r.workspace_id
    WHERE r.workspace_id=$1 ORDER BY r.updated_at DESC,r.id LIMIT 51 OFFSET $2`,[ctx.workspaceId,(number-1)*50])).rows;
  const places=allowed?(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 ORDER BY name,id',[ctx.workspaceId])).rows:[];
  let detail=null;
  if(id){
    const rule=await getRule(db,ctx,id);
    const [product,primary,backup]=await Promise.all([profile(db,ctx,rule.sku_id,rule.location_id),offer(db,ctx,rule.sku_id,rule.primary_supplier_id),offer(db,ctx,rule.sku_id,rule.backup_supplier_id)]);
    const history=(await db.query(`SELECT id,reason,facts,mode,completed_at FROM ${runs} WHERE workspace_id=$1 AND rule_id=$2 ORDER BY completed_at DESC,id LIMIT 50`,[ctx.workspaceId,id])).rows;
    const activeNotices=(await db.query(`SELECT id,evidence,valid_through::text FROM ${notices} WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3
      AND supplier_id=$4 AND revoked_at IS NULL ORDER BY reported_at DESC,id LIMIT 50`,[ctx.workspaceId,rule.sku_id,rule.location_id,rule.primary_supplier_id])).rows;
    let check=null,problem=rule.problem;
    if(allowed&&rule.enabled){
      try{check=await previewWithin(db,ctx,rule);}catch(error){if(!(error instanceof ValidationError))throw error;problem=error.message;}
    }
    detail={rule,product,primary,backup,history,activeNotices,check,problem};
  }
  return {plan:state.plan,allowed,places,rows:rows.slice(0,50),more:rows.length>50,number,detail};
}

const definition={id:95,key:'backup-suppliers',label:'Switch to a confirmed backup supplier',async readPage(db,ctx,{page:number=1}={}){
  const view=await page(db,ctx,null,number);
  return {rows:view.rows.map(r=>({Product:r.code,Location:r.location,Primary:r.primary_name,Backup:r.backup_name,
    Status:r.problem||(r.enabled?'Enabled':'Stopped'),link:'/autopilot/backup-suppliers/'+r.id})),more:view.more,
    summary:'Switches the reorder supplier when current supplier evidence shows an unavailable item or an overdue confirmation. Reviewed terms, current approval and plan authority apply.'};
}};

module.exports={action,configure,recordUnavailable,withdrawNotice,preview,execute,teach,linkLines,supplierReply,schedule,exactChoice,page,definition};
