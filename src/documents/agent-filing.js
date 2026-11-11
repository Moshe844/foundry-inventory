'use strict';
const {createHash}=require('node:crypto'),{newId}=require('../lib/util'),{ValidationError,NotFoundError,AuthorizationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan'),kinds=['other','packing_slip','bill_of_lading','customs','specification','safety_sheet','contract'];
const targets={purchase_order:{table:'purchase_orders',reference:'po_number',party:'supplier_id',path:'/purchasing/orders/'},sales_order:{table:'sales_orders',reference:'order_number',party:'customer_id',path:'/orders/'},item:{table:'items',reference:'name',path:'/inventory/'}};
const digest=v=>createHash('sha256').update(v).digest('hex');
function job(kind){return ['bill_of_lading','customs'].includes(kind)?137:142;}
async function owner(db,ctx){if(!(await db.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId])).rowCount)throw new AuthorizationError('Only the inventory owner can file or open these business documents.');}
async function source(db,ctx,id,lock=false){
 const row=(await db.query(`SELECT a.*,m.supplier_id,m.trust_status,CASE WHEN m.classification='customer' THEN
  (SELECT min(c.id) FROM customers c WHERE c.workspace_id=m.workspace_id AND lower(c.email)=lower(m.sender) AND c.record_state='ACTIVE' HAVING count(*)=1) END AS customer_id
  FROM connection_email_attachments a JOIN connection_email_messages m ON m.workspace_id=a.workspace_id AND m.id=a.message_id WHERE a.workspace_id=$1 AND a.id=$2`+(lock?' FOR SHARE OF a,m':''),[ctx.workspaceId,id])).rows[0];
 if(!row||!Buffer.isBuffer(row.content)||!row.content.length)throw new ValidationError('Choose an exact saved attachment with its original file in this inventory.');
 if(row.extraction_status!=='READABLE'||!row.extracted_text?.trim())throw new ValidationError('Read the complete attachment before filing it. Unreadable documents stay in review.');
 if(row.content.length>20*1024*1024||row.extracted_text.length>180000||digest(row.content)!==row.content_hash)throw new ValidationError('The original document is too large or its saved contents do not match. Review the source again.');
 return row;
}
async function target(db,ctx,kind,id){const type=targets[kind];if(!type)throw new ValidationError('Choose a purchase order, customer order or product.');const row=(await db.query('SELECT * FROM '+type.table+' WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];if(!row)throw new NotFoundError('The document target is not in this inventory.');return row;}
async function build(db,ctx,row,args,kind){
 await owner(db,ctx);let documentKind=args.documentKind||'other';if(!kinds.includes(documentKind))throw new ValidationError('Choose a supported document type.');
 await policy.requireWorkspaceJob(db,ctx.workspaceId,142,'draft');
 const s=await source(db,ctx,args.fileAttachment);
 // An omitted or relabelled document type cannot lower the source's plan ceiling.
 const proof=require('./shipping-document-proof'),visible=proof.inspect([{page:1,text:s.extracted_text,sourceKind:'text'}]);
 if(visible.kind)documentKind=visible.kind;
 else if(visible.headings.length&&job(documentKind)!==137)throw new ValidationError('This source includes shipping paperwork. Choose its exact type and purchase order.');
 else if(/^\s*bill\s+of\s+lading\b/im.test(s.extracted_text))documentKind='bill_of_lading';
 else if(/^\s*customs\s+(declaration|entry|papers?|clearance)\b/im.test(s.extracted_text))documentKind='customs';
 if(job(documentKind)===137&&visible.unrelated)throw new ValidationError('This original identifies a different business document type. Use its matching filing workflow.');
 if(job(documentKind)===137&&kind!=='purchase_order')throw new ValidationError('File bills of lading and customs papers on their purchase order.');
 await policy.requireWorkspaceJob(db,ctx.workspaceId,job(documentKind),'draft');
 const type=targets[kind],reference=row[type.reference];
 const party=type.party?row[type.party]:null;
 if(type.party&&s[type.party]&&s[type.party]!==party)throw new ValidationError('The attachment belongs to a different '+(kind==='purchase_order'?'supplier':'customer')+'.');
 let identifiers=[reference];if(kind==='item')identifiers=(await db.query('SELECT code FROM skus WHERE workspace_id=$1 AND item_id=$2',[ctx.workspaceId,row.id])).rows.map(r=>r.code);
 const mentioned=identifiers.some(code=>code&&new RegExp('(?<![A-Za-z0-9])'+String(code).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![A-Za-z0-9])','i').test(s.extracted_text));
 let proven=mentioned;
 if(job(documentKind)===137){
  proven=false;
  try{
   const pages=await require('./contract-source').read({filename:s.filename,buffer:s.content});
   const printed=proof.inspect(pages);
   proven=printed.kind===documentKind&&printed.headings.some(h=>!h.uncertain)&&printed.references.length>0&&
    printed.references.every(r=>!r.uncertain&&proof.normalized(r.value)===proof.normalized(reference))&&!printed.issues.length;
  }catch(error){if(error.code!=='validation_error')throw error;}
 }
 const needsTargetConfirmation=!proven||s.trust_status!=='TRUSTED'||(kind==='purchase_order'&&documentKind==='other')||(type.party?!s[type.party]:!s.supplier_id);
 return {payload:{recordId:row.id,targetKind:kind,targetReference:reference,attachmentId:s.id,messageId:s.message_id,sourceHash:s.content_hash,textHash:digest(s.extracted_text),filename:s.filename,documentKind,needsTargetConfirmation},
  summary:'File '+s.filename+' on '+reference+'. Save the original document and its readable text.'+(needsTargetConfirmation?' Confirm that this is the right record; the source does not independently prove the match.':' The source identifies this record.')+' This files evidence only; it does not record stock, an invoice, payment or changed terms.'};
}
async function execute(db,ctx,p){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,job(p.documentKind),'draft');
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['file-document:'+ctx.workspaceId+':'+p.sourceHash+':'+p.targetKind+':'+p.recordId]);
 const existing=(await db.query('SELECT id FROM stockchief_runtime.agent_filed_documents WHERE workspace_id=$1 AND source_hash=$2 AND target_kind=$3 AND target_id=$4',[ctx.workspaceId,p.sourceHash,p.targetKind,p.recordId])).rows[0];if(existing)return {documentId:existing.id,replayed:true};
 const s=await source(db,ctx,p.attachmentId,true),row=await target(db,ctx,p.targetKind,p.recordId),fresh=await build(db,ctx,row,{fileAttachment:s.id,documentKind:p.documentKind},p.targetKind);
 const {idempotencyKey,...approved}=p;
 if(require('../pricing/postgres-promotions').hash(fresh.payload)!==require('../pricing/postgres-promotions').hash(approved))throw new ValidationError('The source document or target changed after review. Prepare a fresh filing approval.');
 const id=newId('filed');await require('../commercial/storage-capacity').reserve(db,ctx.workspaceId,'filed-document:'+id,s.content.length+Buffer.byteLength(s.extracted_text,'utf8')+8192,{finished:true});
 await db.query(`INSERT INTO stockchief_runtime.agent_filed_documents(id,workspace_id,source_attachment_id,source_message_id,source_hash,source_text_hash,filename,mime_type,content,extracted_text,document_kind,target_kind,target_id,target_reference,filed_by)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[id,ctx.workspaceId,s.id,s.message_id,s.content_hash,p.textHash,s.filename,s.mime_type,s.content,s.extracted_text,p.documentKind,p.targetKind,p.recordId,p.targetReference,ctx.actorId]);
 await require('../operations/postgres-security-audit').record(db,ctx,{action:'Business document filed',reference:id,after:{filename:s.filename,record:p.targetReference,kind:p.documentKind}});
 return {documentId:id,href:'/autopilot/documents/'+id};
}
async function verify(db,ctx,r,p){return Boolean(r.documentId&&(await db.query('SELECT 1 FROM stockchief_runtime.agent_filed_documents WHERE workspace_id=$1 AND id=$2 AND target_kind=$3 AND target_id=$4 AND source_hash=$5',[ctx.workspaceId,r.documentId,p.targetKind,p.recordId,p.sourceHash])).rowCount);}
async function load(db,ctx,id){await owner(db,ctx);const row=(await db.query('SELECT * FROM stockchief_runtime.agent_filed_documents WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];if(!row)throw new NotFoundError('This filed document is not in this inventory.');if(digest(row.content)!==row.source_hash||digest(row.extracted_text)!==row.source_text_hash)throw new ValidationError('This filed document needs an integrity review before it can be opened.');return {...row,targetHref:targets[row.target_kind].path+row.target_id};}
async function forRecord(db,ctx,kind,id,after=''){
 await owner(db,ctx);const record=await target(db,ctx,kind,id);let cursor=null;
 if(after){if(typeof after!=='string'||after.length>120)throw new ValidationError('Choose a valid document page.');cursor=(await db.query('SELECT created_at::text AS created_at FROM stockchief_runtime.agent_filed_documents WHERE workspace_id=$1 AND target_kind=$2 AND target_id=$3 AND id=$4',[ctx.workspaceId,kind,id,after])).rows[0];if(!cursor)throw new ValidationError('Reopen the document list before continuing.');}
 const rows=(await db.query(`SELECT id,filename,document_kind,created_at,jsonb_array_length(product_facts) AS fact_count FROM stockchief_runtime.agent_filed_documents WHERE workspace_id=$1 AND target_kind=$2 AND target_id=$3 AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5)) ORDER BY created_at DESC,id DESC LIMIT 51`,[ctx.workspaceId,kind,id,cursor?.created_at||null,after])).rows;
 return {reference:record[targets[kind].reference],targetHref:targets[kind].path+id,rows:rows.slice(0,50),next:rows.length>50?rows[49].id:null};
}
async function directory(db,ctx,after=''){
 await owner(db,ctx);let cursor=null;
 if(after){if(typeof after!=='string'||after.length>120)throw new ValidationError('Choose a valid document page.');cursor=(await db.query('SELECT created_at::text AS created_at FROM stockchief_runtime.agent_filed_documents WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,after])).rows[0];if(!cursor)throw new ValidationError('Reopen the document list before continuing.');}
 const rows=(await db.query(`SELECT id,filename,document_kind,created_at,target_kind,target_id,target_reference,jsonb_array_length(product_facts) AS fact_count FROM stockchief_runtime.agent_filed_documents WHERE workspace_id=$1 AND ($2::timestamptz IS NULL OR created_at<=$2::timestamptz AND (created_at<$2::timestamptz OR id>$3)) ORDER BY created_at DESC,id LIMIT 51`,[ctx.workspaceId,cursor?.created_at||null,after])).rows;
 for(const row of rows)row.targetHref=targets[row.target_kind].path+row.target_id;
 return {reference:'this inventory',targetHref:'/inventory',rows:rows.slice(0,50),next:rows.length>50?rows[49].id:null};
}
async function review(db,ctx,{page=1,filter=''},onlyShipping=false){
 const history=await require('../commercial/agent-history').access(db,ctx.workspaceId);
 const rows=(await db.query(`SELECT filename AS "Document",replace(document_kind,'_',' ') AS "Type",target_reference AS "Filed on",created_at::date::text AS "Filed",'/autopilot/documents/'||id AS link FROM stockchief_runtime.agent_filed_documents
  WHERE workspace_id=$1 AND ($2='' OR lower(target_reference)=lower($2)) AND (NOT $3 OR document_kind IN ('bill_of_lading','customs')) AND ($4::timestamptz IS NULL OR created_at>=$4::timestamptz) ORDER BY created_at DESC,id LIMIT 101 OFFSET $5`,[ctx.workspaceId,filter,onlyShipping,history.activityAfter,(page-1)*100])).rows;
 return {rows:rows.slice(0,100),more:rows.length>100,summary:'Original filed documents and readable source text. Filing evidence does not confirm physical stock, an invoice, payment or new commercial terms.'};
}
const specs=Object.keys(targets).map(kind=>({name:'document.file_to_'+kind,record:kind,fields:['recordReference','fileAttachment','documentKind'],permission:require('../actions/permissions').ADMIN,ownerOnly:true,capability:'inventory.core',resultingRecords:['agent_filed_documents'],description:'File an exact readable mailbox attachment on the named '+kind.replace('_',' ')+'. Preserve the original file and text independently of the mailbox. Unproven target matches require individual confirmation. Never infer a receipt, invoice, payment or accepted terms.',build:(db,ctx,row,args)=>build(db,ctx,row,args,kind),execute,verify}));
module.exports={specs,job,load,forRecord,directory,definitions:[{id:142,key:'filed-documents',label:'Documents filed on business records',filterLabel:'Order number or product name',readPage:review},{id:137,key:'shipping-documents',label:'Bills of lading and customs papers',filterLabel:'Purchase order number',readPage:(db,ctx,o)=>review(db,ctx,o,true)}]};
