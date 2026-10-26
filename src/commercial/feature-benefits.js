'use strict';

const {newId}=require('../lib/util');
const {ValidationError}=require('../domain/errors');
const catalog=require('./catalog');
const control=require('./control-service');

// Release packaging only. There is no customer/agent route to this operation.
// Eligibility follows existing capabilities, never an account or plan-name list.
const FEATURES=Object.freeze({
  'communications.ai_drafts':Object.freeze(['communications.email_ingestion','ask.prepare_actions']),
});
function enabled(entries,key){return Number(entries.find(e=>e.capability===key)?.enabled)===1;}
function change(entries,key,value){
  const next=entries.map(e=>e.capability===key?{...e,enabled:value?1:0}:e);
  if(!next.some(e=>e.capability===key))next.push({capability:key,enabled:value?1:0,configuration:{}});
  return next;
}

async function set(database,input){
  const key=catalog.canonicalCapability(input.capability),prerequisites=FEATURES[key];
  if(!prerequisites||typeof input.enabled!=='boolean'||!String(input.reason||'').trim())
    throw new ValidationError('Choose a qualified feature, availability and recorded reason.');
  return database.transaction(async client=>{
    const batchId=newId('benefit');
    const plans=(await client.query('SELECT id FROM commercial_plans ORDER BY id FOR UPDATE')).rows;
    const templates=(await client.query('SELECT * FROM commercial_plan_entitlements ORDER BY plan_id,capability')).rows;
    const eligible=new Set(plans.filter(p=>prerequisites.every(k=>enabled(templates.filter(e=>e.plan_id===p.id),k))).map(p=>p.id));
    let templateCount=0,versionCount=0,subscriptionCount=0;
    if(input.enabled){
      const definition=(await client.query('SELECT * FROM commercial_capabilities WHERE capability=$1 FOR UPDATE',[key])).rows[0];
      if(definition&&definition.readiness!=='SELLABLE'){
        await client.query("UPDATE commercial_capabilities SET readiness='SELLABLE' WHERE capability=$1",[key]);
        await control.audit(client,{...input,subjectType:'capability',subjectId:key,action:'qualified_preparation',
          beforeState:definition,afterState:{...definition,readiness:'SELLABLE',batchId}});
      }
    }
    for(const planId of eligible){
      const prior=templates.find(e=>e.plan_id===planId&&e.capability===key);
      if(Boolean(Number(prior?.enabled))===input.enabled)continue;
      await client.query(`INSERT INTO commercial_plan_entitlements(plan_id,capability,enabled,configuration)
        VALUES($1,$2,$3,'{}'::jsonb) ON CONFLICT(plan_id,capability) DO UPDATE SET enabled=EXCLUDED.enabled`,
        [planId,key,input.enabled?1:0]);
      await control.audit(client,{...input,subjectType:'plan_feature_benefit',subjectId:planId,action:'availability_changed',
        beforeState:prior||null,afterState:{batchId,capability:key,enabled:input.enabled}});
      templateCount++;
    }
    const versions=(await client.query(`SELECT version.* FROM commercial_plan_versions version
      WHERE version.status='ACTIVE' OR EXISTS(SELECT 1 FROM account_subscriptions subscription
        WHERE subscription.plan_version_id=version.id) ORDER BY version.plan_id,version.version_number FOR UPDATE`)).rows;
    const maxima=new Map((await client.query('SELECT plan_id,max(version_number)::text n FROM commercial_plan_versions GROUP BY plan_id')).rows
      .map(r=>[r.plan_id,Number(r.n)]));
    for(const prior of versions){
      if(!eligible.has(prior.plan_id)||!prerequisites.every(k=>enabled(prior.entitlements,k))||enabled(prior.entitlements,key)===input.enabled)continue;
      const id=newId('planver'),number=maxima.get(prior.plan_id)+1;maxima.set(prior.plan_id,number);
      const active=prior.status==='ACTIVE';
      if(active)await client.query("UPDATE commercial_plan_versions SET status='RETIRED',effective_until=now() WHERE id=$1",[prior.id]);
      const next=(await client.query(`INSERT INTO commercial_plan_versions
        (id,plan_id,version_number,status,currency,monthly_amount_minor,annual_amount_minor,entitlements,meters,approved_by_account_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10) RETURNING *`,
        [id,prior.plan_id,number,active?'ACTIVE':'RETIRED',prior.currency,prior.monthly_amount_minor,prior.annual_amount_minor,
          JSON.stringify(change(prior.entitlements,key,input.enabled)),JSON.stringify(prior.meters),input.actorAccountId||null])).rows[0];
      await control.audit(client,{...input,subjectType:'plan_version',subjectId:id,action:'feature_benefit_version',
        beforeState:prior,afterState:{...next,featureBenefitBatchId:batchId}});
      const moved=(await client.query(`UPDATE account_subscriptions SET plan_version_id=$2,updated_at=now()
        WHERE plan_version_id=$1 RETURNING account_id`,[prior.id,id])).rows;
      for(const sub of moved)await control.audit(client,{...input,subjectType:'subscription_feature_benefit',subjectId:sub.account_id,
        action:'version_changed',beforeState:{planVersionId:prior.id},afterState:{planVersionId:id,batchId,capability:key,enabled:input.enabled}});
      versionCount++;subscriptionCount+=moved.length;
    }
    return {batchId,capability:key,enabled:input.enabled,templateCount,versionCount,subscriptionCount,
      pricesAndMetersUnchanged:true,historicalVersionContentsPreserved:true};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={set};
