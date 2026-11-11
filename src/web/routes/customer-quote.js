
'use strict';

const express=require('express');
const service=require('../../sales/agent-quote-buyers');
const {asyncRoute,rateLimit}=require('../middleware');
const base='/customer/quote';
const privateHeaders={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'};
const view='public/customer-quote';
const render=(res,model)=>res.render(view,{offer:null,receipt:null,problem:null,retryPath:null,...model});

function router(db){
  const r=express.Router();
  r.use(base,(req,res,next)=>{res.set(privateHeaders);next();},rateLimit({windowMs:60000,max:60,maxBuckets:10000}));
  function failure(res,error,token){
    if(!service.expectedError(error))throw error;
    const showInput=error.details?.buyerInput===true;
    return render(res.status(showInput?400:404),{
      problem:showInput?error.message:'This private quotation is unavailable. Please contact the business.',
      retryPath:showInput?base+'/'+token:null
    });
  }
  r.get(base+'/:token',asyncRoute(async(req,res)=>{
    try{return render(res,{...await service.buyerPage(db,req.params.token),token:req.params.token});}
    catch(error){return failure(res,error,req.params.token);}
  }));
  r.post(base+'/:token/accept',asyncRoute(async(req,res)=>{
    try{
      await service.receive(db,req.params.token,req.body);
      return res.redirect(303,base+'/'+req.params.token);
    }catch(error){return failure(res,error,req.params.token);}
  }));
  return r;
}

function csrfError(error,req,res,next){
  if(!['invalid_csrf','inventory_context_changed'].includes(error.code)||!req.accepts('html'))return next(error);
  const token=/^\/customer\/quote\/([A-Za-z0-9_-]{43})(?:\/|$)/.exec(req.originalUrl||'')?.[1];
  res.set(privateHeaders);
  return render(res.status(403),{problem:'This quotation form expired. Reload it and review the exact terms before accepting.',
    retryPath:token?base+'/'+token:null});
}

module.exports={router,csrfError};
