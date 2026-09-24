'use strict';

const express=require('express');
const connections=require('../../connections/postgres-service');
const ingestion=require('../../connections/postgres-event-ingestion');
const {DomainError}=require('../../domain/errors');

function createPostgresFeedApi(database){
  const router=express.Router();
  router.post('/events',async(req,res)=>{
    try{
      const auth=await connections.authenticate(database,req.get('authorization'));
      const result=await ingestion.ingestLegacyBatch(database,auth,req.body||{});
      return res.status(result.rejected?207:200).json(result);
    }catch(error){
      if(!(error instanceof DomainError))console.error('[postgres-feed] unexpected event error',error);
      return res.status(error instanceof DomainError?error.status:500).json({error:{code:error.code||'error',
        message:error instanceof DomainError?error.message:'The operating event could not be processed.'}});
    }
  });
  return router;
}

module.exports={createPostgresFeedApi};
