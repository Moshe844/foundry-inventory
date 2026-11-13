'use strict';
// Job 84: the public website stock assistant. No cookies or sessions. The page
// is embedded only by the owner's exact website origins; the JSON endpoint
// answers only those origins in a browser. Each address is limited per minute,
// sending questions to the team more tightly, and the service adds hourly
// limits per assistant and per visitor.
const express=require('express'),service=require('../../sales/agent-website-stock-chat'),{rateLimit}=require('../middleware');
const expected=[400,402,403,404,409,422,429];
function router(db){const r=express.Router();
 r.use('/stock-assistant',rateLimit({windowMs:60000,max:60,maxBuckets:10000}));
 r.post('/stock-assistant/:token/handoff',rateLimit({windowMs:600000,max:10,maxBuckets:10000}));
 const headers=(res,meta)=>{res.removeHeader('X-Frame-Options');res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','Content-Security-Policy':"default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; form-action 'self'; frame-ancestors 'self' "+(meta?.embed_origins||[]).join(' ')});};
 const read=(token,q,visitor)=>db.transaction(c=>service.answer(c,token,q,{lock:true,visitor}),{isolation:'REPEATABLE READ',retrySafe:true});
 r.get('/stock-assistant/:token',async(req,res,next)=>{try{
  const meta=await service.metadata(db,req.params.token);headers(res,meta);
  let answer=null,problem=null;try{answer=await read(req.params.token,req.query.q,req.ip);}catch(e){if(!expected.includes(e.status))throw e;problem=e.status===429?e.message:'The stock assistant is unavailable right now. Please contact the business for stock or delivery details.';}
  return res.status(meta?200:404).render('public/website-stock-chat',{answer,problem,token:req.params.token,title:meta?.label||null,sent:false});
 }catch(e){return next(e);}});
 // A visitor sends a question the assistant may not answer to the team.
 r.post('/stock-assistant/:token/handoff',async(req,res,next)=>{try{
  const meta=await service.metadata(db,req.params.token);headers(res,meta);
  let problem=null,sent=false,status=meta?200:404;try{await service.handoff(db,req.params.token,req.body||{},{visitor:req.ip});sent=true;}catch(e){if(!expected.includes(e.status))throw e;if(e.status===429&&meta)status=429;problem=[400,422,429].includes(e.status)?e.message:'The stock assistant is unavailable right now. Please contact the business directly.';}
  return res.status(status).render('public/website-stock-chat',{answer:null,problem,token:req.params.token,title:meta?.label||null,sent,question:sent?null:String(req.body?.question||'').slice(0,500)});
 }catch(e){return next(e);}});
 // The same answers as JSON, for a chat widget the owner already runs.
 r.get('/stock-assistant/:token/answer.json',async(req,res,next)=>{try{
  res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow',Vary:'Origin'});
  const meta=await service.metadata(db,req.params.token),origin=req.get('origin');
  if(!meta)return res.status(404).json({error:{code:'not_found',message:'This stock assistant is unavailable.'}});
  if(origin){if(!(meta.embed_origins||[]).includes(origin))return res.status(403).json({error:{code:'origin_not_allowed',message:'This website may not use this stock assistant.'}});res.set('Access-Control-Allow-Origin',origin);}
  try{const a=await read(req.params.token,req.query.q,req.ip);
   return res.json({title:a.title,question:a.question,reply:a.reply,delivery:a.delivery&&a.delivery!==a.reply?a.delivery:null,code:a.code,available:a.available,band:a.band,quantity:a.quantity,suggestions:a.suggestions,
    handoff:a.handoff?{reason:'Your question can go to the team.',page:'/stock-assistant/'+req.params.token+'?q='+encodeURIComponent(a.question)}:null});}
  catch(e){if(!expected.includes(e.status))throw e;return res.status(e.status===429?429:503).json({error:{code:e.status===429?'busy':'unavailable',message:e.status===429?e.message:'The stock assistant is unavailable right now. Please contact the business for stock or delivery details.'}});}
 }catch(e){return next(e);}});
 return r;}
module.exports={router};
