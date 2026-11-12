'use strict';

// Job 100: each invoice difference in a supplier dispute, written with its
// evidence (the purchase-order line and agreed price, the receipts, earlier
// invoices and agreed charges and tax) and the amount it puts in question.
// An amount is null when the records cannot price the difference exactly;
// then the whole invoice is in question and a person decides.

const money=require('../domain/currency');
const exact=require('../domain/exact-quantity');
const businessTime=require('../lib/business-time');

const LINE_KINDS=new Set(['price_outside_approved_cost','invoice_ahead_of_receipt','line_total_differs',
  'invoice_exceeds_receipt_value','invoice_receipt_value_differs']);
const LABELS={invoice_measure_mismatch:'The billed quantity and weight do not both agree with the same received stock.',
  invoice_tracking_not_received:'The invoice identifies a batch or serial that does not match the recorded receipt.',
  invoice_tracking_already_billed:'The invoice repeats batch or serial quantities already billed.',
  invoice_serial_count_differs:'The listed serial count does not agree with the billed quantity.',
  invoice_serial_weight_differs:'The weights of the listed serials do not add up to the invoiced weight.',
  invoice_exceeds_receipt_value:'The billed line value exceeds the recorded receipt value.',
  invoice_receipt_value_differs:'The billed line value differs from the recorded receipt value.',
  line_total_differs:'The listed line amount differs from its quantity and price.'};
const key=c=>c.kind+'\u0000'+String(c.label||'').trim().toLowerCase();
const quantity=value=>String(Number(value));
const clamp=(value,low,high)=>Number(value)<Number(low)?String(low):Number(value)>Number(high)?String(high):String(value);

async function records(db,workspaceId,bill){
  const lines=(await db.query(`SELECT p.id,p.sku_id,p.quantity_units,p.unit_cost,s.code,po.po_number,po.currency purchase_currency
    FROM purchase_order_lines p JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id
    JOIN purchase_orders po ON po.workspace_id=p.workspace_id AND po.id=p.purchase_order_id
    WHERE p.workspace_id=$1 AND p.purchase_order_id=$2 ORDER BY p.id`,[workspaceId,bill.purchase_order_id])).rows;
  const receipts=(await db.query(`SELECT rl.purchase_order_line_id line_id,r.received_at,r.reference,rl.quantity_units
    FROM purchase_order_receipt_lines rl JOIN purchase_order_receipts r ON r.workspace_id=rl.workspace_id AND r.id=rl.receipt_id
    WHERE rl.workspace_id=$1 AND r.purchase_order_id=$2 ORDER BY r.received_at,rl.id`,[workspaceId,bill.purchase_order_id])).rows;
  const earlier=(await db.query(`SELECT b.id,coalesce(b.supplier_invoice_number,b.bill_number) number,b.currency,b.charges,b.tax_minor,
      array_remove(array_agg(DISTINCT l.purchase_order_line_id),NULL) line_ids
    FROM accounting_supplier_bills b LEFT JOIN accounting_supplier_bill_lines l ON l.workspace_id=b.workspace_id AND l.bill_id=b.id
    WHERE b.workspace_id=$1 AND b.purchase_order_id=$2 AND b.id<>$3 AND b.status IN('OPEN','PARTIALLY_PAID','PAID')
    GROUP BY b.id ORDER BY min(b.created_at),b.id`,[workspaceId,bill.purchase_order_id,bill.id])).rows;
  const agreed=(await db.query(`SELECT kind,label,amount_minor FROM purchase_order_charges
    WHERE workspace_id=$1 AND purchase_order_id=$2 AND kind<>'deposit' ORDER BY id`,[workspaceId,bill.purchase_order_id])).rows;
  const {timeZone}=await businessTime.forWorkspace(db,workspaceId);
  return {lines,receipts,earlier,agreed,day:at=>businessTime.context(timeZone,new Date(at)).calendarDate};
}

