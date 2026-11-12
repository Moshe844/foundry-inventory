'use strict';

// Job 32: finds goods on placed purchase orders that will realistically never
// arrive, so "incoming" stays real. A line counts once its promised date (or
// its order date, when there is no promise) is more than the owner's grace
// period ago and the supplier has sent nothing in that time. Orders with a
// shipment or ship notice, goods being received, a customer preorder or a
// supplier bill ahead of receipt are kept for a person.
//
// Closing reduces each remaining quantity to what was received, so the goods
// stop counting as incoming everywhere StockChief plans. The close stays
// inside StockChief: it does not tell the supplier. A supplier notice is
// drafted for a person to send. Every close is audited and can be reopened.
const {ValidationError,NotFoundError,AuthorizationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const storage=require('../commercial/storage-capacity');
const money=require('../domain/currency');
const exact=require('../domain/exact-quantity');
const {hash}=require('../pricing/postgres-promotions');
const {newId,nowIso}=require('../lib/util');

const JOB=32,ACTION='purchase_order.close_stale_incoming',KIND='purchasing.stale-incoming.v1',href='/autopilot/stale-incoming';
const DEFAULT_GRACE=30;
const rulesTable='stockchief_runtime.agent_incoming_rules',closes='stockchief_runtime.agent_incoming_closes';
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(sql,args)=>c.query(sql,args),transaction:operation=>operation(c)});

async function owner(db,ctx){
  if(!(await db.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId])).rowCount)
    throw new AuthorizationError('Only the inventory owner can close goods that are not coming.');
}
async function currentOwner(db,workspaceId){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.role='owner' ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}
async function read(db,workspaceId,{lock=false}={}){
  return (await db.query(`SELECT * FROM ${rulesTable} WHERE workspace_id=$1${lock?' FOR UPDATE':''}`,[workspaceId])).rows[0]||null;
}
function included(state){return policy.usesAgentTerms(state)&&policy.permits(state.plan,JOB,'suggest');}
function closesHere(state){return policy.usesAgentTerms(state)&&policy.permits(state.plan,JOB,'draft');}

