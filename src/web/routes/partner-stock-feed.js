'use strict';

// Job 123: the private link a 3PL or consignment partner's system posts its
// stock counts to. It carries no session and no cookies; the link itself is
// the partner's authority and the owner can revoke it at any time.
const express=require('express');
const partnerStock=require('../../autopilot/partner-stock');
const {rateLimit}=require('../middleware');
const {DomainError}=require('../../domain/errors');

function router(db){
  const result=express.Router();
  result.use(partnerStock.feedPath,rateLimit({windowMs:60000,max:30,maxBuckets:10000}),(req,res,next)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'});
    next();
  });
  result.post(partnerStock.feedPath+'/:token',async(req,res)=>{
    try{
      const saved=await partnerStock.feed(db,req.params.token,{body:req.body,query:req.query,contentType:req.get('content-type')||''});
      res.status(saved.replayed?200:201).json(saved);
    }catch(error){
      if(!(error instanceof DomainError))console.error('[partner-stock-feed] unexpected error',error);
      res.status(error instanceof DomainError?error.status:500).json({error:{code:error.code||'error',
        message:error instanceof DomainError?error.message:'The stock counts could not be saved. Nothing changed.'}});
    }
  });
  return result;
}

module.exports={router};
