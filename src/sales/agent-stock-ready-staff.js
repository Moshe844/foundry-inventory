'use strict';
// Job 50 (Growth draft, Pro and Custom alone): tell sales when a waited-for
// item is back in stock. The customer email is agent-stock-ready.js.
//
// Every routine check (refresh, before the alert check) records each order line
// that waited and now has its stock reserved (once per line), and tells the
// people who handle that customer:
//  - the salesperson: the team member who entered the order, if they can see
//    sales orders;
//  - else the team members who entered this customer's other orders in the last
//    year and can see sales orders;
//  - else the team members who can manage sales orders.
// An order the owner entered is the owner's own: the owner's Needs you notice
// tells them. Nobody else is guessed at.
//
// Each person sees it in their Needs you until they mark it seen or the line is
// no longer waiting to ship. On Pro and Custom it also goes out on the alert
// channels the owner chose for this job (jobs 166 to 175: email from the
// chosen mailbox, text and push to each person's own number and devices),
// once per person and line. Sending waits during pause, Watch only, Ask me
// first, the first 14 days and job 173's own mode; the owner can send waiting
// ones from the page. Growth shows them in Needs you only. Every change is
// audited.
const policy=require('../commercial/agent-plan'),audit=require('../operations/postgres-security-audit'),installed=require('../db/schema-installed');
const permissions=require('../actions/permissions'),exact=require('../domain/exact-quantity'),{newId}=require('../lib/util');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');

const JOB=50,ACTION='sales_order.notify_stock_ready',key='stock-ready-updates',path='/autopilot/reviews/'+key;
const LINES='stockchief_runtime.agent_stock_ready_lines',STAFF='stockchief_runtime.agent_stock_ready_staff',channels='stockchief_runtime.agent_alert_channels';
const MAX=200,EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const tx=(db,fn)=>typeof db.transaction==='function'?db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true}):fn(db);
const why={salesperson:'You entered this order.',customer:'You handle this customer’s orders.',sales:'You manage sales orders.'};

async function ready(db){return installed.has(db,STAFF);}
const allowed=state=>policy.usesAgentTerms(state)&&policy.permits(state.plan,JOB,'draft');

async function team(db,workspaceId){
  return (await db.query(`SELECT u.id,u.name,u.role,u.permissions,a.email,w.owner_account_id=u.account_id AND u.role='owner' AS is_owner
    FROM users u JOIN workspaces w ON w.id=u.workspace_id JOIN accounts a ON a.id=u.account_id
    WHERE u.workspace_id=$1 AND u.account_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL) ORDER BY u.id`,[workspaceId])).rows;
}
// The people told about one order, from the records only.
function route(order,people,handlers){
  const seller=people.find(p=>p.id===order.created_by_user_id);
  if(seller?.is_owner)return [];
  const sees=p=>!p.is_owner&&p.role!=='owner'&&permissions.can(p,permissions.VIEW_SALES);
  if(seller&&sees(seller))return [{user:seller,role:'salesperson'}];
  const usual=people.filter(p=>sees(p)&&handlers.includes(p.id));
  if(usual.length)return usual.map(user=>({user,role:'customer'}));
  return people.filter(p=>sees(p)&&permissions.can(p,permissions.MANAGE_SALES)).map(user=>({user,role:'sales'}));
}
function title(row,customer){
  return (row.order_number+' · '+customer+': '+exact.canonical(String(row.remaining))+' × '+row.code+' ('+row.item_name+') is back in stock and reserved.').replace(/\s+/g,' ').slice(0,300);
}

