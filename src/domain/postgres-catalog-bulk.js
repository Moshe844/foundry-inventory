'use strict';
const crypto=require('node:crypto'),{ValidationError,NotFoundError}=require('./errors'),{newId,nowIso}=require('../lib/util');
const catalog=require('./postgres-catalog-service'),prices=require('../pricing/postgres-service');
const stable=v=>v&&typeof v==='object'?Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v);
const digest=v=>crypto.createHash('sha256').update(stable(v)).digest('hex');
async function selected(database,ctx,input){
 const ids=[...new Set((Array.isArray(input)?input:[input]).filter(Boolean).map(String))];
 if(!ids.length||ids.length>100)throw new ValidationError('Select between 1 and 100 products.');
 const rows=(await database.query('SELECT id,name,is_active,updated_at FROM items WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY name,id',[ctx.workspaceId,ids])).rows;
 if(rows.length!==ids.length)throw new NotFoundError('Every selected product must belong to this inventory.');return rows;
}
async function owner(database,ctx){if((await database.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0]?.role!=='owner')throw new ValidationError('Only an owner can approve these product changes.');}
async function prepare(database,ctx,input){
 await owner(database,ctx);if(!['archive','restore','price'].includes(input.kind))throw new ValidationError('Choose a supported bulk action.');
 return database.transaction(async client=>{
  const items=await selected(client,ctx,input.itemIds),changes=[];
  if(input.kind==='archive'){
   const stocked=(await client.query(`SELECT i.name FROM items i JOIN skus s ON s.workspace_id=i.workspace_id AND s.item_id=i.id JOIN balances b ON b.workspace_id=s.workspace_id AND b.sku_id=s.id WHERE i.workspace_id=$1 AND i.id=ANY($2::text[]) AND b.on_hand<>0 LIMIT 1`,[ctx.workspaceId,items.map(i=>i.id)])).rows[0];
   if(stocked)throw new ValidationError('Remove or transfer the remaining stock before archiving '+stocked.name+'.');
  }
  const scoped={query:(...a)=>client.query(...a),transaction:fn=>fn(client)};
  if(input.kind==='price'){
   const skus=(await client.query(`SELECT s.id,s.code,i.name FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.item_id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1 ORDER BY i.name,s.position,s.id LIMIT 1001`,[ctx.workspaceId,items.map(i=>i.id)])).rows;
   if(!skus.length||skus.length>1000)throw new ValidationError('Select active products with at most 1,000 variants for one price review.');
   const currency=prices.normaliseCurrency(input.currency),amountMinor=prices.toMinor(input.amount,'Selling price',currency);if(amountMinor===null)throw new ValidationError('Enter the new selling price.');
   for(const sku of skus){const current=await prices.currentPrice(client,ctx.workspaceId,sku.id);if(current.amount_minor===amountMinor&&current.currency===currency)continue;
    const proposal=await prices.createPriceProposal(scoped,ctx,{skuId:sku.id,amountMinor,currency,sourceText:'Bulk price change from selected products'});
    changes.push({proposalId:proposal.id,hash:proposal.integrity_hash,name:proposal.displayName,code:sku.code,before:proposal.currentFormatted,after:proposal.proposedFormatted});}
   if(!changes.length)throw new ValidationError('Those selected products already have this price.');
  }
  const payload={items,changes},id=newId('bulk'),hash=digest({kind:input.kind,payload});
  await client.query('INSERT INTO catalog_bulk_reviews(id,workspace_id,created_by_user_id,kind,payload,integrity_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,ctx.workspaceId,ctx.actorId,input.kind,payload,hash,nowIso()]);return get(client,ctx,id);
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function get(database,ctx,id){const row=(await database.query('SELECT * FROM catalog_bulk_reviews WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];if(!row)throw new NotFoundError('That product review is not in this inventory.');return row;}
async function cancel(database,ctx,id){await owner(database,ctx);return database.transaction(async client=>{const row=(await client.query('SELECT * FROM catalog_bulk_reviews WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];if(!row)throw new NotFoundError('That product review is not in this inventory.');if(row.status!=='PENDING')throw new ValidationError('Only a pending review can be cancelled.');for(const change of row.payload.changes||[])await prices.cancelPriceProposal(client,ctx.workspaceId,change.proposalId);await client.query("UPDATE catalog_bulk_reviews SET status='CANCELLED' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id]);});}
async function approve(database,ctx,id,hash){await owner(database,ctx);return database.transaction(async client=>{
 const row=(await client.query('SELECT * FROM catalog_bulk_reviews WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];if(!row)throw new NotFoundError('That product review is not in this inventory.');if(row.status==='COMPLETED')return {...row,replayed:true};
 if(row.status!=='PENDING'||row.integrity_hash!==hash||digest({kind:row.kind,payload:row.payload})!==hash)throw new ValidationError('This review changed. Review the current product changes.');
 const current=await selected(client,ctx,row.payload.items.map(i=>i.id));
 if(current.some(i=>{const before=row.payload.items.find(b=>b.id===i.id);return i.updated_at!==before.updated_at||i.is_active!==before.is_active;}))throw new ValidationError('A selected product changed after this review. Prepare the action again.');
 const scoped={query:(...a)=>client.query(...a),transaction:fn=>fn(client)};
 if(row.kind==='price')for(const change of row.payload.changes)await prices.approvePriceProposal(scoped,ctx,change.proposalId,change.hash);
 else for(const item of current)await catalog.setItemActive(scoped,ctx,item.id,row.kind==='restore');
 await client.query("UPDATE catalog_bulk_reviews SET status='COMPLETED',approved_at=$3,approved_by_user_id=$4 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,nowIso(),ctx.actorId]);return {...row,status:'COMPLETED',replayed:false};
 },{isolation:'SERIALIZABLE',retrySafe:true});}
module.exports={selected,prepare,get,approve,cancel};
