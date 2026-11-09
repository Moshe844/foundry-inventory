'use strict';
const {ValidationError}=require('../domain/errors'),policy=require('../commercial/agent-plan'),filing=require('./agent-filing'),{hash}=require('../pricing/postgres-promotions');
const labels=Object.freeze({manufacturer:'Manufacturer',model:'Model or part number',composition:'Material or composition',hazards:'Hazards',handling:'Handling',storage:'Storage',temperature:'Temperature range',certifications:'Certifications',origin:'Country of origin',revision:'Document revision'});
const anchors={manufacturer:'manufacturer|made by',model:'model|part number',composition:'material|composition|ingredients',hazards:'hazards?|risks?',handling:'handling',storage:'storage',temperature:'(?:operating )?temperature(?: range)?',certifications:'certifications?|certified',origin:'country of origin|origin',revision:'(?:document )?revision|version'};
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function labelled(fact){return new RegExp('(?:^|[^A-Za-z])(?:'+anchors[fact.field]+')\\s*[:=-]\\s*'+escape(fact.value),'i').test(fact.quote);}
function facts(raw,text){
 let rows;try{rows=typeof raw==='string'?JSON.parse(raw):raw;}catch{throw new ValidationError('Supply the product facts as a JSON list with field, value and exact source quote.');}
 if(!Array.isArray(rows)||!rows.length||rows.length>10)throw new ValidationError('Choose between one and ten sourced product facts.');
 const seen=new Set();return rows.map(row=>{
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(k=>!['field','value','quote'].includes(k))||!Object.hasOwn(labels,row.field)||seen.has(row.field))throw new ValidationError('Use each supported product-fact field once.');
  seen.add(row.field);const value=String(row.value||'').trim(),quote=String(row.quote||'').trim();
  if(!value||value.length>2000||!quote||quote.length>3000||!text.includes(quote)||!quote.includes(value))throw new ValidationError('Every fact must be copied exactly from its quoted source. Missing or conflicting facts need a document review.');
  return {field:row.field,value,quote};
 });
}
async function build(db,ctx,item,args){
 await policy.requireWorkspaceJob(db,ctx.workspaceId,136,'draft');
 const document=await filing.load(db,ctx,args.filedDocument);
 if(document.target_kind!=='item'||document.target_id!==item.id||!['specification','safety_sheet'].includes(document.document_kind))throw new ValidationError('Choose the spec or safety sheet already filed on this exact product.');
 const requested=facts(args.documentFacts,document.extracted_text),existing=document.product_facts||[];
 for(const fact of requested){const before=existing.find(f=>f.field===fact.field);if(before&&hash(before)!==hash(fact))throw new ValidationError(labels[fact.field]+' was already saved differently from this source. Review a new or corrected source; existing sourced facts are preserved.');}
 const needsFactConfirmation=requested.some(f=>!labelled(f));
 return {payload:{recordId:item.id,productName:item.name,documentId:document.id,filename:document.filename,sourceHash:document.source_hash,textHash:document.source_text_hash,expectedRevision:document.facts_revision,expectedFactsHash:hash(existing),facts:requested,needsFactConfirmation},
  summary:'Save '+requested.length+' source-backed product facts for '+item.name+' from '+document.filename+': '+requested.map(f=>labels[f.field]+': '+f.value).join('; ')+'.'+(needsFactConfirmation?' Confirm the field interpretation; the source does not label every value clearly.':'')+' Stock, prices and supplier terms stay unchanged.'};
}
async function execute(db,ctx,p){
 await policy.requireWorkspaceJob(db,ctx.workspaceId,136,'draft');
 await db.query('SELECT id FROM stockchief_runtime.agent_filed_documents WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,p.documentId]);
 const d=await filing.load(db,ctx,p.documentId);
 if(d.target_kind!=='item'||d.target_id!==p.recordId||!['specification','safety_sheet'].includes(d.document_kind)||d.source_hash!==p.sourceHash||d.source_text_hash!==p.textHash)throw new ValidationError('The filed product source changed. Review it again.');
 const requested=facts(p.facts,d.extracted_text),before=d.product_facts||[];
 if(requested.every(f=>before.some(old=>hash(old)===hash(f))))return {documentId:d.id,savedFacts:0,replayed:true};
 if(d.facts_revision!==p.expectedRevision||hash(before)!==p.expectedFactsHash)throw new ValidationError('The saved product facts changed. Review the current source facts first.');
 const merged=[...before,...requested.filter(f=>!before.some(old=>old.field===f.field))];
 if(merged.length!==before.length+requested.filter(f=>!before.some(old=>hash(old)===hash(f))).length)throw new ValidationError('A saved source fact conflicts with this request. Preserve it and review the source.');
 await require('../commercial/storage-capacity').reserve(db,ctx.workspaceId,'filed-facts:'+d.id+':'+(d.facts_revision+1),Buffer.byteLength(JSON.stringify(merged),'utf8')+8192,{finished:true});
 const changed=await db.query(`UPDATE stockchief_runtime.agent_filed_documents SET product_facts=$3::jsonb,facts_revision=facts_revision+1,facts_recorded_at=now(),facts_recorded_by=$4 WHERE workspace_id=$1 AND id=$2 AND facts_revision=$5`,[ctx.workspaceId,d.id,JSON.stringify(merged),ctx.actorId,d.facts_revision]);
 if(!changed.rowCount)throw new ValidationError('The product facts changed during review. Reload the document.');
 await require('../operations/postgres-security-audit').record(db,ctx,{action:'Sourced product facts saved',reference:d.id,after:{product:p.productName,source:d.filename,fields:requested.map(f=>labels[f.field])}});
 return {documentId:d.id,savedFacts:merged.length-before.length,href:'/autopilot/documents/'+d.id};
}
async function verify(db,ctx,r,p){return Boolean(r.documentId===p.documentId&&(await db.query('SELECT 1 FROM stockchief_runtime.agent_filed_documents WHERE workspace_id=$1 AND id=$2 AND target_id=$3 AND product_facts @> $4::jsonb',[ctx.workspaceId,p.documentId,p.recordId,JSON.stringify(p.facts)])).rowCount);}
async function review(db,ctx,{page=1,filter=''}){
 const history=await require('../commercial/agent-history').access(db,ctx.workspaceId);
 const rows=(await db.query(`SELECT d.target_reference AS "Product",d.filename AS "Source",f.value->>'field' AS field,f.value->>'value' AS "Fact",f.value->>'quote' AS "Source quote",'/autopilot/documents/'||d.id AS link FROM stockchief_runtime.agent_filed_documents d CROSS JOIN LATERAL jsonb_array_elements(d.product_facts) WITH ORDINALITY f(value,position)
  WHERE d.workspace_id=$1 AND ($2='' OR lower(d.target_reference)=lower($2) OR EXISTS(SELECT 1 FROM skus s WHERE s.workspace_id=d.workspace_id AND s.item_id=d.target_id AND lower(s.code)=lower($2))) AND ($3::timestamptz IS NULL OR d.facts_recorded_at>=$3::timestamptz) ORDER BY d.created_at DESC,d.id,f.position LIMIT 101 OFFSET $4`,[ctx.workspaceId,filter,history.activityAfter,(page-1)*100])).rows;
 for(const row of rows){row.Field=labels[row.field]||row.field;delete row.field;}
 return {rows:rows.slice(0,100),more:rows.length>100,summary:'Product facts copied from filed spec and safety sheets, with the original quote. They do not replace stocking units, prices, supplier terms or physical records.'};
}
module.exports={labels,spec:{name:'document.save_product_facts',record:'item',fields:['recordReference','filedDocument','documentFacts'],permission:require('../actions/permissions').ADMIN,ownerOnly:true,capability:'inventory.core',resultingRecords:['agent_filed_documents'],description:'Read an existing filed spec or safety sheet and save exact quoted product facts for its product. Copy literal values and their supporting source quotes. Never invent absent values or overwrite existing sourced facts, stock units, prices, supplier terms or stock. Growth needs approval; Pro/Custom can run inside approved authority.',build,execute,verify},definition:{id:136,key:'product-document-facts',label:'Product facts from spec and safety sheets',filterLabel:'Product name or SKU',readPage:review}};
