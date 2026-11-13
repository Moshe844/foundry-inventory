'use strict';

// Job 149: answers "what if" questions.
//
// Five questions, each answered from recorded stock, orders, prices and
// costs, with the same calculation job 151 uses to say when stock runs out:
//   - sales change by a percentage (demand-scenario);
//   - selling prices change by a percentage (price-scenario);
//   - supplier costs change by a percentage (cost-scenario);
//   - a supplier's deliveries take some days more or less (lead-time-scenario);
//   - a supplier is lost (supplier-loss-scenario).
// Each answer compares today with the "what if" case, product by product.
// It never guesses how customers would react to a price, and it changes
// nothing: no stock, order, price, cost or setting. It runs on Growth, Pro and
// Custom; Starter shows the plan lock.
const runout=require('./agent-runout');
const money=require('../domain/currency');
const {ValidationError}=require('../domain/errors');

const JOB=149,PAGE=25,NO_SUPPLY_DAYS=90;
const round=(n,places=2)=>Math.round(n*10**places)/10**places;
const show=(minor,currency)=>minor==null||!currency?null:money.format(Math.round(minor),currency);
const units=n=>n==null?null:round(n,2);
const percent=n=>(n>0?'+':'')+round(n,1)+'%';

// A number the user names. Empty means "ask for it".
function amount(raw,{min,max,whole=false,label}){
  const text=String(raw??'').trim();
  if(!text)return null;
  const pattern=whole?/^[+-]?\d{1,4}$/:/^[+-]?\d{1,4}(?:\.\d{1,2})?$/;
  if(!pattern.test(text)||Number(text)<min||Number(text)>max)throw new ValidationError('Enter '+label+'.');
  return Number(text);
}

// Sums money by currency: "$1.00 and KWD 2.000".
function totals(list,pick){
  const sums=new Map();
  for(const e of list){const v=pick(e);if(v&&v.minor!=null&&v.currency)sums.set(v.currency,(sums.get(v.currency)||0)+v.minor);}
  return [...sums].map(([currency,minor])=>money.format(Math.round(minor),currency)).join(' and ')||null;
}

async function skuPage(db,ctx,{filter,page}){
  const rows=(await db.query(`SELECT s.id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND ($2='' OR lower(s.code)=lower($2)) ORDER BY s.code,s.id LIMIT $3 OFFSET $4`,
  [ctx.workspaceId,filter||'',PAGE+1,(page-1)*PAGE])).rows;
  if(filter&&!rows.length&&page===1)throw new ValidationError('No active product has the SKU '+filter+'. Enter an exact SKU, or leave it empty for every product.');
  return {ids:rows.slice(0,PAGE).map(r=>r.id),more:rows.length>PAGE};
}

async function supplierNamed(db,ctx,name){
  const rows=(await db.query("SELECT id,name FROM suppliers WHERE workspace_id=$1 AND status='active' AND lower(name)=lower($2) ORDER BY id LIMIT 2",[ctx.workspaceId,name])).rows;
  if(rows.length>1)throw new ValidationError('Two active suppliers are called '+name+'. Give one of them a different name first.');
  return rows[0]||null;
}

// Products a supplier sells you, and products with open orders from it.
// "Main" means it is the preferred supplier, or the only one, for the product.
async function supplierPage(db,ctx,supplierId,page){
  const rows=(await db.query(`WITH linked AS (
      SELECT si.sku_id FROM supplier_items si WHERE si.workspace_id=$1 AND si.supplier_id=$2 AND si.is_active=1
      UNION SELECT l.sku_id FROM purchase_order_lines l JOIN purchase_orders o ON o.workspace_id=l.workspace_id AND o.id=l.purchase_order_id
      WHERE l.workspace_id=$1 AND o.supplier_id=$2 AND o.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED') AND l.quantity_units>l.quantity_received_units)
    SELECT s.id FROM linked JOIN skus s ON s.workspace_id=$1 AND s.id=linked.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.is_active=1 AND i.is_active=1 ORDER BY s.code,s.id LIMIT $3 OFFSET $4`,[ctx.workspaceId,supplierId,PAGE+1,(page-1)*PAGE])).rows;
  return {ids:rows.slice(0,PAGE).map(r=>r.id),more:rows.length>PAGE};
}

