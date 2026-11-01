'use strict';
const {createHash}=require('node:crypto'),{ValidationError,NotFoundError}=require('./errors'),kits=require('./postgres-kit-service'),{newId}=require('../lib/util');
const stable=v=>v&&typeof v==='object'?Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v);
const hash=value=>createHash('sha256').update(stable(value)).digest('hex');
function version(def){return hash({active:Number(def.sku.is_active),itemActive:Number(def.sku.item_active),components:def.components.map(c=>[c.component_sku_id,String(c.quantity),c.stock_basis])});}
async function owner(c,ctx){if((await c.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0]?.role!=='owner')throw new ValidationError('Only an owner can approve a kit recipe.');}
async function prepare(db,ctx,itemId,skuId,input){return db.transaction(async c=>{
 await owner(c,ctx);const before=await kits.definition(c,ctx.workspaceId,skuId);if(before.sku.item_id!==itemId)throw new NotFoundError('Choose a variant of this item.');if(input.expectedVersion!==version(before))throw new ValidationError('This recipe changed in another tab. Reload it before preparing changes.');
 const raw=Array.isArray(input.components)?input.components:Object.values(input.components||{}),components=[];
 if(raw.length>500)throw new ValidationError('Review at most 500 component variants at once.');
 for(const row of raw){const code=String(row.code||'').trim();if(!code&&!String(row.quantity||'').trim())continue;const matches=(await c.query(`SELECT s.id,s.code,s.variant_label,i.name FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND (lower(s.code)=lower($2) OR s.barcode=$2) LIMIT 2`,[ctx.workspaceId,code])).rows;if(matches.length!==1)throw new ValidationError('Use one exact active SKU or barcode for each component: '+code);components.push({skuId:matches[0].id,quantity:row.quantity,code:matches[0].code,name:matches[0].name+(matches[0].variant_label?' — '+matches[0].variant_label:'')});}
 const definition={kitSkuId:skuId,stockBasis:input.stockBasis||'components',components};
 // Run the canonical recipe validation, including nested cycles, in a savepoint.
 // The preview must not change recipes, stock, audit records or read revisions.
 await c.query('SAVEPOINT kit_recipe_preview');await kits.define({transaction:fn=>fn(c)},ctx,definition);const checked=await kits.definition(c,ctx.workspaceId,skuId);await c.query('ROLLBACK TO SAVEPOINT kit_recipe_preview');
 const payload={itemId,definition:{...definition,components:components.map(p=>({...p,quantity:String(checked.components.find(c=>c.component_sku_id===p.skuId).quantity)}))},beforeVersion:version(before),label:before.sku.name+(before.sku.variant_label?' — '+before.sku.variant_label:'')},id=newId('kitreview'),integrityHash=hash(payload);
 await c.query('INSERT INTO kit_recipe_reviews(id,workspace_id,kit_sku_id,actor_id,payload,integrity_hash) VALUES($1,$2,$3,$4,$5,$6)',[id,ctx.workspaceId,skuId,ctx.actorId,payload,integrityHash]);return {id};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function get(db,ctx,id){const row=(await db.query('SELECT * FROM kit_recipe_reviews WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];if(!row)throw new NotFoundError('That kit review is unavailable.');return row;}
async function approve(db,ctx,id,integrityHash){return db.transaction(async c=>{
 await owner(c,ctx);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['kits:'+ctx.workspaceId]);const review=(await c.query('SELECT * FROM kit_recipe_reviews WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];if(!review||review.integrity_hash!==integrityHash||hash(review.payload)!==integrityHash)throw new ValidationError('Open the current kit review before approving it.');if(review.status==='COMPLETED')return {...review,replayed:true};
 const before=await kits.definition(c,ctx.workspaceId,review.kit_sku_id);if(version(before)!==review.payload.beforeVersion)throw new ValidationError('The kit recipe changed after review. Prepare a new review.');await kits.define({transaction:fn=>fn(c)},ctx,review.payload.definition);await c.query("UPDATE kit_recipe_reviews SET status='COMPLETED',completed_at=now() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id]);return review;
},{isolation:'SERIALIZABLE',retrySafe:true});}
module.exports={prepare,get,approve,version};
