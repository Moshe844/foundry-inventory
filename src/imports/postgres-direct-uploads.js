'use strict';

const {newId} = require('../lib/util');
const {ValidationError,NotFoundError} = require('../domain/errors');
const permissions = require('../actions/permissions');
const storage = require('../commercial/storage-capacity');
const jobs = require('../operations/postgres-job-queue');
const formats = require('./source-formats');

async function operator(db,ctx) {
  const actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!actor) throw new NotFoundError('This inventory is not available to you.');
  permissions.assertCan(actor,permissions.OPERATE,'prepare an import preview');
}

function metadata(input) {
  if(!Number.isSafeInteger(input.bytes)||input.bytes<1||input.bytes>formats.maxBytes) throw new ValidationError('Choose a file within the upload size shown on this page.');
  if(typeof input.sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.sha256)) throw new ValidationError('The file checksum could not be confirmed. Select the file again.');
  if(typeof input.filename!=='string'||!input.filename.trim()||input.filename.length>500) throw new ValidationError('Choose a file with a name of up to 500 characters.');
  const name=input.filename.toLowerCase();
  if(!/\.(csv|tsv|txt|xlsx|xlsm|xlsb|xls|ods|json|xml|html?|docx)$/.test(name)) throw new ValidationError('Use the standard upload form for PDFs, images and handwritten documents.');
  const max=/\.pdf$/.test(name)?32*1048576:/\.(png|jpe?g|webp|gif|heic|heif|tiff?)$/.test(name)?20*1048576:formats.maxBytes;
  if(input.bytes>max) throw new ValidationError('This image or PDF exceeds its upload size allowance.');
  if(typeof input.requestKey!=='string'||!/^[a-zA-Z0-9:_-]{1,200}$/.test(input.requestKey)) throw new ValidationError('Reload the import page before uploading.');
  if(input.readingMode&&input.readingMode!=='standard') throw new ValidationError('Use the handwriting upload form for handwritten documents.');
  return {filename:input.filename,bytes:input.bytes,sha256:input.sha256,requestKey:input.requestKey,
    options:{allowModel:false,...(input.defaultLocationId?{defaultLocationId:input.defaultLocationId}:{})}};
}

async function prepare(db,ctx,input,{transport=require('./aws-transport').configured()}={}) {
  await operator(db,ctx);
  const file=metadata(input);
  const row=await db.transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['direct-upload',ctx.workspaceId,ctx.actorId,file.requestKey])]);
    const prior=(await client.query('SELECT * FROM import_external_uploads WHERE workspace_id=$1 AND actor_id=$2 AND request_key=$3 FOR UPDATE',[ctx.workspaceId,ctx.actorId,file.requestKey])).rows[0];
    if(prior){
      if(prior.source_hash!==file.sha256||Number(prior.source_bytes)!==file.bytes||prior.source_name!==file.filename
        ||JSON.stringify(prior.input_options)!==JSON.stringify(file.options)) throw new ValidationError('This upload request already belongs to a different file or choices. Select the file again.');
      if(new Date(prior.expires_at).getTime()<=Date.now()||prior.version_id) throw new ValidationError('This upload is already saved or expired. Open its saved preview or select a new file.');
      return prior;
    }
    if(file.options.defaultLocationId&&!(await client.query('SELECT 1 FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1',[ctx.workspaceId,file.options.defaultLocationId])).rowCount) throw new ValidationError('Choose a location in this inventory.');
    const id=newId('upl');
    await storage.reserve(client,ctx.workspaceId,'upload:'+id,file.bytes+16384);
    return (await client.query(`INSERT INTO import_external_uploads(id,workspace_id,actor_id,request_key,source_name,source_hash,source_bytes,object_key,input_options)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,[id,ctx.workspaceId,ctx.actorId,file.requestKey,file.filename,file.sha256,file.bytes,
      `sources/${ctx.workspaceId}/${id}/original`,JSON.stringify(file.options)])).rows[0];
  },{isolation:'READ COMMITTED'});
  return {id:row.id,upload:await transport.upload(row)};
}

async function complete(db,ctx,id,{transport=require('./aws-transport').configured()}={}) {
  await operator(db,ctx);
  const row=(await db.query('SELECT * FROM import_external_uploads WHERE workspace_id=$1 AND actor_id=$2 AND id=$3',[ctx.workspaceId,ctx.actorId,id])).rows[0];
  if(!row) throw new NotFoundError('That upload was not found in this inventory.');
  if(new Date(row.expires_at).getTime()<=Date.now()) throw new ValidationError('This upload expired. Choose the original file again.');
  // HEAD is outside the DB transaction; only immutable version identity enters
  // the lock window. Concurrent completions converge on the first pinned version.
  const version=row.version_id||await transport.inspect(row);
  await db.transaction(async client=>{
    const saved=(await client.query('SELECT * FROM import_external_uploads WHERE workspace_id=$1 AND actor_id=$2 AND id=$3 FOR UPDATE',[ctx.workspaceId,ctx.actorId,id])).rows[0];
    if(!saved||new Date(saved.expires_at).getTime()<=Date.now()) throw new ValidationError('This upload expired. Choose the original file again.');
    if(saved.version_id) return;
    const queued=await jobs.enqueue(client,{workspaceId:ctx.workspaceId,kind:'import.analyse-source.aws',idempotencyKey:`source:${ctx.actorId}:${saved.request_key}`,payload:{uploadId:id,actorId:ctx.actorId},priority:35,maxAttempts:3});
    await client.query(`INSERT INTO import_source_uploads(id,workspace_id,actor_id,job_id,request_key,source_name,source_hash,source_bytes,input_options,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,[id,ctx.workspaceId,ctx.actorId,queued.job.id,saved.request_key,saved.source_name,saved.source_hash,saved.source_bytes,JSON.stringify(saved.input_options),saved.expires_at]);
    await client.query('UPDATE import_external_uploads SET version_id=$4 WHERE workspace_id=$1 AND actor_id=$2 AND id=$3',[ctx.workspaceId,ctx.actorId,id,version]);
  },{isolation:'READ COMMITTED'});
  return {id,href:'/imports/uploads/'+id};
}

async function read(db,source,transport=require('./aws-transport').configured()) {
  const row=(await db.query('SELECT * FROM import_external_uploads WHERE workspace_id=$1 AND actor_id=$2 AND id=$3 AND version_id IS NOT NULL',[source.workspace_id,source.actor_id,source.id])).rows[0];
  if(!row||row.source_hash!==source.source_hash||Number(row.source_bytes)!==Number(source.source_bytes)) throw new ValidationError('The saved source file is unavailable. Upload the original again.');
  return transport.read(row);
}

module.exports={metadata,prepare,complete,read};
require('../commercial/enforcement').guardExports(module.exports,0,1,{prepare:'imports.spreadsheet',complete:'imports.spreadsheet'});
