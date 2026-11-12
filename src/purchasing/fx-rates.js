'use strict';

// Job 40: exchange rates for purchases in other currencies.
//
// A provider adapter supplies daily reference rates. The default is the
// European Central Bank's free, keyless daily reference rates. Rates are
// stored per inventory with their date and source. An owner can enter a
// manual rate; on the same date it takes precedence over the reference rate,
// and a newer rate of either kind replaces an older one. Rates older than a
// week are not used, so a missing rate stops and asks instead of guessing.
//
// Every conversion is exact decimal arithmetic with half-up rounding to the
// target currency's minor unit. Amounts in different currencies are never
// added together.
const {ValidationError,AuthorizationError}=require('../domain/errors');
const money=require('../domain/currency');
const reference=require('./fx-reference');
const audit=require('../operations/postgres-security-audit');
const storage=require('../commercial/storage-capacity');

const table='stockchief_runtime.agent_fx_rates';
const MANUAL='MANUAL',FRESH_DAYS=7;
const scoped=c=>({query:(sql,args)=>c.query(sql,args),transaction:operation=>operation(c)});

// The default provider. Others plug in with use(); tests use a fake one.
const ecb={source:'ECB',label:'European Central Bank',
  link:'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html',
  async latest(){const quote=await reference.latest();return {date:quote.date,base:'EUR',rates:quote.rates,reference:quote.url};}};
let provider=ecb;
function current(){return provider;}
function use(next){
  if(!next||typeof next.latest!=='function'||!/^[A-Z][A-Z0-9_]{1,19}$/.test(String(next.source||''))||next.source===MANUAL)
    throw new TypeError('An exchange-rate provider needs a source code and a latest() method.');
  const previous=provider;provider=next;return previous;
}
function sourceLabel(source){return source===MANUAL?'your rate':source===provider.source?provider.label:source;}

// Exact decimals as BigInt fractions.
function ratio(value){
  const text=String(value??'').trim();
  if(!/^\d{1,20}(?:\.\d{1,30})?$/.test(text))throw new ValidationError('Use a positive decimal exchange rate.');
  const [whole,fraction='']=text.split('.'),n=BigInt(whole+fraction);
  if(n<=0n)throw new ValidationError('Use a positive decimal exchange rate.');
  return {n,d:10n**BigInt(fraction.length)};
}
// n/d as a decimal string with the given significant digits, rounded half-up.
function decimal(n,d,significant=15){
  if(n<=0n||d<=0n)throw new ValidationError('Use a positive decimal exchange rate.');
  const whole=n/d;let scale;
  if(whole>0n)scale=Math.max(0,significant-String(whole).length);
  else{let zeros=0,rest=n*10n;while(rest<d){rest*=10n;zeros++;}scale=zeros+significant;}
  const factor=10n**BigInt(scale),q=(n*factor*2n+d)/(2n*d);
  let text=q.toString().padStart(scale+1,'0');
  if(scale)text=(text.slice(0,-scale)+'.'+text.slice(-scale)).replace(/0+$/,'').replace(/\.$/,'');
  return text;
}
function display(rate){const r=ratio(rate);return decimal(r.n,r.d,6);}
// Amount in `from` minor units to `to` minor units at "1 from = rate to".
function convert(minor,from,to,rate){
  const r=ratio(rate),amount=BigInt(money.integer(minor));
  const num=amount*r.n*10n**BigInt(money.exponent(to)),den=r.d*10n**BigInt(money.exponent(from));
  const value=Number((num*2n+den)/(2n*den));
  if(!Number.isSafeInteger(value))throw new ValidationError('The converted amount exceeds the exact currency range.');
  return value;
}
// Percent change from one rate to another, to two decimal places.
function change(basis,next){
  const b=ratio(basis),c=ratio(next),num=(c.n*b.d-b.n*c.d)*10000n,den=b.n*c.d;
  const sign=num<0n?-1n:1n,abs=num<0n?-num:num;
  return Number(sign*((abs*2n+den)/(2n*den)))/100;
}

