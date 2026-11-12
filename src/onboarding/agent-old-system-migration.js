'use strict';

// Job 190: moves your data in from your old system on day one.
//
// Reads the ordinary CSV and spreadsheet exports an inventory or ERP system
// produces (product lists, stock on hand by location with value, suppliers,
// customers, open purchase and sales orders, unpaid customer invoices and
// supplier bills, and the export's own totals). Each table is recognised by
// its headings; a table StockChief does not recognise, a value it cannot
// read or a missing total stops and asks. It never guesses.
//
// The records become one ERP cutover (src/onboarding/postgres-cutover.js),
// which saves them through the native catalog, stock, purchasing, sales and
// ledger services in pages, then checks every saved balance against the
// records. Before that, the records' sums are checked against the totals the
// export states.
//
// Starter cannot use it. Growth drafts the whole migration plan; the owner
// approves it and opens the inventory. Pro and Custom approve and open on
// their own when every total and balance matches, outside the first 14 days,
// Watch only, a pause and Ask me first. Any difference stops and asks.

const crypto=require('node:crypto');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const exact=require('../domain/exact-quantity');
const audit=require('../operations/postgres-security-audit');
const cutover=require('./postgres-cutover');

const JOB=190,ACTION='onboarding.old_system_migration';
const sources='stockchief_runtime.agent_migration_sources';
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const clean=v=>String(v??'').trim();
const key=v=>clean(v).toLowerCase();

// ---- Recognising the tables ----------------------------------------------------

