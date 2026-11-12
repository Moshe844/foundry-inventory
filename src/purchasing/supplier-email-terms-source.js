'use strict';
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors'),policy=require('../commercial/agent-plan'),{hash}=require('../pricing/postgres-promotions');
const labels={lead_time_days:'Lead time (days)',minimum_order_quantity:'Minimum order (purchase units)',units_per_purchase_unit:'Pack size (stock units per purchase unit)',default_lead_time_days:'Supplier lead time (days)',contact_name:'Contact name',phone:'Contact phone',email:'Order email address'};
const numeric=new Set(['lead_time_days','minimum_order_quantity','units_per_purchase_unit','default_lead_time_days']),itemFields=new Set(['lead_time_days','minimum_order_quantity','units_per_purchase_unit']);
const unclear=()=>new ValidationError('Review the original supplier email. Use an effective date, exact SKU or supplier SKU, purchase unit, and clearly labelled lead times or minimum order quantities. Prices, payment terms and other instructions need separate review.');
const isSubject=value=>/^(?:supplier (?:terms|details) update|lead time and minimum order update)(?:\s*[:#-]\s*[\w.-]+)?[.!]?$/i.test(String(value||'').trim());
function decimal(value,max=100000){const text=String(value??'').trim();if(!/^\d{1,6}(?:\.\d{1,6})?$/.test(text)||Number(text)>max)throw unclear();return Number(text);}
function parse(subject,text){
 if(!isSubject(subject)||typeof text!=='string'||text.length>30000)throw unclear();
 const raw=text.split(/\r?\n/),fields={},rows=[];let header=-1;
 for(let index=0;index<raw.length;index++){
  const line=raw[index].trim();if(!line||/^(?:hello|hi|thanks|thank you|regards)[,.!]?$/i.test(line))continue;
  if(/^(?:SKU|Supplier SKU)\s*[,|;\t]/i.test(line)){header=index;break;}
  const match=/^(Effective date|Contact name|Contact phone)\s*:\s*(.+)$/i.exec(line);if(!match)throw unclear();
  const key=match[1].toLowerCase();if(Object.hasOwn(fields,key))throw unclear();fields[key]=match[2].trim();
 }
 const effectiveDate=fields['effective date'];
 if(!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate||'')||!Number.isFinite(Date.parse(effectiveDate))||new Date(effectiveDate).toISOString().slice(0,10)!==effectiveDate)throw unclear();
 const contact={};if(fields['contact name']){if(fields['contact name'].length>200||/[\x00-\x1f]/.test(fields['contact name']))throw unclear();contact.contact_name=fields['contact name'];}
 if(fields['contact phone']){if(!/^\+?[\d ()-]{5,35}(?:\s*(?:x|ext\.?)[ ]*\d{1,8})?$/i.test(fields['contact phone']))throw unclear();contact.phone=fields['contact phone'];}
 if(header>=0){
  const delimiter=raw[header].includes('|')?'|':raw[header].includes('\t')?'\t':raw[header].includes(';')?';':',';
  const grid=require('../imports/parser').parseDelimited([raw[header],...raw.slice(header+1).filter(line=>line.trim()&&!/^(?:thanks|thank you|regards)[,.!]?$/i.test(line.trim()))].join('\n'),delimiter),head=grid[0].map(value=>String(value).trim().toLowerCase()),used=new Set();
  const codes=head[0]==='sku'?'sku':head[0]==='supplier sku'?'supplierSku':null,allowed=new Map([['lead time days','lead_time_days'],['minimum order quantity','minimum_order_quantity']]);
  if(!codes||head[1]!=='purchase unit'||head.length<3||head.length>4||new Set(head).size!==head.length||head.slice(2).some(field=>!allowed.has(field))||grid.length<2||grid.length>101)throw unclear();
  for(const row of grid.slice(1)){
   const code=String(row[0]||'').trim(),purchaseUnit=String(row[1]||'').trim(),values={};
   if(row.length!==head.length||!code||code.length>160||!purchaseUnit||purchaseUnit.length>80||used.has(code.toLowerCase()))throw unclear();used.add(code.toLowerCase());
   for(let i=2;i<head.length;i++){if(String(row[i]??'').trim()==='')continue;const field=allowed.get(head[i]),value=decimal(row[i],field==='lead_time_days'?365:100000);if(field==='lead_time_days'&&!Number.isInteger(value))throw unclear();values[field]=value;}
   if(!Object.keys(values).length)throw unclear();rows.push({codeType:codes,code,purchaseUnit,values});
  }
 }
 if(!rows.length&&!Object.keys(contact).length)throw unclear();
 return {effectiveDate,contact,rows};
}
async function owner(db,ctx){
 const user=(await db.query(`SELECT u.* FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
  WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL) FOR SHARE OF u,w`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!user)throw new AuthorizationError('Only the inventory owner can authorize supplier email updates.');
 require('../actions/permissions').assertCan(user,require('../actions/permissions').MANAGE_SUPPLIERS,'update supplier details');
 return user;
}
function product(row){return {skuId:row.sku_id,code:row.code,supplierSku:row.supplier_sku,purchaseUnit:row.purchase_unit,unitsPerPurchaseUnit:String(row.units_per_purchase_unit),unit:row.unit_label};}
async function catalog(db,workspaceId,supplierId){return (await db.query(`SELECT si.*,s.code,i.name,i.unit_label FROM supplier_items si
 JOIN skus s ON s.workspace_id=si.workspace_id AND s.id=si.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 WHERE si.workspace_id=$1 AND si.supplier_id=$2 AND si.is_active=1 AND s.is_active=1 AND i.is_active=1 ORDER BY si.sku_id LIMIT 1001`,[workspaceId,supplierId])).rows;}
async function facts(db,ctx,id){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,96,'draft');
 const message=(await db.query(`SELECT m.*,c.provider_account_id,c.provider_type,c.status AS connector_status,c.paused_at FROM connection_email_messages m
 JOIN workspace_connectors c ON c.workspace_id=m.workspace_id AND c.id=m.connector_id WHERE m.workspace_id=$1 AND m.id=$2`,[ctx.workspaceId,id])).rows[0];
 if(!message)throw new NotFoundError('That supplier email is not in this inventory.');
 if(message.trust_status!=='TRUSTED'||message.classification!=='supplier'||!message.supplier_id||message.connector_status!=='connected'||message.paused_at||!message.provider_account_id||!['gmail','microsoft365'].includes(message.provider_type))throw new ValidationError('Confirm the known supplier and connected Gmail or Microsoft 365 source mailbox first.');
 const suppliers=(await db.query("SELECT * FROM suppliers WHERE workspace_id=$1 AND status='active' AND lower(email)=lower($2) LIMIT 2",[ctx.workspaceId,message.sender])).rows;
 if(suppliers.length!==1||suppliers[0].id!==message.supplier_id)throw new ValidationError('This email must match one active known supplier and their current email address.');
 // Job 96: attachments are read too. Wait until every attached file has been read;
 // an unreadable file goes to a person so no instruction is missed.
 const attachments=(await db.query("SELECT id,filename,content_hash,extraction_status,extracted_text FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2 AND coalesce(external_attachment_id,'') NOT LIKE 'stockchief:%' ORDER BY id",[ctx.workspaceId,id])).rows;
 if(attachments.some(a=>a.extraction_status==='PENDING'))throw Object.assign(new ValidationError('StockChief is still reading the attached files. It checks the supplier details again when reading finishes.'),{waiting:true});
 const supplier=suppliers[0],products=await catalog(db,ctx.workspaceId,supplier.id),changes=[],structured=isSubject(message.subject),text=require('./supplier-detail-text');
 const unreadable=attachments.filter(a=>a.extraction_status!=='READABLE').map(a=>({source:a.filename,quote:a.filename,reason:'This attached file could not be read. Open it and check it yourself.'}));
 const read=text.read([...(structured?[]:[{kind:'body',source:'Email',text:message.body_text||''}]),...attachments.filter(a=>a.extraction_status==='READABLE').map(a=>({kind:'attachment',source:a.filename,text:a.extracted_text||''}))],{products,subjectCue:structured});
 let effectiveDate=null;
 if(structured){
  const parsed=parse(message.subject,message.body_text);effectiveDate=parsed.effectiveDate;
  const lines=[];
  for(const line of parsed.rows){
   const candidates=products.filter(row=>String(line.codeType==='sku'?row.code:row.supplier_sku||'').toLowerCase()===line.code.toLowerCase());
   if(candidates.length!==1||candidates[0].purchase_unit.toLowerCase()!==line.purchaseUnit.toLowerCase())throw new ValidationError('Match every code to one active supplier product and its exact purchase unit. A case minimum is counted in cases, not individual stock units.');
   for(const [field,value]of Object.entries(line.values))lines.push({source:'Email',quote:line.code+' '+labels[field]+' '+value,row:candidates[0],field,value});
  }
  for(const [field,value]of Object.entries(parsed.contact))lines.push({source:'Email',quote:labels[field]+': '+value,row:null,field,value});
  read.found.unshift(...lines);
 }
 const dates=[...new Set(read.effective.filter(Boolean))];
 if(!structured&&dates.length>1)throw new ValidationError('The supplier gives more than one start date ('+dates.join(', ')+'). Check with the supplier before changing records.');
 const receivedAt=new Date(message.received_at);if(!Number.isFinite(+receivedAt)||+receivedAt>Date.now()+300000)throw new ValidationError('The provider email date needs review before updating supplier records.');
 if(!effectiveDate)effectiveDate=dates[0]||(await require('../lib/business-time').forWorkspace(db,ctx.workspaceId,receivedAt)).calendarDate;
 const seen=new Map(),unclear=[...unreadable,...read.unclear.map(({source,quote,reason})=>({source,quote,reason}))];
 for(const f of read.found){
  const key=(f.row?f.row.id:supplier.id)+':'+f.field,value=f.field==='email'?String(f.value).toLowerCase():f.value;
  if(seen.has(key)){if(JSON.stringify(seen.get(key))!==JSON.stringify(value))throw new ValidationError('The supplier gives different values for '+labels[f.field].toLowerCase()+(f.row?' on '+f.row.code:'')+' ('+seen.get(key)+' and '+value+'). Check with the supplier before changing records.');continue;}
  seen.set(key,value);
  const raw=f.row?f.row[f.field]:supplier[f.field],before=raw===null||raw===undefined||raw===''?null:numeric.has(f.field)?Number(raw):raw;
  if(f.statedBefore!==undefined&&f.statedBefore!==null&&before!==null&&Number(f.statedBefore)!==Number(before))unclear.push({source:f.source,quote:f.quote,reason:'The supplier says the old '+labels[f.field].toLowerCase()+' was '+f.statedBefore+', but StockChief has '+before+'.'});
  changes.push(f.row?{targetId:f.row.id,skuId:f.row.sku_id,product:product(f.row),name:f.row.name,field:f.field,value,before,updatedAt:f.row.updated_at,source:f.source,quote:f.quote}
   :{targetId:supplier.id,skuId:null,field:f.field,value,before,updatedAt:supplier.updated_at,source:f.source,quote:f.quote});
 }
 const supplierLead=changes.find(c=>c.field==='default_lead_time_days');
 if(supplierLead){const own=products.filter(r=>r.lead_time_days!==null&&Number(r.lead_time_days)!==supplierLead.value&&!changes.some(c=>c.targetId===r.id&&c.field==='lead_time_days'));
  if(own.length)unclear.push({source:supplierLead.source,quote:supplierLead.quote,reason:own.length+' of this supplier’s products have their own lead time ('+own.slice(0,5).map(r=>r.code).join(', ')+(own.length>5?', …':'')+'). The supplier did not say whether those change too.'});}
 const emailChange=changes.find(c=>c.field==='email'&&c.before!==c.value);
 if(emailChange&&(await db.query("SELECT 1 FROM suppliers WHERE workspace_id=$1 AND id<>$2 AND status='active' AND lower(email)=lower($3) LIMIT 1",[ctx.workspaceId,supplier.id,emailChange.value])).rowCount)unclear.push({source:emailChange.source,quote:emailChange.quote,reason:'Another supplier already uses '+emailChange.value+'.'});
 const other=read.other.map(({source,quote,reason})=>({source,quote,reason}));
 if(!changes.length&&!unclear.length)throw Object.assign(new ValidationError(other.length?'This supplier email mentions prices, payment or other terms. Those always need a person and are not changed here.':'This supplier email does not state new lead times, minimum orders, pack sizes or contact details.'),{notRelevant:true});
 const evidence={messageId:id,supplierId:supplier.id,supplierName:supplier.name,supplierEmail:supplier.email,connectorId:message.connector_id,mailboxAccount:message.provider_account_id,providerType:message.provider_type,sender:message.sender,subject:message.subject,sourceHash:message.content_hash,bodyHash:hash(message.body_text),
  ...(attachments.length||!structured?{attachments:attachments.map(a=>({id:a.id,filename:a.filename,contentHash:a.content_hash,textHash:a.extracted_text?hash(a.extracted_text):null})),freeForm:!structured,unclear,other}:{}),
  receivedAt:receivedAt.toISOString(),effectiveDate,changes:structured&&!attachments.length?changes.map(({source,quote,...c})=>c):changes};
 const instructionHash=hash({...evidence,changes:evidence.changes.map(({before,updatedAt,...row})=>row)});
 return {...evidence,unclear,other,instructionHash,sourceFingerprint:hash(evidence)};
}
// The supplier's email is also where purchase orders are sent, so a new
// address is a possible payment redirect. It never changes without a person.
const personOnly=new Set(['email']);
module.exports={parse,isSubject,owner,facts,catalog,product,labels,decimal,numeric,itemFields,personOnly};
