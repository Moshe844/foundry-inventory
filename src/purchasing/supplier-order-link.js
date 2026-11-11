'use strict';

const crypto=require('node:crypto');
const {ValidationError,NotFoundError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');
const policy=require('../commercial/agent-plan');
const shareStatuses=['APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED'];
const hasEmail=email=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email||'');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const responseFingerprint=(kind,date,shipDate=null,generation=null)=>hash(kind+'|'+(date||'')+
  (shipDate?'|ship:'+shipDate:'')+(generation?'|'+generation:''));

async function issue(client,workspaceId,orderId,recipient,origin) {
  if(!origin) throw new ValidationError('Set the public StockChief address before emailing a supplier order.');
  const base=new URL(origin);
  if(base.protocol!=='https:' && !(base.protocol==='http:' && ['localhost','127.0.0.1'].includes(base.hostname)))
    throw new ValidationError('Configure a secure public address for supplier links.');
  const token=crypto.randomBytes(32).toString('base64url');
  await client.query(`INSERT INTO stockchief_runtime.supplier_order_links(token_hash,workspace_id,purchase_order_id,recipient,expires_at)
    VALUES($1,$2,$3,$4,now()+interval '90 days')`,[hash(token),workspaceId,orderId,recipient.toLowerCase()]);
  return new URL('/supplier/order/'+token,base.origin).href;
}

function canShare(state,status,email,origin){
  return Boolean(origin&&hasEmail(email)&&shareStatuses.includes(status)&&
    policy.usesAgentTerms(state)&&policy.permits(state.plan,35,'draft'));
}

