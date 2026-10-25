'use strict';
const {newId}=require('../lib/util'),{ValidationError,NotFoundError}=require('../domain/errors'),access=require('../actions/permissions'),pricing=require('../pricing/postgres-promotions');
async function actor(db,ctx,permission){access.assertCan((await db.query('SELECT * FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0],permission,'manage quotations');}
async function get(db,workspaceId,id,{lock=false}={}){const r=(await db.query(`SELECT q.*,to_char(q.valid_until,'YYYY-MM-DD') valid_until,c.name customer_name FROM sales_quotations q JOIN customers c ON c.workspace_id=q.workspace_id AND c.id=q.customer_id WHERE q.workspace_id=$1 AND q.id=$2${lock?' FOR UPDATE OF q':''}`,[workspaceId,id])).rows[0];if(!r)throw new NotFoundError('That quotation is not in this inventory.');return r;}
async function list(db,ctx){await actor(db,ctx,access.VIEW_SALES);return (await db.query("SELECT q.*,to_char(q.valid_until,'YYYY-MM-DD') valid_until,c.name customer_name FROM sales_quotations q JOIN customers c ON c.workspace_id=q.workspace_id AND c.id=q.customer_id WHERE q.workspace_id=$1 ORDER BY q.created_at DESC,q.id DESC LIMIT 100",[ctx.workspaceId])).rows;}
async function create(db,ctx,input){return db.transaction(async c=>{
 await actor(c,ctx,access.OPERATE);await require('../commercial/enforcement').workspace(c,ctx.workspaceId,'sales_orders.core');
 if(!String(input.requestKey||'').trim())throw new ValidationError('A quotation request key is required.');
 await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['quotation:'+ctx.workspaceId]);const prior=(await c.query("SELECT *,to_char(valid_until,'YYYY-MM-DD') valid_until FROM sales_quotations WHERE workspace_id=$1 AND request_key=$2",[ctx.workspaceId,input.requestKey])).rows[0];
 const valid=String(input.validUntil||''),day=String(input.orderDate||new Date().toISOString().slice(0,10));if(!/^\d{4}-\d{2}-\d{2}$/.test(valid)||!Number.isFinite(Date.parse(valid))||new Date(valid).toISOString().slice(0,10)!==valid||valid<day)throw new ValidationError('Choose a quotation expiry on or after its issue date.');
 const {requestKey,validUntil,supersedesId,...terms}=input;
 if(prior){if(pricing.hash(prior.input)!==pricing.hash(terms)||prior.valid_until!==valid||prior.supersedes_id!==(supersedesId||null))throw new ValidationError('This quotation request was already used with different terms.');return {...prior,replayed:true};}
 if(supersedesId){const previous=await get(c,ctx.workspaceId,supersedesId,{lock:true});if(previous.status==='ACCEPTED')throw new ValidationError('An accepted quotation cannot be revised.');if((await c.query('SELECT 1 FROM sales_quotations WHERE workspace_id=$1 AND supersedes_id=$2',[ctx.workspaceId,supersedesId])).rows.length)throw new ValidationError('A newer revision already exists. Revise that quotation.');}
 const quote=await pricing.prepareQuote(c,ctx,terms,{lock:true});if(quote.violations.length)throw new ValidationError('Resolve the pricing safeguards before saving this quotation.');
 const count=Number((await c.query('SELECT count(*) n FROM sales_quotations WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),id=newId('quote'),number='QT-'+String(count+1).padStart(5,'0');
 const labels=Object.fromEntries((await c.query("SELECT s.id,i.name||CASE WHEN coalesce(s.variant_label,'')='' THEN '' ELSE ' / '||s.variant_label END||' · '||s.code label FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=ANY($2::text[])",[ctx.workspaceId,terms.lines.map(l=>l.skuId)])).rows.map(r=>[r.id,r.label]));
 return (await c.query(`INSERT INTO sales_quotations(id,workspace_id,customer_id,quote_number,input,pricing,pricing_hash,valid_until,request_key,created_by_user_id,supersedes_id,line_labels) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb) RETURNING *,to_char(valid_until,'YYYY-MM-DD') valid_until`,[id,ctx.workspaceId,terms.customerId,number,JSON.stringify(terms),JSON.stringify(quote),pricing.quoteHash(quote),valid,requestKey,ctx.actorId,supersedesId||null,JSON.stringify(labels)])).rows[0];
 },{isolation:'SERIALIZABLE',retrySafe:true});}
async function decide(db,ctx,id,{accept,expectedHash,today}){return db.transaction(async c=>{
 await actor(c,ctx,access.OPERATE);const q=await get(c,ctx.workspaceId,id,{lock:true});if(q.pricing_hash!==expectedHash)throw new ValidationError('Review this exact quotation before continuing.');
 if(q.status==='ACCEPTED'&&accept)return {salesOrderId:q.sales_order_id,replayed:true};if(q.status!=='OPEN')throw new ValidationError('This quotation has already been decided.');
 if(accept){if(q.valid_until<(today||new Date().toISOString().slice(0,10)))throw new ValidationError('This quotation expired. Prepare a current revision for review.');
  if((await c.query('SELECT 1 FROM sales_quotations WHERE workspace_id=$1 AND supersedes_id=$2',[ctx.workspaceId,id])).rows.length)throw new ValidationError('A newer quotation replaces this one. Review that revision.');
  // Reuse the canonical pricing/approval calculation. A changed promotion,
  // customer exemption, redemption limit or price requires renewed review.
  const result=await require('../operations/postgres-business-workflows').createSalesOrderInTransaction(c,ctx,{...q.input,orderNumber:null,pricingQuoteHash:q.pricing_hash,idempotencyKey:'quotation:'+q.id});await c.query("UPDATE sales_quotations SET status='ACCEPTED',sales_order_id=$3,decided_at=now() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,result.salesOrderId]);return result;
 }
 await c.query("UPDATE sales_quotations SET status='DECLINED',decided_at=now() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id]);return {declined:true};
 },{isolation:'SERIALIZABLE',retrySafe:true});}
module.exports={get,list,create,decide};
