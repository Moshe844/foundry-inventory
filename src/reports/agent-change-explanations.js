'use strict';
// Job 157: explains changes ("why did margin drop in March?").
//
// For sales, gross profit, cost of goods or stock value, one month is compared
// with an earlier one, for the whole business or one item, channel or
// customer. The change is broken into its drivers, each worked out from posted
// journal entries and stock records, and each linked to those records:
//   - volume, mix, selling price and cost per unit, from posted sales by item;
//   - discounts, from the discount recorded on each posted sale;
//   - customer returns and refunds;
//   - other postings that are not item sales (charges, hand entries, corrections).
// These add up exactly to the change. Below gross profit it adds what was
// written off or lost in counts (stock records) and channel fees (job 85 fee
// terms or checked imports). Stockouts are shown as the part of a volume drop
// that happened while the item was out of stock. Cost changes link to the
// receipts, landed costs and supplier price increases (job 91) behind them.
// Stock value is explained by the month-end roll-forward of job 158.
//
// Growth, Pro and Custom answer on their own, on the page and in Ask. After
// each month ends the worker also checks the month and flags big changes
// (20% or more) in Needs you with their causes. Nothing here changes a record.
const {ValidationError,InvariantError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const time=require('../lib/business-time');
const reports=require('./agent-report-runs');

const JOB=157,ACTION='report.change_digest',KIND='reports.change-digest.v1',href='/autopilot/reviews/margin-change';
const MEASURES=Object.freeze({revenue:'Sales',margin:'Gross profit',cogs:'Cost of goods sold',stock:'Stock value'});
const ALIASES={sales:'revenue',revenue:'revenue',margin:'margin',gross_profit:'margin',profit:'margin',cogs:'cogs',cost_of_goods:'cogs',cost:'cogs',stock:'stock',stock_value:'stock',inventory:'stock'};
const DIMENSIONS=Object.freeze({item:'Item',channel:'Channel',customer:'Customer',location:'Location'});
const SALE_TYPES=['sale_fulfillment','manual_customer_invoice','customer_invoice','consignment_sale'];
const RETURN_TYPES=['sales_refund','customer_return_credit','customer_return_receipt','customer_return_credit_payout'];
const BIG_CHANGE_PERCENT=20,DIRECT='Direct',SCALE=1000000n,LIMIT=200000;

const fmt=(minor,currency)=>money.format(Number(minor),currency);
const signed=(minor,currency)=>(minor>0n?'+':'')+fmt(minor,currency);
const abs=v=>v<0n?-v:v;
// Half away from zero.
function divide(n,d){if(d===0n)return 0n;const q=n/d,r=n%d;return q+(2n*abs(r)>=abs(d)?((n<0n)!==(d<0n)?-1n:1n):0n);}
function units(value){const text=String(value??'');if(!/^-?\d+(\.\d+)?$/.test(text))return null;const [whole,fraction='']=text.replace('-','').split('.');
  const scaled=BigInt(whole)*SCALE+BigInt((fraction+'000000').slice(0,6));return text.startsWith('-')?-scaled:scaled;}
const unitText=q=>{const s=(Number(q)/1e6).toFixed(6).replace(/\.?0+$/,'');return s;};
const percent=(change,base)=>base===0n?null:Number(divide(change*10000n,abs(base)))/100;

// ---- What to explain ------------------------------------------------------

// Ask passes one line of plain words, such as "gross profit March vs
// January customer Acme" or "2026-03 by channel". Read it the same way every
// time: months (YYYY-MM or a month name, with an optional year), what changed,
// "by" a dimension, and a named item, customer, channel or warehouse.
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const MONTH_WORD='(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)';
const ONLY_MONTH=new RegExp('^(?:\\d{4}-\\d{2}|'+MONTH_WORD+'\\.?(?:\\s+\\d{4})?)\\s*[?.!]*$','i');
const MONTH_TOKENS=new RegExp('\\b(\\d{4}-(?:0[1-9]|1[0-2]))\\b|\\b'+MONTH_WORD+'\\b\\.?(?:\\s+(\\d{4})\\b)?','gi');
const WORDS=[[/\bgross profit\b|\bprofit\b|\bmargins?\b/i,'margin'],[/\bcost(?:s| of goods(?: sold)?)?\b|\bcogs\b/i,'cogs'],
  [/\bstock value\b|\binventory value\b|\bstock\b|\binventory\b/i,'stock'],[/\bsales\b|\brevenue\b|\bturnover\b/i,'revenue']];
const DIM_WORDS={item:'item',sku:'item',product:'item',customer:'customer',channel:'channel',location:'location',warehouse:'location'};
function parseFilter(today,text){
  let rest=String(text||'').trim();const out={};
  if(!rest)return out;
  const by=/\bby\s+(item|sku|product|customer|channel|location|warehouse)s?\b/i.exec(rest);
  if(by){out.by=DIM_WORDS[by[1].toLowerCase()];rest=rest.slice(0,by.index)+' '+rest.slice(by.index+by[0].length);}
  const named=/\b(item|sku|product|customer|channel|location|warehouse)\s*[:=]?\s+(.+)$/i.exec(rest);
  if(named){out.by=DIM_WORDS[named[1].toLowerCase()];out.subject=named[2].trim().replace(/[?.!]+$/,'');rest=rest.slice(0,named.index);}
  else{const forName=/\bfor\s+(.+)$/i.exec(rest);
    if(forName&&!ONLY_MONTH.test(forName[1].trim())){out.subject=forName[1].trim().replace(/[?.!]+$/,'');out.guess=!out.by;rest=rest.slice(0,forName.index);}}
  const last=reports.lastCompleted(today),found=[];
  for(const m of rest.matchAll(MONTH_TOKENS)){
    if(m[1]){found.push(m[1]);continue;}
    const number=String(MONTHS.indexOf(m[2].toLowerCase().slice(0,3))+1).padStart(2,'0');
    if(m[3]){found.push(m[3]+'-'+number);continue;}
    let year=Number(last.slice(0,4));if(year+'-'+number>last)year--;found.push(year+'-'+number);
  }
  if(found.length){const sorted=[...new Set(found)].sort();out.month=sorted[sorted.length-1];if(sorted.length>1)out.compare=sorted[sorted.length-2];}
  for(const [pattern,measure] of WORDS)if(pattern.test(rest)){out.measure=measure;break;}
  return out;
}

function normalize(today,input={}){
  const measure=ALIASES[String(input.measure||input.changeMeasure||'margin').trim().toLowerCase()];
  if(!measure)throw new ValidationError('Choose what changed: sales, gross profit, cost of goods or stock value.');
  const month=reports.completedMonth(today,input.month);
  const compare=String(input.compare||'').trim()?reports.completedMonth(today,input.compare,'month to compare with'):reports.addMonths(month,-1);
  if(compare>=month)throw new ValidationError('Compare with an earlier month than '+month+'.');
  let by=String(input.by||'').trim().toLowerCase()||(measure==='stock'?'location':'item');
  if(!DIMENSIONS[by])throw new ValidationError('Break it down by item, channel, customer or location.');
  if(measure==='stock'&&!['item','location'].includes(by))throw new ValidationError('Stock value can be broken down by item or location.');
  if(measure!=='stock'&&by==='location')throw new ValidationError('Sales, gross profit and cost of goods can be broken down by item, channel or customer.');
  const subject=String(input.subject||'').trim();
  if(subject.length>150||/[\u0000-\u001f]/.test(subject))throw new ValidationError('Name one item, channel, customer or location on one line, up to 150 characters.');
  return {measure,month,compare,by,subject};
}

// ---- Posted sales facts ---------------------------------------------------

// One row per posted entry and item with sales or cost of goods in either month.
async function salesFacts(db,workspaceId,cur,prev){
  const rows=(await db.query(`WITH base AS (
      SELECT CASE WHEN e.posting_date<=$3 THEN 'previous' ELSE 'current' END AS period,e.id AS entry_id,e.source_type,e.source_record_type,e.source_record_id,
        e.reversal_of_entry_id IS NOT NULL AS reversal,e.metadata,e.description,l.currency,l.sku_id,l.customer_id,a.account_type,l.credit_minor,l.debit_minor
      FROM accounting_journal_entries e JOIN accounting_journal_lines l ON l.workspace_id=e.workspace_id AND l.entry_id=e.id
      JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
      WHERE e.workspace_id=$1 AND e.status='POSTED' AND (e.posting_date BETWEEN $2 AND $3 OR e.posting_date BETWEEN $4 AND $5)
        AND a.account_type IN ('INCOME','COGS'))
    SELECT b.period,b.entry_id,b.source_type,b.source_record_type,b.source_record_id,b.reversal,b.currency,b.sku_id,
      max(b.customer_id) AS customer_id,max(b.description) AS description,
      sum(CASE WHEN b.account_type='INCOME' THEN b.credit_minor-b.debit_minor ELSE 0 END)::text AS income,
      sum(CASE WHEN b.account_type='COGS' THEN b.debit_minor-b.credit_minor ELSE 0 END)::text AS cost,
      max(b.metadata::jsonb->>'quantity') AS meta_quantity,max(b.metadata::jsonb->>'grossMinor') AS gross,max(b.metadata::jsonb->>'discountMinor') AS discount,
      max(b.metadata::jsonb->>'salesOrderLineId') AS order_line,
      (SELECT (-sum(m.quantity_delta))::text FROM accounting_inventory_cost_movements m WHERE m.workspace_id=$1 AND m.journal_entry_id=b.entry_id AND m.sku_id=b.sku_id) AS moved,
      CASE WHEN b.source_record_type='sales_order' THEN b.source_record_id
        WHEN b.source_record_type='customer_return' THEN (SELECT r.sales_order_id FROM customer_returns r WHERE r.workspace_id=$1 AND r.id=b.source_record_id)
        WHEN b.source_record_type='customer_invoice' THEN (SELECT i.sales_order_id FROM accounting_customer_invoices i WHERE i.workspace_id=$1 AND i.id=b.source_record_id) END AS order_id
    FROM base b GROUP BY b.period,b.entry_id,b.source_type,b.source_record_type,b.source_record_id,b.reversal,b.currency,b.sku_id
    ORDER BY b.entry_id,b.sku_id LIMIT ${LIMIT+1}`,[workspaceId,prev.start,prev.end,cur.start,cur.end])).rows;
  if(rows.length>LIMIT)throw new ValidationError('These two months have more than '+LIMIT.toLocaleString('en-US')+' posted sales lines. Explain one item, channel or customer at a time.');
  return rows.map(r=>{
    const kind=r.reversal?'other':r.source_record_type==='customer_return'||RETURN_TYPES.includes(r.source_type)?'return':SALE_TYPES.includes(r.source_type)?'sale':'other';
    const income=BigInt(r.income),cost=BigInt(r.cost);
    // Units: the quantity the sale recorded, else the stock that left with it.
    const q=kind!=='sale'?null:r.source_type==='sale_fulfillment'&&r.sku_id?units(r.meta_quantity):r.sku_id?units(r.moved):null;
    const gross=kind==='sale'&&r.source_type==='sale_fulfillment'&&r.gross!=null?BigInt(r.gross):income;
    const discount=kind==='sale'&&r.source_type==='sale_fulfillment'&&r.discount!=null?BigInt(r.discount):0n;
    // A sale entry's income line carries the item; its tax and receivable lines are not income.
    return {period:r.period,entryId:r.entry_id,sourceType:r.source_type,recordType:r.source_record_type,recordId:r.source_record_id,currency:r.currency,
      skuId:r.sku_id||null,customerId:r.customer_id||null,orderId:r.order_id||null,description:r.description,kind,income,cost,
      units:q!==null&&q>0n?q:null,gross:income===0n&&kind==='sale'?0n:gross,discount:income===0n?0n:discount};
  });
}

// Names, channels and links for the facts.
async function describe(db,workspaceId,facts){
  const skuIds=[...new Set(facts.map(f=>f.skuId).filter(Boolean))],customerIds=[...new Set(facts.map(f=>f.customerId).filter(Boolean))];
  const orderIds=[...new Set(facts.map(f=>f.orderId).filter(Boolean))];
  const skus=skuIds.length?(await db.query(`SELECT s.id,s.code,i.id AS item_id,i.name FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND s.id=ANY($2::text[])`,[workspaceId,skuIds])).rows:[];
  const customers=customerIds.length?(await db.query('SELECT id,name FROM customers WHERE workspace_id=$1 AND id=ANY($2::text[])',[workspaceId,customerIds])).rows:[];
  const mapped=await require('./agent-net-margin').connectedChannels(db,workspaceId,orderIds);
  const imported=orderIds.length?(await db.query('SELECT sales_order_id,channel FROM stockchief_runtime.agent_order_cost_facts WHERE workspace_id=$1 AND sales_order_id=ANY($2::text[])',[workspaceId,orderIds])).rows:[];
  const importChannel=new Map(imported.map(r=>[r.sales_order_id,r.channel]));
  const numbers=new Map((orderIds.length?(await db.query('SELECT id,order_number FROM sales_orders WHERE workspace_id=$1 AND id=ANY($2::text[])',[workspaceId,orderIds])).rows:[]).map(r=>[r.id,r.order_number]));
  const items=new Map(skus.map(s=>[s.id,{label:s.code+' · '+s.name,code:s.code,href:'/inventory/'+s.item_id}]));
  const people=new Map(customers.map(c=>[c.id,{label:c.name,href:'/sales/customers/'+c.id}]));
  const channel=orderId=>{if(!orderId)return null;const links=mapped.get(orderId)||[];return links.length?links.map(l=>l.name).join(' / '):importChannel.get(orderId)||DIRECT;};
  for(const f of facts){
    f.item=f.skuId?items.get(f.skuId)||{label:'Removed item',href:null}:null;
    f.customer=f.customerId?people.get(f.customerId)||{label:'Removed customer',href:null}:null;
    f.channel=channel(f.orderId);f.orderNumber=f.orderId?numbers.get(f.orderId)||null:null;
  }
  return facts;
}
function keyOf(f,by){
  if(by==='item')return f.skuId?{key:f.skuId,label:f.item.label,href:f.item.href}:{key:'',label:'Not tied to an item',href:null};
  if(by==='customer')return f.customerId?{key:f.customerId,label:f.customer.label,href:f.customer.href}:{key:'',label:'Not tied to a customer',href:null};
  return f.channel?{key:f.channel.toLowerCase(),label:f.channel,href:null}:{key:'',label:'Not tied to a sales channel',href:null};
}
function matches(f,by,subject){
  if(!subject)return true;const s=subject.toLowerCase();
  if(by==='item')return Boolean(f.item&&(f.item.code.toLowerCase()===s||f.item.label.toLowerCase()===s));
  if(by==='customer')return Boolean(f.customer&&f.customer.label.toLowerCase()===s);
  return Boolean(f.channel&&f.channel.toLowerCase()===s);
}

// ---- The breakdown --------------------------------------------------------

function totals(facts){
  const t={G:0n,D:0n,CH:0n,C:0n,RI:0n,RC:0n,OI:0n,OC:0n,UI:0n,UC:0n};
  for(const f of facts){
    if(f.kind==='sale'&&f.units){t.G+=f.gross;t.D+=f.discount;t.CH+=f.income-(f.gross-f.discount);t.C+=f.cost;}
    else if(f.kind==='sale'){t.UI+=f.income;t.UC+=f.cost;}
    else if(f.kind==='return'){t.RI+=f.income;t.RC+=f.cost;}
    else{t.OI+=f.income;t.OC+=f.cost;}
  }
  t.revenue=t.G-t.D+t.CH+t.RI+t.OI+t.UI;t.cogs=t.C+t.RC+t.OC+t.UC;t.margin=t.revenue-t.cogs;
  return t;
}
function byItem(facts){
  const items=new Map();
  for(const f of facts){
    if(f.kind!=='sale'||!f.units)continue;
    if(!items.has(f.skuId))items.set(f.skuId,{skuId:f.skuId,item:f.item,previous:{q:0n,G:0n,C:0n,D:0n},current:{q:0n,G:0n,C:0n,D:0n}});
    const p=items.get(f.skuId)[f.period];p.q+=f.units;p.G+=f.gross;p.C+=f.cost;p.D+=f.discount;
  }
  return [...items.values()];
}
// Volume, mix, price and cost per unit for the item sales of one measure.
// Value per unit is the price before discounts (sales), the cost (cost of
// goods) or the price less the cost (gross profit). Mix takes the rest, so the
// four always add up to the change in item sales.
function itemDrivers(items,measure){
  const value=(p)=>measure==='revenue'?p.G:measure==='cogs'?p.C:p.G-p.C;
  let Q0=0n,Q1=0n,V0=0n,V1=0n,price=0n,cost=0n;const lines=[];
  for(const it of items){
    const a=it.previous,b=it.current;Q0+=a.q;Q1+=b.q;V0+=value(a);V1+=value(b);
    const line={...it,price:0n,cost:0n};
    if(a.q>0n&&b.q>0n){
      line.price=b.G-divide(b.q*a.G,a.q);line.cost=b.C-divide(b.q*a.C,a.q);
      if(measure!=='cogs')price+=line.price;if(measure!=='revenue')cost+=line.cost;
    }
    lines.push(line);
  }
  const volume=Q0>0n?divide((Q1-Q0)*V0,Q0):V1-V0;
  const costEffect=measure==='margin'?-cost:cost;
  const mix=V1-V0-volume-(measure==='cogs'?0n:price)-costEffect;
  return {volume,mix,price:measure==='cogs'?0n:price,cost:costEffect,lines,Q0,Q1,V0,V1};
}

function decompose(facts,measure){
  const prev=totals(facts.filter(f=>f.period==='previous')),cur=totals(facts.filter(f=>f.period==='current'));
  const items=itemDrivers(byItem(facts),measure);
  const d=(k)=>cur[k]-prev[k];
  const drivers=[['volume',items.volume],['mix',items.mix]];
  if(measure!=='cogs')drivers.push(['price',items.price],['discounts',-d('D')]);
  if(measure!=='revenue')drivers.push(['cost',items.cost]);
  drivers.push(['returns',measure==='revenue'?d('RI'):measure==='cogs'?d('RC'):d('RI')-d('RC')]);
  drivers.push(['other',measure==='revenue'?d('CH')+d('OI')+d('UI'):measure==='cogs'?d('OC')+d('UC'):d('CH')+d('OI')+d('UI')-d('OC')-d('UC')]);
  const change=cur[measure]-prev[measure];
  if(drivers.reduce((n,[,v])=>n+v,0n)!==change)throw new InvariantError('The change explanation does not add up.');
  return {previous:prev[measure],current:cur[measure],change,drivers:new Map(drivers),items,prevTotals:prev,curTotals:cur};
}

// ---- Evidence for each driver ---------------------------------------------

const LABELS={volume:'More or fewer units sold',mix:'A different mix of items',price:'Selling prices per unit',discounts:'Discounts given',
  cost:'Cost per unit',returns:'Customer returns and refunds',other:'Other postings, not item sales',
  receipts:'Stock received',adjustments:'Counts and adjustments',writeoffs:'Stock written off',transfers:'Transfers between locations',
  production:'Production and other',booksOnly:'Postings only in your books',fees:'Channel fees',counts:'Count differences'};
function itemLine(line,currency,text){return {label:line.item.label,href:line.item.href,text};}
function perUnit(total,q){return q>0n?divide(total*SCALE,q):0n;}

async function evidence(db,workspaceId,facts,result,ctx2){
  const {currency,measure,cur,prev,zone}=ctx2,lines=result.items.lines,out={};
  const top=(list,score,n=5)=>list.filter(x=>score(x)!==0n).sort((a,b)=>abs(score(b))>abs(score(a))?1:abs(score(b))<abs(score(a))?-1:0).slice(0,n);
  out.volume=top(lines,l=>l.current.q-l.previous.q).map(l=>itemLine(l,currency,unitText(l.previous.q)+' → '+unitText(l.current.q)+' units'));
  out.mix=top(lines.filter(l=>l.previous.q===0n||l.current.q===0n),l=>l.current.q-l.previous.q).map(l=>itemLine(l,currency,l.previous.q===0n?'Sold only in '+cur.name:'Not sold in '+cur.name));
  out.price=top(lines,l=>l.price).map(l=>itemLine(l,currency,fmt(perUnit(l.previous.G,l.previous.q),currency)+' → '+fmt(perUnit(l.current.G,l.current.q),currency)+' a unit before discounts ('+signed(l.price,currency)+')'));
  const costly=top(lines,l=>l.cost);
  out.cost=costly.map(l=>itemLine(l,currency,fmt(perUnit(l.previous.C,l.previous.q),currency)+' → '+fmt(perUnit(l.current.C,l.current.q),currency)+' a unit ('+signed(l.cost,currency)+' in cost)'));
  // What moved the cost: receipts at their unit cost, landed costs, and supplier price increases (job 91).
  if(costly.length&&measure!=='revenue'){
    const skuIds=costly.filter(l=>l.cost>0n).map(l=>l.skuId);
    if(skuIds.length){
      const receipts=(await db.query(`SELECT m.sku_id,e.id,e.entry_number,e.posting_date,e.source_type,m.quantity_delta::text AS q,m.cost_delta_minor::text AS amount
        FROM accounting_inventory_cost_movements m JOIN accounting_journal_entries e ON e.workspace_id=m.workspace_id AND e.id=m.journal_entry_id AND e.status='POSTED'
        WHERE m.workspace_id=$1 AND m.sku_id=ANY($2::text[]) AND m.quantity_delta>0 AND e.source_type='purchase_receipt' AND e.posting_date BETWEEN $3 AND $4
        ORDER BY e.posting_date DESC,e.entry_number DESC LIMIT 20`,[workspaceId,skuIds,prev.start,cur.end])).rows;
      const landed=(await db.query(`SELECT l.sku_id,e.id,e.entry_number,e.posting_date,sum(l.debit_minor-l.credit_minor)::text AS amount
        FROM accounting_journal_entries e JOIN accounting_journal_lines l ON l.workspace_id=e.workspace_id AND l.entry_id=e.id
        JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id AND a.system_key='INVENTORY_ASSET'
        WHERE e.workspace_id=$1 AND e.status='POSTED' AND l.sku_id=ANY($2::text[]) AND e.source_type IN ('landed_cost_document','landed_cost_allocation') AND e.posting_date BETWEEN $3 AND $4
        GROUP BY l.sku_id,e.id,e.entry_number,e.posting_date ORDER BY e.posting_date DESC LIMIT 20`,[workspaceId,skuIds,prev.start,cur.end])).rows;
      out.costSources=costly.filter(l=>l.cost>0n).map(l=>({label:l.item.label,href:l.item.href,
        records:[...receipts.filter(r=>r.sku_id===l.skuId).slice(0,3).map(r=>({label:'Received '+r.posting_date+' at '+fmt(divide(BigInt(r.amount)*SCALE,units(r.q)),currency)+' a unit',href:'/accounting/entries/'+r.id})),
          ...landed.filter(r=>r.sku_id===l.skuId).slice(0,3).map(r=>({label:'Landed cost '+r.posting_date+' '+signed(BigInt(r.amount),currency),href:'/accounting/entries/'+r.id})),
          {label:'Supplier price increases for '+l.item.code,href:'/autopilot/reviews/supplier-price-increases?'+new URLSearchParams({filter:l.item.code})}]}));
    }
  }
  const current=facts.filter(f=>f.period==='current');
  out.discounts=top(current.filter(f=>f.kind==='sale'&&f.discount>0n),f=>f.discount).map(f=>({label:(f.orderNumber?'Order '+f.orderNumber+' · ':'')+(f.item?.label||'Sale'),text:fmt(f.discount,currency)+' off',
    href:f.orderId?'/sales/orders/'+f.orderId:'/accounting/entries/'+f.entryId}));
  out.returns=top(current.filter(f=>f.kind==='return'),f=>f.income-f.cost).map(f=>({label:(f.item?.label||'Return')+(f.customer?' · '+f.customer.label:''),
    text:'Sales '+signed(f.income,currency)+(f.cost?', cost '+signed(-f.cost,currency):''),href:f.recordType==='customer_return'?'/returns/'+f.recordId:'/accounting/entries/'+f.entryId}));
  out.other=top(facts.filter(f=>f.kind==='other'||(f.kind==='sale'&&!f.units)),f=>f.income-f.cost).map(f=>({label:(f.period==='current'?cur.name:prev.name)+' · '+(f.description||f.sourceType.replaceAll('_',' ')),
    text:'Sales '+signed(f.income,currency)+', cost '+signed(f.cost,currency),href:'/accounting/entries/'+f.entryId}));
  return out;
}

// Units probably missed while an item was out of stock everywhere: the days in
// the month it ended with nothing on hand, at its sales rate the month before.
async function stockouts(db,workspaceId,lines,{cur,prev,zone,currency}){
  const falling=lines.filter(l=>l.previous.q>0n&&l.current.q<l.previous.q).sort((a,b)=>Number(b.previous.q-b.current.q-(a.previous.q-a.current.q))).slice(0,25);
  if(!falling.length)return [];
  const startAt=time.dayBoundary(cur.start,zone),endAt=time.dayBoundary(cur.end,zone,{nextDay:true}),ids=falling.map(l=>l.skuId);
  const opening=new Map((await db.query(`SELECT sku_id,sum(quantity_delta)::text AS q FROM movements WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND occurred_at::timestamptz<$3::timestamptz GROUP BY sku_id`,
    [workspaceId,ids,startAt])).rows.map(r=>[r.sku_id,units(r.q)||0n]));
  const moves=(await db.query(`SELECT sku_id,occurred_at,quantity_delta::text AS q FROM movements WHERE workspace_id=$1 AND sku_id=ANY($2::text[])
    AND occurred_at::timestamptz>=$3::timestamptz AND occurred_at::timestamptz<$4::timestamptz ORDER BY sku_id,occurred_at::timestamptz,seq LIMIT 100001`,[workspaceId,ids,startAt,endAt])).rows;
  const days=[];for(let d=cur.start;d<=cur.end;d=new Date(Date.parse(d)+86400000).toISOString().slice(0,10))days.push(d);
  const prevDays=BigInt(Number(prev.end.slice(8,10)));const out=[];
  for(const l of falling){
    let balance=opening.get(l.skuId)||0n;const byDay=new Map();
    for(const m of moves.filter(x=>x.sku_id===l.skuId)){const day=time.parts(new Date(m.occurred_at),zone).day;balance+=units(m.q)||0n;byDay.set(day,balance);}
    balance=opening.get(l.skuId)||0n;let out_days=0;
    for(const day of days){if(byDay.has(day))balance=byDay.get(day);if(balance<=0n)out_days++;}
    if(!out_days)continue;
    const missed=[l.previous.q-l.current.q,divide(l.previous.q*BigInt(out_days),prevDays)].reduce((a,b)=>a<b?a:b);
    if(missed<=0n)continue;
    out.push({label:l.item.label,href:l.item.href,days:out_days,units:missed,sales:divide(missed*l.previous.G,l.previous.q),margin:divide(missed*(l.previous.G-l.previous.C),l.previous.q),
      text:'Out of stock '+out_days+' day'+(out_days===1?'':'s')+' in '+cur.name+'. About '+unitText(missed)+' units ('+fmt(divide(missed*l.previous.G,l.previous.q),currency)+' of sales) were probably missed.'});
  }
  return out;
}

// Channel fees per period from the owner's fee terms or checked imports (job 85).
async function channelFees(db,workspaceId,facts,{cur,prev}){
  const orders=new Map();
  for(const f of facts.filter(f=>f.kind==='sale'&&f.orderId&&f.sourceType==='sale_fulfillment')){
    if(!orders.has(f.orderId))orders.set(f.orderId,{id:f.orderId,channel:f.channel||DIRECT,currency:f.currency,previous:0n,current:0n});
    orders.get(f.orderId)[f.period]+=f.income>0n?f.income:0n;
  }
  const result={previous:0n,current:0n,missing:[]};if(!orders.size)return result;
  const ids=[...orders.keys()];
  const first=new Map((await db.query(`SELECT source_record_id,min(posting_date) AS first FROM accounting_journal_entries WHERE workspace_id=$1 AND status='POSTED'
    AND source_type='sale_fulfillment' AND source_record_type='sales_order' AND source_record_id=ANY($2::text[]) GROUP BY source_record_id`,[workspaceId,ids])).rows.map(r=>[r.source_record_id,r.first]));
  const checked=new Map((await db.query('SELECT sales_order_id,currency,fees_minor::text FROM stockchief_runtime.agent_order_cost_facts WHERE workspace_id=$1 AND sales_order_id=ANY($2::text[])',[workspaceId,ids])).rows.map(r=>[r.sales_order_id,r]));
  const terms=new Map((await db.query(`SELECT channel_key,currency,percent_bps,fixed_minor::text FROM stockchief_runtime.agent_channel_fee_rules WHERE workspace_id=$1 AND enabled`,[workspaceId])).rows.map(r=>[r.channel_key+'|'+r.currency,r]));
  const firstIn=(o,span)=>{const d=first.get(o.id);return d>=span.start&&d<=span.end;};
  for(const o of orders.values()){
    const fact=checked.get(o.id);
    if(fact&&fact.currency===o.currency){for(const [period,span] of [['previous',prev],['current',cur]])if(firstIn(o,span))result[period]+=BigInt(fact.fees_minor);continue;}
    const rule=terms.get(o.channel.toLowerCase()+'|'+o.currency);
    if(!rule){if(!result.missing.includes(o.channel))result.missing.push(o.channel);continue;}
    for(const [period,span] of [['previous',prev],['current',cur]])
      result[period]+=divide(o[period]*BigInt(rule.percent_bps),10000n)+(firstIn(o,span)?BigInt(rule.fixed_minor):0n);
  }
  return result;
}

// ---- Explaining one change ------------------------------------------------

async function explainFor(db,workspaceId,input){
  const today=await time.today(db,workspaceId);
  // Plain words from Ask or a shared link: read them, and try each kind of record for a bare name.
  if(input.filter&&!input.measure&&!input.month&&!input.by&&!input.subject){
    const parsed=parseFilter(today,input.filter);
    if(!parsed.guess)return explainFor(db,workspaceId,parsed);
    for(const by of parsed.measure==='stock'?['item','location']:['item','customer','channel']){
      try{return await explainFor(db,workspaceId,{...parsed,guess:undefined,by});}
      catch(error){if(!(error instanceof ValidationError)||!/^No (?:item|customer|channel|warehouse)/.test(error.message))throw error;}
    }
    throw new ValidationError('No item, customer, channel or warehouse named '+parsed.subject+' has records in these months.');
  }
  const q=normalize(today,input);
  const cur=reports.span(q.month),prev=reports.span(q.compare),zone=(await time.forWorkspace(db,workspaceId)).timeZone;
  const settings=await reports.accounting(db,workspaceId);
  const base={...q,name:MEASURES[q.measure],current:cur,previous:prev,currencies:[]};
  if(!Number(settings?.enabled)||!settings.accounting_start_date)return {...base,problem:'Turn on accounting so StockChief can explain changes from your posted records.'};
  if(settings.accounting_start_date>prev.start)return {...base,problem:'Your accounting records start on '+settings.accounting_start_date+'. Compare months from then on.'};
  if(q.measure==='stock')return stockChange(db,workspaceId,base,{cur,prev,zone});
  let facts=await describe(db,workspaceId,await salesFacts(db,workspaceId,cur,prev));
  if(q.subject){
    facts=facts.filter(f=>matches(f,q.by,q.subject));
    if(!facts.length)throw new ValidationError('No '+DIMENSIONS[q.by].toLowerCase()+' named '+q.subject+' has posted sales or costs in '+q.compare+' or '+q.month+'.');
  }
  for(const currency of [...new Set(facts.map(f=>f.currency))].sort()){
    const own=facts.filter(f=>f.currency===currency),result=decompose(own,q.measure);
    const proof=await evidence(db,workspaceId,own,result,{currency,measure:q.measure,cur,prev,zone});
    const drivers=[...result.drivers].map(([key,amount])=>({key,label:LABELS[key],amount,records:proof[key]||[],...(key==='cost'&&proof.costSources?{sources:proof.costSources}:{})}));
    const missed=q.measure==='cogs'?[]:await stockouts(db,workspaceId,result.items.lines,{cur,prev,zone,currency});
    const below=q.measure==='margin'?await belowGrossProfit(db,workspaceId,own,q,{cur,prev,zone,currency,change:result.change}):null;
    const groups=new Map();
    for(const f of own){const g=keyOf(f,q.by);if(!groups.has(g.key))groups.set(g.key,{...g,facts:[]});groups.get(g.key).facts.push(f);}
    const breakdown=[...groups.values()].map(g=>{const r=decompose(g.facts,q.measure),lead=[...r.drivers].filter(([,v])=>v!==0n).sort((a,b)=>abs(b[1])>abs(a[1])?1:-1)[0];
      return {key:g.key,label:g.label,href:g.href,previous:r.previous,current:r.current,change:r.change,lead:lead?{label:LABELS[lead[0]],amount:lead[1]}:null};})
      .filter(g=>g.previous||g.current).sort((a,b)=>abs(b.change)>abs(a.change)?1:abs(b.change)<abs(a.change)?-1:a.label.localeCompare(b.label));
    base.currencies.push({currency,previous:result.previous,current:result.current,change:result.change,percent:percent(result.change,result.previous),
      drivers,stockouts:missed,below,breakdown:breakdown.slice(0,50),breakdownMore:breakdown.length>50,sentence:sentence(q,result.previous,result.current,result.change,drivers,currency,cur,prev)});
  }
  if(!base.currencies.length)base.empty='No posted sales or cost of goods in '+prev.name+' or '+cur.name+'.';
  return base;
}

// Write-offs and count differences (stock records), and channel fees, which
// sit below gross profit. Missing fee terms leave the fee change unknown.
async function belowGrossProfit(db,workspaceId,facts,q,{cur,prev,zone,currency,change}){
  const lines=[],notes=[];let known=true;
  if(q.subject&&q.by!=='item')notes.push('Write-offs and count differences belong to items, not to a '+q.by+', so they are not shown here.');
  else{
    const month=require('./agent-month-end-stock'),skuIds=q.subject?[...new Set(facts.map(f=>f.skuId).filter(Boolean))]:null;
    const read=async span=>{const r=await month.records(db,workspaceId,{start:span.start,end:span.end,zone,by:'location',skuIds});
      return r.positions.reduce((t,p)=>({writeoffs:t.writeoffs+p.writeoffs,adjustments:t.adjustments+p.adjustments}),{writeoffs:0n,adjustments:0n});};
    const before=await read(prev),after=await read(cur),books=await reports.accounting(db,workspaceId);
    if(books.base_currency===currency){
      lines.push({key:'writeoffs',label:LABELS.writeoffs,previous:before.writeoffs,current:after.writeoffs,amount:after.writeoffs-before.writeoffs,href:month.href+'?'+new URLSearchParams({month:q.month})});
      lines.push({key:'counts',label:LABELS.counts,previous:before.adjustments,current:after.adjustments,amount:after.adjustments-before.adjustments,href:month.href+'?'+new URLSearchParams({month:q.month})});
    }
  }
  if(q.subject&&q.by==='item')notes.push('Channel fees are charged per order, so they are not split by item.');
  else{
    const fees=await channelFees(db,workspaceId,facts.filter(f=>f.currency===currency),{cur,prev});
    if(fees.missing.length){known=false;notes.push('No fee terms or checked costs for '+fees.missing.join(', ')+' in '+currency+'. Fees are left out, not counted as zero.');}
    else lines.push({key:'fees',label:LABELS.fees,previous:-fees.previous,current:-fees.current,amount:fees.previous-fees.current,href:'/autopilot/net-contribution#fee-terms'});
  }
  const total=lines.reduce((n,l)=>n+l.amount,change);
  return {lines,notes,afterChange:known?total:null};
}

async function stockChange(db,workspaceId,base,{cur,prev,zone}){
  const month=require('./agent-month-end-stock');
  const start=new Date(Date.parse(prev.end)+86400000).toISOString().slice(0,10);
  const report=await month.compute(db,workspaceId,{start,end:cur.end});
  if(report.problem)return {...base,problem:report.problem};
  let skuIds=null,location=null;
  if(base.subject&&base.by==='item'){
    const sku=(await db.query('SELECT id FROM skus WHERE workspace_id=$1 AND lower(code)=lower($2)',[workspaceId,base.subject])).rows[0];
    if(!sku)throw new ValidationError('No item with the code '+base.subject+'.');skuIds=[sku.id];
  }
  if(base.subject&&base.by==='location'){
    location=(await db.query('SELECT id FROM locations WHERE workspace_id=$1 AND parent_location_id IS NULL AND lower(name)=lower($2)',[workspaceId,base.subject])).rows[0];
    if(!location)throw new ValidationError('No warehouse or store named '+base.subject+'.');
  }
  const detail=await month.records(db,workspaceId,{start,end:cur.end,zone,by:base.by==='item'?'sku':'location',skuIds});
  const names=base.by==='item'?new Map((await db.query(`SELECT s.id,s.code||' · '||i.name AS label,i.id AS item_id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1`,[workspaceId])).rows.map(r=>[r.id,{label:r.label,href:'/inventory/'+r.item_id}]))
    :new Map((await db.query('SELECT id,name FROM locations WHERE workspace_id=$1',[workspaceId])).rows.map(r=>[r.id,{label:r.name,href:null}]));
  const keys=['receipts','cogs','adjustments','writeoffs','transfers','other'];
  for(const c of report.currencies){
    const scoped=detail.positions.filter(p=>c.currency===report.base&&(!location||p.key===location.id));
    const sum=k=>scoped.reduce((n,p)=>n+p[k],0n);
    const whole=!skuIds&&!location;
    const previous=whole?c.books.opening:sum('opening'),current=whole?c.books.closing:sum('closing');
    const drivers=keys.map(k=>({key:k,label:k==='cogs'?'Cost of goods sold':LABELS[k==='other'?'production':k],amount:sum(k),records:[{label:'Month-end stock report',href:month.href+'?'+new URLSearchParams({month:base.month})}]}));
    if(whole)drivers.push({key:'booksOnly',label:LABELS.booksOnly,amount:(c.books.closing-c.books.opening)-(sum('closing')-sum('opening')),records:c.booksOnly.slice(0,5).map(e=>({label:'Entry '+e.number+' · '+e.description,href:e.href}))});
    const change=current-previous;
    if(drivers.reduce((n,d)=>n+d.amount,0n)!==change)throw new InvariantError('The stock value explanation does not add up.');
    const breakdown=scoped.map(p=>({key:p.key,...(names.get(p.key)||{label:'Removed',href:null}),previous:p.opening,current:p.closing,change:p.closing-p.opening,
      lead:(()=>{const k=keys.filter(k=>p[k]!==0n).sort((a,b)=>abs(p[b])>abs(p[a])?1:-1)[0];return k?{label:k==='cogs'?'Cost of goods sold':LABELS[k==='other'?'production':k],amount:p[k]}:null;})()}))
      .filter(g=>g.previous||g.current).sort((a,b)=>abs(b.change)>abs(a.change)?1:-1);
    base.currencies.push({currency:c.currency,previous,current,change,percent:percent(change,previous),drivers,stockouts:[],below:null,
      breakdown:breakdown.slice(0,50),breakdownMore:breakdown.length>50,sentence:sentence(base,previous,current,change,drivers,c.currency,cur,prev)});
  }
  return base;
}

function sentence(q,previous,current,change,drivers,currency,cur,prev){
  const name=MEASURES[q.measure]+(q.subject?' for '+q.subject:'');
  const pct=percent(change,previous);
  const head=change===0n?name+' did not change: '+fmt(current,currency)+' in '+cur.name+' and in '+prev.name+'.'
    :name+(change>0n?' rose ':' fell ')+fmt(abs(change),currency)+(pct===null?'':' ('+Math.abs(pct)+'%)')+' in '+cur.name+': '+fmt(current,currency)+' against '+fmt(previous,currency)+' in '+prev.name+'.';
  const lead=drivers.filter(d=>d.amount!==0n).sort((a,b)=>abs(b.amount)>abs(a.amount)?1:-1).slice(0,3);
  return head+(lead.length&&change!==0n?' Biggest causes: '+lead.map(d=>d.label.toLowerCase()+' '+signed(d.amount,currency)).join(', ')+'.':'');
}

// ---- Page, Ask and the review list ---------------------------------------

async function explain(db,ctx,input={}){
  await reports.owner(db,ctx);
  await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'suggest');
  return db.transaction(c=>explainFor(c,ctx.workspaceId,input),{isolation:'REPEATABLE READ'});
}
function pageLink(r,extra={}){return href+'?'+new URLSearchParams({measure:r.measure,month:r.month,compare:r.compare,by:r.by,...(r.subject?{subject:r.subject}:{}),...extra});}
async function page(db,ctx,query={}){
  const explicit=['measure','month','compare','by','subject'].some(k=>String(query[k]||'').trim());
  const explanation=await explain(db,ctx,explicit?{measure:query.measure,month:query.month,compare:query.compare,by:query.by,subject:query.subject}:{filter:query.filter});
  const state=await policy.accountState(db,ctx.workspaceId),today=await time.today(db,ctx.workspaceId);
  const [runs,flags]=await Promise.all([reports.runs(db,ctx.workspaceId,JOB,{limit:3}),reports.flagsFor(db,ctx.workspaceId,JOB)]);
  return {explanation,months:Array.from({length:24},(_,i)=>reports.addMonths(reports.lastCompleted(today),-i)),measures:MEASURES,dimensions:DIMENSIONS,
    runs,flags,shadow:Boolean(state.shadow),automatic:await reports.automaticStop(db,ctx.workspaceId,state,ACTION),fmt,signed,unitText,link:pageLink(explanation)};
}
// Rows for Ask: the change, then each cause with its records.
function rows(r){
  const out=[];
  for(const c of r.currencies){
    const link=pageLink(r);
    out.push({Month:r.month,Currency:c.currency,Cause:MEASURES[r.measure]+' change',Change:signed(c.change,c.currency),
      Detail:c.sentence,link});
    for(const d of c.drivers)if(d.amount!==0n)out.push({Month:r.month,Currency:c.currency,Cause:d.label,Change:signed(d.amount,c.currency),
      Detail:(d.records||[]).slice(0,3).map(x=>x.label+(x.text?' ('+x.text+')':'')).join('; '),link:d.records?.find(x=>x.href)?.href||link});
    for(const s of c.stockouts)out.push({Month:r.month,Currency:c.currency,Cause:'Out of stock: '+s.label,Change:fmt(s.sales,c.currency)+' of sales probably missed',Detail:s.text,link:s.href||link});
    if(c.below)for(const l of c.below.lines)if(l.amount!==0n)out.push({Month:r.month,Currency:c.currency,Cause:l.label,Change:signed(l.amount,c.currency),Detail:'Below gross profit',link:l.href});
  }
  return out;
}
async function readPage(db,ctx,{filter,today}){
  // Ask passes plain words in filter, read the same way as on the page.
  const r=await explainFor(db,ctx.workspaceId,String(filter||'').trim()?{filter}:{measure:'margin',month:reports.lastCompleted(today)});
  if(r.problem)return {rows:[],more:false,summary:r.problem};
  return {rows:rows(r),more:false,summary:r.currencies.map(c=>c.sentence).join(' ')||r.empty};
}

