'use strict';
const {ValidationError}=require('../domain/errors'),money=require('../domain/currency'),{createHash}=require('node:crypto');
const digest=v=>createHash('sha256').update(v).digest('hex'),same=require('node:util').isDeepStrictEqual;
function field(text,labels){
 const matches=[...text.matchAll(new RegExp('^\\s*(?:'+labels+')\\s*:\\s*([^\\r\\n]+)\\s*$','gim'))];
 if(matches.length!==1)throw new ValidationError('The invoice needs one clear '+labels.replace(/[()?:|\\]/g,' ')+' field before it can run automatically.');
 return matches[0][1].trim();
}
function parse(text){
 const currency=money.code(field(text,'Currency')),amount=(v,label)=>money.userToMinor(v,currency,{label});
 const invoiceNumber=field(text,'(?:Supplier )?Invoice (?:number|no\\.?)'),purchaseOrder=field(text,'Purchase order|PO number'),issueDate=field(text,'Issue date|Invoice date'),dueDate=field(text,'Due date');
 const total=amount(field(text,'Invoice total|Grand total|Total'),'Document total'),tax=amount(field(text,'Tax|Tax total'),'Document tax');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)||!/^\d{4}-\d{2}-\d{2}$/.test(dueDate))throw new ValidationError('Confirm unambiguous invoice and due dates before automatic posting.');
 const lines=text.split(/\r?\n/),header=lines.findIndex(l=>/^\s*SKU\s*[,|\t]\s*Quantity\s*[,|\t]\s*Unit (?:price|cost)\s*[,|\t]\s*Line total\s*$/i.test(l));
 if(header<0)throw new ValidationError('The source item table needs an exact SKU, quantity, unit price and line total. Review this layout individually.');
 const delimiter=lines[header].includes('|')?'|':lines[header].includes('\t')?'\t':',',grid=require('../imports/parser').parseDelimited(lines.slice(header).join('\n'),delimiter).filter(r=>r.some(c=>String(c).trim()));
 if(grid.length<2||grid.length>501)throw new ValidationError('Review this invoice’s complete item table individually.');
 const rows=grid.slice(1).map(r=>{
  if(r.length!==4||!String(r[0]).trim()||!/^\d+(?:\.\d{1,6})?$/.test(String(r[1]).trim()))throw new ValidationError('An invoice item or quantity is unclear. Review the original table.');
  const quantity=Number(r[1]),unitCostMinor=amount(r[2],'Source unit price'),lineTotalMinor=amount(r[3],'Source line total');
  if(quantity<=0||unitCostMinor<0||require('../pricing/calculator').ratio(unitCostMinor,Math.round(quantity*1000000),1000000)!==lineTotalMinor)throw new ValidationError('An invoice line does not reconcile exactly.');
  return {code:String(r[0]).trim(),quantity,unitCostMinor,lineTotalMinor};
 });
 if(money.sum(rows.map(r=>r.lineTotalMinor).concat(tax))!==total)throw new ValidationError('The source invoice total does not agree with its complete item table and tax.');
 return {currency,invoiceNumber,purchaseOrder,issueDate,dueDate,total,tax,rows};
}
async function source(db,ctx,p){
 if(!p.sourceMessageId||!p.sourceAttachmentHash)throw new ValidationError('This invoice needs its readable original supplier attachment before automatic posting.');
 const row=(await db.query(`SELECT a.*,m.supplier_id,m.trust_status,m.connector_id,c.provider_account_id,c.status,c.paused_at FROM connection_email_attachments a
  JOIN connection_email_messages m ON m.workspace_id=a.workspace_id AND m.id=a.message_id JOIN workspace_connectors c ON c.workspace_id=m.workspace_id AND c.id=m.connector_id
  WHERE a.workspace_id=$1 AND a.message_id=$2 AND a.content_hash=$3 ORDER BY a.id LIMIT 1`,[ctx.workspaceId,p.sourceMessageId,p.sourceAttachmentHash])).rows[0];
 if(!row)throw new ValidationError('The original supplier attachment is unavailable.');
 const s=row;
 if(s.extraction_status!=='READABLE'||!s.extracted_text?.trim()||!Buffer.isBuffer(s.content)||!s.content.length||s.content.length>20*1024*1024||s.extracted_text.length>180000||digest(s.content)!==s.content_hash)throw new ValidationError('The original invoice must be completely readable and pass its saved file integrity check.');
 const evidence={attachmentId:s.id,messageId:s.message_id,sourceHash:s.content_hash,textHash:digest(s.extracted_text),filename:s.filename,supplierId:s.supplier_id,trust:s.trust_status,connectorId:row.connector_id,mailboxAccount:row.provider_account_id};
 return {s,row,evidence};
}
async function qualify(db,ctx,p,loaded){
 const {s,row,evidence}=loaded||await source(db,ctx,p);
 if(p.sourceEvidence&&!same(evidence,p.sourceEvidence))throw new ValidationError('The original invoice source changed after preparation. Review a fresh proposal.');
 if(s.supplier_id!==p.supplierId||s.trust_status!=='TRUSTED'||row.status!=='connected'||row.paused_at||!row.provider_account_id)throw new ValidationError('Confirm the supplier and connected source mailbox before automatic invoice posting.');
 if(p.expectedStatus!=='OPEN'||!p.expectedMatchFingerprint||p.expectedTotalMinor!==p.documentTotalMinor||p.taxMinor!==0||(p.charges||[]).length)throw new ValidationError('An invoice exception, tax or extra charge needs individual confirmation.');
 const doc=parse(s.extracted_text),po=(await db.query('SELECT p.po_number,p.supplier_id,a.base_currency FROM purchase_orders p JOIN accounting_settings a ON a.workspace_id=p.workspace_id AND a.enabled=1 WHERE p.workspace_id=$1 AND p.id=$2',[ctx.workspaceId,p.purchaseOrderId])).rows[0];
 if(po?.base_currency!==p.currency)throw new ValidationError('Review currency conversion individually before posting this supplier invoice.');
 if(p.issueDate>await require('../lib/business-time').today(db,ctx.workspaceId))throw new ValidationError('Review a future-dated supplier invoice individually.');
 if(!po||po.supplier_id!==s.supplier_id||doc.purchaseOrder!==po.po_number||doc.invoiceNumber!==p.supplierInvoiceNumber||doc.currency!==p.currency||doc.issueDate!==p.issueDate||doc.dueDate!==p.dueDate||doc.total!==p.documentTotalMinor||doc.tax!==p.taxMinor||doc.rows.length!==p.lines.length)throw new ValidationError('The prepared invoice fields do not match the original document exactly.');
 const lines=(await db.query(`SELECT l.id,l.sku_id,l.supplier_sku,l.units_per_purchase_unit,s.code FROM purchase_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id WHERE l.workspace_id=$1 AND l.purchase_order_id=$2`,[ctx.workspaceId,p.purchaseOrderId])).rows,used=new Set();
 for(const r of doc.rows){
  const line=require('./supplier-line-match').matchLine(lines,{sku:r.code});
  if(!line||Number(line.units_per_purchase_unit)!==1||used.has(line.id))throw new ValidationError('Confirm purchase packs, repeated lines or ambiguous product codes individually.');
  const proposed=p.lines.filter(l=>l.purchaseOrderLineId===line.id);if(proposed.length!==1||proposed[0].skuId!==line.sku_id||proposed[0].quantity!==r.quantity||proposed[0].unitCostMinor!==r.unitCostMinor)throw new ValidationError('The prepared invoice items differ from the original table.');used.add(line.id);
 }
 return evidence;
}
async function capture(db,ctx,p){
 let loaded;try{loaded=await source(db,ctx,p);}catch(e){if(e instanceof ValidationError)return {needsInvoiceConfirmation:true};throw e;}
 try{await qualify(db,ctx,p,loaded);return {sourceEvidence:loaded.evidence,needsInvoiceConfirmation:false};}
 catch(e){if(e instanceof ValidationError)return {sourceEvidence:loaded.evidence,needsInvoiceConfirmation:true};throw e;}
}
async function recheck(db,ctx,p,automatic){
 if(p.sourceEvidence){const {evidence}=await source(db,ctx,p);if(!same(evidence,p.sourceEvidence))throw new ValidationError('The supplier invoice source changed. Review it again.');}
 if(automatic){if(p.needsInvoiceConfirmation!==false)throw new ValidationError('This invoice needs individual confirmation.');await qualify(db,ctx,p);}
}
module.exports={parse,capture,recheck,qualify};
