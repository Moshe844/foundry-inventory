'use strict';

// One deterministic quote calculator. All amounts are integral minor units;
// dates, configuration and cost evidence are explicit inputs, never globals.
const {ValidationError}=require('../domain/errors');
const invalid=message=>{throw new ValidationError(message);};
function integer(value,label,{min=0,max=Number.MAX_SAFE_INTEGER}={}){
  if(!Number.isSafeInteger(value)||value<min||value>max)invalid(`${label} is outside its supported range.`);return value;
}
function number(value){const n=Number(value);return integer(n,'Calculated amount');}
const QUANTITY_SCALE=1000000;
function quantityScaled(value,fractional=false){
  if(!fractional)return integer(value,'Quantity',{min:1,max:1000000})*QUANTITY_SCALE;
  const text=String(value);if(!/^\d+(?:\.\d{1,6})?$/.test(text))invalid('Quantity supports at most six decimal places.');
  const [whole,fraction='']=text.split('.'),scaled=Number(whole)*QUANTITY_SCALE+Number(fraction.padEnd(6,'0'));
  return integer(scaled,'Quantity',{min:1,max:1000000*QUANTITY_SCALE});
}
function extended(amount,scaledQuantity){return ratio(amount,scaledQuantity,QUANTITY_SCALE);}
function ratio(value,numerator,denominator){
  integer(value,'Amount');integer(numerator,'Numerator');integer(denominator,'Denominator',{min:1});
  return number((BigInt(value)*BigInt(numerator)+BigInt(denominator)/2n)/BigInt(denominator));
}
function sum(values){return number(values.reduce((n,value)=>n+BigInt(integer(value,'Amount')),0n));}
function allocate(amount,weights){
  integer(amount,'Amount');weights.forEach(w=>integer(w,'Allocation weight'));const total=sum(weights);
  if(!total){if(amount)invalid('A nonzero amount needs an allocation basis.');return weights.map(()=>0);}
  const parts=weights.map((weight,index)=>({index,value:BigInt(amount)*BigInt(weight)/BigInt(total),remainder:BigInt(amount)*BigInt(weight)%BigInt(total)}));
  let remainder=BigInt(amount)-parts.reduce((n,p)=>n+p.value,0n);
  const ranked=[...parts].sort((a,b)=>a.remainder===b.remainder?a.index-b.index:a.remainder>b.remainder?-1:1);
  for(const part of ranked){if(!remainder)break;part.value++;remainder--;}
  return parts.map(p=>number(p.value));
}
function active(rule,at,currency){return rule.enabled!==false&&rule.currency===currency&&
  (!rule.startsAt||Date.parse(rule.startsAt)<=at)&&(!rule.endsAt||at<Date.parse(rule.endsAt));}
function eligible(scope={},line,customerId){return (!scope.customerIds?.length||scope.customerIds.includes(customerId))&&
  (!scope.skuIds?.length||scope.skuIds.includes(line.skuId))&&(!scope.categoryIds?.length||scope.categoryIds.includes(line.categoryId));}
