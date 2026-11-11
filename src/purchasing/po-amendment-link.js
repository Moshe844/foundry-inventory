'use strict';

const {createHash}=require('node:crypto');
const exact=require('../domain/exact-quantity');
const money=require('../domain/currency');
const policy=require('../commercial/agent-plan');
const {newId}=require('../lib/util');
const {ValidationError}=require('../domain/errors');
const {hash}=require('../pricing/postgres-promotions');
const {lookup}=require('./supplier-order-link');
const source=require('./po-delivery-date-source');

function tokenFingerprint(date,changes,revision){
  return createHash('sha256').update('amendment|'+hash({date,changes,revision})).digest('hex');
}

async function canAccept(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  return policy.usesAgentTerms(account)&&policy.permits(account.plan,31,'draft');
}

async function current(db,order){
  const header=await source.currentSnapshot(db,order.workspace_id,order.id);
  if(order.delivery_kind!=='WAREHOUSE'||!['ORDERED','PARTIALLY_RECEIVED'].includes(header?.status))
    throw new ValidationError('Only placed warehouse purchases with goods still due can be amended here.');
  return hash(header);
}

async function page(db,token){
  const order=await lookup(db,token);
  await policy.requireWorkspaceJob(db,order.workspace_id,31,'draft');
  const revision=await current(db,order);
  const lines=(await db.query(`SELECT l.id,l.line_number,s.code,i.name,i.unit_label,i.secondary_unit_label,
    l.purchase_unit,l.units_per_purchase_unit::text,l.unit_cost::text,
    (l.quantity_units-l.quantity_received_units)::text AS remaining,
    (l.secondary_quantity_ordered-l.secondary_quantity_received)::text AS remaining_weight
    FROM purchase_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE l.workspace_id=$1 AND l.purchase_order_id=$2 AND l.quantity_units>l.quantity_received_units
    ORDER BY l.line_number,l.id`,[order.workspace_id,order.id])).rows;
  return {order,lines,revision};
}

function formChanges(input,currency){
  const rows=input?.terms==null?[]:Object.values(input.terms);
  if(rows.length>250)throw new ValidationError('Submit up to 250 exact purchase lines in one response.');
  const changes=[];
  for(const row of rows){
    if(!row||typeof row!=='object'||Array.isArray(row))
      throw new ValidationError('Enter the revised quantity, weight or price beside its purchase line.');
    const fields={};
    for(const key of ['quantity','secondary','price']){
      const value=row[key];
      if(value==null||value==='')continue;
      if(typeof value!=='string'||value.length>32)throw new ValidationError('Enter an exact decimal for each revised figure.');
      fields[key]=key==='price'
        ?money.fromMinor(money.toMinor(value,currency,{label:'Proposed price'}),currency)
        :exact.canonical(value,{scale:6,label:key==='secondary'?'Remaining weight':'Remaining quantity'});
    }
    if(Object.keys(fields).length)changes.push({lineId:row.lineId,...fields});
  }
  if(!changes.length||new Set(changes.map(row=>row.lineId)).size!==changes.length)
    throw new ValidationError('Enter at least one revised amount and select each purchase line only once.');
  return changes.sort((a,b)=>String(a.lineId).localeCompare(String(b.lineId)));
}

async function submit(db,token,input){
  if(input.confirmed!=='yes')throw new ValidationError('Confirm the exact supplier quantities, costs or date before submitting.');
  const date=input.date||null;
  if(date&&(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||
    !Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date))
    throw new ValidationError('Enter a valid proposed delivery date.');
  return db.transaction(async c=>{
    const order=await lookup(c,token,true,{includeClosed:true});
    await policy.requireWorkspaceJob(c,order.workspace_id,31,'draft');
    const changes=formChanges(input,order.currency);
    const fingerprint=tokenFingerprint(date,changes,input.revision);
    const existing=(await c.query(`SELECT id FROM stockchief_runtime.supplier_link_submissions
      WHERE token_hash=$1 AND fingerprint=$2`,[order.token_hash,fingerprint])).rows[0];
    if(existing)return {id:existing.id,replayed:true};
    const revision=await current(c,order);
    if(input.revision!==revision)throw new ValidationError('The purchase order changed. Reopen this page and check the current remaining quantities.');
    await require('./po-amendment-lines').prepare(c,order.workspace_id,order,changes);
    const id=newId('supplierreply'),amendment=JSON.stringify({revision,changes});
    const scoped={query:(sql,args)=>c.query(sql,args),transaction:operation=>operation(c)};
    await require('../commercial/storage-capacity').reserve(scoped,order.workspace_id,'supplier-amendment:'+id,
      Buffer.byteLength(amendment)+8192,{finished:true});
    await c.query(`INSERT INTO stockchief_runtime.supplier_link_submissions(id,token_hash,kind,expected_date,amendment,fingerprint,workspace_id)
      VALUES($1,$2,'amendment',$3,$4,$5,$6)`,[id,order.token_hash,date,amendment,fingerprint,order.workspace_id]);
    await require('./agent-po-delivery-dates').enqueue(c,order.workspace_id,id);
    return {id,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

module.exports={canAccept,page,submit,tokenFingerprint};
