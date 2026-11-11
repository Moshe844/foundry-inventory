'use strict';

const {ValidationError}=require('../domain/errors');
const exact=require('../domain/exact-quantity');
const money=require('../domain/currency');
const budgets=require('./agent-budgets');
const reorder=require('./agent-reorder-workflows');
const {addDays}=require('../accounting/customer-money');
const {hash}=require('../pricing/postgres-promotions');

const scale=6,factor=1000000n;
const atoms=value=>BigInt(exact.atoms(value,scale));
const ceil=(a,b)=>(a+b-1n)/b;
function gcd(a,b){while(b)[a,b]=[b,a%b];return a;}
const key=(category,currency)=>JSON.stringify([category,currency]);

function quote(row,headroom){
  const o=row.chosen;
  if(o.totalMinor<=headroom)return {quantity:o.quantity,purchaseUnits:o.purchaseUnits,secondaryQuantity:o.secondaryQuantity??null,amount:o.totalMinor};
  if(row.profile.secondary_unit_label)return null;
  const multiple=atoms(o.order_multiple),pack=atoms(o.units_per_purchase_unit),stockStep=atoms(row.profile.quantity_increment);
  const denominator=stockStep*factor,increment=denominator/gcd(pack*multiple,denominator);
  const minimum=ceil(atoms(o.minimum_order_quantity),multiple*increment)||1n;
  let low=minimum,high=atoms(o.purchaseUnits)/(multiple*increment),result=null;
  while(low<=high){
    const middle=(low+high)/2n,counts=middle*multiple*increment;
    const purchaseUnits=exact.fromAtoms(Number(counts),scale);
    const quantity=exact.convert(purchaseUnits,{numerator:String(o.units_per_purchase_unit),precision:Number(row.profile.quantity_precision)});
    const amount=exact.costMinor(quantity,o.unitCostMinor);
    if(amount>headroom)high=middle-1n;
    else{result={quantity,purchaseUnits,secondaryQuantity:null,amount};low=middle+1n;}
  }
  return result;
}

function offerFacts(o){
  return [o.id,o.supplier_id,o.supplier_sku,o.currency,String(o.last_unit_cost),String(o.units_per_purchase_unit),o.purchase_unit,
    String(o.minimum_order_quantity),String(o.order_multiple),o.minimum_order_amount,o.payment_terms,
    o.freight_terms_currency,o.free_freight_threshold_minor,o.ordinary_freight_minor,o.lead_time_days,
    o.default_lead_time_days,o.effective_lead??null,o.samples??null];
}

function rank(row){
  const available=Number(row.available),rate=row.position.dailyRate;
  return [available<=0?0:1,rate>0?Math.max(0,available)/rate:Number.MAX_SAFE_INTEGER,row.chosen.leadDays??Number.MAX_SAFE_INTEGER];
}
function compare(a,b){
  const x=rank(a),y=rank(b);
  return x[0]-y[0]||x[1]-y[1]||y[2]-x[2]||a.position.code.localeCompare(b.position.code)||a.locationId.localeCompare(b.locationId);
}
function detail(row){
  return {skuId:row.position.sku_id,code:row.position.code,locationId:row.locationId,location:row.position.location_name,
    category:row.profile.budget_category||'',currency:row.chosen.currency,supplier:row.chosen.supplier_name,
    needed:row.needed,available:row.available,incoming:row.incoming,stockUnit:row.profile.unit_label};
}