function stable(a,b){return (b.priority||0)-(a.priority||0)||String(a.id).localeCompare(String(b.id),'en');}
function validateRule(rule){
  if(!rule||!['price_list','promotion','guard'].includes(rule.kind))invalid('Choose a price list, promotion or pricing guard.');
  const common=['kind','name','currency','enabled','priority','scope','startsAt','endsAt','id','version','redemptions','customerRedemptions','createdAt'],specific={price_list:['entries'],promotion:['discount','stacking','code','stackGroup','excludes','minimumOrderMinor','minimumQuantity','maxRedemptions','maxPerCustomer'],guard:['minimumMarginBps','maximumDiscountBps']}[rule.kind];
  if(Object.keys(rule).some(key=>![...common,...specific].includes(key)))invalid('This pricing rule contains an unsupported term. Review its complete definition.');
  if(rule.scope!==undefined&&(!rule.scope||typeof rule.scope!=='object'||Array.isArray(rule.scope)))invalid('Pricing scope must contain product, category or customer selections.');
  if(typeof rule.name!=='string'||!rule.name.trim()||rule.name.length>160)invalid('Give this pricing rule a name.');
  if(typeof rule.currency!=='string'||!/^[A-Z]{3}$/.test(rule.currency))invalid('Choose a recorded three-letter currency.');
  try{if(new Intl.NumberFormat('en',{style:'currency',currency:rule.currency}).resolvedOptions().maximumFractionDigits!==2)invalid('This currency needs precision that the current accounting engine does not support.');}catch{invalid('Choose a supported accounting currency.');}
  if(rule.priority!==undefined)integer(rule.priority,'Priority',{min:-100000,max:100000});
  for(const key of ['startsAt','endsAt'])if(rule[key]&&(typeof rule[key]!=='string'||!/T/.test(rule[key])||!/(Z|[+-]\d{2}:\d{2})$/.test(rule[key])||!Number.isFinite(Date.parse(rule[key]))))invalid('Use explicit UTC start and end dates.');
  if(rule.startsAt&&rule.endsAt&&Date.parse(rule.startsAt)>=Date.parse(rule.endsAt))invalid('The promotion must end after it starts.');
  if(rule.enabled!==undefined&&typeof rule.enabled!=='boolean')invalid('Enabled must be true or false.');
  for(const [field,values]of Object.entries(rule.scope||{})){if(!['customerIds','skuIds','categoryIds'].includes(field)||!Array.isArray(values)||values.length>500||values.some(v=>typeof v!=='string'||!v))invalid('Choose valid product, category and customer scopes.');}
  if(rule.kind==='price_list'){
    if(!Array.isArray(rule.entries)||!rule.entries.length||rule.entries.length>500)invalid('Add at least one price-list entry.');
    const seen=new Set();for(const entry of rule.entries){if(!entry||typeof entry.skuId!=='string'||!entry.skuId||Object.keys(entry).some(k=>!['skuId','minQuantity','unitPriceMinor'].includes(k)))invalid('Each price needs an exact product and supported tier fields.');integer(entry.minQuantity,'Price tier quantity',{min:1});integer(entry.unitPriceMinor,'Tier price');const key=entry.skuId+':'+entry.minQuantity;if(seen.has(key))invalid('A product cannot repeat the same quantity tier.');seen.add(key);}
  }
  if(rule.kind==='promotion'){
    if(!['percent','fixed_order','fixed_line','fixed_unit','bundle'].includes(rule.discount?.type))invalid('Choose a supported discount type.');
    if(Object.keys(rule.discount).some(key=>!['type','value','items'].includes(key)))invalid('The discount contains an unsupported term.');
    if(!['stack','exclusive'].includes(rule.stacking||'exclusive'))invalid('Choose stacking or exclusive discounts.');
    if(rule.discount.type==='percent')integer(rule.discount.value,'Percentage in basis points',{max:10000});else integer(rule.discount.value,'Discount amount');
    if(rule.code!==undefined&&(typeof rule.code!=='string'||!rule.code.trim()||rule.code.length>80))invalid('Enter a valid discount code.');
    if(rule.stackGroup!==undefined&&(typeof rule.stackGroup!=='string'||!rule.stackGroup.trim()||rule.stackGroup.length>80))invalid('Enter a valid offer group.');
    if(rule.minimumOrderMinor!==undefined)integer(rule.minimumOrderMinor,'Minimum order');
    if(rule.minimumQuantity!==undefined)integer(rule.minimumQuantity,'Minimum quantity',{min:1});
    for(const key of ['maxRedemptions','maxPerCustomer'])if(rule[key]!==undefined)integer(rule[key],key,{min:1});
    if(rule.excludes!==undefined&&(!Array.isArray(rule.excludes)||rule.excludes.length>500||rule.excludes.some(v=>typeof v!=='string'||!v)))invalid('Choose valid excluded promotions.');
    if(rule.discount.type==='bundle'){
      const items=rule.discount.items;if(!Array.isArray(items)||!items.length||items.length>50)invalid('Choose products and quantities for the bundle.');
      const skus=new Set();for(const item of items){if(!item.skuId||skus.has(item.skuId))invalid('Each bundle product must appear once.');skus.add(item.skuId);integer(item.quantity,'Bundle quantity',{min:1});}
    }
  }
  if(rule.kind==='guard'){
    if(rule.minimumMarginBps===undefined&&rule.maximumDiscountBps===undefined)invalid('Choose at least one margin or discount safeguard.');
    for(const field of ['minimumMarginBps','maximumDiscountBps'])if(rule[field]!==undefined)integer(rule[field],field,{max:10000});
  }
  return JSON.parse(JSON.stringify(rule));
}
function quote(input){
  if(!Array.isArray(input.lines)||!input.lines.length||input.lines.length>500)invalid('Choose between one and 500 order lines.');
  if(input.codes!==undefined&&(!Array.isArray(input.codes)||input.codes.length>50||input.codes.some(c=>typeof c!=='string'||!c.trim()||c.length>80)))invalid('Choose at most 50 valid promotion codes.');
  const at=Date.parse(input.at);if(!Number.isFinite(at))invalid('An explicit pricing time is required.');
  const guardAt=input.guardAt?Date.parse(input.guardAt):at;if(!Number.isFinite(guardAt))invalid('An explicit safeguard evaluation time is required.');
  const rules=(input.rules||[]).map(validateRule).filter(r=>active(r,r.kind==='guard'?guardAt:at,input.currency)).sort(stable),codes=new Set((input.codes||[]).map(s=>String(s).trim().toUpperCase()));
  const lists=rules.filter(r=>r.kind==='price_list'),discounts=rules.filter(r=>r.kind==='promotion'),guards=rules.filter(r=>r.kind==='guard');
  const scaled=input.lines.map(line=>quantityScaled(line.quantity,input.allowFractionalQuantities===true));
  const quantities=new Map();input.lines.forEach((line,i)=>quantities.set(line.skuId,sum([quantities.get(line.skuId)||0,scaled[i]])));
  const lines=input.lines.map((line,index)=>{
    const quantity=scaled[index]/QUANTITY_SCALE,base=integer(line.unitPriceMinor,'Unit price');
    let selected=null,unitPriceMinor=base;const candidates=[];
    for(const list of lists){if(line.priceOverride===true||input.priceListId&&list.id!==input.priceListId||!eligible(list.scope,line,input.customerId))continue;
      const tier=list.entries.filter(e=>e.skuId===line.skuId&&e.minQuantity*QUANTITY_SCALE<=quantities.get(line.skuId)).sort((a,b)=>b.minQuantity-a.minQuantity)[0];
      if(tier)candidates.push({list,tier,specificity:(list.scope?.customerIds?.length?4:0)+(list.scope?.skuIds?.length?2:0)+(list.scope?.categoryIds?.length?1:0)});}
    candidates.sort((a,b)=>(b.list.priority||0)-(a.list.priority||0)||b.specificity-a.specificity||b.tier.minQuantity-a.tier.minQuantity||a.tier.unitPriceMinor-b.tier.unitPriceMinor||String(a.list.id).localeCompare(String(b.list.id),'en'));
    if(candidates.length){selected=candidates[0].list;unitPriceMinor=candidates[0].tier.unitPriceMinor;}
    const grossMinor=extended(unitPriceMinor,scaled[index]);
    return {index,skuId:line.skuId,categoryId:line.categoryId||null,quantity,priceOverride:line.priceOverride===true,baseUnitPriceMinor:base,unitPriceMinor,costUnitMinor:line.costUnitMinor??null,grossMinor,discountMinor:0,netMinor:grossMinor,priceSource:selected?{id:selected.id,version:selected.version}:null,adjustments:[]};
  });
  if(input.priceListId&&!lists.some(r=>r.id===input.priceListId&&lines.some(l=>l.priceSource?.id===r.id)))invalid('The selected price list is not applicable to this customer, currency or quantity.');
  const originalSubtotal=sum(lines.map(l=>l.grossMinor)),applied=[],groups=new Set();let exclusive=false;
  function apply(rule,indices,amount){
    const allocations=allocate(Math.min(amount,sum(indices.map(i=>lines[i].netMinor))),indices.map(i=>lines[i].netMinor));let total=0;
    indices.forEach((i,j)=>{if(allocations[j]){lines[i].discountMinor+=allocations[j];lines[i].netMinor-=allocations[j];lines[i].adjustments.push({ruleId:rule.id,version:rule.version,amountMinor:allocations[j]});total+=allocations[j];}});return total;
  }
  for(const rule of discounts){
    if(exclusive||rule.code&&!codes.has(rule.code.trim().toUpperCase())||originalSubtotal<(rule.minimumOrderMinor||0)||rule.stackGroup&&groups.has(rule.stackGroup)||applied.some(p=>rule.excludes?.includes(p.id)||p.excludes?.includes(rule.id))||((rule.stacking||'exclusive')==='exclusive'&&applied.length))continue;
    if(rule.maxRedemptions!==undefined&&(rule.redemptions||0)>=rule.maxRedemptions||rule.maxPerCustomer!==undefined&&(rule.customerRedemptions||0)>=rule.maxPerCustomer)continue;
    const indices=lines.filter(l=>eligible(rule.scope,l,input.customerId)&&l.quantity>=(rule.minimumQuantity||0)).map(l=>l.index);if(!indices.length)continue;
    let amount=0;
    if(rule.discount.type==='percent')for(const i of indices)amount+=apply(rule,[i],ratio(lines[i].netMinor,rule.discount.value,10000));
    else if(rule.discount.type==='fixed_unit')for(const i of indices)amount+=apply(rule,[i],extended(rule.discount.value,scaled[i]));
    else if(rule.discount.type==='fixed_line')for(const i of indices)amount+=apply(rule,[i],rule.discount.value);
    else if(rule.discount.type==='fixed_order')amount=apply(rule,indices,rule.discount.value);
    else{
      const items=rule.discount.items,quantityFor=sku=>sum(lines.filter(l=>indices.includes(l.index)&&l.skuId===sku).map(l=>scaled[l.index]));
      const bundles=Math.min(...items.map(item=>Math.floor(quantityFor(item.skuId)/(item.quantity*QUANTITY_SCALE))));
      if(bundles){const bundleIndices=indices.filter(i=>items.some(item=>item.skuId===lines[i].skuId));let covered=0;
        for(const item of items){let left=bundles*item.quantity*QUANTITY_SCALE;for(const i of bundleIndices.filter(i=>lines[i].skuId===item.skuId)){const take=Math.min(left,scaled[i]);covered+=ratio(lines[i].netMinor,take,scaled[i]);left-=take;}}
        amount=apply(rule,bundleIndices,Math.max(0,covered-number(BigInt(bundles)*BigInt(rule.discount.value))));}
    }
    if(amount){applied.push({id:rule.id,version:rule.version,name:rule.name,amountMinor:amount,excludes:rule.excludes});if(rule.stackGroup)groups.add(rule.stackGroup);exclusive=(rule.stacking||'exclusive')==='exclusive';}
  }
  const manual=integer(input.discountMinor??0,'Order discount');if(manual>sum(lines.map(l=>l.netMinor)))invalid('Order discount exceeds the remaining order value.');
  if(manual)apply({id:'manual',version:null},lines.map(l=>l.index),manual);
  const violations=[];
  for(const guard of guards)for(const line of lines){if(!eligible(guard.scope,line,input.customerId))continue;
    const source=input.lines[line.index];const reference=extended(integer(source.referenceUnitPriceMinor??line.baseUnitPriceMinor,'Reference price'),scaled[line.index]);
    if(guard.maximumDiscountBps!==undefined&&BigInt(Math.max(0,reference-line.netMinor))*10000n>BigInt(reference)*BigInt(guard.maximumDiscountBps))violations.push({ruleId:guard.id,skuId:line.skuId,kind:'discount_limit'});
    if(guard.minimumMarginBps!==undefined){if(line.costUnitMinor===null)violations.push({ruleId:guard.id,skuId:line.skuId,kind:'missing_cost_evidence'});
      else {const cost=BigInt(integer(line.costUnitMinor,'Recorded unit cost'))*BigInt(scaled[line.index]),revenue=BigInt(line.netMinor)*BigInt(QUANTITY_SCALE);if((revenue-cost)*10000n<revenue*BigInt(guard.minimumMarginBps))violations.push({ruleId:guard.id,skuId:line.skuId,kind:'minimum_margin'});}}
  }
  const taxMinor=integer(input.taxMinor??0,'Tax'),taxes=allocate(taxMinor,lines.map(l=>l.netMinor));
  lines.forEach((line,i)=>{line.taxMinor=taxes[i];line.totalMinor=sum([line.netMinor,line.taxMinor]);});
  return {version:1,at:input.at,currency:input.currency,customerId:input.customerId||null,lines,subtotalMinor:originalSubtotal,discountMinor:sum(lines.map(l=>l.discountMinor)),manualDiscountMinor:manual,taxMinor,totalMinor:sum(lines.map(l=>l.totalMinor)),applied:applied.map(({excludes,...p})=>p),policyVersions:rules.map(r=>({id:r.id,version:r.version})),codes:[...codes],unusedCodes:[...codes].filter(code=>!discounts.some(r=>r.code?.trim().toUpperCase()===code&&applied.some(p=>p.id===r.id))),priceListId:input.priceListId||null,violations};
}
// Cumulative allocation makes splitting a fulfillment or return conserve every
// penny; the final unit receives exactly the snapshot's remaining fraction.
function portion(total,quantity,before,take){integer(total,'Historical amount');integer(quantity,'Ordered quantity',{min:1});integer(before,'Already processed');integer(take,'Requested quantity');if(before+take>quantity)invalid('Quantity exceeds the historical line.');return number(BigInt(total)*BigInt(before+take)/BigInt(quantity)-BigInt(total)*BigInt(before)/BigInt(quantity));}
module.exports={quote,validateRule,allocate,ratio,portion};
