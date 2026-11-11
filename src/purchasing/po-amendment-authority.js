'use strict';

const exact=require('../domain/exact-quantity');
const money=require('../domain/currency');
const {hash}=require('../pricing/postgres-promotions');
const {ValidationError}=require('../domain/errors');
const {purchaseTotalsSql}=require('../operations/postgres-team-access');

function profile(line){
  return hash({sku:line.skuId,warehouse:line.locationId,unit:line.unit,weight:line.weightUnit,pack:line.pack,size:line.packSize});
}

function limits(input,p){
  return {
    quantityBps:exact.atoms(String(input.maximumQuantityPercent??''),2,{label:'Maximum quantity and weight change percentage'}),
    priceBps:exact.atoms(String(input.maximumPricePercent??''),2,{label:'Maximum unit price change percentage'}),
    orderIncrease:money.userToMinor(input.maximumOrderIncrease,p.currency,{label:'Maximum increase from the original order'}),
    profiles:[...new Set(p.amendments.filter(line=>line.changed).map(profile))].sort(),
    mailbox:p.mailSource?{connectorId:p.mailSource.connectorId,providerAccountId:p.mailSource.providerAccountId}:null,
  };
}

function exceeds(before,after,basisPoints,precision=6){
  if(before===after)return false;
  if(before==null||after==null)return true;
  const old=BigInt(exact.atoms(before,precision)),revised=BigInt(exact.atoms(after,precision)),difference=revised-old;
  return (difference<0n?-difference:difference)*10000n>old*BigInt(basisPoints);
}

function sameSource(p,authorization){
  return p.mailSource
    ?authorization?.mailbox?.connectorId===p.mailSource.connectorId&&authorization.mailbox.providerAccountId===p.mailSource.providerAccountId
    :!authorization?.mailbox;
}

function requireTerms(p,authorization,lines=p.amendments,{checkSource=true}={}){
  if(!authorization||!p.commitment||!Array.isArray(authorization.profiles)||
    !Number.isSafeInteger(authorization.quantityBps)||!Number.isSafeInteger(authorization.priceBps)||
    !Number.isSafeInteger(authorization.orderIncrease))
    throw new ValidationError('Set explicit purchase-change limits and check the full order value before routine changes.');
  if(checkSource&&!sameSource(p,authorization))
    throw new ValidationError('Individually review this supplier response source before authorizing its mailbox or private link for routine changes.');
  for(const line of lines.filter(row=>row.changed)){
    if(line.supplyHold&&(new Date(p.receivedAt)<=new Date(line.supplyHoldAt)||
      !p.amendmentInput.some(change=>change.lineId===line.lineId&&change.quantity!=null)))
      throw new ValidationError('Review the supplier’s current availability before changing this purchase automatically.');
    if(!authorization?.profiles.includes(profile(line)))
      throw new ValidationError('Authorize this exact supplier product, warehouse and measurement before making routine purchase changes.');
    const old=line.originalRemaining,proposed=line.remaining;
    if(exceeds(old.quantity,proposed.quantity,authorization.quantityBps)||
      exceeds(old.secondary,proposed.secondary,authorization.quantityBps))
      throw new ValidationError(line.code+' exceeds your authorized quantity or weight change.');
    if(exceeds(old.price,proposed.price,authorization.priceBps,0))
      throw new ValidationError(line.code+' exceeds your authorized unit price change.');
  }
  if(p.commitment.after-p.commitment.original>authorization.orderIncrease)
    throw new ValidationError('The revised purchase exceeds your maximum increase from its original order value.');
}

async function commitment(db,workspaceId,p,original){
  const multiplier=10**money.exponent(p.currency);
  const total=(await db.query(purchaseTotalsSql('$1','$2','$3::numeric'),[workspaceId,p.orderId,multiplier])).rows[0];
  const changes=p.amendments.filter(line=>line.changed);
  if(!total.priced||changes.some(line=>line.before.totalMinor==null||line.retained.totalMinor==null||
    line.replacement&&line.replacement.totalMinor==null))return null;
  const before=money.sum([money.integer(total.lines),money.integer(total.charges,'Purchase charges',{signed:true})]);
  const deltas=changes.map(line=>money.sum([line.retained.totalMinor,line.replacement?.totalMinor??0,-line.before.totalMinor]));
  return {before,after:money.sum([before,...deltas]),original:original==null?before:money.integer(original)};
}

async function requireBudget(db,p,account){
  const increase=p.commitment.after-p.commitment.before;
  if(increase<=0)return 0;
  const policy=require('../commercial/agent-plan'),caps=policy.purchaseLimits(account);
  if(!caps||p.currency!==caps.currency||p.commitment.after>money.toMinor(String(caps.perOrder),p.currency))
    throw new ValidationError('This increase needs approval under your plan’s automatic purchase limit.');
  const current=await policy.automaticPurchaseCommitments(db,account,caps.currency);
  if(current.unknown||money.sum([current.committed,increase])>money.toMinor(String(caps.perWeek),p.currency))
    throw new ValidationError('This increase needs approval under your weekly automatic purchasing limit.');
  return increase;
}

module.exports={profile,limits,sameSource,requireTerms,commitment,requireBudget};