// Charges above what the purchase order agreed, net of earlier invoices: the
// same budget supplier invoice matching uses.
function chargeOvercharge(bill,agreed,earlier){
  const budget=new Map();
  for(const c of agreed)if(c.kind!=='tax')budget.set(key(c),money.sum([budget.get(key(c))||0,Number(c.amount_minor)]));
  for(const prior of earlier)if(prior.currency===bill.currency)for(const c of prior.charges||[])if(budget.has(key(c)))budget.set(key(c),budget.get(key(c))-Number(c.amountMinor));
  const requested=new Map();
  for(const c of bill.charges||[])requested.set(key(c),money.sum([requested.get(key(c))||0,Number(c.amountMinor)]));
  let over=0;
  for(const [k,n] of requested){
    const allowed=budget.get(k);
    if(n>=0)over+=Math.max(0,n-Math.max(0,allowed??0));
    else if(allowed!=null)over+=Math.max(0,n-allowed);
  }
  return over;
}

async function explain(db,ctx,bill,preview){
  const facts=await records(db,ctx.workspaceId,bill),{lines,receipts,earlier,agreed,day}=facts;
  const po=lines[0]?.po_number||'our purchase order',currency=bill.currency;
  const format=minor=>money.format(minor,currency);
  const inputLines=bill.invoice_input?.lines||[];
  const poLine=n=>{const id=inputLines[n-1]?.purchaseOrderLineId,line=preview.lines[n-1];
    return lines.find(l=>l.id===id)||lines.find(l=>l.sku_id===line?.skuId)||null;};
  const label=d=>poLine(d.line)?.code||'Invoice line '+d.line;
  const open=preview.differences.filter(d=>!d.approved);
  const received=line=>{const rows=receipts.filter(r=>r.line_id===line?.id);
    return rows.length?' Received on '+po+': '+rows.map(r=>quantity(r.quantity_units)+' on '+day(r.received_at)+(r.reference?' (delivery note '+r.reference+')':'')).join(', ')+'.'
      :' Nothing has been received on '+po+' for this item yet.';};
  const billedBefore=line=>{const numbers=earlier.filter(b=>b.line_ids.includes(line?.id)).map(b=>b.number);
    return numbers.length?' Already billed on invoice '+numbers.join(', ')+'.':'';};

  // One amount per invoice line, so a price and a quantity difference on the
  // same line are not counted twice.
  const lineAmount=new Map();
  for(const n of new Set(open.filter(d=>d.line).map(d=>d.line))){
    const found=open.filter(d=>d.line===n),line=preview.lines[n-1];
    if(!line||found.some(d=>!LINE_KINDS.has(d.kind))){lineAmount.set(n,null);continue;}
    const over=found.find(d=>d.kind==='invoice_exceeds_receipt_value');
    if(over||found.some(d=>d.kind==='invoice_receipt_value_differs')){
      lineAmount.set(n,over?Math.max(0,Number(over.previouslyBilledMinor)+Number(over.billedMinor)-Number(over.receivedValueMinor)):0);continue;
    }
    const ahead=found.find(d=>d.kind==='invoice_ahead_of_receipt'),price=found.find(d=>d.kind==='price_outside_approved_cost');
    if(price&&price.approvedUnitCostMinor==null||ahead&&line.secondaryQuantity!=null){lineAmount.set(n,null);continue;}
    const allowed=ahead?clamp(exact.subtract(quantity(ahead.received),quantity(ahead.previouslyBilled)),0,line.quantity):String(line.quantity);
    const measure=line.secondaryQuantity!=null?line.secondaryQuantity:allowed;
    const expected=price?exact.costMinor(measure,price.approvedUnitCostMinor)
      :exact.costMinor(measure,line.unitCostMinor,{perQuantity:line.priceQuantity||1});
    lineAmount.set(n,Math.max(0,Number(line.lineTotalMinor)-expected));
  }

  const taxDifference=open.find(d=>d.kind==='invoice_tax_differs');
  const taxOverMinor=taxDifference?Math.max(0,Number(taxDifference.billedTaxMinor)-Number(taxDifference.agreedTaxMinor)):0;
  const agreedTax=money.sum(agreed.filter(c=>c.kind==='tax').map(c=>Number(c.amount_minor)));
  const earlierTax=money.sum(earlier.filter(b=>b.currency===currency).map(b=>Number(b.tax_minor)));
  const agreedCharges=agreed.filter(c=>c.kind!=='tax').map(c=>c.label+' '+format(Number(c.amount_minor)));
  const counted=new Set();
  const differences=open.map(d=>{
    let amountMinor=null,text;
    if(d.line&&!counted.has(d.line)){counted.add(d.line);amountMinor=lineAmount.get(d.line);}
    else if(d.line)amountMinor=lineAmount.get(d.line)==null?null:0;
    const line=d.line?poLine(d.line):null;
    if(d.kind==='price_outside_approved_cost')text=label(d)+': '+(d.approvedUnitCostMinor==null?'our purchase order has no confirmed unit price'
      :'our approved purchase-order price is '+money.format(d.approvedUnitCostMinor,line?.purchase_currency||currency)+' per approved pricing unit on '+po
        +(line?' ('+quantity(line.quantity_units)+' ordered)':''))
      +'; the invoice shows '+money.format(d.billedUnitCostMinor,currency)+' per '+(d.priceQuantity||1)+' pricing unit(s).';
    else if(d.kind==='invoice_ahead_of_receipt')text=label(d)+': our records show '+d.received+' stock units received and '+d.previouslyBilled
      +' stock units already billed. The saved invoice line uses '+d.billed+' stock units.'+received(line)+billedBefore(line);
    else if(d.kind==='invoice_weight_ahead_of_receipt')text=label(d)+': our records show '+d.received+' '+d.unit+' received and '+d.previouslyBilled
      +' previously billed. The invoice shows '+d.billed+' '+d.unit+'.'+received(line)+billedBefore(line);
    else if(d.kind==='document_total_differs'){
      text='Our saved document total is '+format(d.documentTotalMinor)+'; the saved lines, charges and tax calculate to '+format(d.calculatedTotalMinor)+'. Please confirm the original invoice total.';
      amountMinor=Math.max(0,Number(d.documentTotalMinor)-Number(d.calculatedTotalMinor));
    }else if(d.kind==='invoice_currency_differs')text='The purchase order is in '+d.approvedCurrency+'; this invoice is in '+d.billedCurrency+'. Please confirm the agreed currency.';
    else if(d.kind==='additional_charges_require_review'){
      text='Please identify the agreed basis for the invoice charges ('+(bill.charges||[]).map(c=>c.label+' '+format(c.amountMinor)).join(', ')+'). '
        +(agreedCharges.length?'Purchase order '+po+' agreed '+agreedCharges.join(', ')+'.':'Purchase order '+po+' has no agreed extra charges.');
      amountMinor=chargeOvercharge(bill,agreed,earlier);
    }else if(d.kind==='invoice_tax_differs'){
      text='Purchase order '+po+' agreed '+format(agreedTax)+' tax'+(earlierTax?', and '+format(earlierTax)+' of it is already billed':'')
        +'. This invoice charges '+format(d.billedTaxMinor)+' tax.';
      amountMinor=taxOverMinor;
    }else text=(d.line?label(d)+': ':'')+(LABELS[d.kind]||require('./postgres-invoice-review').differenceLabel(d.kind));
    return {kind:d.kind,text,amountMinor};
  });
  const ceiling=Math.max(Number(bill.total_minor),Number(bill.document_total_minor||0));
  const disputedMinor=differences.some(d=>d.amountMinor==null)?null:Math.min(ceiling,money.sum(differences.map(d=>d.amountMinor)));
  return {purchaseOrderNumber:lines[0]?.po_number||null,differences,disputedMinor,taxOverMinor};
}

module.exports={explain};
