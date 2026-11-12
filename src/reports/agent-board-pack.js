'use strict';
// Job 159 (Custom): the board or investor pack.
//
// Six months to a closing month, each currency on its own pages: sales, cost of
// goods and gross profit with the gross margin; stock value at each month end
// (cash tied up in stock) with days of supply and stock turns; the best items by
// gross profit; and problems from the records (stock written off, count
// differences, a difference between the books and the stock records, overdue
// customer invoices, and items that sold but are out of stock today). A short
// commentary is written from those numbers only, the same way every time.
//
// The owner can download the pack at any time, keep a copy, or set a day each
// month on which StockChief builds the pack for the month that just ended
// (through the worker) and tells them in Needs you. Pause holds the schedule;
// Watch only, Ask me first and the first 14 days build it without telling.
// Everything is read from posted journal entries and stock records.
const {ValidationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const time=require('../lib/business-time');
const audit=require('../operations/postgres-security-audit');
const storage=require('../commercial/storage-capacity');
const reports=require('./agent-report-runs');

const JOB=159,ACTION='report.board_pack',KIND='reports.board-pack.v1',href='/autopilot/reviews/board-pack',MONTHS=6;
const SCHEDULES='stockchief_runtime.agent_board_pack_schedules';
const fmt=(minor,currency)=>money.format(Number(minor),currency);
const pct=(n,d)=>d?Math.round(n*1000/d)/10:null;
const one=n=>n===null||!Number.isFinite(n)?null:Math.round(n*10)/10;
const daysIn=month=>Number(reports.monthEnd(month).slice(8));
const change=(now,before)=>before?Math.round((now-before)*1000/Math.abs(before))/10:null;

// ---- The figures ----------------------------------------------------------

async function figures(db,workspaceId,closing){
  const months=Array.from({length:MONTHS},(_,i)=>reports.addMonths(closing,i-MONTHS+1));
  const span={closing,start:months[0]+'-01',end:reports.monthEnd(closing),months,name:reports.monthName(closing)};
  const settings=await reports.accounting(db,workspaceId);
  if(!Number(settings?.enabled)||!settings.accounting_start_date)return {...span,currencies:[],problem:'Turn on accounting so the pack can be built from your posted records.'};
  if(settings.accounting_start_date>span.end)return {...span,currencies:[],problem:'Your accounting records start on '+settings.accounting_start_date+', after this month.'};
  const ledger=(await db.query(`SELECT CASE WHEN e.posting_date<$2 THEN 'opening' ELSE substr(e.posting_date,1,7) END AS month,l.currency,
      sum(CASE WHEN a.account_type='INCOME' THEN l.credit_minor-l.debit_minor ELSE 0 END)::text AS revenue,
      sum(CASE WHEN a.account_type='COGS' THEN l.debit_minor-l.credit_minor ELSE 0 END)::text AS cost,
      sum(CASE WHEN a.system_key='INVENTORY_ASSET' THEN l.debit_minor-l.credit_minor ELSE 0 END)::text AS stock
    FROM accounting_journal_entries e JOIN accounting_journal_lines l ON l.workspace_id=e.workspace_id AND l.entry_id=e.id
    JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
    WHERE e.workspace_id=$1 AND e.status='POSTED' AND e.posting_date<=$3 AND (a.account_type IN ('INCOME','COGS') OR a.system_key='INVENTORY_ASSET')
    GROUP BY 1,2 ORDER BY 2,1`,[workspaceId,span.start,span.end])).rows;
  const closingStart=closing+'-01';
  const items=(await db.query(`SELECT l.currency,l.sku_id,s.code,i.name,i.id AS item_id,
      sum(CASE WHEN a.account_type='INCOME' THEN l.credit_minor-l.debit_minor ELSE 0 END)::text AS revenue,
      sum(CASE WHEN a.account_type='COGS' THEN l.debit_minor-l.credit_minor ELSE 0 END)::text AS cost,
      (SELECT coalesce(sum(b.on_hand),0)::text FROM balances b WHERE b.workspace_id=l.workspace_id AND b.sku_id=l.sku_id) AS on_hand
    FROM accounting_journal_entries e JOIN accounting_journal_lines l ON l.workspace_id=e.workspace_id AND l.entry_id=e.id
    JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
    JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE e.workspace_id=$1 AND e.status='POSTED' AND e.posting_date BETWEEN $2 AND $3 AND a.account_type IN ('INCOME','COGS')
    GROUP BY l.workspace_id,l.currency,l.sku_id,s.code,i.name,i.id LIMIT 20001`,[workspaceId,closingStart,span.end])).rows;
  const overdue=(await db.query(`SELECT currency,count(*)::int AS n,coalesce(sum(balance_minor),0)::text AS amount FROM accounting_customer_invoices
    WHERE workspace_id=$1 AND status IN ('OPEN','PARTIALLY_PAID') AND balance_minor>0 AND due_date IS NOT NULL AND due_date<=$2 GROUP BY currency`,[workspaceId,span.end])).rows;
  const month=await require('./agent-month-end-stock').compute(db,workspaceId,{month:closing});
  const currencies=[...new Set(ledger.map(r=>r.currency))].sort(),out=[];
  for(const currency of currencies){
    const rows=ledger.filter(r=>r.currency===currency);
    let stock=Number(rows.find(r=>r.month==='opening')?.stock||0);const points=[];
    for(const m of months){
      const r=rows.find(x=>x.month===m),start=stock;
      stock+=Number(r?.stock||0);
      if(!r&&settings.accounting_start_date>reports.monthEnd(m))continue;
      const revenue=Number(r?.revenue||0),cost=Number(r?.cost||0),gross=revenue-cost,average=(start+stock)/2;
      points.push({month:m,revenue,cost,gross,margin:revenue>0?pct(gross,revenue):null,stock,
        days:cost>0?Math.round(stock*daysIn(m)/cost):null,turns:average>0?one(cost/average*365/daysIn(m)):null,
        coverage:settings.accounting_start_date<=m+'-01'?'Full month':'Partial records'});
    }
    const sold=items.filter(i=>i.currency===currency).map(i=>({code:i.code,name:i.name,href:'/inventory/'+i.item_id,revenue:Number(i.revenue),cost:Number(i.cost),
      gross:Number(i.revenue)-Number(i.cost),onHand:Number(i.on_hand)}));
    const top=sold.filter(i=>i.revenue>0).sort((a,b)=>b.gross-a.gross||a.code.localeCompare(b.code)).slice(0,5)
      .map(i=>({...i,margin:pct(i.gross,i.revenue)}));
    const problems=[],stockMonth=month.currencies?.find(c=>c.currency===currency);
    if(stockMonth){
      if(stockMonth.totals.writeoffs)problems.push({key:'writeoffs',label:'Stock written off',amount:-Number(stockMonth.totals.writeoffs)});
      if(stockMonth.totals.adjustments)problems.push({key:'counts',label:'Count differences',amount:Number(stockMonth.totals.adjustments)});
      if(stockMonth.difference.closing)problems.push({key:'books',label:'Books differ from stock records',amount:Number(stockMonth.difference.closing)});
    }
    const late=overdue.find(o=>o.currency===currency);
    if(late)problems.push({key:'overdue',label:'Customer invoices overdue and unpaid',amount:Number(late.amount),count:late.n});
    const out_=sold.filter(i=>i.revenue>0&&i.onHand<=0).sort((a,b)=>b.revenue-a.revenue);
    if(out_.length)problems.push({key:'stockouts',label:'Items sold in '+span.name+' and out of stock today',count:out_.length,names:out_.slice(0,3).map(i=>i.code)});
    const entry={currency,points,top,problems};
    entry.commentary=commentary(span,entry);
    out.push(entry);
  }
  return {...span,currencies:out,accountingStart:settings.accounting_start_date};
}

// Short plain sentences, only from the figures above.
function commentary(span,c){
  const last=c.points[c.points.length-1],before=c.points[c.points.length-2],first=c.points[0],cur=c.currency,out=[];
  if(!last||last.month!==span.closing)return ['No posted sales or stock value in '+span.name+'.'];
  const vs=(now,then,label)=>{const p=change(now,then);return p===null?'':(p===0?', the same as ':p>0?', up '+p+'% on ':', down '+Math.abs(p)+'% on ')+label;};
  const sinceFirst=first&&first!==before&&first!==last?vs(last.revenue,first.revenue,reports.monthName(first.month)):'';
  out.push('Sales were '+fmt(last.revenue,cur)+' in '+span.name+(before?vs(last.revenue,before.revenue,reports.monthName(before.month)):'')+
    (sinceFirst?' and'+sinceFirst.slice(1):'')+'.');
  out.push('Gross profit was '+fmt(last.gross,cur)+(last.margin===null?'':', a '+last.margin+'% margin')+(before&&before.margin!==null?' ('+before.margin+'% in '+reports.monthName(before.month)+')':'')+'.');
  out.push('Stock was worth '+fmt(last.stock,cur)+' at the month end'+(last.days===null?'':', about '+last.days+' days of supply at this month’s cost of goods')+
    (last.turns===null?'':', turning '+last.turns+' times a year')+'.');
  if(c.top[0])out.push('Best item: '+c.top[0].code+' · '+c.top[0].name+', with '+fmt(c.top[0].gross,cur)+' of gross profit.');
  if(c.problems.length)out.push('To watch: '+c.problems.map(p=>p.key==='stockouts'?p.count+' item'+(p.count===1?'':'s')+' sold and now out of stock'
    :p.key==='overdue'?fmt(p.amount,cur)+' overdue on '+p.count+' invoice'+(p.count===1?'':'s'):p.label.toLowerCase()+' '+fmt(p.amount,cur)).join('; ')+'.');
  else out.push('No write-offs, count differences, overdue invoices or stockouts recorded.');
  return out;
}

// ---- The PDF --------------------------------------------------------------

function pdf(pack){
  const PDF=require('pdfkit'),doc=new PDF({size:'A4',layout:'landscape',margin:36,info:{Title:'Board or investor pack',Author:'StockChief'}});
  const font=require.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf');
  const done=new Promise((resolve,reject)=>{const chunks=[];doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  const ink='#192731',palette=['#234e68','#b25c29','#3e7552','#6b4f8a'];
  doc.font(font).fillColor(ink);
  const bars=(x,y,w,h,points,series,currency,title,label=v=>fmt(v,currency))=>{
    doc.fillColor(ink).fontSize(10).text(title,x,y);
    const values=points.flatMap(p=>series.map(([,k])=>p[k]||0)),high=Math.max(0,...values),low=Math.min(0,...values),scale=(h-30)/((high-low)||1),zero=y+18+high*scale;
    const step=(w-50)/Math.max(points.length,1),bar=Math.min(16,step/(series.length+1));
    doc.fontSize(7).text(label(high),x,y+14,{width:48});if(low<0)doc.text(label(low),x,y+h-14,{width:48});
    doc.strokeColor('#91a0a8').moveTo(x+50,zero).lineTo(x+w,zero).stroke();
    for(const [i,p] of points.entries()){
      const center=x+50+step*(i+.5);
      for(const [j,[,k]] of series.entries()){const v=p[k]||0;if(v)doc.rect(center+(j-series.length/2)*bar,Math.min(zero,zero-v*scale),bar-1,Math.abs(v*scale)).fill(palette[j]);}
      doc.fillColor(ink).fontSize(7).text(p.month,center-22,y+h+2,{width:44,align:'center'});
    }
    series.forEach(([label],j)=>{doc.rect(x+50+j*95,y+h+14,8,8).fill(palette[j]);doc.fillColor(ink).fontSize(8).text(label,x+62+j*95,y+h+14);});
  };
  if(!pack.currencies.length){doc.fontSize(22).text('Board or investor pack',36,36);doc.fontSize(11).text(pack.problem||'No posted records in this period.',36,76);}
  for(const [index,c] of pack.currencies.entries()){
    if(index)doc.addPage();
    doc.fillColor(ink).fontSize(22).text('Board or investor pack',36,30);
    doc.fontSize(10).text(pack.start+' to '+pack.end+'  |  '+c.currency+'  |  closing month '+pack.name,36,58);
    doc.fontSize(9.5).text(c.commentary.join(' '),36,76,{width:770});
    const y=146;
    bars(36,y,370,150,c.points,[['Sales','revenue'],['Cost of goods','cost'],['Gross profit','gross']],c.currency,'Sales and gross profit');
    bars(436,y,370,150,c.points,[['Stock value','stock']],c.currency,'Cash tied up in stock at month end');
    const columns=[['Month',60],['Sales',90],['Cost of goods',90],['Gross profit',90],['Margin',60],['Stock value',95],['Days of supply',80],['Turns a year',75],['Coverage',90]];
    let ty=345,x=36;for(const [label,w] of columns){doc.fontSize(8.5).text(label,x,ty,{width:w-4});x+=w;}
    for(const p of c.points){ty+=17;x=36;
      const cells=[p.month,fmt(p.revenue,c.currency),fmt(p.cost,c.currency),fmt(p.gross,c.currency),p.margin===null?'':p.margin+'%',fmt(p.stock,c.currency),p.days??'',p.turns??'',p.coverage];
      cells.forEach((v,i)=>{doc.fontSize(9).text(String(v),x,ty,{width:columns[i][1]-4});x+=columns[i][1];});}
    doc.fontSize(7.5).text('Source: posted StockChief journal entries and stock records. Days of supply and turns use each month’s cost of goods and its stock value.',36,536,{width:770,height:20});
    doc.addPage();
    doc.fillColor(ink).fontSize(16).text('Best items in '+pack.name+' · '+c.currency,36,30);
    let iy=58;
    if(!c.top.length){doc.fontSize(10).text('No item sales posted this month.',36,iy);iy+=18;}
    else{const head=[['Item',300],['Sales',100],['Cost of goods',100],['Gross profit',100],['Margin',70]];x=36;for(const [l,w] of head){doc.fontSize(9).text(l,x,iy,{width:w-4});x+=w;}
      for(const t of c.top){iy+=17;x=36;[t.code+' · '+t.name,fmt(t.revenue,c.currency),fmt(t.cost,c.currency),fmt(t.gross,c.currency),t.margin===null?'':t.margin+'%']
        .forEach((v,i)=>{doc.fontSize(9).text(String(v),x,iy,{width:head[i][1]-4});x+=head[i][1];});}}
    iy+=36;doc.fontSize(16).text('Problems to watch',36,iy);iy+=26;
    if(!c.problems.length)doc.fontSize(10).text('No write-offs, count differences, overdue invoices or stockouts recorded.',36,iy);
    for(const p of c.problems){doc.fontSize(10).text(p.label+': '+(p.amount!==undefined?fmt(p.amount,c.currency):'')+(p.count?(p.amount!==undefined?' on ':'')+p.count+(p.key==='overdue'?' invoice':' item')+(p.count===1?'':'s'):'')+(p.names?' ('+p.names.join(', ')+')':''),36,iy,{width:770});iy+=18;}
    // Stock health: how long the stock lasts and how often it turns.
    const hy=Math.max(iy+30,300);
    bars(36,hy,370,150,c.points,[['Days of supply','days']],c.currency,'Days of supply at month end',v=>String(Math.round(v)));
    bars(436,hy,370,150,c.points,[['Turns a year','turns']],c.currency,'Stock turns a year',v=>String(Math.round(v*10)/10));
  }
  doc.end();return done;
}

// ---- Pages, review rows, keeping copies -----------------------------------

async function access(db,ctx,operation='suggest'){
  await reports.owner(db,ctx);
  return policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,operation);
}
async function closingFor(db,workspaceId,value){return reports.completedMonth(await time.today(db,workspaceId),value,'closing month');}
// Review rows (Ask and the agent review list) and the live download.
async function readPage(db,ctx,{filter,today}){
  const closing=reports.completedMonth(today,filter,'closing month');
  const pack=await figures(db,ctx.workspaceId,closing);
  if(pack.problem)return {span:pack,...pack,rows:[],more:false,summary:pack.problem};
  const link=href+'?'+new URLSearchParams({month:closing}),rows=[];
  for(const c of pack.currencies)for(const p of c.points)rows.push({Month:p.month,Currency:c.currency,Revenue:fmt(p.revenue,c.currency),'Cost of goods':fmt(p.cost,c.currency),
    'Gross profit':fmt(p.gross,c.currency),'Gross margin':p.margin===null?null:p.margin+'%','Stock value':fmt(p.stock,c.currency),'Days of supply':p.days,'Turns a year':p.turns,Coverage:p.coverage,link});
  return {span:pack,...pack,rows,more:false,summary:pack.currencies.map(c=>c.commentary.join(' ')).join(' ')};
}
async function schedule_(db,workspaceId){return (await db.query(`SELECT * FROM ${SCHEDULES} WHERE workspace_id=$1`,[workspaceId])).rows[0]||null;}
async function page(db,ctx,query={}){
  const state=await access(db,ctx);
  const closing=await closingFor(db,ctx.workspaceId,query.month||query.filter);
  const pack=await db.transaction(c=>figures(c,ctx.workspaceId,closing),{isolation:'REPEATABLE READ'});
  const today=await time.today(db,ctx.workspaceId);
  const [kept,flags,rule]=[await reports.runs(db,ctx.workspaceId,JOB,{limit:12}),await reports.flagsFor(db,ctx.workspaceId,JOB),await schedule_(db,ctx.workspaceId)];
  return {pack,closing,months:Array.from({length:24},(_,i)=>reports.addMonths(reports.lastCompleted(today),-i)),kept,flags,rule,shadow:Boolean(state.shadow),
    automatic:rule?.enabled?await reports.automaticStop(db,ctx.workspaceId,state,ACTION):null,fmt,
    download:href+'/download?'+new URLSearchParams({filter:closing})};
}
const plain=v=>JSON.parse(JSON.stringify(v));
function ready(pack){
  return {key:'ready:'+pack.closing,detail:{kind:'accounting',priority:40,title:'Your board pack for '+pack.name+' is ready',
    happened:pack.currencies.map(c=>c.commentary[0]).join(' ')||'The pack is built from your posted records.',
    why:'You asked StockChief to build the board pack each month.',recommendation:'Download it and check it before you share it.',
    href:href+'?'+new URLSearchParams({month:pack.closing})+'#kept-packs',actionLabel:'Open the board pack'}};
}
async function produce(c,ctx,closing,{automatic,watch=null}){
  const pack=plain(await figures(c,ctx.workspaceId,closing));
  return reports.record(c,ctx,{job:JOB,period:closing,facts:pack,result:pack,flags:automatic&&!pack.problem?[ready(pack)]:[],automatic,watch,problem:pack.problem||null,
    syncFlags:automatic,action:automatic?'StockChief built the board pack':'Built and kept the board pack'});
}
// On demand: keep a copy of this month's pack.
async function keep(database,ctx,input={}){
  await access(database,ctx);
  const closing=await closingFor(database,ctx.workspaceId,input.month);
  return reports.tx(database,async c=>produce(c,ctx,closing,{automatic:false}));
}
async function kept(db,ctx,runId){
  await access(db,ctx);
  const run=(await db.query(`SELECT id,period,result,outcome,created_at FROM ${reports.tables.runs} WHERE workspace_id=$1 AND job_id=$2 AND id=$3 AND outcome<>'STOPPED'`,
    [ctx.workspaceId,JOB,String(runId||'')])).rows[0];
  if(!run)throw new NotFoundError('That board pack is not in this inventory.');
  const file=await pdf(run.result);
  await reports.tx(db,async c=>{
    const settled=await reports.settle(c,ctx,JOB,run.period,'ready:'+run.period,'Downloaded.');
    if(settled)await audit.record(c,ctx,{action:'Downloaded the board pack',reference:reports.monthName(run.period),after:{runId:run.id}});
  });
  return {filename:'board-pack-'+run.period+'.pdf',body:file};
}

// ---- The owner's schedule and the worker ----------------------------------

async function configure(database,ctx,input={}){
  return reports.tx(database,async c=>{
    await reports.owner(c,ctx);
    const prior=(await c.query(`SELECT * FROM ${SCHEDULES} WHERE workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0];
    if(Number(input.revision||0)!==(prior?.revision||0))throw new ValidationError('Reload the board pack schedule before changing it.');
    if(input.stop==='yes'){
      if(prior?.enabled){
        await c.query(`UPDATE ${SCHEDULES} SET enabled=false,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1`,[ctx.workspaceId]);
        await audit.record(c,ctx,{action:'Stopped the monthly board pack',before:{dayOfMonth:prior.day_of_month}});
      }
      return {stopped:true};
    }
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic');
    const day=Number(String(input.dayOfMonth??'').trim());
    if(!Number.isSafeInteger(day)||day<1||day>28)throw new ValidationError('Choose a day from 1 to 28.');
    if(prior?.enabled&&prior.day_of_month===day)return {unchanged:true};
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await storage.reserve(reports.scoped(c),ctx.workspaceId,'board-pack-schedule:'+((prior?.revision||0)+1),512,{finished:true});
    await c.query(`INSERT INTO ${SCHEDULES}(workspace_id,day_of_month,authorized_by) VALUES($1,$2,$3)
      ON CONFLICT(workspace_id) DO UPDATE SET day_of_month=EXCLUDED.day_of_month,authorized_by=EXCLUDED.authorized_by,enabled=true,
        revision=agent_board_pack_schedules.revision+1,updated_at=clock_timestamp()`,[ctx.workspaceId,day,ctx.actorId]);
    await audit.record(c,ctx,{action:'Scheduled the monthly board pack',before:prior?{dayOfMonth:prior.day_of_month,enabled:prior.enabled}:{},after:{dayOfMonth:day}});
    return {saved:true};
  });
}
async function due(db,workspaceId,today){
  const installed=require('../db/schema-installed');
  if(!(await installed.has(db,SCHEDULES)))return null;
  const rule=await schedule_(db,workspaceId);if(!rule?.enabled||Number(today.slice(8,10))<rule.day_of_month)return null;
  const settings=await reports.accounting(db,workspaceId),month=reports.lastCompleted(today);
  if(!Number(settings?.enabled)||!settings.accounting_start_date||settings.accounting_start_date>reports.monthEnd(month))return null;
  return month;
}
async function run(database,workspaceId,payload={}){
  const actorId=await reports.currentOwner(database,workspaceId);if(!actorId)return {skipped:'owner_unavailable'};
  const ctx={workspaceId,actorId},state=await policy.accountState(database,workspaceId);
  if(!reports.alone(state,JOB))return {skipped:'plan'};
  if(await reports.paused(database,workspaceId))return {held:'paused'};
  const today=await time.today(database,workspaceId),month=await due(database,workspaceId,today);
  if(!month)return {skipped:'not_scheduled'};
  if(payload.month&&payload.month!==month)return {skipped:'stale'};
  return reports.tx(database,async c=>produce(c,ctx,month,{automatic:true,watch:await reports.automaticStop(c,workspaceId,state,ACTION)}));
}
async function schedule(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);if(!reports.alone(state,JOB))return {queued:0};
  const today=await time.today(db,workspaceId),month=await due(db,workspaceId,today);if(!month)return {queued:0};
  if((await db.query(`SELECT 1 FROM ${reports.tables.runs} WHERE workspace_id=$1 AND job_id=$2 AND period=$3 AND outcome='PRODUCED' AND authorization_kind='AUTOMATIC' LIMIT 1`,[workspaceId,JOB,month])).rowCount)return {queued:0};
  // Daily from the chosen day until the month's pack is built; the same facts replay to the same pack.
  const job=await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:KIND,priority:70,maxAttempts:3,idempotencyKey:'board-pack:'+month+':'+today,payload:{month}});
  return {queued:job.created?1:0};
}

module.exports={JOB,ACTION,KIND,href,figures,commentary,pdf,readPage,page,keep,kept,configure,run,schedule};
