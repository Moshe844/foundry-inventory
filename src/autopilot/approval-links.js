'use strict';

// Job 175: approve from email or phone. Alone on every plan.
//
// Once the owner chooses how approvals reach people (by email from a
// connected mailbox, text or push: the job 175 row of the alert channels,
// job 173), every routine check (the worker's agent.approval-links job) looks
// at each team member's Needs you. Every approval waiting there (replenishment
// purchase orders, transfers, two-person purchase signatures, suggested QC
// holds and any other decision Needs you lists) gets one link for that person,
// sent once on each channel the owner chose. Links for approvals decided
// elsewhere stop; nothing is sent for them.
//
// A link is not a key. Opening it needs the person to sign in, as the person
// it was sent to, and only shows the approval as it is now: opening never
// approves anything. For purchase orders, transfers, purchase signatures and
// QC holds the page has one button; one deliberate tap approves, through the
// approval's own service. At that tap StockChief checks again that the
// approval is still in this person's Needs you (their permission and
// membership), that it is exactly what they were shown (any change asks them
// to look again), and the service checks its own limits and state (purchase
// approval limits, plan, first 14 days, prices, supplier email). The tap is
// audited and recorded once; tapping again, or a second tap racing the first,
// approves nothing more. Every other approval opens its own page, where its own
// button decides.
//
// Sending links is work StockChief does on its own, so it waits during the
// first 14 days, pause, Watch only, Ask me first for this job or job 173, and
// an exceeded rule allowance; the owner can send waiting links from the page.

const {createHash,randomBytes}=require('node:crypto');
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const installed=require('../db/schema-installed');
const {ValidationError,NotFoundError}=require('../domain/errors');
const {newId}=require('../lib/util');

const JOB=175,ACTION='approval.link',key='approval-links',path='/autopilot/reviews/'+key,label='Approve from email or phone';
const links='stockchief_runtime.agent_approval_links',channels='stockchief_runtime.agent_alert_channels';
// A channel a manager chose not to use for approvals is marked, not sent.
const BY_PREFERENCE='not-wanted';
const DAYS=14,MAX_PEOPLE=25,MAX_SEND=200,PER_MESSAGE=3,EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/,ID=/^[A-Za-z0-9_-]{32,64}$/;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,40);
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const plural=(n,one,many)=>n+' '+(Number(n)===1?one:many);
async function ready(db){return installed.has(db,links);}

// What counts as an approval in a person's Needs you. Alerts (jobs 166 to
// 171) and items passed on (job 172) send their own messages.
function isApproval(entry){
  const source=String(entry?.sourceId||'');
  if(!entry?.href||!String(entry.href).startsWith('/')||String(entry.href).startsWith('//'))return false;
  if(source.startsWith('escalation:')||source.startsWith('agent-notice-'))return false;
  if(['clarification','recovery','mail','import','connection'].includes(entry.kind))return false;
  return entry.kind==='approval'||entry.importance==='Needs You';
}
// One approval. A later decision about the same record (a purchase waiting
// for its supplier after approval) has another title, so it is a new item.
// Grouped entries keep their key while their counts change.
const itemKey=entry=>hash([String(entry.sourceId||''),String(entry.href),...(entry.grouped?[]:[String(entry.title||'')])]);

// The checks the work page makes before Send to supplier, shared with it.
async function workBlock(database,workspaceId,item){
  const action=item.recommendedAction||{};
  if(item.execution_status!=='WAITING_FOR_APPROVAL')return null;
  if(action.type==='purchase'&&action.supplierId&&(action.unitCost==null||action.value==null))
    return {reason:'Record the supplier’s unit price before sending this purchase order.',href:'/suppliers/'+encodeURIComponent(action.supplierId),label:'Review supplier prices'};
  if(item.evidenceQuality?.level==='low')return {reason:item.evidenceQuality.reason,href:'/autopilot',label:'Review inventory and purchasing'};
  if(action.type!=='transfer'&&action.supplierId){
    const ready=await require('./postgres-service').supplierDeliveryReadiness(database,workspaceId,action.supplierId);
    if(!ready.ready)return /email address/.test(ready.reason||'')
      ?{reason:(action.supplierName||'This supplier')+' has no order email address yet, so the order can’t be sent.',href:'/suppliers/'+encodeURIComponent(action.supplierId)+'?edit=1',label:'Add the supplier’s email'}
      :{reason:ready.reason,href:'/settings/connections',label:'Fix the connection'};
  }
  return null;
}