// ---- Monthly digest: flag big changes -------------------------------------

async function digest(c,workspaceId,month){
  const out=[],flags=[];
  for(const measure of ['revenue','margin','cogs','stock']){
    let r;try{r=await explainFor(c,workspaceId,{measure,month});}catch(error){if(error instanceof ValidationError)return {problem:error.message};throw error;}
    if(r.problem)return {problem:r.problem};
    for(const cur of r.currencies){
      const pct=cur.percent,item={measure,currency:cur.currency,previous:cur.previous,current:cur.current,change:cur.change,percent:pct,sentence:cur.sentence,
        drivers:cur.drivers.map(d=>({key:d.key,label:d.label,amount:d.amount}))};
      out.push(item);
      if(pct===null||Math.abs(pct)<BIG_CHANGE_PERCENT||cur.change===0n)continue;
      const other=cur.drivers.find(d=>d.key==='other'||d.key==='booksOnly')?.amount||0n,unexplained=abs(other)*2n>=abs(cur.change);
      flags.push({key:'change:'+measure+':'+cur.currency,currency:cur.currency,amount:Number(cur.change),detail:{kind:'accounting',priority:unexplained?54:46,
        title:MEASURES[measure]+(cur.change>0n?' rose ':' fell ')+Math.abs(pct)+'% in '+reports.monthName(month),
        happened:cur.sentence+(unexplained?' Most of it is in postings that are not item sales or stock records.':''),
        why:'Changes of '+BIG_CHANGE_PERCENT+'% or more from the month before are flagged in your monthly digest.',
        recommendation:unexplained?'Check the postings behind it; StockChief could not tie most of this change to items.':'Open the explanation to see each cause and its records.',
        href:pageLink({measure,month:r.month,compare:r.compare,by:r.by}),actionLabel:'See why it changed'}});
    }
  }
  return {measures:out,flags};
}
const plain=v=>JSON.parse(JSON.stringify(v,(_k,x)=>typeof x==='bigint'?Number(x):x));
async function produce(c,ctx,month,{automatic,watch=null}){
  const d=await digest(c,ctx.workspaceId,month),result=plain({month,measures:d.measures||[]});
  return reports.record(c,ctx,{job:JOB,period:month,facts:result,result,flags:d.problem?[]:d.flags,automatic,watch,problem:d.problem||null,
    action:automatic?'StockChief checked the month for big changes':'Checked the month for big changes'});
}
async function due(db,workspaceId,today){
  const settings=await reports.accounting(db,workspaceId);
  if(!Number(settings?.enabled)||!settings.accounting_start_date)return null;
  const month=reports.lastCompleted(today);
  return settings.accounting_start_date<=reports.addMonths(month,-1)+'-01'?month:null;
}
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
  const today=await time.today(db,workspaceId),month=await due(db,workspaceId,today);if(!month)return {queued:0};
  if((await db.query(`SELECT 1 FROM ${reports.tables.runs} WHERE workspace_id=$1 AND job_id=$2 AND period=$3 AND outcome='PRODUCED' LIMIT 1`,[workspaceId,JOB,month])).rowCount)return {queued:0};
  // Daily after a month ends until its digest is made; the same facts replay to the same run.
  const job=await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:KIND,priority:70,maxAttempts:3,idempotencyKey:'change-digest:'+month+':'+today,payload:{month}});
  return {queued:job.created?1:0};
}
async function checkNow(database,ctx,input={}){
  await reports.owner(database,ctx);
  const state=await policy.requireWorkspaceJob(database,ctx.workspaceId,JOB,'draft');
  const stop=await policy.stopped(database,ctx.workspaceId,state,ACTION,false);if(stop)throw new ValidationError(stop);
  const month=reports.completedMonth(await time.today(database,ctx.workspaceId),input.month);
  return reports.tx(database,async c=>produce(c,ctx,month,{automatic:false}));
}

module.exports={JOB,ACTION,KIND,href,MEASURES,DIMENSIONS,BIG_CHANGE_PERCENT,normalize,salesFacts,decompose,itemDrivers,explain,explainFor,parseFilter,page,readPage,rows,
  digest,run,schedule,checkNow,
  definition:{id:JOB,key:'margin-change',label:'Explain a change in sales, profit, costs or stock value',filterLabel:'Completed month (YYYY-MM)',readPage}};
