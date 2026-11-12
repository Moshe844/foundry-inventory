'use strict';

const {createHash}=require('node:crypto');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {newId}=require('../lib/util');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const exact=require('../domain/exact-quantity');
const source=require('./supplier-price-list-source');
const jobs=require('../operations/postgres-job-queue');
const capacity=require('../commercial/storage-capacity');
const ent=require('../commercial/entitlements');
const kind='import.read-supplier-price-list.v1';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const storage=id=>'supplier-price-list:'+id;
const path='/autopilot/supplier-price-lists';
const lockNotices=(db,workspaceId)=>db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['supplier-price-notices:'+workspaceId]);

async function owner(db,ctx,{lock=false}={}){
  const allowed=(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=w.owner_account_id AND x.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF w,u':''}`,[ctx.workspaceId,ctx.actorId])).rowCount;
  if(!allowed)throw new AuthorizationError('Only the current inventory owner can review supplier price lists.');
  return policy.requireWorkspaceJob(db,ctx.workspaceId,91,'suggest');
}

async function receipt(db,workspaceId,hash,{renew=false,reverse=null}={}){
  const scope=await ent.ownerScopeForWorkspace(db,workspaceId);
  const events=await require('../documents/source-read-receipts').readReceipts(db,scope,hash);
  if(events.some(event=>event.status==='COMMITTED'))return null;
  const usage={meter:'agent_documents',units:1,idempotencyKey:'supplier-price-list:'+hash,retryReversed:true,detail:{sourceHash:hash}};
  if(reverse){
    if(events.some(event=>event.idempotency_key===usage.idempotencyKey))await ent.reverseUsage(db,scope,{...usage,reason:reverse});
    return null;
  }
  if(events.some(event=>event.idempotency_key!==usage.idempotencyKey))
    throw new ValidationError('This original has another pending document read. Retry after it finishes.');
  if(renew&&events.length)await ent.reverseUsage(db,scope,{...usage,reason:'Recheck document funding under the current plan'});
  await ent.reserveUsage(db,scope,usage);
  return {scope,usage};
}

async function upload(db,ctx,{filename,buffer,supplierId,currency}){
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>require('../imports/source-formats').maxBytes)
    throw new ValidationError('Choose one complete supplier price-list file within the upload limit.');
  filename=String(filename||'').trim();
  if(!filename||filename.length>240)throw new ValidationError('Choose a readable original filename.');
  const confirmedCurrency=currency?money.code(currency):null;
  return db.transaction(async c=>{
    await owner(c,ctx,{lock:true});
    if(!(await c.query("SELECT 1 FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active' FOR SHARE",[ctx.workspaceId,supplierId])).rowCount)
      throw new ValidationError('Choose the exact existing supplier for this original.');
    const hash=sha(buffer);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['supplier-price-list',ctx.workspaceId,hash])]);
    const existing=(await c.query(`SELECT id,confirmed_currency FROM stockchief_runtime.agent_supplier_price_lists
      WHERE workspace_id=$1 AND supplier_id=$2 AND content_hash=$3`,[ctx.workspaceId,supplierId,hash])).rows[0];
    if(existing){
      if(existing.confirmed_currency!==confirmedCurrency)throw new ValidationError('This original already has a different confirmed currency. Review its saved evidence.');
      return {id:existing.id,replayed:true};
    }
    const sameOriginal=(await c.query("SELECT 1 FROM stockchief_runtime.agent_supplier_price_lists WHERE workspace_id=$1 AND content_hash=$2 LIMIT 1",[ctx.workspaceId,hash])).rowCount;
    if(sameOriginal)throw new ValidationError('This original is already assigned to another supplier. Check the saved source.');
    const id=newId('supplier-price-list');
    await receipt(c,ctx.workspaceId,hash);
    await capacity.reserve(c,ctx.workspaceId,storage(id),buffer.length+4096,{finished:true});
    await c.query(`INSERT INTO stockchief_runtime.agent_supplier_price_lists
      (workspace_id,id,supplier_id,uploaded_by,filename,content_hash,original,confirmed_currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ctx.workspaceId,id,supplierId,ctx.actorId,filename,hash,buffer,confirmedCurrency]);
    await jobs.enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind,payload:{sourceId:id},idempotencyKey:id,priority:55,maxAttempts:8});
    return {id,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function supplierBasis(db,workspaceId,supplierId,before){
  const {rows}=await db.query(`WITH bought AS (
    SELECT l.sku_id,l.supplier_sku,l.purchase_unit,l.units_per_purchase_unit,p.id AS po_id,p.po_number,
      l.unit_cost,p.currency,greatest(p.ordered_at::timestamptz,l.created_at::timestamptz) AS placed_at,l.id AS line_id
    FROM purchase_order_lines l JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id
    WHERE p.workspace_id=$1 AND p.supplier_id=$2 AND p.ordered_at::timestamptz<=$3 AND l.created_at::timestamptz<=$3
      AND p.status IN('ORDERED','PARTIALLY_RECEIVED','RECEIVED')
  ), link AS (
    SELECT DISTINCT ON(sku_id) sku_id,supplier_sku,purchase_unit,units_per_purchase_unit
    FROM (SELECT sku_id,supplier_sku,purchase_unit,units_per_purchase_unit,0 AS priority,placed_at AS at,line_id AS id FROM bought
      UNION ALL SELECT sku_id,supplier_sku,purchase_unit,units_per_purchase_unit,1,updated_at::timestamptz,id
        FROM supplier_items WHERE workspace_id=$1 AND supplier_id=$2 AND is_active=1 AND updated_at::timestamptz<=$3) sources
    ORDER BY sku_id,priority DESC,at DESC,id DESC
  ), observed AS (
    SELECT sku_id,currency,unit_cost::text AS major,NULL::text AS minor,1::numeric AS pricing_quantity,
      placed_at::timestamptz AS observed_at,'Placed purchase order' AS kind,po_number AS reference,'/purchasing/orders/'||po_id AS href,1 AS priority,NULL::boolean AS measured
    FROM bought WHERE unit_cost IS NOT NULL
    UNION ALL
    SELECT si.sku_id,s.currency,si.last_unit_cost::text,NULL,1,coalesce(si.last_cost_at,si.updated_at)::timestamptz,
      'Saved supplier price',s.name,'/suppliers/'||s.id,2,NULL
    FROM supplier_items si JOIN suppliers s ON s.workspace_id=si.workspace_id AND s.id=si.supplier_id
    WHERE si.workspace_id=$1 AND si.supplier_id=$2 AND si.is_active=1 AND si.last_unit_cost IS NOT NULL
      AND coalesce(si.last_cost_at,si.updated_at)::timestamptz BETWEEN s.updated_at::timestamptz AND $3
    UNION ALL
    SELECT h.sku_id,h.currency,h.unit_cost::text,NULL,1,h.observed_at::timestamptz,
      'Matched supplier document',coalesce(d.document_reference,d.id),'/purchasing/orders/'||d.purchase_order_id,2,false
    FROM supplier_price_history h JOIN supplier_documents d ON d.workspace_id=h.workspace_id AND d.id=h.source_document_id
    WHERE h.workspace_id=$1 AND h.supplier_id=$2 AND d.supplier_id=h.supplier_id AND d.status='MATCHED' AND h.observed_at::timestamptz<=$3
    UNION ALL
    SELECT b.sku_id,i.currency,NULL,coalesce(l.source_unit_cost_minor,l.unit_cost_minor)::text,
      coalesce(l.source_price_quantity,l.price_quantity),i.opened_at::timestamptz,
      'Posted supplier bill',i.bill_number,'/money/bills/'||i.id,3,l.secondary_quantity IS NOT NULL
    FROM bought b JOIN accounting_supplier_bill_lines l ON l.workspace_id=$1 AND l.purchase_order_line_id=b.line_id AND l.sku_id=b.sku_id
    JOIN accounting_supplier_bills i ON i.workspace_id=l.workspace_id AND i.id=l.bill_id AND i.supplier_id=$2
    JOIN accounting_journal_entries j ON j.workspace_id=i.workspace_id AND j.id=i.journal_entry_id AND j.status='POSTED'
    WHERE i.status IN('OPEN','PARTIALLY_PAID','PAID') AND i.match_status='MATCHED' AND i.opened_at::timestamptz<=$3
      AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries reversal WHERE reversal.workspace_id=j.workspace_id
        AND reversal.reversal_of_entry_id=j.id AND reversal.status='POSTED')
  ), latest AS (
    SELECT DISTINCT ON(sku_id,currency) sku_id,currency,major,minor,trim_scale(pricing_quantity)::text AS pricing_quantity,
      observed_at::text AS observed_at,kind,reference,href
    FROM observed JOIN skus os ON os.workspace_id=$1 AND os.id=observed.sku_id
    JOIN items oi ON oi.workspace_id=os.workspace_id AND oi.id=os.item_id
    WHERE pricing_quantity>0 AND (measured IS NULL OR measured=(oi.secondary_unit_label IS NOT NULL))
    ORDER BY sku_id,currency,observed_at DESC,priority DESC,reference DESC
  )
  SELECT link.*,s.code,i.unit_label,i.secondary_unit_label,supplier.name AS supplier_name,
    coalesce((SELECT jsonb_agg(to_jsonb(latest)-'sku_id' ORDER BY latest.currency) FROM latest WHERE latest.sku_id=link.sku_id),'[]'::jsonb) AS prior
  FROM link JOIN skus s ON s.workspace_id=$1 AND s.id=link.sku_id AND s.is_active=1
  JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
  JOIN suppliers supplier ON supplier.workspace_id=s.workspace_id AND supplier.id=$2 AND supplier.status='active'`,[workspaceId,supplierId,before]);
  return rows;
}

function findings(raw,products,confirmedCurrency){
  const ids=new Map();
  for(const product of products)for(const code of new Set([product.code,product.supplier_sku].filter(Boolean).map(v=>v.trim().toLowerCase()))){
    if(!ids.has(code))ids.set(code,[]);
    ids.get(code).push(product);
  }
  const counts=new Map(),matched=raw.map(row=>{
    const products=ids.get(row.code.trim().toLowerCase())||[];
    const product=products.length===1?products[0]:null;
    if(product)counts.set(product.sku_id,(counts.get(product.sku_id)||0)+1);
    return {row,product};
  });
  return matched.map(({row,product},index)=>{
    const r={ordinal:index+1,sku_id:product?.sku_id||null,sku_code:product?.code||row.code,sheet:row.sheet,row_number:row.rowNumber,quote:row};
    try{
      if(!product)throw new ValidationError('No single active product matches this supplier’s SKU and purchasing history.');
      if(counts.get(product.sku_id)>1)throw new ValidationError('The original has several prices for this SKU. Confirm the exact tier or effective price.');
      if(row.supplier&&row.supplier.toLowerCase()!==product.supplier_name.toLowerCase())throw new ValidationError('The printed supplier differs from the selected supplier.');
      if(row.tableCurrency&&money.code(row.currency)!==row.tableCurrency)throw new ValidationError('The row currency differs from the printed table currency.');
      if(confirmedCurrency&&row.currency&&money.code(row.currency)!==confirmedCurrency)throw new ValidationError('The printed currency differs from the confirmed source currency.');
      const value=source.comparable({...row,currency:row.currency||confirmedCurrency},product);
      const prior=product.prior.find(p=>p.currency===value.currency);
      if(!prior)throw new ValidationError('This supplier has no earlier trusted price in the same currency and pricing unit.');
      const previousMinor=prior.minor==null?money.toMinor(prior.major,value.currency):money.integer(prior.minor);
      const higher=BigInt(value.amountMinor)*BigInt(exact.atoms(prior.pricing_quantity,6))>
        BigInt(previousMinor)*BigInt(exact.atoms(value.pricingQuantity,6));
      return {...r,currency:value.currency,amount_minor:value.amountMinor,pricing_quantity:value.pricingQuantity,
        prior:{...prior,amountMinor:previousMinor,unit:value.unit},result:higher?'HIGHER':'NO_INCREASE'};
    }catch(error){if(error.code!=='validation_error')throw error;return {...r,result:'HELD',reason:error.message};}
  });
}

async function comparison(db,row,rows){
  return findings(rows,await supplierBasis(db,row.workspace_id,row.supplier_id,row.created_at),row.confirmed_currency);
}

async function saveComparison(db,row,compared,json,payment,confirmation=null){
  await db.query(`INSERT INTO stockchief_runtime.agent_supplier_price_list_findings
    (workspace_id,source_id,ordinal,sku_id,sku_code,sheet,row_number,quote,currency,amount_minor,pricing_quantity,prior,result,reason)
    SELECT $1,$2,x.ordinal,x.sku_id,x.sku_code,x.sheet,x.row_number,x.quote,x.currency,x.amount_minor,x.pricing_quantity,x.prior,x.result,x.reason
    FROM jsonb_to_recordset($3::jsonb) x(ordinal int,sku_id text,sku_code text,sheet text,row_number int,quote jsonb,currency text,
      amount_minor bigint,pricing_quantity numeric,prior jsonb,result text,reason text)`,[row.workspace_id,row.id,json]);
  await db.query(`UPDATE stockchief_runtime.agent_supplier_price_lists SET status='READY',problem=NULL,checked_at=clock_timestamp(),
    confirmed_by=$3,confirmed_at=CASE WHEN $3::text IS NOT NULL THEN clock_timestamp() END,confirmation_hash=$4
    WHERE workspace_id=$1 AND id=$2`,[row.workspace_id,row.id,confirmation?.actorId||null,confirmation?.hash||null]);
  if(payment)await ent.commitUsage(db,payment.scope,payment.usage);
  return {status:'READY',increases:compared.filter(r=>r.result==='HIGHER').length,rows:compared.length};
}

async function run(job,db){
  const workspaceId=job.workspaceId,id=job.payload?.sourceId;
  const original=(await db.query('SELECT * FROM stockchief_runtime.agent_supplier_price_lists WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];
  if(!original)return {missing:true};
  if(original.status!=='QUEUED')return {status:original.status,replayed:true};
  let rows,problem;
  try{
    await owner(db,{workspaceId,actorId:original.uploaded_by});
    if(sha(original.original)!==original.content_hash)throw new ValidationError('The original failed its saved integrity check.');
    rows=await source.read({filename:original.filename,buffer:original.original});
  }catch(error){if(![400,402,403].includes(error.status))throw error;problem=error.message;}
  return db.transaction(async c=>{
    const row=(await c.query('SELECT * FROM stockchief_runtime.agent_supplier_price_lists WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,id])).rows[0];
    if(!row||row.status!=='QUEUED')return {status:row?.status,replayed:true};
    try{await owner(c,{workspaceId,actorId:row.uploaded_by},{lock:true});}catch(error){
      if(![402,403].includes(error.status))throw error;problem=error.message;
    }
    if(row.content_hash!==original.content_hash||sha(row.original)!==original.content_hash)problem='The preserved price-list original changed.';
    const hold=async reason=>{
      await receipt(c,workspaceId,row.content_hash,{reverse:reason});
      await c.query("UPDATE stockchief_runtime.agent_supplier_price_lists SET status='HELD',problem=$3,checked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[workspaceId,id,reason]);
      return {status:'HELD',reason};
    };
    if(problem)return hold(problem);
    const compared=await comparison(c,row,rows);
    const json=JSON.stringify(compared);
    let payment;
    try{
      payment=await receipt(c,workspaceId,row.content_hash,{renew:true});
      await capacity.reserve(c,workspaceId,storage(id),row.original.length+Buffer.byteLength(json)+4096,{finished:true});
    }catch(error){
      if(![400,402,403].includes(error.status))throw error;
      return hold(error.message);
    }
    return saveComparison(c,row,compared,json,payment);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function confirm(db,ctx,id,input){
  await owner(db,ctx);
  if(input.confirmed!=='yes'||typeof input.sourceTable!=='string'||!input.sourceTable.trim())
    throw new ValidationError('Open the retained original and confirm that you copied the complete pricing table exactly.');
  const buffer=Buffer.from(input.sourceTable);
  const hash=sha(buffer),rows=await source.read({filename:'confirmed-source.txt',buffer});
  return db.transaction(async c=>{
    await owner(c,ctx,{lock:true});
    const row=(await c.query('SELECT * FROM stockchief_runtime.agent_supplier_price_lists WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
    if(!row)throw new NotFoundError('That supplier price-list original was not found.');
    if(row.status==='READY'&&row.confirmation_hash===hash)return {replayed:true};
    if(row.status!=='HELD'||input.sourceHash!==row.content_hash||sha(row.original)!==row.content_hash)
      throw new ValidationError('Choose the exact preserved original that still needs source confirmation.');
    const compared=await comparison(c,row,rows.map(line=>({...line,sheet:'Owner-confirmed table'}))),json=JSON.stringify(compared);
    const payment=await receipt(c,ctx.workspaceId,row.content_hash,{renew:true});
    await capacity.reserve(c,ctx.workspaceId,storage(id),row.original.length+Buffer.byteLength(json)+4096,{finished:true});
    return saveComparison(c,row,compared,json,payment,{actorId:ctx.actorId,hash});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function page(db,ctx,id,{page=1}={}){
  const state=await owner(db,ctx),full=policy.permits(state.plan,91,'automatic');
  const number=Number(page);
  if(!Number.isSafeInteger(number)||number<1||number>1000000)throw new ValidationError('Choose a valid source results page.');
  const current=id&&!full?1:number;
  if(!id){
    const suppliers=(await db.query("SELECT id,name FROM suppliers WHERE workspace_id=$1 AND status='active' ORDER BY name,id",[ctx.workspaceId])).rows;
    const lists=(await db.query(`SELECT p.id,p.filename,p.status,p.created_at,p.reviewed_at,s.name supplier
      FROM stockchief_runtime.agent_supplier_price_lists p LEFT JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id
      WHERE p.workspace_id=$1 ORDER BY p.created_at DESC,p.id LIMIT 51 OFFSET $2`,[ctx.workspaceId,(current-1)*50])).rows;
    return {lists:lists.slice(0,50),suppliers,full,list:null,rows:[],more:lists.length>50,page:current};
  }
  const list=(await db.query(`SELECT p.id,p.filename,p.status,p.content_hash,p.confirmed_at,coalesce(p.problem,j.last_error->>'message') AS problem,p.reviewed_at,s.name supplier,
    (SELECT count(*)::int FROM stockchief_runtime.agent_supplier_price_list_findings f
      WHERE f.workspace_id=p.workspace_id AND f.source_id=p.id AND f.result='HELD') AS held_rows
    FROM stockchief_runtime.agent_supplier_price_lists p LEFT JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id
    LEFT JOIN stockchief_runtime.jobs j ON j.workspace_id=p.workspace_id AND j.kind=$3 AND j.idempotency_key=p.id
    WHERE p.workspace_id=$1 AND p.id=$2`,[ctx.workspaceId,id,kind])).rows[0];
  if(!list)throw new NotFoundError('That supplier price-list original was not found.');
  const rows=(await db.query(`SELECT * FROM stockchief_runtime.agent_supplier_price_list_findings WHERE workspace_id=$1 AND source_id=$2
    AND ($3::boolean OR result='HIGHER') ORDER BY (result='HIGHER') DESC,ordinal LIMIT $4 OFFSET $5`,[ctx.workspaceId,id,full,full?101:1,(current-1)*100])).rows;
  return {list,full,rows:rows.slice(0,100),more:rows.length>100,page:current};
}

async function acknowledge(db,ctx,id){
  return db.transaction(async c=>{
    const state=await owner(c,ctx,{lock:true});
    policy.requireJob(state.plan,91,'automatic');
    await lockNotices(c,ctx.workspaceId);
    const result=await c.query(`UPDATE stockchief_runtime.agent_supplier_price_lists SET reviewed_at=coalesce(reviewed_at,clock_timestamp())
      WHERE workspace_id=$1 AND id=$2 AND status='READY'`,[ctx.workspaceId,id]);
    if(!result.rowCount)throw new ValidationError('Choose a finished supplier price-list review.');
    await c.query(`UPDATE stockchief_runtime.agent_operational_notices SET resolved=true
      WHERE workspace_id=$1 AND job_id=91 AND kind='Price list' AND reference=$2`,[ctx.workspaceId,id]);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function download(db,ctx,id){
  await owner(db,ctx);
  const row=(await db.query('SELECT filename,original,content_hash FROM stockchief_runtime.agent_supplier_price_lists WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That supplier price-list original was not found.');
  if(sha(row.original)!==row.content_hash)throw new ValidationError('The original failed its saved integrity check.');
  return row;
}

module.exports={kind,path,upload,run,confirm,page,acknowledge,download,lockNotices};
