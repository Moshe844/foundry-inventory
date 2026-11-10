'use strict';
const {ValidationError,AuthorizationError}=require('../domain/errors'),policy=require('../commercial/agent-plan'),{hash}=require('../pricing/postgres-promotions');
const {addDays}=require('../accounting/customer-money');
async function owner(c,ctx,{lock=true}={}){
 const user=(await c.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
  WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL) ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!user)throw new AuthorizationError('Only the inventory owner can prepare or authorize supplier quote requests.');
}
async function access(c,ctx,{automatic=false,trained=false,readOnly=false}={}){
 await owner(c,ctx,{lock:!readOnly});if(!readOnly)await c.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
 const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,93,automatic?'automatic':'draft',{trained});
 const stop=await policy.stopped(c,ctx.workspaceId,state,'supplier.request_quotes',automatic);if(stop)throw new ValidationError(stop);
 if(automatic&&!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('The owner must authorize routine work before automatic quote requests.');return state;
}
function input(value){
 const reference=String(value.reference||'').trim(),requestKey=String(value.requestKey||'').trim(),connectorId=String(value.connectorId||'');
 const supplierIds=Array.isArray(value.supplierIds)?value.supplierIds:[value.supplierIds].filter(Boolean),lines=Array.isArray(value.lines)?value.lines:[];
 if(!requestKey||requestKey.length>160||!reference||reference.length>160||/[\r\n\x00-\x1f\x7f]/.test(reference)||!connectorId)throw new ValidationError('Enter an exact RFQ reference and choose a connected sending mailbox.');
 if(supplierIds.length<2||supplierIds.length>20||supplierIds.some(s=>typeof s!=='string'||!s)||new Set(supplierIds).size!==supplierIds.length)throw new ValidationError('Choose two to twenty distinct known suppliers.');
 if(!lines.length||lines.length>100||new Set(lines.map(l=>l.skuId)).size!==lines.length||lines.some(l=>typeof l.skuId!=='string'||!l.skuId||!/^\d{1,6}$/.test(String(l.quantity))||Number(l.quantity)<1||Number(l.quantity)>100000))throw new ValidationError('Enter one to 100 distinct whole-unit products with explicit quantities from one to 100,000.');
 const replyBy=String(value.replyBy||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(replyBy)||!Number.isFinite(Date.parse(replyBy))||new Date(replyBy+'T00:00:00Z').toISOString().slice(0,10)!==replyBy)throw new ValidationError('Choose the actual date you want supplier quotations by.');
 return {reference,requestKey,connectorId,supplierIds:[...supplierIds].sort(),lines:lines.map(l=>({skuId:l.skuId,quantity:Number(l.quantity)})).sort((a,b)=>a.skuId.localeCompare(b.skuId)),replyBy};
}
async function snapshot(c,ctx,raw,{readOnly=false}={}){
 await access(c,ctx,{readOnly});const scope=input(raw),clock=await require('../lib/business-time').forWorkspace(c,ctx.workspaceId);
 if(scope.replyBy<clock.calendarDate||scope.replyBy>addDays(clock.calendarDate,365))throw new ValidationError('Choose a quotation deadline from today through the next year.');
 const mailbox=await require('../shipping/agent-shipping-notices').mailbox(c,ctx.workspaceId,scope.connectorId);
 if(!mailbox)throw new ValidationError('Choose a connected, active Gmail or Microsoft 365 mailbox before preparing supplier requests.');
 const suppliers=(await c.query("SELECT id,name,email,currency FROM suppliers WHERE workspace_id=$1 AND id=ANY($2::text[]) AND status='active' ORDER BY id",[ctx.workspaceId,scope.supplierIds])).rows;
 if(suppliers.length!==scope.supplierIds.length||suppliers.some(s=>!s.name||!s.currency||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email||'')||/[\r\n\x00-\x1f\x7f]/.test(s.name)))throw new ValidationError('Every selected supplier needs a current name, currency and exact quote email address.');
 if(new Set(suppliers.map(s=>s.email.toLowerCase())).size!==suppliers.length)throw new ValidationError('Two selected suppliers share the same email address. Review the recipients before sending duplicate requests.');
 const products=(await c.query(`SELECT s.id,s.code,i.name,i.unit_label FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1 AND i.tracking_mode='quantity'
   AND i.quantity_precision=0 AND i.secondary_unit_label IS NULL ORDER BY s.id`,[ctx.workspaceId,scope.lines.map(l=>l.skuId)])).rows;
 if(products.length!==scope.lines.length)throw new ValidationError('Choose active whole-unit quantity products. Lots, serials and measured products need a separately reviewed request.');
 const recorded=(await c.query(`SELECT supplier_id,sku_id,supplier_sku,purchase_unit,units_per_purchase_unit,minimum_order_quantity,order_multiple,is_active FROM supplier_items
  WHERE workspace_id=$1 AND supplier_id=ANY($2::text[]) AND sku_id=ANY($3::text[]) ORDER BY supplier_id,sku_id`,[ctx.workspaceId,scope.supplierIds,scope.lines.map(l=>l.skuId)])).rows;
 if(recorded.some(l=>!Number(l.is_active)))throw new ValidationError('A selected supplier-product link is stopped. Review that relationship before requesting another quotation.');
 const byPair=new Map(recorded.map(l=>[JSON.stringify([l.supplier_id,l.sku_id]),l]));
 const links=suppliers.flatMap(s=>products.map(p=>byPair.get(JSON.stringify([s.id,p.id]))||{supplier_id:s.id,sku_id:p.id,supplier_sku:null,purchase_unit:null,units_per_purchase_unit:null,minimum_order_quantity:null,order_multiple:null,is_active:null}));
 for(const link of links){
  if(link.units_per_purchase_unit!==null&&(!Number.isSafeInteger(Number(link.units_per_purchase_unit))||Number(link.units_per_purchase_unit)<1)||link.minimum_order_quantity!==null&&(!Number.isSafeInteger(Number(link.minimum_order_quantity))||Number(link.minimum_order_quantity)<0)||link.order_multiple!==null&&(!Number.isSafeInteger(Number(link.order_multiple))||Number(link.order_multiple)<1))throw new ValidationError('Review invalid saved supplier pack terms before quoting. Unconfirmed terms can remain unknown; they are never guessed.');
 }
 const facts={...scope,preparedAt:clock.instant,timeZone:clock.timeZone,suppliers,products,links,mailboxAccount:mailbox.provider_account_id,providerType:mailbox.provider_type};return {...facts,sourceFingerprint:hash(facts)};
}
function profile(p){return {supplierIds:p.supplierIds,connectorId:p.connectorId,suppliers:p.suppliers,products:p.products,links:p.links,mailboxAccount:p.mailboxAccount,providerType:p.providerType,timeZone:p.timeZone};}
async function knownPartners(c,ctx,p){
 const known=(await c.query(`SELECT s.id FROM suppliers s WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND (
  EXISTS(SELECT 1 FROM purchase_orders o WHERE o.workspace_id=s.workspace_id AND o.supplier_id=s.id AND o.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED') AND o.approved_by_user_id IS NOT NULL)
  OR EXISTS(SELECT 1 FROM stockchief_runtime.agent_rfq_deliveries d JOIN supplier_communications m ON m.workspace_id=d.workspace_id AND m.id=d.communication_id
   WHERE d.workspace_id=s.workspace_id AND d.supplier_id=s.id AND NOT d.automatic AND m.status='SENT' AND lower(m.recipient)=lower(s.email) AND nullif(m.external_message_id,'') IS NOT NULL))`,[ctx.workspaceId,p.supplierIds])).rows;
 if(known.length!==p.supplierIds.length)throw new ValidationError('The first request for a new supplier needs individual owner approval. Complete that first request before routine sending.');
}
function compose(p,supplierId){
 const s=p.suppliers.find(s=>s.id===supplierId);if(!s)throw new ValidationError('This supplier is not in the reviewed RFQ.');
 const rows=p.lines.map(l=>{
  const product=p.products.find(v=>v.id===l.skuId),link=p.links.find(v=>v.supplier_id===supplierId&&v.sku_id===l.skuId),pack=Number(link.units_per_purchase_unit),knownPack=link.purchase_unit&&Number.isSafeInteger(pack)&&pack>0;
  const quantity=String(l.quantity)+' '+product.unit_label+(knownPack&&l.quantity%pack===0?' ('+(l.quantity/pack)+' '+link.purchase_unit+')':'');
  const terms=knownPack?'Recorded pack: '+pack+' '+product.unit_label+' per '+link.purchase_unit+'.':'Purchase pack not confirmed. Please state your selling unit and pack size.';
  const minimum=link.minimum_order_quantity===null?'Minimum order quantity not confirmed. Please state it.':'Recorded minimum: '+link.minimum_order_quantity+' purchase units.';
  const multiple=link.order_multiple===null?'Order multiple not confirmed. Please state it.':'Recorded order multiple: '+link.order_multiple+' purchase units.';
  return product.code+' · '+product.name+'\nRequested: '+quantity+(link.supplier_sku?'\nYour product code: '+link.supplier_sku:'\nPlease confirm that you can supply this exact product.')+'\n'+terms+' '+minimum+' '+multiple+'\nPlease quote availability for the requested quantity and identify any different supply conditions separately.';
 });
 const body='Hello '+s.name+',\n\nPlease provide a quotation for RFQ '+p.reference+' by '+p.replyBy+'.\n\n'+rows.join('\n\n')+'\n\nPlease state your unit prices in '+s.currency+', availability, earliest delivery date, freight and tax separately, quote validity and any changed pack or payment terms.\n\nThis is a request for a quotation only. It is not a purchase order, acceptance of terms, delivery promise or commitment to buy. No order has been placed.\n\nThank you.';
 if(body.length>100000)throw new ValidationError('Choose fewer products so each complete quote request fits in one email.');return {subject:'Request for quotation · '+p.reference,body};
}
module.exports={owner,access,input,snapshot,profile,compose,knownPartners};
