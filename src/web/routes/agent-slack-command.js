'use strict';

const express=require('express');
const slack=require('../../connections/slack-agent-command');
const workflow=require('../../connections/agent-slack');

function router(db){
  const result=express.Router();
  result.post(workflow.publicPath+'/:endpoint',express.raw({type:'application/x-www-form-urlencoded',limit:'16kb',inflate:false}),
    async(req,res,next)=>{
      try{
        res.set('Cache-Control','no-store');
        const response=await workflow.receive(db,req.params.endpoint,req.body,{timestamp:req.get('x-slack-request-timestamp'),signature:req.get('x-slack-signature')});
        return response?res.json(slack.reply(response)):res.status(200).end();
      }catch(error){
        if(error.status>=400&&error.status<500)return res.status(error.status).json(slack.reply(error.message));
        return next(error);
      }
    });
  return result;
}

module.exports={router};
