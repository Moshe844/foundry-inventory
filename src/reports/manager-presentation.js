'use strict';
const plan=require('../commercial/agent-plan'),permissions=require('../actions/permissions');
const {AuthorizationError,ValidationError}=require('../domain/errors');
const choices={
  report_period:{default:'Use the standard report dates',last_7_days:'Last 7 days',last_30_days:'Last 30 days',last_month:'Last month',year_to_date:'Year to date'},
  download_format:{default:'Show download choices',csv:'CSV',xlsx:'Excel',pdf:'PDF'},
  inbox_sort:{priority:'Most important first',oldest:'Oldest first',newest:'Newest first'}
};
const defaults={report_period:'default',download_format:'default',inbox_sort:'priority',revision:0};
function manager(user){
  return user&&[permissions.ADMIN,permissions.APPROVE_PO,permissions.MANAGE_SALES,permissions.MANAGE_ACCOUNTING,permissions.MANAGE_REPLENISHMENT,permissions.MANAGE_FULFILLMENT_WAVES].some(p=>permissions.can(user,p));
}
async function personal(db,ctx,{required=false}={}){
  const member=(await db.query(`SELECT u.role,u.permissions,u.warehouse_location_ids,p.report_period,p.download_format,p.inbox_sort,p.revision
    FROM users u JOIN accounts a ON a.id=u.account_id LEFT JOIN platform_account_access x ON x.account_id=a.id
    LEFT JOIN stockchief_runtime.manager_presentation p ON p.workspace_id=u.workspace_id AND p.actor_id=u.id
    WHERE u.workspace_id=$1 AND u.id=$2 AND x.disabled_at IS NULL`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!manager(member)||(member.role!=='owner'&&member.warehouse_location_ids!==null)){
    if(required)throw new AuthorizationError('Inventory-wide management access is required for these preferences.');
    return null;
  }
  if(required)await plan.requireWorkspaceJob(db,ctx.workspaceId,214,'automatic');
  else{
    const state=await plan.accountState(db,ctx.workspaceId);
    if(!plan.usesAgentTerms(state)||!plan.permits(state.plan,214,'automatic'))return null;
  }
  return member.revision?{report_period:member.report_period,download_format:member.download_format,inbox_sort:member.inbox_sort,revision:member.revision}:{...defaults};
}
async function save(db,ctx,input){
  return db.transaction(async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['manager-view:'+ctx.workspaceId+':'+ctx.actorId]);
    const current=await personal(c,ctx,{required:true});
    if(input.revision==null||Number(input.revision)!==current.revision)throw new ValidationError('Your preferences changed. Reload before saving.');
    for(const key of Object.keys(choices))if(!Object.hasOwn(choices[key],input[key]))throw new ValidationError('Choose one of the listed report and approval preferences.');
    await c.query(`INSERT INTO stockchief_runtime.manager_presentation(workspace_id,actor_id,report_period,download_format,inbox_sort,revision)
      VALUES($1,$2,$3,$4,$5,1) ON CONFLICT(workspace_id,actor_id) DO UPDATE SET report_period=$3,download_format=$4,inbox_sort=$5,revision=manager_presentation.revision+1`,
      [ctx.workspaceId,ctx.actorId,input.report_period,input.download_format,input.inbox_sort]);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function dateQuery(db,ctx,query,view){
  if(!view||view.report_period==='default'||query.from!==undefined||query.to!==undefined)return query;
  const calendar=await require('../lib/business-time').forWorkspace(db,ctx.workspaceId);
  return {...query,...require('./relative-dates').bounds(view.report_period,calendar)};
}
const definition={id:214,key:'my-manager-preferences',label:'My report and approval preferences',read:async(db,ctx)=>{
  const view=await personal(db,ctx,{required:true});
  return {summary:'Your preferences apply in this inventory.',rows:[{'Report dates':choices.report_period[view.report_period],
    'Download':choices.download_format[view.download_format],'Decision order':choices.inbox_sort[view.inbox_sort],link:'/reports/my-preferences'}]};
}};
module.exports={choices,personal,save,dateQuery,definition};