const H={
  sku:/^(?:sku|item (?:code|no|number|#|id)|item#|product (?:code|no|number|id)|part (?:no|number|#)|stock code|code)$/,
  name:/^(?:name|item name|product name|description|item description|product|item)$/,
  qty:/^(?:qty|quantity|on hand|qty on hand|quantity on hand|in stock|stock on hand|soh)$/,
  location:/^(?:location|warehouse|whse|site|store|branch)$/,
  value:/^(?:value|stock value|inventory value|total value|total cost|extended cost|value on hand)$/,
  unitCost:/^(?:cost|unit cost|average cost|avg cost|cost price|purchase price|standard cost)$/,
  price:/^(?:price|selling price|sell price|sales price|retail price|list price)$/,
  barcode:/^(?:barcode|upc|ean|gtin)$/,
  unit:/^(?:unit|uom|unit of measure)$/,
  supplier:/^(?:supplier|vendor|supplier name|vendor name|preferred supplier|preferred vendor)$/,
  customer:/^(?:customer|client|customer name|client name)$/,
  email:/^(?:email|e mail|email address)$/,phone:/^(?:phone|telephone|phone number)$/,currency:/^(?:currency|currency code)$/,
  po:/^(?:po|po (?:no|number|#)|po#|purchase order|purchase order (?:no|number|#))$/,
  so:/^(?:so|so (?:no|number|#)|so#|sales order|sales order (?:no|number|#)|order (?:no|number|#)|order#)$/,
  invoice:/^(?:invoice|invoice (?:no|number|#)|invoice#)$/,
  bill:/^(?:bill|bill (?:no|number|#)|bill#|vendor invoice|vendor invoice (?:no|number|#)|supplier invoice|supplier invoice (?:no|number|#))$/,
  balance:/^(?:balance|open balance|amount due|balance due|outstanding|unpaid|open amount)$/,
  total:/^(?:total|invoice total|bill total|original amount|amount)$/,
  date:/^(?:date|invoice date|bill date|order date|issue date|document date)$/,
  due:/^(?:due|due date)$/,
  expected:/^(?:expected|expected date|eta|delivery date)$/,
  ordered:/^(?:ordered|qty ordered|quantity ordered)$/,received:/^(?:received|qty received|quantity received)$/,shipped:/^(?:shipped|qty shipped|quantity shipped)$/,
  open:/^(?:open|qty open|open qty|remaining|qty remaining|remaining qty|outstanding qty)$/,
  address:/^(?:ship to|ship to address|shipping address|delivery address|address)$/,
};
const norm=text=>require('../imports/fields').normalise(text);
function columnsOf(sheet){
  const found={};
  for(const column of sheet.columns){const n=norm(column.name);for(const [field,pattern] of Object.entries(H))if(found[field]===undefined&&pattern.test(n)){found[field]=column.index;break;}}
  return found;
}
const TOTAL_LABELS=[['stockValue',/(?:stock|inventory) value|total value|value on hand/],['stockUnits',/(?:stock|inventory) units|units on hand|total (?:units|quantity)|quantity on hand/],
  ['receivables',/receivable|customers owe|owed by customers|unpaid invoices|open invoices/],['payables',/payable|owed to suppliers|unpaid bills|open bills/],
  ['products',/^(?:number of )?(?:products|items|skus)(?: count)?$/],['customers',/^(?:number of )?customers(?: count)?$/],['suppliers',/^(?:number of )?(?:suppliers|vendors)(?: count)?$/]];
const FAMILIES={products:'Products',stock:'Stock on hand',suppliers:'Suppliers',customers:'Customers',purchaseOrders:'Open purchase orders',salesOrders:'Open sales orders',
  receivables:'Unpaid customer invoices',payables:'Unpaid supplier bills',totals:'Export totals'};
function family(sheet){
  const c=columnsOf(sheet),has=f=>c[f]!==undefined,party=has('customer'),vendor=has('supplier');
  if(has('invoice')&&party&&(has('balance')||has('total')))return {kind:'receivables',c};
  if(has('bill')&&vendor&&(has('balance')||has('total')))return {kind:'payables',c};
  if(has('so')&&party&&has('sku'))return {kind:'salesOrders',c};
  if(has('po')&&vendor&&has('sku'))return {kind:'purchaseOrders',c};
  if(has('sku')&&has('qty'))return {kind:'stock',c};
  if(has('sku')&&has('name'))return {kind:'products',c};
  if(party&&!has('sku'))return {kind:'customers',c};
  if(vendor&&!has('sku'))return {kind:'suppliers',c};
  if(sheet.columns.length===2&&sheet.rows.some(r=>TOTAL_LABELS.some(([,p])=>p.test(norm(r.cells[sheet.columns[0].index])))))return {kind:'totals',c:{label:sheet.columns[0].index,amount:sheet.columns[1].index}};
  return null;
}

// ---- Reading values ---------------------------------------------------------------

function readMoney(value,label){
  const text=clean(value);if(!text)return null;
  try{const minor=require('../pricing/price-service').toMinor(require('../imports/source-money').clean(text),label);if(minor===null)throw new Error();return minor;}
  catch{throw new ValidationError(label+' “'+text+'” is not an amount StockChief can read.');}
}
function readQuantity(value,label){
  const text=clean(value).replace(/,/g,'');if(!text)return null;
  if(!/^\d+(?:\.\d{1,6})?$/.test(text))throw new ValidationError(label+' “'+clean(value)+'” is not a quantity of zero or more.');
  return exact.canonical(text);
}
function readDate(value,label){
  const text=clean(value);if(!text)return null;
  const read=require('../imports/row-validator').readDate(text);
  if(!read?.ok||!read.value||read.ambiguous)throw new ValidationError(label+' “'+text+'” is not a date StockChief can read without guessing.');
  return String(read.value).slice(0,10);
}
const isTotalRow=(row,sheet)=>sheet.columns.slice(0,3).some(col=>/^(?:grand )?totals?:?$/i.test(clean(row.cells[col.index])));

// ---- Building the migration plan ------------------------------------------------------

function plan(files,{currency,startDate,defaultLocation,typedTotals={}}){
  const problems=[],add=(file,row,error)=>{if(problems.length<50)problems.push({file,row,message:error.message||String(error)});};
  const tables=[],unknown=[];
  for(const file of files){
    const book=require('../imports/parser').parse({buffer:file.buffer,filename:file.filename,indexed:true});
    for(const sheet of book.sheets){
      if(!sheet.rows?.length)continue;
      const kind=family(sheet),label=book.sheets.length>1?file.filename+' · '+sheet.name:file.filename;
      if(!kind)unknown.push(label);else tables.push({label,sheet,...kind});
    }
  }
  if(unknown.length)throw new ValidationError('StockChief does not know what '+unknown.map(u=>'“'+u+'”').join(', ')+' holds. Supported exports: '+Object.values(FAMILIES).join(', ').toLowerCase()+'.');
  if(!tables.some(t=>['products','stock'].includes(t.kind)))throw new ValidationError('Add the product list or stock on hand export. A migration starts with your products.');
  const exported={},computed={stockUnits:'0',stockValue:0,receivables:0,payables:0};
  const products=new Map(),suppliers=new Map(),customers=new Map(),locations=new Map(),positions=new Map(),pos=new Map(),sos=new Map(),ars=[],aps=[];
  const location=name=>{const n=clean(name)||clean(defaultLocation);if(!n)throw new ValidationError('Name the location for stock that has no location.');const k='location:'+key(n);if(!locations.has(k))locations.set(k,{name:n});return k;};
  const party=(map,prefix,name,extra={})=>{const n=clean(name);if(!n)throw new ValidationError('The '+prefix+' name is missing.');const k=prefix+':'+key(n);const prior=map.get(k);map.set(k,{...prior,name:prior?.name||n,...Object.fromEntries(Object.entries(extra).filter(([,v])=>clean(v)))});return k;};
  const product=(code,fields={})=>{const c=clean(code);if(!c)throw new ValidationError('The SKU is missing.');const k='sku:'+key(c);const prior=products.get(k)||{code:c};
    for(const [f,v] of Object.entries(fields))if(v!==null&&v!==undefined&&clean(v)!==''){if(prior[f]!==undefined&&String(prior[f])!==String(v))throw new ValidationError('The files give two different '+f+'s for '+c+'.');prior[f]=v;}
    products.set(k,prior);return k;};
  const exportTotal=(name,value)=>{if(value===null||value===undefined)return;exported[name]=exported[name]===undefined?value:typeof value==='string'?exact.add(exported[name],value):exported[name]+value;};
  for(const t of tables){
    const c=t.c,cell=(row,f)=>c[f]===undefined?'':row.cells[c[f]];
    for(const row of t.sheet.rows){
      try{
        if(t.kind==='totals'){
          const label=norm(row.cells[c.label]),found=TOTAL_LABELS.find(([,p])=>p.test(label));if(!found)continue;
          const [name]=found,value=['stockValue','receivables','payables'].includes(name)?readMoney(row.cells[c.amount],'The total'):readQuantity(row.cells[c.amount],'The total');
          exportTotal(name,['products','customers','suppliers'].includes(name)?Number(value):value);continue;
        }
        if(isTotalRow(row,t.sheet)){
          if(t.kind==='stock'){exportTotal('stockUnits',readQuantity(cell(row,'qty'),'The total quantity'));if(c.value!==undefined)exportTotal('stockValue',readMoney(cell(row,'value'),'The total value'));}
          if(t.kind==='receivables'||t.kind==='payables')exportTotal(t.kind,readMoney(cell(row,c.balance!==undefined?'balance':'total'),'The total'));
          continue;
        }
        if(!t.sheet.columns.some(col=>clean(row.cells[col.index])))continue;
        if(t.kind==='products'||t.kind==='stock'){
          const cost=readMoney(cell(row,'unitCost'),'The cost'),price=readMoney(cell(row,'price'),'The price');
          const k=product(cell(row,'sku'),{name:clean(cell(row,'name'))||null,barcode:clean(cell(row,'barcode'))||null,unit:clean(cell(row,'unit'))||null,
            costMinor:cost,priceMinor:price,supplier:c.supplier!==undefined&&clean(cell(row,'supplier'))?party(suppliers,'supplier',cell(row,'supplier')):null});
          if(t.kind==='stock'){
            const quantity=readQuantity(cell(row,'qty'),'The quantity');
            let value=c.value!==undefined?readMoney(cell(row,'value'),'The value'):null;
            if(value===null&&cost!==null)value=exact.costMinor(quantity,cost);
            if(value===null&&Number(quantity)>0)throw new ValidationError('This stock line has no value or cost. StockChief does not guess what stock is worth.');
            const loc=location(cell(row,'location')),pk=JSON.stringify([k,loc]);
            if(positions.has(pk))throw new ValidationError('This SKU and location appear twice. Combine them in the export.');
            positions.set(pk,{skuKey:k,locationKey:loc,quantity,totalCostMinor:Number(quantity)?value:0});
            computed.stockUnits=exact.add(computed.stockUnits,quantity);computed.stockValue+=Number(quantity)?value:0;
          }
        }
        if(t.kind==='suppliers')party(suppliers,'supplier',cell(row,'supplier'),{email:cell(row,'email'),phone:cell(row,'phone')});
        if(t.kind==='customers')party(customers,'customer',cell(row,'customer'),{email:cell(row,'email'),phone:cell(row,'phone')});
        if(t.kind==='purchaseOrders'||t.kind==='salesOrders'){
          const purchase=t.kind==='purchaseOrders',number=clean(cell(row,purchase?'po':'so'));if(!number)throw new ValidationError('The order number is missing.');
          const remaining=c.open!==undefined?readQuantity(cell(row,'open'),'The open quantity'):
            exact.subtract(readQuantity(cell(row,c.ordered!==undefined?'ordered':'qty'),'The ordered quantity')||'0',readQuantity(cell(row,purchase?'received':'shipped'),'The quantity done')||'0');
          if(Number(remaining)<0)throw new ValidationError('More was '+(purchase?'received':'shipped')+' than ordered.');
          if(!Number(remaining))continue;
          const unit=readMoney(cell(row,purchase?'unitCost':'price'),purchase?'The cost':'The price');if(unit===null)throw new ValidationError('This order line has no '+(purchase?'cost':'price')+'.');
          const map=purchase?pos:sos,k=(purchase?'po:':'so:')+key(number),counterparty=purchase?party(suppliers,'supplier',cell(row,'supplier')):party(customers,'customer',cell(row,'customer'));
          const order=map.get(k)||{orderNumber:number,party:counterparty,location:location(cell(row,'location')),lines:[],orderDate:readDate(cell(row,'date'),'The order date'),expectedDate:readDate(cell(row,'expected'),'The expected date')};
          if(order.party!==counterparty)throw new ValidationError('Order '+number+' names two different '+(purchase?'suppliers':'customers')+'.');
          if(!purchase){const address=clean(cell(row,'address'));if(!address&&!order.address)throw new ValidationError('Order '+number+' has no delivery address. Add the ship-to address to the export.');if(address&&order.address&&address!==order.address)throw new ValidationError('Order '+number+' has two delivery addresses.');order.address=order.address||address;}
          order.lines.push({skuKey:product(cell(row,'sku'),{name:clean(cell(row,'name'))||null}),quantity:remaining,unitPriceMinor:unit});map.set(k,order);
        }
        if(t.kind==='receivables'||t.kind==='payables'){
          const ar=t.kind==='receivables',number=clean(cell(row,ar?'invoice':'bill'));if(!number)throw new ValidationError('The document number is missing.');
          const balance=readMoney(cell(row,c.balance!==undefined?'balance':'total'),'The balance');if(!balance)continue;
          const total=c.balance!==undefined&&c.total!==undefined?readMoney(cell(row,'total'),'The document total'):null;
          const issue=readDate(cell(row,'date'),'The document date');if(!issue)throw new ValidationError('The document date is missing.');
          const doc={documentNumber:number,party:ar?party(customers,'customer',cell(row,'customer')):party(suppliers,'supplier',cell(row,'supplier')),issueDate:issue,dueDate:readDate(cell(row,'due'),'The due date'),balanceMinor:balance,...(total!==null?{originalTotalMinor:total}:{})};
          (ar?ars:aps).push(doc);computed[t.kind]+=balance;
        }
        if(c.currency!==undefined&&clean(cell(row,'currency'))&&clean(cell(row,'currency')).toUpperCase()!==currency)throw new ValidationError('This line is in '+clean(cell(row,'currency'))+', not '+currency+'.');
      }catch(error){if(!(error instanceof ValidationError))throw error;add(t.label,row.sourceRow,error);}
    }
  }
  computed.products=products.size;computed.customers=customers.size;computed.suppliers=suppliers.size;
  for(const [name,value] of Object.entries(typedTotals))if(value!==null&&value!==undefined&&exported[name]===undefined)exported[name]=value;
  const families=new Set(tables.map(t=>t.kind));
  const needed=[...(families.has('stock')?['stockUnits','stockValue']:[]),...(families.has('receivables')?['receivables']:[]),...(families.has('payables')?['payables']:[])];
  const missing=needed.filter(n=>exported[n]===undefined);
  const differences=Object.entries(exported).filter(([name])=>computed[name]!==undefined).filter(([name,value])=>
    name==='stockUnits'?exact.canonical(value)!==exact.canonical(computed[name]):Number(value)!==Number(computed[name])).map(([name,value])=>({name,export:value,records:computed[name]}));
  return {problems,missing,differences,exported,computed,tables:tables.map(t=>({label:t.label,kind:t.kind,label2:FAMILIES[t.kind],rows:t.sheet.rows.length})),
    data:{products,suppliers,customers,locations,positions,pos,sos,ars,aps}};
}

function records(data,{currency,startDate}){
  const out=[];const push=(type,k,payload)=>out.push({type,key:k,payload});
  for(const [k,l] of data.locations)push('location',k,{name:l.name,kind:'warehouse'});
  for(const [k,s] of data.suppliers)push('supplier',k,{name:s.name,currency,...(s.email?{email:s.email}:{}),...(s.phone?{phone:s.phone}:{})});
  for(const [k,s] of data.customers)push('customer',k,{name:s.name,...(s.email?{email:s.email}:{}),...(s.phone?{phone:s.phone}:{})});
  for(const [k,p] of data.products){
    push('product','product:'+k.slice(4),{name:p.name||p.code,trackingMode:'quantity',unitLabel:p.unit||'unit'});
    push('sku',k,{productKey:'product:'+k.slice(4),code:p.code,...(p.barcode?{barcode:p.barcode}:{}),options:[]});
    if(p.costMinor!==null&&p.costMinor!==undefined)push('purchase_cost','cost:'+k,{skuKey:k,amountMinor:p.costMinor,currency});
    if(p.priceMinor!==null&&p.priceMinor!==undefined)push('selling_price','price:'+k,{skuKey:k,amountMinor:p.priceMinor,currency});
    if(p.supplier)push('supplier_item','link:'+p.supplier+':'+k,{supplierKey:p.supplier,skuKey:k,supplierSku:p.code});
  }
  for(const [pk,p] of data.positions)push('inventory_position','position:'+pk,{skuKey:p.skuKey,locationKey:p.locationKey,quantity:p.quantity,totalCostMinor:p.totalCostMinor,currency,
    reservedQuantity:'0',damagedQuantity:'0',availableQuantity:p.quantity});
  for(const [k,o] of data.pos)push('purchase_order',k,{currency,orderNumber:o.orderNumber,status:'ORDERED',supplierKey:o.party,destinationLocationKey:o.location,remainingOnly:true,
    ...(o.orderDate?{orderDate:o.orderDate}:{}),...(o.expectedDate?{expectedDate:o.expectedDate}:{}),lines:o.lines});
  // Open sales orders arrive unconfirmed: confirming one reserves stock, and a
  // reservation the export does not state would be a guess.
  for(const [k,o] of data.sos)push('sales_order',k,{currency,orderNumber:o.orderNumber,status:'DRAFT',customerKey:o.party,fulfillmentLocationKey:o.location,remainingOnly:true,deliveryMethod:'SHIP',shipToAddress:o.address,
    ...(o.orderDate?{orderDate:o.orderDate}:{}),lines:o.lines});
  for(const d of data.ars)push('opening_receivable','ar:'+key(d.documentNumber),{documentNumber:d.documentNumber,customerKey:d.party,issueDate:d.issueDate,...(d.dueDate?{dueDate:d.dueDate}:{}),balanceMinor:d.balanceMinor,...(d.originalTotalMinor!==undefined?{originalTotalMinor:d.originalTotalMinor}:{}),currency});
  for(const d of data.aps)push('opening_payable','ap:'+key(d.documentNumber),{documentNumber:d.documentNumber,supplierKey:d.party,issueDate:d.issueDate,...(d.dueDate?{dueDate:d.dueDate}:{}),balanceMinor:d.balanceMinor,...(d.originalTotalMinor!==undefined?{originalTotalMinor:d.originalTotalMinor}:{}),currency});
  // The opening books: stock and what customers owe on one side, what is owed
  // to suppliers and the opening equity on the other.
  const lines=[];let debit=0,credit=0;
  const stock=[...data.positions.values()].reduce((n,p)=>n+p.totalCostMinor,0);
  if(stock){lines.push({accountKey:'INVENTORY_ASSET',debitMinor:stock});debit+=stock;}
  const sumBy=(docs)=>{const m=new Map();for(const d of docs)m.set(d.party,(m.get(d.party)||0)+d.balanceMinor);return m;};
  for(const [customerKey,amount] of sumBy(data.ars)){lines.push({accountKey:'ACCOUNTS_RECEIVABLE',customerKey,debitMinor:amount});debit+=amount;}
  for(const [supplierKey,amount] of sumBy(data.aps)){lines.push({accountKey:'ACCOUNTS_PAYABLE',supplierKey,creditMinor:amount});credit+=amount;}
  if(debit!==credit)lines.push(debit>credit?{accountKey:'OPENING_BALANCE_EQUITY',creditMinor:debit-credit}:{accountKey:'OPENING_BALANCE_EQUITY',debitMinor:credit-debit});
  if(lines.length>=2)push('opening_journal','opening',{currency,postingDate:startDate,lines});
  return out;
}

// ---- Authority --------------------------------------------------------------------------

async function power(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'automatic'))
    return {automatic:false,reason:policy.usesAgentTerms(account)&&policy.permits(account.plan,JOB,'draft')?'On Growth you approve the migration plan and open the inventory yourself.':null};
  const stopped=await policy.stopped(db,workspaceId,account,ACTION,true);
  if(stopped)return {automatic:false,reason:stopped};
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)
    return {automatic:false,reason:'Handle routine work is off for this inventory, so you approve the migration and open the inventory.'};
  return {automatic:true,reason:null};
}

// ---- Starting ---------------------------------------------------------------------------

function totalsInput(input){
  const out={};
  const m=v=>clean(v)?readMoney(v,'The total'):null,q=v=>clean(v)?readQuantity(v,'The total'):null;
  if(clean(input.stockValue))out.stockValue=m(input.stockValue);
  if(clean(input.stockUnits))out.stockUnits=q(input.stockUnits);
  if(clean(input.receivables))out.receivables=m(input.receivables);
  if(clean(input.payables))out.payables=m(input.payables);
  return out;
}

async function start(db,ctx,input={}){
  await cutover.assertAccess(db,ctx);
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  if(policy.usesAgentTerms(state)){const stopped=await policy.stopped(db,ctx.workspaceId,state,ACTION,false);if(stopped&&!/first 14 days/.test(stopped))throw new ValidationError(stopped);}
  const files=(input.files||[]).filter(f=>Buffer.isBuffer(f.buffer)&&f.buffer.length);
  if(!files.length)throw new ValidationError('Choose the export files from your old system.');
  if(files.length>20)throw new ValidationError('Choose at most 20 export files.');
  if(input.sourceStopped!==true)throw new ValidationError('Confirm that these exports are final and the old system is frozen.');
  const accounting=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.base_currency;
  const currency=clean(input.currency||accounting||'').toUpperCase();
  if(!/^[A-Z]{3}$/.test(currency))throw new ValidationError('Choose the currency your old system keeps its books in.');
  money.code(currency);
  const startDate=clean(input.startDate);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(startDate)||!Number.isFinite(Date.parse(startDate+'T00:00:00Z')))throw new ValidationError('Choose the date your opening balances are for.');
  const found=plan(files,{currency,startDate,defaultLocation:input.defaultLocation,typedTotals:totalsInput(input)});
  if(found.problems.length)throw new ValidationError('StockChief stopped: '+found.problems.slice(0,5).map(p=>p.file+' line '+p.row+': '+p.message).join(' ')+
    (found.problems.length>5?' And '+(found.problems.length-5)+' more lines.':'')+' Correct the export and upload it again. Nothing was saved.');
  if(found.missing.length)throw new ValidationError('The export does not state its '+found.missing.map(m=>({stockUnits:'stock units',stockValue:'stock value',receivables:'total customers owe',payables:'total owed to suppliers'})[m]).join(', ')+
    '. Enter them from your old system’s report so StockChief can check every total. Nothing was saved.');
  const list=records(found.data,{currency,startDate});
  const counts=Object.fromEntries(Object.keys(cutover.TYPES).map(t=>[t,list.filter(r=>r.type===t).length]));
  const snapshot=sha(Buffer.concat(files.map(f=>Buffer.from(sha(f.buffer)))));
  const manifest={counts,accounting:{currency,startDate}};
  const label=clean(input.label)||files.map(f=>f.filename).join(', ').slice(0,150);
  const pkg=await cutover.create(db,ctx,{sourceNamespace:'old-system:'+snapshot.slice(0,32),sourceLabel:label,snapshotHash:snapshot,manifest});
  // A replay of the same exports continues an interrupted upload, else it
  // opens the migration already made from them.
  if(pkg.replayed&&pkg.status!=='STAGING')return {id:pkg.id,replayed:true};
  const oldSystem={version:1,tables:found.tables,exported:found.exported,computed:found.computed,differences:found.differences,
    files:files.map(f=>({name:f.filename,bytes:f.buffer.length,sha256:sha(f.buffer)})),startedBy:ctx.actorId};
  await db.transaction(async c=>{
    await c.query(`UPDATE migration_packages SET postgres_state=postgres_state||jsonb_build_object('oldSystem',$2::jsonb) WHERE id=$1`,[pkg.id,JSON.stringify(oldSystem)]);
    for(const [i,f] of files.entries())await c.query(`INSERT INTO ${sources}(package_id,workspace_id,position,file_name,sha256,content) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[pkg.id,ctx.workspaceId,i,f.filename,sha(f.buffer),f.buffer]);
    await audit.record(c,ctx,{action:'Old system migration read',reference:pkg.id,after:{files:oldSystem.files.map(f=>f.name),counts,differences:found.differences.length}});
  },{isolation:'READ COMMITTED'});
  for(let i=0;i<list.length;i+=cutover.MAX_PAGE)
    await cutover.stage(db,ctx,pkg.id,{batchKey:'old-system-page:'+i/cutover.MAX_PAGE,records:list.slice(i,i+cutover.MAX_PAGE).map(r=>({type:r.type,key:r.key,payload:r.payload}))});
  await require('./postgres-cutover-runner').seal(db,ctx,pkg.id,{sourceStopped:true,manifest});
  return {id:pkg.id,replayed:false,differences:found.differences};
}

// ---- After each worker step ---------------------------------------------------------------

// A person approves on Growth, or when a total differs. Pro and Custom approve
// and open the inventory on their own when every check matches.
async function afterStep(c,ctx,pkg){
  const plan=pkg.postgres_state?.oldSystem;
  if(!plan||!['READY','VERIFIED'].includes(pkg.status))return pkg;
  const owner=(await c.query("SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id WHERE w.id=$1 AND u.id=$2 AND u.role='owner'",[ctx.workspaceId,ctx.actorId])).rows[0];
  const can=owner?await power(c,ctx.workspaceId):{automatic:false,reason:'The migration was started by someone who is not the owner.'};
  const hold=async reason=>{await c.query(`UPDATE migration_packages SET postgres_state=jsonb_set(postgres_state,'{oldSystem,holdReason}',to_jsonb($2::text),true) WHERE id=$1`,[pkg.id,reason]);return pkg;};
  if(pkg.status==='READY'){
    if(plan.differences?.length)return hold('The export’s totals and its records differ. A person decides.');
    if(!can.automatic)return hold(can.reason||'A person approves this migration.');
    const approved=await cutover.approve(scoped(c),ctx,pkg.id,pkg.postgres_state.sealedHash);
    await c.query(`UPDATE migration_packages SET postgres_state=jsonb_set(jsonb_set(postgres_state,'{oldSystem,agentApproved}','true'::jsonb,true),'{oldSystem,holdReason}','null'::jsonb,true) WHERE id=$1`,[pkg.id]);
    await audit.record(c,ctx,{action:'Old system migration approved by StockChief',reference:pkg.id,after:{exported:plan.exported,computed:plan.computed}});
    return {...approved,postgres_state:{...approved.postgres_state,oldSystem:{...plan,agentApproved:true}}};
  }
  if(!plan.agentApproved)return pkg;
  if(!can.automatic)return hold(can.reason||'A person opens this inventory.');
  const active=await cutover.activate(scoped(c),ctx,pkg.id,pkg.postgres_state.sealedHash);
  await audit.record(c,ctx,{action:'Inventory opened by StockChief after the migration matched',reference:pkg.id,after:{exported:plan.exported}});
  return active;
}

// Approving with totals that differ is the owner's explicit decision.
async function beforeApprove(db,ctx,id,input={}){
  const pkg=await cutover.get(db,ctx,id);
  const plan=pkg.postgres_state?.oldSystem;
  if(!plan)return;
  await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  if(plan.differences?.length){
    if(input.acceptDifferences!=='yes')throw new ValidationError('The export’s totals and its records differ. Correct the export, or tick that you accept the differences.');
    await audit.record(db,ctx,{action:'Old system migration differences accepted',reference:id,after:{differences:plan.differences}});
  }
}

// A person's approval or opening of an old-system migration is audited too.
async function recordDecision(db,ctx,id,action){
  const pkg=await cutover.get(db,ctx,id);
  if(!pkg.postgres_state?.oldSystem)return;
  await audit.record(db,ctx,{action:action==='approve'?'Old system migration approved by the owner':'Inventory opened by the owner after the migration',reference:id,after:{status:pkg.status}});
}

async function inbox(db,workspaceId){
  if(!await require('../db/schema-installed').has(db,sources))return [];
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return [];
  const rows=(await db.query(`SELECT id,source_label,status,problem_count,updated_at FROM migration_packages WHERE workspace_id=$1 AND postgres_state ? 'oldSystem'
    AND (status IN ('READY','VERIFIED','NEEDS_ATTENTION') OR status='RECONCILING' AND problem_count>0) ORDER BY updated_at LIMIT 5`,[workspaceId])).rows;
  return rows.map(r=>({kind:'migration',importance:'Needs You',priority:50,title:'Your data move needs you',
    happened:r.status==='READY'?'The migration plan for '+r.source_label+' is ready for your approval.':r.status==='VERIFIED'?'Every balance from '+r.source_label+' matches. Open the inventory when ready.':'Some records from '+r.source_label+' need review.',
    why:'StockChief does not open your books on a guess.',recommendation:'Review the migration.',href:'/erp-cutovers/'+encodeURIComponent(r.id),actionLabel:'Review the migration',
    sourceId:'old-system:'+r.id,at:r.updated_at,createdAt:r.updated_at}));
}

module.exports={JOB,ACTION,FAMILIES,family,plan,records,power,start,afterStep,beforeApprove,recordDecision,inbox,totalsInput};
