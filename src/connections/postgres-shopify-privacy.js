'use strict';
const crypto=require('node:crypto'),vault=require('./credentials'),jobs=require('../operations/postgres-job-queue');
const {newId}=require('../lib/util');
const {AuthenticationError,ValidationError,InvariantError,NotFoundError,AuthorizationError}=require('../domain/errors');
const TOPICS=new Set(['customers/data_request','customers/redact','shop/redact']);
const quote=value=>'"'+value.replaceAll('"','""')+'"';
const scoped=c=>({query:(sql,args)=>c.query(sql,args),transaction:fn=>fn(c)});
function application(profile){
 const prefix=profile==='public'?'SHOPIFY_PUBLIC':profile==='legacy'?'SHOPIFY':null;
 if(!prefix)throw new NotFoundError();
 return {id:process.env[prefix+'_CLIENT_ID'],secret:process.env[prefix+'_CLIENT_SECRET']};
}
function verify(profile,headers,raw){
 const app=application(profile),signature=String(headers['x-shopify-hmac-sha256']||'');
 if(!app.id||!app.secret)throw Object.assign(new Error('Shopify privacy signing credentials are not configured.'),{status:503});
 const expected=crypto.createHmac('sha256',app.secret).update(raw).digest('base64');
 if(!/^[A-Za-z0-9+/]{43}=$/.test(signature)||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw new AuthenticationError('This Shopify privacy request has an invalid signature.');
 const topic=String(headers['x-shopify-topic']||'');if(!TOPICS.has(topic))throw new ValidationError('Unsupported Shopify privacy topic.');
 let body;try{body=JSON.parse(raw.toString('utf8'));}catch{throw new ValidationError('A Shopify privacy request needs valid JSON.');}
 if(!body||typeof body!=='object'||Array.isArray(body))throw new ValidationError('A Shopify privacy request needs a JSON object.');
 const shop=String(body.shop_domain||'').toLowerCase();
 if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)||String(headers['x-shopify-shop-domain']||'').toLowerCase()!==shop)throw new AuthenticationError('The signed Shopify store identity does not match.');
 const id=value=>{if(value==null)return null;if(typeof value==='number'&&!Number.isSafeInteger(value))throw new ValidationError('The Shopify resource identity must retain its exact digits.');const result=String(value);if(!/^\d{1,30}$/.test(result))throw new ValidationError('Invalid Shopify resource identity.');return result;};
 const customer=body.customer||{},email=customer.email==null?null:String(customer.email).trim().toLowerCase();
 if(email&&(!email.includes('@')||email.length>320))throw new ValidationError('Invalid customer email.');
 const orders=body.orders_requested||body.orders_to_redact||[];if(!Array.isArray(orders))throw new ValidationError('Shopify order identities must be a list.');
 const payload={shopId:id(body.shop_id),customerId:id(customer.id),customerEmail:email,
  orderIds:orders.map(id),dataRequestId:id(body.data_request?.id)};
 if(!payload.shopId)throw new ValidationError('The Shopify store identity is required.');
 if(payload.orderIds.length>10000)throw new ValidationError('This request has too many order identities.');
 if(topic!=='shop/redact'&&!payload.customerId&&!payload.customerEmail&&!payload.orderIds.length)throw new ValidationError('A customer or order identity is required.');
 const delivery=String(headers['x-shopify-webhook-id']||headers['x-shopify-event-id']||payload.dataRequestId||crypto.createHash('sha256').update(raw).digest('hex'));
 if(delivery.length>160)throw new ValidationError('Invalid delivery identity.');
 return {appId:app.id,shop,topic,payload,delivery,hash:crypto.createHash('sha256').update(raw).digest('hex')};
}
async function receive(database,profile,headers,raw){
 const input=verify(profile,headers,raw),sealed=vault.encrypt(input.payload);
 return database.transaction(async c=>{
  const inserted=await c.query(`INSERT INTO shopify_privacy_requests(id,app_client_id,shop_domain,topic,delivery_id,payload_hash,ciphertext,iv,auth_tag)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,[newId('privacy'),input.appId,input.shop,input.topic,input.delivery,input.hash,sealed.ciphertext,sealed.iv,sealed.authTag]);
  const row=(await c.query('SELECT id,payload_hash FROM shopify_privacy_requests WHERE app_client_id=$1 AND shop_domain=$2 AND topic=$3 AND delivery_id=$4 FOR UPDATE',[input.appId,input.shop,input.topic,input.delivery])).rows[0];
  if(row.payload_hash!==input.hash)throw new InvariantError('A Shopify privacy delivery identity was reused with different content.');
  if(!inserted.rowCount)return {requestId:row.id,replayed:true};
  // Existing custom-app installations belong to the legacy app; a public-app
  // signature must never authorize operations on those installations.
  const connections=(await c.query(`SELECT workspace_id,id FROM workspace_connectors
   WHERE provider_type='shopify' AND provider_account_id=$1
   AND COALESCE(config::jsonb->>'shopifyClientId',$3)=$2`,[input.shop,input.appId,process.env.SHOPIFY_CLIENT_ID||''])).rows;
  for(const connection of connections){const work=newId('privacywork');
   await c.query('INSERT INTO shopify_privacy_work(id,request_id,workspace_id,connector_id) VALUES($1,$2,$3,$4)',[work,row.id,connection.workspace_id,connection.id]);
   await jobs.enqueue(scoped(c),{workspaceId:connection.workspace_id,kind:'system.shopify-privacy',idempotencyKey:'shopify-privacy:'+work,payload:{workId:work},priority:5,maxAttempts:8});
  }
  if(!connections.length)await c.query('UPDATE shopify_privacy_requests SET completed_at=now() WHERE id=$1',[row.id]);
  return {requestId:row.id,received:true,targets:connections.length};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function owner(c,ctx){const row=(await c.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];if(row?.role!=='owner')throw new AuthorizationError('Only an inventory owner can manage customer privacy requests.');}
async function list(database,ctx){await owner(database,ctx);return (await database.query(`SELECT w.id,w.status,w.result,w.hold_reason,w.hold_until,w.completed_at,r.topic,r.shop_domain,r.received_at,r.due_at
 FROM shopify_privacy_work w JOIN shopify_privacy_requests r ON r.id=w.request_id WHERE w.workspace_id=$1 ORDER BY r.due_at,w.id`,[ctx.workspaceId])).rows;}
async function records(c,work,payload){
 const mappings=(await c.query(`SELECT entity_type,external_id,foundry_record_id FROM connection_mappings WHERE workspace_id=$1 AND connector_id=$2 AND entity_type IN ('customer','sales_order')`,[work.workspace_id,work.connector_id])).rows;
 const all=work.topic==='shop/redact';
 const customerIds=mappings.filter(m=>m.entity_type==='customer'&&(all||m.external_id===payload.customerId)).map(m=>m.foundry_record_id);
 if(payload.customerEmail){for(const row of (await c.query(`SELECT DISTINCT c.id FROM customers c JOIN connection_mappings m ON m.workspace_id=c.workspace_id AND m.foundry_record_id=c.id AND m.entity_type='customer'
  WHERE c.workspace_id=$1 AND m.connector_id=$2 AND lower(c.email)=$3`,[work.workspace_id,work.connector_id,payload.customerEmail])).rows)customerIds.push(row.id);}
 const orderIds=mappings.filter(m=>m.entity_type==='sales_order'&&(all||payload.orderIds.includes(m.external_id))).map(m=>m.foundry_record_id);
 for(const row of (await c.query('SELECT id FROM sales_orders WHERE workspace_id=$1 AND customer_id=ANY($2::text[])',[work.workspace_id,customerIds])).rows)orderIds.push(row.id);
 const args=[work.workspace_id,[...new Set(customerIds)],[...new Set(orderIds)]],tables=(await c.query(`SELECT col.table_schema,col.table_name,col.column_name,col.data_type,col.is_nullable FROM information_schema.columns col
  JOIN information_schema.tables tab ON tab.table_schema=col.table_schema AND tab.table_name=col.table_name AND tab.table_type='BASE TABLE'
  WHERE col.table_schema IN ('public','stockchief_runtime') ORDER BY col.table_schema,col.table_name,col.ordinal_position`)).rows;
 const descriptors=new Map();for(const col of tables){const key=col.table_schema+'.'+col.table_name;if(!descriptors.has(key))descriptors.set(key,{schema:col.table_schema,name:col.table_name,columns:[]});descriptors.get(key).columns.push(col);}
 const selected=new Map(),add=(key,predicate)=>{const table=descriptors.get(key);if(table&&!selected.has(key))selected.set(key,{...table,predicate});};
 add('public.customers','id=ANY($2::text[])');add('public.sales_orders','id=ANY($3::text[])');
 for(const [key,table] of descriptors)if(table.columns.some(c=>c.column_name==='workspace_id')){
  if(table.columns.some(c=>c.column_name==='customer_id'))add(key,'customer_id=ANY($2::text[])');
  else if(table.columns.some(c=>c.column_name==='sales_order_id'))add(key,'sales_order_id=ANY($3::text[])');
 }
 const edges=(await c.query(`SELECT ns.nspname AS schema,cl.relname AS child,pns.nspname AS parent_schema,pcl.relname AS parent,
  a.attname AS child_column,pa.attname AS parent_column FROM pg_constraint co JOIN pg_class cl ON cl.oid=co.conrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace
  JOIN pg_class pcl ON pcl.oid=co.confrelid JOIN pg_namespace pns ON pns.oid=pcl.relnamespace
  JOIN LATERAL generate_subscripts(co.conkey,1) k(i) ON true JOIN pg_attribute a ON a.attrelid=cl.oid AND a.attnum=co.conkey[k.i]
  JOIN pg_attribute pa ON pa.attrelid=pcl.oid AND pa.attnum=co.confkey[k.i]
  WHERE co.contype='f' AND array_length(co.conkey,1)=1 AND ns.nspname IN ('public','stockchief_runtime')`)).rows;
 for(let depth=0;depth<8;depth++){const before=selected.size;for(const edge of edges){const parent=selected.get(edge.parent_schema+'.'+edge.parent),child=descriptors.get(edge.schema+'.'+edge.child);
  if(parent&&child?.columns.some(col=>col.column_name==='workspace_id'))add(edge.schema+'.'+edge.child,quote(edge.child_column)+' IN (SELECT '+quote(edge.parent_column)+' FROM '+quote(parent.schema)+'.'+quote(parent.name)+' WHERE workspace_id=$1 AND ('+parent.predicate+'))');
 }if(before===selected.size)break;}
 let count=0;const output=[];for(const table of selected.values()){
  const rows=(await c.query('SELECT ctid::text AS __privacy_tid,* FROM '+quote(table.schema)+'.'+quote(table.name)+' WHERE workspace_id=$1 AND cardinality($2::text[])>=0 AND cardinality($3::text[])>=0 AND ('+table.predicate+') LIMIT 5001',args)).rows;
  count+=rows.length;if(count>5000)throw new ValidationError('This privacy request needs a larger reviewed export. No data was changed.');
  if(rows.length)output.push({...table,rows});
 }
 return {tables:output,customerIds:args[1],orderIds:args[2]};
}
function exportValue(value){
 if(Array.isArray(value))return value.map(exportValue);
 if(typeof value==='string'&&/^[\[{]/.test(value.trim())){try{return exportValue(JSON.parse(value));}catch{return value;}}
 if(!value||typeof value!=='object')return value;
 if(value instanceof Date)return value.toISOString();
 const result={};for(const [key,entry] of Object.entries(value))if(!/(?:password|secret|token|ciphertext|auth.?tag|^iv$|__privacy_tid)/i.test(key))result[key]=exportValue(entry);
 return result;
}
async function processWork(database,job){
 return database.transaction(async c=>{
  const work=(await c.query(`SELECT w.*,r.topic,r.ciphertext,r.iv,r.auth_tag FROM shopify_privacy_work w JOIN shopify_privacy_requests r ON r.id=w.request_id WHERE w.workspace_id=$1 AND w.id=$2 FOR UPDATE OF w`,[job.workspaceId,job.payload?.workId])).rows[0];
  if(!work)throw new NotFoundError('That privacy request does not belong to this inventory.');
  if(['COMPLETED','READY','NEEDS_REVIEW'].includes(work.status))return {status:work.status,replayed:true};
  if(work.status==='HELD'&&new Date(work.hold_until)>new Date())return {status:'HELD'};
  const payload=vault.decrypt(work),result=await records(c,work,payload);
  const rawRows=(await c.query('SELECT * FROM connection_webhook_receipts WHERE workspace_id=$1 AND connector_id=$2 AND payload_purged_at IS NULL ORDER BY received_at LIMIT 5001',[job.workspaceId,work.connector_id])).rows;
  if(rawRows.length>5000)throw new ValidationError('This request needs a larger reviewed source export.');
  const providerRecords=[];for(const row of rawRows){const original=vault.decrypt(row),body=JSON.parse(Buffer.from(original.rawBody,'base64').toString('utf8'));if(matches(body,payload,work.topic==='shop/redact'))providerRecords.push({deliveryId:row.delivery_id,body:exportValue(body)});}
  const exported={topic:work.topic,generatedAt:new Date().toISOString(),records:result.tables.map(t=>({table:t.schema+'.'+t.name,rows:exportValue(t.rows)})),providerRecords};
  const sealed=vault.encrypt(exported),status=work.topic==='customers/data_request'?'READY':'NEEDS_REVIEW';
  await c.query(`UPDATE shopify_privacy_work SET status=$3,export_ciphertext=$4,export_iv=$5,export_auth_tag=$6,
   result=$7::jsonb,updated_at=now() WHERE workspace_id=$1 AND id=$2`,[job.workspaceId,work.id,status,sealed.ciphertext,sealed.iv,sealed.authTag,JSON.stringify({customerRecords:result.customerIds.length,orders:result.orderIds.length,linkedRecords:result.tables.reduce((n,t)=>n+t.rows.length,0),message:status==='READY'?'The encrypted customer export is ready for the store owner.':'Review the linked records and any legal retention obligations before erasing personal data.'})]);
  return {status};
 },{isolation:'REPEATABLE READ'});
}
async function download(database,ctx,id){return database.transaction(async c=>{await owner(c,ctx);const work=(await c.query('SELECT * FROM shopify_privacy_work WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];if(!work?.export_ciphertext)throw new NotFoundError('That privacy export is not ready or has expired.');
 await c.query("INSERT INTO shopify_privacy_access(id,workspace_id,work_id,actor_id,action) VALUES($1,$2,$3,$4,'EXPORT_DOWNLOADED')",[newId('privacyaccess'),ctx.workspaceId,id,ctx.actorId]);
 return vault.decrypt({ciphertext:work.export_ciphertext,iv:work.export_iv,auth_tag:work.export_auth_tag});});}
async function completeExport(database,ctx,id){return database.transaction(async c=>{await owner(c,ctx);const result=await c.query(`UPDATE shopify_privacy_work w SET status='COMPLETED',completed_at=now(),updated_at=now()
 FROM shopify_privacy_requests r WHERE w.workspace_id=$1 AND w.id=$2 AND r.id=w.request_id AND r.topic='customers/data_request' AND w.status='READY'
 AND EXISTS(SELECT 1 FROM shopify_privacy_access a WHERE a.work_id=w.id AND a.workspace_id=w.workspace_id AND a.action='EXPORT_DOWNLOADED') RETURNING w.request_id`,[ctx.workspaceId,id]);
 if(!result.rowCount)throw new ValidationError('Download the prepared customer export and provide it to the store owner before marking it delivered.');
 await c.query(`UPDATE shopify_privacy_requests r SET completed_at=now() WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM shopify_privacy_work w WHERE w.request_id=r.id AND w.status<>'COMPLETED')`,[result.rows[0].request_id]);
});}
function subjectHash(kind,value){return crypto.createHmac('sha256',require('../config').connectionEncryptionKey).update(kind+':'+String(value).toLowerCase()).digest('hex');}
function identities(body){return [body.customer?.id&&subjectHash('id',body.customer.id),(body.customer?.email||body.email)&&subjectHash('email',body.customer?.email||body.email)].filter(Boolean);}
async function filterBody(c,connection,body){
 if(connection.provider_type!=='shopify')return body;
 // These fields are unused by the importer and not requested for the public
 // app. Do not retain them even in encrypted raw working copies.
 const safe=structuredClone(body);delete safe.phone;delete safe.billing_address;
 if(safe.customer){for(const key of ['phone','addresses','default_address','sms_marketing_consent','email_marketing_consent','note','tags'])delete safe.customer[key];}
 for(const address of [safe.shipping_address,safe.destination])if(address){delete address.phone;delete address.first_name;delete address.last_name;delete address.name;}
 const hashes=identities(body);
 if(hashes.length&&(await c.query('SELECT 1 FROM shopify_privacy_subjects WHERE workspace_id=$1 AND connector_id=$2 AND subject_hash=ANY($3::text[]) LIMIT 1',[connection.workspace_id,connection.id,hashes])).rowCount){
  const redacted=require('./personal-data').workingCopy(safe);
  if(redacted.customer)redacted.customer.first_name='Deleted customer '+String(redacted.customer.id||'record');
  return redacted;
 }return safe;
}
function matches(body,payload,all){return all||Boolean(payload.customerId&&String(body.customer?.id||body.order?.customer?.id||'')===payload.customerId)||Boolean(payload.customerEmail&&[body.email,body.customer?.email,body.order?.email].some(email=>String(email||'').toLowerCase()===payload.customerEmail))||payload.orderIds.includes(String(body.order_id||body.order?.id||body.id||''));}
async function filterEvent(c,connection,workspaceId,event){
 if(connection.provider_type!=='shopify')return event;
 const data=event.data||{},id=data.customer?.externalId||data.customer?.id,email=data.customerEmail||data.customer?.email;
 const hashes=[id&&subjectHash('id',id),email&&subjectHash('email',email)].filter(Boolean);
 if(!hashes.length||!(await c.query('SELECT 1 FROM shopify_privacy_subjects WHERE workspace_id=$1 AND connector_id=$2 AND subject_hash=ANY($3::text[]) LIMIT 1',[workspaceId,connection.id,hashes])).rowCount)return event;
 const safe=require('./personal-data').workingCopy(data);if(safe.customer)safe.customer.name='Deleted customer '+String(id||'record');
 return {...event,data:safe};
}
function tokensFor(result,payload){return [...new Set([payload.customerEmail,...result.tables.filter(t=>t.name==='customers').flatMap(t=>t.rows.flatMap(row=>[row.name,row.email,row.phone,row.company,row.shipping_address]))].filter(v=>typeof v==='string'&&v.trim().length>=3))];}
function eraseValue(value,tokens){
 if(Array.isArray(value))return value.map(v=>eraseValue(v,tokens));
 if(value&&typeof value==='object'){if(value instanceof Date)return value;const result={};for(const [key,entry] of Object.entries(value))result[key]=eraseValue(entry,tokens);return require('./personal-data').workingCopy(result);}
 if(typeof value==='string'){let result=value;for(const token of tokens)result=result.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),'[removed]');return result;}
 return value;
}
async function erase(database,ctx,id){
 try{return await database.transaction(async c=>{
  await owner(c,ctx);const work=(await c.query(`SELECT w.*,r.topic,r.ciphertext,r.iv,r.auth_tag FROM shopify_privacy_work w JOIN shopify_privacy_requests r ON r.id=w.request_id WHERE w.workspace_id=$1 AND w.id=$2 FOR UPDATE OF w`,[ctx.workspaceId,id])).rows[0];
  if(!work)throw new NotFoundError();if(work.status==='COMPLETED')return {completed:true,replayed:true};
  if(work.topic==='customers/data_request')throw new ValidationError('Deliver the customer export instead of erasing this request.');
  if(work.hold_until&&new Date(work.hold_until)>new Date())throw new ValidationError('This request has an active legal retention hold.');
  const payload=vault.decrypt(work),all=work.topic==='shop/redact',result=await records(c,work,payload),tokens=tokensFor(result,payload);
  if(result.customerIds.length&&(await c.query(`SELECT 1 FROM connection_mappings WHERE workspace_id=$1 AND entity_type='customer' AND foundry_record_id=ANY($2::text[]) AND connector_id<>$3 LIMIT 1`,[ctx.workspaceId,result.customerIds,work.connector_id])).rowCount)throw new ValidationError('A customer is shared with another connection. Review the shared records before redaction.');
  const rawRows=(await c.query('SELECT * FROM connection_webhook_receipts WHERE workspace_id=$1 AND connector_id=$2 AND payload_purged_at IS NULL FOR UPDATE',[ctx.workspaceId,work.connector_id])).rows;
  for(const receipt of rawRows){const raw=vault.decrypt(receipt),body=JSON.parse(Buffer.from(raw.rawBody,'base64').toString('utf8'));if(!matches(body,payload,all))continue;
   if(receipt.status!=='COMPLETED')throw new ValidationError('A matching provider delivery is still unfinished. Resolve it before erasing its source evidence.');
   await c.query("UPDATE connection_webhook_receipts SET ciphertext='',iv='',auth_tag='',payload_purged_at=now(),error_message=NULL WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,receipt.id]);
  }
  // Stable identifiers and all stock, quantities and monetary facts remain.
  // Unknown files/immutable records fail the transaction and remain visibly
  // open for reviewed handling; they never produce a false completion.
  let changed=0;for(const table of result.tables)for(const row of table.rows){
   const updates=[],values=[ctx.workspaceId,row.__privacy_tid];
   for(const col of table.columns){const key=col.column_name,value=row[key];if(value==null||/(?:^id$|_id$|_at$|_hash$|^status$|^currency$|^record_state$)/.test(key))continue;
    if(/ciphertext|file_path|storage_path|pdf_bytes|document_bytes/.test(key))throw new ValidationError('A linked encrypted document or stored file needs reviewed deletion before this request can be completed.');
    let next=value;
    if(table.name==='customers'&&key==='name')next='Deleted customer '+row.id;
    else if(table.name==='customers'&&['email','phone','company','shipping_address','notes'].includes(key))next=null;
    else if(/email|phone|address|recipient_name|customer_name|customer_company|notes|memo/.test(key))next=col.is_nullable==='YES'?null:'';
    else if(['json','jsonb'].includes(col.data_type))next=eraseValue(value,tokens);
    else if(typeof value==='string'&&/payload|snapshot|body|content|detail|message|description|reference/.test(key)){
     try{next=JSON.stringify(eraseValue(JSON.parse(value),tokens));}catch{next=eraseValue(value,tokens);}
    }
    if(JSON.stringify(next)!==JSON.stringify(value)){values.push(['json','jsonb'].includes(col.data_type)?JSON.stringify(next):next);updates.push(quote(key)+'=$'+values.length+(['json','jsonb'].includes(col.data_type)?'::'+col.data_type:''));}
   }
   if(updates.length){await c.query('UPDATE '+quote(table.schema)+'.'+quote(table.name)+' SET '+updates.join(',')+' WHERE workspace_id=$1 AND ctid=$2::tid',values);changed++;}
  }
  const eventRows=(await c.query('SELECT id,payload,normalized_payload,status FROM connector_feed_events WHERE workspace_id=$1 AND connector_id=$2 FOR UPDATE',[ctx.workspaceId,work.connector_id])).rows;
  for(const event of eventRows){const body=typeof event.normalized_payload==='string'?JSON.parse(event.normalized_payload):event.normalized_payload;
   if(!all&&!matches({...body.data,customer:body.data?.customer,id:body.data?.externalOrderId},payload,false))continue;
   if(event.status!=='COMPLETED')throw new ValidationError('A matching imported event still needs reconciliation.');
   await c.query('UPDATE connector_feed_events SET payload=$3,normalized_payload=$4,error_message=NULL,personal_data_purged_at=now() WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,event.id,JSON.stringify(eraseValue(JSON.parse(event.payload),tokens)),JSON.stringify(eraseValue(body,tokens))]);
  }
  for(const hash of [payload.customerId&&subjectHash('id',payload.customerId),payload.customerEmail&&subjectHash('email',payload.customerEmail)].filter(Boolean))await c.query('INSERT INTO shopify_privacy_subjects(workspace_id,connector_id,subject_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ctx.workspaceId,work.connector_id,hash]);
  if(all){await c.query("UPDATE workspace_connectors SET status='disconnected',paused_at=$3,updated_at=$3,last_error=NULL WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,work.connector_id,new Date().toISOString()]);await c.query('DELETE FROM connection_credentials WHERE workspace_id=$1 AND connector_id=$2',[ctx.workspaceId,work.connector_id]);}
  await c.query("UPDATE shopify_privacy_work SET status='COMPLETED',completed_at=now(),updated_at=now(),export_ciphertext=NULL,export_iv=NULL,export_auth_tag=NULL,result=$3::jsonb WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,JSON.stringify({personalRecordsRedacted:changed,financialAndStockFactsPreserved:true})]);
  await c.query("INSERT INTO shopify_privacy_access(id,workspace_id,work_id,actor_id,action) VALUES($1,$2,$3,$4,'PERSONAL_DATA_REDACTED')",[newId('privacyaccess'),ctx.workspaceId,id,ctx.actorId]);
  await c.query(`UPDATE shopify_privacy_requests r SET completed_at=now() WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM shopify_privacy_work w WHERE w.request_id=r.id AND w.status<>'COMPLETED')`,[work.request_id]);
  return {completed:true,personalRecordsRedacted:changed};
 },{isolation:'SERIALIZABLE',retrySafe:true});
 }catch(error){if(error instanceof ValidationError||['P0001','23000','23514','23502'].includes(error.code)){
  await database.query("UPDATE shopify_privacy_work SET status='NEEDS_REVIEW',result=jsonb_build_object('message',$3::text),updated_at=now() WHERE workspace_id=$1 AND id=$2 AND status NOT IN ('COMPLETED','HELD')",[ctx.workspaceId,id,error instanceof ValidationError?error.message:'A protected business record needs reviewed handling. No redaction was committed.']);
 }throw error;}
}
async function hold(database,ctx,id,input){return database.transaction(async c=>{await owner(c,ctx);const reason=String(input.reason||'').trim(),until=new Date(input.until);
 if(reason.length<20||reason.length>1000||!Number.isFinite(until.getTime())||until<=new Date())throw new ValidationError('Describe the legal obligation and choose a future review date.');
 const updated=await c.query("UPDATE shopify_privacy_work SET status='HELD',hold_reason=$3,hold_until=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND status<>'COMPLETED' RETURNING id",[ctx.workspaceId,id,reason,until.toISOString()]);if(!updated.rowCount)throw new NotFoundError();
 await c.query("INSERT INTO shopify_privacy_access(id,workspace_id,work_id,actor_id,action) VALUES($1,$2,$3,$4,'LEGAL_HOLD_RECORDED')",[newId('privacyaccess'),ctx.workspaceId,id,ctx.actorId]);
});}
module.exports={receive,verify,list,processWork,download,completeExport,records,owner,quote,scoped,erase,hold,filterBody,filterEvent,subjectHash,exportValue};
