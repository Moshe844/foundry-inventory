'use strict';
// Job 158: month-end stock value and cost of goods.
//
// For each location the report rolls stock value forward through the month:
// opening value, received, cost of goods sold, counts and adjustments, written
// off, transfers, production and other, and closing value. The figures come
// from the stock value records (every cost change at every location), dated by
// the journal entry that booked them, else by when the goods moved. Each
// currency's totals are then checked against Inventory in the books. Postings
// that are only in the books, or only in the stock records, are listed; any
// difference is flagged in Needs you. Cost of goods sold in the books is shown
// beside the cost of goods taken from stock.
//
// Growth, Pro and Custom make the report on their own after each month ends,
// through the worker, and keep checking a month while it has a difference.
// Nothing here posts, changes or closes anything: closing a month in the books
// always stays with a person.
const {ValidationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const time=require('../lib/business-time');
const reports=require('./agent-report-runs');

const JOB=158,ACTION='report.month_end_stock',KIND='reports.month-end-stock.v1',href='/autopilot/reviews/month-end-stock';
const CATEGORIES=Object.freeze([['receipts','Received'],['cogs','Cost of goods sold'],['adjustments','Counts and adjustments'],
  ['writeoffs','Written off'],['transfers','Transfers'],['other','Production and other']]);
const WRITE_OFF_REASONS=['damaged','damage','expired','disposal','loss','lost','scrap','custody_loss','write_off','writeoff'];
const WRITE_OFF_SOURCES=['customer_return_scrap','custody_loss','inventory_write_down','inventory_write_down_aged'];
const PRODUCTION_REASONS=['production','production_recovery','used'];

function zero(){return Object.fromEntries(CATEGORIES.map(([k])=>[k,0n]));}

// Stock value changes from opening to closing for each location (or SKU), in
// the base currency of the stock value records. Bins roll up to their warehouse.
async function records(db,workspaceId,{start,end,zone,by='location',skuIds=null}){
  const rows=(await db.query(`WITH RECURSIVE roots AS (
      SELECT id,id AS root FROM locations WHERE workspace_id=$1 AND parent_location_id IS NULL
      UNION ALL SELECT l.id,r.root FROM locations l JOIN roots r ON l.parent_location_id=r.id WHERE l.workspace_id=$1),
    changes AS MATERIALIZED (
      SELECT m.sku_id,m.location_id,m.cost_delta_minor::bigint AS amount,e.id AS entry_id,mv.operation,mv.reason_code,m.cost_source_type AS source,
        coalesce(e.posting_date,(coalesce(mv.occurred_at,m.created_at)::timestamptz AT TIME ZONE $4)::date::text) AS day
      FROM accounting_inventory_cost_movements m
      LEFT JOIN movements mv ON mv.workspace_id=m.workspace_id AND mv.id=m.inventory_movement_id
      LEFT JOIN accounting_journal_entries e ON e.workspace_id=m.workspace_id AND e.id=m.journal_entry_id AND e.status='POSTED'
      WHERE m.workspace_id=$1 AND m.cost_delta_minor<>0 AND ($7::text[] IS NULL OR m.sku_id=ANY($7::text[]))
      UNION ALL
      SELECT v.sku_id,v.location_id,v.amount_delta_minor::bigint,e.id,'value',NULL,v.source_type,
        coalesce(e.posting_date,(v.created_at::timestamptz AT TIME ZONE $4)::date::text)
      FROM accounting_inventory_value_adjustments v
      LEFT JOIN accounting_journal_entries e ON e.workspace_id=v.workspace_id AND e.id=v.journal_entry_id AND e.status='POSTED'
      WHERE v.workspace_id=$1 AND ($7::text[] IS NULL OR v.sku_id=ANY($7::text[]))),
    kinds AS (
      SELECT l.entry_id,bool_or(a.account_type='COGS' OR a.system_key='CUSTOMER_RETURN_COST_PENDING') AS cogs,
        bool_or(a.system_key='INVENTORY_WRITE_DOWNS') AS written_down,bool_or(a.system_key='INVENTORY_IN_TRANSIT') AS transit,
        bool_or(a.system_key='SUPPLIER_CREDITS_RECEIVABLE') AS supplier_return
      FROM accounting_journal_lines l JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
      WHERE l.workspace_id=$1 AND l.entry_id IN (SELECT entry_id FROM changes WHERE entry_id IS NOT NULL AND day BETWEEN $2 AND $3)
      GROUP BY l.entry_id)
    SELECT CASE WHEN $8='sku' THEN c.sku_id ELSE coalesce(r.root,c.location_id) END AS key,c.day<$2 AS opening,
      CASE WHEN c.day<$2 THEN NULL
        WHEN k.written_down OR c.reason_code=ANY($5::text[]) OR c.source=ANY($6::text[]) THEN 'writeoffs'
        WHEN k.cogs THEN 'cogs'
        WHEN k.transit OR c.operation='transfer' THEN 'transfers'
        WHEN c.reason_code=ANY($9::text[]) THEN 'other'
        WHEN c.operation IN ('receive','value') OR k.supplier_return OR c.reason_code='returned' THEN 'receipts'
        WHEN c.operation='adjust' THEN 'adjustments'
        ELSE 'other' END AS category,
      sum(c.amount)::text AS amount,
      count(*) FILTER (WHERE c.day>=$2 AND c.entry_id IS NULL AND c.operation IS DISTINCT FROM 'transfer')::int AS unbooked,
      coalesce(sum(c.amount) FILTER (WHERE c.day>=$2 AND c.entry_id IS NULL AND c.operation IS DISTINCT FROM 'transfer'),0)::text AS unbooked_amount
    FROM changes c LEFT JOIN roots r ON r.id=c.location_id LEFT JOIN kinds k ON k.entry_id=c.entry_id
    WHERE c.day<=$3 GROUP BY 1,2,3`,
  [workspaceId,start,end,zone,WRITE_OFF_REASONS,WRITE_OFF_SOURCES,skuIds,by,PRODUCTION_REASONS])).rows;
  const out=new Map(),unbooked={count:0,amount:0n};
  for(const r of rows){
    if(!out.has(r.key))out.set(r.key,{key:r.key,opening:0n,...zero()});
    const p=out.get(r.key),amount=BigInt(r.amount);
    if(r.opening)p.opening+=amount;else p[r.category]+=amount;
    unbooked.count+=r.unbooked;unbooked.amount+=BigInt(r.unbooked_amount);
  }
  for(const p of out.values())p.closing=CATEGORIES.reduce((n,[k])=>n+p[k],p.opening);
  return {positions:[...out.values()],unbooked};
}

// Inventory, stock in transit and cost of goods sold in the books.
async function books(db,workspaceId,{start,end}){
  // One after another: db may be a single transaction client.
  const totals=await db.query(`SELECT l.currency,
      coalesce(sum(l.debit_minor-l.credit_minor) FILTER (WHERE a.system_key='INVENTORY_ASSET' AND e.posting_date<$2),0)::text AS opening,
      coalesce(sum(l.debit_minor-l.credit_minor) FILTER (WHERE a.system_key='INVENTORY_ASSET'),0)::text AS closing,
      coalesce(sum(l.debit_minor-l.credit_minor) FILTER (WHERE a.system_key='INVENTORY_IN_TRANSIT'),0)::text AS transit,
      coalesce(sum(l.debit_minor-l.credit_minor) FILTER (WHERE a.account_type='COGS' AND e.posting_date>=$2),0)::text AS cogs
    FROM accounting_journal_entries e JOIN accounting_journal_lines l ON l.workspace_id=e.workspace_id AND l.entry_id=e.id
    JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
    WHERE e.workspace_id=$1 AND e.status='POSTED' AND e.posting_date<=$3
      AND (a.system_key IN ('INVENTORY_ASSET','INVENTORY_IN_TRANSIT') OR a.account_type='COGS') GROUP BY l.currency ORDER BY l.currency`,[workspaceId,start,end]);
  // Entries that changed Inventory in the month with no stock value record behind them.
  const only=await db.query(`SELECT e.id,e.entry_number,e.posting_date,e.description,l.currency,sum(l.debit_minor-l.credit_minor)::text AS amount
    FROM accounting_journal_entries e JOIN accounting_journal_lines l ON l.workspace_id=e.workspace_id AND l.entry_id=e.id
    JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id AND a.system_key='INVENTORY_ASSET'
    WHERE e.workspace_id=$1 AND e.status='POSTED' AND e.posting_date BETWEEN $2 AND $3
      AND NOT EXISTS(SELECT 1 FROM accounting_inventory_cost_movements m WHERE m.workspace_id=e.workspace_id AND m.journal_entry_id=e.id)
      AND NOT EXISTS(SELECT 1 FROM accounting_inventory_value_adjustments v WHERE v.workspace_id=e.workspace_id AND v.journal_entry_id=e.id)
    GROUP BY e.id,e.entry_number,e.posting_date,e.description,l.currency HAVING sum(l.debit_minor-l.credit_minor)<>0
    ORDER BY abs(sum(l.debit_minor-l.credit_minor)) DESC,e.entry_number LIMIT 51`,[workspaceId,start,end]);
  return {totals:totals.rows,only:only.rows};
}

const dollars=(minor,currency)=>money.format(Number(minor),currency);

// The report for one completed month (or any date range ending on a month end).
async function compute(db,workspaceId,{month,start=null,end=null}){
  const range=month?reports.span(month):{month:end.slice(0,7),start,end,name:reports.monthName(end.slice(0,7))};
  const settings=await reports.accounting(db,workspaceId);
  if(!Number(settings?.enabled)||!settings.accounting_start_date)
    return {...range,currencies:[],problem:'Turn on accounting so the report can be checked against your books.'};
  if(settings.accounting_start_date>range.end)
    return {...range,currencies:[],problem:'Your accounting records start on '+settings.accounting_start_date+', after this month.'};
  const zone=(await time.forWorkspace(db,workspaceId)).timeZone;
  const stock=await records(db,workspaceId,{...range,zone}),ledger=await books(db,workspaceId,range);
  const places=await db.query('SELECT id,name FROM locations WHERE workspace_id=$1',[workspaceId]);
  const names=new Map(places.rows.map(l=>[l.id,l.name])),base=settings.base_currency;
  const currencies=new Set([base,...ledger.totals.map(t=>t.currency)]),out=[];
  for(const currency of [...currencies].sort()){
    const positions=currency===base?stock.positions.filter(p=>p.opening||p.closing||CATEGORIES.some(([k])=>p[k])):[];
    const locations=positions.map(p=>({id:p.key,name:names.get(p.key)||'Removed location',...p}))
      .sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
    const totals={opening:0n,...zero(),closing:0n};
    for(const p of locations)for(const k of Object.keys(totals))totals[k]+=p[k];
    const b=ledger.totals.find(t=>t.currency===currency)||{opening:'0',closing:'0',transit:'0',cogs:'0'};
    const booksOpening=BigInt(b.opening),booksClosing=BigInt(b.closing),booksCogs=BigInt(b.cogs);
    const only=ledger.only.filter(e=>e.currency===currency);
    const fromStock=-totals.cogs;
    out.push({currency,locations,totals,
      books:{opening:booksOpening,closing:booksClosing,transit:BigInt(b.transit),cogs:booksCogs},
      difference:{opening:booksOpening-totals.opening,closing:booksClosing-totals.closing},
      cogs:{books:booksCogs,fromStock,notFromStock:booksCogs-fromStock},
      booksOnly:only.slice(0,50).map(e=>({id:e.id,number:Number(e.entry_number),date:e.posting_date,description:e.description,amount:BigInt(e.amount),href:'/accounting/entries/'+e.id})),
      booksOnlyMore:only.length>50,
      recordsOnly:currency===base?stock.unbooked:{count:0,amount:0n}});
  }
  return {...range,base,accountingStart:settings.accounting_start_date,partial:settings.accounting_start_date>range.start,currencies:out};
}

// Plain numbers for storage, hashing and files.
function plain(report){return JSON.parse(JSON.stringify(report,(_k,v)=>typeof v==='bigint'?Number(v):v));}

// What Needs you shows for each currency whose books and records differ.
function differences(report){
  const link=href+'?'+new URLSearchParams({month:report.month});
  return report.currencies.filter(c=>c.difference.closing!==0n).map(c=>{
    const diff=c.difference.closing,more=diff>0n?'more':'less';
    return {key:'difference:'+c.currency,currency:c.currency,amount:Number(diff),detail:{kind:'accounting',priority:55,
      title:'Stock value in your books differs from your stock records for '+report.name,
      happened:'At '+report.end+' your books show '+dollars(c.books.closing,c.currency)+' of stock and your stock records '+dollars(c.totals.closing,c.currency)+
        ': '+dollars(diff<0n?-diff:diff,c.currency)+' '+more+' in the books.'+(c.booksOnly.length?' '+c.booksOnly.length+(c.booksOnlyMore?'+':'')+' posting'+(c.booksOnly.length===1?' is':'s are')+' only in the books.':''),
      why:'The month-end report checks Inventory in your books against your stock records.',
      recommendation:'Open the report to see what is only in the books or only in the stock records. StockChief has not changed your books.',
      href:link,actionLabel:'Open the month-end report'}};
  });
}

// ---- Making the report: worker, owner, schedule ---------------------------

async function produce(c,ctx,month,{automatic,watch=null}){
  const report=await compute(c,ctx.workspaceId,{month});
  const stored=plain(report);
  return reports.record(c,ctx,{job:JOB,period:month,facts:stored,result:stored,flags:report.problem?[]:differences(report),automatic,watch,
    problem:report.problem||null,action:automatic?'StockChief made the month-end stock report':'Made the month-end stock report'});
}
async function due(db,workspaceId,today){
  const settings=await reports.accounting(db,workspaceId);
  if(!Number(settings?.enabled)||!settings.accounting_start_date)return null;
  const month=reports.lastCompleted(today);
  if(settings.accounting_start_date>reports.monthEnd(month))return null;
  return month;
}
// Worker: make the report for the month that just ended, and check a month again while it has a difference.
async function run(database,workspaceId,payload={}){
  const actorId=await reports.currentOwner(database,workspaceId);if(!actorId)return {skipped:'owner_unavailable'};
  const ctx={workspaceId,actorId},state=await policy.accountState(database,workspaceId);
  if(!reports.alone(state,JOB))return {skipped:'plan'};
  if(await reports.paused(database,workspaceId))return {held:'paused'};
  const today=await time.today(database,workspaceId);
  const month=reports.MONTH.test(String(payload.month||''))&&payload.month<today.slice(0,7)?payload.month:await due(database,workspaceId,today);
  if(!month)return {skipped:'no_books'};
  return reports.tx(database,async c=>produce(c,ctx,month,{automatic:true,watch:await reports.automaticStop(c,workspaceId,state,ACTION)}));
}
async function schedule(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);if(!reports.alone(state,JOB))return {queued:0};
  const today=await time.today(db,workspaceId),month=await due(db,workspaceId,today);
  const open=(await db.query(`SELECT DISTINCT period FROM ${reports.tables.flags} WHERE workspace_id=$1 AND job_id=$2 AND status='OPEN' ORDER BY period DESC LIMIT 3`,[workspaceId,JOB])).rows.map(r=>r.period);
  const made=month?(await db.query(`SELECT 1 FROM ${reports.tables.runs} WHERE workspace_id=$1 AND job_id=$2 AND period=$3 AND outcome='PRODUCED' LIMIT 1`,[workspaceId,JOB,month])).rowCount:1;
  const queue=require('../operations/postgres-job-queue');let queued=0;
  // Daily after each month end until the month's report is made (a watched
  // report is made again once StockChief may flag), then daily while a month
  // still has an open difference. The same facts replay to the same run.
  for(const period of new Set([...(made?[]:[month]),...open])){
    const job=await queue.enqueue(db,{workspaceId,kind:KIND,priority:70,maxAttempts:3,idempotencyKey:'month-end-stock:'+period+':'+today,payload:{month:period}});
    if(job.created)queued++;
  }
  return {queued};
}
// The owner checks a month now; with Ask me first, flags open on the owner's say.
async function checkNow(database,ctx,input={}){
  await reports.owner(database,ctx);
  const state=await policy.requireWorkspaceJob(database,ctx.workspaceId,JOB,'draft');
  const stop=await policy.stopped(database,ctx.workspaceId,state,ACTION,false);if(stop)throw new ValidationError(stop);
  const month=reports.completedMonth(await time.today(database,ctx.workspaceId),input.month);
  return reports.tx(database,async c=>produce(c,ctx,month,{automatic:false}));
}

