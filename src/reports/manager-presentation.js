'use strict';

// Job 214: remembers how each manager likes their reports and approvals.
// Custom only. Each manager with inventory-wide management access keeps their
// own report dates, download format, decision order and first filter in Needs
// you, rows on item reports, grouped or one-by-one approvals, the channel
// approvals reach them on, and the hour for new scheduled reports.
//
// A manager can set each one, and StockChief also learns from what that
// manager actually chooses: the same choice made three times in a row, where
// it differs from the saved preference, becomes the preference. Only the
// manager's own choices count, never another manager's. An explicit choice on
// a page always wins for that page. Every preference is shown with where it
// came from, and each one, or all, can be reset to the standard.

const plan=require('../commercial/agent-plan'),permissions=require('../actions/permissions');
const installed=require('../db/schema-installed');
const {AuthorizationError,ValidationError}=require('../domain/errors');

const table='stockchief_runtime.manager_presentation',recent='stockchief_runtime.manager_preference_choices';
const LEARN_AFTER=3,KEEP=10;
const hours=Object.fromEntries([['default','Use the standard time'],...Array.from({length:24},(_,h)=>[String(h),String(h).padStart(2,'0')+':00'])]);
const choices={
  report_period:{default:'Use the standard report dates',last_7_days:'Last 7 days',last_30_days:'Last 30 days',last_month:'Last month',year_to_date:'Year to date'},
  download_format:{default:'Show download choices',csv:'CSV',xlsx:'Excel',pdf:'PDF'},
  inbox_sort:{priority:'Most important first',oldest:'Oldest first',newest:'Newest first'},
  inbox_category:{all:'Everything',approval:'Approvals',clarification:'Questions',mail:'Messages',inventory:'Inventory',accounting:'Money',orders:'Orders & deliveries',connection:'Connections',other:'Other issues'},
  report_view:{default:'Each report’s standard rows',items:'By item',variants:'By variant'},
  approval_grouping:{grouped:'Group similar approvals',one_by_one:'Show approvals one by one'},
  approval_channel:{all:'Every way the owner chose',email:'Email only',sms:'Text message only',push:'Push only'},
  report_hour:hours
};
const labels={report_period:'Default report dates',download_format:'Preferred report download',inbox_sort:'Order of decisions in Needs you',
  inbox_category:'What Needs you shows first',report_view:'Rows on item reports',approval_grouping:'Similar approvals',
  approval_channel:'How approvals reach you',report_hour:'Hour for new scheduled reports'};
const legacy=['report_period','download_format','inbox_sort'];
const added=['inbox_category','report_view','approval_grouping','approval_channel','report_hour'];
const standard={report_period:'default',download_format:'default',inbox_sort:'priority',inbox_category:'all',report_view:'default',
  approval_grouping:'grouped',approval_channel:'all',report_hour:null};
const defaults={...standard,learned:{},revision:0};
// A preference as the choice list names it.
const valueOf=(view,key)=>key==='report_hour'?(view.report_hour==null?'default':String(view.report_hour)):String(view[key]);
const stored=(key,value)=>key==='report_hour'?(value==='default'?null:Number(value)):value;

