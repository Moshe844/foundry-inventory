'use strict';
const {AuthorizationError,ValidationError}=require('../domain/errors');
const store=require('./postgres-goal-store');
const readonlyAuthorizations=new WeakMap();
const list=value=>String(value||'').split(',').map(s=>s.trim()).filter(Boolean);
function configured(ctx){return process.env.STOCKCHIEF_RUNTIME_ENV==='staging'&&process.env.STOCKCHIEF_CODEX_PILOT==='1'&&
 list(process.env.STOCKCHIEF_CODEX_PILOT_WORKSPACES).includes(ctx.workspaceId);}
async function access(db,ctx,{enabled=false,owner=false}={}){
 if(!configured(ctx))throw new AuthorizationError('The Codex pilot is not available in this business.');
 const actor=(await db.query(`SELECT u.id,u.role,a.email FROM users u JOIN accounts a ON a.id=u.account_id
  WHERE u.workspace_id=$1 AND u.id=$2`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!actor||!list(process.env.STOCKCHIEF_CODEX_PILOT_EMAILS).map(s=>s.toLowerCase()).includes(actor.email.toLowerCase())||owner&&actor.role!=='owner')
  throw new AuthorizationError('This account is not authorized for the Staging pilot.');
 const pilot=(await db.query('SELECT * FROM stockchief_runtime.codex_pilots WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
 if(!pilot||!pilot.authorized_actor_ids.includes(ctx.actorId)||enabled&&!pilot.enabled)
  throw new AuthorizationError('The Staging pilot is disabled for this account.');
 await require('../commercial/enforcement').workspace(db,ctx.workspaceId,'ask.lookup');
 return {actor,pilot};
}
async function selected(db,ctx){if(!configured(ctx))return false;try{await access(db,ctx,{enabled:true});return true;}catch(e){if(e instanceof AuthorizationError)return false;throw e;}}
async function view(db,ctx){if(!configured(ctx))return null;try{const {actor,pilot}=await access(db,ctx);return {
 enabled:pilot.enabled,canToggle:actor.role==='owner',funded:!pilot.stopped&&Number(pilot.ceiling_micro_usd)>0&&new Date(pilot.period_ends_at)>new Date(),
 model:'GPT-6.1 Sol',reasoning:'High'};}catch(e){if(e instanceof AuthorizationError)return null;throw e;}}
async function toggle(db,ctx,enabled){await access(db,ctx,{owner:true});
 return db.transaction(async client=>{
  await client.query(`UPDATE stockchief_runtime.codex_pilots SET enabled=$2,revision=revision+1,updated_at=now() WHERE workspace_id=$1`,[ctx.workspaceId,Boolean(enabled)]);
  if(!enabled)await client.query(`UPDATE stockchief_runtime.assistant_goals SET status='CANCELLED',run_token=NULL,lease_until=NULL,
   answer='The Staging agent was disabled. Approved operations retain their canonical recorded status.',updated_at=now()
   WHERE workspace_id=$1 AND checkpoint->>'runtime'='codex-staging' AND status NOT IN ('COMPLETED','CANCELLED','BLOCKED')`,[ctx.workspaceId]);
 });
}
async function start(db,ctx,message,options={}){
 const {pilot}=await access(db,ctx,{enabled:true});
 if(pilot.stopped||Number(pilot.ceiling_micro_usd)<=0||new Date(pilot.period_ends_at)<=new Date())
  throw new ValidationError('The pilot is enabled, but paid agent work is locked until a Staging budget is approved.');
 const goal=await store.create(db,ctx,message,{...options,budgetMinor:Math.min(options.budgetMinor||100,100)});
 if(goal.checkpoint.runtime&&goal.checkpoint.runtime!=='codex-staging')throw new ValidationError('That request already belongs to another Ask runtime.');
 await db.query(`UPDATE stockchief_runtime.assistant_goals SET checkpoint=checkpoint||$4::jsonb WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,
  [ctx.workspaceId,ctx.actorId,goal.id,JSON.stringify({runtime:'codex-staging',pilotRevision:pilot.revision})]);
 goal.checkpoint.runtime='codex-staging';
 await store.enqueue(db,goal);return {status:'CLARIFY',answer:'StockChief is investigating your goal.',goalId:goal.id,goalStatus:goal.status};
}
async function inbox(db,ctx,id){await access(db,ctx);const goal=await store.get(db,ctx,id);
 if(!goal||goal.checkpoint.runtime!=='codex-staging')throw new ValidationError('Pilot goal not found.');
 const result=await require('../../scripts/environment-agent-demo/approval-handoff').inbox(db,ctx,id);
 return {goal,approvals:result?.approvals||[]};
}
async function decide(db,ctx,id,deliveryId,sha256,approved,{responseReference}={}){
 await access(db,ctx,{enabled:true});
 const goal=await store.get(db,ctx,id);if(goal?.checkpoint.runtime!=='codex-staging')throw new ValidationError('Pilot goal not found.');
 if(goal.checkpoint.harness?.approvalDeliveries?.[deliveryId]?.sha256!==sha256)throw new ValidationError('The prepared approval changed. Reload its exact card before approving.');
 const handoff=require('../../scripts/environment-agent-demo/approval-handoff');
 const result=await handoff.decide({database:db,ctx,goalId:id,id:deliveryId,sha256,
  decision:{source:'human_user',approved:Boolean(approved),responseReference},
  execute:async(proposal,executionDb)=>{
   if(!proposal.action_type)return require('../manager/postgres-operating-instructions').approve(executionDb,ctx,proposal.id,proposal.integrity_hash);
   return require('./postgres-service').executeProposal(executionDb,{...ctx,goalId:id},proposal.id,{provider:{name:'openai',model:'gpt-6.1-sol',
    complete:async()=>{throw Error('UNAPPROVED_HELPER_MODEL_CALL');}}});
  }});
 if(!approved){const current=await inbox(db,ctx,id),card=current.approvals.find(c=>c.id===deliveryId);
  if(card?.kind==='rule')await require('../manager/postgres-operating-instructions').cancel(db,ctx,card.proposalId);
  else if(card)await require('./postgres-service').cancelProposal(db,ctx,card.proposalId);}
 const updated=await require('../../scripts/environment-agent-demo/waits').refresh(db,ctx,id);
 if(updated?.status==='READY')await store.enqueue(db,updated);return result;
}
async function run(db,ctx,id,options={}){
 await access(db,ctx,{enabled:true});return require('./postgres-codex-runtime').run(db,ctx,id,options);
}
async function readAuthorization(db,ctx,connectionString){await access(db,ctx,{enabled:true});
 if(!connectionString||connectionString!==(process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL))throw new AuthorizationError('The renderer must use the configured Staging database.');
 const token=Object.freeze({});readonlyAuthorizations.set(token,{...ctx,connectionString});return token;
}
function assertReadAuthorization(token,cluster,ctx){const p=readonlyAuthorizations.get(token);
 if(!p||!configured(ctx)||p.connectionString!==cluster.connectionString||p.workspaceId!==ctx.workspaceId||p.actorId!==ctx.actorId)
  throw new AuthorizationError('Invalid Staging renderer identity.');
}
module.exports={configured,access,selected,view,toggle,start,inbox,decide,run,readAuthorization,assertReadAuthorization};