// ---- Page, review, files --------------------------------------------------

async function page(db,ctx,query={}){
  await reports.owner(db,ctx);
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'suggest');
  const today=await time.today(db,ctx.workspaceId);
  const month=reports.completedMonth(today,query.month||query.filter);
  const report=await db.transaction(c=>compute(c,ctx.workspaceId,{month}),{isolation:'REPEATABLE READ'});
  const [runs,flags]=await Promise.all([reports.runs(db,ctx.workspaceId,JOB),reports.flagsFor(db,ctx.workspaceId,JOB)]);
  const stored=runs.find(r=>r.period===month&&r.outcome!=='STOPPED');
  const {hash}=require('../pricing/postgres-promotions');
  const changed=Boolean(stored&&hash(stored.result.currencies||[])!==hash(plain(report).currencies));
  return {report,month,months:Array.from({length:12},(_,i)=>reports.addMonths(reports.lastCompleted(today),-i)),runs,flags,stored,changed,
    categories:CATEGORIES,shadow:Boolean(state.shadow),automatic:await reports.automaticStop(db,ctx.workspaceId,state,ACTION),
    downloads:{xlsx:href+'/download?'+new URLSearchParams({month,format:'xlsx'}),pdf:href+'/download?'+new URLSearchParams({month,format:'pdf'})},money:dollars};
}
// Rows for Ask and the review list: one per location and currency, then totals and the books.
async function readPage(db,ctx,{filter,today}){
  const month=reports.completedMonth(today,filter);
  const report=await compute(db,ctx.workspaceId,{month});
  if(report.problem)return {rows:[],more:false,summary:report.problem};
  const link=href+'?'+new URLSearchParams({month}),rows=[];
  for(const c of report.currencies){
    const row=(label,p)=>({Month:month,Currency:c.currency,Location:label,'Opening value':dollars(p.opening,c.currency),
      ...Object.fromEntries(CATEGORIES.map(([k,l])=>[l,dollars(p[k],c.currency)])),'Closing value':dollars(p.closing,c.currency),link});
    for(const p of c.locations)rows.push(row(p.name,p));
    rows.push({...row('All locations',c.totals),'Stock on books at month end':dollars(c.books.closing,c.currency),'Stock in transit':dollars(c.books.transit,c.currency),
      'Cost of goods sold':dollars(c.cogs.books,c.currency),'Difference to books':dollars(c.difference.closing,c.currency)});
  }
  return {rows,more:false,summary:'Stock value rolled forward through '+report.end+' for each location, checked against Inventory in your books. Later postings are left out.'+
    (report.partial?' Accounting began partway through this month.':'')};
}

