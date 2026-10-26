'use strict';
const {ValidationError}=require('../domain/errors');
const {newId}=require('../lib/util');
function policy(){
 const enabled=process.env.STOCKCHIEF_SELF_SERVICE_TRIAL_ENABLED==='1';
 const days=Number(process.env.STOCKCHIEF_SELF_SERVICE_TRIAL_DAYS||14);
 if(!Number.isSafeInteger(days)||days<1||days>30)throw new ValidationError('The trial duration is not configured correctly.');
 return {enabled,days,planId:process.env.STOCKCHIEF_SELF_SERVICE_TRIAL_PLAN||'starter'};
}
async function activate(database,accountId){
 const trial=policy();if(!trial.enabled)throw new ValidationError('Trial signup is not available on this installation.');
 return database.transaction(async client=>{
  const account=(await client.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[accountId])).rows[0];
  if(!account?.email_verified_at)throw new ValidationError('Verify your email before starting your trial.');
  const scoped={query:(sql,args)=>client.query(sql,args),transaction:fn=>fn(client)};
  const prior=(await client.query('SELECT id FROM workspaces WHERE owner_account_id=$1 AND deletion_requested_at IS NULL ORDER BY created_at,id LIMIT 1',[accountId])).rows[0]?.id;
  if(prior)return {workspaceId:prior,created:false};
  if(account.plan!=='commercial_pending')throw new ValidationError('This account has already completed signup.');
  if((await client.query('SELECT 1 FROM account_subscriptions WHERE account_id=$1',[accountId])).rows.length)
   throw new ValidationError('This account already has a plan. Review it in Billing.');
  const plan=(await client.query("SELECT * FROM commercial_plans WHERE id=$1 AND status='ACTIVE' AND sales_only=0",[trial.planId])).rows[0];
  if(!plan)throw new ValidationError('The trial plan is unavailable.');
  const now=new Date(),ends=new Date(now.getTime()+trial.days*86400000);
  await client.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,billing_interval,
   current_period_start,current_period_end,trial_ends_at,source) VALUES($1,$2,$3,
   (SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1),
   'TRIALING','MONTHLY',$4,$5,$5,'SELF_SERVICE_TRIAL')`,[newId('sub'),accountId,plan.id,now.toISOString(),ends.toISOString()]);
  const created=await require('../domain/postgres-auth-service').createWorkspace(scoped,accountId,
   {name:account.pending_business_name||`${account.name}'s inventory`,now:now.toISOString()});
  await client.query(`UPDATE accounts SET plan='trial',pending_business_name=NULL,pending_commercial_plan_id=NULL,
   pending_billing_interval=NULL,pending_promo_code=NULL WHERE id=$1`,[accountId]);
  await client.query(`INSERT INTO account_inventory_onboarding(account_id,first_inventory_created_at)
   VALUES($1,$2) ON CONFLICT(account_id) DO NOTHING`,[accountId,now.toISOString()]);
  return {...created,created:true,trialEndsAt:ends.toISOString()};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={policy,activate};
