'use strict';

const crypto=require('node:crypto');
const express=require('express');
const config=require('../../config');
const monitoring=require('../../operations/postgres-monitoring');
const {asyncRoute}=require('../middleware');

function equal(leftValue,rightValue){
  const left=Buffer.from(String(leftValue||''));const right=Buffer.from(String(rightValue||''));
  return left.length===right.length&&left.length>0&&crypto.timingSafeEqual(left,right);
}

function createPostgresOperationsApi(database){
  const router=express.Router();
  router.post('/alerts/:id/ack',asyncRoute(async(req,res)=>{
    const expected=config.operations.alertAckToken;
    const presented=String(req.get('authorization')||'').replace(/^Bearer\s+/i,'')||String(req.body?.token||'');
    if(!expected||!equal(presented,expected))return res.status(401).json({error:{code:'unauthorized',message:'Invalid responder token.'}});
    const alert=await monitoring.acknowledge(database,req.params.id,req.body?.responder||'external responder');
    if(!alert)return res.status(404).json({error:{code:'not_found',message:'Alert not found or already handled.'}});
    return res.json({ok:true,alertId:alert.id,status:alert.status});
  }));
  return router;
}

module.exports={createPostgresOperationsApi,equal};
