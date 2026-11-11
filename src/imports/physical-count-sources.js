'use strict';

const {createHash}=require('node:crypto');
const {newId}=require('../lib/util');
const {DomainError,ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {hash}=require('../pricing/postgres-promotions');
const policy=require('../commercial/agent-plan');
const storage=require('../commercial/storage-capacity');
const queue=require('../operations/postgres-job-queue');
const reading=require('./physical-count-source-reading');
const stock=require('./physical-count-source-stock');
const documents=require('./handwritten-table');

const path='/imports/count-sources',kind='import.physical-count-source.v1',action='import.count_sheet';
const sources='stockchief_runtime.agent_count_sources',rowsTable='stockchief_runtime.agent_count_source_rows',
  rules='stockchief_runtime.agent_count_source_rules';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const scopeKey=ids=>[...new Set([].concat(ids||[]).filter(id=>typeof id==='string'&&id))].sort();
const sameScope=(a,b)=>JSON.stringify(scopeKey(a))===JSON.stringify(scopeKey(b));
const operation=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});

async function owner(c,ctx,lock=false){
  const match=(await c.query(`SELECT w.owner_account_id FROM workspaces w JOIN users u ON u.workspace_id=w.id AND u.account_id=w.owner_account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=w.owner_account_id AND a.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF w,u':''}`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!match)throw new AuthorizationError('Only the current inventory owner can review these physical count sources.');
  if(lock)await c.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR SHARE',[match.owner_account_id]);
  return match.owner_account_id;
}

async function authorize(c,ctx,{lock=false,automatic=false,posting=false,trained=false}={}){
  await owner(c,ctx,lock);
  const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,5,automatic?'automatic':'draft',{trained});
  await require('../commercial/enforcement').workspace(c,ctx.workspaceId,'imports.spreadsheet');
  if(lock&&(automatic||posting))await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR NO KEY UPDATE',[ctx.workspaceId]);
  const stop=automatic||posting?await policy.stopped(c,ctx.workspaceId,state,action,automatic):
    await require('../autopilot/job-modes').restriction(c,ctx.workspaceId,5,false);
  if(stop)throw new ValidationError(stop);
  if(automatic&&!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)
    throw new ValidationError('Enable routine work before preparing count sources automatically.');
  return state;
}