// Late goods with the facts that decide whether they can close.
async function late(db,workspaceId,{grace=DEFAULT_GRACE,orderId=null,lock=false}={}){
  const today=await require('../lib/business-time').today(db,workspaceId);
  if(lock&&orderId)await db.query('SELECT id FROM purchase_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,orderId]);
  const rows=(await db.query(`SELECT p.id AS order_id,p.po_number,p.status,p.currency,p.expected_date::text AS promised,p.supplier_id,
      v.name AS supplier,v.email AS supplier_email,p.integrity_hash,
      coalesce(p.expected_date::date,(p.ordered_at::timestamptz AT TIME ZONE coalesce(w.time_zone,a.time_zone,'UTC'))::date)::text AS due,
      $2::date-coalesce(p.expected_date::date,(p.ordered_at::timestamptz AT TIME ZONE coalesce(w.time_zone,a.time_zone,'UTC'))::date) AS late_days,
      l.id AS line_id,l.line_number,l.sku_id,coalesce(l.destination_location_id,p.destination_location_id) AS location_id,s.code,
      l.quantity_units::text AS ordered,l.quantity_received_units::text AS received,(l.quantity_units-l.quantity_received_units)::text AS remaining,
      l.unit_cost::text AS cost,
      EXISTS(SELECT 1 FROM stockchief_runtime.agent_preorder_sources x WHERE x.workspace_id=l.workspace_id AND x.purchase_order_line_id=l.id)
        OR EXISTS(SELECT 1 FROM stockchief_runtime.agent_preorder_claims x WHERE x.workspace_id=l.workspace_id AND x.purchase_order_line_id=l.id) AS preorder,
      coalesce((SELECT sum(bl.quantity) FROM accounting_supplier_bill_lines bl JOIN accounting_supplier_bills b ON b.workspace_id=bl.workspace_id AND b.id=bl.bill_id
        WHERE bl.workspace_id=l.workspace_id AND bl.purchase_order_line_id=l.id AND b.status<>'VOID'),0)>l.quantity_received_units AS billed_ahead
    FROM purchase_orders p JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id
    JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN suppliers v ON v.workspace_id=p.workspace_id AND v.id=p.supplier_id
    JOIN workspaces w ON w.id=p.workspace_id JOIN accounts a ON a.id=w.owner_account_id
    WHERE p.workspace_id=$1 AND p.status IN ('ORDERED','PARTIALLY_RECEIVED') AND p.ordered_at IS NOT NULL
      AND coalesce(to_jsonb(p)->>'delivery_kind','WAREHOUSE')='WAREHOUSE' AND ($3::text IS NULL OR p.id=$3)
      AND l.quantity_units>l.quantity_received_units AND l.supplier_amendment_closed_at IS NULL AND l.incoming_close_id IS NULL
      AND $2::date>coalesce(p.expected_date::date,(p.ordered_at::timestamptz AT TIME ZONE coalesce(w.time_zone,a.time_zone,'UTC'))::date)
    ORDER BY due,p.po_number,p.id,l.line_number,l.id LIMIT 2001`,[workspaceId,today,orderId])).rows;
  const ids=[...new Set(rows.map(row=>row.order_id))];
  const facts=new Map(ids.length?(await db.query(`SELECT p.id,
      (SELECT max(t) FROM (
        SELECT d.processed_at::timestamptz AS t FROM supplier_documents d WHERE d.workspace_id=p.workspace_id AND d.purchase_order_id=p.id AND d.status<>'IGNORED'
        UNION ALL SELECT r.created_at FROM stockchief_runtime.supplier_link_submissions r JOIN stockchief_runtime.supplier_order_links k
          ON k.workspace_id=r.workspace_id AND k.token_hash=r.token_hash WHERE k.workspace_id=p.workspace_id AND k.purchase_order_id=p.id
        UNION ALL SELECT m.received_at::timestamptz FROM supplier_communications sc JOIN connection_email_messages m ON m.workspace_id=sc.workspace_id
          AND m.connector_id=sc.connector_id AND m.external_thread_id=sc.external_thread_id AND m.supplier_id=p.supplier_id
          WHERE sc.workspace_id=p.workspace_id AND sc.purchase_order_id=p.id AND sc.external_thread_id IS NOT NULL) heard) AS heard_at,
      EXISTS(SELECT 1 FROM stockchief_runtime.supplier_link_submissions r JOIN stockchief_runtime.supplier_order_links k
          ON k.workspace_id=r.workspace_id AND k.token_hash=r.token_hash WHERE k.workspace_id=p.workspace_id AND k.purchase_order_id=p.id AND r.kind='ship-notice')
        OR EXISTS(SELECT 1 FROM supplier_documents d WHERE d.workspace_id=p.workspace_id AND d.purchase_order_id=p.id
          AND d.document_type='shipment_notice' AND d.status<>'IGNORED')
        OR EXISTS(SELECT 1 FROM stockchief_runtime.agent_inbound_freight f WHERE f.workspace_id=p.workspace_id AND f.order_ids ? p.id) AS shipment,
      EXISTS(SELECT 1 FROM stockchief_runtime.assistant_action_proposals x WHERE x.workspace_id=p.workspace_id AND x.status IN ('PENDING','EXECUTING')
          AND x.action_type IN ('purchase_order.receive','purchase_order.receive_from_document')
          AND (x.payload->>'recordId'=p.id OR x.payload->>'purchaseOrderId'=p.id))
        OR EXISTS(SELECT 1 FROM stockchief_runtime.agent_voice_receiving_notes x WHERE x.workspace_id=p.workspace_id AND x.purchase_order_id=p.id
          AND x.state IN ('QUEUED','READING','READY') AND x.created_at>coalesce(last.at,'-infinity'::timestamptz))
        OR EXISTS(SELECT 1 FROM stockchief_runtime.agent_delivery_comparisons x WHERE x.workspace_id=p.workspace_id AND x.purchase_order_id=p.id
          AND x.recorded_at>coalesce(last.at,'-infinity'::timestamptz)) AS receiving,
      (SELECT jsonb_build_object('status',x.status,'at',coalesce(x.reopened_at,x.created_at)) FROM ${closes} x
        WHERE x.workspace_id=p.workspace_id AND x.purchase_order_id=p.id AND x.status IN ('DISMISSED','REOPENED')
        ORDER BY coalesce(x.reopened_at,x.created_at) DESC,x.id LIMIT 1) AS owner_kept
    FROM purchase_orders p LEFT JOIN LATERAL (SELECT max(r.received_at::timestamptz) AS at FROM purchase_order_receipts r
      WHERE r.workspace_id=p.workspace_id AND r.purchase_order_id=p.id) last ON true
    WHERE p.workspace_id=$1 AND p.id=ANY($2::text[])`,[workspaceId,ids])).rows.map(row=>[row.id,row]):[]);
  const quiet=new Date(Date.now()-grace*86400000);
  const orders=new Map();
  for(const row of rows){
    let o=orders.get(row.order_id);
    if(!o){
      const f=facts.get(row.order_id),heard=f?.heard_at?new Date(f.heard_at):null;
      const kept=f?.shipment?'A shipment or ship notice is recorded for this order.':f?.receiving?'Goods for this order are being received.':
        heard&&heard>quiet?'The supplier was in touch on '+heard.toISOString().slice(0,10)+'.':null;
      const keptByOwner=f?.owner_kept?(f.owner_kept.status==='REOPENED'?'You reopened these goods on ':'You chose to keep these goods on ')+
        String(f.owner_kept.at).slice(0,10)+'. StockChief leaves them for you.':null;
      o={ownerKept:keptByOwner,orderId:row.order_id,number:row.po_number,status:row.status,currency:row.currency,promised:row.promised,supplierId:row.supplier_id,
        supplier:row.supplier,supplierEmail:row.supplier_email,due:row.due,
        lateDays:Number(row.late_days),heardAt:heard?heard.toISOString():null,kept,lines:[],version:row.integrity_hash};
      o.closesOn=require('../accounting/customer-money').addDays(o.due,grace+1);
      o.waiting=o.lateDays<=grace;
      orders.set(row.order_id,o);
    }
    const costMinor=money.toMinor(row.cost,row.currency,{optional:true});
    const kept=row.preorder?'A customer preorder is waiting for these goods.':row.billed_ahead?'The supplier billed for goods not yet received.':null;
    o.lines.push({lineId:row.line_id,number:row.line_number,skuId:row.sku_id,locationId:row.location_id,code:row.code,ordered:exact.canonical(row.ordered),
      received:exact.canonical(row.received),remaining:exact.canonical(row.remaining),valueMinor:costMinor==null?null:exact.costMinor(row.remaining,costMinor),kept});
  }
  const list=[...orders.values()];
  for(const o of list){
    // A person can close any late goods that are not kept; StockChief waits for the grace period.
    o.closable=o.kept?[]:o.lines.filter(line=>!line.kept);
    o.ready=!o.waiting&&!o.ownerKept&&o.closable.length>0;
    o.valueMinor=o.closable.some(line=>line.valueMinor==null)?null:o.closable.reduce((n,line)=>n+line.valueMinor,0);
    o.fingerprint=hash({order:o.orderId,version:o.version,status:o.status,promised:o.promised,heard:o.heardAt,grace,
      lines:o.lines.map(line=>[line.lineId,line.ordered,line.received,line.valueMinor,Boolean(line.kept)]),closable:o.closable.map(line=>line.lineId)});
  }
  return {today,grace,orders:list.slice(0,200),more:list.length>200||rows.length>2000};
}

// Close the remaining quantity of each closable line. Called with the order locked.
async function closeLines(c,ctx,o,{closeId,automatic}){
  const at=nowIso(),ids=o.closable.map(line=>line.lineId);
  const current=(await c.query(`SELECT l.*,p.status AS order_status,p.integrity_hash FROM purchase_order_lines l
    JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id
    WHERE l.workspace_id=$1 AND l.purchase_order_id=$2 AND l.id=ANY($3::text[]) ORDER BY l.line_number,l.id FOR UPDATE OF l`,
  [ctx.workspaceId,o.orderId,ids])).rows;
  if(current.length!==ids.length)throw new ValidationError('The purchase order changed. Review the current goods still due.');
  const lines=[];
  for(const line of current){
    const received=exact.canonical(line.quantity_received_units);
    const packs=exact.convert(received,{denominator:String(line.units_per_purchase_unit),precision:6});
    const secondary=line.secondary_quantity_ordered==null?null:exact.canonical(line.secondary_quantity_received);
    const costMinor=money.toMinor(line.unit_cost,o.currency,{optional:true});
    const total=costMinor==null?null:money.fromMinor(exact.costMinor(secondary??received,costMinor),o.currency);
    await c.query(`UPDATE purchase_order_lines SET quantity_units=$4,quantity_purchase_units=$5,secondary_quantity_ordered=$6,line_total=$7,incoming_close_id=$8
      WHERE workspace_id=$1 AND purchase_order_id=$2 AND id=$3`,[ctx.workspaceId,o.orderId,line.id,received,packs,secondary,total,closeId]);
    const seen=o.lines.find(row=>row.lineId===line.id);
    lines.push({lineId:line.id,skuId:line.sku_id,code:seen.code,locationId:seen.locationId,closed:exact.subtract(line.quantity_units,line.quantity_received_units),
      before:{quantity:String(line.quantity_units),packs:String(line.quantity_purchase_units),secondary:line.secondary_quantity_ordered==null?null:String(line.secondary_quantity_ordered),
        total:line.line_total==null?null:String(line.line_total)},
      after:{quantity:received,packs,secondary,total},received});
  }
  const previous=current[0].order_status;
  const state=(await c.query(`SELECT coalesce(bool_or(quantity_units>quantity_received_units),false) AS remaining,
    coalesce(bool_or(quantity_received_units>0),false) AS received FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2`,
  [ctx.workspaceId,o.orderId])).rows[0];
  let status=previous;
  if(!state.remaining&&state.received){
    status='RECEIVED';
    await c.query('UPDATE purchase_orders SET status=$3,completed_at=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,o.orderId,status,at]);
  }else if(!state.remaining){
    status='CANCELLED';
    await require('../operations/postgres-business-workflows').cancelPurchaseOrderInTransaction(c,ctx,o.orderId,
      {idempotencyKey:'incoming-close:'+closeId,reason:'Closed in StockChief: the remaining goods were not expected to arrive.'});
  }
  await c.query('UPDATE purchase_orders SET updated_at=$3,integrity_hash=$4 WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,o.orderId,at,hash({previous:current[0].integrity_hash,closeId,lines:lines.map(line=>[line.lineId,line.after])})]);
  await c.query(`INSERT INTO purchase_order_events(id,workspace_id,purchase_order_id,event,detail,actor_user_id,created_at)
    VALUES($1,$2,$3,'incoming_closed',$4,$5,$6)`,[newId('poevt'),ctx.workspaceId,o.orderId,
    JSON.stringify({closeId,automatic,previousStatus:previous,status,lines:lines.map(line=>({lineId:line.lineId,closed:line.closed}))}),ctx.actorId,at]);
  await refresh(c,ctx.workspaceId,lines,'incoming_closed');
  return {lines,previous,status};
}

// Planning sees the new incoming at once.
async function refresh(c,workspaceId,lines,reason){
  const places=[...new Map(lines.map(line=>[line.skuId+'|'+line.locationId,line])).values()];
  await c.query('SELECT stockchief_expire_replenishment($1::jsonb,$2)',[JSON.stringify(places.map(line=>({workspace_id:workspaceId,sku_id:line.skuId}))),reason]);
  await c.query(`SELECT stockchief_signal_reorder_candidates(coalesce(jsonb_agg(jsonb_build_object('workspace_id',$1::text,'sku_id',x.sku,
      'location_id',x.place,'remaining',coalesce((SELECT on_hand FROM balances b WHERE b.workspace_id=$1 AND b.sku_id=x.sku AND b.location_id=x.place),0))),'[]'::jsonb))
    FROM jsonb_to_recordset($2::jsonb) x(sku text,place text) WHERE x.place IS NOT NULL`,
  [workspaceId,JSON.stringify(places.map(line=>({sku:line.skuId,place:line.locationId})))]);
}

// A plain notice for a person to send. Nothing is sent to the supplier.
async function draftNotice(c,ctx,o,closeId,lines){
  const goods=lines.map(line=>line.closed+' × '+line.code).join(', ');
  const body='Hello '+o.supplier+',\n\nWe have not received the remaining goods on '+o.number+' ('+goods+'), due '+o.due+
    ', and we have not heard from you since. We have stopped expecting them. If you are still sending them, please reply with the ship date. '+
    'If not, please confirm that the order is closed.\n\nThank you.';
  const id=newId('email'),at=nowIso();
  await c.query(`INSERT INTO supplier_communications(id,workspace_id,supplier_id,purchase_order_id,recipient,subject,body,status,message_kind,idempotency_key,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'PREPARED','purchase_remainder_closed',$8,$9,$9)`,
  [id,ctx.workspaceId,o.supplierId,o.orderId,o.supplierEmail,'Remaining goods on '+o.number,body,'incoming-close:'+closeId,at]);
  return id;
}

async function apply(c,ctx,o,row,{automatic,ruleRevision}){
  const done=await closeLines(c,ctx,o,{closeId:row.id,automatic});
  const notice=o.supplierEmail?await draftNotice(c,ctx,o,row.id,done.lines):null;
  await c.query(`UPDATE ${closes} SET status='CLOSED',plan=$3,previous_status=$4,closed_status=$5,authorization_kind=$6,rule_revision=$7,
      closed_by=$8,closed_at=now(),notice_id=$9,reason=NULL WHERE workspace_id=$1 AND id=$2`,
  [ctx.workspaceId,row.id,JSON.stringify({...stored(o),lines:done.lines}),done.previous,done.status,automatic?'AUTOMATIC':'INDIVIDUAL',ruleRevision??null,ctx.actorId,notice]);
  await audit.record(c,ctx,{action:automatic?'StockChief closed goods that will not arrive':'Closed goods that will not arrive',reference:o.orderId,
    before:{status:done.previous,lines:done.lines.map(line=>[line.code,line.before.quantity])},
    after:{status:done.status,closeId:row.id,lines:done.lines.map(line=>[line.code,line.after.quantity]),grace:o.grace}});
  return {id:row.id,closed:true,status:done.status,notice};
}
const stored=o=>({orderId:o.orderId,number:o.number,supplier:o.supplier,currency:o.currency,due:o.due,promised:o.promised,lateDays:o.lateDays,
  heardAt:o.heardAt,valueMinor:o.valueMinor,grace:o.grace,lines:o.closable});

async function insert(c,ctx,o,{status,key,reason=null,ruleRevision=null}){
  await storage.reserve(scoped(c),ctx.workspaceId,'incoming-close:'+key,4096+o.closable.length*1024,{finished:true});
  return (await c.query(`INSERT INTO ${closes}(workspace_id,id,purchase_order_id,request_key,fingerprint,status,plan,reason,rule_revision)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_id,request_key) DO NOTHING RETURNING *`,
  [ctx.workspaceId,newId('incoming_close'),o.orderId,key,o.fingerprint,status,JSON.stringify(stored(o)),reason,ruleRevision])).rows[0]||null;
}
async function draft(c,ctx,o,reason,ruleRevision){
  await c.query(`UPDATE ${closes} SET status='STALE' WHERE workspace_id=$1 AND purchase_order_id=$2 AND status='DRAFT' AND fingerprint<>$3`,
    [ctx.workspaceId,o.orderId,o.fingerprint]);
  const row=await insert(c,ctx,o,{status:'DRAFT',key:'draft:'+o.orderId+':'+o.fingerprint,reason,ruleRevision});
  if(!row)await c.query(`UPDATE ${closes} SET reason=$4 WHERE workspace_id=$1 AND purchase_order_id=$2 AND status='DRAFT' AND fingerprint=$3`,
    [ctx.workspaceId,o.orderId,o.fingerprint,reason]);
  return {drafted:Boolean(row)};
}

// Why an order cannot close on its own right now, or null.
async function automaticStop(c,ctx,state,rule,o){
  if(!rule.automatic)return 'Turn on closing on its own to let StockChief close these goods.';
  if(rule.authorized_by!==ctx.actorId)return 'The current owner must confirm the rule.';
  if(!policy.permits(state.plan,JOB,'automatic'))return 'Your plan lists these goods for you.';
  const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,true);
  if(stop)return stop;
  if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)
    return 'Automatic work is off for this inventory. Close these goods yourself.';
  if(o.valueMinor==null)return 'A line has no recorded price, so StockChief cannot check your limit.';
  if(o.currency!==rule.currency)return 'This order is in '+o.currency+'. Your limit is in '+rule.currency+'.';
  if(o.valueMinor>Number(rule.max_value_minor))
    return 'The goods still due are worth '+money.format(o.valueMinor,o.currency)+', more than your limit of '+money.format(Number(rule.max_value_minor),rule.currency)+'.';
  return null;
}

// Worker: close or draft each late order under the owner's rule.
async function run(database,workspaceId){
  const actorId=await currentOwner(database,workspaceId);
  if(!actorId)return {skipped:'owner_unavailable'};
  const ctx={workspaceId,actorId},state=await policy.accountState(database,workspaceId);
  if(!closesHere(state))return {skipped:'plan'};
  const rule=await read(database,workspaceId);
  if(!rule?.enabled)return {skipped:'no_rule'};
  if(await policy.stopped(database,workspaceId,state,ACTION,false))return {watching:true};
  const found=await late(database,workspaceId,{grace:rule.grace_days});
  let closed=0,drafted=0;
  for(const seen of found.orders.filter(o=>o.ready).slice(0,50)){
    const result=await tx(database,async c=>{
      const fresh=(await late(c,workspaceId,{grace:rule.grace_days,orderId:seen.orderId,lock:true})).orders[0];
      const current=await read(c,workspaceId);
      if(!fresh?.ready||!current?.enabled||current.revision!==rule.revision)return {};
      fresh.grace=current.grace_days;
      const why=await automaticStop(c,ctx,state,current,fresh);
      if(why)return draft(c,ctx,fresh,why,current.revision);
      const row=await insert(c,ctx,fresh,{status:'DRAFT',key:'auto:'+fresh.orderId+':'+fresh.fingerprint,ruleRevision:current.revision});
      if(!row)return {replayed:true};
      await c.query(`UPDATE ${closes} SET status='STALE' WHERE workspace_id=$1 AND purchase_order_id=$2 AND status='DRAFT' AND id<>$3`,
        [workspaceId,fresh.orderId,row.id]);
      return apply(c,ctx,fresh,row,{automatic:true,ruleRevision:current.revision});
    });
    if(result.closed)closed++;
    if(result.drafted)drafted++;
  }
  return {closed,drafted};
}

async function schedule(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);
  if(!closesHere(state)||!(await read(db,workspaceId))?.enabled)return {queued:0};
  const slot=Math.floor(Date.now()/3600000);
  const job=await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:KIND,priority:70,maxAttempts:3,
    idempotencyKey:'stale-incoming:'+slot,payload:{}});
  return {queued:job.created?1:0};
}

