'use strict';

const {documents,addDays} = require('./customer-money');
const money = require('../domain/currency');

function terms(text) {
  const value=String(text||'').trim();
  const net=/^net\s*(\d{1,3})\s*(?:days?)?$/i.exec(value);
  if(net) return {net:Number(net[1])};
  const match=/^(\d{1,2}(?:\.\d{1,2})?)\s*%?\s*\/\s*(\d{1,3})\s*[,;]?\s*(?:net|n)\s*\/?\s*(\d{1,3})$/i.exec(value);
  if(!match || Number(match[1])<=0 || Number(match[2])>Number(match[3])) return {};
  return {percent:Number(match[1]),days:Number(match[2]),net:Number(match[3])};
}

function opportunity(bill,today) {
  const term=terms(bill.agreed_discount_terms);
  if(!term.percent || bill.balance_minor!==Number(bill.total_minor) || bill.issue_date>today) return null;
  const deadline=addDays(bill.issue_date,term.days);
  if(deadline<today) return null;
  const basis=money.integer(bill.subtotal_minor,bill.currency);
  const minor=Number((BigInt(basis)*BigInt(Math.round(term.percent*100))+5000n)/10000n);
  return minor>0 && minor<=bill.balance_minor ? {deadline,minor} : null;
}

async function payments(db,ctx,{today,discountsOnly=false}) {
  const bills=await documents(db,ctx.workspaceId,'bills',today);
  const end=addDays(today,6),rows=[];
  for(const bill of bills){
    const offer=opportunity(bill,today);
    const due=bill.due_date || (terms(bill.agreed_discount_terms).net!=null ? addDays(bill.issue_date,terms(bill.agreed_discount_terms).net) : null);
    if(discountsOnly ? !offer : !(offer && offer.deadline<=end) && due && due>end) continue;
    rows.push({Supplier:bill.party_name,Bill:bill.number,Due:due||'Confirm due date',
      Balance:money.format(bill.balance_minor,bill.currency),'Discount deadline':offer?.deadline||'',
      'Possible saving':offer?money.format(offer.minor,bill.currency):'',
      'Review amount':money.format(bill.balance_minor-(offer?.minor||0),bill.currency),link:bill.href});
  }
  return {summary:discountsOnly?'Unpaid posted bills within documented early-payment terms. Confirm the discount basis with the supplier.':
    'Bills due through '+end+', discount deadlines this week and bills needing a due date. Review each bill before paying.',rows};
}

async function forecast(db,ctx,{today,adviceOnly=false}) {
  const books=await documents(db,ctx.workspaceId,'bills',today);
  const invoices=await documents(db,ctx.workspaceId,'invoices',today);
  const lines=(await db.query(`WITH billed AS (
    SELECT bl.purchase_order_line_id,sum(bl.quantity) AS units FROM accounting_supplier_bill_lines bl
    JOIN accounting_supplier_bills b ON b.workspace_id=bl.workspace_id AND b.id=bl.bill_id
    WHERE bl.workspace_id=$1 AND b.status IN ('OPEN','PARTIALLY_PAID','PAID') GROUP BY bl.purchase_order_line_id)
    SELECT p.po_number,p.currency,p.expected_date,s.payment_terms,l.unit_cost,l.secondary_quantity_ordered,
      greatest(l.quantity_units-coalesce(b.units,0),0) AS unbilled
    FROM purchase_orders p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id
    JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id
    LEFT JOIN billed b ON b.purchase_order_line_id=l.id WHERE p.workspace_id=$1 AND p.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED')
    AND l.quantity_units>coalesce(b.units,0)`,[ctx.workspaceId])).rows;
  const currencies=new Map(),undated=new Set();
  function add(currency,date,amount,kind,reference){
    if(!currencies.has(currency)) currencies.set(currency,Array.from({length:13},()=>({incoming:0,bills:0,purchases:0})));
    if(!date || amount===null){undated.add(reference);return;}
    const days=Math.round((Date.parse(date)-Date.parse(today))/86400000),index=Math.max(0,Math.floor(days/7));
    if(index<13) {const week=currencies.get(currency)[index];week[kind]=money.sum([week[kind],amount]);}
  }
  for(const b of books)add(b.currency,b.due_date,b.balance_minor,'bills',b.number);
  for(const i of invoices)add(i.currency,i.due_date,i.balance_minor,'incoming',i.number);
  for(const l of lines){
    const net=terms(l.payment_terms).net;
    const amount=l.unit_cost==null || l.secondary_quantity_ordered!=null ? null :
      require('../domain/exact-quantity').costMinor(l.unbilled,money.toMinor(l.unit_cost,l.currency));
    add(l.currency,l.expected_date && net!=null ? addDays(l.expected_date,net) : null,amount,'purchases',l.po_number);
  }
  const rows=[];
  for(const [currency,weeks] of [...currencies].sort(([a],[b])=>a.localeCompare(b))){
    let suggested=false;
    weeks.forEach((w,index)=>{
      const week=addDays(today,index*7),net=money.sum([w.incoming,-w.bills,-w.purchases]);
      if(adviceOnly){
        if(!suggested && net<0){rows.push({Currency:currency,'Week beginning':week,Review:'Expected payments exceed expected receipts.'});suggested=true;}
        return;
      }
      rows.push({'Week beginning':week,Currency:currency,'Customer receipts':money.format(w.incoming,currency),
        'Supplier bills':money.format(w.bills,currency),'Unbilled PO goods':money.format(w.purchases,currency),'Net flow':money.format(net,currency)});
    });
    if(adviceOnly && !suggested)rows.push({Currency:currency,'Week beginning':today,Review:'No negative week among dated records.'});
  }
  return {summary:'Overdue amounts enter week one. Unbilled goods use expected delivery plus supplier terms. Unbilled freight, tax, deposits and opening bank balances are excluded. '+undated.size+' documents need a date or price.'+
    (undated.size?' Review '+[...undated].slice(0,8).join(', ')+'.':''),rows};
}
module.exports={payments,forecast,terms};
