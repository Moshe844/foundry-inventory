'use strict';
// Job 165 (Growth, Pro and Custom): the year-end stocktake and valuation pack
// for the accountant.
//
// The owner saves the month the financial year ends and the accountant's email
// (a saved rule). After each year end the worker makes the workbook
// (agent-report-packs yearEnd: the valuation method, the closing stock value
// from the books, the year's roll-forward with write-offs, write-downs and count
// differences, the completed counts and signed-off stocktakes), keeps it, and
// sends it to the accountant from the owner's connected mailbox through the
// ordinary outbound mail path. One pack per financial year: a replay finds the
// same pack and never sends twice.
//
// Pause holds the worker. The first 14 days, Watch only and a job set to Watch
// only make and keep the pack and send nothing. Ask me first keeps it ready and
// the owner presses send; so does a year end where the books and the stock
// records differ. A missing accountant email, no connected mailbox, or two
// mailboxes with no choice made stop the send and ask in Needs you.
const {ValidationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const time=require('../lib/business-time');
const money=require('../domain/currency');
const audit=require('../operations/postgres-security-audit');
const storage=require('../commercial/storage-capacity');
const reports=require('../reports/agent-report-runs');
const {hash}=require('../pricing/postgres-promotions');
const {newId}=require('../lib/util');

const JOB=165,ACTION='report.year_end_pack',KIND='reports.year-end-pack.v1',MAIL='accountant_pack';
const href='/autopilot/reviews/year-end-stocktake';
const PACKS='stockchief_runtime.agent_year_end_packs',SETTINGS='stockchief_runtime.agent_year_end_settings';
const XLSX_TYPE='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// The worker makes the pack in the three months after a year end.
const WINDOW_DAYS=92,EMAIL_LIMIT=2097152,EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const outbound=()=>require('../connections/postgres-outbound-mail');
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
const yearName=closing=>'year to '+reports.monthName(closing);
// Pack figures are kept in major units, as the workbook shows them.
const fmt=(value,currency)=>money.format(Math.round(Number(value)*10**money.exponent(currency)),currency);

// ---- Who may do what, right now -------------------------------------------

async function authority(db,workspaceId,state){
  const manual=await policy.stopped(db,workspaceId,state,ACTION,false);
  if(manual)return {mode:'watch',reason:manual};
  const automatic=await policy.stopped(db,workspaceId,state,ACTION,true);
  if(automatic)return {mode:'ask',reason:automatic};
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)
    return {mode:'ask',reason:'StockChief asks before it does routine work in this inventory. Press send for the pack.'};
  return {mode:'automatic',reason:null};
}
async function settingsOf(db,workspaceId,{lock=false}={}){
  return (await db.query(`SELECT * FROM ${SETTINGS} WHERE workspace_id=$1${lock?' FOR UPDATE':''}`,[workspaceId])).rows[0]||null;
}
function mailbox(db,workspaceId,settings){return require('../connections/agent-sending-mailbox').resolve(db,workspaceId,settings?.connector_id||null,'the year-end pack');}
function missing(file,settings,sender){
  if(!settings?.accountant_email||!EMAIL.test(settings.accountant_email))return {problem:'recipient',reason:'Add your accountant’s email so StockChief can send the year-end pack.'};
  if(file.length>EMAIL_LIMIT)return {problem:'size',reason:'This pack is too large to email. Download it and send it yourself.'};
  if(!sender.box)return {problem:sender.problem,reason:sender.reason};
  return null;
}
// Books and stock records that disagree are a fact the owner decides about.
function mismatch(report){
  const off=(report.rollForward||[]).filter(c=>c.difference!==0);
  if(!off.length)return null;
  return 'At '+report.span.end+' your books and your stock records differ: '+off.map(c=>fmt(c.difference,c.currency)+' '+c.currency).join(', ')+
    '. Check the month-end stock report, then send the pack yourself.';
}

// ---- Making and keeping the pack -------------------------------------------

