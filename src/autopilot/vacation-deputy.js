'use strict';
const permissions=require('../actions/permissions'),policy=require('../commercial/agent-plan');
const {AuthorizationError,ValidationError}=require('../domain/errors');
const time=require('../lib/business-time');
const money=require('../domain/currency');
const exponents=Object.fromEntries([...Intl.supportedValuesOf('currency'),'CLF','UYW'].map(code=>[code,money.exponent(code)]));

function mayBuy(member){return permissions.can(member,permissions.VIEW_PURCHASING)&&permissions.can(member,permissions.APPROVE_PO);}
function mayTransfer(member){return permissions.can(member,permissions.VIEW_TRANSFERS)&&permissions.can(member,permissions.APPROVE_TRANSFER);}
const members=`SELECT u.id,u.account_id,u.name,u.role,u.permissions,u.po_approval_limit_minor,u.po_approval_currency
  FROM users u JOIN workspaces w ON w.id=u.workspace_id
  LEFT JOIN platform_account_access a ON a.account_id=u.account_id
  WHERE u.workspace_id=$1 AND u.account_id IS NOT NULL AND u.account_id<>w.owner_account_id AND u.warehouse_location_ids IS NULL AND a.disabled_at IS NULL`;

async function setting(db,workspaceId){
  return (await db.query(`SELECT d.deputy_id,d.starts_on::text,d.ends_on::text,d.revision,u.name
    FROM stockchief_runtime.vacation_deputies d LEFT JOIN users u ON u.workspace_id=d.workspace_id AND u.id=d.deputy_id
    WHERE d.workspace_id=$1`,[workspaceId])).rows[0]||{revision:0};
}
async function setup(db,ctx){
  const people=(await db.query(members+' ORDER BY u.name,u.id',[ctx.workspaceId])).rows.filter(p=>mayBuy(p)||mayTransfer(p));
  return {people,rule:await setting(db,ctx.workspaceId),today:await time.today(db,ctx.workspaceId)};
}
async function save(db,ctx,input){
  return db.transaction(async c=>{
    const owner=await c.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner' FOR SHARE",[ctx.workspaceId,ctx.actorId]);
    if(!owner.rowCount)throw new AuthorizationError('Only the inventory owner can choose a vacation deputy.');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['vacation:'+ctx.workspaceId]);
    const prior=await setting(c,ctx.workspaceId);
    if(input.revision==null||prior.revision!==Number(input.revision))throw new ValidationError('The vacation dates or deputy changed. Review the current setting.');
    if(input.remove==='1'){
      await c.query('UPDATE stockchief_runtime.vacation_deputies SET deputy_id=NULL,revision=revision+1 WHERE workspace_id=$1 AND deputy_id IS NOT NULL',[ctx.workspaceId]);
      if(prior.deputy_id)await require('../operations/postgres-security-audit').record(c,ctx,{action:'Ended vacation coverage',before:{deputy:prior.name}});
      return;
    }
    await policy.requireWorkspaceJob(c,ctx.workspaceId,202,'automatic');
    const selected=(await c.query(members+' AND u.id=$2',[ctx.workspaceId,input.deputyId])).rows[0];
    if(!selected||!mayBuy(selected)&&!mayTransfer(selected))throw new ValidationError('Choose a current team member authorized to approve purchases or transfers across this inventory.');
    const {timeZone,calendarDate}=await time.forWorkspace(c,ctx.workspaceId);
    time.dayBoundary(input.start,timeZone);time.dayBoundary(input.end,timeZone);
    if(input.end<input.start||input.end<calendarDate)throw new ValidationError('Choose a vacation end date on or after the start date and today.');
    await c.query(`INSERT INTO stockchief_runtime.vacation_deputies(workspace_id,owner_id,deputy_id,starts_on,ends_on,revision)
      VALUES($1,$2,$3,$4,$5,1) ON CONFLICT(workspace_id) DO UPDATE SET owner_id=$2,deputy_id=$3,starts_on=$4,ends_on=$5,
      revision=vacation_deputies.revision+1`,[ctx.workspaceId,ctx.actorId,selected.id,input.start,input.end]);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Scheduled vacation coverage',after:{deputy:selected.name,from:input.start,through:input.end}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function inbox(db,workspaceId,actorId){
  const active=(await db.query(`SELECT u.* FROM stockchief_runtime.vacation_deputies d JOIN users u ON u.id=d.deputy_id AND u.workspace_id=d.workspace_id
    JOIN users owner ON owner.id=d.owner_id AND owner.workspace_id=d.workspace_id AND owner.role='owner'
    JOIN workspaces w ON w.id=d.workspace_id JOIN accounts a ON a.id=w.owner_account_id
    LEFT JOIN platform_account_access access ON access.account_id=u.account_id
    WHERE d.workspace_id=$1 AND d.deputy_id=$2 AND u.account_id<>a.id AND u.warehouse_location_ids IS NULL AND access.disabled_at IS NULL
    AND (now() AT TIME ZONE coalesce(w.time_zone,a.time_zone,'UTC'))::date BETWEEN d.starts_on AND d.ends_on`,[workspaceId,actorId])).rows[0];
  if(!active)return [];
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,202,'automatic'))return [];
  const rows=[];
  if(mayBuy(active)){
    const dual=require('../purchasing/dual-approval'),rule=await dual.setting(db,workspaceId);
    const totals=require('../operations/postgres-team-access').purchaseTotalsSql('p.workspace_id','p.id',"power(10::numeric,($3::jsonb->>p.currency)::int)");
    const orders=(await db.query(`SELECT p.id,p.po_number AS number,p.currency,p.created_at,
      billed.lines+billed.charges AS amount, signatures.digests,
      ${rule.amount_minor!=null?dual.recordFields:'NULL AS header,NULL AS charges,NULL AS lines'}
      FROM purchase_orders p
      JOIN LATERAL (${totals}) billed ON billed.priced
      LEFT JOIN LATERAL (SELECT array_agg(digest) AS digests FROM stockchief_runtime.purchase_approval_signatures
        WHERE workspace_id=p.workspace_id AND purchase_order_id=p.id AND account_id=$2) signatures ON true
      WHERE p.workspace_id=$1 AND p.status IN ('DRAFT','AWAITING_APPROVAL') ORDER BY p.created_at,p.id`,[workspaceId,active.account_id,JSON.stringify(exponents)])).rows;
    for(const order of orders){
      const amount=Number(order.amount);
      if(order.amount==null||!Number.isSafeInteger(amount)||amount<0)continue;
      if(active.po_approval_limit_minor!==null&&(active.po_approval_currency!==order.currency||amount>Number(active.po_approval_limit_minor)))continue;
      const needsTwo=rule.amount_minor!=null&&(rule.currency!==order.currency||amount>Number(rule.amount_minor));
      if(needsTwo&&(!policy.permits(state.plan,205,'automatic')||order.digests?.includes(dual.digestFor(rule,order))))continue;
      rows.push({...order,type:'purchase',href:'/purchasing/orders/'+order.id});
    }
  }
  if(mayTransfer(active)){
    const transfers=(await db.query("SELECT id,transfer_number AS number,created_at FROM inventory_transfers WHERE workspace_id=$1 AND status='REQUESTED' ORDER BY created_at,id",[workspaceId])).rows;
    rows.push(...transfers.map(x=>({...x,type:'transfer',href:'/transfers/'+x.id})));
  }
  return rows.map(r=>({kind:'approval',priority:82,importance:'Important',sourceId:'vacation-'+r.id,title:'Review '+r.type+' '+r.number,
    happened:'The owner assigned this approval to you during vacation coverage.',actionLabel:'Review '+r.type,href:r.href,at:r.created_at,createdAt:r.created_at}));
}
const definition={id:202,key:'vacation-deputy',label:'Assign a vacation deputy',read:async(db,ctx)=>{
  const rule=await setting(db,ctx.workspaceId);
  return {summary:'Purchases and stock transfers appear in your deputy’s Needs you list during the dates you choose. Their existing approval permissions and purchase limits apply.',
    rows:rule.deputy_id?[{Deputy:rule.name,From:rule.starts_on,Through:rule.ends_on}]:[]};
}};
module.exports={definition,setup,save,inbox};
