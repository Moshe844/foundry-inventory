'use strict';
// Jobs 46 and 51: original delivery photos. Staff take them on the phone at a
// failed QC inspection, on a delivery's damage page after receiving, or on a
// delivery check. The original bytes and their SHA-256 stay unchanged; a
// smaller JPEG copy is prepared for the supplier claim email. Photos are
// evidence only: StockChief never reads damage or counts from them.
const crypto=require('node:crypto'),{newId}=require('../lib/util'),{ValidationError,NotFoundError}=require('../domain/errors');
const quality=require('./agent-quality-holds'),policy=require('../commercial/agent-plan');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const maxOriginalBytes=10*1024*1024,maxEmailBytes=600*1024,MAX_PER_PARENT=10,MAX_PER_CLAIM=3;
const COLUMNS={holdId:'hold_id',receiptId:'receipt_id',comparisonId:'delivery_comparison_id'};
// A photo belongs to exactly one QC hold, purchase receipt or delivery check.
function parentOf(value){
 if(typeof value==='string')return {holdId:value};
 const keys=Object.keys(COLUMNS).filter(k=>value?.[k]);
 if(keys.length!==1)throw new ValidationError('Choose one delivery inspection, receipt or delivery check for this photo.');
 return {[keys[0]]:String(value[keys[0]])};
}
function parentOfRow(row){return row.hold_id?{holdId:row.hold_id}:row.receipt_id?{receiptId:row.receipt_id}:{comparisonId:row.delivery_comparison_id};}
const sameParent=(a,b)=>Object.keys(COLUMNS).every(k=>(a[k]||null)===(b[k]||null));
async function receiptLocations(c,ctx,receiptId){
 const r=(await c.query(`SELECT r.id,(SELECT array_agg(DISTINCT rl.location_id) FROM purchase_order_receipt_lines rl WHERE rl.workspace_id=r.workspace_id AND rl.receipt_id=r.id) AS locations
  FROM purchase_order_receipts r WHERE r.workspace_id=$1 AND r.id=$2`,[ctx.workspaceId,receiptId])).rows[0];
 if(!r)throw new NotFoundError('That delivery is not in this inventory.');return r.locations||[];
}
async function comparisonLocations(c,ctx,comparisonId){
 const r=(await c.query(`SELECT d.id,(SELECT array_agg(DISTINCT coalesce(l.destination_location_id,o.destination_location_id)) FROM purchase_order_lines l
   WHERE l.workspace_id=o.workspace_id AND l.purchase_order_id=o.id) AS locations
  FROM stockchief_runtime.agent_delivery_comparisons d JOIN purchase_orders o ON o.workspace_id=d.workspace_id AND o.id=d.purchase_order_id
  WHERE d.workspace_id=$1 AND d.id=$2`,[ctx.workspaceId,comparisonId])).rows[0];
 if(!r)throw new NotFoundError('That delivery check is not in this inventory.');return (r.locations||[]).filter(Boolean);
}
// Staff who receive goods at the photo's location may add and read photos.
async function access(c,ctx,value,{write=false}={}){
 const parent=parentOf(value);let hold=null;
 if(parent.holdId){hold=await quality.hold(c,ctx,parent.holdId);await quality.actor(c,ctx,{locationId:hold.location_id,lock:write});}
 else{await quality.actor(c,ctx,{lock:write});const locations=parent.receiptId?await receiptLocations(c,ctx,parent.receiptId):await comparisonLocations(c,ctx,parent.comparisonId);
  await require('./postgres-warehouse-access').assertLocations(c,ctx,locations);}
 if(write)await policy.requireWorkspaceJob(c,ctx.workspaceId,46,'draft');
 return parent.holdId?hold:parent;
}
let photoCopiesInProgress=0;
async function emailCopy(bytes){
 if(photoCopiesInProgress>=2)throw new ValidationError('Two delivery photos are being prepared right now. Try this upload again in a moment.');
 photoCopiesInProgress++;try{return await prepareEmailCopy(bytes);}finally{photoCopiesInProgress--;}
}
async function prepareEmailCopy(bytes){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>maxOriginalBytes)throw new ValidationError('Choose a JPEG or PNG photo up to 10 MB.');
 const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 if(!png&&!jpeg)throw new ValidationError('Choose an original JPEG or PNG photograph. Other file types are not interpreted as evidence.');
 const sharp=require('sharp');let info;
 try{info=await sharp(bytes,{limitInputPixels:40000000,failOn:'error'}).metadata();}catch{throw new ValidationError('This photo could not be read. Choose an original JPEG or PNG photograph.');}
 if(!['jpeg','png'].includes(info.format)||!info.width||!info.height||(info.pages||1)!==1||info.width*info.height>40000000)throw new ValidationError('Use a single JPEG or PNG photo up to 40 megapixels.');
 for(const [size,quality] of [[1600,80],[1280,70],[1024,60]]){
  let copy;
  try{copy=await sharp(bytes,{limitInputPixels:40000000,failOn:'error'}).rotate().resize({width:size,height:size,fit:'inside',withoutEnlargement:true}).flatten({background:'#fff'}).jpeg({quality}).toBuffer({resolveWithObject:true});}catch{throw new ValidationError('This photo could not be prepared for email. Choose another original photo.');}
  if(copy.data.length<=maxEmailBytes)return {bytes:copy.data,width:copy.info.width,height:copy.info.height,mimeType:info.format==='jpeg'?'image/jpeg':'image/png'};
 }
 throw new ValidationError('This photo is still too large for the email copy. Choose a smaller photo; the app never invents replacement evidence.');
}
async function upload(db,ctx,value,file,input={}){
 const parent=parentOf(value),[key]=Object.keys(parent),column=COLUMNS[key],ref=parent[key];
 await access(db,ctx,parent,{write:true});
 const filename=String(file?.filename||'').split(/[\\/]/).at(-1),caption=String(input.caption||'').trim();
 if(!filename||filename.length>240||/[\x00-\x1f\x7f]/.test(filename)||caption.length>500)throw new ValidationError('Use a photo filename up to 240 characters and an optional note up to 500 characters.');
 const bytes=file?.buffer,hash=Buffer.isBuffer(bytes)?digest(bytes):null;
 const copy=await emailCopy(bytes);
 return db.transaction(async c=>{
  await access(c,ctx,parent,{write:true});
  const prior=(await c.query(`SELECT id,caption FROM stockchief_runtime.agent_quality_photos WHERE workspace_id=$1 AND ${column}=$2 AND content_hash=$3`,[ctx.workspaceId,ref,hash])).rows[0];
  if(prior){if(prior.caption!==caption)throw new ValidationError('This exact photo is already recorded with a different note. Review the existing evidence.');return {id:prior.id,replayed:true};}
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('quality-photos:'||$1,0))",[ref]);
  if(Number((await c.query(`SELECT count(*)::int n FROM stockchief_runtime.agent_quality_photos WHERE workspace_id=$1 AND ${column}=$2`,[ctx.workspaceId,ref])).rows[0].n)>=MAX_PER_PARENT)
   throw new ValidationError('This delivery already has ten photos. Review the existing evidence before adding more.');
  const id=newId('qc-photo');await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'quality-photo:'+id,bytes.length+copy.bytes.length+8192,{finished:true});
  const row=await c.query(`INSERT INTO stockchief_runtime.agent_quality_photos(id,workspace_id,${column},filename,mime_type,content_hash,content,email_hash,email_content,email_width,email_height,caption,created_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING id`,[id,ctx.workspaceId,ref,filename,copy.mimeType,hash,bytes,digest(copy.bytes),copy.bytes,copy.width,copy.height,caption,ctx.actorId]);
  if(!row.rowCount)throw Object.assign(Error('This photo was recorded concurrently. Retry the exact upload.'),{code:'40001'});
  const actual=row.rows[0].id;
  await require('./postgres-security-audit').record(c,ctx,{action:'Physical delivery photo recorded',reference:actual,after:{...parent,filename,originalHash:hash,emailCopyHash:digest(copy.bytes),originalBytes:bytes.length,emailCopyBytes:copy.bytes.length}});return {id:actual,replayed:false};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
const FIELDS='id,hold_id,receipt_id,delivery_comparison_id,filename,content_hash,email_hash,email_width,email_height,caption,created_at';
async function list(c,ctx,value){
 const parent=parentOf(value),[key]=Object.keys(parent);await access(c,ctx,parent);
 return (await c.query(`SELECT ${FIELDS} FROM stockchief_runtime.agent_quality_photos WHERE workspace_id=$1 AND ${COLUMNS[key]}=$2 ORDER BY created_at,id LIMIT 11`,[ctx.workspaceId,parent[key]])).rows;
}
async function load(c,ctx,id,{email=false}={}){
 const row=(await c.query('SELECT * FROM stockchief_runtime.agent_quality_photos WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];if(!row)throw new NotFoundError('That photo is not in this inventory.');
 await access(c,ctx,parentOfRow(row));if(digest(row.content)!==row.content_hash||digest(row.email_content)!==row.email_hash)throw new ValidationError('This saved photo needs an integrity review before it can be used.');
 return {...row,bytes:email?row.email_content:row.content,contentType:email?'image/jpeg':row.mime_type,downloadName:email?'damage-photo-'+row.id.slice(-12)+'-email.jpg':row.filename};
}
// The photos that may travel with one claim: the evidence's own photos and
// those of the receipt the goods arrived on.
async function related(c,ctx,source){
 if(source.holdId){const h=await quality.hold(c,ctx,source.holdId);
  const receipt=(await c.query('SELECT receipt_id FROM purchase_order_receipt_lines WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,h.receipt_line_id])).rows[0];
  return [{holdId:h.id},...(receipt?[{receiptId:receipt.receipt_id}]:[])];}
 if(source.reportId){const d=(await c.query(`SELECT rl.receipt_id FROM stockchief_runtime.agent_receipt_damage_reports d JOIN purchase_order_receipt_lines rl ON rl.workspace_id=d.workspace_id AND rl.id=d.receipt_line_id
  WHERE d.workspace_id=$1 AND d.id=$2`,[ctx.workspaceId,source.reportId])).rows[0];if(!d)throw new NotFoundError('That damage report is not in this inventory.');return [{receiptId:d.receipt_id}];}
 if(source.comparisonId)return [{comparisonId:source.comparisonId},...[...new Set(source.receiptIds||[])].map(receiptId=>({receiptId}))];
 throw new ValidationError('Choose the delivery evidence these photos belong to.');
}
async function photoSet(c,ctx,source){
 const parents=await related(c,ctx,source),out=[];
 for(const parent of parents){const [key]=Object.keys(parent);out.push(...(await c.query(`SELECT ${FIELDS} FROM stockchief_runtime.agent_quality_photos WHERE workspace_id=$1 AND ${COLUMNS[key]}=$2 ORDER BY created_at,id LIMIT 11`,[ctx.workspaceId,parent[key]])).rows);}
 return out;
}
async function selectedFor(c,ctx,source,ids,{automatic=false}={}){
 await policy.requireWorkspaceJob(c,ctx.workspaceId,46,automatic?'automatic':'draft');
 if(!Array.isArray(ids)||ids.length>MAX_PER_CLAIM||new Set(ids).size!==ids.length)throw new ValidationError('Choose up to three exact photos for this claim.');
 const allowed=await related(c,ctx,source),result=[];
 for(const id of ids){const photo=await load(c,ctx,id,{email:true});
  if(!allowed.some(p=>sameParent(p,parentOfRow(photo))))throw new ValidationError('Every photo must belong to this exact delivery inspection, its receipt or its delivery check.');
  result.push({id:photo.id,originalHash:photo.content_hash,emailHash:photo.email_hash,filename:photo.downloadName,caption:photo.caption});}
 return result;
}
async function selected(c,ctx,holdId,ids,options){return selectedFor(c,ctx,{holdId},ids,options);}
module.exports={upload,list,load,selected,selectedFor,photoSet,related,emailCopy,digest,parentOf,maxOriginalBytes,maxEmailBytes,MAX_PER_CLAIM};
