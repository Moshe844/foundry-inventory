'use strict';
const express=require('express'),service=require('../../pricing/postgres-promotions'),prices=require('../../pricing/postgres-service');
const {requireAuth,requireOwner,asyncRoute}=require('../middleware'),{ValidationError}=require('../../domain/errors');
const list=v=>v==null?[]:(Array.isArray(v)?v:[v]).map(String).filter(Boolean);
const slots=v=>v==null?[]:(Array.isArray(v)?v:[v]);
function definition(body){
 const rule={kind:String(body.kind),name:String(body.name||'').trim(),currency:prices.normaliseCurrency(body.currency),enabled:body.enabled==='1',priority:Number(body.priority||0),scope:{skuIds:list(body.skuIds),customerIds:list(body.customerIds),categoryIds:list(body.categoryIds)}};
 for(const k of ['startsAt','endsAt'])if(body[k]){const at=new Date(String(body[k]).endsWith('Z')?body[k]:body[k]+'Z');if(!Number.isFinite(at.getTime()))throw new ValidationError('Choose valid start and end dates.');rule[k]=at.toISOString();}
 if(rule.kind==='price_list'){
  const skus=slots(body.entrySku),quantities=slots(body.entryQuantity),amounts=slots(body.entryAmount);rule.entries=skus.flatMap((skuId,i)=>skuId?[{skuId,minQuantity:Number(quantities[i]),unitPriceMinor:prices.toMinor(amounts[i])}]:[]);
 }else if(rule.kind==='promotion'){
  rule.discount={type:String(body.discountType),value:prices.toMinor(body.discountValue)};rule.stacking=body.stacking||'exclusive';
  for(const key of ['code','stackGroup'])if(body[key])rule[key]=String(body[key]).trim();
  for(const key of ['minimumQuantity','maxRedemptions','maxPerCustomer'])if(body[key])rule[key]=Number(body[key]);
  if(body.minimumOrder)rule.minimumOrderMinor=prices.toMinor(body.minimumOrder);rule.excludes=list(body.excludes);
  if(rule.discount.type==='bundle'){const skus=slots(body.bundleSku),quantities=slots(body.bundleQuantity);rule.discount.items=skus.flatMap((skuId,i)=>skuId?[{skuId,quantity:Number(quantities[i])}]:[]);}
 }else if(rule.kind==='guard')for(const[key,input]of [['minimumMarginBps','minimumMargin'],['maximumDiscountBps','maximumDiscount']])if(body[input]!==''&&body[input]!=null)rule[key]=prices.toMinor(body[input]);
 return rule;
}
async function choices(db,ctx,ids=[]){const products=(await db.query(`SELECT s.id,s.code,i.name FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND s.id=ANY($2::text[]) ORDER BY i.name,s.code`,[ctx.workspaceId,ids])).rows;
 const customers=(await db.query("SELECT id,name FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' ORDER BY name",[ctx.workspaceId])).rows;
 const categories=(await db.query('SELECT DISTINCT category FROM catalogue_item_facts WHERE workspace_id=$1 AND category IS NOT NULL ORDER BY category',[ctx.workspaceId])).rows.map(r=>r.category);return {products,customers,categories};}
const {describe}=require('../../pricing/presentation');
function productIds(rule){return [...new Set([...(rule?.scope?.skuIds||[]),...(rule?.entries||[]).map(r=>r.skuId),...(rule?.discount?.items||[]).map(r=>r.skuId)])];}

function createPostgresPromotionsRouter(database){const router=express.Router();router.use('/sales/pricing',requireAuth);
 router.get('/sales/pricing/products/search',asyncRoute(async(req,res)=>{const access=require('../../actions/permissions');access.assertCan(req.user,access.VIEW_SALES,'search pricing products');res.set('Cache-Control','no-store');const products=(await database.query(`SELECT s.id,s.code,i.name,s.variant_label FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND ($2='' OR position(lower($2) in lower(s.code||' '||i.name||' '||coalesce(s.variant_label,'')))>0 OR lower(s.barcode)=lower($2)) ORDER BY lower(i.name),s.code,s.id LIMIT 50`,[req.ctx.workspaceId,String(req.query.q||'').trim().slice(0,120)])).rows;res.json({products});}));
 router.get('/sales/pricing',asyncRoute(async(req,res)=>{const rules=await service.list(database,req.ctx);return res.page('pricing/rules',{title:'Pricing & promotions',nav:'sales',rules,now:Date.now(),canManage:req.user.role==='owner'});}));
 router.get('/sales/pricing/rules/new',requireOwner,asyncRoute(async(req,res)=>res.page('pricing/rule-new',{title:'Create pricing rule',nav:'sales',...await choices(database,req.ctx),rules:await service.list(database,req.ctx),draft:null})));
 router.get('/sales/pricing/rules/:id/edit',requireOwner,asyncRoute(async(req,res)=>{const rules=await service.list(database,req.ctx),draft=rules.find(r=>r.id===req.params.id);if(!draft)throw new ValidationError('That pricing rule is not in this business.');return res.page('pricing/rule-new',{title:'Edit pricing rule',nav:'sales',...await choices(database,req.ctx,productIds(draft)),rules,draft});}));
 router.post('/sales/pricing/rules/proposals',requireOwner,asyncRoute(async(req,res)=>{const proposal=await service.propose(database,req.ctx,definition(req.body),{ruleId:req.body.ruleId||null,expectedRevision:Number(req.body.expectedRevision||0)});return res.redirect(303,'/sales/pricing/rules/proposals/'+proposal.id);}));
 router.get('/sales/pricing/rules/proposals/:id',asyncRoute(async(req,res)=>{const proposal=await service.getProposal(database,req.ctx,req.params.id);return res.page('pricing/rule-review',{title:'Review pricing',nav:'sales',proposal,rows:describe(proposal.definition,await choices(database,req.ctx,productIds(proposal.definition))),canManage:req.user.role==='owner'});}));
 router.post('/sales/pricing/rules/proposals/:id/decide',requireOwner,asyncRoute(async(req,res)=>{if(!['approve','reject'].includes(req.body.decision))throw new ValidationError('Choose approve or reject.');await service.decide(database,req.ctx,req.params.id,req.body.integrityHash,req.body.decision==='approve');req.flash('success',req.body.decision==='approve'?'Pricing rule approved. Existing orders keep their saved prices.':'Pricing change rejected.');return res.redirect(303,'/sales/pricing');}));
 router.get('/sales/pricing/rules/:id/history',asyncRoute(async(req,res)=>{const versions=await service.history(database,req.ctx,req.params.id),options=await choices(database,req.ctx,[...new Set(versions.flatMap(v=>productIds(v.definition)))]);return res.page('pricing/rule-history',{title:'Pricing history',nav:'sales',versions:versions.map(v=>({...v,rows:describe(v.definition,options)}))});}));
 return router;}
module.exports={createPostgresPromotionsRouter,definition,describe};
