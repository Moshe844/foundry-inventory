'use strict';
const policy=require('../commercial/agent-plan'),permissions=require('../actions/permissions');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const repeat=require('../assistant/repeat-customer-order'),money=require('../domain/currency');
const {newId}=require('../lib/util');
const scoped=c=>({query:c.query.bind(c),transaction:fn=>fn(c)});
async function owner(db,ctx){
 const actor=(await db.query(`SELECT u.role FROM users u JOIN accounts a ON a.id=u.account_id
  LEFT JOIN platform_account_access x ON x.account_id=a.id WHERE u.workspace_id=$1 AND u.id=$2 AND x.disabled_at IS NULL`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(actor?.role!=='owner')throw new AuthorizationError('Only the inventory owner can authorize recurring customer orders.');
 return policy.requireWorkspaceJob(db,ctx.workspaceId,67,'draft');
}
function nextDate(date,cadence,anchorDay=Number(date.slice(8))){
 if(cadence!=='monthly')return require('../accounting/customer-money').addDays(date,cadence==='daily'?1:7);
 const [year,month,day]=date.split('-').map(Number),last=new Date(Date.UTC(year,month+1,0)).getUTCDate();
 return new Date(Date.UTC(year,month,Math.min(anchorDay,last))).toISOString().slice(0,10);
}
async function configure(db,ctx,input){
 return db.transaction(async c=>{
  const account=await owner(c,ctx),id=input.id||newId('standing'),revision=Number(input.revision);
  if(!Number.isSafeInteger(revision)||revision<0||!['daily','weekly','monthly'].includes(input.cadence))throw new ValidationError('Review the current schedule and choose its cadence.');
  const today=await require('../lib/business-time').today(c,ctx.workspaceId),day=String(input.firstDate||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day||day<today)throw new ValidationError('Choose a first order date from today.');
  const customer=(await c.query("SELECT * FROM customers WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE'",[ctx.workspaceId,input.customerId])).rows[0];
  if(!customer)throw new ValidationError('Choose an active customer in this inventory.');
  const preview=await repeat.prepare(c,ctx,customer,{repeatPeriod:'latest',sourceOrderNumber:input.sourceOrderNumber});
  const maximum=money.userToMinor(input.maximum,preview.payload.input.currency);
  if(maximum<=0||maximum<preview.payload.training.amountMinor)throw new ValidationError('The maximum order value must cover this reviewed example.');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['standing-orders:'+account.accountId]);
  const existing=(await c.query('SELECT * FROM stockchief_runtime.recurring_customer_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
  if((existing?.revision||0)!==revision)throw new ValidationError('This recurring order changed. Reload its schedule.');
  if((await c.query(`SELECT 1 FROM stockchief_runtime.recurring_customer_orders WHERE workspace_id=$1 AND customer_id=$2
    AND template->>'sourceOrderId'=$3 AND cadence=$4 AND id<>$5 AND NOT paused LIMIT 1`,[ctx.workspaceId,customer.id,preview.payload.sourceOrderId,input.cadence,id])).rowCount)
    throw new ValidationError('This customer already has this recurring schedule. Edit the existing schedule.');
  if(!existing||existing.paused)await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
  const snapshot={sourceOrderNumber:preview.payload.sourceOrderNumber,sourceOrderId:preview.payload.sourceOrderId,address:preview.payload.address,
    customerId:customer.id,currency:preview.payload.input.currency,deliveryMethod:preview.payload.input.deliveryMethod,
    lines:preview.payload.input.lines};
  await c.query(`INSERT INTO stockchief_runtime.recurring_customer_orders(id,workspace_id,authorized_by,customer_id,template,cadence,next_date,maximum_minor,currency,anchor_day)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::date,$8,$9,$10) ON CONFLICT(workspace_id,id) DO UPDATE SET template=excluded.template,cadence=excluded.cadence,
    next_date=excluded.next_date,maximum_minor=excluded.maximum_minor,currency=excluded.currency,anchor_day=excluded.anchor_day,authorized_by=excluded.authorized_by,revision=recurring_customer_orders.revision+1,paused=false,problem=NULL`,
    [id,ctx.workspaceId,ctx.actorId,customer.id,JSON.stringify(snapshot),input.cadence,day,maximum,snapshot.currency,Number(day.slice(8))]);
  await c.query('UPDATE stockchief_runtime.agent_operational_notices SET resolved=true WHERE workspace_id=$1 AND job_id=67 AND reference=$2',[ctx.workspaceId,id]);
  return {id};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function run(c,workspaceId,{id,revision,date}){
 const row=(await c.query("SELECT *,to_char(next_date,'YYYY-MM-DD') AS due FROM stockchief_runtime.recurring_customer_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,id])).rows[0];
 if(!row||row.paused||row.revision!==revision||row.due!==date)return {held:true};
 const ctx={workspaceId,actorId:row.authorized_by};
 await c.query('SAVEPOINT recurring_order');
 try{
  const account=await owner(c,ctx);policy.requireJob(account.plan,67,'automatic',{trained:true});
  const stopped=await policy.stopped(c,workspaceId,account,'sales_order.recurring',true);
  if(stopped)throw new ValidationError(stopped);
  if(!(await require('../autopilot/postgres-service').getState(c,workspaceId)).canAutomate)throw new ValidationError('Enable routine work before scheduled customer orders may run.');
  const customer=(await c.query("SELECT * FROM customers WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE'",[workspaceId,row.customer_id])).rows[0];
  if(!customer)throw new ValidationError('Review the recurring order’s customer.');
  const proposed=await repeat.prepare(c,ctx,customer,{repeatPeriod:'latest',sourceOrderNumber:row.template.sourceOrderNumber});
  const p=proposed.payload;
  const shape={sourceOrderNumber:p.sourceOrderNumber,sourceOrderId:p.sourceOrderId,address:p.address,customerId:customer.id,currency:p.input.currency,deliveryMethod:p.input.deliveryMethod,lines:p.input.lines};
  if(require('../pricing/postgres-promotions').hash(shape)!==require('../pricing/postgres-promotions').hash(row.template)||p.input.currency!==row.currency)
    throw new ValidationError('The template, delivery details or product quantities changed. Review this recurring order.');
  if(p.training.amountMinor>Number(row.maximum_minor))throw new ValidationError('The current order total exceeds the approved recurring limit.');
  const today=await require('../lib/business-time').today(c,workspaceId);
  if(today<date)return {held:true};
  const result=await repeat.execute(c,ctx,{...p,idempotencyKey:'standing:'+id+':'+revision+':'+date});
  if(!await repeat.verify(c,ctx,result,p))throw new Error('The recurring order did not match its template.');
  await c.query(`INSERT INTO stockchief_runtime.recurring_customer_order_runs(workspace_id,schedule_id,scheduled_date,sales_order_id)
    VALUES($1,$2,$3::date,$4) ON CONFLICT DO NOTHING`,[workspaceId,id,date,result.salesOrderId]);
  await c.query('UPDATE stockchief_runtime.recurring_customer_orders SET next_date=$3::date,problem=NULL WHERE workspace_id=$1 AND id=$2',[workspaceId,id,nextDate(date,row.cadence,row.anchor_day)]);
  await c.query('RELEASE SAVEPOINT recurring_order');
  return {salesOrderId:result.salesOrderId};
 }catch(error){
  if(![400,402,403,404].includes(error.status))throw error;
  await c.query('ROLLBACK TO SAVEPOINT recurring_order');
  await c.query('UPDATE stockchief_runtime.recurring_customer_orders SET paused=true,problem=$3 WHERE workspace_id=$1 AND id=$2',[workspaceId,id,error.message]);
  await c.query(`INSERT INTO stockchief_runtime.agent_operational_notices(workspace_id,job_id,kind,reference,link,due,last_reminded)
    VALUES($1,67,'Recurring order',$2,'/autopilot/reviews/recurring-customer-orders',$3::date,$3::date)
    ON CONFLICT(workspace_id,job_id,kind,reference,link) DO UPDATE SET resolved=false,due=excluded.due`,[workspaceId,id,date]);
  return {held:true,reason:error.message};
 }
}
async function schedule(c,workspaceId){
 const account=await policy.accountState(c,workspaceId);
 if(!account.plan||account.shadow||!policy.usesAgentTerms(account))return;
 const today=await require('../lib/business-time').today(c,workspaceId);
 const rows=(await c.query("SELECT id,revision,to_char(next_date,'YYYY-MM-DD') AS date FROM stockchief_runtime.recurring_customer_orders WHERE workspace_id=$1 AND NOT paused AND next_date<=$2::date ORDER BY next_date,id LIMIT 100",[workspaceId,today])).rows;
 for(const row of rows)await require('../operations/postgres-job-queue').enqueue(scoped(c),{workspaceId,kind:'sales.recurring-order',payload:row,idempotencyKey:'standing:'+row.id+':'+row.revision+':'+row.date,priority:45});
}
async function review(db,ctx){
 const rows=(await db.query(`SELECT r.id,r.customer_id,c.name,r.cadence,to_char(r.next_date,'YYYY-MM-DD') AS due,r.maximum_minor,r.currency,r.paused,r.problem
  FROM stockchief_runtime.recurring_customer_orders r JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id WHERE r.workspace_id=$1 ORDER BY r.next_date,r.id LIMIT 101`,[ctx.workspaceId])).rows;
 const orders=(await db.query(`SELECT o.id,o.order_number,c.name FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
  WHERE o.workspace_id=$1 AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED') AND c.record_state='ACTIVE'
  ORDER BY o.created_at DESC,o.id DESC LIMIT 100`,[ctx.workspaceId])).rows;
 const schedules=(await db.query("SELECT *,to_char(next_date,'YYYY-MM-DD') AS due FROM stockchief_runtime.recurring_customer_orders WHERE workspace_id=$1 ORDER BY next_date,id LIMIT 100",[ctx.workspaceId])).rows;
 return {rows:rows.slice(0,100).map(r=>({Customer:r.name,Cadence:r.cadence,'Next order':r.due,Maximum:money.format(r.maximum_minor,r.currency),Status:r.paused?'Needs review':'Scheduled',Review:r.problem,link:'/sales/customers/'+r.customer_id})),more:rows.length>100,
  recurringForm:{newId:newId('standing'),orders,schedules: schedules.map(s=>({...s,maximum:money.fromMinor(s.maximum_minor,s.currency)})),today:await require('../lib/business-time').today(db,ctx.workspaceId)},
  summary:'Scheduled orders use the reviewed source order, current prices and the owner’s maximum. Changes pause the schedule for review.'};
}
async function pause(db,ctx,id,revision){
 const actor=(await db.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 if(actor?.role!=='owner')throw new AuthorizationError('Only the inventory owner can stop recurring orders.');
 const result=await db.query('UPDATE stockchief_runtime.recurring_customer_orders SET paused=true,problem=NULL,revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND revision=$3',[ctx.workspaceId,id,Number(revision)]);
 if(!result.rowCount)throw new ValidationError('The recurring order changed. Reload before stopping it.');
}
const spec={name:'sales_order.recurring',description:'Authorize a recurring draft order from a customer’s exact confirmed source order. Supply standingOrder JSON with customerId, sourceOrderNumber, cadence daily/weekly/monthly, firstDate, maximum, and revision 0 for a new schedule.',
 fields:['standingOrder'],permission:permissions.MANAGE_SALES,ownerOnly:true,capability:'sales_orders.core',
 build:async(db,ctx,_row,args)=>{await owner(db,ctx);let input;try{input=JSON.parse(args.standingOrder);}catch{throw new ValidationError('Provide the customer, source order, first date, cadence and maximum as a recurring order.');}return {payload:{input},summary:'Authorize a '+input.cadence+' customer order from '+input.sourceOrderNumber+', up to '+input.maximum+' per order, starting '+input.firstDate+'.'};},
 execute:(c,ctx,p)=>configure(scoped(c),ctx,p.input),verify:async(db,ctx,r)=>Boolean((await db.query('SELECT 1 FROM stockchief_runtime.recurring_customer_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,r.id])).rowCount)};
module.exports={configure,pause,run,schedule,spec,nextDate,definition:{id:67,key:'recurring-customer-orders',label:'Standing customer orders',readPage:review}};