async function share(db,ctx,orderId,origin){
  return db.transaction(async client=>{
    await policy.requireWorkspaceJob(client,ctx.workspaceId,35,'draft');
    const order=(await client.query(`SELECT po.id,po.po_number,po.status,s.name AS supplier_name,s.email
      FROM purchase_orders po JOIN suppliers s ON s.workspace_id=po.workspace_id AND s.id=po.supplier_id
      WHERE po.workspace_id=$1 AND po.id=$2 AND s.status='active'
        AND coalesce(to_jsonb(po)->>'delivery_kind','WAREHOUSE')='WAREHOUSE'
      FOR UPDATE OF po,s`,[ctx.workspaceId,orderId])).rows[0];
    if(!order)throw new NotFoundError('This purchase order or its active supplier was not found.');
    if(!shareStatuses.includes(order.status))throw new ValidationError('Approve the purchase order before sharing its supplier response link.');
    if(!hasEmail(order.email))throw new ValidationError('Add the supplier’s email address before sharing its response link.');
    await require('./dual-approval').guardOrderMessage(client,ctx.workspaceId,order.id);
    const url=await issue(client,ctx.workspaceId,order.id,order.email,origin);
    return {orderNumber:order.po_number,supplierName:order.supplier_name,supplierEmail:order.email,url};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function lookup(db,token,lock=false,{includeCompleted=false,includeClosed=false,includeReceived=false}={}){
  if(!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundError();
  const order=(await db.query(`SELECT po.id,po.workspace_id,po.po_number,po.expected_date,po.currency,po.status,
      l.token_hash,l.recipient,s.name AS supplier_name,coalesce(to_jsonb(po)->>'delivery_kind','WAREHOUSE') AS delivery_kind
      FROM stockchief_runtime.supplier_order_links l
    JOIN purchase_orders po ON po.id=l.purchase_order_id AND po.workspace_id=l.workspace_id
    JOIN suppliers s ON s.id=po.supplier_id AND s.workspace_id=po.workspace_id
    JOIN workspaces w ON w.id=po.workspace_id
    WHERE l.token_hash=$1 AND l.expires_at>now() AND lower(s.email)=l.recipient
      AND s.status='active' AND w.deletion_requested_at IS NULL
      AND (po.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED') OR
        $2::boolean AND po.status='RECEIVED' AND to_jsonb(po)->>'delivery_kind'='CUSTOMER_DIRECT' OR
        $3::boolean AND po.status IN ('RECEIVED','CANCELLED') OR $4::boolean AND po.status='RECEIVED')
      ${lock?'FOR UPDATE OF po,l':''}`,[hash(token),includeCompleted,includeClosed,includeReceived])).rows[0];
  if(!order) throw new NotFoundError('This supplier order link is no longer active.');
  return order;
}

async function submit(db,token,kind,value,{shipDate=null}={}){
  if(!['confirm','date','invoice','ship-notice'].includes(kind)) throw new ValidationError('Choose a valid response.');
  const file=['invoice','ship-notice'].includes(kind), date=file?null:value||null;
  if(file && (!Buffer.isBuffer(value) || value.length>4*1024*1024 || value.subarray(0,5).toString()!=='%PDF-'))
    throw new ValidationError('Choose a PDF no larger than 4 MB.');
  if(kind==='date' && !date) throw new ValidationError('Enter the proposed delivery date.');
  if(date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date))
    throw new ValidationError('Enter a valid delivery date.');
  if(shipDate&&(kind!=='confirm'||!require('./supplier-unavailability-mail-parser').validDate(shipDate)))
    throw new ValidationError('Use Confirm this order to send a valid planned ship date.');
  return db.transaction(async client=>{
    const order=await lookup(client,token,true,{includeReceived:file});
    const unavailable=kind==='confirm'&&(!date||shipDate)?(await client.query(`SELECT r.id FROM stockchief_runtime.supplier_link_submissions r
      JOIN stockchief_runtime.supplier_order_links l ON l.workspace_id=r.workspace_id AND l.token_hash=r.token_hash
      WHERE l.workspace_id=$1 AND l.purchase_order_id=$2 AND r.kind='unavailable' ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,
    [order.workspace_id,order.id])).rows[0]:null;
    const digest=responseFingerprint(kind,file?hash(value):date,shipDate,unavailable?.id),id=newId('supplierreply');
    // A supplier may receive another link for the same order. Replaying the
    // same document through it must not reserve storage or start intake again.
    const existing=file?await client.query(`SELECT 1 FROM stockchief_runtime.supplier_link_submissions r
      JOIN stockchief_runtime.supplier_order_links l ON l.workspace_id=r.workspace_id AND l.token_hash=r.token_hash
      WHERE l.workspace_id=$1 AND l.purchase_order_id=$2 AND l.recipient=$3 AND r.fingerprint=$4 LIMIT 1`,
    [order.workspace_id,order.id,order.recipient,digest]):
      await client.query('SELECT 1 FROM stockchief_runtime.supplier_link_submissions WHERE token_hash=$1 AND fingerprint=$2',[order.token_hash,digest]);
    if(existing.rowCount) return {saved:true};
    if(file) await require('../commercial/storage-capacity').reserve(client,order.workspace_id,'supplier-file:'+id,value.length,{finished:true});
    const saved=await client.query(`INSERT INTO stockchief_runtime.supplier_link_submissions(id,token_hash,kind,expected_date,contents,fingerprint,workspace_id${shipDate?',ship_date,availability_generation':''})
      VALUES($1,$2,$3,$4,$5,$6,$7${shipDate?',$8,$9':''}) ON CONFLICT(token_hash,fingerprint) DO NOTHING RETURNING id`,
      [id,order.token_hash,kind,date,file?value:null,digest,order.workspace_id,...(shipDate?[shipDate,unavailable?.id||null]:[])]);
    if(!saved.rowCount) return {saved:true};
    if(file) {
      const count=await client.query('SELECT count(*) AS n FROM stockchief_runtime.supplier_link_submissions WHERE token_hash=$1 AND contents IS NOT NULL',[order.token_hash]);
      if(Number(count.rows[0].n)>12) throw new ValidationError('The document limit for this supplier link has been reached.');

    }
    await client.query(`INSERT INTO purchase_order_events(id,workspace_id,purchase_order_id,event,detail,created_at)
      VALUES($1,$2,$3,$4,$5,$6)`,[newId('poevt'),order.workspace_id,order.id,'supplier_link_'+kind,JSON.stringify({submission:id,expectedDate:date,...(shipDate?{shipDate}:{})}),nowIso()]);
    if(!file&&date)await require('./agent-po-delivery-dates').enqueue(client,order.workspace_id,id);
    if(shipDate)await require('./agent-supplier-ship-promises').enqueue(client,order.workspace_id,id);
    if(kind==='invoice')await require('./supplier-portal-invoices').queue(client,order.workspace_id,id);
    return {saved:true};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function responses(db,workspaceId,orderId){
  const rows=(await db.query(`SELECT r.id,r.kind,r.expected_date::text,to_jsonb(r)->>'ship_date' AS ship_date,r.created_at FROM stockchief_runtime.supplier_link_submissions r
    JOIN stockchief_runtime.supplier_order_links l USING(token_hash)
    WHERE l.workspace_id=$1 AND l.purchase_order_id=$2 ORDER BY r.created_at DESC,r.id`,[workspaceId,orderId])).rows;
  const unavailable=rows.filter(row=>row.kind==='unavailable').map(row=>row.id);
  if(!unavailable.length)return rows;
  const evidence=(await db.query(`SELECT n.id,n.supplier_reply_id,n.evidence,n.valid_through::text,n.revoked_at,s.code,
    to_jsonb(n)->>'original_email_message_id' AS original_email_id
    FROM stockchief_runtime.agent_backup_supplier_notices n JOIN skus s ON s.workspace_id=n.workspace_id AND s.id=n.sku_id
    WHERE n.workspace_id=$1 AND n.purchase_order_id=$2 AND n.supplier_reply_id=ANY($3::text[])
    ORDER BY n.supplier_reply_id,s.code,n.id`,[workspaceId,orderId,unavailable])).rows;
  const byId=new Map();
  for(const notice of evidence){
    if(!byId.has(notice.supplier_reply_id))byId.set(notice.supplier_reply_id,[]);
    byId.get(notice.supplier_reply_id).push(notice);
  }
  return rows.map(row=>({...row,notices:byId.get(row.id)||[]}));
}
module.exports={issue,canShare,share,lookup,submit,responses,responseFingerprint};
