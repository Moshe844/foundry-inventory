'use strict';
const express=require('express'),gateway=require('../../payments/postgres-cardknox'),config=require('../../config');
const {asyncRoute}=require('../middleware'),{AuthenticationError,ValidationError}=require('../../domain/errors');
function createCardknoxPublicRouter(database){const router=express.Router();
 router.use('/pay/cardknox',(req,res,next)=>{res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');next();});
 router.get('/pay/cardknox/:token',asyncRoute(async(req,res)=>{
  const s=await gateway.session(database,req.params.token),held=await gateway.context(database,{workspace_id:s.workspace_id,connector_id:s.connector_id,provider_account_id:s.merchant_account_id});
  const attempt=(await database.query('SELECT status FROM cardknox_payment_attempts WHERE workspace_id=$1 AND session_id=$2',[s.workspace_id,s.id])).rows[0];
  return res.render('payments/cardknox',{title:'Secure payment',business:s.business_name,amount:require('../../domain/currency').format(s.amount_minor,s.currency),
   token:req.params.token,ifieldsKey:held.ifieldsKey,status:s.request_status==='PAID'?'PAID':s.request_status!=='OPEN'?'CLOSED':attempt?.status||'READY',enabled:gateway.enabled(),message:null});
 }));
 router.post('/pay/cardknox/:token',express.urlencoded({extended:false,limit:'8kb'}),asyncRoute(async(req,res)=>{
  const origin=config.connections.publicOrigin||`${req.protocol}://${req.get('host')}`;
  if(req.get('origin')!==new URL(origin).origin||req.body.formToken!==req.params.token)throw new AuthenticationError('Open the original payment page and try again.');
  if(Object.keys(req.body).some(k=>!['formToken','cardToken','cvvToken','expiry'].includes(k)))throw new ValidationError('Only secure payment tokens are accepted.');
  const result=await gateway.pay(database,req.params.token,req.body);
  // No provider bodies, payment tokens or keys are ever placed in the URL.
  return res.redirect(303,'/pay/cardknox/'+req.params.token);
 }));
 router.use('/pay/cardknox',(error,req,res,next)=>{
  if(res.headersSent)return next(error);const status=Number(error.status);return res.status(status>=400&&status<500?status:503).render('payments/error',{
   message:status>=400&&status<500?error.message:'We could not finish checking this payment. Contact the business before trying to pay again.'});
 });
 return router;
}
module.exports={createCardknoxPublicRouter};
