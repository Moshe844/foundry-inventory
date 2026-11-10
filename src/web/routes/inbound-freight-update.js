'use strict';

const express=require('express');
const freight=require('../../purchasing/agent-inbound-freight');
const {asyncRoute,rateLimit}=require('../middleware');

function router(db){
  const result=express.Router();
  result.use(freight.publicPath,rateLimit({windowMs:60000,max:30,maxBuckets:10000}),(req,res,next)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'});
    next();
  });
  result.get(freight.publicPath+'/:token',asyncRoute(async(req,res)=>{
    const data=await freight.publicPage(db,req.params.token);
    res.render('public/inbound-freight-update',{...data,action:freight.publicPath+'/'+req.params.token,saved:req.query.saved==='1'});
  }));
  result.post(freight.publicPath+'/:token',asyncRoute(async(req,res)=>{
    await freight.submit(db,req.params.token,req.body);
    res.redirect(303,freight.publicPath+'/'+req.params.token+'?saved=1');
  }));
  return result;
}

module.exports={router};