// A person closes one late order now, or approves a waiting close.
async function closeNow(database,ctx,orderId,input){
  return tx(database,async c=>{
    await owner(c,ctx);
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,false);
    if(stop)throw new ValidationError(stop);
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that these goods are not coming.');
    const rule=await read(c,ctx.workspaceId),grace=rule?.enabled?rule.grace_days:DEFAULT_GRACE;
    const o=(await late(c,ctx.workspaceId,{grace,orderId:String(orderId||''),lock:true})).orders[0];
    if(!o)throw new NotFoundError('This order has no late goods still due.');
    if(o.fingerprint!==input.fingerprint){
      const pending=(await c.query(`SELECT id FROM ${closes} WHERE workspace_id=$1 AND id=$2 AND status='DRAFT'`,[ctx.workspaceId,String(input.closeId||'')])).rows[0];
      if(pending)await c.query(`UPDATE ${closes} SET status='STALE' WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,pending.id]);
      return {stale:true};
    }
    if(!o.closable.length)throw new ValidationError(o.kept||'Every late line is kept for a person.');
    o.grace=grace;
    let row=input.closeId?(await c.query(`SELECT * FROM ${closes} WHERE workspace_id=$1 AND id=$2 AND purchase_order_id=$3 AND status='DRAFT' FOR UPDATE`,
      [ctx.workspaceId,String(input.closeId),o.orderId])).rows[0]:null;
    if(!row)row=await insert(c,ctx,o,{status:'DRAFT',key:'person:'+o.orderId+':'+o.fingerprint,ruleRevision:rule?.revision});
    if(!row)return {replayed:true};
    await c.query(`UPDATE ${closes} SET status='STALE' WHERE workspace_id=$1 AND purchase_order_id=$2 AND status='DRAFT' AND id<>$3`,[ctx.workspaceId,o.orderId,row.id]);
    return apply(c,ctx,o,row,{automatic:false,ruleRevision:rule?.revision});
  });
}

async function dismiss(database,ctx,closeId){
  return tx(database,async c=>{
    await owner(c,ctx);
    const result=await c.query(`UPDATE ${closes} SET status='DISMISSED' WHERE workspace_id=$1 AND id=$2 AND status='DRAFT' RETURNING purchase_order_id`,[ctx.workspaceId,closeId]);
    if(!result.rowCount)throw new ValidationError('This close is no longer waiting for you.');
    await audit.record(c,ctx,{action:'Kept late goods as incoming',reference:result.rows[0].purchase_order_id,after:{closeId}});
    return {dismissed:true};
  });
}

// Undo: the goods count as incoming again and the order returns to its status.
async function reopen(database,ctx,closeId,input={}){
  return tx(database,async c=>{
    await owner(c,ctx);
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that these goods may still arrive.');
    const row=(await c.query(`SELECT * FROM ${closes} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,closeId])).rows[0];
    if(!row)throw new NotFoundError('That close was not found.');
    if(row.status==='REOPENED')return {replayed:true};
    if(row.status!=='CLOSED')throw new ValidationError('Only closed goods can be reopened.');
    const order=(await c.query('SELECT status,integrity_hash FROM purchase_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,row.purchase_order_id])).rows[0];
    if(order.status!==row.closed_status)throw new ValidationError('The purchase order changed after the close. Review it before reopening.');
    const at=nowIso();
    for(const line of row.plan.lines){
      const changed=await c.query(`UPDATE purchase_order_lines SET quantity_units=$4,quantity_purchase_units=$5,secondary_quantity_ordered=$6,line_total=$7,incoming_close_id=NULL
        WHERE workspace_id=$1 AND purchase_order_id=$2 AND id=$3 AND incoming_close_id=$8 AND quantity_received_units=$9`,
      [ctx.workspaceId,row.purchase_order_id,line.lineId,line.before.quantity,line.before.packs,line.before.secondary,line.before.total,row.id,line.received]);
      if(!changed.rowCount)throw new ValidationError('Goods were booked in or the line changed after the close. Review the purchase order.');
    }
    if(row.closed_status!==row.previous_status)
      await c.query(`UPDATE purchase_orders SET status=$3,completed_at=NULL,cancel_reason=NULL,cancelled_by_user_id=NULL,cancelled_at=NULL
        WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.purchase_order_id,row.previous_status]);
    await c.query('UPDATE purchase_orders SET updated_at=$3,integrity_hash=$4 WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,row.purchase_order_id,at,hash({previous:order.integrity_hash,reopened:row.id})]);
    await c.query(`INSERT INTO purchase_order_events(id,workspace_id,purchase_order_id,event,detail,actor_user_id,created_at)
      VALUES($1,$2,$3,'incoming_reopened',$4,$5,$6)`,[newId('poevt'),ctx.workspaceId,row.purchase_order_id,
      JSON.stringify({closeId:row.id,status:row.previous_status}),ctx.actorId,at]);
    if(row.notice_id)await c.query(`UPDATE supplier_communications SET status='CANCELLED',updated_at=$3 WHERE workspace_id=$1 AND id=$2 AND status='PREPARED'`,
      [ctx.workspaceId,row.notice_id,at]);
    await c.query(`UPDATE ${closes} SET status='REOPENED',reopened_by=$3,reopened_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,ctx.actorId]);
    await refresh(c,ctx.workspaceId,row.plan.lines,'incoming_reopened');
    await audit.record(c,ctx,{action:'Reopened goods that were closed as not arriving',reference:row.purchase_order_id,
      before:{status:row.closed_status},after:{status:row.previous_status,closeId:row.id}});
    return {reopened:true,status:row.previous_status};
  });
}