async function places(c,workspaceId,ids,lock=false){
  const {rows}=await c.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL
    AND ($2::text[] IS NULL OR id=ANY($2::text[])) ORDER BY name,id${lock?' FOR SHARE':''}`,[workspaceId,ids]);
  if(ids&&(!ids.length||rows.length!==ids.length))throw new ValidationError('Choose the exact active stock locations for this source.');
  return rows;
}

async function load(c,ctx,id,{original=false,lock=false}={}){
  await owner(c,ctx,lock);
  const row=(await c.query(`SELECT id,actor_id,filename,source_hash,format,location_ids,rule_id,rule_revision,job_id,status,revision,layout_hash,evidence_hash,
    reading_note,issue,approved_at,posted_at,created_at,
    (SELECT j.status FROM stockchief_runtime.jobs j WHERE j.id=s.job_id AND j.workspace_id=s.workspace_id) job_status${original?',content':''}
    FROM ${sources} s WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[ctx.workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('This physical count original is unavailable in this inventory.');
  if(original&&digest(row.content)!==row.source_hash)throw new ValidationError('The saved original failed its integrity check.');
  return row;
}

async function rule(c,ctx,id,revision=null,lock=false){
  const row=(await c.query(`SELECT r.* FROM ${rules} r WHERE r.workspace_id=$1 AND r.id=$2 AND r.enabled AND r.authorized_by=$3
    AND ($4::text IS NULL OR r.revision=$4)${lock?' FOR SHARE':''}`,[ctx.workspaceId,id,ctx.actorId,revision])).rows[0];
  if(!row)throw new ValidationError('This owner’s count-source routine changed or was stopped.');
  const example=row.example_id?(await c.query(`SELECT id,layout_hash FROM ${sources} WHERE workspace_id=$1 AND id=$2 AND status='POSTED'
    AND actor_id=$3 AND rule_id IS NULL AND format=$4 AND location_ids=$5::text[]`,[ctx.workspaceId,row.example_id,ctx.actorId,row.format,row.location_ids])).rows[0]:null;
  const trained=Boolean(example&&example.layout_hash===row.layout_hash);
  await authorize(c,ctx,{automatic:true,trained,lock});
  return row;
}

async function configure(db,ctx,input){
  return operation(db,async c=>{
    await owner(c,ctx,true);
    if(input.remove==='yes'){
      await c.query(`UPDATE ${rules} SET enabled=false WHERE workspace_id=$1 AND id=$2 AND enabled`,[ctx.workspaceId,input.id]);
      return;
    }
    const format=input.format,locationIds=scopeKey(input.locationIds),limit=Number(input.maximumRows),label=String(input.label||'').trim();
    if(input.confirmed!=='yes'||!['sheet','visual'].includes(format)||!label||label.length>120||
      !Number.isSafeInteger(limit)||limit<1||limit>require('./parser').LIMITS.maxRows)
      throw new ValidationError('Confirm a named source type, exact location scope and maximum number of rows.');
    await places(c,ctx.workspaceId,locationIds,true);
    const example=input.exampleId?(await c.query(`SELECT id,layout_hash FROM ${sources} WHERE workspace_id=$1 AND id=$2 AND status='POSTED'
      AND actor_id=$3 AND rule_id IS NULL AND format=$4 AND location_ids=$5::text[]`,
      [ctx.workspaceId,input.exampleId,ctx.actorId,format,locationIds])).rows[0]:null;
    if(input.exampleId&&!example)throw new ValidationError('Choose a completed manually prepared count for these locations and source type.');
    await authorize(c,ctx,{lock:true,automatic:true,trained:Boolean(example?.layout_hash)});
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
    const id=newId('count-source-rule');
    await storage.reserve(c,ctx.workspaceId,'count-source-rule:'+id,8192+Buffer.byteLength(JSON.stringify(locationIds)),{finished:true});
    await c.query(`INSERT INTO ${rules}(id,workspace_id,authorized_by,revision,label,format,location_ids,maximum_rows,example_id,layout_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,ctx.workspaceId,ctx.actorId,newId('count-rule'),label,format,locationIds,limit,
      example?.id||null,example?.layout_hash||null]);
    return {id};
  });
}

function formatOf(bytes){
  return bytes.subarray(0,5).toString()==='%PDF-'||require('./image-table').isImage(bytes)||require('./image-codecs').kind(bytes)?'visual':'sheet';
}

async function addJob(c,ctx,id,stage){
  const {job}=await queue.enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind,idempotencyKey:id+':'+newId(stage),
    payload:{id,actorId:ctx.actorId,stage},maxAttempts:2,priority:stage==='read'?40:55});
  return job.id;
}

async function sourceFence(c,ctx,sourceHash,{legacy=false}={}){
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[ctx.workspaceId+':count-original:'+sourceHash]);
  if(legacy){
    const active=(await c.query(`SELECT id FROM ${sources} WHERE workspace_id=$1 AND source_hash=$2 AND status IN('APPROVED','POSTED')`,[ctx.workspaceId,sourceHash])).rows[0];
    if(active)throw new ValidationError('This original already has an approved physical count. Open the original count workflow.',{href:path+'/'+active.id});
  }else{
    const active=(await c.query(`SELECT id FROM import_plans WHERE workspace_id=$1 AND source_hash=$2
      AND (status='SUCCEEDED' OR approval_status='APPROVED') AND transformations::jsonb->>'importMode'='set' LIMIT 1`,[ctx.workspaceId,sourceHash])).rows[0];
    if(active)throw new ValidationError('This original already has an approved stock count. Continue that source.',{href:'/imports/'+active.id});
  }
}

async function enqueue(db,ctx,input){
  const filename=String(input.filename||'').trim(),bytes=input.buffer;
  if(!filename||filename.length>240||!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>require('../config').uploads.maxBytes)
    throw new ValidationError('Choose an intact count spreadsheet, PDF or image within the import upload limit.');
  const format=formatOf(bytes),sourceHash=digest(bytes);
  return operation(db,async c=>{
    await authorize(c,ctx,{lock:true});
    const routine=input.ruleId?await rule(c,ctx,input.ruleId,null,true):null;
    if(routine&&routine.format!==format)throw new ValidationError('Use the source type named in the saved routine.');
    const locationIds=routine?routine.location_ids:scopeKey(input.locationIds);
    await places(c,ctx.workspaceId,locationIds,true);
    await sourceFence(c,ctx,sourceHash);
    const prior=(await c.query(`SELECT id,location_ids FROM ${sources} WHERE workspace_id=$1 AND source_hash=$2`,[ctx.workspaceId,sourceHash])).rows[0];
    if(prior){
      if(!sameScope(prior.location_ids,locationIds))throw new ValidationError('This exact original is already associated with a different location scope.');
      return {id:prior.id,replayed:true};
    }
    const id=newId('count-source');
    await storage.reserve(c,ctx.workspaceId,'count-source-original:'+id,bytes.length+8192,{finished:true});
    const jobId=await addJob(c,ctx,id,'read');
    await c.query(`INSERT INTO ${sources}(id,workspace_id,actor_id,filename,source_hash,content,format,location_ids,rule_id,rule_revision,job_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,ctx.workspaceId,ctx.actorId,filename,sourceHash,bytes,format,locationIds,routine?.id||null,routine?.revision||null,jobId]);
    return {id,replayed:false};
  });
}

async function leased(c,job,result=null){
  const args=[job.workspaceId,job.id,job.leaseToken],guard=`WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING'
    AND lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000)`;
  const resultRow=result?await c.query('UPDATE stockchief_runtime.jobs SET result=$4::jsonb,updated_at=now() '+guard+' RETURNING id',[...args,JSON.stringify(result)]):
    await c.query('SELECT id FROM stockchief_runtime.jobs '+guard+' FOR SHARE',args);
  if(!resultRow.rowCount)throw new ValidationError('The count-source worker lost its lease. The original and completed results are preserved.');
}

const fingerprint=rows=>hash(rows.map(r=>[r.number,r.observed,r.checked,r.preview,r.issue]));

async function getRows(c,workspaceId,id,{pending=false,limit=null,after=0}={}){
  return (await c.query(`SELECT number,source_row raw,observed,checked,preview,issue,effect FROM ${rowsTable}
    WHERE workspace_id=$1 AND source_id=$2 AND number>$3${pending?' AND effect IS NULL':''} ORDER BY number LIMIT $4`,[workspaceId,id,after,limit])).rows;
}

async function saveRows(c,ctx,id,rows,{original=false}={}){
  for(let offset=0;offset<rows.length;offset+=500){
    const values=rows.slice(offset,offset+500).map(r=>({number:r.number,raw:r.raw,observed:r.observed,checked:r.checked,preview:r.preview,issue:r.issue}));
    const input=`jsonb_to_recordset($3::jsonb) x(number integer,raw jsonb,observed jsonb,checked boolean,preview jsonb,issue text)`;
    await c.query(original?`INSERT INTO ${rowsTable}(workspace_id,source_id,number,source_row,observed,checked,preview,issue)
      SELECT $1,$2,x.number,x.raw,x.observed,x.checked,x.preview,x.issue FROM ${input}`:
      `UPDATE ${rowsTable} r SET observed=x.observed,checked=x.checked,preview=x.preview,issue=x.issue FROM ${input}
      WHERE r.workspace_id=$1 AND r.source_id=$2 AND r.number=x.number AND r.effect IS NULL`,[ctx.workspaceId,id,JSON.stringify(values)]);
  }
}

async function readSource(db,ctx,source,{provider,usageKey}){
  try{return await reading.parse(source.content,source.filename);}
  catch(error){
    if(source.format!=='visual'||!provider&&!require('../config').ai.configured)throw error;
    await documents.reserveDocument(db,ctx,usageKey);
    const config=require('../config');
    provider ||= require('../ai/provider').createProviderUnobserved(config.ai.provider,config.ai.tier('fast'));
    const data=await documents.parse(source.content,{purpose:'count',additionalFields:['secondaryQuantity','secondaryUnitLabel'],authorize:()=>authorize(db,ctx),
      providerForPage:async page=>require('../commercial/model').wrap(db,ctx,provider,'import_mapping',usageKey+':page:'+page,{deferCustomerCommit:true})});
    const keys={sku:'code',location:'location',quantity:'quantity',unit:'unitLabel',lot:'lotCode',serial:'serial',
      secondary:'secondaryQuantity',secondaryUnit:'secondaryUnitLabel',cost:'unitCost',currency:'currency'};
    const rows=data.sheets.flatMap(sheet=>sheet.rows.map(row=>({raw:{sheet:sheet.name,row:row.sourceRow,
      headings:sheet.columns.map(c=>c.name),cells:row.cells,observations:row.problems||[]},
      observed:Object.fromEntries(Object.entries(keys).map(([k,field])=>[k,String(row.cells[data.mappings[field]]??'').trim()])),
      checked:false}))).map((r,index)=>({...r,number:index+1}));
    return {visual:true,rows,layoutHash:hash(data.sheets.map(sheet=>sheet.columns.map(c=>c.name))),paid:true};
  }
}

// Job 6: a count sheet whose differences are small posts on its own. The owner's count
// rule decides it exactly as for counts typed in the app: under the value limit, on a plan
// that allows it, in routine mode, outside shadow, pauses and Watch only. On Pro the sheet
// must come through a taught count routine (job 5 is trained there); Custom needs none.
// A person still checks anything read from a photo or PDF, any row that needs review, a
// unit cost written on the sheet, and every serial added or removed: a serial is one
// identified unit, so its loss or appearance is a fact to confirm, not a small difference.
async function smallDifferences(c,ctx,source,rows,parsed){
  if(parsed.visual||!rows.length||rows.some(r=>r.issue||!r.checked||!r.preview))return null;
  const effects=rows.map(r=>r.preview),currencies=[...new Set(effects.map(p=>p.currency))];
  if(currencies.length!==1||effects.some(p=>p.expected?.serial&&Number(p.delta)))return null;
  if(!source.rule_id)try{await policy.requireWorkspaceJob(c,ctx.workspaceId,5,'automatic');}catch(error){if(error instanceof DomainError)return null;throw error;}
  const decision=await require('../autopilot/count-rules').evaluate(c,ctx,{currency:currencies[0],
    lines:effects.map(p=>({delta:Number(p.delta)||0,costDeltaMinor:Number(p.costDelta)||0}))},rows.map(r=>({unitCost:r.observed?.cost??''})));
  if(!decision)return null;
  if(decision.action==='post')await require('../operations/postgres-security-audit').record(c,ctx,{action:'Count sheet posted under the count limit',
    reference:source.id,after:{exposureMinor:decision.exposureMinor,limitMinor:decision.limitMinor,currency:decision.currency}});
  return decision;
}

async function readJob(db,ctx,job,options){
  const source=await load(db,ctx,job.payload.id,{original:true});
  if(source.job_id!==job.id||source.status!=='QUEUED')return {id:source.id,replayed:true};
  await authorize(db,ctx);
  if(source.rule_id)await rule(db,ctx,source.rule_id,source.rule_revision);
  const key='physical-count-source:'+source.id+':'+hash(job.leaseToken).slice(0,16);
  try{
    const parsed=await readSource(db,ctx,source,{...options,usageKey:key});
    return await operation(db,async c=>{
      const locked=await load(c,ctx,source.id,{lock:true});
      if(locked.job_id!==job.id||locked.status!=='QUEUED')throw new ValidationError('This saved original changed before its reading could be prepared.');
      await authorize(c,ctx,{lock:true});
      await leased(c,job);
      const routine=source.rule_id?await rule(c,ctx,source.rule_id,source.rule_revision,true):null;
      if(routine&&(parsed.rows.length>routine.maximum_rows||routine.layout_hash&&parsed.layoutHash!==routine.layout_hash))
        throw new ValidationError('This original exceeds the routine’s row limit or differs from its taught layout. Prepare the original individually.');
      const locations=await places(c,ctx.workspaceId,source.location_ids,true);
      const rows=await stock.preview(c,ctx.workspaceId,locations,parsed.rows),summary={id:source.id,positions:rows.length,
        needsReview:rows.filter(r=>r.issue).length};
      await storage.reserve(c,ctx.workspaceId,'count-source-rows:'+source.id,8192+Buffer.byteLength(JSON.stringify(rows)),{finished:true});
      await saveRows(c,ctx,source.id,rows,{original:true});
      await c.query(`UPDATE ${sources} SET status='REVIEW',layout_hash=$3,evidence_hash=$4,reading_note=$5,issue=NULL WHERE workspace_id=$1 AND id=$2`,
        [ctx.workspaceId,source.id,parsed.layoutHash,fingerprint(rows),parsed.visual?'Check all visual readings against the saved original.':null]);
      const decision=await smallDifferences(c,ctx,source,rows,parsed);
      if(decision){
        const money=minor=>require('../domain/currency').format(minor,decision.currency);
        const posting=decision.action==='post',note=posting
          ?`Posted on its own: the differences come to ${money(decision.exposureMinor)}, within your ${money(decision.limitMinor)} count limit.`
          :`The differences come to ${money(decision.exposureMinor)}, over your ${money(decision.limitMinor)} count limit. Check the counts and approve them yourself.`;
        const jobId=posting?await addJob(c,ctx,source.id,'post'):null;
        await c.query(`UPDATE ${sources} SET reading_note=$3${jobId?",status='APPROVED',job_id=$4,approved_at=now()":''} WHERE workspace_id=$1 AND id=$2`,
          jobId?[ctx.workspaceId,source.id,note,jobId]:[ctx.workspaceId,source.id,note]);
        summary.posting=posting;
      }
      if(parsed.paid)await documents.commitCredits(c,ctx,key);
      await leased(c,job,summary);
      return summary;
    });
  }catch(error){
    await documents.refund(db,ctx,key);
    throw error;
  }
}

async function revise(db,ctx,id,input={}){
  return operation(db,async c=>{
    await authorize(c,ctx,{lock:true});
    const source=await load(c,ctx,id,{lock:true});
    if(source.revision!==Number(input.revision)||!['REVIEW','HELD'].includes(source.status)&&source.job_status!=='DEAD')
      throw new ValidationError('Open the current count source before checking its readings.');
    const pending=await getRows(c,ctx.workspaceId,id,{pending:true});
    if(!pending.length){
      if(source.layout_hash)throw new ValidationError('This count source already has a result.');
      const newJob=await addJob(c,ctx,id,'read');
      await c.query(`UPDATE ${sources} SET status='QUEUED',rule_id=NULL,rule_revision=NULL,job_id=$3,revision=revision+1,issue=NULL
        WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,newJob]);
      return;
    }
    const previousBytes=Buffer.byteLength(JSON.stringify(pending));
    const previous=new Map(pending.filter(r=>r.preview).map(r=>[r.number,hash(r.preview.expected)]));
    if(input.number){
      const row=pending.find(r=>r.number===Number(input.number));
      if(!row||input.confirmed!=='yes')throw new ValidationError('Confirm the physical row against the original.');
      row.observed=Object.fromEntries([...reading.fieldNames,'measureCorrection','measureReason'].map(k=>[k,String(input[k]??'').trim()]));
      if(input.exclude==='yes'){
        const reason=String(input.excludeReason||'').trim();
        if(!reason||reason.length>500)throw new ValidationError('Explain why this original row is outside the physical count.');
        row.observed.excludeReason=reason;
      }
      row.checked=true;
    }
    if(input.confirmReadings==='yes'&&input.confirmed==='yes')for(const row of pending)row.checked=true;
    await stock.preview(c,ctx.workspaceId,await places(c,ctx.workspaceId,source.location_ids,true),pending);
    for(const row of pending){
      if(row.number!==Number(input.number)&&row.preview&&previous.has(row.number)&&previous.get(row.number)!==hash(row.preview.expected)){
        row.checked=false;
        row.issue='Stock, identity or cost changed. Physically check this position again against the original before approval.';
      }
    }
    const extra=Buffer.byteLength(JSON.stringify(pending))-previousBytes;
    if(extra>0)await storage.reserve(c,ctx.workspaceId,'count-source-review:'+id+':'+source.revision,extra,{finished:true});
    await saveRows(c,ctx,id,pending);
    await c.query(`UPDATE ${sources} SET status='REVIEW',evidence_hash=$3,revision=revision+1,issue=NULL WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,id,fingerprint(pending)]);
  });
}

async function approve(db,ctx,id,input){
  return operation(db,async c=>{
    await authorize(c,ctx,{lock:true,posting:true});
    const source=await load(c,ctx,id,{lock:true});
    if(['APPROVED','POSTED'].includes(source.status)&&source.evidence_hash===input.evidence)return {id,replayed:true};
    if(source.status!=='REVIEW'||input.confirmed!=='yes'||input.evidence!==source.evidence_hash||Number(input.revision)!==source.revision)
      throw new ValidationError('Confirm the current physical counts and the recorded cost changes before posting.');
    await sourceFence(c,ctx,source.source_hash);
    const pending=await getRows(c,ctx.workspaceId,id,{pending:true});
    if(!pending.some(r=>r.preview)||pending.some(r=>r.issue||!r.checked||!r.preview&&!r.observed.excludeReason))
      throw new ValidationError('Resolve all uncertain or incomplete readings and retain an exact stock position before physical approval.');
    const fresh=await stock.preview(c,ctx.workspaceId,await places(c,ctx.workspaceId,source.location_ids,true),pending);
    if(fingerprint(fresh)!==source.evidence_hash)throw new ValidationError('Stock, identities or cost changed. Refresh the review against the original.');
    const jobId=await addJob(c,ctx,id,'post');
    await c.query(`UPDATE ${sources} SET status='APPROVED',job_id=$3,approved_at=now(),issue=NULL WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,jobId]);
    return {id,jobId,replayed:false};
  });
}

async function postJob(db,ctx,job){
  let processed=0;
  for(;processed<32;processed++){
    const result=await operation(db,async c=>{
      await authorize(c,ctx,{lock:true,posting:true});
      const source=await load(c,ctx,job.payload.id,{lock:true});
      if(source.status==='POSTED'||source.job_id!==job.id)return {id:source.id,replayed:true};
      if(source.status!=='APPROVED'||!source.approved_at)throw new ValidationError('This physical count needs current individual approval.');
      await leased(c,job);
      await sourceFence(c,ctx,source.source_hash);
      const first=(await getRows(c,ctx.workspaceId,source.id,{pending:true,limit:1}))[0];
      if(!first){
        await c.query(`UPDATE ${sources} SET status='POSTED',posted_at=now(),issue=NULL WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,source.id]);
        return {id:source.id,posted:true,processed};
      }
      if(first.observed.excludeReason){
        await c.query(`UPDATE ${rowsTable} SET effect=$4 WHERE workspace_id=$1 AND source_id=$2 AND number=$3`,
          [ctx.workspaceId,source.id,first.number,{excluded:true,reason:first.observed.excludeReason}]);
        return null;
      }
      const group=(await c.query(`SELECT number,observed,preview FROM ${rowsTable} WHERE workspace_id=$1 AND source_id=$2 AND effect IS NULL
        AND preview#>>'{expected,position}'=$3 ORDER BY number FOR UPDATE`,
        [ctx.workspaceId,source.id,first.preview.expected.position])).rows;
      await stock.assertCurrent(c,ctx.workspaceId,group);
      for(const row of group.sort(stock.effectOrder)){
        const effect=await stock.apply(c,ctx,source,row);
        await c.query(`UPDATE ${rowsTable} SET effect=$4 WHERE workspace_id=$1 AND source_id=$2 AND number=$3`,[ctx.workspaceId,source.id,row.number,effect]);
      }
      return null;
    });
    if(result)return result;
  }
  return operation(db,async c=>{
    await authorize(c,ctx,{lock:true,posting:true});
    const source=await load(c,ctx,job.payload.id,{lock:true});
    await leased(c,job);
    const next=await addJob(c,ctx,source.id,'post');
    await c.query(`UPDATE ${sources} SET job_id=$3 WHERE workspace_id=$1 AND id=$2 AND job_id=$4`,[ctx.workspaceId,source.id,next,job.id]);
    return {id:source.id,processed,continuing:true};
  });
}