function day(value,label='rate date'){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)
    throw new ValidationError('Use a valid '+label+'.');
  return value;
}
function addDays(value,n){return new Date(Date.parse(value+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);}

// Store one provider table. Repeating the same date stores nothing new.
async function store(db,workspaceId,quote,{today=null}={}){
  const source=provider.source,date=day(quote?.date),base=money.code(quote?.base);
  const now=today||await require('../lib/business-time').today(db,workspaceId);
  if(date>now)throw new ValidationError('The reference rates are dated in the future. Nothing was saved.');
  if(date<addDays(now,-FRESH_DAYS))throw new ValidationError('The reference rates are more than a week old. Nothing was saved.');
  const entries=Object.entries(quote.rates||{}).filter(([code])=>code!==base);
  if(!entries.length||entries.length>64)throw new ValidationError('The reference rates have no usable table.');
  const rows=entries.map(([code,rate])=>{const currency=money.code(code);ratio(rate);return {to:currency,rate:String(rate)};});
  if(new Set(rows.map(r=>r.to)).size!==rows.length)throw new ValidationError('The reference rates repeat a currency.');
  const sourceReference=String(quote.reference||provider.link||source).slice(0,300);
  await storage.reserve(scoped(db),workspaceId,'fx-rates:'+source+':'+date,512+rows.length*256,{finished:true});
  const inserted=await db.query(`INSERT INTO ${table}(workspace_id,source,rate_date,from_currency,to_currency,rate,source_reference)
    SELECT $1,$2,$3::date,$4,x.to,x.rate,$5 FROM jsonb_to_recordset($6::jsonb) x("to" text,rate text)
    ON CONFLICT DO NOTHING`,[workspaceId,source,date,base,sourceReference,JSON.stringify(rows)]);
  return {date,source,stored:inserted.rowCount};
}
// Fetch the provider's latest table, outside any transaction, then store it.
async function refresh(db,workspaceId){
  const quote=await provider.latest();
  return db.transaction(c=>store(c,workspaceId,quote),{isolation:'SERIALIZABLE',retrySafe:true});
}

// The rate to use for one pair on one day, or null. Stored rates only.
function pick(rows,from,to){
  const manual=rows.filter(r=>r.source===MANUAL&&r.from_currency===from&&r.to_currency===to)
    .sort((a,b)=>b.rate_date.localeCompare(a.rate_date))[0]||null;
  const tables=new Map();
  for(const r of rows.filter(r=>r.source!==MANUAL)){
    const key=r.source+'|'+r.rate_date+'|'+r.from_currency;
    if(!tables.has(key))tables.set(key,{source:r.source,date:r.rate_date,rates:new Map([[r.from_currency,'1']]),reference:r.source_reference});
    tables.get(key).rates.set(r.to_currency,r.rate);
  }
  const best=[...tables.values()].filter(t=>t.rates.has(from)&&t.rates.has(to)).sort((a,b)=>b.date.localeCompare(a.date))[0]||null;
  if(manual&&(!best||manual.rate_date>=best.date))
    return {rate:manual.rate,date:manual.rate_date,source:MANUAL,reference:manual.source_reference,manual:true};
  if(!best)return null;
  // Cross rate through the table's base currency: to-per-base over from-per-base.
  const f=ratio(best.rates.get(from)),t=ratio(best.rates.get(to));
  return {rate:decimal(t.n*f.d,t.d*f.n),date:best.date,source:best.source,reference:best.reference,manual:false};
}
async function rows(db,workspaceId,pairs,on){
  const currencies=[...new Set(pairs.flat())];
  return (await db.query(`SELECT source,rate_date::text,from_currency,to_currency,rate,source_reference FROM ${table}
    WHERE workspace_id=$1 AND rate_date<=$2::date AND rate_date>$2::date-$4::int
      AND ((source=$5 AND (from_currency,to_currency) IN (SELECT x->>0,x->>1 FROM jsonb_array_elements($3::jsonb) x))
        OR (source<>$5 AND to_currency=ANY($6::text[])))
    ORDER BY rate_date DESC,source,from_currency,to_currency LIMIT 2000`,
  [workspaceId,on,JSON.stringify(pairs),FRESH_DAYS+1,MANUAL,currencies])).rows;
}
// Rates for many currencies into one base currency on one day.
async function ratesOn(db,workspaceId,currencies,base,on){
  const list=[...new Set(currencies.map(c=>money.code(c)))].filter(c=>c!==base),found=new Map();
  if(!list.length)return found;
  const stored=await rows(db,workspaceId,list.map(c=>[c,base]),day(on));
  for(const c of list){const rate=pick(stored,c,base);if(rate)found.set(c,rate);}
  return found;
}
async function rateOn(db,workspaceId,from,to,on){return (await ratesOn(db,workspaceId,[from],money.code(to),on)).get(money.code(from))||null;}

// Rates to show now: stored rates, plus the provider's latest table when it
// is newer. A failed provider leaves stored rates in use. Nothing is written.
async function latest(db,workspaceId,currencies,base){
  const today=await require('../lib/business-time').today(db,workspaceId),wanted=[...new Set(currencies)].filter(c=>c!==base);
  const found=await ratesOn(db,workspaceId,wanted,base,today);
  let failed=null,live=null;
  if(wanted.length)try{live=await provider.latest();}catch(error){if(!(error instanceof ValidationError))throw error;failed=error.message;}
  if(live&&typeof live.date==='string'&&live.date<=today&&live.date>addDays(today,-FRESH_DAYS)){
    const quoted=Object.entries(live.rates||{}).map(([to,rate])=>({source:provider.source,rate_date:live.date,from_currency:live.base,
      to_currency:to,rate:String(rate),source_reference:live.reference||provider.link}));
    for(const c of wanted){
      const mine=found.get(c),fromLive=pick(quoted,c,base);
      if(fromLive&&(!mine||fromLive.date>mine.date))found.set(c,{...fromLive,live:true});
    }
  }
  return {today,rates:found,failed,liveDate:live?.date||null};
}

// Owner-entered rates. Removing one is the undo; receipts already booked keep the rate they used.
async function owner(db,ctx){
  if(!(await db.query("SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner'",[ctx.workspaceId,ctx.actorId])).rowCount)
    throw new AuthorizationError('Only the inventory owner can record exchange rates.');
}
async function books(db,workspaceId){
  const row=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[workspaceId])).rows[0];
  if(!row)throw new ValidationError('Confirm the accounting currency before recording exchange rates.');
  return money.code(row.base_currency);
}
async function saveManual(db,ctx,input){
  return db.transaction(async c=>{
    await owner(c,ctx);
    await require('../commercial/agent-plan').requireWorkspaceJob(c,ctx.workspaceId,40,'suggest');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm the rate direction and date.');
    const base=await books(c,ctx.workspaceId),from=money.code(input.currency);
    if(from===base)throw new ValidationError('Choose a currency other than your accounting currency.');
    const rate=reference.decimal(String(input.rate||'').trim()).text,today=await require('../lib/business-time').today(c,ctx.workspaceId);
    const date=day(String(input.rateDate||today));
    if(date>today)throw new ValidationError('A rate cannot be dated in the future.');
    if(date<addDays(today,-366))throw new ValidationError('Use a rate from the last year.');
    const note=String(input.note||'').trim();
    if(!note||note.length>200||/[\u0000-\u001f\u007f]/.test(note))throw new ValidationError('Say where this rate comes from, such as your bank, up to 200 plain characters.');
    const prior=(await c.query(`SELECT rate,source_reference,revision FROM ${table} WHERE workspace_id=$1 AND source=$2 AND rate_date=$3::date AND from_currency=$4 AND to_currency=$5 FOR UPDATE`,
      [ctx.workspaceId,MANUAL,date,from,base])).rows[0];
    if(prior&&prior.rate===rate&&prior.source_reference===note)return {currency:from,date,unchanged:true};
    await storage.reserve(scoped(c),ctx.workspaceId,'fx-manual:'+from+':'+date+':'+((prior?.revision||0)+1),1024,{finished:true});
    await c.query(`INSERT INTO ${table}(workspace_id,source,rate_date,from_currency,to_currency,rate,source_reference,recorded_by)
      VALUES($1,$2,$3::date,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,source,rate_date,from_currency,to_currency)
      DO UPDATE SET rate=EXCLUDED.rate,source_reference=EXCLUDED.source_reference,recorded_by=EXCLUDED.recorded_by,
        recorded_at=clock_timestamp(),revision=agent_fx_rates.revision+1`,[ctx.workspaceId,MANUAL,date,from,base,rate,note,ctx.actorId]);
    await audit.record(c,ctx,{action:'Exchange rate entered',reference:from+'/'+base+' '+date,
      before:prior?{rate:prior.rate,source:prior.source_reference}:{},after:{rate,source:note,date,currency:from,base}});
    return {currency:from,date,rate};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function removeManual(db,ctx,input){
  return db.transaction(async c=>{
    await owner(c,ctx);
    const base=await books(c,ctx.workspaceId),from=money.code(input.currency),date=day(String(input.rateDate||''));
    const removed=(await c.query(`DELETE FROM ${table} WHERE workspace_id=$1 AND source=$2 AND rate_date=$3::date AND from_currency=$4 AND to_currency=$5 RETURNING rate,source_reference`,
      [ctx.workspaceId,MANUAL,date,from,base])).rows[0];
    if(!removed)return {replayed:true};
    await audit.record(c,ctx,{action:'Exchange rate removed',reference:from+'/'+base+' '+date,before:{rate:removed.rate,source:removed.source_reference},after:{}});
    return {removed:true};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function manualRates(db,workspaceId,limit=30){
  return (await db.query(`SELECT r.rate_date::text,r.from_currency,r.to_currency,r.rate,r.source_reference,r.recorded_at,u.name recorded_by_name
    FROM ${table} r LEFT JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.recorded_by
    WHERE r.workspace_id=$1 AND r.source=$2 ORDER BY r.rate_date DESC,r.from_currency LIMIT $3`,[workspaceId,MANUAL,limit])).rows;
}

module.exports={MANUAL,FRESH_DAYS,table,current,use,sourceLabel,ratio,decimal,display,convert,change,store,refresh,
  ratesOn,rateOn,latest,saveManual,removeManual,manualRates,addDays};
