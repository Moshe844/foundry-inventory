'use strict';
const express=require('express'),service=require('../../sales/agent-website-stock-chat'),{rateLimit}=require('../middleware');
function router(db){const r=express.Router();r.use('/stock-assistant',rateLimit({windowMs:60000,max:60,maxBuckets:10000}));
 r.get('/stock-assistant/:token',async(req,res,next)=>{try{
  const meta=await service.metadata(db,req.params.token),ancestors=meta?.embed_origins||[];
  res.removeHeader('X-Frame-Options');res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','Content-Security-Policy':"default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; form-action 'self'; frame-ancestors 'self' "+ancestors.join(' ')});
  let answer=null,problem=null;try{answer=await db.transaction(c=>service.answer(c,req.params.token,req.query.q,{lock:true}),{isolation:'REPEATABLE READ',retrySafe:true});}catch(e){if(![400,402,403,404,422].includes(e.status))throw e;problem='The stock assistant is unavailable right now. Please contact the business for stock or delivery details.';}
  return res.status(meta?200:404).render('public/website-stock-chat',{answer,problem,token:req.params.token});
 }catch(e){return next(e);}});return r;}
module.exports={router};