// Every active supplier link for these products, with its recorded lead time.
async function links(db,ctx,skuIds){
  if(!skuIds.length)return [];
  return (await db.query(`SELECT si.sku_id,si.supplier_id,s.name,si.is_preferred,lead.effective_lead
    FROM supplier_items si JOIN suppliers s ON s.workspace_id=si.workspace_id AND s.id=si.supplier_id AND s.status='active'
    LEFT JOIN stockchief_runtime.supplier_planning_leads lead ON lead.workspace_id=si.workspace_id AND lead.supplier_item_id=si.id
    WHERE si.workspace_id=$1 AND si.sku_id=ANY($2::text[]) AND si.is_active=1 ORDER BY si.sku_id,si.is_preferred DESC,s.name,si.id`,[ctx.workspaceId,skuIds])).rows;
}
const mainSupplier=(list,skuId)=>{const own=list.filter(l=>l.sku_id===skuId);return own.find(l=>Number(l.is_preferred))||(own.length===1?own[0]:null);};

function pair(now,then){
  const other=new Map(then.map(e=>[e.skuId,e]));
  return now.filter(e=>other.has(e.skuId)).map(e=>[e,other.get(e.skuId)]).sort((a,b)=>a[0].code.localeCompare(b[0].code));
}
const lost=e=>e.lostMargin==null?null:{minor:e.lostMargin,currency:e.currency};
const shortOf=e=>e.beforeDelivery?units(e.unitsShort):0;
const lostText=e=>e.beforeDelivery?show(e.lostMargin,e.currency)||'Unknown':'None';
const later=e=>e.runout||'Not within a year';
// Today's value, then the what-if value: "150 → 180". One value when the
// what-if leaves it unchanged.
const shift=(a,b)=>{const x=a??'None',y=b??'None';return String(x)===String(y)?x:x+' → '+y;};
const missingPrice='Record a selling price and a purchase cost in the same currency to answer this.';
const scopeNote=(more,count)=>more?' These figures cover the '+count+' products on this page.':'';

async function sales(db,ctx,o){
  const change=amount(o.change,{min:-100,max:1000,label:'a sales change between -100% and 1,000%'});
  if(change==null)return {rows:[],more:false,summary:'Enter how much sales change, in percent. StockChief compares the next 30 days, when stock runs out and what that costs, with today.'};
  const {ids,more}=await skuPage(db,ctx,o),data=ids.length?await runout.load(db,ctx.workspaceId,ids,o.today):null;
  const now=data?runout.compute(data):[],then=data?runout.compute(data,{demandFactor:1+change/100}):[],pairs=pair(now,then);
  const rows=pairs.map(([a,b])=>({SKU:a.code,'Available now':a.available,'Sales in 30 days':shift(units(a.dailyDemand*30),units(b.dailyDemand*30)),
    'Runs out':shift(later(a),later(b)),'Next delivery':b.nextDelivery||'None','Short before it':shift(shortOf(a),shortOf(b)),
    'Margin lost before it':shift(lostText(a),lostText(b)),Reason:b.reason,link:'/inventory/'+a.itemId}));
  const before=pairs.filter(([a])=>a.beforeDelivery).length,after=pairs.filter(([,b])=>b.beforeDelivery).length;
  const short=round(pairs.reduce((n,[,b])=>n+shortOf(b),0)),lostNow=totals(pairs.map(p=>p[0]),lost),lostThen=totals(pairs.map(p=>p[1]),lost);
  const summary='If sales '+(change>=0?'go up ':'go down ')+Math.abs(change)+'%, '+after+' of '+rows.length+' products run out before their next delivery ('+before+' today)'+
    (after?', '+short+' units short in all':'')+'.'+(lostThen?' Gross margin lost before those deliveries: '+lostThen+(lostNow?' (today '+lostNow+').':' (none today).'):'')+
    scopeNote(more,rows.length)+' Demand comes from each product’s forecast, or else its last 90 days of sales. Nothing was changed.';
  return {rows,more,summary};
}

