'use strict';

// Job 83: the private link the text provider sends a business's SMS and
// WhatsApp messages to. It has no session or form token; the provider's
// signature over the exact link and fields is the proof.

const express=require('express');
const textOrders=require('../../sales/agent-text-orders');

function origin(req,configured){
  const value=configured==='request'?`${req.protocol}://${req.get('host')}`
    :(configured||require('../../config').connections.publicOrigin||`${req.protocol}://${req.get('host')}`);
  return String(value).replace(/\/$/,'');
}

function router(db,options={}){
  const result=express.Router();
  result.post(textOrders.publicPath+'/:endpoint',express.urlencoded({extended:false,limit:'32kb',parameterLimit:100}),
    async(req,res,next)=>{
      try{
        res.set('Cache-Control','no-store');
        await textOrders.receive(db,req.params.endpoint,{url:origin(req,options.publicOrigin)+req.originalUrl,params:{...req.body},
          signature:req.get('x-twilio-signature')},{settings:options.textSettings});
        // The answer to the customer is sent after the message is read.
        return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      }catch(error){
        if(error.status>=400&&error.status<500)return res.status(error.status).type('text/plain').send(error.message);
        return next(error);
      }
    });
  return result;
}

module.exports={router};
