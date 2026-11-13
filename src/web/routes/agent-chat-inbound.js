'use strict';
// Job 188: incoming Microsoft Teams and WhatsApp messages. Each request is
// checked by its channel (Bot Framework token or Twilio signature) before
// anything is read. Answers come later from the worker; a short notice (link
// first, plan, pause) is sent at once.
const express=require('express');
const workflow=require('../../connections/agent-chat');

const xml=value=>String(value).replace(/[<>&'"]/g,ch=>({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'})[ch]);
function address(req){
  const origin=require('../../config').connections.publicOrigin||req.protocol+'://'+req.get('host');
  return new URL(req.originalUrl,origin).href;
}
function router(db){
  const result=express.Router();
  result.post(workflow.publicPaths.teams+'/:endpoint',express.raw({type:'application/json',limit:'64kb',inflate:false}),async(req,res,next)=>{
    try{
      res.set('Cache-Control','no-store');
      const notice=await workflow.receive(db,'teams',{endpoint:req.params.endpoint,raw:Buffer.isBuffer(req.body)?req.body:Buffer.alloc(0),
        headers:{authorization:req.get('authorization')},url:address(req)});
      if(notice)await workflow.notify(db,'teams',notice).catch(()=>{});
      return res.status(200).end();
    }catch(error){
      if(error.status>=400&&error.status<500)return res.status(error.status).end();
      return next(error);
    }
  });
  result.post(workflow.publicPaths.whatsapp,express.raw({type:'application/x-www-form-urlencoded',limit:'16kb',inflate:false}),async(req,res,next)=>{
    try{
      res.set('Cache-Control','no-store');
      const notice=await workflow.receive(db,'whatsapp',{raw:Buffer.isBuffer(req.body)?req.body:Buffer.alloc(0),
        headers:{'x-twilio-signature':req.get('x-twilio-signature')},url:address(req)});
      return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response>'+(notice?.notice?'<Message>'+xml(notice.notice)+'</Message>':'')+'</Response>');
    }catch(error){
      if(error.status>=400&&error.status<500)return res.status(error.status).end();
      return next(error);
    }
  });
  return result;
}
module.exports={router};