function words(pack,settings){
  const s=pack.summary,greeting=settings?.accountant_name?'Hello '+settings.accountant_name+',':'Hello,';
  const lines=(s.rollForward||[]).map(c=>'· '+c.currency+': closing stock '+fmt(c.closing,c.currency)+' in the stock records and '+fmt(c.booksClosing,c.currency)+' in the books; '+
    fmt(Math.abs(c.writeoffs),c.currency)+' written off or written down; '+fmt(c.adjustments,c.currency)+' from counts and adjustments.');
  return {subject:'Year-end stock pack · '+s.span.start+' to '+s.span.end+' · '+s.business,
    body:greeting+'\n\nAttached is our year-end stocktake and stock valuation pack for the financial year '+s.span.start+' to '+s.span.end+'. Stock is valued at '+String(s.method).toLowerCase()+'.\n\n'+
      (lines.length?lines.join('\n')+'\n\n':'')+
      'The workbook has the closing stock value from the books, the year’s stock value changes by location, the write-downs, '+s.counts+' approved count line'+(s.counts===1?'':'s')+
      (s.stocktakes?' and '+s.stocktakes+' signed-off stocktake'+(s.stocktakes===1?'':'s'):'')+'.'+(s.pending?' '+s.pending+' count'+(s.pending===1?' was':'s were')+' not approved by the year end and '+(s.pending===1?'is':'are')+' left out.':'')+
      '\n\nThank you,\n'+s.business};
}
async function load(db,workspaceId,id,{lock=false}={}){
  return (await db.query(`SELECT * FROM ${PACKS} WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[workspaceId,String(id||'')])).rows[0]||null;
}
async function figures(c,workspaceId,closing){
  const today=await time.today(c,workspaceId);
  const report=JSON.parse(JSON.stringify(await require('./agent-report-packs').yearEnd(c,{workspaceId},{today,filter:closing,download:true})));
  const {more:_more,...facts}=report;
  return facts;
}
// Make (or bring up to date) the pack for one financial year, then send it if
// StockChief may. Never sends a queued pack again.
async function prepare(c,ctx,closing,{automatic,state}){
  const existing=(await c.query(`SELECT * FROM ${PACKS} WHERE workspace_id=$1 AND closing=$2 FOR UPDATE`,[ctx.workspaceId,closing])).rows[0];
  if(existing?.status==='QUEUED')return {pack:existing,replayed:true};
  const report=await figures(c,ctx.workspaceId,closing),fingerprint=hash(report);
  let file=existing?.file,filename=existing?.filename;
  if(!existing||existing.fingerprint!==fingerprint){
    file=require('./agent-report-pack-files').stocktakeWorkbook(report);
    filename='year-end-stock-pack-'+closing+'.xlsx';
    await storage.reserve(reports.scoped(c),ctx.workspaceId,'year-end-pack:'+fingerprint.slice(0,48),file.length+8192,{finished:true});
  }
  const summary={span:report.span,business:report.business,method:report.method,rollForward:report.rollForward.map(({locations:_l,...c})=>c),
    counts:report.counts.length,writeDowns:report.writeDowns.length,stocktakes:report.stocktakes.length,pending:report.pending,accounting:report.accounting};
  const settings=await settingsOf(c,ctx.workspaceId),who=await authority(c,ctx.workspaceId,state),sender=await mailbox(c,ctx.workspaceId,settings);
  const lack=missing(file,settings,sender),differ=mismatch(report);
  let status,reason=null,problem=null;
  if(who.mode==='watch'){status='WATCHED';reason=who.reason;}
  else if(lack){status='STOPPED';reason=lack.reason;problem=lack.problem;}
  else{status='WAITING';reason=differ||(who.mode==='ask'?who.reason:null);}
  const id=existing?.id||newId('yearendpack');
  await c.query(`INSERT INTO ${PACKS}(workspace_id,id,closing,year_start,year_end,fingerprint,summary,file,filename,status,reason,problem,made_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT(workspace_id,id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,summary=EXCLUDED.summary,file=EXCLUDED.file,filename=EXCLUDED.filename,
      status=EXCLUDED.status,reason=EXCLUDED.reason,problem=EXCLUDED.problem,updated_at=clock_timestamp()`,
  [ctx.workspaceId,id,closing,report.span.start,report.span.end,fingerprint,JSON.stringify(summary),file,filename,status,reason,problem,automatic?null:ctx.actorId]);
  const changed=!existing||existing.fingerprint!==fingerprint||existing.status!==status||existing.problem!==problem;
  if(changed)await audit.record(c,ctx,{action:automatic?'StockChief made the year-end stock pack':'Made the year-end stock pack',reference:yearName(closing),
    before:existing?{status:existing.status,fingerprint:existing.fingerprint}:{},after:{packId:id,status,reason,fingerprint}});
  const pack=await load(c,ctx.workspaceId,id);
  if(status==='WAITING'&&!differ&&automatic&&who.mode==='automatic')return {pack:await queue(c,ctx,pack,{automatic:true,box:sender.box,recipient:settings.accountant_email}),sent:true};
  return {pack,changed};
}

// ---- Sending ---------------------------------------------------------------

async function queue(c,ctx,pack,{automatic,box,recipient}){
  const attempt=pack.attempt||0,key='year-end-pack:'+pack.closing+(attempt?':'+attempt:'');
  const grant={kind:MAIL,packId:pack.id,fingerprint:pack.fingerprint,attempt,automatic,actorId:ctx.actorId};
  const settings=await settingsOf(c,ctx.workspaceId);
  const r=await outbound().queueInTransaction(c,ctx,{recipientKind:'address',recipientEmail:recipient,connectorId:box.id,...words(pack,settings),standingAuthority:grant},key,{agentRequested:true,agentJob:JOB});
  await c.query(`UPDATE ${PACKS} SET status='QUEUED',reason=NULL,problem=NULL,communication_id=$3,recipient=$4,connector_id=$5,authorization_kind=$6,sent_by=$7,queued_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,pack.id,r.communicationId,recipient,box.id,automatic?'AUTOMATIC':'INDIVIDUAL',automatic?null:ctx.actorId]);
  await audit.record(c,ctx,{action:automatic?'StockChief sent the year-end stock pack to the accountant':'Sent the year-end stock pack to the accountant',reference:yearName(pack.closing),
    after:{packId:pack.id,recipient,mailbox:box.display_name||box.provider_account_name||box.id,communicationId:r.communicationId,attempt}});
  return load(c,ctx.workspaceId,pack.id);
}
async function delivery(db,workspaceId,pack){
  if(!pack?.communication_id)return null;
  return (await db.query(`SELECT m.status,m.error_message,m.sent_at,e.status AS effect_status FROM customer_communications m
    LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send'
    WHERE m.workspace_id=$1 AND m.id=$2 ORDER BY e.created_at DESC LIMIT 1`,[workspaceId,pack.communication_id])).rows[0]||null;
}
async function access(db,ctx,operation='suggest'){await reports.owner(db,ctx);return policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,operation);}

// The owner presses send.
async function send(database,ctx,id,input={}){
  return tx(database,async c=>{
    const state=await access(c,ctx,'draft');
    if(await reports.paused(c,ctx.workspaceId))throw new ValidationError('StockChief is paused. Resume it to send the year-end pack.');
    const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,false);if(stop)throw new ValidationError(stop);
    let pack=await load(c,ctx.workspaceId,id,{lock:true});
    if(!pack)throw new NotFoundError('That year-end pack is not in this inventory.');
    if(pack.status==='QUEUED'){
      const sent=await delivery(c,ctx.workspaceId,pack);
      if(sent?.status!=='FAILED')return {pack,replayed:true};
      if(sent.effect_status!=='FAILED')throw new ValidationError('StockChief cannot tell whether the last email reached your accountant. Check the mailbox’s Sent folder before sending again.');
      await c.query(`UPDATE ${PACKS} SET attempt=attempt+1,status='WAITING',communication_id=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,pack.id]);
    }
    if(String(input.fingerprint||'')!==pack.fingerprint)throw new ValidationError('This pack changed after you opened it. Review it again before sending.');
    pack=(await prepare(c,ctx,pack.closing,{automatic:false,state})).pack;
    if(pack.fingerprint!==String(input.fingerprint))return {pack,changed:true};
    if(pack.status==='WATCHED'||pack.status==='STOPPED')throw new ValidationError(pack.reason);
    const settings=await settingsOf(c,ctx.workspaceId),sender=await mailbox(c,ctx.workspaceId,settings);
    return {pack:await queue(c,ctx,pack,{automatic:false,box:sender.box,recipient:settings.accountant_email}),sent:true};
  });
}

// The owner's saved rule: when the year ends, the accountant and the mailbox.
async function configure(database,ctx,input={}){
  return tx(database,async c=>{
    await reports.owner(c,ctx);
    const prior=await settingsOf(c,ctx.workspaceId,{lock:true});
    if(Number(input.revision||0)!==(prior?.revision||0))throw new ValidationError('Reload the year-end pack settings before changing them.');
    if(input.stop==='yes'){
      if(prior?.enabled){
        await c.query(`UPDATE ${SETTINGS} SET enabled=false,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1`,[ctx.workspaceId]);
        await audit.record(c,ctx,{action:'Stopped the yearly pack for the accountant',before:{yearEndMonth:prior.year_end_month,accountant:prior.accountant_email}});
      }
      return {stopped:true};
    }
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic');
    const month=Number(String(input.yearEndMonth??'').trim());
    if(!Number.isSafeInteger(month)||month<1||month>12)throw new ValidationError('Choose the month your financial year ends.');
    const email=String(input.accountantEmail||'').trim().toLowerCase()||null,name=String(input.accountantName||'').trim()||null;
    if(email&&(email.length>254||!EMAIL.test(email)))throw new ValidationError('Enter your accountant’s email address, like name@firm.com.');
    if(name&&(name.length>120||/[\u0000-\u001f\u007f]/.test(name)))throw new ValidationError('Use a name of up to 120 characters on one line.');
    let connector=prior?.connector_id||null;
    if(input.connectorId){
      const box=(await outbound().mailboxes(c,ctx.workspaceId)).find(b=>b.id===String(input.connectorId));
      if(!box)throw new ValidationError('Choose one of your connected mailboxes.');connector=box.id;
    }
    const next={year_end_month:month,accountant_email:email,accountant_name:name,connector_id:connector};
    if(prior?.enabled&&Object.entries(next).every(([k,v])=>prior[k]===v))return {unchanged:true};
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await storage.reserve(reports.scoped(c),ctx.workspaceId,'year-end-pack-settings:'+((prior?.revision||0)+1),1024,{finished:true});
    await c.query(`INSERT INTO ${SETTINGS}(workspace_id,year_end_month,accountant_email,accountant_name,connector_id,authorized_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(workspace_id) DO UPDATE SET enabled=true,year_end_month=EXCLUDED.year_end_month,accountant_email=EXCLUDED.accountant_email,accountant_name=EXCLUDED.accountant_name,
        connector_id=EXCLUDED.connector_id,authorized_by=EXCLUDED.authorized_by,revision=agent_year_end_settings.revision+1,updated_at=clock_timestamp()`,
    [ctx.workspaceId,month,email,name,connector,ctx.actorId]);
    await audit.record(c,ctx,{action:'Saved the yearly pack for the accountant',
      before:prior?{yearEndMonth:prior.year_end_month,accountant:prior.accountant_email,connectorId:prior.connector_id,enabled:prior.enabled}:{},
      after:{yearEndMonth:month,accountant:email,connectorId:connector}});
    return {saved:true};
  });
}

// ---- The outbound mail boundary -------------------------------------------

async function deliveryAuthority(db,workspaceId,grant){
  if(grant?.kind!==MAIL)throw new ValidationError('This year-end pack email is not authorized.');
  const pack=await load(db,workspaceId,grant.packId);
  if(!pack||pack.status!=='QUEUED'||pack.fingerprint!==grant.fingerprint||Number(pack.attempt)!==Number(grant.attempt))
    throw new ValidationError('This year-end pack changed after it was queued. Review it before sending.');
  const state=await policy.requireWorkspaceJob(db,workspaceId,JOB,'draft');
  if(await reports.paused(db,workspaceId))throw new ValidationError('StockChief is paused. Resume it to send the year-end pack.');
  const stop=await policy.stopped(db,workspaceId,state,ACTION,grant.automatic===true);if(stop)throw new ValidationError(stop);
  if(grant.automatic===true&&!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)
    throw new ValidationError('StockChief asks before it does routine work in this inventory. Press send for the pack.');
  const settings=await settingsOf(db,workspaceId);
  if(String(settings?.accountant_email||'').toLowerCase()!==String(pack.recipient).toLowerCase())
    throw new ValidationError('Your accountant’s email changed after this pack was queued. Review it before sending.');
  return pack;
}
async function attachments(db,workspaceId,grant){
  const pack=await deliveryAuthority(db,workspaceId,grant);
  if(pack.file.length>EMAIL_LIMIT)throw new ValidationError('This pack is too large to email. Download it and send it yourself.');
  return [{filename:pack.filename,contentType:XLSX_TYPE,content:Buffer.from(pack.file)}];
}

// ---- The worker -------------------------------------------------------------

// The financial year to make now: the last one that ended, if it ended in the
// last three months and the books cover it.
// The last month of the most recent financial year that has ended.
function lastYearEnd(today,yearEndMonth){
  const month=String(yearEndMonth).padStart(2,'0'),closing=today.slice(0,4)+'-'+month;
  return closing>=today.slice(0,7)?String(Number(today.slice(0,4))-1)+'-'+month:closing;
}
async function due(db,workspaceId,today,settings){
  if(!settings?.enabled)return null;
  const closing=lastYearEnd(today,settings.year_end_month),end=reports.monthEnd(closing);
  if((Date.parse(today)-Date.parse(end))/86400000>WINDOW_DAYS)return null;
  const books=await reports.accounting(db,workspaceId);
  if(!Number(books?.enabled)||!books.accounting_start_date||books.accounting_start_date>end)return null;
  return closing;
}
async function run(database,workspaceId,payload={}){
  const actorId=await reports.currentOwner(database,workspaceId);if(!actorId)return {skipped:'owner_unavailable'};
  const ctx={workspaceId,actorId},state=await policy.accountState(database,workspaceId);
  if(!reports.alone(state,JOB))return {skipped:'plan'};
  if(await reports.paused(database,workspaceId))return {held:'paused'};
  const today=await time.today(database,workspaceId),closing=await due(database,workspaceId,today,await settingsOf(database,workspaceId));
  if(!closing)return {skipped:'not_due'};
  if(payload.closing&&payload.closing!==closing)return {skipped:'stale'};
  const r=await tx(database,c=>prepare(c,ctx,closing,{automatic:true,state}));
  return {closing,status:r.pack.status,sent:Boolean(r.sent),replayed:Boolean(r.replayed),changed:Boolean(r.changed)};
}
async function schedule(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);if(!reports.alone(state,JOB))return {queued:0};
  const installed=require('../db/schema-installed');
  if(!(await installed.has(db,SETTINGS))||!(await installed.has(db,PACKS)))return {queued:0};
  const today=await time.today(db,workspaceId),closing=await due(db,workspaceId,today,await settingsOf(db,workspaceId));if(!closing)return {queued:0};
  if((await db.query(`SELECT 1 FROM ${PACKS} WHERE workspace_id=$1 AND closing=$2 AND status='QUEUED'`,[workspaceId,closing])).rowCount)return {queued:0};
  // Daily after the year end until the pack is sent; the same figures replay to the same pack.
  const job=await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:KIND,priority:70,maxAttempts:3,
    idempotencyKey:'year-end-pack:'+closing+':'+today,payload:{closing}});
  return {queued:job.created?1:0};
}
// On demand: make and keep the pack for a completed financial year now.
async function makeNow(database,ctx,input={}){
  const state=await access(database,ctx,'draft');
  if(await reports.paused(database,ctx.workspaceId))throw new ValidationError('StockChief is paused. Resume it to make the year-end pack.');
  const today=await time.today(database,ctx.workspaceId);
  const closing=reports.completedMonth(today,input.closing,'financial year’s last month');
  return tx(database,c=>prepare(c,ctx,closing,{automatic:false,state}));
}

// ---- Page, kept copies, Needs you ------------------------------------------

function display(pack,sent){
  if(pack.status==='QUEUED'){
    if(sent?.status==='SENT')return {label:'Sent',tone:'ok',detail:'Sent to '+pack.recipient};
    if(sent?.status==='FAILED')return {label:'Not sent',tone:'danger',detail:sent.error_message||'The mailbox did not send it.',retry:sent.effect_status==='FAILED'};
    return {label:'Sending',tone:'info',detail:'Queued for '+pack.recipient};
  }
  if(pack.status==='WAITING')return {label:'Ready to send',tone:'warn',detail:pack.reason||'Ready to send.',send:true};
  if(pack.status==='STOPPED')return {label:'Needs you',tone:'danger',detail:pack.reason};
  return {label:'Kept, not sent',tone:'info',detail:null};
}
async function page(db,ctx,query={}){
  const state=await access(db,ctx);
  const today=await time.today(db,ctx.workspaceId),settings=await settingsOf(db,ctx.workspaceId);
  const last=reports.lastCompleted(today);
  const months=Array.from({length:24},(_,i)=>reports.addMonths(last,-i));
  const defaultClosing=lastYearEnd(today,settings?.enabled?settings.year_end_month:12);
  const closing=months.includes(String(query.closing||''))?String(query.closing):defaultClosing;
  const packs=(await db.query(`SELECT k.id,k.closing,k.year_start,k.year_end,k.fingerprint,k.summary,k.status,k.reason,k.problem,k.recipient,k.communication_id,k.attempt,
      k.authorization_kind,k.queued_at,k.updated_at,m.status AS sent_status,m.error_message,e.status AS effect_status
    FROM ${PACKS} k LEFT JOIN customer_communications m ON m.workspace_id=k.workspace_id AND m.id=k.communication_id
    LEFT JOIN LATERAL (SELECT x.status FROM stockchief_runtime.provider_effects x WHERE x.workspace_id=m.workspace_id AND x.aggregate_id=m.id AND x.kind='mail.outbound.send'
      ORDER BY x.created_at DESC LIMIT 1) e ON true
    WHERE k.workspace_id=$1 ORDER BY k.closing DESC LIMIT 10`,[ctx.workspaceId])).rows;
  for(const p of packs)p.view=display(p,p.communication_id?{status:p.sent_status,error_message:p.error_message,effect_status:p.effect_status}:null);
  const sender=await mailbox(db,ctx.workspaceId,settings);
  const paused=await reports.paused(db,ctx.workspaceId);
  const alone=reports.alone(state,JOB);
  const who=alone?await authority(db,ctx.workspaceId,state):{mode:'watch',reason:null};
  const books=await reports.accounting(db,ctx.workspaceId);
  return {settings,months,closing,packs,sender,paused,who,alone,shadow:Boolean(state.shadow),monthNames:MONTHS,fmt,
    booksOff:!Number(books?.enabled)||!books?.accounting_start_date,
    download:'/autopilot/reviews/year-end-stocktake/download?'+new URLSearchParams({filter:closing})};
}
async function kept(db,ctx,id){
  await access(db,ctx);
  const pack=await load(db,ctx.workspaceId,id);
  if(!pack)throw new NotFoundError('That year-end pack is not in this inventory.');
  return {filename:pack.filename,body:Buffer.from(pack.file)};
}
async function inbox(db,workspaceId){
  if(!(await require('../db/schema-installed').has(db,PACKS)))return [];
  const state=await policy.accountState(db,workspaceId);
  if(!reports.alone(state,JOB))return [];
  const row=(await db.query(`SELECT k.id,k.closing,k.status,k.problem,k.reason,k.updated_at,m.status AS sent_status
    FROM ${PACKS} k LEFT JOIN customer_communications m ON m.workspace_id=k.workspace_id AND m.id=k.communication_id
    WHERE k.workspace_id=$1 ORDER BY k.closing DESC LIMIT 1`,[workspaceId])).rows[0];
  if(!row)return [];
  const link=href+'#year-end-packs',base={kind:'accounting',importance:'Needs You',href:link,sourceId:'year-end-pack:'+row.id,createdAt:row.updated_at,at:row.updated_at};
  const name=yearName(row.closing);
  if(row.status==='WAITING')return [{...base,priority:45,title:'Your year-end stock pack for the '+name+' is ready to send',happened:row.reason||'The pack is made and kept.',
    why:'StockChief asks you before it sends this pack.',recommendation:'Check it and press send.',actionLabel:'Review and send'}];
  if(row.status==='STOPPED')return [{...base,priority:50,title:row.problem==='recipient'?'Add your accountant’s email to send the year-end stock pack':row.problem==='mailbox_choice'?'Choose the mailbox for the year-end stock pack':
      row.problem==='size'?'The year-end stock pack is too large to email':'Connect a mailbox to send the year-end stock pack',
    happened:row.reason,why:'StockChief does not guess where to send the pack or which mailbox to send it from.',recommendation:'Fix this on the year-end pack page.',actionLabel:'Open the year-end pack'}];
  if(row.sent_status==='FAILED')return [{...base,priority:50,title:'The year-end stock pack was not sent',happened:'The mailbox did not send it.',
    why:'Your accountant has not received it.',recommendation:'Check the mailbox, then send again.',actionLabel:'Open the year-end pack'}];
  return [];
}

module.exports={JOB,ACTION,KIND,MAIL,href,authority,prepare,send,configure,deliveryAuthority,attachments,due,run,schedule,makeNow,page,kept,inbox,words};
