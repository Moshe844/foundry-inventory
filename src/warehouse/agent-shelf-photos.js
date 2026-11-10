'use strict';

const {createHash}=require('node:crypto');
const {newId}=require('../lib/util');
const {AuthorizationError,NotFoundError,ValidationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const storage=require('../commercial/storage-capacity');
const documentUsage=require('../imports/handwritten-table');
const queue=require('../operations/postgres-job-queue');
const vision=require('./shelf-photo-reading');

const kind='import.read-shelf-photo.v1';
const action='warehouse.read_shelf_photo';
const photos='stockchief_runtime.agent_shelf_photos';
const rules='stockchief_runtime.agent_shelf_photo_rules';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const usageKey=(id,lease)=>'shelf-photo:'+id+':'+sha(lease||id).slice(0,20);
const finished=['REVIEW','CONFIRMED'];

async function owner(db,ctx){
  const found=await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL) FOR SHARE OF u,w`,
  [ctx.workspaceId,ctx.actorId]);
  if(!found.rowCount)throw new AuthorizationError('Only the current inventory owner can read these shelf photos.');
  await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
}

async function location(db,ctx,id){
  const row=(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 FOR SHARE',[ctx.workspaceId,id])).rows[0];
  if(!row)throw new ValidationError('Choose a current location in this inventory.');
  return row;
}

async function authority(db,ctx){
  await owner(db,ctx);
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,140,'draft');
  const restriction=await require('../autopilot/job-modes').restriction(db,ctx.workspaceId,140,false);
  if(restriction)throw new ValidationError(restriction);
  return state;
}

async function load(db,ctx,id,{content=true,lock=false}={}){
  await owner(db,ctx);
  const fields=content?'p.*':'p.id,p.location_id,p.job_id,p.filename,p.source_hash,p.status,p.reading,p.confirmation,p.training_example_id,p.credits_used,p.problem';
  const row=(await db.query(`SELECT ${fields},j.status AS job_status FROM ${photos} p
    LEFT JOIN stockchief_runtime.jobs j ON j.id=p.job_id AND j.workspace_id=p.workspace_id
    WHERE p.workspace_id=$1 AND p.id=$2${lock?' FOR UPDATE OF p':''}`,[ctx.workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('This shelf photo was not found in this inventory.');
  if(content&&sha(row.content)!==row.source_hash)throw new ValidationError('The original photo failed its integrity check.');
  return row;
}

async function status(db,ctx,id){
  await owner(db,ctx);
  const row=(await db.query(`SELECT p.status,j.status AS "jobStatus" FROM ${photos} p
    LEFT JOIN stockchief_runtime.jobs j ON j.id=p.job_id AND j.workspace_id=p.workspace_id
    WHERE p.workspace_id=$1 AND p.id=$2`,[ctx.workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('This shelf photo was not found in this inventory.');
  return row;
}

async function enqueue(db,ctx,{buffer,filename,locationId,requestKey}){
  await authority(db,ctx);
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>20*1024*1024)throw new ValidationError('Choose an original shelf photo up to 20 MB.');
  if(!/^[\w:-]{1,160}$/.test(requestKey||''))throw new ValidationError('Reload the shelf photo form before uploading.');
  const hash=sha(buffer);
  return db.transaction(async tx=>{
    await authority(tx,ctx);
    await location(tx,ctx,locationId);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[ctx.workspaceId+':shelf-photo:'+requestKey]);
    const prior=(await tx.query(`SELECT id,source_hash,location_id FROM ${photos} WHERE workspace_id=$1 AND request_key=$2`,[ctx.workspaceId,requestKey])).rows[0];
    if(prior){
      if(prior.source_hash!==hash||prior.location_id!==locationId)throw new ValidationError('This upload reference already belongs to another original or location.');
      return {id:prior.id,replayed:true};
    }
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[ctx.workspaceId+':shelf-original:'+locationId+':'+hash]);
    const original=(await tx.query(`SELECT id FROM ${photos} WHERE workspace_id=$1 AND location_id=$2 AND source_hash=$3`,[ctx.workspaceId,locationId,hash])).rows[0];
    if(original)return {id:original.id,replayed:true};
    await documentUsage.documentCapacity(tx,ctx);
    const id=newId('shelf_photo');
    await storage.reserve(tx,ctx.workspaceId,'shelf-original:'+id,buffer.length+16384,{finished:true});
    const scoped={query:(...args)=>tx.query(...args),transaction:fn=>fn(tx)};
    const {job}=await queue.enqueue(scoped,{workspaceId:ctx.workspaceId,kind,idempotencyKey:id,
      payload:{readingId:id,actorId:ctx.actorId},maxAttempts:1,priority:35});
    await tx.query(`INSERT INTO ${photos}(id,workspace_id,actor_id,location_id,job_id,request_key,filename,source_hash,content,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'QUEUED')`,[id,ctx.workspaceId,ctx.actorId,locationId,job.id,requestKey,String(filename||'Shelf photo').slice(0,240),hash,buffer]);
    return {id};
  },{isolation:'READ COMMITTED'});
}

function signature(reading){
  if(!reading.visibleBoxes||reading.uncertainBoxes||reading.obstructions.length||
    reading.boxes.some(box=>!box.label.trim())||reading.shelfLabels.some(label=>label.uncertain))return null;
  const boxLabels=[...new Set(reading.boxes.map(box=>box.label))].sort();
  const shelfLabels=[...new Set(reading.shelfLabels.map(label=>label.label))].sort();
  return sha(JSON.stringify([boxLabels,shelfLabels]));
}

async function applyTraining(db,ctx,state,photo,reading){
  if(state.plan!=='enterprise')return null;
  const labelSignature=signature(reading);
  if(!labelSignature)return null;
  const mode=(await db.query('SELECT mode FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId])).rows[0];
  if(mode?.mode!=='POLICY_AUTOMATED'||await policy.stopped(db,ctx.workspaceId,state,action,true))return null;
  const proof=(await db.query(`SELECT r.example_id FROM ${rules} r JOIN ${photos} p ON p.id=r.example_id AND p.workspace_id=r.workspace_id
    WHERE r.workspace_id=$1 AND r.location_id=$2 AND r.label_signature=$3 AND r.authorized_by=$4 AND r.maximum_boxes>=$5
    AND p.status='CONFIRMED' AND p.confirmation->>'mode'='human' FOR SHARE OF r,p`,
  [ctx.workspaceId,photo.location_id,labelSignature,ctx.actorId,reading.visibleBoxes])).rows[0];
  if(!proof)return null;
  await policy.requireWorkspaceJob(db,ctx.workspaceId,140,'automatic',{trained:true});
  return proof.example_id;
}

async function readPhoto(buffer){
  if(buffer.subarray(0,5).toString()==='%PDF-')throw new ValidationError('Use one original shelf photo. Count-sheet PDFs belong in file imports.');
  const images=[];
  for await(const page of documentUsage.pages(buffer))images.push(page.block);
  if(images.length!==1)throw new ValidationError('Upload each shelf photo separately so the same boxes are not counted from two pages.');
  return images[0];
}

async function run(job,db,{provider}={}){
  const ctx={workspaceId:job.workspaceId,actorId:job.payload.actorId};
  const id=job.payload.readingId;
  const key=usageKey(id,job.leaseToken);
  try{
    await authority(db,ctx);
    const photo=await load(db,ctx,id);
    if(photo.job_id!==job.id)throw new ValidationError('The queued work does not match the original shelf photo.');
    if(finished.includes(photo.status))return {readingId:id,replayed:true};
    await location(db,ctx,photo.location_id);
    await documentUsage.reserveDocument(db,ctx,key);
    await db.query(`UPDATE ${photos} SET status='READING',problem=NULL WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);
    const image=await readPhoto(photo.content);
    await authority(db,ctx);
    const config=require('../config');
    if(!provider&&!config.ai.configured)throw new ValidationError('Shelf photo reading is not connected yet. Your original is retained.');
    provider ||= require('../ai/provider').createProviderUnobserved(config.ai.provider,config.ai.tier('fast'));
    const metered=require('../commercial/model').wrap(db,ctx,provider,'import_mapping',key,{deferCustomerCommit:true});
    const response=await metered.complete({system:vision.system,prompt:[image,{type:'text',text:'Read the visible boxes and the original labels in this shelf photograph.'}],
      schema:vision.schema,schemaName:'stockchief_shelf_photo',maxOutputTokens:8000,onValidated:async data=>{await authority(db,ctx);vision.checked(data);}});
    const reading=vision.checked(response.data);
    return await db.transaction(async tx=>{
      const state=await authority(tx,ctx);
      await location(tx,ctx,photo.location_id);
      const fence=await tx.query(`UPDATE stockchief_runtime.jobs SET result=jsonb_build_object('committedShelfPhoto',$4::text),updated_at=now()
        WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING'
        AND lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000) RETURNING id`,[ctx.workspaceId,job.id,job.leaseToken,id]);
      if(!fence.rowCount)throw new ValidationError('The photo reading worker stopped before saving.');
      const example=await applyTraining(tx,ctx,state,photo,reading);
      const confirmation=example?{mode:'trained',visibleBoxes:reading.visibleBoxes}:null;
      const credits=Number((await tx.query("SELECT units FROM commercial_usage_events WHERE workspace_id=$1 AND meter='ai_work_credits' AND idempotency_key=$2 AND status='RESERVED'",[ctx.workspaceId,ctx.workspaceId+':'+key])).rows[0]?.units||0);
      await storage.reserve(tx,ctx.workspaceId,'shelf-observations:'+id,Buffer.byteLength(JSON.stringify(reading))+8192,{finished:true});
      const saved=await tx.query(`UPDATE ${photos} SET status=$3,reading=$4,confirmation=$5,training_example_id=$6,credits_used=$7,
        confirmed_at=CASE WHEN $6::text IS NULL THEN NULL ELSE now() END WHERE workspace_id=$1 AND id=$2 AND job_id=$8 AND source_hash=$9`,
      [ctx.workspaceId,id,example?'CONFIRMED':'REVIEW',JSON.stringify(reading),confirmation&&JSON.stringify(confirmation),example,credits,job.id,photo.source_hash]);
      if(!saved.rowCount)throw new ValidationError('The saved photo changed before its observation could commit.');
      await documentUsage.commitCredits(tx,ctx,key);
      return {readingId:id,visibleBoxes:reading.visibleBoxes,credits,needsReview:!example};
    },{isolation:'READ COMMITTED'});
  }catch(error){
    await documentUsage.refund(db,ctx,key);
    await db.query(`UPDATE ${photos} SET status='FAILED',problem=$4 WHERE workspace_id=$1 AND id=$2 AND job_id=$3 AND status IN('QUEUED','READING')`,
    [ctx.workspaceId,id,job.id,String(error.message).slice(0,1000)]);
    throw error;
  }
}

