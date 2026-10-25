'use strict';
const crypto=require('node:crypto'),{ValidationError,AuthenticationError}=require('../../domain/errors');
const money=require('../../domain/currency'),{providerFetch}=require('../../lib/provider-http');
async function call(apiKey,command,values={},options={}){
 if(!apiKey)throw new ValidationError('Connect this business’s own Sola/Cardknox API key.');
 const response=await (options.fetch||providerFetch)('https://x1.cardknox.com/'+(command.startsWith('report:')?'reportjson':'gatewayjson'),{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({xKey:apiKey,xVersion:'5.0.0',xSoftwareName:'StockChief',xSoftwareVersion:'1.0.0',xCommand:command,...values})
 },{provider:'Sola/Cardknox',retries:0});
 let result;try{result=await response.json();}catch{throw Object.assign(new ValidationError('Sola did not confirm a readable result. Verify the original attempt before trying again.'),{providerOutcomeUncertain:true});}
 if(!response.ok)throw Object.assign(new ValidationError('Sola could not confirm this request. Check its original status before repeating it.'),{providerOutcomeUncertain:true});
 return result;
}
async function verify(apiKey,options={}){
 const date=new Date().toISOString().slice(0,10),r=await call(apiKey,'report:approved',{xBeginDate:date,xEndDate:date,xFields:'xRefNum'},options);
 if(r.xResult!=='A')throw new ValidationError('Sola could not verify that API key and its reporting permission. Check the merchant account and key permissions.');
 return {verified:true};
}
function sut(value,label){const text=String(value||'');if(text.length<20||text.length>1024||/^\d+$/.test(text)||/\s/.test(text))throw new ValidationError(label+' must come from the secure Sola payment fields. Card numbers and security codes are not accepted by StockChief.');return text;}
async function sale(ctx,input){
 const card=sut(input.cardToken,'Card token'),cvv=sut(input.cvvToken,'Security token');
 if(!/^\d{4}$/.test(input.expiry||''))throw new ValidationError('Enter the expiry as MMYY.');
 if(!Number.isSafeInteger(input.amountMinor)||input.amountMinor<1||input.currency!=='USD')throw new ValidationError('This gateway currently supports positive USD payments only.');
 return call(ctx.cardknoxApiKey,'cc:sale',{xCardNum:card,xCVV:cvv,xExp:input.expiry,xAmount:money.fromMinor(input.amountMinor,'USD'),xCurrency:'USD',
  xInvoice:input.reference,xAllowDuplicate:'FALSE',xAllowPartialAuth:'FALSE',xCustReceipt:'FALSE'},ctx.cardknoxOptions);
}
async function createCustomer(ctx,{email}){return {externalCustomerId:'local:'+crypto.createHash('sha256').update(ctx.workspaceId+':'+email).digest('hex')};}
async function createInvoice(ctx,input){return require('../postgres-cardknox').createSession(ctx.database,ctx.workspaceId,input.attemptId,{origin:ctx.publicOrigin});}
async function getHostedPaymentUrl(ctx,{externalInvoiceId}){return (await ctx.database.query('SELECT hosted_url FROM payment_requests WHERE workspace_id=$1 AND provider=$2 AND external_invoice_id=$3',[ctx.workspaceId,'cardknox',externalInvoiceId])).rows[0]?.hosted_url||null;}
async function refundPayment(ctx,{externalPaymentId,amountMinor}){
 const r=await call(ctx.cardknoxApiKey,'cc:refund',{xRefNum:externalPaymentId,xAmount:money.fromMinor(amountMinor,'USD'),xCustReceipt:'FALSE'},ctx.cardknoxOptions);
 if(r.xResult!=='A'||!r.xRefNum)throw Object.assign(new ValidationError('Sola did not confirm the refund. Review the original attempt before retrying.'),{providerOutcomeUncertain:r.xResult!=='D'});
 return {externalRefundId:String(r.xRefNum)};
}
function verifyEvent(){throw new AuthenticationError('Sola payment results must be verified directly through this business’s gateway account.');}
function readEvent(event){return event.stockchiefVerified===true?event.read:{kind:'IGNORED',reason:'Unverified gateway result.'};}
module.exports={call,verify,sut,sale,createCustomer,createInvoice,getHostedPaymentUrl,refundPayment,verifyEvent,readEvent};