function workbook(report){
  const XLSX=require('xlsx'),book=XLSX.utils.book_new(),amount=(v,c)=>Number(money.fromMinor(Number(v),c));
  const sheet=(name,rows)=>{const ws=XLSX.utils.aoa_to_sheet(rows);ws['!cols']=rows[0].map(h=>({wch:Math.max(14,String(h).length+2)}));XLSX.utils.book_append_sheet(book,ws,name);};
  const head=['Currency','Location','Opening value',...CATEGORIES.map(([,l])=>l),'Closing value'];
  const rows=[head];
  for(const c of report.currencies){
    for(const p of c.locations)rows.push([c.currency,p.name,amount(p.opening,c.currency),...CATEGORIES.map(([k])=>amount(p[k],c.currency)),amount(p.closing,c.currency)]);
    rows.push([c.currency,'All locations',amount(c.totals.opening,c.currency),...CATEGORIES.map(([k])=>amount(c.totals[k],c.currency)),amount(c.totals.closing,c.currency)]);
  }
  sheet('Stock value',rows);
  sheet('Books check',[['Currency','Books opening','Records opening','Books closing','Records closing','Difference at month end','Stock in transit','Cost of goods sold in books','Cost of goods from stock','Cost of goods not from stock','Changes only in stock records'],
    ...report.currencies.map(c=>[c.currency,amount(c.books.opening,c.currency),amount(c.totals.opening,c.currency),amount(c.books.closing,c.currency),amount(c.totals.closing,c.currency),
      amount(c.difference.closing,c.currency),amount(c.books.transit,c.currency),amount(c.cogs.books,c.currency),amount(c.cogs.fromStock,c.currency),amount(c.cogs.notFromStock,c.currency),c.recordsOnly.count])]);
  sheet('Only in the books',[['Currency','Entry','Date','Description','Change to Inventory'],
    ...report.currencies.flatMap(c=>c.booksOnly.map(e=>[c.currency,e.number,e.date,e.description,amount(e.amount,c.currency)]))]);
  sheet('Period',[['Month','From','Through','Source'],[report.month,report.start,report.end,'Stock value records and posted journal entries through the month end. Later postings are left out.']]);
  return XLSX.write(book,{type:'buffer',bookType:'xlsx',compression:true});
}
function pdf(report){
  const PDF=require('pdfkit'),doc=new PDF({size:'A4',layout:'landscape',margin:36,info:{Title:'Month-end stock value',Author:'StockChief'}});
  const font=require.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf');
  const done=new Promise((resolve,reject)=>{const chunks=[];doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  const columns=['Location','Opening',...CATEGORIES.map(([,l])=>l),'Closing'],widths=[120,72,72,82,82,72,66,82,72];
  const row=(cells,y,size=8)=>{let x=36;cells.forEach((v,i)=>{doc.fontSize(size).text(String(v),x,y,{width:widths[i]-4,align:i?'right':'left'});x+=widths[i];});};
  doc.font(font).fillColor('#192731');
  if(!report.currencies.length){doc.fontSize(18).text('Month-end stock value · '+report.name,36,36);doc.fontSize(10).text(report.problem||'No stock value recorded.',36,70);}
  for(const [index,c] of report.currencies.entries()){
    if(index)doc.addPage();
    doc.fontSize(18).text('Month-end stock value · '+report.name,36,36);
    doc.fontSize(10).text(report.start+' to '+report.end+'  |  '+c.currency+'  |  later postings left out',36,62);
    let y=92;row(columns,y,8);y+=18;
    for(const p of [...c.locations,{name:'All locations',...c.totals}]){
      if(y>500){doc.addPage();y=36;row(columns,y,8);y+=18;}
      row([p.name,dollars(p.opening,c.currency),...CATEGORIES.map(([k])=>dollars(p[k],c.currency)),dollars(p.closing,c.currency)],y);y+=16;
    }
    y+=12;
    for(const [label,value] of [['Inventory in your books at month end',c.books.closing],['Difference to your stock records',c.difference.closing],['Stock in transit',c.books.transit],
      ['Cost of goods sold in your books',c.cogs.books],['Cost of goods taken from stock',c.cogs.fromStock],['Cost of goods not taken from stock',c.cogs.notFromStock]]){
      doc.fontSize(10).text(label,36,y,{width:260});doc.text(dollars(value,c.currency),300,y,{width:110,align:'right'});y+=16;
    }
    if(c.booksOnly.length){y+=8;doc.fontSize(10).text('Only in the books: '+c.booksOnly.slice(0,8).map(e=>'#'+e.number+' '+e.date+' '+dollars(e.amount,c.currency)).join(', ')+(c.booksOnly.length>8?' and more':''),36,y,{width:760});}
    doc.fontSize(8).text('Source: StockChief stock value records and posted journal entries. Closing the month in your books stays with you.',36,540);
  }
  doc.end();return done;
}
async function download(db,ctx,query={}){
  await reports.owner(db,ctx);
  await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'suggest');
  const format=query.format==='pdf'?'pdf':query.format==='xlsx'||!query.format?'xlsx':null;
  if(!format)throw new ValidationError('Choose Excel or PDF.');
  const month=reports.completedMonth(await time.today(db,ctx.workspaceId),query.month||query.filter);
  const report=await db.transaction(c=>compute(c,ctx.workspaceId,{month}),{isolation:'REPEATABLE READ'});
  if(report.problem)throw new ValidationError(report.problem);
  return {filename:'month-end-stock-'+month+'.'+format,format,body:format==='pdf'?await pdf(report):workbook(report)};
}

module.exports={JOB,ACTION,KIND,href,CATEGORIES,records,books,compute,plain,differences,run,schedule,checkNow,page,readPage,workbook,pdf,download,
  definition:{id:JOB,key:'month-end-stock',label:'Month-end stock value and cost of goods sold',filterLabel:'Completed month (YYYY-MM)',readPage}};