async function recover(tx,job){
  const row=(await tx.query(`SELECT id,status,actor_id FROM ${photos} WHERE workspace_id=$1 AND id=$2 AND job_id=$3 FOR UPDATE`,
  [job.workspaceId,job.payload.readingId,job.id])).rows[0];
  if(!row)return null;
  if(finished.includes(row.status))return {readingId:row.id,recovered:true};
  await documentUsage.refund(tx,{workspaceId:job.workspaceId,actorId:row.actor_id},usageKey(row.id,job.leaseToken));
  await tx.query(`UPDATE ${photos} SET status='FAILED',problem=$3 WHERE workspace_id=$1 AND id=$2`,
  [job.workspaceId,row.id,'The worker stopped before completing the shelf reading. Your original is retained and the new credits were released.']);
  return null;
}

async function confirm(db,ctx,id,input){
  return db.transaction(async tx=>{
    const state=await authority(tx,ctx);
    const photo=await load(tx,ctx,id,{lock:true});
    const correcting=photo.confirmation?.mode==='trained';
    if(photo.status==='CONFIRMED'&&!correcting)return {id,replayed:true};
    if((photo.status!=='REVIEW'&&!correcting)||input.sourceHash!==photo.source_hash||input.confirmed!=='yes'){
      throw new ValidationError('Compare the original and confirm this exact photo reading.');
    }
    await location(tx,ctx,photo.location_id);
    const count=Number(input.count);
    if(!/^\d{1,4}$/.test(String(input.count))||!Number.isSafeInteger(count))throw new ValidationError('Enter the whole number of boxes you can see.');
    const notes=String(input.notes||'').trim();
    if(notes.length>4000)throw new ValidationError('Keep the photo correction under 4,000 characters.');
    const reading=photo.reading;
    const corrected=count!==reading.visibleBoxes||reading.uncertainBoxes>0||reading.obstructions.length>0;
    if(corrected&&!notes)throw new ValidationError('Describe the correction or confirm what the photo could not show.');
    if(input.teach==='yes'){
      if(correcting)throw new ValidationError('A reading confirmed by training cannot teach future work.');
      await policy.requireWorkspaceJob(tx,ctx.workspaceId,140,'automatic',{trained:true});
      if(state.plan!=='enterprise'||state.shadow)throw new ValidationError('A Custom owner can teach this after the first 14 days.');
      const labelSignature=signature(reading);
      if(corrected||notes||!labelSignature)throw new ValidationError('Teach only from a complete, uncorrected photo with every visible box label checked.');
      await storage.reserve(tx,ctx.workspaceId,'shelf-rule:'+id,8192,{finished:true});
      await tx.query(`INSERT INTO ${rules}(workspace_id,location_id,example_id,authorized_by,label_signature,maximum_boxes)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,location_id,label_signature) DO UPDATE
        SET example_id=EXCLUDED.example_id,authorized_by=EXCLUDED.authorized_by,maximum_boxes=EXCLUDED.maximum_boxes`,
      [ctx.workspaceId,photo.location_id,id,ctx.actorId,labelSignature,count]);
    }
    if(correcting&&(corrected||notes)){
      await tx.query(`DELETE FROM ${rules} WHERE workspace_id=$1 AND example_id=$2`,[ctx.workspaceId,photo.training_example_id]);
    }
    const confirmation={mode:'human',visibleBoxes:count,notes,actorId:ctx.actorId,taught:input.teach==='yes',
      ...(correcting?{supersedes:photo.confirmation}:{})};
    await storage.reserve(tx,ctx.workspaceId,'shelf-confirmation:'+id,Buffer.byteLength(JSON.stringify(confirmation))+4096,{finished:true});
    await tx.query(`UPDATE ${photos} SET status='CONFIRMED',confirmation=$3,confirmed_at=now() WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,id,JSON.stringify(confirmation)]);
    await require('../operations/postgres-security-audit').record(tx,ctx,{action:'Shelf photo reading confirmed',reference:photo.filename,
      after:{originalHash:photo.source_hash,visibleBoxes:count,taught:confirmation.taught}});
    return {id};
  },{isolation:'READ COMMITTED'});
}

async function stopRule(db,ctx,id){
  await owner(db,ctx);
  await db.query(`DELETE FROM ${rules} WHERE workspace_id=$1 AND example_id=$2`,[ctx.workspaceId,id]);
}

async function retry(db,ctx,id){
  await authority(db,ctx);
  const row=await load(db,ctx,id);
  if(finished.includes(row.status))return {id};
  if(row.job_status!=='DEAD'||!await queue.retryDead(db,row.job_id,ctx.workspaceId,{by:ctx.actorId})){
    throw new ValidationError('The saved photo is already queued, reading or waiting for plan access.');
  }
  await db.query(`UPDATE ${photos} SET status='QUEUED',problem=NULL WHERE workspace_id=$1 AND id=$2 AND status='FAILED'`,[ctx.workspaceId,id]);
  return {id};
}

const statusLabels={QUEUED:'Waiting to read',READING:'Reading visible boxes',REVIEW:'Ready to review',CONFIRMED:'Confirmed observation',FAILED:'Reading stopped'};

async function page(db,ctx,id=null,number=1){
  number=Number(number);
  if(!Number.isSafeInteger(number)||number<1||number>1000000)throw new ValidationError('Choose a valid shelf photo page.');
  await owner(db,ctx);
  const state=await policy.accountState(db,ctx.workspaceId);
  const allowed=policy.usesAgentTerms(state)&&policy.permits(state.plan,140,'draft');
  const rows=(await db.query(`SELECT p.id,p.filename,p.status,p.credits_used,p.created_at,l.name AS location
    FROM ${photos} p LEFT JOIN locations l ON l.id=p.location_id AND l.workspace_id=p.workspace_id
    WHERE p.workspace_id=$1 ORDER BY p.created_at DESC,p.id LIMIT 51 OFFSET $2`,[ctx.workspaceId,(number-1)*50])).rows;
  const places=allowed?(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 ORDER BY name,id',[ctx.workspaceId])).rows:[];
  return {allowed,statusLabels,mayTeach:allowed&&state.plan==='enterprise'&&!state.shadow,rows:rows.slice(0,50),more:rows.length>50,number,
    places,requestKey:newId('shelf_upload'),record:id?await load(db,ctx,id,{content:false}):null};
}

const definition={id:140,key:'shelf-photos',label:'Count boxes and read shelf labels',async readPage(db,ctx,{page:number=1}={}){
  const result=await page(db,ctx,null,number);
  return {rows:result.rows.map(row=>({Photo:row.filename,Location:row.location||'Archived location',Status:statusLabels[row.status],
    'AI credits used':row.credits_used,link:'/autopilot/shelf-photos/'+row.id})),more:result.more,
    summary:'Reads visible boxes and their labels from original shelf photos. Review unclear or hidden items and confirm the observation before using it in a physical count.'};
}};

module.exports={kind,action,owner,load,status,enqueue,run,recover,signature,confirm,stopRule,retry,page,definition,readPhoto};