// The approvals one tap can decide, each through its own service.
const adapters=[
  {type:'work',
    ref:e=>{const m=/^\/autopilot\/work\/([^/?#]+)$/.exec(String(e.href||''));return m?decodeURIComponent(m[1]):null;},
    async state(db,ctx,id){
      let item;
      try{item=await require('./postgres-service').getWork(db,ctx.workspaceId,id);}catch(error){if(error instanceof NotFoundError)return null;throw error;}
      if(item.execution_status!=='WAITING_FOR_APPROVAL')return null;
      const action=item.recommendedAction||{},transfer=action.type==='transfer';
      const block=action.quantityScope==='workspace'&&!action.destinationLocationId?'Choose where this delivery arrives on the full page.':(await workBlock(db,ctx.workspaceId,item))?.reason||null;
      const units=n=>Number(n)+' '+(Number(n)===1?'unit':'units');
      let total=null;try{total=action.value!=null&&/^[A-Z]{3}$/.test(action.currency||'')?new Intl.NumberFormat('en-US',{style:'currency',currency:action.currency}).format(Number(action.value)):null;}catch{total=null;}
      const detail=transfer?'Move '+units(action.quantity)+' from '+(action.sourceLocationName||'the other location')+' to '+(action.destinationLocationName||'this location')+'.'
        :'Order '+units(action.quantity)+' from '+(action.supplierName||'the supplier')+(total?' for '+total:'')+'.';
      return {revision:hash([item.execution_status,item.approval_requirement,action]),label:transfer?'Approve transfer':'Send to supplier',block,transfer,detail};
    },
    approve:(db,ctx,user,id)=>require('./postgres-service').approve(db,ctx,user,id),
    outcome:(result,state)=>state.transfer?'Transfer approved.':'Purchase order approved and sent to the supplier.'},
  {type:'purchase-signature',
    ref:e=>/^po-signature-(.+)$/.exec(String(e.sourceId||''))?.[1]||null,
    async state(db,ctx,id){
      const view=await require('../purchasing/dual-approval').view(db,ctx,id);
      if(!view||view.locked)return null;
      return {revision:view.digest,label:'Sign purchase order',detail:'Total '+view.total+'.'+(view.people.length?' Signed so far by '+view.people.join(', ')+'.':''),
        block:view.signed?'You already signed this purchase order. It is waiting for a second person.':null};
    },
    approve:(db,ctx,user,id,state)=>require('../purchasing/dual-approval').sign(db,ctx,id,state.revision),
    outcome:result=>result?.status==='WAITING_FOR_SECOND_SIGNER'?'Signed. It now needs a second person.':'Signed and approved.'},
  {type:'quality-hold',
    ref:e=>String(e.title||'').startsWith('Suggested QC hold')?/^delivery-quality:(.+)$/.exec(String(e.sourceId||''))?.[1]||null:null,
    async state(db,ctx,id){
      if(!await installed.has(db,'stockchief_runtime.agent_quality_holds'))return null;
      const hold=(await db.query('SELECT status,revision FROM stockchief_runtime.agent_quality_holds WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
      if(!hold||hold.status!=='PROPOSED')return null;
      return {revision:'qc:'+hold.revision,holdRevision:hold.revision,label:'Hold the goods',block:null};
    },
    approve:(db,ctx,user,id,state)=>require('../operations/agent-quality-holds').decide(db,ctx,id,{revision:state.holdRevision,decision:'hold'}),
    outcome:()=>'The goods are held for inspection.'}
];

// One approval as it is now, with its one-tap decision when there is one.
// For the kinds one tap decides, the record itself says whether it still
// waits (an approved purchase stays in Needs you while it is sent): one that
// no longer waits is `settled`.
async function describe(db,ctx,entry){
  const adapter=adapters.find(a=>a.ref(entry))||null,ref=adapter?adapter.ref(entry):null;
  const state=adapter?await adapter.state(db,ctx,ref):null;
  // A kind one tap decides is unchanged while its record is; anything else while its words and amount are.
  const revision=state?hash(['record',entry.title||null,state.revision]):hash([entry.title||null,entry.happened||null,entry.moneyValue??null,entry.moneyCurrency||null]);
  return {entry,adapter:state?adapter:null,ref,state,revision,settled:Boolean(adapter&&!state)};
}
async function entries(db,workspaceId,userId){
  const out=[];
  for(const entry of (await require('../projections/postgres-service').needs(db,workspaceId,userId)).filter(isApproval))out.push(...await expand(db,workspaceId,entry));
  return out;
}
// Needs you shows three or more purchases (or transfers) of the same kind as
// one line. Each one waiting there still gets its own link and button, with
// the same words it has when shown on its own.
async function expand(db,workspaceId,entry){
  const match=/^\/needs-you\/work\?(.+)$/.exec(String(entry.href||''));
  if(!entry.grouped||!match)return [entry];
  const q=new URLSearchParams(match[1]),value=name=>['','null'].includes(q.get(name)||'')?null:q.get(name);
  const rows=(await db.query(`SELECT id,category,recommended_action FROM work_items WHERE workspace_id=$1 AND source='postgres_autopilot'
    AND execution_status='WAITING_FOR_APPROVAL' AND approval_requirement<>'NONE' AND NOT (coalesce(outcome,'{}')::jsonb ? 'decision')
    AND inbox_kind IS NOT DISTINCT FROM $2 AND inbox_location IS NOT DISTINCT FROM $3 AND inbox_currency IS NOT DISTINCT FROM $4
    ORDER BY priority DESC,created_at,id LIMIT 50`,[workspaceId,value('kind'),value('location'),value('currency')])).rows;
  return rows.map(row=>{
    let action={};try{action=typeof row.recommended_action==='string'?JSON.parse(row.recommended_action):row.recommended_action||{};}catch{action={};}
    return {...entry,grouped:false,sourceId:row.id,href:'/autopilot/work/'+row.id,moneyValue:null,moneyCurrency:null,actionLabel:'Review decision',
      title:action.title||`${action.type==='transfer'?'Transfer':'Replenish'} ${action.displayName||String(row.category).replaceAll('_',' ')}`,happened:action.summary||null};
  });
}
async function team(db,workspaceId){
  return (await db.query(`SELECT u.id,u.name,a.email,w.owner_account_id=u.account_id AND u.role='owner' AS is_owner
    FROM users u JOIN workspaces w ON w.id=u.workspace_id JOIN accounts a ON a.id=u.account_id
    WHERE u.workspace_id=$1 AND u.account_id IS NOT NULL AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ORDER BY (w.owner_account_id=u.account_id AND u.role='owner') DESC,u.id LIMIT ${MAX_PEOPLE}`,[workspaceId])).rows;
}
const settingFor=async(db,workspaceId)=>(await db.query(`SELECT * FROM ${channels} WHERE workspace_id=$1 AND job_id=${JOB}`,[workspaceId])).rows[0]||null;
const anyChannel=setting=>Boolean(setting&&(setting.email_connector_id||setting.sms||setting.push));
const alone=state=>policy.usesAgentTerms(state)&&policy.permits(state.plan,JOB,'automatic');
// Whether the routine check should queue this job's check.
async function enabled(db,workspaceId,state){
  return alone(state)&&await ready(db)&&await installed.has(db,channels,'sms')&&anyChannel(await settingFor(db,workspaceId));
}

// The worker: one link per person and waiting approval, then send new links.
async function run(database,workspaceId){
  if(!await ready(database)||!await installed.has(database,channels,'sms'))return {skipped:'upgrade'};
  const state=await policy.accountState(database,workspaceId);
  if(!alone(state))return {skipped:'plan'};
  const setting=await settingFor(database,workspaceId);
  if(!anyChannel(setting))return {skipped:'off'};
  const current=[];
  for(const person of await team(database,workspaceId)){
    for(const entry of await entries(database,workspaceId,person.id)){
      const d=await describe(database,{workspaceId,actorId:person.id},entry);
      if(d.settled)continue;
      current.push({user:person.id,key:itemKey(entry),source:String(entry.sourceId||entry.href).slice(0,300),href:String(entry.href).slice(0,500),
        title:String(entry.title||'An approval').slice(0,300),revision:d.revision});
    }
  }
  return tx(database,async c=>{
    const rows=(await c.query(`SELECT * FROM ${links} WHERE workspace_id=$1 FOR UPDATE`,[workspaceId])).rows;
    const byKey=new Map(rows.map(r=>[r.user_id+'|'+r.item_key,r])),seen=new Set(current.map(i=>i.user+'|'+i.key));
    let opened=0,closed=0;
    for(const item of current){
      const row=byKey.get(item.user+'|'+item.key),fields=[item.source,item.href,item.title,item.revision];
      if(row&&!row.closed_at)continue;
      if(row&&!row.decided_at){await c.query(`UPDATE ${links} SET closed_at=NULL,title=$2 WHERE id=$1`,[row.id,item.title]);continue;}
      opened++;
      // A new approval, or one decided earlier that is waiting again: a fresh link.
      if(row)await c.query(`UPDATE ${links} SET id=$2,source_id=$3,href=$4,title=$5,revision=$6,created_at=clock_timestamp(),expires_at=clock_timestamp()+interval '${DAYS} days',
          opened_at=NULL,closed_at=NULL,claim_token=NULL,claimed_at=NULL,decided_at=NULL,decided_by=NULL,outcome=NULL,
          email_batch=NULL,email_communication_id=NULL,sms_batch=NULL,push_batch=NULL WHERE id=$1`,[row.id,randomBytes(24).toString('base64url'),...fields]);
      else await c.query(`INSERT INTO ${links}(id,workspace_id,user_id,item_key,source_id,href,title,revision,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '${DAYS} days') ON CONFLICT DO NOTHING`,
        [randomBytes(24).toString('base64url'),workspaceId,item.user,item.key,...fields]);
    }
    for(const row of rows)if(!row.closed_at&&!seen.has(row.user_id+'|'+row.item_key)){
      closed++;await c.query(`UPDATE ${links} SET closed_at=clock_timestamp() WHERE id=$1`,[row.id]);
    }
    const sent=await deliver(c,workspaceId,state,setting);
    return {opened,closed,...sent};
  });
}

async function notes(c,workspaceId,email,phone){
  await c.query(`UPDATE ${channels} SET email_note=$2,phone_note=$3 WHERE workspace_id=$1 AND job_id=${JOB}
    AND (email_note IS DISTINCT FROM $2 OR phone_note IS DISTINCT FROM $3)`,[workspaceId,email?email.slice(0,500):null,phone?phone.slice(0,500):null]);
}
// Sends each person their new links on every channel the owner chose: one
// email listing each approval with its own link, one text and one push.
async function deliver(c,workspaceId,account,setting,{manual=false}={}){
  const out={emailed:0,texted:0,pushed:0,note:null,phoneNote:null};
  const want=['email','sms','push'].filter(ch=>ch==='email'?setting.email_connector_id:setting[ch]);
  if(!want.length||!await ready(c))return out;
  const rows=(await c.query(`SELECT * FROM ${links} WHERE workspace_id=$1 AND decided_at IS NULL AND closed_at IS NULL AND expires_at>clock_timestamp()
    AND (${want.map(ch=>ch+'_batch IS NULL').join(' OR ')}) ORDER BY user_id,created_at,id LIMIT ${MAX_SEND}`,[workspaceId])).rows;
  const emailWanted=want.includes('email'),phoneWanted=want.some(ch=>ch!=='email');
  if(!rows.length){await notes(c,workspaceId,null,null);return out;}
  const phones=require('./alert-phones'),alerts=require('./agent-alerts');
  const stop=await phones.held(c,workspaceId,account,ACTION,manual);
  if(stop){
    out.note=emailWanted?'No email was sent. '+stop:null;out.phoneNote=phoneWanted?'Nothing was texted or pushed. '+stop:null;
    await notes(c,workspaceId,out.note,out.phoneNote);return out;
  }
  if(!phones.link('/')){
    const text='StockChief’s web address is not set on this server, so no approval links were sent.';
    out.note=emailWanted?text:null;out.phoneNote=phoneWanted?text:null;await notes(c,workspaceId,out.note,out.phoneNote);return out;
  }
  const people=await team(c,workspaceId),owner=people.find(p=>p.is_owner);
  const box=emailWanted?(await alerts.mailboxes(c,workspaceId)).find(b=>b.id===setting.email_connector_id):null;
  const emailProblems=new Set(),phoneProblems=new Set();let last=null;
  // Job 214: a Custom manager may keep approvals to one of the owner's channels.
  const preferred=await require('../reports/manager-presentation').approvalChannelFor(c,workspaceId,account);
  for(const userId of [...new Set(rows.map(r=>r.user_id))]){
    const person=people.find(p=>p.id===userId),mine=rows.filter(r=>r.user_id===userId);
    if(!person)continue;
    const only=want.includes(preferred.get(userId))?preferred.get(userId):null;
    for(const ch of want.filter(x=>only&&x!==only)){
      const skipped=mine.filter(r=>!r[ch+'_batch']);
      if(skipped.length)await c.query(`UPDATE ${links} SET ${ch}_batch=$2${ch==='email'?',email_communication_id=$2':''} WHERE id=ANY($1::text[])`,[skipped.map(r=>r.id),BY_PREFERENCE]);
      for(const r of skipped)r[ch+'_batch']=BY_PREFERENCE;
    }
    const list=mine.filter(r=>!r.email_batch);
    if(emailWanted&&list.length){
      if(!box)emailProblems.add('The chosen mailbox is disconnected, paused or cannot send. Reconnect it, or choose another. No email was sent.');
      else if(!EMAIL.test(person.email||''))emailProblems.add(person.name+' has no email address, so no email was sent to them.');
      else{
        const subject=list.length===1?'Approve: '+list[0].title:list.length+' approvals are waiting for you';
        const body=(list.length===1?'This is waiting for your approval in StockChief.':'These are waiting for your approval in StockChief.')+'\n\n'+
          list.map(r=>'- '+r.title+'\n  Review and approve: '+phones.link('/approve/'+r.id)).join('\n')+
          '\n\nOpening a link does not approve anything. Sign in, check it, and tap the button when you are sure.';
        const queued=await alerts.queue(c,workspaceId,{job:JOB,person,box,subject,body,manual,count:list.length,authority:{userId:person.id},sender:owner?.id||person.id});
        if(queued.problem)emailProblems.add('No email was sent. '+queued.problem);
        else{
          await c.query(`UPDATE ${links} SET email_batch=$2,email_communication_id=$3 WHERE id=ANY($1::text[])`,[list.map(r=>r.id),queued.batch,queued.communicationId]);
          out.emailed+=list.length;last=queued.communicationId;
        }
      }
    }
    for(const ch of ['sms','push'].filter(x=>want.includes(x))){
      const pending=mine.filter(r=>!r[ch+'_batch']);if(!pending.length)continue;
      // Each approval gets its own message and link, so each is one tap away;
      // more than three at once become one message pointing to Needs you.
      const groups=pending.length<=PER_MESSAGE?pending.map(r=>[r]):[pending];
      for(const group of groups){
        const title=group.length===1?'Approve: '+group[0].title:group.length+' approvals are waiting for you';
        const body=group.length===1?group[0].title+'. Tap to check it and approve.'
          :group.slice(0,2).map(r=>r.title+'.').join(' ')+' And '+(group.length-2)+' more. Tap to review them in Needs you.';
        const batch=newId('approval-'+ch);
        const queued=await phones.queue(c,workspaceId,{purpose:'APPROVAL',job:JOB,batch,userId:person.id,sms:ch==='sms',push:ch==='push',title,body,
          url:phones.link(group.length===1?'/approve/'+group[0].id:'/needs-you'),manual});
        if(!queued[ch]){phoneProblems.add(person.name+': '+queued.problems.join(' '));break;}
        await c.query(`UPDATE ${links} SET ${ch}_batch=$2 WHERE id=ANY($1::text[])`,[group.map(r=>r.id),batch]);
        await audit.record(c,{workspaceId,actorId:owner?.id||person.id},{action:ch==='sms'?'Approval text queued':'Approval push queued',reference:batch,
          after:{approvals:group.length,to:person.name,...(manual?{sentByOwner:true}:{})}});
        out[ch==='sms'?'texted':'pushed']+=group.length;
      }
    }
  }
  out.note=emailProblems.size?[...emailProblems].join(' '):null;out.phoneNote=phoneProblems.size?[...phoneProblems].join(' '):null;
  await notes(c,workspaceId,out.note,out.phoneNote);
  if(last)await c.query(`UPDATE ${channels} SET last_communication_id=$2,last_emailed_at=clock_timestamp() WHERE workspace_id=$1 AND job_id=${JOB}`,[workspaceId,last]);
  return out;
}

// Checked again just before an email, text or push goes out: the approvals
// in it are still waiting for that person.
async function emailAuthority(db,workspaceId,grant){
  const open=(await db.query(`SELECT 1 FROM ${links} WHERE workspace_id=$1 AND email_batch=$2 AND user_id=$3 AND decided_at IS NULL AND closed_at IS NULL LIMIT 1`,
    [workspaceId,String(grant.batch||''),String(grant.userId||'')])).rowCount;
  if(!open)throw new ValidationError('These approvals were decided before the email was sent, so it was not sent.');
}
async function phoneAuthority(db,workspaceId,m){
  const column=m.channel==='SMS'?'sms_batch':'push_batch';
  const open=(await db.query(`SELECT 1 FROM ${links} WHERE workspace_id=$1 AND ${column}=$2 AND user_id=$3 AND decided_at IS NULL AND closed_at IS NULL LIMIT 1`,
    [workspaceId,String(m.batch||''),String(m.user_id||'')])).rowCount;
  if(!open)throw new ValidationError('These approvals were decided before the message was sent, so it was not sent.');
}
async function waiting(db,workspaceId,setting){
  if(!await ready(db))return 0;
  const unsent=[setting?.email_connector_id?'email_batch IS NULL':null,setting?.sms?'sms_batch IS NULL':null,setting?.push?'push_batch IS NULL':null].filter(Boolean);
  if(!unsent.length)return 0;
  return Number((await db.query(`SELECT count(*) AS n FROM ${links} WHERE workspace_id=$1 AND decided_at IS NULL AND closed_at IS NULL
    AND expires_at>clock_timestamp() AND (${unsent.join(' OR ')})`,[workspaceId])).rows[0].n);
}

// --- The link itself ---------------------------------------------------------

async function find(db,id){
  if(!ID.test(String(id||''))||!await ready(db))return null;
  return (await db.query(`SELECT l.*,l.expires_at<=clock_timestamp() AS expired,u.name AS decided_name FROM ${links} l
    LEFT JOIN users u ON u.id=l.decided_by WHERE l.id=$1`,[id])).rows[0]||null;
}
// The link, only for the account of the person it was sent to.
async function locate(db,accountId,id){
  const row=await find(db,id);
  const mine=row&&accountId?(await db.query('SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND account_id=$3',[row.workspace_id,row.user_id,accountId])).rowCount:0;
  if(!mine)throw new NotFoundError('This approval link is not valid for your account.');
  return row;
}
function mineHere(row,ctx){
  if(row.workspace_id!==ctx.workspaceId||row.user_id!==ctx.actorId)throw new NotFoundError('This approval link is not valid for your account.');
}
const moneyText=e=>Number.isSafeInteger(e.moneyValue)&&/^[A-Z]{3}$/.test(e.moneyCurrency||'')?require('../domain/currency').format(e.moneyValue,e.moneyCurrency):null;

// What the link shows. Opening it changes nothing but the time it was opened.
async function view(db,ctx,id){
  const row=await locate(db,ctx.accountId,id);mineHere(row,ctx);
  await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'suggest');
  if(!row.opened_at)await db.query(`UPDATE ${links} SET opened_at=clock_timestamp() WHERE id=$1 AND opened_at IS NULL`,[id]);
  const base={id,title:row.title,href:row.href,action:'/approve/'+id};
  if(row.decided_at)return {...base,status:'approved',outcome:row.outcome,at:row.decided_at,by:row.decided_name};
  if(row.expired)return {...base,status:'expired'};
  const entry=(await entries(db,ctx.workspaceId,ctx.actorId)).find(e=>itemKey(e)===row.item_key);
  const d=entry?await describe(db,ctx,entry):null;
  if(!d||d.settled)return {...base,status:'gone'};
  return {...base,status:'waiting',href:entry.href,changed:d.revision!==row.revision,revision:d.revision,
    entry:{title:entry.title,happened:entry.happened||null,why:entry.why||null,recommendation:entry.recommendation||null,money:moneyText(entry),actionLabel:entry.actionLabel||'Open it'},
    detail:d.state?.detail||null,block:d.state?.block||null,label:d.state?.label||null,canApprove:Boolean(d.adapter&&!d.state.block)};
}

// One deliberate tap after sign-in. Checked again now: still waiting for this
// person, unchanged since they looked, and allowed by the approval's own
// service. Recorded and audited once.
async function approve(database,ctx,user,id,{revision}={}){
  const row=await locate(database,ctx.accountId,id);mineHere(row,ctx);
  if(row.decided_at)return {replayed:true,outcome:row.outcome};
  if(row.expired)throw new ValidationError('This link expired. Open Needs you to see what is waiting.');
  await policy.requireWorkspaceJob(database,ctx.workspaceId,JOB,'suggest');
  const entry=(await entries(database,ctx.workspaceId,ctx.actorId)).find(e=>itemKey(e)===row.item_key);
  const d=entry?await describe(database,ctx,entry):null;
  if(!d||d.settled){
    await database.query(`UPDATE ${links} SET closed_at=coalesce(closed_at,clock_timestamp()) WHERE id=$1 AND decided_at IS NULL`,[id]);
    throw new ValidationError('This is no longer waiting for you. It may have been decided already. Open Needs you to see what is.');
  }
  if(!d.adapter)throw new ValidationError('This approval is made on its own page. Open it to decide.');
  if(String(revision||'')!==d.revision)throw new ValidationError('This changed since you opened it. Check it again before you approve.');
  if(d.state.block)throw new ValidationError(d.state.block);
  const token=newId('approve-claim');
  const claimed=(await database.query(`UPDATE ${links} SET claim_token=$2,claimed_at=clock_timestamp() WHERE id=$1 AND decided_at IS NULL
    AND (claimed_at IS NULL OR claimed_at<clock_timestamp()-interval '2 minutes') RETURNING id`,[id,token])).rowCount;
  if(!claimed){
    const now=await find(database,id);
    if(now?.decided_at)return {replayed:true,outcome:now.outcome};
    throw new ValidationError('This approval is already being sent. Refresh in a moment.');
  }
  let result;
  try{result=await d.adapter.approve(database,ctx,user,d.ref,d.state);}
  catch(error){
    await database.query(`UPDATE ${links} SET claim_token=NULL,claimed_at=NULL WHERE id=$1 AND claim_token=$2`,[id,token]);
    throw error;
  }
  const outcome=d.adapter.outcome(result,d.state);
  await tx(database,async c=>{
    const done=(await c.query(`UPDATE ${links} SET decided_at=clock_timestamp(),decided_by=$3,outcome=$4,claim_token=NULL,claimed_at=NULL
      WHERE id=$1 AND claim_token=$2 AND decided_at IS NULL RETURNING id`,[id,token,ctx.actorId,outcome])).rowCount;
    if(done)await audit.record(c,ctx,{action:'Approved from a link',reference:row.title,
      after:{kind:d.adapter.type,item:entry.href,outcome,sent:[row.email_batch&&'email',row.sms_batch&&'text',row.push_batch&&'push'].filter(Boolean)}});
  });
  return {approved:true,outcome,label:d.state.label};
}

// The owner's page: what was sent, to whom, and what happened.
async function review(db,ctx,{page=1}){
  if(!await ready(db))return {rows:[],more:false,summary:'This is being upgraded. Check back shortly.'};
  const setting=await settingFor(db,ctx.workspaceId);
  const summary=anyChannel(setting)?'Each approval waiting in someone’s Needs you is sent to them once, with its own link. Opening a link approves nothing: they sign in, check it and tap once.'
    :'Choose how approvals reach people below, and each approval waiting in someone’s Needs you is sent to them with its own link.';
  const zone=(await require('../lib/business-time').forWorkspace(db,ctx.workspaceId)).timeZone;
  const local=value=>value?new Intl.DateTimeFormat('en-US',{timeZone:zone,dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'';
  const rows=(await db.query(`SELECT l.*,l.expires_at<=clock_timestamp() AS expired,u.name AS person,d.name AS decider FROM ${links} l
    JOIN users u ON u.id=l.user_id LEFT JOIN users d ON d.id=l.decided_by WHERE l.workspace_id=$1
    ORDER BY (l.decided_at IS NULL AND l.closed_at IS NULL) DESC,coalesce(l.decided_at,l.created_at) DESC,l.id LIMIT 101 OFFSET $2`,[ctx.workspaceId,(page-1)*100])).rows;
  return {summary,more:rows.length>100,rows:rows.slice(0,100).map(r=>({Approval:r.title,For:r.person,
    Sent:[r.email_batch&&r.email_batch!==BY_PREFERENCE&&'Email',r.sms_batch&&r.sms_batch!==BY_PREFERENCE&&'Text',r.push_batch&&r.push_batch!==BY_PREFERENCE&&'Push'].filter(Boolean).join(', ')||'Not yet',
    Status:r.decided_at?'Approved by '+(r.decider||'a former team member')+', '+local(r.decided_at):r.closed_at?'No longer waiting':r.expired?'Link expired':r.opened_at?'Opened, not approved yet':'Waiting',
    link:r.href}))};
}

const definition={id:JOB,key,label,readPage:review};
module.exports={JOB,ACTION,key,path,label,definition,ready,enabled,isApproval,itemKey,workBlock,adapters,run,deliver,emailAuthority,phoneAuthority,waiting,view,approve,review,find,locate};
