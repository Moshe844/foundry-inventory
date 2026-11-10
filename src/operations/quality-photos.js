'use strict';
const crypto=require('node:crypto'),{newId}=require('../lib/util'),{ValidationError,NotFoundError,AuthorizationError}=require('../domain/errors');
const quality=require('./agent-quality-holds'),policy=require('../commercial/agent-plan');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const maxOriginalBytes=10*1024*1024,maxEmailBytes=600*1024;
async function access(c,ctx,holdId,{write=false}={}){
 const hold=await quality.hold(c,ctx,holdId);await quality.actor(c,ctx,{locationId:hold.location_id,lock:write});
 if(write)await policy.requireWorkspaceJob(c,ctx.workspaceId,46,'draft');return hold;
}
async function emailCopy(bytes){
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
async function upload(db,ctx,holdId,file,input={}){
 await access(db,ctx,holdId,{write:true});
 const filename=String(file?.filename||'').split(/[\\/]/).at(-1),caption=String(input.caption||'').trim();
 if(!filename||filename.length>240||/[\x00-\x1f\x7f]/.test(filename)||caption.length>500)throw new ValidationError('Use a photo filename up to 240 characters and an optional note up to 500 characters.');
 const bytes=file?.buffer,hash=Buffer.isBuffer(bytes)?digest(bytes):null;
 const copy=await emailCopy(bytes);
 return db.transaction(async c=>{
  await access(c,ctx,holdId,{write:true});
  const prior=(await c.query('SELECT id,caption FROM stockchief_runtime.agent_quality_photos WHERE workspace_id=$1 AND hold_id=$2 AND content_hash=$3',[ctx.workspaceId,holdId,hash])).rows[0];
  if(prior){if(prior.caption!==caption)throw new ValidationError('This exact photo is already recorded with a different note. Review the existing evidence.');return {id:prior.id,replayed:true};}
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('quality-photos:'||$1,0))",[holdId]);
  if(Number((await c.query('SELECT count(*)::int n FROM stockchief_runtime.agent_quality_photos WHERE workspace_id=$1 AND hold_id=$2',[ctx.workspaceId,holdId])).rows[0].n)>=10)throw new ValidationError('This delivery already has ten photos. Review the existing evidence before adding more.');
  const id=newId('qc-photo');await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'quality-photo:'+id,bytes.length+copy.bytes.length+8192,{finished:true});
  const row=await c.query(`INSERT INTO stockchief_runtime.agent_quality_photos(id,workspace_id,hold_id,filename,mime_type,content_hash,content,email_hash,email_content,email_width,email_height,caption,created_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(hold_id,content_hash) DO NOTHING RETURNING id`,[id,ctx.workspaceId,holdId,filename,copy.mimeType,hash,bytes,digest(copy.bytes),copy.bytes,copy.width,copy.height,caption,ctx.actorId]);
  if(!row.rowCount)throw Object.assign(Error('This photo was recorded concurrently. Retry the exact upload.'),{code:'40001'});
  const actual=row.rows[0].id;
  await require('./postgres-security-audit').record(c,ctx,{action:'Physical delivery photo recorded',reference:actual,after:{holdId,filename,originalHash:hash,emailCopyHash:digest(copy.bytes),originalBytes:bytes.length,emailCopyBytes:copy.bytes.length}});return {id:actual,replayed:!row.rowCount};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function list(c,ctx,holdId){
 await access(c,ctx,holdId);return (await c.query('SELECT id,filename,content_hash,email_hash,email_width,email_height,caption,created_at FROM stockchief_runtime.agent_quality_photos WHERE workspace_id=$1 AND hold_id=$2 ORDER BY created_at,id LIMIT 11',[ctx.workspaceId,holdId])).rows;
}
async function load(c,ctx,id,{email=false}={}){
 const row=(await c.query('SELECT * FROM stockchief_runtime.agent_quality_photos WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];if(!row)throw new NotFoundError('That photo is not in this inventory.');
 await access(c,ctx,row.hold_id);if(digest(row.content)!==row.content_hash||digest(row.email_content)!==row.email_hash)throw new ValidationError('This saved photo needs an integrity review before it can be used.');
 return {...row,bytes:email?row.email_content:row.content,contentType:email?'image/jpeg':row.mime_type,downloadName:email?'damage-photo-'+row.id.slice(-12)+'-email.jpg':row.filename};
}
async function selected(c,ctx,holdId,ids,{automatic=false}={}){
 await access(c,ctx,holdId);await policy.requireWorkspaceJob(c,ctx.workspaceId,46,automatic?'automatic':'draft');
 if(!Array.isArray(ids)||ids.length>3||new Set(ids).size!==ids.length)throw new ValidationError('Choose up to three exact photos for this claim.');
 const result=[];for(const id of ids){const photo=await load(c,ctx,id,{email:true});if(photo.hold_id!==holdId)throw new ValidationError('Every photo must belong to this exact delivery inspection.');result.push({id:photo.id,originalHash:photo.content_hash,emailHash:photo.email_hash,filename:photo.downloadName,caption:photo.caption});}return result;
}
module.exports={upload,list,load,selected,emailCopy,digest,maxOriginalBytes,maxEmailBytes};
