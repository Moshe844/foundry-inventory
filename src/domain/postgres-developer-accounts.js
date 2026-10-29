'use strict';
const {ValidationError,AuthorizationError,NotFoundError}=require('./errors'),{newId}=require('../lib/util'),crypto=require('node:crypto');
const quote=s=>'"'+String(s).replaceAll('"','""')+'"',hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function staging(){if(process.env.STOCKCHIEF_RUNTIME_ENV!=='staging')throw new AuthorizationError('Developer account removal is available on Staging only.');}
async function admin(db,id,options={}){if(options.platformOwner)return require('./postgres-account-access').assertOwner(db,id);staging();if(!(await db.query('SELECT 1 FROM developer_account_administrators WHERE account_id=$1',[id])).rows.length)throw new AuthorizationError('Only an authorized StockChief developer can remove test accounts.');}
async function review(db,actorAccountId,email,options={}){
 await admin(db,actorAccountId,options);const normalized=require('./postgres-auth-service').normaliseEmail?require('./postgres-auth-service').normaliseEmail(email):String(email||'').trim().toLowerCase();
 const target=(await db.query('SELECT id,email,name,created_at FROM accounts WHERE lower(email)=lower($1)',[normalized])).rows[0];if(!target)throw new NotFoundError('No account uses that email address.');
 const workspaces=(await db.query(`SELECT w.id,w.name,w.owner_account_id,
  (SELECT count(*)::text FROM items i WHERE i.workspace_id=w.id) products,
  (SELECT count(*)::text FROM accounting_journal_entries j WHERE j.workspace_id=w.id) journals
  FROM workspaces w WHERE w.owner_account_id=$1 ORDER BY w.id`,[target.id])).rows;
 const blockers=[];
 if(target.id===actorAccountId)blockers.push('You cannot remove the developer account you are currently using.');
 if((await db.query('SELECT 1 FROM developer_account_administrators WHERE account_id=$1 UNION ALL SELECT 1 FROM commercial_admin_accounts WHERE account_id=$1 UNION ALL SELECT 1 FROM platform_console_operators WHERE account_id=$1 AND active=true',[target.id])).rows.length)blockers.push('Remove this account’s developer access before deleting it.');
 if((await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id WHERE u.account_id=$1 AND w.owner_account_id IS DISTINCT FROM $1 LIMIT 1`,[target.id])).rows.length)blockers.push('This account belongs to another owner’s inventory. Remove that membership first.');
 const sub=(await db.query('SELECT stripe_subscription_id,status FROM account_subscriptions WHERE account_id=$1',[target.id])).rows[0];
 if(sub?.stripe_subscription_id&&sub.status!=='CANCELLED')blockers.push('Cancel the provider subscription through Billing and verify cancellation before removing the account.');
 if((await db.query(`SELECT 1 FROM stockchief_runtime.codex_pilots p JOIN workspaces w ON w.id=p.workspace_id WHERE w.owner_account_id=$1 AND coalesce(p.admission_kind,'PILOT')<>'COMMERCIAL' LIMIT 1`,[target.id])).rows.length)blockers.push('This account owns an approved certification spending ledger. Its authority and usage must be retained.');
 const ids=workspaces.map(w=>w.id);
 const busy=(await db.query(`SELECT EXISTS(SELECT 1 FROM stockchief_runtime.jobs WHERE workspace_id=ANY($1::text[]) AND status='RUNNING')
 OR EXISTS(SELECT 1 FROM stockchief_runtime.assistant_goals WHERE workspace_id=ANY($1::text[]) AND status IN ('READY','RUNNING'))
 OR EXISTS(SELECT 1 FROM stockchief_runtime.provider_effects WHERE workspace_id=ANY($1::text[]) AND status IN ('RUNNING','AMBIGUOUS'))
 OR EXISTS(SELECT 1 FROM shipping_label_transactions WHERE workspace_id=ANY($1::text[]) AND status IN ('PENDING','REVIEW'))
 OR EXISTS(SELECT 1 FROM commercial_model_cost_holds WHERE account_id=$2 AND status IN ('RESERVED','UNKNOWN'))
 OR EXISTS(SELECT 1 FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=ANY($1::text[]) AND state IN ('RESERVED','UNKNOWN')) AS blocked`,[ids,target.id])).rows[0];
 if(busy.blocked)blockers.push('Wait for active work and reconcile uncertain provider/model outcomes before removal.');
 const access=options.platformOwner?(await db.query('SELECT disabled_at,revision FROM platform_account_access WHERE account_id=$1',[target.id])).rows[0]:null;if(options.platformOwner&&!access?.disabled_at)blockers.push('Disable account access first, so new sign-ins and business jobs cannot start during removal.');
 const snapshot={target,workspaces,...(options.platformOwner?{accessRevision:Number(access?.revision||0)}:{})};return {...snapshot,blockers,canDelete:!blockers.length,reviewHash:hash(snapshot)};
}
async function queue(db,actorAccountId,input,options={}){
 await admin(db,actorAccountId,options);const actor=(await db.query('SELECT password_hash FROM accounts WHERE id=$1',[actorAccountId])).rows[0];
 if(!require('./auth-service').verifyPassword(actor?.password_hash,String(input.password||'')))throw new ValidationError(options.platformOwner?'Your owner-console password did not match.':'Your developer password did not match.');
 if(input.confirmed!=='yes'||String(input.confirmEmail||'').trim().toLowerCase()!==String(input.email||'').trim().toLowerCase())throw new ValidationError('Type the exact account email and confirm permanent removal.');
 const reason=options.platformOwner?require('../lib/util').requireText(input.reason,'Reason for deletion',{max:1000}):null;if(reason&&reason.length<8)throw new ValidationError('Explain the deletion reason in at least 8 characters.');const requestKey=options.platformOwner?require('../lib/util').requireText(input.requestKey,'Deletion reference',{max:100}):null;
 return db.transaction(async c=>{if(requestKey){await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['platform-deletion:'+actorAccountId+':'+requestKey]);const prior=(await c.query('SELECT id,email_digest,review_hash,reason FROM developer_account_deletions WHERE actor_account_id=$1 AND request_key=$2',[actorAccountId,requestKey])).rows[0];if(prior){if(prior.email_digest!==hash(String(input.email||'').trim().toLowerCase())||prior.review_hash!==input.reviewHash||prior.reason!==reason)throw new ValidationError('That deletion reference was used for a different review.');return {requestId:prior.id,queued:true,replayed:true};}}const r=await review(c,actorAccountId,input.email,options);if(!r.canDelete)throw new ValidationError(r.blockers.join(' '));if(r.reviewHash!==input.reviewHash)throw new ValidationError('The account changed. Review its current inventories before confirming removal.');
 const id=newId('accountdelete');await c.query(`INSERT INTO developer_account_deletions(id,actor_account_id,target_account_id,email_digest,review_hash,workspace_ids,environment,status,expires_at,authority,reason,request_key) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'QUEUED',now()+interval '1 hour',$8,$9,$10)`,[id,actorAccountId,r.target.id,hash(r.target.email),r.reviewHash,JSON.stringify(r.workspaces.map(w=>w.id)),options.platformOwner?(process.env.STOCKCHIEF_RUNTIME_ENV||'production'):'staging',options.platformOwner?'PLATFORM_OWNER':'DEVELOPER_TEST',reason,requestKey]);
 if(options.platformOwner)await require('../commercial/control-service').audit(c,{actorAccountId,subjectType:'platform_account_deletion',subjectId:r.target.id,action:'explicitly_approve_deletion',afterState:{requestId:id,workspaces:r.workspaces.length},reason});
 await require('../operations/postgres-job-queue').enqueue({query:c.query.bind(c),transaction:fn=>fn(c)},{kind:'developer.account-delete',idempotencyKey:id,payload:{requestId:id},priority:70,maxAttempts:1});
 return {requestId:id,queued:true};},{isolation:'SERIALIZABLE',retrySafe:true});
}
async function removeAccountRows(c,accountId){
 const edges=(await c.query(`SELECT con.conrelid::text child,con.confrelid::text parent,con.confdeltype action,n.nspname schema,t.relname name,
 array_agg(a.attname::text ORDER BY k.i) columns,array_agg(p.attname::text ORDER BY k.i) parent_columns
 FROM pg_constraint con JOIN pg_class t ON t.oid=con.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
 CROSS JOIN LATERAL generate_subscripts(con.conkey,1) k(i) JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=con.conkey[k.i]
 JOIN pg_attribute p ON p.attrelid=con.confrelid AND p.attnum=con.confkey[k.i] WHERE con.contype='f' AND n.nspname IN ('public','stockchief_runtime') GROUP BY con.oid,n.nspname,t.relname`)).rows;
 const oid=(await c.query("SELECT 'accounts'::regclass::oid::text oid")).rows[0].oid,known=new Map([[oid,{schema:'public',name:'accounts',predicate:'id=$1'}]]);
 let changed=true;while(changed){changed=false;for(const e of edges)if(known.has(e.parent)&&!known.has(e.child)&&!['n','d'].includes(e.action)){
  const p=known.get(e.parent);known.set(e.child,{schema:e.schema,name:e.name,predicate:'('+e.columns.map(quote).join(',')+') IN (SELECT '+e.parent_columns.map(quote).join(',')+' FROM '+quote(p.schema)+'.'+quote(p.name)+' WHERE '+p.predicate+')'});changed=true;}}
 const active=new Map();for(const[k,v]of known)if((await c.query('SELECT 1 FROM '+quote(v.schema)+'.'+quote(v.name)+' WHERE '+v.predicate+' LIMIT 1',[accountId])).rows.length)active.set(k,v);
 while(active.size){const ready=[...active].filter(([id])=>!edges.some(e=>active.has(e.child)&&e.parent===id&&e.child!==id&&!['n','d'].includes(e.action)));if(!ready.length)throw new ValidationError('A linked account record needs review. No account data was removed.');for(const[id,v]of ready){await c.query('DELETE FROM '+quote(v.schema)+'.'+quote(v.name)+' WHERE '+v.predicate,[accountId]);active.delete(id);}}
}
async function execute(db,requestId){return db.transaction(async c=>{
 const d=(await c.query('SELECT * FROM developer_account_deletions WHERE id=$1 FOR UPDATE',[requestId])).rows[0];if(!d)throw new NotFoundError('That account-removal request is unavailable.');if(d.status==='COMPLETED')return {completed:true,replayed:true};await admin(c,d.actor_account_id,{platformOwner:d.authority==='PLATFORM_OWNER'});if(d.environment!==(process.env.STOCKCHIEF_RUNTIME_ENV||'production'))throw new AuthorizationError('This deletion belongs to a different environment.');if(new Date(d.expires_at)<=new Date())throw new ValidationError('This account-removal confirmation expired. Review it again.');
 const target=(await c.query('SELECT email FROM accounts WHERE id=$1 FOR UPDATE',[d.target_account_id])).rows[0];if(!target)throw new ValidationError('The account no longer matches its reviewed state.');const r=await review(c,d.actor_account_id,target.email,{platformOwner:d.authority==='PLATFORM_OWNER'});if(!r.canDelete||r.reviewHash!==d.review_hash)throw new ValidationError('The account changed or work is still active. Review it again; nothing was removed.');
 const ids=d.workspace_ids;await c.query("UPDATE developer_account_deletions SET status='EXECUTING' WHERE id=$1",[requestId]);await c.query("SELECT set_config('stockchief.runtime_environment',$2,true),set_config('stockchief.developer_purge_request',$1,true)",[requestId,d.environment]);
 await c.query(`INSERT INTO commercial_deleted_ai_receipts(receipt_kind,receipt_id,funding_workspace_id,charged_micro_usd)
 SELECT 'native',id,coalesce(detail->>'certificationFundingWorkspaceId',funding_workspace_id),charged FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=ANY($1::text[]) AND state='SETTLED' ON CONFLICT DO NOTHING`,[ids]);
 await c.query(`INSERT INTO commercial_deleted_ai_receipts(receipt_kind,receipt_id,funding_workspace_id,charged_micro_usd)
 SELECT 'model_hold',id,detail->>'certificationFundingWorkspaceId',(coalesce(actual_minor,0)*10000)::bigint FROM commercial_model_cost_holds WHERE account_id=$1 AND status='SETTLED' AND detail->>'certificationFundingWorkspaceId' IS NOT NULL ON CONFLICT DO NOTHING`,[d.target_account_id]);
 for(const workspaceId of ids){await c.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[workspaceId]);await c.query("SELECT set_config('stockchief.purge_workspace',$1,true)",[workspaceId]);await require('../commercial/subscription-refund-retention').purgeWorkspace(c,workspaceId);}
 await c.query("DELETE FROM stockchief_runtime.sessions WHERE data->>'accountId'=$1",[d.target_account_id]);
 await c.query("DELETE FROM stockchief_runtime.jobs WHERE payload->>'accountId'=$1 AND status<>'RUNNING'",[d.target_account_id]);
 await removeAccountRows(c,d.target_account_id);await c.query("UPDATE developer_account_deletions SET status='COMPLETED',completed_at=now() WHERE id=$1",[requestId]);return {completed:true,workspacesRemoved:ids.length,signInAccountRemoved:true,spendingReceiptsRetained:true};
 },{isolation:'SERIALIZABLE',statementTimeoutMs:120000,retrySafe:true});}
module.exports={assertAdmin:admin,review,queue,execute};
