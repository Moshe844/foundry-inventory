'use strict';

const crypto=require('node:crypto');
const {newId,nowIso,trimOrNull}=require('../lib/util');
const {ValidationError,NotFoundError}=require('../domain/errors');

const CURRENCY=/^[A-Z]{3}$/;

function normaliseCurrency(value,fallback='USD'){
  const currency=String(value||fallback).trim().toUpperCase();
  if(!CURRENCY.test(currency))throw new ValidationError('Currency must be a three-letter code such as USD, EUR or GBP.');
  return currency;
}

function toMinor(value,label='Price'){
  if(value===null||value===undefined||String(value).trim()==='')return null;
  const clean=String(value).trim().replace(/[$£€¥,\s]/g,'');
  if(!/^\d+(?:\.\d{1,2})?$/.test(clean))throw new ValidationError(`${label} must be a positive amount with no more than two decimal places.`);
  const [whole,fraction='']=clean.split('.');const minor=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(!Number.isSafeInteger(minor)||minor<0||minor>99999999999)throw new ValidationError(`${label} is outside the supported range.`);
  return minor;
}

function formatMinor(amountMinor,currency='USD'){
  if(amountMinor===null||amountMinor===undefined)return 'Not set';
  try{return new Intl.NumberFormat('en-US',{style:'currency',currency:normaliseCurrency(currency)}).format(Number(amountMinor)/100);}
  catch{return `${currency} ${(Number(amountMinor)/100).toFixed(2)}`;}
}

function hash(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}

async function requireSku(queryable,workspaceId,skuId){
  const row=(await queryable.query(`SELECT s.*,i.name AS item_name,i.unit_label FROM skus s JOIN items i ON i.id=s.item_id
    WHERE s.id=$1 AND s.workspace_id=$2 AND s.is_active=1 AND i.is_active=1`,[skuId,workspaceId])).rows[0];
  if(!row)throw new NotFoundError('That product or variant is not in this inventory.');
  return {...row,display_name:row.variant_label?`${row.item_name} / ${row.variant_label}`:row.item_name};
}

async function currentPrice(queryable,workspaceId,skuId){
  const row=(await queryable.query(`SELECT sp.*,u.name AS actor_name FROM sku_prices sp LEFT JOIN users u ON u.id=sp.created_by_user_id
    WHERE sp.workspace_id=$1 AND sp.sku_id=$2 ORDER BY sp.created_at DESC,sp.id DESC LIMIT 1`,[workspaceId,skuId])).rows[0];
  return row?{...row,isSet:row.amount_minor!==null,amount_minor:row.amount_minor===null?null:Number(row.amount_minor),
    formatted:formatMinor(row.amount_minor,row.currency)}:
    {id:null,workspace_id:workspaceId,sku_id:skuId,amount_minor:null,currency:'USD',isSet:false,formatted:'Not set'};
}

async function purchaseCost(queryable,workspaceId,skuId){
  const stated=(await queryable.query(`SELECT pc.*,sup.name AS supplier_name FROM sku_purchase_costs pc
    LEFT JOIN supplier_items si ON si.id=pc.supplier_item_id LEFT JOIN suppliers sup ON sup.id=si.supplier_id
    WHERE pc.workspace_id=$1 AND pc.sku_id=$2 ORDER BY pc.created_at DESC,pc.id DESC LIMIT 1`,[workspaceId,skuId])).rows[0];
  if(stated)return {...stated,amount_minor:Number(stated.amount_minor),isSet:true,
    formatted:formatMinor(stated.amount_minor,stated.currency),sourceLabel:stated.supplier_name||'Owner supplied'};
  const supplier=(await queryable.query(`SELECT si.id AS supplier_item_id,si.last_unit_cost,si.last_cost_at,
      supplier.currency,supplier.name AS supplier_name FROM supplier_items si JOIN suppliers supplier ON supplier.id=si.supplier_id
    WHERE si.workspace_id=$1 AND si.sku_id=$2 AND si.is_active=1 AND si.last_unit_cost IS NOT NULL
    ORDER BY si.is_preferred DESC,si.last_cost_at DESC,si.updated_at DESC LIMIT 1`,[workspaceId,skuId])).rows[0];
  if(!supplier)return null;
  const amountMinor=Math.round(Number(supplier.last_unit_cost)*100);
  return {...supplier,amount_minor:amountMinor,isSet:true,formatted:formatMinor(amountMinor,supplier.currency),sourceLabel:supplier.supplier_name};
}

async function listForSkus(queryable,workspaceId,skuIds){
  const result=new Map();
  await Promise.all((skuIds||[]).map(async(skuId)=>result.set(skuId,{sellingPrice:await currentPrice(queryable,workspaceId,skuId),
    purchaseCost:await purchaseCost(queryable,workspaceId,skuId)})));
  return result;
}