async function configure(database,ctx,input){
  return tx(database,async c=>{
    await owner(c,ctx);
    const prior=await read(c,ctx.workspaceId,{lock:true});
    if(Number(input.revision||0)!==(prior?.revision||0))throw new ValidationError('Reload the rule before changing it.');
    if(input.stop==='yes'){
      if(prior?.enabled){
        await c.query(`UPDATE ${rulesTable} SET enabled=false,automatic=false,revision=revision+1,updated_at=now() WHERE workspace_id=$1`,[ctx.workspaceId]);
        await audit.record(c,ctx,{action:'Turned off closing goods that will not arrive',before:{revision:prior.revision}});
      }
      return {stopped:true};
    }
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm the rule for closing goods that are not coming.');
    const grace=Number(input.graceDays);
    if(!Number.isSafeInteger(grace)||grace<1||grace>365)throw new ValidationError('Choose a grace period from 1 to 365 days.');
    const currency=String(input.currency||'').toUpperCase();
    if(!/^[A-Z]{3}$/.test(currency))throw new ValidationError('Choose the currency for your limit.');
    const max=money.userToMinor(String(input.maxValue??''),currency,{label:'Most value to close on its own'});
    const automatic=input.automatic==='yes';
    if(prior?.enabled&&prior.grace_days===grace&&prior.currency===currency&&Number(prior.max_value_minor)===max&&prior.automatic===automatic&&prior.authorized_by===ctx.actorId)return {unchanged:true};
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await storage.reserve(scoped(c),ctx.workspaceId,'incoming-rule:'+((prior?.revision||0)+1),1024,{finished:true});
    await c.query(`INSERT INTO ${rulesTable}(workspace_id,grace_days,currency,max_value_minor,automatic,authorized_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(workspace_id) DO UPDATE SET grace_days=EXCLUDED.grace_days,currency=EXCLUDED.currency,max_value_minor=EXCLUDED.max_value_minor,
        automatic=EXCLUDED.automatic,authorized_by=EXCLUDED.authorized_by,enabled=true,revision=agent_incoming_rules.revision+1,updated_at=now()`,
    [ctx.workspaceId,grace,currency,max,automatic,ctx.actorId]);
    await audit.record(c,ctx,{action:'Saved the rule for goods that will not arrive',
      before:prior?{grace:prior.grace_days,currency:prior.currency,maxValueMinor:Number(prior.max_value_minor),automatic:prior.automatic}:{},
      after:{grace,currency,maxValueMinor:max,automatic}});
    return {saved:true};
  });
}

