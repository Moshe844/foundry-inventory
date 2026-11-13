'use strict';
// Job 70 routine: each packed international shipment gets its paperwork.
// The packet is the commercial invoice, the packing list and the customs
// declaration (CN 23 fields), from confirmed facts only: HS code, country of
// origin and net weight per product, the sale's own values and currency, and
// the measured parcels.
//  - Pro and Custom prepare the private packet on their own. The owner still
//    reviews it, and a person signs and submits the customs form.
//  - Growth prepares the exact request; a person approves it in Needs you.
//  - Under Ask me first, or with routine work off, Pro and Custom do the same.
//  - During the first 14 days, Watch only and pause it does nothing.
// A missing or mismatched fact stops and asks in Needs you, with the reason;
// nothing is guessed, classified, filed or sent.
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const jobs=require('../operations/postgres-job-queue');
const {has}=require('../db/schema-installed');
const {ValidationError,DomainError}=require('../domain/errors');
const {hash}=require('../pricing/postgres-promotions');
const papers=require('./agent-export-papers');

const JOB=70,KIND='agent.shipping.export-papers.v1';
const checks='stockchief_runtime.agent_export_paper_checks',packets='stockchief_runtime.agent_export_paper_packets';
const scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
// Facts a person can fix stop the one shipment and ask; anything else fails the run.
const expected=error=>error instanceof DomainError&&error.status<500;
const installed=async db=>await has(db,packets)&&await has(db,checks);

// Packed outbound shipments with a saved structured destination and no
// current packet. A prepared or proposed one is looked at again once a day,
// or as soon as the shipment changes; a held one on every run.
const CANDIDATES=`SELECT s.id,s.shipment_number,s.ship_to_address,s.ship_to_address_fields,l.address AS location_address,
  f.address_fields AS origin_fields,c.status AS check_status,c.facts_key,c.reason
 FROM sales_shipments s JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id
 LEFT JOIN locations l ON l.workspace_id=s.workspace_id AND l.id=s.ship_from_location_id
 LEFT JOIN stockchief_runtime.agent_export_origin_facts f ON f.workspace_id=s.workspace_id AND f.location_id=s.ship_from_location_id
 LEFT JOIN ${checks} c ON c.workspace_id=s.workspace_id AND c.shipment_id=s.id
 WHERE s.workspace_id=$1 AND s.status='PACKED' AND s.customer_return_id IS NULL AND s.return_outbound_shipment_id IS NULL
  AND o.status<>'CANCELLED' AND s.ship_to_address_fields IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM ${packets} p WHERE p.workspace_id=s.workspace_id AND p.shipment_id=s.id AND p.status IN('DRAFT','REVIEWED'))
  AND NOT(coalesce(c.status,'HELD')<>'HELD' AND c.checked_at>=greatest(s.updated_at::timestamptz,clock_timestamp()-interval '20 hours'))`;

// Only shipments leaving the dispatch country. A free-text warehouse address
// is read as a US address; structured fields give the country exactly.
async function pending(db,workspaceId,limit=25){
  const addresses=require('./address');
  const rows=(await db.query(CANDIDATES+' ORDER BY s.updated_at,s.id LIMIT '+Number(limit),[workspaceId])).rows;
  return rows.filter(r=>{
    const to=addresses.parse(r.ship_to_address,r.ship_to_address_fields),from=addresses.parse(r.location_address,r.origin_fields);
    return Boolean(to.country)&&to.country!==from.country;
  });
}

async function ownerUser(db,workspaceId){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL ORDER BY u.created_at,u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}

async function authority(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {skip:'plan'};
  const owner=await ownerUser(db,workspaceId);if(!owner)return {skip:'owner'};
  const watching=await policy.stopped(db,workspaceId,account,papers.action,false);if(watching)return {skip:watching};
  const state=await require('../autopilot/postgres-service').getState(db,workspaceId);
  if(state.paused||state.suspended)return {skip:'Automatic work is paused.'};
  const alone=policy.permits(account.plan,JOB,'automatic')&&state.canAutomate&&!await policy.stopped(db,workspaceId,account,papers.action,true);
  return {owner,alone};
}

