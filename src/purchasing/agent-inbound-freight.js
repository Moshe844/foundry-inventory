'use strict';

const {createHash,randomBytes}=require('node:crypto');
const {AuthorizationError,NotFoundError,ValidationError}=require('../domain/errors');
const {newId,requireText}=require('../lib/util');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const access=require('../operations/postgres-warehouse-access');

const path='/autopilot/inbound-freight',publicPath='/freight/update',action='purchasing.track_inbound_freight';
const table='stockchief_runtime.agent_inbound_freight';
const updates='stockchief_runtime.agent_inbound_freight_updates';
const deposits='stockchief_runtime.agent_inbound_freight_deposits';
const statusLabels={booked:'Booked',in_transit:'In transit',arrived:'At destination port or airport',released:'Released for onward delivery',exception:'Needs attention'};
const progress=new Map([['booked',0],['in_transit',1],['arrived',2],['released',3]]);
const hash=value=>createHash('sha256').update(value).digest('hex');
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const audit=(c,ctx,verb,id,after={})=>require('../operations/postgres-security-audit').record(c,ctx,{action:verb,reference:id,after});

function date(raw,required=false){
  const value=String(raw||'').trim();
  if(!value&&!required)return null;
  const parsed=new Date(value+'T00:00:00Z');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)
    throw new ValidationError('Enter an exact calendar date.');
  return value;
}

function identity({mode,referenceType,reference}){
  const types=mode==='ocean'?['container','bill','booking']:mode==='air'?['waybill']:[];
  if(!types.includes(referenceType))throw new ValidationError('Choose a reference type for this ocean or air shipment.');
  const original=requireText(reference,'Freight reference',{max:80}).toUpperCase();
  const normalized=referenceType==='waybill'?original.replace(/[ -]/g,''):original;
  const format=referenceType==='waybill'?/^\d{11}$/:referenceType==='container'?/^[A-Z]{4}\d{7}$/:/^[A-Z0-9][A-Z0-9./-]{2,79}$/;
  if(!format.test(normalized))throw new ValidationError('Enter the complete freight reference as it appears on the transport document.');
  return {mode,referenceType,reference:referenceType==='waybill'?normalized.slice(0,3)+'-'+normalized.slice(3):normalized};
}

async function owner(db,ctx,lock=false){
  const result=await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId]);
  if(!result.rowCount)throw new AuthorizationError('Only the current inventory owner can manage inbound freight.');
  await access.assertInventoryWide(db,ctx);
}

async function authorize(db,ctx,lock=false){
  await owner(db,ctx,lock);
  if(lock)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
  return policy.requireWorkspaceJob(db,ctx.workspaceId,39,'draft');
}

async function orderFacts(db,ctx,references){
  const rows=(await db.query(`SELECT id,po_number,expected_date::text,supplier_id,currency,destination_location_id,status
    FROM purchase_orders WHERE workspace_id=$1 AND (id=ANY($2::text[]) OR lower(po_number)=ANY($3::text[])) ORDER BY id`,
  [ctx.workspaceId,references,references.map(reference=>reference.toLowerCase())])).rows;
  if(rows.length!==references.length||rows.some(row=>!['ORDERED','PARTIALLY_RECEIVED','RECEIVED'].includes(row.status)))
    throw new ValidationError('Choose exact placed purchase order numbers from this inventory.');
  await access.assertLocations(db,ctx,rows.map(row=>row.destination_location_id));
  return rows;
}