async function page(db,ctx){
  await owner(db,ctx);
  const state=await policy.accountState(db,ctx.workspaceId);
  const mode=included(state)?policy.allowance(state.plan,JOB):'excluded';
  const rule=await read(db,ctx.workspaceId),grace=rule?.enabled?rule.grace_days:DEFAULT_GRACE;
  const found=await late(db,ctx.workspaceId,{grace});
  const listed=statuses=>db.query(`SELECT c.*,p.po_number FROM ${closes} c JOIN purchase_orders p ON p.workspace_id=c.workspace_id AND p.id=c.purchase_order_id
    WHERE c.workspace_id=$1 AND c.status=ANY($2::text[]) ORDER BY coalesce(c.closed_at,c.created_at) DESC,c.id LIMIT 30`,[ctx.workspaceId,statuses]);
  const drafts=(await listed(['DRAFT'])).rows,recent=(await listed(['CLOSED','REOPENED'])).rows;
  const canClose=mode!=='excluded'&&mode!=='suggest';
  const blocked=canClose?await policy.stopped(db,ctx.workspaceId,state,ACTION,false):null;
  let automatic=null;
  if(canClose&&rule?.enabled&&rule.automatic){
    automatic=await policy.stopped(db,ctx.workspaceId,state,ACTION,true);
    if(!automatic&&!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)
      automatic='Automatic work is off for this inventory, so each close waits for you.';
  }
  const currency=rule?.currency||(await db.query(`SELECT currency FROM purchase_orders WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 1`,[ctx.workspaceId])).rows[0]?.currency||'USD';
  return {mode,canClose,shadow:Boolean(state.shadow),rule,grace,defaultGrace:DEFAULT_GRACE,currency,found,drafts,recent,blocked,automatic,href,
    money:(minor,code)=>minor==null?'Unknown':money.format(Number(minor),code),amount:(minor,code)=>money.fromMinor(Number(minor),code)};
}

async function inbox(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);
  if(!closesHere(state))return [];
  const rows=(await db.query(`SELECT c.id,c.reason,c.created_at,p.po_number FROM ${closes} c JOIN purchase_orders p ON p.workspace_id=c.workspace_id AND p.id=c.purchase_order_id
    WHERE c.workspace_id=$1 AND c.status='DRAFT' ORDER BY c.created_at,c.id LIMIT 50`,[workspaceId])).rows;
  return rows.map(row=>({kind:'purchase',importance:'Needs You',priority:70,title:'Close goods that will not arrive on '+row.po_number,
    happened:'These goods are long past their promised date and the supplier has sent nothing.',why:row.reason||'Approve the close or keep the goods as incoming.',
    recommendation:'Check the order, then close the goods still due or keep them.',href:href+'#close-'+row.id,actionLabel:'Review late goods',
    sourceId:'incoming-close:'+row.id,createdAt:row.created_at,at:row.created_at}));
}

module.exports={JOB,ACTION,KIND,href,DEFAULT_GRACE,read,late,run,schedule,closeNow,dismiss,reopen,configure,page,inbox};
