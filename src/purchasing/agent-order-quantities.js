'use strict';
const money=require('../domain/currency');
const policy=require('../commercial/agent-plan');
const {ValidationError}=require('../domain/errors');

function quantities(offer,needed,useAgentTerms){
  const pack=Number(offer.units_per_purchase_unit||1),multiple=Number(offer.order_multiple||1),minimum=Number(offer.minimum_order_quantity||1);
  const packsFor=units=>Math.ceil(units/pack/multiple)*multiple;
  const basePacks=packsFor(needed);
  let packs=Math.max(basePacks,Math.ceil(minimum/multiple)*multiple);
  const price=offer.last_unit_cost==null?null:money.toMinor(String(offer.last_unit_cost),offer.currency);
  let topUp=packs>basePacks?'Minimum purchase quantity':null;
  const minimumValue=useAgentTerms&&offer.minimum_order_amount>0?money.toMinor(String(offer.minimum_order_amount),offer.currency):0;
  if(minimumValue&&!(price>0))return {blocked:'The supplier minimum order value needs a positive recorded unit price.'};
  if(minimumValue&&packs*pack*price<minimumValue){
    packs=packsFor(minimumValue/price);
    topUp='Minimum order value';
  }
  if(useAgentTerms&&price>0&&offer.freight_terms_currency===offer.currency){
    const threshold=money.integer(offer.free_freight_threshold_minor),freight=money.integer(offer.ordinary_freight_minor);
    if(packs*pack*price<threshold){
      const freightPacks=packsFor(threshold/price);
      if((freightPacks-packs)*pack*price<=freight){packs=freightPacks;topUp='Free shipping';}
    }
  }
  const quantity=packs*pack;
  const total=price===null?null:money.integer(quantity*price,'Supplier order value');
  return {unitsPer:pack,purchaseUnits:packs,quantity,unitCost:price===null?null:Number(offer.last_unit_cost),
    value:total===null?null:Number(money.fromMinor(total,offer.currency)),topUp,packJob:pack!==1||multiple!==1};
}
function restriction(state,offer){
  if(offer.blocked)return offer.blocked;
  if(!state.agentTerms)return null;
  if(offer.packJob&&!policy.permits(state.plan,27,'draft'))return 'Ordering in supplier packs requires Growth. Enter the supplier order manually.';
  if(offer.topUp&&!policy.permits(state.plan,23,'draft'))return 'Growth can top up this order. Review the supplier minimum and enter the quantity manually.';
  return null;
}
async function saveFreight(db,ctx,input){
  return db.transaction(async client=>{
    const state=await require('../autopilot/job-reviews').ownerState(client,ctx);
    policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,23,'draft');
    const {rows:[supplier]}=await client.query("SELECT currency FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active' FOR UPDATE",[ctx.workspaceId,input.supplierId]);
    if(!supplier)throw new ValidationError('Choose an active supplier in this inventory.');
    const currency=supplier.currency;
    if(input.currency!==currency)throw new ValidationError('The supplier currency changed. Review the amounts again.');
    const clear=input.mode==='clear';
    if(!clear&&input.mode!=='save')throw new ValidationError('Choose whether to save or clear the freight terms.');
    const minimum=clear?null:money.userToMinor(input.threshold,currency),delivery=clear?null:money.userToMinor(input.freight,currency);
    if(!clear&&minimum<=0)throw new ValidationError('Enter a positive free shipping threshold.');
    await client.query('UPDATE suppliers SET free_freight_threshold_minor=$3,ordinary_freight_minor=$4,freight_terms_currency=$5,updated_at=now()::text WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,input.supplierId,minimum,delivery,clear?null:currency]);
    await require('../operations/postgres-security-audit').record(client,ctx,{action:'Supplier freight terms changed',reference:input.supplierId,
      after:{currency,freeFreightThreshold:minimum,ordinaryFreight:delivery}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function freightSettings(db,ctx,id){
  const state=await require('../autopilot/job-reviews').ownerState(db,ctx);
  policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,23,'draft');
  const {rows:[s]}=await db.query("SELECT * FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'",[ctx.workspaceId,id]);
  if(!s)throw new ValidationError('Choose an active supplier in this inventory.');
  const current=s.currency===s.freight_terms_currency;
  return {id:s.id,name:s.name,currency:s.currency,threshold:current?money.fromMinor(s.free_freight_threshold_minor,s.currency):'',
    freight:current?money.fromMinor(s.ordinary_freight_minor,s.currency):''};
}
async function supplierMinimums(db,ctx,{filter,page}){
  const {rows}=await db.query(`SELECT id,name,currency,minimum_order_amount,freight_terms_currency,free_freight_threshold_minor,ordinary_freight_minor
    FROM suppliers WHERE workspace_id=$1 AND status='active' AND ($2='' OR lower(name)=lower($2)) ORDER BY name,id LIMIT 101 OFFSET $3`,
    [ctx.workspaceId,filter,(page-1)*100]);
  return {rows:rows.slice(0,100).map(s=>({Supplier:s.name,Currency:s.currency,
    'Minimum order value':s.minimum_order_amount==null?null:money.format(money.toMinor(String(s.minimum_order_amount),s.currency),s.currency),
    'Free shipping threshold':s.freight_terms_currency===s.currency?money.format(s.free_freight_threshold_minor,s.currency):null,
    'Shipping charge':s.freight_terms_currency===s.currency?money.format(s.ordinary_freight_minor,s.currency):null,link:'/purchasing/freight/'+s.id})),
    more:rows.length>100,summary:'Replenishment applies the saved minimum amount and pack requirements. It adds goods to reach free shipping only if their cost is no greater than the saved shipping charge. The normal purchase limits still apply.'};
}
module.exports={quantities,restriction,saveFreight,freightSettings,supplierMinimums};
