'use strict';

const express=require('express');
const publicApi=require('../../connections/postgres-public-api');
const inventory=require('../../domain/postgres-inventory-engine');
const {DomainError,ValidationError}=require('../../domain/errors');

function decodeCursor(value){
  if(!value)return null;
  try{
    const parsed=JSON.parse(Buffer.from(String(value),'base64url').toString('utf8'));
    if(!parsed||typeof parsed.skuId!=='string'||typeof parsed.locationId!=='string')throw new Error('invalid');
    return parsed;
  }catch{throw new ValidationError('That inventory cursor is invalid.');}
}

function encodeCursor(row){
  return Buffer.from(JSON.stringify({skuId:row.skuId,locationId:row.locationId})).toString('base64url');
}

function limit(value){return Math.min(500,Math.max(1,Number(value)||200));}

function apiError(res,error){
  if(!(error instanceof DomainError))console.error('[postgres-public-api] unexpected error',error);
  return res.status(error instanceof DomainError?error.status:500).json({error:{code:error.code||'error',
    message:error instanceof DomainError?error.message:'The API request could not be completed.'}});
}

function route(scope,handler){
  return async(req,res)=>{
    try{return await handler(await publicApi.authenticate(req.app.locals.database,req.get('authorization'),scope),req,res);}
    catch(error){return apiError(res,error);}
  };
}

function createPostgresPublicApi(database){
  const router=express.Router();
  router.get('/inventory',route('inventory:read',async(auth,req,res)=>{
    const pageLimit=limit(req.query.limit);const cursor=decodeCursor(req.query.cursor);
    const values=[auth.workspaceId,pageLimit+1];let after='';
    if(cursor){values.push(cursor.skuId,cursor.locationId);after='AND (sku.id,location.id)>($3,$4)';}
    const rows=(await database.query(`SELECT sku.id AS "skuId",sku.code,item.name,
      location.id AS "locationId",location.name AS location,COALESCE(balance.on_hand,0) AS "onHand"
      FROM skus sku JOIN items item ON item.id=sku.item_id CROSS JOIN locations location
      LEFT JOIN balances balance ON balance.sku_id=sku.id AND balance.location_id=location.id
      WHERE sku.workspace_id=$1 AND location.workspace_id=$1 AND sku.is_active=1 AND item.is_active=1
        AND location.is_active=1 ${after} ORDER BY sku.id,location.id LIMIT $2`,values)).rows;
    const more=rows.length>pageLimit;const data=rows.slice(0,pageLimit).map((row)=>({...row,onHand:Number(row.onHand)}));
    return res.json({data,sourceOfTruth:'StockChief canonical PostgreSQL inventory engine',
      nextCursor:more?encodeCursor(data[data.length-1]):null});
  }));
  router.post('/commands/inventory/receive',route('inventory:write',async(auth,req,res)=>{
    const execution=await publicApi.executeCommand(database,auth,{idempotencyKey:req.get('idempotency-key'),
      commandType:'inventory.receive',body:req.body},async(client,operationKey)=>{
      const operation=await inventory.receiveInTransaction(client,auth,{...req.body,
        reference:req.body.reference||`api:${auth.clientId}`,idempotencyKey:operationKey});
      const balance=(await client.query(`SELECT COALESCE(on_hand,0) AS on_hand FROM balances
        WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,[auth.workspaceId,req.body.skuId,req.body.locationId])).rows[0];
      return {operation,verifiedOnHand:Number(balance?.on_hand||0)};
    });
    return res.status(execution.replayed?200:201).json(execution);
  }));
  router.post('/commands/inventory/adjust',route('inventory:write',async(auth,req,res)=>{
    const execution=await publicApi.executeCommand(database,auth,{idempotencyKey:req.get('idempotency-key'),
      commandType:'inventory.adjust',body:req.body},async(client,operationKey)=>{
      const operation=await inventory.adjustInTransaction(client,auth,{...req.body,
        reference:req.body.reference||`api:${auth.clientId}`,idempotencyKey:operationKey});
      const balance=(await client.query(`SELECT COALESCE(on_hand,0) AS on_hand FROM balances
        WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,[auth.workspaceId,req.body.skuId,req.body.locationId])).rows[0];
      return {operation,verifiedOnHand:Number(balance?.on_hand||0)};
    });
    return res.status(execution.replayed?200:201).json(execution);
  }));
  return router;
}

module.exports={createPostgresPublicApi,decodeCursor,encodeCursor};