async function price(db,ctx,o){
  const change=amount(o.change,{min:-100,max:1000,label:'a price change between -100% and 1,000%'});
  if(change==null)return {rows:[],more:false,summary:'Enter how much selling prices change, in percent. StockChief compares margin over the next 30 days at today’s sales.'};
  const {ids,more}=await skuPage(db,ctx,o),data=ids.length?await runout.load(db,ctx.workspaceId,ids,o.today):null;
  const list=(data?runout.compute(data):[]).sort((a,b)=>a.code.localeCompare(b.code)),known=[];
  const rows=list.map(a=>{
    const month=a.dailyDemand*30,link='/inventory/'+a.itemId;
    if(a.price==null||a.cost==null||a.priceCurrency!==a.costCurrency)return {SKU:a.code,Price:show(a.price,a.priceCurrency),Cost:show(a.cost,a.costCurrency),'Margin a unit':null,
      'Sales in 30 days':units(month),'Margin in 30 days':null,'Sales change that earns the same':null,Reason:missingPrice,link};
    const currency=a.priceCurrency,next=Math.round(a.price*(1+change/100)),m0=a.price-a.cost,m1=next-a.cost;
    known.push({currency,now:m0*month,then:m1*month});
    const same=m0<=0?'No margin today':m1<=0?'None: the price would be at or below cost':percent((m0/m1-1)*100);
    return {SKU:a.code,Price:shift(show(a.price,currency),show(next,currency)),Cost:show(a.cost,currency),'Margin a unit':shift(show(m0,currency),show(m1,currency)),
      'Sales in 30 days':units(month),'Margin in 30 days':shift(show(m0*month,currency),show(m1*month,currency)),
      'Sales change that earns the same':same,Reason:'Assumes the same sales as today.',link};
  });
  const now=totals(known,k=>({minor:k.now,currency:k.currency})),then=totals(known,k=>({minor:k.then,currency:k.currency}));
  const currencies=new Set(known.map(k=>k.currency)),sumNow=known.reduce((n,k)=>n+k.now,0),sumThen=known.reduce((n,k)=>n+k.then,0);
  const same=currencies.size===1&&sumNow>0&&sumThen>0?' Sales could change by '+percent((sumNow/sumThen-1)*100)+' and earn the same.':'';
  const missing=rows.length-known.length;
  const summary='If selling prices '+(change>=0?'go up ':'go down ')+Math.abs(change)+'% and you sell the same amounts, gross margin over the next 30 days '+
    (now?'goes from '+now+' to '+then+'.':'cannot be worked out yet.')+same+(missing?' '+missing+' product'+(missing===1?' needs':'s need')+' a selling price and cost first.':'')+
    scopeNote(more,rows.length)+' StockChief does not guess how customers react. No price was changed; changing prices always needs a person.';
  return {rows,more,summary};
}

async function cost(db,ctx,o){
  const change=amount(o.change,{min:-100,max:1000,label:'a cost change between -100% and 1,000%'});
  if(change==null)return {rows:[],more:false,summary:'Enter how much supplier costs change, in percent. Add a supplier name to look at one supplier, or leave it empty for every product.'};
  const filter=String(o.filter||'').trim(),supplier=filter?await supplierNamed(db,ctx,filter):null;
  let ids,more;
  if(supplier){
    ({ids,more}=await supplierPage(db,ctx,supplier.id,o.page));
    const list=await links(db,ctx,ids);ids=ids.filter(id=>mainSupplier(list,id)?.supplier_id===supplier.id);
  }else ({ids,more}=await skuPage(db,ctx,o));
  const data=ids.length?await runout.load(db,ctx.workspaceId,ids,o.today):null;
  const list=(data?runout.compute(data):[]).sort((a,b)=>a.code.localeCompare(b.code)),known=[];
  const rows=list.map(a=>{
    const month=a.dailyDemand*30,link='/inventory/'+a.itemId;
    if(a.price==null||a.cost==null||a.priceCurrency!==a.costCurrency)return {SKU:a.code,Cost:show(a.cost,a.costCurrency),Price:show(a.price,a.priceCurrency),Margin:null,
      'Sales in 30 days':units(month),'Margin in 30 days':null,'Price that keeps the margin %':null,Reason:missingPrice,link};
    const currency=a.costCurrency,next=Math.round(a.cost*(1+change/100)),m0=a.price-a.cost,m1=a.price-next;
    known.push({currency,now:m0*month,then:m1*month});
    const share=v=>a.price>0?round(v/a.price*100,1)+'%':null;
    return {SKU:a.code,Cost:shift(show(a.cost,currency),show(next,currency)),Price:show(a.price,currency),Margin:shift(share(m0),share(m1)),
      'Sales in 30 days':units(month),'Margin in 30 days':shift(show(m0*month,currency),show(m1*month,currency)),
      'Price that keeps the margin %':a.cost>0?show(a.price*next/a.cost,currency):null,Reason:'At today’s prices and sales.',link};
  });
  const now=totals(known,k=>({minor:k.now,currency:k.currency})),then=totals(known,k=>({minor:k.then,currency:k.currency}));
  const summary='If '+(supplier?'costs from '+supplier.name:'supplier costs')+' '+(change>=0?'go up ':'go down ')+Math.abs(change)+'%, gross margin over the next 30 days at today’s prices '+
    (now?'goes from '+now+' to '+then+'.':'cannot be worked out yet.')+(known.length?' Keeping today’s margin percentage means prices '+(change>=0?'up':'down')+' '+Math.abs(change)+'% too; each product shows its price.':'')+
    (rows.length>known.length?' '+(rows.length-known.length)+' product'+(rows.length-known.length===1?' needs':'s need')+' a selling price and cost first.':'')+
    scopeNote(more,rows.length)+' Stock you already have keeps the cost you paid. Nothing was changed.';
  return {rows,more,summary};
}