// Record newly ready lines, tell their people, and clear what is no longer waiting.
async function refresh(database,workspaceId){
  if(!await ready(database))return {skipped:'upgrade'};
  const state=await policy.accountState(database,workspaceId);
  if(!allowed(state))return {skipped:'plan'};
  const stock=require('./agent-stock-ready');
  return tx(database,async c=>{
    const found=(await c.query(`${stock.readyLines()} AND NOT EXISTS(SELECT 1 FROM ${LINES} n WHERE n.workspace_id=l.workspace_id AND n.sales_order_line_id=l.id)
      ORDER BY ready.at,l.id LIMIT ${MAX}`,[workspaceId])).rows;
    let told=0;
    if(found.length){
      await c.query(`INSERT INTO ${LINES}(workspace_id,sales_order_line_id,sales_order_id,quantity) SELECT $1,x.line,x.sales_order,x.quantity::numeric
        FROM jsonb_to_recordset($2::jsonb) AS x(line text,sales_order text,quantity text) ON CONFLICT DO NOTHING`,
      [workspaceId,JSON.stringify(found.map(r=>({line:r.line_id,sales_order:r.order_id,quantity:String(r.remaining)})))]);
      const people=await team(c,workspaceId),orders=[...new Set(found.map(r=>r.order_id))];
      const customers=new Map((await c.query(`SELECT o.id,o.customer_id,c.name FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
        WHERE o.workspace_id=$1 AND o.id=ANY($2::text[])`,[workspaceId,orders])).rows.map(r=>[r.id,r]));
      const handlers=new Map();
      for(const customerId of new Set([...customers.values()].map(r=>r.customer_id)))
        handlers.set(customerId,(await c.query(`SELECT DISTINCT created_by_user_id AS id FROM sales_orders WHERE workspace_id=$1 AND customer_id=$2 AND status<>'CANCELLED'
          AND created_at::timestamptz>now()-interval '365 days'`,[workspaceId,customerId])).rows.map(r=>r.id));
      for(const row of found){
        const order=customers.get(row.order_id);
        for(const {user,role} of route(row,people,handlers.get(order.customer_id)||[]))
          told+=(await c.query(`INSERT INTO ${STAFF}(workspace_id,id,sales_order_line_id,sales_order_id,user_id,role,title) VALUES($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT(workspace_id,sales_order_line_id,user_id) DO NOTHING`,[workspaceId,newId('stockready'),row.line_id,row.order_id,user.id,role,title(row,order.name)])).rowCount;
      }
    }
    // A line shipped, cancelled or no longer reserved is no longer news.
    const open=(await c.query(`SELECT DISTINCT sales_order_line_id FROM ${STAFF} WHERE workspace_id=$1 AND seen_at IS NULL AND cleared_at IS NULL`,[workspaceId])).rows.map(r=>r.sales_order_line_id);
    let cleared=0;
    if(open.length){
      const still=new Set((await c.query(`${stock.readyLines('AND l.id=ANY($2::text[])')}`,[workspaceId,open])).rows.map(r=>r.line_id));
      const gone=open.filter(id=>!still.has(id));
      if(gone.length)cleared=(await c.query(`UPDATE ${STAFF} SET cleared_at=clock_timestamp() WHERE workspace_id=$1 AND sales_order_line_id=ANY($2::text[]) AND seen_at IS NULL AND cleared_at IS NULL`,[workspaceId,gone])).rowCount;
    }
    if(found.length||told||cleared){
      const owner=people0(await team(c,workspaceId));
      await audit.record(c,{workspaceId,actorId:owner?.id||null},{action:'Told sales that waited-for stock is reserved',after:{lines:found.length,told,cleared}});
    }
    return {lines:found.length,told,cleared};
  });
}
const people0=people=>people.find(p=>p.is_owner)||null;

// ---- Needs you and "seen" ---------------------------------------------------

async function inbox(db,workspaceId,actorId){
  if(!actorId||!await ready(db))return [];
  const rows=(await db.query(`SELECT * FROM ${STAFF} WHERE workspace_id=$1 AND user_id=$2 AND seen_at IS NULL AND cleared_at IS NULL ORDER BY created_at,id LIMIT 50`,[workspaceId,actorId])).rows;
  if(!rows.length||!allowed(await policy.accountState(db,workspaceId)))return [];
  return rows.map(r=>({kind:'inventory',requiredPermissions:[permissions.VIEW_SALES],importance:'Important',priority:72,title:'Waited-for stock is back: '+r.title.split(': ')[0],
    happened:r.title,why:why[r.role]+' The customer was waiting for it.',recommendation:'Plan the shipment, and tell the customer if they expect to hear from you.',
    href:'/orders/'+encodeURIComponent(r.sales_order_id),actionLabel:'Open order',dismiss:{action:'/autopilot/stock-ready/staff/'+encodeURIComponent(r.id)+'/seen',label:'Seen'},
    sourceId:'stock-ready-staff:'+r.id,createdAt:r.created_at,timeLabel:'Ready',at:r.created_at}));
}
async function seen(database,ctx,id){
  return tx(database,async c=>{
    if(!await ready(c))throw new NotFoundError('That item is not in this inventory.');
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const user=(await c.query(`SELECT u.id,u.name,w.owner_account_id=u.account_id AND u.role='owner' AS is_owner FROM users u JOIN workspaces w ON w.id=u.workspace_id WHERE u.workspace_id=$1 AND u.id=$2`,[ctx.workspaceId,ctx.actorId])).rows[0];
    const row=(await c.query(`SELECT * FROM ${STAFF} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,String(id||'')])).rows[0];
    if(!row||!user)throw new NotFoundError('That item is not in this inventory.');
    if(row.user_id!==user.id&&!user.is_owner)throw new AuthorizationError('Only the person it was sent to, or the owner, can mark it seen.');
    if(row.seen_at||row.cleared_at)return {replayed:true};
    await c.query(`UPDATE ${STAFF} SET seen_at=clock_timestamp(),seen_by=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,user.id]);
    await audit.record(c,ctx,{action:'Marked waited-for stock as seen',reference:row.title,after:{by:user.name}});
    return {seen:1};
  });
}

