'use strict';
// Job 36: what one key supplier is shown each week. Only that supplier's own
// active products (its supplier items), our owned stock on hand at active
// sites, and twelve weekly quantities from StockChief's demand forecast: the
// same forecasting job 144 uses (agent-demand-forecast), fitted on the same
// recorded sales. A product without enough history stays unknown. No costs,
// prices or customers are read.
const {AuthorizationError}=require('../domain/errors'),P=require('../actions/permissions'),policy=require('../commercial/agent-plan');
const exact=require('../domain/exact-quantity'),{addDays}=require('../accounting/customer-money'),{hash}=require('../pricing/postgres-promotions');
const MAX_PRODUCTS=250,WEEKS=12;
const round=n=>Math.round(n*100)/100;

async function owner(db,ctx){
 const user=(await db.query(`SELECT u.* FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!user)throw new AuthorizationError('Only the inventory owner can share supplier stock forecasts.');P.assertCan(user,P.MANAGE_SUPPLIERS,'share supplier forecasts');P.assertCan(user,P.VIEW,'review the shared stock');
}
async function access(db,ctx,operation='draft'){await owner(db,ctx);return policy.requireWorkspaceJob(db,ctx.workspaceId,36,operation);}
function monday(date){const day=new Date(date+'T00:00:00Z').getUTCDay();return addDays(date,-((day+6)%7));}

// The supplier's own active products, by code. One more than the limit tells
// the caller there are too many.
async function products(db,workspaceId,supplierId){
 return (await db.query(`SELECT s.id,s.code,i.name,i.unit_label FROM supplier_items si
  JOIN skus s ON s.workspace_id=si.workspace_id AND s.id=si.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  WHERE si.workspace_id=$1 AND si.supplier_id=$2 AND si.is_active=1 AND s.is_active=1 AND i.is_active=1 ORDER BY s.code,s.id LIMIT ${MAX_PRODUCTS+1}`,[workspaceId,supplierId])).rows;
}
// Twelve weeks of a fitted forecast shape, from the preparation day.
function weeks(shape,today){
 const forecast=require('../forecasting/agent-demand-forecast');
 return Array.from({length:WEEKS},(_,i)=>({from:addDays(today,i*7),to:addDays(today,i*7+6),quantity:shape?forecast.units(shape,addDays(today,i*7),7):null}));
}
// The facts for one supplier this week, read at one moment. `skuIds` limits
// it to products already chosen (an earlier snapshot); they must still be the
// supplier's products.
async function snapshot(db,ctx,supplier,list){
 const read=async c=>{
  const forecast=require('../forecasting/agent-demand-forecast'),clock=await require('../lib/business-time').forWorkspace(c,ctx.workspaceId),today=clock.calendarDate,ids=list.map(p=>p.id);
  const stock=new Map((await c.query(`SELECT b.sku_id,sum(b.on_hand)::text quantity,count(*) FILTER(WHERE b.on_hand<0)::int negative FROM balances b JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id
   WHERE b.workspace_id=$1 AND b.sku_id=ANY($2::text[]) AND l.is_active=1 AND l.custody_agreement_id IS NULL GROUP BY b.sku_id`,[ctx.workspaceId,ids])).rows.map(r=>[r.sku_id,r]));
  const from=await forecast.historyStart(c,ctx.workspaceId,today),sales=await forecast.demand(c,ctx.workspaceId,ids,{from,today});
  const rows=list.map(p=>{
   const days=forecast.daysOf(sales.get(p.id)||new Map(),today),fitted=days.length?forecast.fit(days):{shape:null,label:'More history needed'},plan=weeks(fitted.shape||null,today),held=stock.get(p.id);
   return {skuId:p.id,sku:p.code,name:p.name,unit:p.unit_label,onHand:exact.canonical(held?.quantity||'0',{signed:true}),needsReview:Number(held?.negative||0)>0,
    method:fitted.shape?fitted.label:null,weeks:plan,total:fitted.shape?round(plan.reduce((n,w)=>n+w.quantity,0)):null};
  });
  const facts={version:2,supplierId:supplier.id,supplierName:supplier.name,recipient:supplier.email||null,preparedAt:clock.instant,timeZone:clock.timeZone,today,weekStart:monday(today),
   historyFrom:from,historyThrough:addDays(today,-1),skuIds:ids,rows};
  return {...facts,sourceFingerprint:hash(facts)};
 };
 return typeof db.transaction==='function'?db.transaction(read,{isolation:'REPEATABLE READ',readOnly:true,retrySafe:true}):read(db);
}
module.exports={owner,access,monday,products,weeks,snapshot,MAX_PRODUCTS,WEEKS};