async function get(db,workspaceId,id,lock=false){
  const row=(await db.query(`SELECT id,workspace_id,mode,reference_type,reference,forwarder,destination,status,eta::text,original_eta::text,
    order_ids,authorized_by,routine,maximum_shift_days,revision,link_expires_at FROM ${table} WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,
  [workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That freight shipment is not in this inventory.');
  return row;
}

async function create(db,ctx,input){
  const facts=identity(input),initial=date(input.eta),forwarder=requireText(input.forwarder,'Carrier or freight forwarder',{max:150}),
    destination=requireText(input.destination,'Destination port or airport',{max:150});
  const references=[...new Set(String(input.orders||'').split(/[\r\n,]+/).map(v=>v.trim()).filter(Boolean))];
  const maximum=String(input.maximumShiftDays||'0');
  const routine=input.routine==='yes';
  if(input.confirmed!=='yes'||!references.length||references.length>25||!/^\d{1,3}$/.test(maximum)||Number(maximum)>365||
    routine&&(!initial||Number(maximum)===0))throw new ValidationError('Confirm the linked orders. Routine updates need an initial arrival date and an explicit day limit.');
  return db.transaction(async c=>{
    const tx=scoped(c),state=await authorize(tx,ctx,true);
    if(routine){
      const reason=await policy.stopped(tx,ctx.workspaceId,state,action,true);
      if(reason)throw new ValidationError(reason);
      await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
    }
    const orders=await orderFacts(c,ctx,references),id=newId('inbound');
    await require('../commercial/storage-capacity').reserve(tx,ctx.workspaceId,'inbound-freight:'+id,16384,{finished:true});
    const inserted=await c.query(`INSERT INTO ${table}(workspace_id,id,mode,reference_type,reference,forwarder,destination,eta,original_eta,
      order_ids,authorized_by,routine,maximum_shift_days) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9::jsonb,$10,$11,$12)
      ON CONFLICT(workspace_id,mode,reference_type,reference) DO NOTHING RETURNING id`,
    [ctx.workspaceId,id,facts.mode,facts.referenceType,facts.reference,forwarder,destination,initial,JSON.stringify(orders.map(row=>row.id)),ctx.actorId,routine,maximum]);
    if(!inserted.rowCount)throw new ValidationError('That exact freight reference is already tracked in this inventory.');
    await audit(c,ctx,'Inbound freight tracking recorded',id,{mode:facts.mode,reference:facts.reference,routine});
    return {id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function issueLink(db,ctx,id,input){
  if(input.confirmed!=='yes')throw new ValidationError('Confirm replacing the private update link.');
  return db.transaction(async c=>{
    await authorize(scoped(c),ctx,true);
    await get(c,ctx.workspaceId,id,true);
    const token=randomBytes(32).toString('base64url');
    await c.query(`UPDATE ${table} SET token_hash=$3,link_expires_at=now()+interval '90 days' WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,id,hash(token)]);
    await audit(c,ctx,'Private forwarder link issued',id);
    return publicPath+'/'+token;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function stopLink(db,ctx,id){
  return db.transaction(async c=>{
    await owner(c,ctx,true);
    await get(c,ctx.workspaceId,id,true);
    await c.query(`UPDATE ${table} SET token_hash=NULL,link_expires_at=NULL WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);
    await audit(c,ctx,'Private forwarder link revoked',id);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function configure(db,ctx,id,input){
  return db.transaction(async c=>{
    const tx=scoped(c);
    await owner(c,ctx,true);
    const row=await get(c,ctx.workspaceId,id,true);
    if(input.confirmed!=='yes'||Number(input.revision)!==row.revision)throw new ValidationError('Reload the current freight settings and confirm the change.');
    const enabled=input.enable==='yes',maximum=String(input.maximumShiftDays||row.maximum_shift_days);
    if(enabled){
      const state=await authorize(tx,ctx,true);
      const reason=await policy.stopped(tx,ctx.workspaceId,state,action,true);
      if(reason)throw new ValidationError(reason);
      if(!row.eta||!/^\d{1,3}$/.test(maximum)||Number(maximum)<1||Number(maximum)>365)
        throw new ValidationError('Confirm an existing arrival date and an explicit change limit from 1 to 365 days.');
      await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],row.routine?0:1);
    }
    await c.query(`UPDATE ${table} SET routine=$3,maximum_shift_days=$4,original_eta=CASE WHEN $3 THEN eta ELSE original_eta END,
      revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,enabled,enabled?maximum:row.maximum_shift_days]);
    await audit(c,ctx,enabled?'Routine freight updates authorized':'Routine freight updates paused',id);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function portal(db,token){
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new NotFoundError('This private freight link is inactive.');
  const row=(await db.query(`SELECT f.id,f.workspace_id,f.authorized_by FROM ${table} f JOIN workspaces w ON w.id=f.workspace_id
    JOIN users u ON u.id=f.authorized_by AND u.workspace_id=w.id AND u.role='owner' AND u.account_id=w.owner_account_id
    WHERE f.token_hash=$1 AND f.link_expires_at>now() AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=w.owner_account_id AND a.disabled_at IS NOT NULL)`,[hash(token)])).rows[0];
  if(!row)throw new NotFoundError('This private freight link is inactive.');
  try{await policy.requireWorkspaceJob(db,row.workspace_id,39,'draft');}
  catch(error){if(error.code==='entitlement_required')throw new NotFoundError('This private freight link is inactive.');throw error;}
  return row;
}

async function publicPage(db,token){
  const found=await portal(db,token),row=await get(db,found.workspace_id,found.id);
  return {reference:row.reference,mode:row.mode,status:row.status,eta:row.eta,revision:row.revision,statusLabels};
}

function eligibleDate(current,eta){
  if(!eta)return true;
  const distance=(first,second)=>Math.abs(Date.parse(first)-Date.parse(second))/86400000;
  return Boolean(current.eta&&current.original_eta&&distance(current.eta,eta)<=current.maximum_shift_days&&
    distance(current.original_eta,eta)<=current.maximum_shift_days);
}

async function submit(db,token,input){
  const eta=date(input.eta),status=input.status,note=String(input.note||'').trim();
  if(input.confirmed!=='yes'||!Object.hasOwn(statusLabels,status)||note.length>1000)
    throw new ValidationError('Confirm the current status and any updated arrival date.');
  return db.transaction(async c=>{
    const tx=scoped(c),found=await portal(c,token);
    const ctx={workspaceId:found.workspace_id,actorId:found.authorized_by};
    const account=await authorize(tx,ctx,true);
    const row=await get(c,ctx.workspaceId,found.id,true);
    if(!(await c.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND id=$2 AND token_hash=$3 AND link_expires_at>now()`,
      [ctx.workspaceId,row.id,hash(token)])).rowCount)throw new NotFoundError('This private freight link is inactive.');
    if(Number(input.revision)!==row.revision)throw new ValidationError('This shipment was updated. Reload the current status before sending your update.');
    const automatic=row.routine&&status!=='exception'&&progress.get(status)>=progress.get(row.status)&&eligibleDate(row,eta)&&
      !await policy.stopped(tx,ctx.workspaceId,account,action,true)&&(await require('../autopilot/postgres-service').getState(tx,ctx.workspaceId)).canAutomate;
    const id=newId('freight-update');
    await require('../commercial/storage-capacity').reserve(tx,ctx.workspaceId,'inbound-freight-update:'+id,4096,{finished:true});
    await c.query(`INSERT INTO ${updates}(workspace_id,freight_id,id,revision,status,eta,note,disposition,applied_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[ctx.workspaceId,row.id,id,row.revision+1,status,eta,note||null,automatic?'APPLIED':'REVIEW',automatic?ctx.actorId:null]);
    await c.query(`UPDATE ${table} SET revision=revision+1,status=CASE WHEN $3 THEN $4 ELSE status END,
      eta=CASE WHEN $3 THEN coalesce($5,eta) ELSE eta END WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,automatic,status,eta]);
    await audit(c,ctx,automatic?'Forwarder freight update applied':'Forwarder freight update needs review',row.id,{updateId:id,status,eta});
    return {saved:true};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function reviewUpdate(db,ctx,id,input){
  return db.transaction(async c=>{
    const tx=scoped(c),state=await authorize(tx,ctx,true);
    const reason=await policy.stopped(tx,ctx.workspaceId,state,action,false);
    if(reason)throw new ValidationError(reason);
    const row=await get(c,ctx.workspaceId,id,true);
    const update=(await c.query(`SELECT id,revision,status,eta::text,disposition FROM ${updates} WHERE workspace_id=$1 AND freight_id=$2 AND id=$3 FOR UPDATE`,
      [ctx.workspaceId,id,input.updateId])).rows[0];
    if(update?.disposition==='APPLIED')return {replayed:true};
    if(input.confirmed!=='yes'||!update||update.revision!==row.revision||Number(input.revision)!==row.revision)
      throw new ValidationError('Review the latest forwarder update before applying it.');
    await c.query(`UPDATE ${updates} SET disposition='APPLIED',applied_by=$4 WHERE workspace_id=$1 AND freight_id=$2 AND id=$3`,[ctx.workspaceId,id,update.id,ctx.actorId]);
    await c.query(`UPDATE ${table} SET revision=revision+1,status=$3,eta=coalesce($4,eta) WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,update.status,update.eta]);
    await audit(c,ctx,'Forwarder freight update individually approved',id,{updateId:update.id,status:update.status,eta:update.eta});
    return {applied:true};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function saveDeposit(db,ctx,id,input){
  return db.transaction(async c=>{
    const tx=scoped(c);
    await authorize(tx,ctx,true);
    const row=await get(c,ctx.workspaceId,id,true);
    if(input.confirmed!=='yes'||!row.order_ids.includes(input.orderId))throw new ValidationError('Confirm the exact linked purchase order and deposit terms.');
    const [po]=await orderFacts(c,ctx,[input.orderId]);
    const amount=money.userToMinor(input.amount,po.currency,{label:'Expected deposit'}),due=date(input.dueDate,true);
    if(amount<=0)throw new ValidationError('Enter a positive deposit.');
    const reference=String(input.billNumber||'').trim();
    const bill=reference?(await c.query(`SELECT b.id FROM accounting_supplier_bills b JOIN accounting_journal_entries j
      ON j.workspace_id=b.workspace_id AND j.id=b.journal_entry_id AND j.status='POSTED'
      WHERE b.workspace_id=$1 AND b.purchase_order_id=$2 AND b.supplier_id=$3 AND b.currency=$4
        AND b.total_minor=$5 AND b.status IN('OPEN','PARTIALLY_PAID','PAID') AND lower(b.bill_number)=lower($6) FOR SHARE OF b,j`,
    [ctx.workspaceId,po.id,po.supplier_id,po.currency,amount,reference])).rows[0]:null;
    if(reference&&!bill)throw new ValidationError('Choose a posted bill for this purchase order, supplier, currency and exact deposit amount.');
    const prior=(await c.query(`SELECT revision FROM ${deposits} WHERE workspace_id=$1 AND freight_id=$2 AND purchase_order_id=$3 FOR UPDATE`,
      [ctx.workspaceId,id,po.id])).rows[0];
    if(Number(input.revision)!==(prior?.revision||0))throw new ValidationError('Reload the current deposit before editing.');
    if(bill&&(await c.query(`SELECT 1 FROM ${deposits} WHERE workspace_id=$1 AND bill_id=$2 AND (freight_id<>$3 OR purchase_order_id<>$4)`,
      [ctx.workspaceId,bill.id,id,po.id])).rowCount)throw new ValidationError('This bill already tracks a deposit on another shipment.');
    await c.query(`INSERT INTO ${deposits}(workspace_id,freight_id,purchase_order_id,bill_id,amount_minor,currency,due_date)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,freight_id,purchase_order_id) DO UPDATE SET bill_id=EXCLUDED.bill_id,
      amount_minor=EXCLUDED.amount_minor,currency=EXCLUDED.currency,due_date=EXCLUDED.due_date,revision=agent_inbound_freight_deposits.revision+1`,
    [ctx.workspaceId,id,po.id,bill?.id||null,amount,po.currency,due]);
    await audit(c,ctx,'Expected freight deposit recorded',id,{purchaseOrderId:po.id,amount,currency:po.currency,due,billId:bill?.id||null});
    return {saved:true};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function page(db,ctx,id=null){
  await owner(db,ctx);
  const state=await policy.accountState(db,ctx.workspaceId);
  const allowed=policy.usesAgentTerms(state)&&policy.permits(state.plan,39,'draft');
  const rows=(await db.query(`SELECT id,mode,reference,forwarder,destination,status,eta::text FROM ${table}
    WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`,[ctx.workspaceId])).rows;
  if(!id)return {allowed,rows,freight:null,statusLabels};
  const freight=await get(db,ctx.workspaceId,id);
  const [orders,history,expected]=await Promise.all([
    db.query('SELECT id,po_number,expected_date::text,currency FROM purchase_orders WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY po_number',
      [ctx.workspaceId,freight.order_ids]),
    db.query(`SELECT id,revision,status,eta::text,note,disposition,created_at FROM ${updates} WHERE workspace_id=$1 AND freight_id=$2
      ORDER BY revision DESC LIMIT 100`,[ctx.workspaceId,id]),
    db.query(`SELECT d.purchase_order_id,d.revision,d.amount_minor,d.currency,d.due_date::text,b.bill_number,coalesce(sum(paid.amount_minor),0)::text paid
      FROM ${deposits} d LEFT JOIN accounting_supplier_bills b ON b.workspace_id=d.workspace_id AND b.id=d.bill_id
        AND b.purchase_order_id=d.purchase_order_id AND b.status IN('OPEN','PARTIALLY_PAID','PAID')
        AND b.currency=d.currency AND b.total_minor=d.amount_minor AND EXISTS(SELECT 1 FROM accounting_journal_entries j
          WHERE j.workspace_id=b.workspace_id AND j.id=b.journal_entry_id AND j.status='POSTED')
      LEFT JOIN LATERAL(SELECT a.amount_minor FROM accounting_payment_allocations a JOIN accounting_payments p
        ON p.workspace_id=a.workspace_id AND p.id=a.payment_id AND p.status='POSTED' AND p.direction='SUPPLIER_PAYMENT'
        AND p.currency=b.currency AND p.supplier_id=b.supplier_id JOIN accounting_journal_entries j ON j.workspace_id=p.workspace_id
        AND j.id=p.journal_entry_id AND j.status='POSTED' WHERE a.workspace_id=b.workspace_id AND a.supplier_bill_id=b.id) paid ON true
      WHERE d.workspace_id=$1 AND d.freight_id=$2 GROUP BY d.purchase_order_id,d.revision,d.amount_minor,d.currency,d.due_date,b.bill_number`,
    [ctx.workspaceId,id])
  ]);
  return {allowed,rows,freight,orders:orders.rows,history:history.rows,deposits:expected.rows,statusLabels};
}

async function review(db,ctx){
  const data=await page(db,ctx);
  return {rows:data.rows.map(row=>({Reference:row.reference,Mode:row.mode,Forwarder:row.forwarder,Status:statusLabels[row.status],
    Arrival:row.eta||'Not supplied',link:path+'/'+row.id})),action:{label:'Open inbound freight',href:path},
    summary:'Track ocean and air arrival updates from the private forwarder link and show linked purchase orders, expected deposits and posted payments.'};
}

module.exports={path,publicPath,action,create,issueLink,stopLink,configure,publicPage,submit,reviewUpdate,saveDeposit,page,
  definition:{id:39,key:'inbound-freight',label:'Track ocean and air shipments and their deposits',readPage:review}};