async function supplierFrom(db,ctx,o,ask){
  const filter=String(o.filter||'').trim();
  if(!filter)return null;
  const supplier=await supplierNamed(db,ctx,filter);
  if(!supplier)throw new ValidationError('No active supplier is called '+filter+'. '+ask);
  return supplier;
}

async function leadTime(db,ctx,o){
  const ask='Enter the supplier’s exact name and how many more days its deliveries take.';
  const days=amount(o.change,{min:-90,max:365,whole:true,label:'whole days between -90 and 365'}),supplier=await supplierFrom(db,ctx,o,ask);
  if(days==null||!supplier)return {rows:[],more:false,summary:ask+' Use a minus sign for faster deliveries.'};
  const {ids,more}=await supplierPage(db,ctx,supplier.id,o.page),data=ids.length?await runout.load(db,ctx.workspaceId,ids,o.today):null;
  const now=data?runout.compute(data):[],list=await links(db,ctx,ids),leads=new Map(),mains=new Set();
  for(const e of now){
    const main=mainSupplier(list,e.skuId);if(main?.supplier_id!==supplier.id)continue;
    mains.add(e.skuId);
    const lead=main.effective_lead!=null?Number(main.effective_lead):e.evidence.lead;
    if(lead!=null)leads.set(e.skuId,Math.max(0,Math.ceil(lead)+days));
  }
  const then=data?runout.compute(data,{supplierId:supplier.id,extraLeadDays:days,leads}):[],pairs=pair(now,then);
  const cover=e=>days>0?Math.ceil(days*e.dailyDemand-1e-9):0;
  const rows=pairs.map(([a,b])=>({SKU:a.code,'Available now':a.available,'Next delivery':shift(a.nextDelivery,b.nextDelivery),'Runs out':later(a),
    'Short before it':shift(shortOf(a),shortOf(b)),'Margin lost before it':shift(lostText(a),lostText(b)),'Extra stock for the wait':cover(a),
    Reason:mains.has(a.skuId)?b.reason:b.reason+' New orders go to its main supplier, not '+supplier.name+'.',link:'/inventory/'+a.itemId}));
  const before=pairs.filter(([a])=>a.beforeDelivery).length,after=pairs.filter(([,b])=>b.beforeDelivery).length,extra=pairs.reduce((n,[a])=>n+cover(a),0);
  const lostNow=totals(pairs.map(p=>p[0]),lost),lostThen=totals(pairs.map(p=>p[1]),lost);
  const summary='If deliveries from '+supplier.name+' take '+Math.abs(days)+' days '+(days>=0?'longer':'less')+', '+after+' of '+rows.length+' products run out before their next delivery ('+before+' today).'+
    (extra?' Keeping about '+extra+' more units in stock covers the longer wait.':'')+(lostThen?' Gross margin lost before those deliveries: '+lostThen+(lostNow?' (today '+lostNow+').':' (none today).'):'')+
    scopeNote(more,rows.length)+' Its dated purchase orders move by the same days, and new orders use its recorded lead time. Nothing was changed.';
  return {rows,more,summary};
}