async function save(db,ctx,row,{status,key=null,reason=null,sku=null,proposal=null,packet=null}){
  const why=reason?String(reason).slice(0,600):null;
  await db.transaction(async c=>{
    await c.query(`INSERT INTO ${checks}(workspace_id,shipment_id,status,facts_key,reason,sku,proposal_id,packet_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(workspace_id,shipment_id) DO UPDATE SET status=EXCLUDED.status,facts_key=EXCLUDED.facts_key,reason=EXCLUDED.reason,
      sku=EXCLUDED.sku,proposal_id=EXCLUDED.proposal_id,packet_id=EXCLUDED.packet_id,checked_at=clock_timestamp()`,
    [ctx.workspaceId,row.id,status,key,why,sku,proposal,packet]);
    // A hold is audited when it starts or its reason changes, not on every run.
    if(status==='HELD'&&!(row.check_status==='HELD'&&row.reason===why))
      await audit.record(c,ctx,{action:'Export papers held for a person',reference:row.id,after:{shipment:row.shipment_number,reason:why}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function run(db,job){
  const workspaceId=job.workspaceId;
  if(!await installed(db))return {skipped:'not_installed'};
  const auth=await authority(db,workspaceId);if(auth.skip)return {skipped:auth.skip};
  const ctx={workspaceId,actorId:auth.owner},result={checked:0,prepared:0,proposed:0,held:0};
  for(const row of await pending(db,workspaceId)){
    result.checked++;
    let snapshot;
    try{snapshot=await papers.facts(db,ctx,row.id);}
    catch(error){if(!expected(error))throw error;await save(db,ctx,row,{status:'HELD',reason:error.message,sku:error.sku||null});result.held++;continue;}
    // The same facts are prepared or proposed once; the date alone is not a change.
    const key=hash({...snapshot,preparedDate:null,sourceHash:null});
    if(row.facts_key===key&&['PROPOSED','PREPARED'].includes(row.check_status)){
      await db.query(`UPDATE ${checks} SET checked_at=clock_timestamp() WHERE workspace_id=$1 AND shipment_id=$2`,[workspaceId,row.id]);continue;
    }
    try{
      if(auth.alone){
        const prepared=await papers.prepareAlone(db,ctx,row.id);
        await save(db,ctx,row,{status:'PREPARED',key,packet:prepared.id});result.prepared++;
      }else{
        const asked=await require('../assistant/postgres-service').prepareAction(db,ctx,'Prepare export papers for '+row.shipment_number,
          {action:papers.action,recordReference:row.id});
        if(!asked.proposal?.id)throw new ValidationError(asked.answer||'Choose the exact packed shipment.');
        await save(db,ctx,row,{status:'PROPOSED',key,proposal:asked.proposal.id});result.proposed++;
      }
    }catch(error){
      if(!expected(error))throw error;
      await save(db,ctx,row,{status:'HELD',reason:error.message,sku:error.sku||null});result.held++;
    }
  }
  return result;
}

async function schedule(c,workspaceId,cycleId){
  if(!await installed(c))return {queued:false};
  const account=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {queued:false};
  if(!(await pending(c,workspaceId)).length)return {queued:false};
  await jobs.enqueue(scoped(c),{workspaceId,kind:KIND,idempotencyKey:'export-papers:'+cycleId,payload:{cycleId},priority:47,maxAttempts:3});
  return {queued:true};
}

// Needs you: facts to confirm, and packets waiting for approval. A prepared
// draft is already listed by the export packet review.
async function inbox(db,workspaceId){
  if(!await installed(db))return [];
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return [];
  const rows=(await db.query(`SELECT c.shipment_id,c.status,c.reason,c.sku,c.proposal_id,c.checked_at,s.shipment_number
    FROM ${checks} c JOIN sales_shipments s ON s.workspace_id=c.workspace_id AND s.id=c.shipment_id
    LEFT JOIN stockchief_runtime.assistant_action_proposals p ON p.workspace_id=c.workspace_id AND p.id=c.proposal_id
    WHERE c.workspace_id=$1 AND s.status='PACKED' AND (c.status='HELD' OR c.status='PROPOSED' AND p.status='PENDING')
      AND NOT EXISTS(SELECT 1 FROM ${packets} k WHERE k.workspace_id=c.workspace_id AND k.shipment_id=c.shipment_id AND k.status IN('DRAFT','REVIEWED'))
    ORDER BY c.checked_at,c.shipment_id LIMIT 50`,[workspaceId])).rows;
  return rows.map(r=>r.status==='HELD'
    ?{kind:'shipping',importance:'Needs You',priority:52,title:'Export papers for '+r.shipment_number+' need your facts',happened:r.reason,
      why:'Customs facts are never guessed. Confirm them and StockChief prepares the papers.',actionLabel:'Confirm export facts',
      href:'/autopilot/export-papers'+(r.sku?'?'+new URLSearchParams({sku:r.sku})+'#trade-facts':''),sourceId:'export-paper-check:'+r.shipment_id,createdAt:r.checked_at,at:r.checked_at}
    :{kind:'shipping',importance:'Needs You',priority:51,title:'Approve export papers for '+r.shipment_number,
      happened:'The commercial invoice, packing list and customs declaration are ready to prepare from your confirmed facts.',
      why:'A person approves each export packet on your plan. Nothing is filed or sent.',actionLabel:'Review export papers',
      href:'/actions/'+r.proposal_id,sourceId:'export-paper-check:'+r.shipment_id,createdAt:r.checked_at,at:r.checked_at});
}

module.exports={KIND,run,schedule,inbox,pending,authority};