function manager(user){
  return user&&[permissions.ADMIN,permissions.APPROVE_PO,permissions.MANAGE_SALES,permissions.MANAGE_ACCOUNTING,permissions.MANAGE_REPLENISHMENT,permissions.MANAGE_FULFILLMENT_WAVES].some(p=>permissions.can(user,p));
}
async function personal(db,ctx,{required=false}={}){
  // Older databases do not have the job 214 additions yet.
  const extended=await installed.has(db,table,'learned');
  const member=(await db.query(`SELECT u.role,u.permissions,u.warehouse_location_ids,p.report_period,p.download_format,p.inbox_sort,p.revision
      ${extended?',p.inbox_category,p.report_view,p.approval_grouping,p.approval_channel,p.report_hour,p.learned':''}
    FROM users u JOIN accounts a ON a.id=u.account_id LEFT JOIN platform_account_access x ON x.account_id=a.id
    LEFT JOIN ${table} p ON p.workspace_id=u.workspace_id AND p.actor_id=u.id
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
  if(!member.revision)return {...defaults,learned:{}};
  const view={...defaults,report_period:member.report_period,download_format:member.download_format,inbox_sort:member.inbox_sort,revision:member.revision};
  if(extended)Object.assign(view,{inbox_category:member.inbox_category,report_view:member.report_view,approval_grouping:member.approval_grouping,
    approval_channel:member.approval_channel,report_hour:member.report_hour==null?null:Number(member.report_hour),learned:member.learned||{}});
  return view;
}

const lock=(c,ctx)=>c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['manager-view:'+ctx.workspaceId+':'+ctx.actorId]);
async function write(c,ctx,next,learned,{extended}){
  const columns=['report_period','download_format','inbox_sort',...(extended?added:[])];
  const values=columns.map(key=>stored(key,valueOf(next,key)));
  const all=[...columns,...(extended?['learned']:[])],params=[ctx.workspaceId,ctx.actorId,...values,...(extended?[JSON.stringify(learned)]:[])];
  await c.query(`INSERT INTO ${table}(workspace_id,actor_id,${all.join(',')},revision)
    VALUES($1,$2,${all.map((_,i)=>'$'+(i+3)).join(',')},1)
    ON CONFLICT(workspace_id,actor_id) DO UPDATE SET ${all.map(key=>key+'=excluded.'+key).join(',')},revision=${table.split('.')[1]}.revision+1`,params);
}

// The manager's own choices on the preferences page.
async function save(db,ctx,input){
  return db.transaction(async c=>{
    await lock(c,ctx);
    const current=await personal(c,ctx,{required:true});
    if(input.revision==null||Number(input.revision)!==current.revision)throw new ValidationError('Your preferences changed. Reload before saving.');
    const extended=await installed.has(c,table,'learned');
    for(const key of legacy)if(!Object.hasOwn(choices[key],input[key]))throw new ValidationError('Choose one of the listed report and approval preferences.');
    for(const key of added)if(input[key]!==undefined&&!Object.hasOwn(choices[key],String(input[key])))throw new ValidationError('Choose one of the listed report and approval preferences.');
    const next={...current};
    for(const key of [...legacy,...added])if(input[key]!==undefined)next[key]=key==='report_hour'?stored(key,String(input[key])):String(input[key]);
    // A preference the manager changed here is their own choice now.
    const learned=Object.fromEntries(Object.entries(current.learned||{}).filter(([key])=>valueOf(next,key)===valueOf(current,key)));
    await write(c,ctx,next,learned,{extended});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Back to the standard, for one preference or all of them. Its recent
// choices are forgotten too, so learning starts again from new choices.
async function reset(db,ctx,input={}){
  const key=String(input.preference||'');
  if(key!=='all'&&!Object.hasOwn(choices,key))throw new ValidationError('Choose a preference to reset.');
  return db.transaction(async c=>{
    await lock(c,ctx);
    const current=await personal(c,ctx,{required:true});
    const extended=await installed.has(c,table,'learned');
    const keys=key==='all'?Object.keys(choices):[key],next={...current},learned={...current.learned};
    for(const name of keys){next[name]=standard[name];delete learned[name];}
    await write(c,ctx,next,learned,{extended});
    if(await installed.has(c,recent))await c.query(`DELETE FROM ${recent} WHERE workspace_id=$1 AND actor_id=$2 AND preference=ANY($3::text[])`,
      [ctx.workspaceId,ctx.actorId,keys]);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// One choice a manager made on a page. After the same choice three times in
// a row it becomes their preference, unless it already is.
async function note(db,ctx,key,value){
  value=String(value??'');
  if(!Object.hasOwn(choices,key)||key==='approval_channel'||!Object.hasOwn(choices[key],value)||!ctx?.actorId)return null;
  if(!await installed.has(db,recent))return null;
  if(!await personal(db,ctx))return null;
  return db.transaction(async c=>{
    await lock(c,ctx);
    const current=await personal(c,ctx);
    if(!current)return null;
    await c.query(`INSERT INTO ${recent}(workspace_id,actor_id,preference,value) VALUES($1,$2,$3,$4)`,[ctx.workspaceId,ctx.actorId,key,value]);
    await c.query(`DELETE FROM ${recent} WHERE workspace_id=$1 AND actor_id=$2 AND preference=$3 AND id NOT IN(
      SELECT id FROM ${recent} WHERE workspace_id=$1 AND actor_id=$2 AND preference=$3 ORDER BY id DESC LIMIT ${KEEP})`,[ctx.workspaceId,ctx.actorId,key]);
    const last=(await c.query(`SELECT value FROM ${recent} WHERE workspace_id=$1 AND actor_id=$2 AND preference=$3 ORDER BY id DESC LIMIT ${LEARN_AFTER}`,
      [ctx.workspaceId,ctx.actorId,key])).rows;
    if(last.length<LEARN_AFTER||last.some(row=>row.value!==value)||valueOf(current,key)===value)return {learned:false};
    const next={...current,[key]:stored(key,value)};
    await write(c,ctx,next,{...current.learned,[key]:{value,at:new Date().toISOString()}},{extended:true});
    return {learned:true};
  },{isolation:'READ COMMITTED'});
}

// Learning reads only real choices: a date range picked on a report matches
// one of the remembered periods, or it teaches nothing.
async function notePeriod(db,ctx,query){
  if(query?.picked!=='period'||!query.from||!query.to)return null;
  const calendar=await require('../lib/business-time').forWorkspace(db,ctx.workspaceId);
  const {bounds}=require('./relative-dates');
  const key=Object.keys(choices.report_period).filter(k=>k!=='default').find(k=>{const b=bounds(k,calendar);return b.from===query.from&&b.to===query.to;});
  return key?note(db,ctx,'report_period',key):null;
}

async function dateQuery(db,ctx,query,view){
  if(!view||view.report_period==='default'||query.from!==undefined||query.to!==undefined)return query;
  const calendar=await require('../lib/business-time').forWorkspace(db,ctx.workspaceId);
  return {...query,...require('./relative-dates').bounds(view.report_period,calendar)};
}

// The page: each preference with its current value and where it came from.
async function page(db,ctx){
  const current=await personal(db,ctx,{required:true});
  const ownerChannels=await approvalChannels(db,ctx.workspaceId);
  return {current,choices,ownerChannels,rows:Object.keys(choices).map(key=>{
    const value=valueOf(current,key),learned=current.learned?.[key]?.value===value;
    return {key,label:labels[key],value,text:choices[key][value],
      source:learned?'Learned from your last '+LEARN_AFTER+' choices':value===valueOf(standard,key)?'Standard':'You chose this'};
  })};
}
async function approvalChannels(db,workspaceId){
  if(!await installed.has(db,'stockchief_runtime.agent_alert_channels','sms'))return [];
  const row=(await db.query('SELECT email_connector_id,sms,push FROM stockchief_runtime.agent_alert_channels WHERE workspace_id=$1 AND job_id=175',[workspaceId])).rows[0];
  return row?[row.email_connector_id&&'email',row.sms&&'sms',row.push&&'push'].filter(Boolean):[];
}

// Job 175 sends approval links on the channels the owner chose. A Custom
// manager who keeps them to one of those channels gets them only there.
async function approvalChannelFor(db,workspaceId,account){
  if(!plan.usesAgentTerms(account)||!plan.permits(account.plan,214,'automatic')||!await installed.has(db,table,'approval_channel'))return new Map();
  return new Map((await db.query(`SELECT actor_id,approval_channel FROM ${table} WHERE workspace_id=$1 AND approval_channel<>'all'`,[workspaceId])).rows
    .map(row=>[row.actor_id,row.approval_channel]));
}

const definition={id:214,key:'my-manager-preferences',label:'My report and approval preferences',read:async(db,ctx)=>{
  const view=await page(db,ctx);
  return {summary:'Your preferences apply in this inventory. Each one shows where it came from.',
    rows:view.rows.map(row=>({Preference:row.label,Setting:row.text,From:row.source,link:'/reports/my-preferences'}))};
}};
module.exports={choices,labels,standard,LEARN_AFTER,personal,save,reset,note,notePeriod,dateQuery,page,approvalChannelFor,definition};