async function supplierLoss(db,ctx,o){
  const ask='Enter the exact name of the supplier you might lose.';
  const supplier=await supplierFrom(db,ctx,o,ask);
  if(!supplier)return {rows:[],more:false,summary:ask+' StockChief shows which products have no other supplier, when they run out and what that costs.'};
  const {ids,more}=await supplierPage(db,ctx,supplier.id,o.page),data=ids.length?await runout.load(db,ctx.workspaceId,ids,o.today):null;
  const list=await links(db,ctx,ids),leads=new Map(),noSupplier=new Set();
  for(const id of ids){
    const others=list.filter(l=>l.sku_id===id&&l.supplier_id!==supplier.id);
    if(!others.length){noSupplier.add(id);continue;}
    const known=others.filter(l=>l.effective_lead!=null).map(l=>Math.ceil(Number(l.effective_lead)));
    leads.set(id,known.length?Math.min(...known):null);
  }
  const due=(await db.query(`SELECT l.sku_id,o.id,o.currency,(l.quantity_units-l.quantity_received_units)::float8 AS units,l.unit_cost::float8 AS unit_cost
    FROM purchase_order_lines l JOIN purchase_orders o ON o.workspace_id=l.workspace_id AND o.id=l.purchase_order_id
    WHERE l.workspace_id=$1 AND o.supplier_id=$2 AND o.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED') AND l.quantity_units>l.quantity_received_units`,
  [ctx.workspaceId,supplier.id])).rows;
  const now=data?runout.compute(data):[],then=data?runout.compute(data,{supplierId:supplier.id,withoutSupplier:true,leads,noSupplier,noSupplyDays:NO_SUPPLY_DAYS}):[];
  const other=new Map(then.map(e=>[e.skuId,e])),margin=e=>e.unitMargin==null?null:{minor:e.unitMargin*e.dailyDemand*30,currency:e.currency};
  const rows=now.sort((a,b)=>a.code.localeCompare(b.code)).map(a=>{
    const b=other.get(a.skuId)||a,names=list.filter(l=>l.sku_id===a.skuId&&l.supplier_id!==supplier.id).map(l=>l.name);
    return {SKU:a.code,'Other suppliers':names.length?[...new Set(names)].join(', '):'None on record','Due from this supplier':units(due.filter(d=>d.sku_id===a.skuId).reduce((n,d)=>n+d.units,0)),
      'Runs out':shift(later(a),later(b)),'Next delivery if lost':b.nextDelivery||'None','Margin lost before it':lostText(b),'Margin a month':show(margin(a)?.minor,a.currency),
      Reason:b.reason,link:'/inventory/'+a.itemId};
  });
  const only=now.filter(e=>noSupplier.has(e.skuId)),hit=now.filter(e=>other.get(e.skuId)?.beforeDelivery);
  const orders=new Set(due.map(d=>d.id)).size,value=totals(due,d=>d.unit_cost==null||!d.currency?null:{minor:Math.round(d.units*d.unit_cost*10**money.exponent(d.currency)),currency:d.currency});
  const lostThen=totals(hit.map(e=>other.get(e.skuId)),lost),monthly=totals(only,margin);
  const summary='If you lost '+supplier.name+', '+noSupplier.size+' of its '+ids.length+' products would have no other supplier on record, and '+hit.length+' would run out before another delivery could arrive.'+
    (orders?' '+orders+' open purchase order'+(orders===1?'':'s')+(value?' worth '+value:'')+' from it would not arrive.':'')+
    (monthly?' Products only it supplies earn about '+monthly+' of gross margin a month.':'')+(lostThen?' Gross margin lost before new stock arrives: '+lostThen+'.':'')+
    scopeNote(more,rows.length)+' With no other supplier, losses are counted over '+NO_SUPPLY_DAYS+' days. Nothing was changed.';
  return {rows,more,summary};
}

const definitions=[
  {id:JOB,key:'demand-scenario',label:'What if sales change',readPage:sales,requiresChange:true,filterLabel:'SKU (optional)'},
  {id:JOB,key:'price-scenario',label:'What if selling prices change',readPage:price,requiresChange:true,changeLabel:'Change in selling prices (%)',filterLabel:'SKU (optional)'},
  {id:JOB,key:'cost-scenario',label:'What if supplier costs change',readPage:cost,requiresChange:true,changeLabel:'Change in supplier costs (%)',filterLabel:'Supplier name (optional)'},
  {id:JOB,key:'lead-time-scenario',label:'What if a supplier’s deliveries take longer',readPage:leadTime,requiresChange:true,changeLabel:'Extra days to deliver',minChange:-90,maxChange:365,filterLabel:'Supplier name'},
  {id:JOB,key:'supplier-loss-scenario',label:'What if you lost a supplier',readPage:supplierLoss,filterLabel:'Supplier name'}
];

module.exports={JOB,definitions,sales,price,cost,leadTime,supplierLoss};