async function run(job,db,options={}){
  const ctx={workspaceId:job.workspaceId,actorId:job.payload.actorId};
  try{return job.payload.stage==='read'?await readJob(db,ctx,job,options):await postJob(db,ctx,job);}
  catch(error){
    if(!(error instanceof DomainError)&&error.code!=='entitlement_required'&&error.name!=='SpreadsheetError')throw error;
    const message=String(error.message).slice(0,1000);
    await db.query(`UPDATE ${sources} s SET status='HELD',issue=$4 WHERE s.workspace_id=$1 AND s.id=$2 AND s.job_id=$3
      AND s.status IN('QUEUED','APPROVED') AND EXISTS(SELECT 1 FROM stockchief_runtime.jobs j
        WHERE j.workspace_id=s.workspace_id AND j.id=$3 AND j.status='RUNNING' AND j.lease_token=$5
        AND j.lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000))`,[ctx.workspaceId,job.payload.id,job.id,message,job.leaseToken]);
    return {id:job.payload.id,held:message};
  }
}

async function recover(c,job){
  const source=(await c.query(`SELECT id,status,job_id FROM ${sources} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
    [job.workspaceId,job.payload.id])).rows[0];
  if(!source)return null;
  if(source.status==='POSTED'||source.job_id!==job.id||job.payload.stage==='read'&&source.status==='REVIEW')
    return {id:source.id,recovered:true};
  if(job.payload.stage==='read')await documents.refund(c,{workspaceId:job.workspaceId,actorId:job.payload.actorId},
    'physical-count-source:'+source.id+':'+hash(job.leaseToken).slice(0,16));
  if(job.attemptCount>=job.maxAttempts)await c.query(`UPDATE ${sources} SET status='HELD',issue=$3 WHERE workspace_id=$1 AND id=$2
    AND status IN('QUEUED','APPROVED')`,[job.workspaceId,source.id,'The worker stopped. Review the saved original and any completed positions before continuing.']);
  return null;
}

async function page(db,ctx,{id,after}={}){
  await owner(db,ctx);
  await policy.requireWorkspaceJob(db,ctx.workspaceId,5,'draft');
  if(id){
    const source=await load(db,ctx,id),cursor=Number(after||0);
    if(!Number.isSafeInteger(cursor)||cursor<0)throw new ValidationError('Choose a current reading page.');
    const rows=await getRows(db,ctx.workspaceId,id,{after:cursor,limit:51});
    const totals=(await db.query(`SELECT count(*)::int rows,count(*) FILTER(WHERE issue IS NOT NULL)::int held,count(effect)::int done,
      coalesce(sum((preview->>'costDelta')::numeric) FILTER(WHERE effect IS NULL),0)::text value,max(preview->>'currency') currency
      FROM ${rowsTable} WHERE workspace_id=$1 AND source_id=$2`,[ctx.workspaceId,id])).rows[0];
    return {source,rows:rows.slice(0,50),next:rows.length>50?rows[49].number:null,totals,fields:reading.fieldNames};
  }
  const [locations,latest,settings,examples]=await Promise.all([
    places(db,ctx.workspaceId,null),db.query(`SELECT id,filename,format,status,issue FROM ${sources} WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 50`,[ctx.workspaceId]),
    db.query(`SELECT id,label,format,maximum_rows,example_id FROM ${rules} WHERE workspace_id=$1 AND enabled ORDER BY label,id`,[ctx.workspaceId]),
    db.query(`SELECT id,filename,format FROM ${sources} WHERE workspace_id=$1 AND status='POSTED' AND rule_id IS NULL ORDER BY posted_at DESC,id LIMIT 100`,[ctx.workspaceId]),
  ]);
  return {source:null,locations,latest:latest.rows,rules:settings.rows,examples:examples.rows};
}

module.exports={path,kind,configure,enqueue,load,revise,approve,run,recover,page,sourceFence};
