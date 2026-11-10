'use strict';
const {ValidationError}=require('../domain/errors'),money=require('../domain/currency'),{createHash}=require('node:crypto');
const digest=v=>createHash('sha256').update(v).digest('hex'),same=require('node:util').isDeepStrictEqual;
const parse=require('./supplier-invoice-source-parser').parse;
async function source(db,ctx,p){
 if(!p.sourceMessageId||!p.sourceAttachmentHash)throw new ValidationError('This invoice needs its readable original supplier attachment before automatic posting.');
 const row=(await db.query(`SELECT a.*,m.supplier_id,m.sender,m.trust_status,m.connector_id,c.provider_account_id,c.status,c.paused_at FROM connection_email_attachments a
  JOIN connection_email_messages m ON m.workspace_id=a.workspace_id AND m.id=a.message_id JOIN workspace_connectors c ON c.workspace_id=m.workspace_id AND c.id=m.connector_id
  WHERE a.workspace_id=$1 AND a.message_id=$2 AND a.content_hash=$3 ORDER BY a.id LIMIT 1`,[ctx.workspaceId,p.sourceMessageId,p.sourceAttachmentHash])).rows[0];
 if(!row)throw new ValidationError('The original supplier attachment is unavailable.');
 const s=row;
 if(s.extraction_status!=='READABLE'||!s.extracted_text?.trim()||!Buffer.isBuffer(s.content)||!s.content.length||s.content.length>20*1024*1024||s.extracted_text.length>2000000||digest(s.content)!==s.content_hash)throw new ValidationError('The original invoice must be completely readable and pass its saved file integrity check.');
 const evidence={attachmentId:s.id,messageId:s.message_id,sourceHash:s.content_hash,textHash:digest(s.extracted_text),filename:s.filename,supplierId:s.supplier_id,trust:s.trust_status,connectorId:row.connector_id,mailboxAccount:row.provider_account_id};
 return {s,row,evidence};
}
async function qualify(db,ctx,p,loaded){
 const {s,row,evidence}=loaded||await source(db,ctx,p);
 if(p.sourceEvidence&&!same(evidence,p.sourceEvidence))throw new ValidationError('The original invoice source changed after preparation. Review a fresh proposal.');
 if(s.supplier_id!==p.supplierId||s.trust_status!=='TRUSTED'||row.status!=='connected'||row.paused_at||!row.provider_account_id)throw new ValidationError('Confirm the supplier and connected source mailbox before automatic invoice posting.');
 if(p.expectedStatus!=='OPEN'||!p.expectedMatchFingerprint||p.expectedTotalMinor!==p.documentTotalMinor||p.routineAdjustmentsProven!==true&&(p.taxMinor!==0||(p.charges||[]).length))throw new ValidationError('An invoice exception or unapproved tax or charge needs individual confirmation.');
 const doc=parse(s.extracted_text),po=(await db.query('SELECT p.po_number,p.supplier_id,a.base_currency,s.payment_terms FROM purchase_orders p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id JOIN accounting_settings a ON a.workspace_id=p.workspace_id AND a.enabled=1 WHERE p.workspace_id=$1 AND p.id=$2',[ctx.workspaceId,p.purchaseOrderId])).rows[0];
 if(po?.base_currency!==p.currency)throw new ValidationError('Review currency conversion individually before posting this supplier invoice.');
 if(p.routineTermsProven!==true)throw new ValidationError('The invoice due date is not proven by the current agreed supplier terms. Confirm this invoice’s terms individually.');
 if(p.issueDate>await require('../lib/business-time').today(db,ctx.workspaceId))throw new ValidationError('Review a future-dated supplier invoice individually.');
 if(doc.documentType==='credit')throw new ValidationError('A supplier credit note cannot become another invoice. Review its original bill and credit application separately.');
 const sourceDueDate=doc.dueDate||require('./supplier-invoice-match').terms({payment_terms:doc.paymentTerms||po?.payment_terms},doc.issueDate,null).expected;
 if(!po||po.supplier_id!==s.supplier_id||doc.purchaseOrder.toLowerCase()!==po.po_number.toLowerCase()||doc.invoiceNumber!==p.supplierInvoiceNumber||doc.currency!==p.currency||doc.issueDate!==p.issueDate||sourceDueDate!==p.dueDate||doc.total!==p.documentTotalMinor||doc.tax!==p.taxMinor||(doc.paymentTerms||null)!==(p.sourcePaymentTerms||null)||doc.rows.length!==p.lines.length)throw new ValidationError('The prepared invoice fields do not match the original document exactly.');
 if(!same(doc.charges||[],p.charges||[]))throw new ValidationError('The prepared charges differ from the complete original document.');
 const sourceLines=await require('./postgres-invoice-preparation').resolveLines(db,ctx,{id:p.purchaseOrderId},doc.rows.map(r=>({sku:r.code,description:r.description,quantity:r.quantity,quantityBasis:r.quantityBasis,secondaryQuantity:r.secondaryQuantity,priceQuantity:r.priceQuantity,priceUnit:r.priceUnit,lotCode:r.lotCode,serials:r.serials,unitCostMinor:r.unitCostMinor,documentLineTotalMinor:r.lineTotalMinor})));
 const comparable=l=>({id:l.purchaseOrderLineId,sku:l.skuId,quantity:Number(l.quantity),secondary:l.secondaryQuantity==null?null:Number(l.secondaryQuantity),price:Number(l.priceQuantity??1),cost:Number(l.unitCostMinor),lot:l.lotCode||null,serials:l.serials||null,total:l.documentLineTotalMinor??require('../domain/exact-quantity').costMinor(l.secondaryQuantity??l.quantity,Number(l.unitCostMinor),{perQuantity:l.priceQuantity??1})});
 if(!same(sourceLines.map(comparable),p.lines.map(comparable)))throw new ValidationError('The prepared invoice items differ from the original table.');
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
module.exports={parse,capture,recheck,qualify,readOriginal:source};
