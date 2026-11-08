'use strict';

const policy=require('../commercial/agent-plan');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const money=require('../domain/currency');
const cash=require('../accounting/agent-cash-planning');
const definitions=[
  ...require('./exception-reviews'),
  ...require('./inventory-reviews'),...require('./planning-reviews'),...require('../accounting/agent-month-end'),...require('./commercial-reviews'),...require('./traceability-reviews'),
  {id:104,key:'payment-run',label:'Prepare this week’s supplier payment run',read:cash.payments},
  {id:108,key:'early-discounts',label:'Find early-payment discounts',read:(db,ctx,options)=>cash.payments(db,ctx,{...options,discountsOnly:true})},
  {id:109,key:'cash-forecast',label:'Forecast thirteen weeks of cash flow',read:cash.forecast}
].sort((a,b)=>a.id-b.id);
const keys=new Map(definitions.map(d=>[d.key,d]));

async function ownerState(db,ctx){
  const member=await db.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId]);
  if(!member.rowCount) throw new AuthorizationError('Only the business owner can run this review across the inventory.');
  return policy.accountState(db,ctx.workspaceId);
}

function offers(state){
  const tiers=[['starter','Starter'],['growth','Growth'],['pro','Pro'],['enterprise','Custom']];
  return definitions.map(d=>({key:d.key,label:d.label,mode:policy.usesAgentTerms(state)?policy.allowance(state.plan,d.id):'excluded',
    minimum:tiers.find(([plan])=>policy.permits(plan,d.id,'suggest'))?.[1]}));
}

const suggestions={
  3:r=>'Check '+r.SKU+' at '+r.Location+'. '+r.Problem+'.',
  64:r=>'Review '+r.Order+' for '+r.Customer+'. '+r['Waiting units']+' units of '+r.SKU+' are still waiting for stock.',
  116:r=>'Review returns for '+r.Name+'. '+r['Returned units']+' of '+r['Fulfilled units']+' fulfilled units were returned.',
  110:r=>'Review the '+r.Month+' purchase budget for '+r.Category+' in '+r.Currency+'.',
  144:r=>r['Next 7 days']==null?'Record more customer orders for '+r.SKU+' before forecasting.':'Plan for about '+r['Next 7 days']+' units of '+r.SKU+' over the next week.',
  146:r=>r['Estimated units in 30 days']==null?'No comparable sales history for '+r.SKU+' yet.':'Consider about '+r['Estimated units in 30 days']+' units for '+r.SKU+' over its first 30 days.',
  4:r=>'Count '+r.SKU+' at '+r.Shelf+' first. '+r.Reason+'.',
  22:r=>'Check the saved price and delivery terms with '+r.Supplier+' for '+r.SKU+'.',
  32:r=>'Contact '+r.Supplier+' about overdue order '+r.Order+'.',
  44:r=>'Review '+r.Order+' against its delivery record for '+r.SKU+'.',
  79:r=>'Consider '+r.Product+' for this quote. It appeared in '+r['Shared orders']+' shared orders.',
  88:r=>'Review the ordering history for '+r.Customer+'. '+r.Health+'.',
  90:r=>'Review '+r.Supplier+' using its '+r['Placed orders']+' recorded purchase orders.',
  91:r=>'Check the higher supplier price on '+r.Order+' for '+r.SKU+'.',
  99:r=>'Review supplier invoice '+r.Invoice+' with '+r.Supplier+'. '+r.Problem,
  105:r=>'Check '+r['Credit or return']+' with '+r.Supplier+'. '+r.Status+'.',
  108:r=>'Review bill '+r.Bill+' before '+r['Discount deadline']+' for an early-payment discount.',
  148:r=>'Review replenishment for '+r.SKU+' because its shipped units rose in the last week.'
};

async function run(db,ctx,key,options={}){
  const def=keys.get(key);
  if(!def) throw new NotFoundError();
  const state=await ownerState(db,ctx),tier=policy.usesAgentTerms(state)?state.plan:null;
  policy.requireJob(tier,def.id,options.scheduled?'automatic':'suggest',{trained:options.trained===true});
  const mode=policy.allowance(tier,def.id),filter=String(options.filter||'').trim();
  if(filter.length>150) throw new ValidationError('Use an item code, supplier, customer or record number up to 150 characters.');
  const page=mode==='suggest'?1:Number(options.page||1);
  if(!Number.isSafeInteger(page)||page<1||page>1000000) throw new ValidationError('Choose a valid results page.');
  if(def.requiresFilter && !filter) return {label:def.label,summary:'Enter the exact '+(def.prompt||(def.id===195?'serial number':'SKU'))+' to look up.',rows:[],mode,filterable:true};
  const today=await require('../lib/business-time').today(db,ctx.workspaceId);
  let rows,summary=def.summary,more=false;
  if(def.readPage){
    const result=await def.readPage(db,ctx,{filter,page,today,change:options.change});
    if(mode==='suggest'&&suggestions[def.id])return {label:def.label,summary:result.summary,
      rows:result.rows.slice(0,1).map(row=>({Suggestion:suggestions[def.id](row)})),mode,more:false,page:1,filterable:true};
    return {label:def.label,summary:result.summary,rows:result.rows,more:result.more,page,mode,filterable:true,
      requiresChange:def.requiresChange,change:options.change,filterLabel:def.filterLabel};
  }
  if(def.read){
    const result=await def.read(db,ctx,{today,adviceOnly:mode==='suggest'});
    rows=result.rows;summary=result.summary;
    more=rows.length>page*100;
    rows=rows.slice((page-1)*100,page*100);
  }else{
    const args=def.usesDate?[ctx.workspaceId,filter,today]:[ctx.workspaceId,filter];
    let sql=def.sql;
    if(def.priceIncrease){
      const exponents=Object.fromEntries([...Intl.supportedValuesOf('currency'),'CLF','UYW'].map(code=>[code,money.exponent(code)]));
      args.push(JSON.stringify(exponents));
      sql='SELECT * FROM ('+sql+') evidence WHERE price_minor > "PO unit price"::numeric * power(10::numeric,($'+args.length+'::jsonb->>"Currency")::int) ORDER BY "Supplier","SKU","Order","Source","Document"';
    }
    args.push((page-1)*100);
    rows=(await db.query(sql+' LIMIT 101 OFFSET $'+args.length,args)).rows;
    more=rows.length>100;rows=rows.slice(0,100);
    for(const row of rows) if(row.price_minor!=null){
      row['Supplier unit price']=money.format(row.price_minor,row.Currency);delete row.price_minor;
    }
  }
  if(def.id===99)for(const row of rows)row.Problem=require('../purchasing/postgres-invoice-review').differenceLabel(row.Problem);
  if(def.id===105)for(const row of rows){row.Amount=row.Amount!=null&&row.Currency?money.format(row.Amount,row.Currency):null;}
  if(def.id===196)for(const row of rows) row.link='/autopilot/lots?'+new URLSearchParams({sku:row.SKU,lot:row.Lot});
  if(mode==='suggest' && suggestions[def.id]){
    rows=rows.slice(0,1).map(r=>({Suggestion:suggestions[def.id](r)}));more=false;
  }
  return {label:def.label,summary,rows,more,page,mode,filterable:!def.read};
}

module.exports={definitions,ownerState,offers,run};