// ---- The alert channels (agent-alerts.js, own sender) -----------------------

const phoneColumns=db=>installed.has(db,channels,'sms');
async function note(c,workspaceId,column,text){
  await c.query(`UPDATE ${channels} SET ${column}=$2 WHERE workspace_id=$1 AND job_id=${JOB} AND ${column} IS DISTINCT FROM $2`,[workspaceId,text?text.slice(0,500):null]);
}
// Sends each person the lines they were told about that have not gone out on
// a chosen channel yet.
async function deliver(c,workspaceId,account,setting,{manual=false}={}){
  const out={emailed:0,note:null,texted:0,pushed:0,phoneNote:null};
  if(!await ready(c))return out;
  if(setting.email_connector_id)Object.assign(out,await deliverEmail(c,workspaceId,account,setting,{manual}));
  if(await phoneColumns(c)&&(setting.sms||setting.push))Object.assign(out,await deliverPhone(c,workspaceId,account,setting,{manual}));
  return out;
}
const subject=rows=>rows.length===1?'Waited-for stock is back: '+rows[0].title.split(': ')[0]:rows.length+' waited-for items are back in stock';
async function deliverEmail(c,workspaceId,account,setting,{manual}){
  const rows=(await c.query(`SELECT * FROM ${STAFF} WHERE workspace_id=$1 AND seen_at IS NULL AND cleared_at IS NULL AND email_batch IS NULL ORDER BY user_id,created_at,id LIMIT ${MAX}`,[workspaceId])).rows;
  if(!rows.length){await note(c,workspaceId,'email_note',null);return {emailed:0,note:null};}
  const stop=await require('../autopilot/alert-phones').held(c,workspaceId,account,ACTION,manual);
  if(stop){const text='No email was sent. '+stop;await note(c,workspaceId,'email_note',text);return {emailed:0,note:text};}
  const alerts=require('../autopilot/agent-alerts'),box=(await alerts.mailboxes(c,workspaceId)).find(b=>b.id===setting.email_connector_id);
  if(!box){const text='The chosen mailbox is disconnected, paused or cannot send. Reconnect it, or choose another. No email was sent.';await note(c,workspaceId,'email_note',text);return {emailed:0,note:text};}
  const people=await team(c,workspaceId),owner=people0(people);let emailed=0,last=null;const problems=[];
  for(const holder of [...new Set(rows.map(r=>r.user_id))]){
    const person=people.find(p=>p.id===holder),list=rows.filter(r=>r.user_id===holder);
    if(!person)continue;
    if(!EMAIL.test(person.email||'')){problems.push(person.name+' has no email address.');continue;}
    const body='Stock your customers were waiting for is back and reserved for their orders.\n\n'+list.map(r=>'- '+r.title).join('\n')+
      '\n\nOpen Needs you in StockChief to see each order, and mark it seen when you have dealt with it.';
    const queued=await alerts.queue(c,workspaceId,{job:JOB,person,box,subject:subject(list),body,manual,count:list.length,authority:{userId:person.id},sender:owner?.id||person.id});
    if(queued.problem){problems.push(queued.problem);continue;}
    await c.query(`UPDATE ${STAFF} SET email_batch=$3,email_communication_id=$4 WHERE workspace_id=$1 AND id=ANY($2::text[])`,[workspaceId,list.map(r=>r.id),queued.batch,queued.communicationId]);
    emailed+=list.length;last=queued.communicationId;
  }
  await note(c,workspaceId,'email_note',problems.length?('Some emails were not sent. '+problems.join(' ')):null);
  if(last)await c.query(`UPDATE ${channels} SET last_communication_id=$2,last_emailed_at=clock_timestamp() WHERE workspace_id=$1 AND job_id=${JOB}`,[workspaceId,last]);
  return {emailed,note:problems.length?problems.join(' '):null};
}
async function deliverPhone(c,workspaceId,account,setting,{manual}){
  const phones=require('../autopilot/alert-phones'),want=['sms','push'].filter(ch=>setting[ch]),out={texted:0,pushed:0,phoneNote:null};
  const rows=(await c.query(`SELECT * FROM ${STAFF} WHERE workspace_id=$1 AND seen_at IS NULL AND cleared_at IS NULL AND (${want.map(ch=>ch+'_batch IS NULL').join(' OR ')})
    ORDER BY user_id,created_at,id LIMIT ${MAX}`,[workspaceId])).rows;
  if(!rows.length){await note(c,workspaceId,'phone_note',null);return out;}
  const stop=await phones.held(c,workspaceId,account,ACTION,manual);
  if(stop){out.phoneNote='Nothing was texted or pushed. '+stop;await note(c,workspaceId,'phone_note',out.phoneNote);return out;}
  const people=await team(c,workspaceId),owner=people0(people),problems=[];
  for(const holder of [...new Set(rows.map(r=>r.user_id))]){
    const person=people.find(p=>p.id===holder);if(!person)continue;
    for(const ch of want){
      const list=rows.filter(r=>r.user_id===holder&&!r[ch+'_batch']);if(!list.length)continue;
      const head=subject(list),body=list.length===1?list[0].title:head+'. '+list.slice(0,2).map(r=>r.title).join(' ')+(list.length>2?' And '+(list.length-2)+' more.':'');
      const batch=newId('stockready-'+ch);
      const queued=await phones.queue(c,workspaceId,{purpose:'ALERT',job:JOB,batch,userId:person.id,sms:ch==='sms',push:ch==='push',title:head.slice(0,200),body:body.slice(0,1000),
        url:phones.link(list.length===1?'/orders/'+encodeURIComponent(list[0].sales_order_id):'/needs-you'),manual});
      if(!queued[ch]){problems.push(person.name+': '+queued.problems.join(' '));continue;}
      await c.query(`UPDATE ${STAFF} SET ${ch}_batch=$3 WHERE workspace_id=$1 AND id=ANY($2::text[])`,[workspaceId,list.map(r=>r.id),batch]);
      await audit.record(c,{workspaceId,actorId:owner?.id||person.id},{action:ch==='sms'?'Alert text queued':'Alert push queued',reference:batch,
        after:{job:JOB,alerts:list.length,to:person.name,...(manual?{sentByOwner:true}:{})}});
      out[ch==='sms'?'texted':'pushed']+=list.length;
    }
  }
  out.phoneNote=problems.length?problems.join(' ').slice(0,500):null;
  await note(c,workspaceId,'phone_note',out.phoneNote);
  return out;
}
// Checked again just before the mailbox sends: the lines are still open with that person.
async function emailAuthority(db,workspaceId,grant){
  const open=(await db.query(`SELECT 1 FROM ${STAFF} WHERE workspace_id=$1 AND email_batch=$2 AND user_id=$3 AND seen_at IS NULL AND cleared_at IS NULL LIMIT 1`,
    [workspaceId,String(grant.batch||''),String(grant.userId||'')])).rowCount;
  if(!open)throw new ValidationError('These items were seen, shipped or changed before the email was sent, so it was not sent.');
}
async function phoneAuthority(db,workspaceId,m){
  const column=m.channel==='SMS'?'sms_batch':'push_batch';
  const open=(await db.query(`SELECT 1 FROM ${STAFF} WHERE workspace_id=$1 AND ${column}=$2 AND user_id=$3 AND seen_at IS NULL AND cleared_at IS NULL LIMIT 1`,
    [workspaceId,String(m.batch||''),String(m.user_id||'')])).rowCount;
  if(!open)throw new ValidationError('These items were seen, shipped or changed before the message was sent, so it was not sent.');
}
// Open lines not sent yet on a channel the owner chose.
async function waiting(db,workspaceId,setting){
  if(!await ready(db))return 0;
  const phones=setting&&await phoneColumns(db);
  const unsent=[setting?.email_connector_id?'email_batch IS NULL':null,phones&&setting.sms?'sms_batch IS NULL':null,phones&&setting.push?'push_batch IS NULL':null].filter(Boolean);
  if(!unsent.length)unsent.push('email_batch IS NULL');
  return Number((await db.query(`SELECT count(*) AS n FROM ${STAFF} WHERE workspace_id=$1 AND seen_at IS NULL AND cleared_at IS NULL AND (${unsent.join(' OR ')})`,[workspaceId])).rows[0].n);
}
// The words agent-alerts.js would use for open notices of this job.
async function lines(_db,_workspaceId,keys){return keys.map(k=>'Stock ready: '+k.reference+'.');}

module.exports={JOB,ACTION,key,path,ready,route,refresh,inbox,seen,deliver,emailAuthority,phoneAuthority,waiting,lines};
