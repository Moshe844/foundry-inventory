'use strict';
const express=require('express'),service=require('../../sales/agent-customer-order-pages'),{asyncRoute,rateLimit}=require('../middleware');
function router(db){const r=express.Router();
 r.use('/customer/order',rateLimit({windowMs:60000,max:60,maxBuckets:10000}),(req,res,next)=>{res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'});next();});
 function failed(res,error){if(![400,402,403,404,409,422].includes(error.status))throw error;return res.status(error.status===404?404:error.status===402?200:400).render('public/customer-order-page',{unavailable:true,problem:[402,403,404].includes(error.status)?'This customer order page is unavailable. Please contact the business.':error.message,offer:null,preview:null,receipt:null});}
 r.get('/customer/order/:token',asyncRoute(async(req,res)=>{try{const q=await service.publicContext(db,req.params.token),saved=req.session?.customerOrderReceipt,receipt=saved?.pageId===q.p.id?saved:null;if(receipt)delete req.session.customerOrderReceipt;return res.render('public/customer-order-page',{unavailable:false,problem:null,offer:{...q,token:req.params.token},preview:null,receipt});}catch(e){return failed(res,e);}}));
 r.post('/customer/order/:token/review',asyncRoute(async(req,res)=>{try{const q=await service.quoteRequest(db,req.params.token,req.body);return res.render('public/customer-order-page',{unavailable:false,problem:null,offer:{...q,token:req.params.token},preview:q,receipt:null});}catch(e){return failed(res,e);}}));
 r.post('/customer/order/:token/submit',asyncRoute(async(req,res)=>{
  try{
   const result=await service.submit(db,req.params.token,req.body),q=await service.publicContext(db,req.params.token);
   const receipt={pageId:q.p.id,reference:String(req.body.reference),replayed:Boolean(result.replayed)};
   req.session.customerOrderReceipt=receipt;
   try{
    await new Promise((resolve,reject)=>req.session.save(error=>error?reject(error):resolve()));
   }catch{
    // The purchase request already committed. The customer can still see its receipt.
    delete req.session.customerOrderReceipt;
    return res.render('public/customer-order-page',{unavailable:false,problem:null,offer:{...q,token:req.params.token},preview:null,receipt});
   }
   return res.redirect(303,'/customer/order/'+req.params.token);
  }catch(error){return failed(res,error);}
 }));
 return r;
}
function csrfError(error,req,res,next){if(!['invalid_csrf','inventory_context_changed'].includes(error.code)||!req.accepts('html'))return next(error);const token=/^\/customer\/order\/([A-Za-z0-9_-]{43})(?:\/|$)/.exec(req.originalUrl||'')?.[1];res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'});return res.status(403).render('public/customer-order-page',{unavailable:true,problem:'This customer order form expired. Reload the customer page and review your entries again. Nothing was submitted or charged.',retryPath:token?'/customer/order/'+token:null,offer:null,preview:null,receipt:null});}
module.exports={router,csrfError};