async function plan(c,ctx,input){
  const {start,next}=budgets.period(input.month),end=addDays(next,-1);
  const today=await require('../lib/business-time').today(c,ctx.workspaceId);
  if(end<today)throw new ValidationError('Choose the current or a future budget month for purchase planning.');
  const request=reorder.input({secondaryQuantities:input.secondaryQuantities},false);
  const source=await reorder.facts(c,ctx,request,false,{collect:true,throughDate:end});
  const rows=await budgets.headroom(c,ctx.workspaceId,{month:input.month,today});
  const current=new Map(rows.map(row=>[key(row.category,row.currency),row])),remaining=new Map(rows.map(row=>[key(row.category,row.currency),row.remaining]));
  const held=[...source.held],groups=new Map();
  for(const row of source.rows.sort(compare)){
    const o=row.chosen,summary=detail(row),fund=current.get(key(summary.category,o.currency));
    if(o.leadDays==null||!Number.isSafeInteger(o.leadDays)||o.leadDays<0){
      held.push({...summary,reason:'Record the saved supplier’s delivery lead time.'});continue;
    }
    const earliest=addDays(today,o.leadDays);
    if(earliest>end){held.push({...summary,reason:'Recorded lead time places the delivery after this budget month.',earliest});continue;}
    if(!fund||fund.budget===null){held.push({...summary,reason:'This category and currency have no approved budget for the month.'});continue;}
    if(fund.remaining===null){held.push({...summary,reason:'Review undated, overdue, unpriced or unmeasured purchase commitments before allocating this budget.'});continue;}
    const orderDate=earliest<start?addDays(start,-o.leadDays):today,expectedDate=addDays(orderDate,o.leadDays);
    const groupKey=JSON.stringify([o.supplier_id,o.currency,orderDate]);
    if(!groups.has(groupKey))groups.set(groupKey,{supplierId:o.supplier_id,supplierName:o.supplier_name,currency:o.currency,orderDate,items:[]});
    groups.get(groupKey).items.push({row,summary,expectedDate});
  }
  const output=[];
  for(const group of groups.values()){
    const proposed=new Map(),lines=[],deferred=[];
    for(const {row,summary,expectedDate} of group.items){
      const o=row.chosen,budgetKey=key(summary.category,summary.currency),capacity=proposed.has(budgetKey)?proposed.get(budgetKey):remaining.get(budgetKey);
      const packed=capacity<0?null:quote(row,capacity);
      if(!packed){
        deferred.push({...summary,reason:row.profile.secondary_unit_label?
          'The exact independently measured request exceeds this category’s headroom. Confirm a new quantity and weight before changing it.':
          'The remaining category budget cannot fund a complete supplier pack or the order minimum.'});
        continue;
      }
      proposed.set(budgetKey,capacity-packed.amount);
      lines.push({...summary,skuCode:summary.code,destinationLocationId:row.locationId,quantityUnits:packed.quantity,
        quantityPurchaseUnits:packed.purchaseUnits,unitsPerPurchaseUnit:o.units_per_purchase_unit,purchaseUnit:o.purchase_unit,
        unitCost:String(o.last_unit_cost),secondaryQuantity:packed.secondaryQuantity,secondaryUnit:row.profile.secondary_unit_label||null,
        supplierSku:o.supplier_sku,amountMinor:packed.amount,leadDays:o.leadDays,expectedDate,
        orderMultiple:String(o.order_multiple),minimumOrderQuantity:String(o.minimum_order_quantity),
        fullQuantity:o.quantity,fullAmountMinor:o.totalMinor,offerId:o.id,offerHash:hash(offerFacts(o)),
        knownTerms:row.knownTerms,incomingRecords:row.datedIncomingRecords,
        stockProof:hash([row.position.source_version,row.position.reorderPoint,row.position.targetStock,row.position.committed,
          row.available,row.incoming,row.datedIncomingRecords])});
    }
    const offer=group.items[0].row.chosen,totalMinor=money.sum(lines.map(line=>line.amountMinor)),
      minimum=offer.minimum_order_amount==null?null:money.toMinor(String(offer.minimum_order_amount),group.currency);
    if(lines.length&&minimum!==null&&totalMinor<minimum){
      held.push(...group.items.map(({summary})=>({...summary,reason:'The affordable group is below the supplier’s recorded minimum order value.'})));
      continue;
    }
    held.push(...deferred);
    if(!lines.length)continue;
    for(const [budgetKey,amount] of proposed)remaining.set(budgetKey,amount);
    const {items,...identity}=group;
    output.push({...identity,expectedDate:lines.reduce((date,line)=>date>line.expectedDate?date:line.expectedDate,''),
      totalMinor,minimumOrderMinor:minimum,lines});
  }
  const capacity=rows.map(row=>({...row,planned:row.remaining===null?0:row.remaining-remaining.get(key(row.category,row.currency)),
    afterPlan:remaining.get(key(row.category,row.currency))}));
  return {month:input.month,today,request:{secondaryQuantities:request.secondaryQuantities},capacity,groups:output,held};
}

module.exports={plan,key,offerFacts};