async function setPriceInTransaction(client,ctx,input){
  const sku=await requireSku(client,ctx.workspaceId,input.skuId);const amountMinor=input.amountMinor===undefined?toMinor(input.amount):input.amountMinor;
  if(amountMinor!==null&&(!Number.isSafeInteger(Number(amountMinor))||Number(amountMinor)<0))throw new ValidationError('Selling price must be a valid non-negative amount.');
  const currency=normaliseCurrency(input.currency);const current=await currentPrice(client,ctx.workspaceId,sku.id);
  if(Object.prototype.hasOwnProperty.call(input,'expectedCurrentId')&&(current.id||null)!==(input.expectedCurrentId||null))
    throw new ValidationError('The current selling price changed after this preview was prepared. Start again from the latest price.');
  if(current.id&&current.amount_minor===amountMinor&&current.currency===currency)return {...current,replayed:true};
  const id=newId('prc');const at=nowIso();
  await client.query(`INSERT INTO sku_prices
    (id,workspace_id,sku_id,amount_minor,currency,source,source_detail,created_by_user_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,[id,ctx.workspaceId,sku.id,amountMinor,currency,
    trimOrNull(input.source)||'owner',JSON.stringify(input.sourceDetail||{}),ctx.actorId||null,at]);
  if(amountMinor!==null)await client.query(`UPDATE sales_order_lines SET unit_price_minor=$1,price_source_id=$2,updated_at=$3
    WHERE workspace_id=$4 AND sku_id=$5 AND unit_price_minor IS NULL
      AND sales_order_id IN (SELECT id FROM sales_orders WHERE workspace_id=$4 AND status='DRAFT')`,
  [amountMinor,id,at,ctx.workspaceId,sku.id]);
  return currentPrice(client,ctx.workspaceId,sku.id);
}

async function setPrice(database,ctx,input){return database.transaction((client)=>setPriceInTransaction(client,ctx,input));}

async function setPurchaseCostInTransaction(client,ctx,input){
  const sku=await requireSku(client,ctx.workspaceId,input.skuId);const amountMinor=input.amountMinor===undefined?
    toMinor(input.amount,'Purchase cost'):Number(input.amountMinor);
  if(!Number.isSafeInteger(amountMinor)||amountMinor<0)throw new ValidationError('Purchase cost must be a valid non-negative amount.');
  const currency=normaliseCurrency(input.currency);const current=await purchaseCost(client,ctx.workspaceId,sku.id);
  if(Object.prototype.hasOwnProperty.call(input,'expectedCurrentId')&&(current?.id||null)!==(input.expectedCurrentId||null))
    throw new ValidationError('The current purchase cost changed after this preview was prepared. Start again from the latest cost.');
  if(current&&current.amount_minor===amountMinor&&current.currency===currency)return {...current,replayed:true};
  const id=newId('pcost');const at=nowIso();
  await client.query(`INSERT INTO sku_purchase_costs
    (id,workspace_id,sku_id,amount_minor,currency,supplier_item_id,source,source_detail,created_by_user_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,[id,ctx.workspaceId,sku.id,amountMinor,currency,
    input.supplierItemId||null,trimOrNull(input.source)||'owner',JSON.stringify(input.sourceDetail||{}),ctx.actorId||null,at]);
  if(input.supplierItemId)await client.query(`UPDATE supplier_items SET last_unit_cost=$1,last_cost_at=$2,updated_at=$2
    WHERE id=$3 AND workspace_id=$4 AND sku_id=$5`,[amountMinor/100,at,input.supplierItemId,ctx.workspaceId,sku.id]);
  return purchaseCost(client,ctx.workspaceId,sku.id);
}

async function setPurchaseCost(database,ctx,input){return database.transaction((client)=>setPurchaseCostInTransaction(client,ctx,input));}

async function preferredSupplierItem(queryable,workspaceId,skuId){
  const rows=(await queryable.query(`SELECT si.id,si.is_preferred FROM supplier_items si JOIN suppliers supplier ON supplier.id=si.supplier_id
    WHERE si.workspace_id=$1 AND si.sku_id=$2 AND si.is_active=1 AND supplier.status='active'
    ORDER BY si.is_preferred DESC,si.updated_at DESC`,[workspaceId,skuId])).rows;
  const preferred=rows.filter((row)=>Boolean(row.is_preferred));return preferred.length===1?preferred[0].id:rows.length===1?rows[0].id:null;
}

function pricePayload(workspaceId,skuId,amountMinor,currency,currentPriceId){return {workspaceId,skuId,amountMinor,currency,currentPriceId};}

async function createPriceProposal(database,ctx,input){
  const sku=await requireSku(database,ctx.workspaceId,input.skuId);const amountMinor=input.amountMinor===undefined?toMinor(input.amount):input.amountMinor;
  const currency=normaliseCurrency(input.currency);const current=await currentPrice(database,ctx.workspaceId,sku.id);
  if(current.id&&current.amount_minor===amountMinor&&current.currency===currency)throw new ValidationError('That selling price is already current.');
  const id=newId('pricechg');const payload=pricePayload(ctx.workspaceId,sku.id,amountMinor,currency,current.id||null);
  await database.query(`INSERT INTO price_change_proposals
    (id,workspace_id,sku_id,amount_minor,currency,source_text,status,current_price_id,integrity_hash,created_by_user_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,'PENDING',$7,$8,$9,$10)`,[id,ctx.workspaceId,sku.id,amountMinor,currency,
    String(input.sourceText||'Set from inventory screen.'),current.id||null,hash(payload),ctx.actorId,nowIso()]);
  return getPriceProposal(database,ctx.workspaceId,id);
}

async function getPriceProposal(queryable,workspaceId,id,lock=false){
  const row=(await queryable.query(`SELECT proposal.*,sku.item_id,sku.code,sku.variant_label,item.name AS item_name
    FROM price_change_proposals proposal JOIN skus sku ON sku.id=proposal.sku_id JOIN items item ON item.id=sku.item_id
    WHERE proposal.id=$1 AND proposal.workspace_id=$2${lock?' FOR UPDATE OF proposal':''}`,[id,workspaceId])).rows[0];
  if(!row)throw new NotFoundError('That selling-price change is not in this inventory.');
  const current=await currentPrice(queryable,workspaceId,row.sku_id);
  return {...row,amount_minor:row.amount_minor===null?null:Number(row.amount_minor),current,
    displayName:row.variant_label?`${row.item_name} / ${row.variant_label}`:row.item_name,
    currentFormatted:current.formatted,proposedFormatted:formatMinor(row.amount_minor,row.currency)};
}

async function approvePriceProposal(database,ctx,id,expectedHash){
  return database.transaction(async(client)=>{
    const proposal=await getPriceProposal(client,ctx.workspaceId,id,true);
    if(proposal.status==='COMPLETED')return proposal;
    if(proposal.status!=='PENDING')throw new ValidationError('That selling-price change is no longer waiting for approval.');
    if(expectedHash!==proposal.integrity_hash)throw new ValidationError('That price preview changed. Review it again.');
    const current=await currentPrice(client,ctx.workspaceId,proposal.sku_id);
    const check=hash(pricePayload(ctx.workspaceId,proposal.sku_id,proposal.amount_minor,proposal.currency,current.id||null));
    if(check!==proposal.integrity_hash)throw new ValidationError('The current selling price changed after this preview was prepared. Start again from the latest price.');
    await setPriceInTransaction(client,ctx,{skuId:proposal.sku_id,amountMinor:proposal.amount_minor,currency:proposal.currency,
      source:'approved_instruction',sourceDetail:{proposalId:proposal.id,statedAs:proposal.source_text}});
    await client.query(`UPDATE price_change_proposals SET status='COMPLETED',approved_by_user_id=$1,completed_at=$2
      WHERE id=$3 AND workspace_id=$4`,[ctx.actorId,nowIso(),id,ctx.workspaceId]);
    return getPriceProposal(client,ctx.workspaceId,id);
  });
}

async function cancelPriceProposal(database,workspaceId,id){
  await database.query(`UPDATE price_change_proposals SET status='CANCELLED',cancelled_at=$1
    WHERE id=$2 AND workspace_id=$3 AND status='PENDING'`,[nowIso(),id,workspaceId]);
  return getPriceProposal(database,workspaceId,id);
}

function purchasePayload(workspaceId,skuId,amountMinor,currency,supplierItemId,currentCostId){
  return {workspaceId,skuId,amountMinor,currency,supplierItemId,currentCostId};
}

async function createPurchaseCostProposal(database,ctx,input){
  const sku=await requireSku(database,ctx.workspaceId,input.skuId);const amountMinor=input.amountMinor===undefined?
    toMinor(input.amount,'Purchase cost'):Number(input.amountMinor);const currency=normaliseCurrency(input.currency);
  const current=await purchaseCost(database,ctx.workspaceId,sku.id);
  if(current&&current.amount_minor===amountMinor&&current.currency===currency)throw new ValidationError('That purchase cost is already current.');
  const supplierItemId=input.supplierItemId||await preferredSupplierItem(database,ctx.workspaceId,sku.id);
  const payload=purchasePayload(ctx.workspaceId,sku.id,amountMinor,currency,supplierItemId,current?.id||null);const id=newId('pcpurch');
  await database.query(`INSERT INTO purchase_cost_change_proposals
    (id,workspace_id,sku_id,amount_minor,currency,supplier_item_id,source_text,status,current_cost_id,integrity_hash,created_by_user_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,$9,$10,$11)`,[id,ctx.workspaceId,sku.id,amountMinor,currency,supplierItemId,
    String(input.sourceText||'Set from inventory screen.'),current?.id||null,hash(payload),ctx.actorId,nowIso()]);
  return getPurchaseCostProposal(database,ctx.workspaceId,id);
}

async function getPurchaseCostProposal(queryable,workspaceId,id,lock=false){
  const row=(await queryable.query(`SELECT proposal.*,sku.item_id,sku.code,sku.variant_label,item.name AS item_name,
      supplier.name AS supplier_name FROM purchase_cost_change_proposals proposal JOIN skus sku ON sku.id=proposal.sku_id
    JOIN items item ON item.id=sku.item_id LEFT JOIN supplier_items si ON si.id=proposal.supplier_item_id
    LEFT JOIN suppliers supplier ON supplier.id=si.supplier_id WHERE proposal.id=$1 AND proposal.workspace_id=$2${lock?' FOR UPDATE OF proposal':''}`,
  [id,workspaceId])).rows[0];
  if(!row)throw new NotFoundError('That purchase-cost change is not in this inventory.');
  const current=await purchaseCost(queryable,workspaceId,row.sku_id);const selling=await currentPrice(queryable,workspaceId,row.sku_id);
  const amountMinor=Number(row.amount_minor);const differenceMinor=selling.isSet?selling.amount_minor-amountMinor:null;
  return {...row,amount_minor:amountMinor,current,sellingPrice:selling,
    displayName:row.variant_label?`${row.item_name} / ${row.variant_label}`:row.item_name,
    currentFormatted:current?.formatted||'Not set',proposedFormatted:formatMinor(amountMinor,row.currency),differenceMinor,
    belowCost:differenceMinor!==null&&differenceMinor<0,marginFormatted:differenceMinor===null?null:formatMinor(Math.abs(differenceMinor),row.currency)};
}

async function approvePurchaseCostProposal(database,ctx,id,expectedHash){
  return database.transaction(async(client)=>{
    const proposal=await getPurchaseCostProposal(client,ctx.workspaceId,id,true);
    if(proposal.status==='COMPLETED')return proposal;
    if(proposal.status!=='PENDING')throw new ValidationError('That purchase-cost change is no longer waiting for approval.');
    if(expectedHash!==proposal.integrity_hash)throw new ValidationError('That purchase-cost preview changed. Review it again.');
    const current=await purchaseCost(client,ctx.workspaceId,proposal.sku_id);
    const check=hash(purchasePayload(ctx.workspaceId,proposal.sku_id,proposal.amount_minor,proposal.currency,
      proposal.supplier_item_id,current?.id||null));
    if(check!==proposal.integrity_hash)throw new ValidationError('The current purchase cost changed after this preview was prepared. Start again from the latest cost.');
    await setPurchaseCostInTransaction(client,ctx,{skuId:proposal.sku_id,amountMinor:proposal.amount_minor,
      currency:proposal.currency,supplierItemId:proposal.supplier_item_id,source:'approved_instruction',
      sourceDetail:{proposalId:proposal.id,statedAs:proposal.source_text}});
    await client.query(`UPDATE purchase_cost_change_proposals SET status='COMPLETED',approved_by_user_id=$1,completed_at=$2
      WHERE id=$3 AND workspace_id=$4`,[ctx.actorId,nowIso(),id,ctx.workspaceId]);
    return getPurchaseCostProposal(client,ctx.workspaceId,id);
  });
}

async function cancelPurchaseCostProposal(database,workspaceId,id){
  await database.query(`UPDATE purchase_cost_change_proposals SET status='CANCELLED',cancelled_at=$1
    WHERE id=$2 AND workspace_id=$3 AND status='PENDING'`,[nowIso(),id,workspaceId]);
  return getPurchaseCostProposal(database,workspaceId,id);
}

module.exports={normaliseCurrency,toMinor,formatMinor,requireSku,currentPrice,purchaseCost,listForSkus,
  setPrice,setPriceInTransaction,setPurchaseCost,setPurchaseCostInTransaction,createPriceProposal,getPriceProposal,
  approvePriceProposal,cancelPriceProposal,createPurchaseCostProposal,getPurchaseCostProposal,
  approvePurchaseCostProposal,cancelPurchaseCostProposal};
